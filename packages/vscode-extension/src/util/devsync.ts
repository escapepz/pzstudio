import * as vscode from 'vscode';
import type {
    BuildSession,
    FileDelta,
    PzStudio,
    PzStudioLogger,
} from '@pzstudio/cli/api';
import {
    isWatchPathIgnored,
    summarizeApplyResult,
    WATCH_DEBOUNCE_MS,
} from '@pzstudio/cli/api';

/**
 * Desktop auto-sync: ONE core BuildSession driven by a workspace
 * FileSystemWatcher. Watch writes into the workshop output folders, so this
 * feature is Node-host only — the web build never registers the command.
 *
 * Events are pre-filtered through the same decision the CLI watch uses
 * (isWatchPathIgnored, driven by studio.resolveOutDir) so the engine's own
 * output writes never feed the session — an output root inside a configured
 * mod folder would otherwise self-feed. The filtering root follows the
 * engine's re-baselines (doc 13 §6.3): it is resolved at startup, re-resolved
 * when a root-level project.json event is scheduled (the only event the core
 * classifies full-rebuild, so a re-baseline attempt is immediately behind
 * it) and after every apply that reports a re-baseline. A failed
 * re-resolution retains the last good root — the same side the engine keeps.
 *
 * Events are collected and flushed on a debounce so a burst of saves becomes
 * one sync pass; the session itself serializes and classifies the deltas.
 *
 * The session is created by the activation-created host instance
 * (studio.createDevSync): its settings provider is consulted on every plan
 * input with the session's projectDir, and its logger owns every emission —
 * the batch summaries/errors below and the session/plan-input lines inside
 * the CLI alike (doc 11 §12/§14, commit 9). No legacy facade import.
 */

/**
 * Normalizes a path for comparison (never for filesystem access) — the same
 * convention classifyDelta uses: backslashes fold to '/', trailing
 * separators drop. Comparisons stay case-sensitive, exactly like the
 * engine's own.
 */
function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Whether `path` is THE project.json of the session's project root — the
 * exact comparison classifyDelta performs (rel === 'project.json' against
 * the plan input's projectDir). A nested project.json is an ordinary mod
 * file to the engine and must not switch the filter root: no re-baseline
 * follows it, so switching would leave the filter ahead of the engine.
 */
function isRootProjectJson(projectDir: string, path: string): boolean {
    return normalizePath(path) === `${normalizePath(projectDir)}/project.json`;
}

export class DevSyncController implements vscode.Disposable {
    private readonly studio: PzStudio;
    private readonly logger: PzStudioLogger;
    private session: BuildSession | undefined;
    private watcher: vscode.FileSystemWatcher | undefined;
    /** The session's project directory — published with the filter root. */
    private projectDir: string | undefined;
    /** The resolved output root the outdir rule filters against. */
    private filterRoot: string | undefined;
    private pending: FileDelta[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private starting = false;

    constructor(studio: PzStudio, logger: PzStudioLogger) {
        this.studio = studio;
        this.logger = logger;
    }

    get active(): boolean {
        return this.session !== undefined;
    }

    /**
     * Starts a full build plus live sync for the project at projectDir.
     * Re-entrant calls while active or starting are ignored — the toggle
     * command decides what to message the user.
     */
    async start(projectDir: string): Promise<void> {
        if (this.active || this.starting) {
            return;
        }
        this.starting = true;
        try {
            const session = this.studio.createDevSync(projectDir);
            // Resolve the filtering root BEFORE the initial build: the two
            // reads are then back-to-back (the CLI watch reads its config
            // before creating the session too). A failure here is the same
            // config-resolution failure the session's first plan input
            // would hit, so aborting before the build is fail-closed
            // alignment — the UX-06 catch below owns the notification.
            let filterRoot = this.studio.resolveOutDir(projectDir);
            await session.start(['main', 'development']);
            // Post-start correction: the session's first plan input resolved
            // inside start(); re-read and adopt whatever the race window
            // between the two reads changed. A throw retains the pre-start
            // root — the engine keeps its baseline on the same failure.
            try {
                filterRoot = this.studio.resolveOutDir(projectDir);
            } catch {
                /* retain the pre-start root */
            }

            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(projectDir), '**/*'),
            );
            watcher.onDidCreate((uri) => this.schedule('create', uri.fsPath));
            watcher.onDidChange((uri) => this.schedule('change', uri.fsPath));
            watcher.onDidDelete((uri) => this.schedule('delete', uri.fsPath));

            // Publish the filter state only once the session is live, so no
            // event can ever be filtered by a root without a session.
            this.projectDir = projectDir;
            this.filterRoot = filterRoot;
            this.watcher = watcher;
            this.session = session;
        } catch (e) {
            // The session owns its error logging; stop the half-started
            // session so the next toggle begins from a clean slate.
            this.logger.warn(e instanceof Error ? e.message : String(e));
            await this.stop();
            throw e;
        } finally {
            this.starting = false;
        }
    }

    /** Stops watching and drains the session. Safe to call when idle. */
    async stop(): Promise<void> {
        const watcher = this.watcher;
        const session = this.session;
        this.watcher = undefined;
        this.session = undefined;
        this.projectDir = undefined;
        this.filterRoot = undefined;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.pending = [];
        watcher?.dispose();
        await session?.stop();
    }

    async dispose(): Promise<void> {
        await this.stop();
    }

    private schedule(type: FileDelta['type'], path: string): void {
        if (!this.session) {
            return;
        }
        // Schedule-time switch: a root-level project.json event is the only
        // in-band signal that guarantees a full re-baseline attempt is
        // imminent ('full-rebuild' is classified before any mod lookup), so
        // the filter is never switched without a re-baseline immediately
        // behind it. Re-resolve and adopt — a same-root result keeps
        // filtering (preserving the output-subtree loop protection), and a
        // throw retains the last good root (the rebuild this event triggers
        // keeps its baseline on the same failure). mod.info /
        // .pzstudioignore events do NOT switch here — their re-baseline is
        // conditional — they are covered by the post-apply correction.
        if (this.projectDir && isRootProjectJson(this.projectDir, path)) {
            try {
                this.filterRoot = this.studio.resolveOutDir(this.projectDir);
            } catch {
                /* retain last good root — engine-aligned */
            }
        }
        // Fail open: an unknown filtering root must never discard source
        // events. Unreachable in practice (the root is published before the
        // watcher exists and cleared after it is disposed), but the safe
        // direction is forward-not-drop.
        if (
            this.projectDir !== undefined &&
            this.filterRoot !== undefined &&
            isWatchPathIgnored(this.projectDir, this.filterRoot, path)
        ) {
            return;
        }
        this.pending.push({ type, path });
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush();
        }, WATCH_DEBOUNCE_MS);
    }

    private async flush(): Promise<void> {
        const session = this.session;
        const projectDir = this.projectDir;
        const batch = this.pending.splice(0, this.pending.length);
        if (!session || batch.length === 0) {
            return;
        }
        const result = await session.apply(batch);
        // Post-apply correction: fullRebuild and a non-empty scoped list are
        // the only SessionApplyResult shapes an engine re-baseline produces —
        // after either, the baseline is the fresh input, so re-resolving NOW
        // follows the re-baseline instead of racing ahead of it. Guarded on
        // session identity: a stop()/start() while this apply was in flight
        // must not adopt a root into the next session's filter state.
        if (
            this.session === session &&
            projectDir !== undefined &&
            this.projectDir === projectDir &&
            (result.fullRebuild || result.scoped.length > 0)
        ) {
            try {
                this.filterRoot = this.studio.resolveOutDir(projectDir);
            } catch {
                /* retain last good root */
            }
        }
        // A successful sync is otherwise silent in the output channel —
        // say what the batch did, same wording the CLI watch prints.
        const summary = summarizeApplyResult(result);
        if (summary) {
            this.logger.log(`- ${summary}.`);
        }
        for (const message of result.errors) {
            this.logger.warn(`- ${message}`);
        }
    }
}
