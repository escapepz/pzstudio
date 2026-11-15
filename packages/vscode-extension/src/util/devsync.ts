import * as vscode from 'vscode';
import type {
    BuildSession,
    FileDelta,
    PzStudio,
    PzStudioLogger,
} from '@pzstudio/cli/api';
import {
    createIgnoreMatcher,
    isWatchPathIgnored,
    readIgnoreRulesForDir,
    summarizeApplyResult,
    WATCH_DEBOUNCE_MS,
} from '@pzstudio/cli/api';
import { t } from './l10n';
import { ruleFileFs } from './ruleFs';
import { watchTreeRecursive, type RecursiveFsWatcherHandle } from './fsWatcher';

/**
 * Desktop auto-sync: ONE core BuildSession driven by file events from TWO
 * watcher legs — the workspace FileSystemWatcher (host-managed) and the
 * self-owned recursive fs.watch walker (fsWatcher.ts, enabled at the
 * activation site; d09-B2 — the host watcher alone silently stops
 * delivering on hosts where the watched tree's shape changes after the
 * window's watcher established itself). Overlapping events are safe: the
 * engine's coalesceDeltas collapses same-path duplicates. Watch writes
 * into the workshop output folders, so this feature is Node-host only —
 * the web build never registers the command.
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
 * As the final drop-condition of the same shared decision, the ROOT-level
 * .gitignore/.pzstudioignore rules steer the filter (readIgnoreRulesForDir +
 * createIgnoreMatcher over vscode.workspace.fs). Root rules only: nested
 * rule files are the engine's apply-time territory (isSourcePathIncluded
 * re-reads the closest rule files per applied path, and a nested rule-file
 * change re-baselines the owning mod), so this layer never walks nested
 * directories. The rules load once per session before the watcher exists,
 * reload when a ROOT-level rule-file event is scheduled (the event reaches
 * the engine, but a ROOT-level rule file classifies 'dot entry at project
 * root' — no re-baseline follows it — so this reload is the predicate's
 * only in-band change signal) and after every re-baseline the session
 * reports. A failed reload retains the last good matcher — the same side
 * the engine keeps.
 *
 * A filtered drop is never fully silent (DEC-9): drops are counted and
 * reported as one aggregate line per batch at verbose level. Apply-phase
 * failures reach the error surface (notification + Show Details, DEC-6),
 * not only the channel, and a rejected flush is reported instead of dying
 * as an unhandled rejection.
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

/**
 * Whether `path` is THE root-level .gitignore or .pzstudioignore of the
 * session's project. These events are the ignore predicate's only in-band
 * change signal: they reach the engine, but a ROOT-level rule file
 * classifies 'dot entry at project root' — no re-baseline follows — so
 * nothing else refreshes the ROOT rules. Nested rule files never match —
 * their rules are engine apply-time territory and their mod-scoped
 * re-baseline flows through the post-apply reload instead.
 */
function isRootRuleFile(projectDir: string, path: string): boolean {
    const dir = normalizePath(projectDir);
    const normalized = normalizePath(path);
    return (
        normalized === `${dir}/.gitignore` ||
        normalized === `${dir}/.pzstudioignore`
    );
}

export class DevSyncController implements vscode.Disposable {
    private readonly studio: PzStudio;
    private readonly logger: PzStudioLogger;
    private session: BuildSession | undefined;
    private watcher: vscode.FileSystemWatcher | undefined;
    /**
     * The self-owned delivery leg (fsWatcher.ts): Node fs.watch over the
     * project tree. The vscode watcher is host-managed and silently stops
     * delivering when the watched tree's shape changes under it (d09-B2) —
     * this one subscribes what exists at session start and follows new
     * directories, so delivery never depends on the host watcher service.
     * Both sources feed the same schedule(); the engine's coalesceDeltas
     * collapses the overlap on healthy hosts.
     */
    private fsWatcher: RecursiveFsWatcherHandle | undefined;
    /** Whether start() also runs the self-owned fs.watch delivery leg. */
    private readonly useFsWatcher: boolean;
    /** The session's project directory — published with the filter root. */
    private projectDir: string | undefined;
    /** The resolved output root the outdir rule filters against. */
    private filterRoot: string | undefined;
    /**
     * The matcher over the ROOT-level .gitignore/.pzstudioignore rules —
     * the final drop-condition. Undefined until the first successful read
     * (fail-open) and cleared with the rest of the filter state in stop().
     */
    private ignoreMatcher: ((rel: string) => boolean) | undefined;
    private pending: FileDelta[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private starting = false;
    /** Events dropped by the scope filter since the last reported batch. */
    private filteredEvents = 0;

    constructor(
        studio: PzStudio,
        logger: PzStudioLogger,
        options?: { useFsWatcher?: boolean },
    ) {
        this.studio = studio;
        this.logger = logger;
        // Off by default: the self-owned delivery leg is a product decision
        // made at the activation site (extension.ts). Tests construct the
        // controller directly and drive the schedule pipeline through the
        // vscode watcher mock — deterministic, no real fs dependency.
        this.useFsWatcher = options?.useFsWatcher === true;
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

            // The root-level rules load once per session, before the watcher
            // exists: no event can ever be filtered by rules that were not
            // read, and a failed read lands in the fail-open no-matcher
            // state (the same side the engine keeps).
            await this.refreshIgnoreRules(projectDir);

            // The watcher base is the WORKSPACE FOLDER containing the
            // project — never the project folder itself (sweep d09-B2). A
            // project folder created mid-session (the standard extension
            // flow `pzstudio new` → `add` → build → watch) is accepted as a
            // RelativePattern base, but the watcher service then delivers
            // NOTHING for it — zero events, zero channel lines, no error
            // (VM probe evidence 2026-11-16, VS Code stable 1.146: with a
            // pre-existing project the fs/editor saves sync in ~1s; the
            // same session with the project created through the palette
            // delivers nothing at all). The workspace folder pre-dates the
            // window — VS Code already watches it for the workbench — so a
            // pattern over it delivers. Scope stays per-project: every
            // event still passes the isWatchPathIgnored decision in
            // schedule() (outside the project or under the output root →
            // counted and dropped).
            const projectUri = vscode.Uri.file(projectDir);
            const workspaceFolder =
                vscode.workspace.getWorkspaceFolder(projectUri);
            const watcherBase = workspaceFolder
                ? new vscode.RelativePattern(workspaceFolder.uri, '**/*')
                : // Unreachable through the picker (the project dir always
                  // resolves inside a workspace folder); the historical
                  // project-dir base stays the fail-open fallback.
                  new vscode.RelativePattern(projectUri, '**/*');
            let watcher: vscode.FileSystemWatcher;
            try {
                watcher = vscode.workspace.createFileSystemWatcher(watcherBase);
                watcher.onDidCreate((uri) =>
                    this.schedule('create', uri.fsPath),
                );
                watcher.onDidChange((uri) =>
                    this.schedule('change', uri.fsPath),
                );
                watcher.onDidDelete((uri) =>
                    this.schedule('delete', uri.fsPath),
                );
            } catch (e) {
                // A session without a working watcher is a silently dead
                // sync — registration failures must never be silent again
                // (d09-B2) and the half-start must not pretend to run.
                const message = e instanceof Error ? e.message : String(e);
                this.logger.error(
                    new Error(
                        `Development sync: watcher registration failed (${message}) — file changes cannot be observed, stopping the session.`,
                    ),
                );
                await this.stop();
                throw e;
            }
            // One channel line proving the watcher is registered (the
            // dead-watcher state used to be fully invisible).
            this.logger.info(
                `Development sync: watching '${watcherBase.base.toString()}' for changes (**/*).`,
            );

            // The GUARANTEED delivery leg (d09-B2): a self-owned recursive
            // fs.watch walker over the PROJECT tree. The vscode watcher
            // above is host-managed and — on some VS Code builds/hosts —
            // silently delivers nothing for trees that changed shape after
            // the window's watcher established itself; this walker
            // subscribes what exists at session start and follows new
            // directories, so delivery never depends on the host service.
            // Both legs feed the same schedule(); the engine's
            // coalesceDeltas collapses the overlap on healthy hosts.
            if (this.useFsWatcher) {
                this.fsWatcher = watchTreeRecursive(
                    projectDir,
                    (type, path) => this.schedule(type, path),
                    (message) => this.logger.warn(message),
                );
                this.logger.info(
                    `Development sync: fs watcher subscribed ${this.fsWatcher.subscribedCount} director(ies) under '${projectDir}'.`,
                );
            }

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
        const fsWatcher = this.fsWatcher;
        this.watcher = undefined;
        this.fsWatcher = undefined;
        this.session = undefined;
        this.projectDir = undefined;
        this.filterRoot = undefined;
        this.ignoreMatcher = undefined;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.pending = [];
        this.filteredEvents = 0;
        watcher?.dispose();
        fsWatcher?.dispose();
        await session?.stop();
    }

    async dispose(): Promise<void> {
        await this.stop();
    }

    /**
     * Re-reads the project's ROOT-level ignore rules and rebuilds the
     * matcher. Adopted only while this session still owns the project — a
     * stop()/start() race between the fire-and-forget reloads and the next
     * start must not leave the next session's filter holding this session's
     * rules (the next start re-reads before its watcher exists anyway). A
     * failed read retains the last good matcher — the same side the engine
     * keeps.
     */
    private async refreshIgnoreRules(projectDir: string): Promise<void> {
        let matcher: ((rel: string) => boolean) | undefined;
        try {
            const rules = await readIgnoreRulesForDir(
                ruleFileFs,
                vscode.Uri.file(projectDir).toString(),
            );
            matcher = createIgnoreMatcher({ '': rules }).isIgnored;
        } catch (e) {
            // Retain the last good matcher (fail-open), but never silently:
            // a rules failure is diagnostic gold when nothing syncs.
            this.logger.warn(
                `Development sync: reading the root ignore rules failed (${
                    e instanceof Error ? e.message : String(e)
                }); keeping the previous filter.`,
            );
            return;
        }
        if (this.projectDir === undefined || this.projectDir === projectDir) {
            this.ignoreMatcher = matcher;
        }
    }

    /** The final drop-condition: root-level rules, fail-open when unset. */
    private isRuleIgnored(rel: string): boolean {
        return this.ignoreMatcher?.(rel) ?? false;
    }

    private schedule(type: FileDelta['type'], path: string): void {
        // Event processing must never die silently (d09-B2): a throwing
        // handler or filter is surfaced through the error channel + toast.
        // The debounce state stays consistent — a later event re-arms the
        // timer and flushes whatever was already queued.
        try {
            this.scheduleEvent(type, path);
        } catch (e) {
            this.logger.error(e instanceof Error ? e : String(e));
        }
    }

    private scheduleEvent(type: FileDelta['type'], path: string): void {
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
        // A ROOT-level rule-file event re-steers the predicate: no engine
        // re-baseline follows it (classifyDelta puts a root-level rule
        // file in the root-dot-entry ignore class), so this reload is the
        // only in-band signal a root rule change gets. The event itself is
        // delivered — a nested rule file is the one that re-baselines its
        // owning mod.
        if (this.projectDir && isRootRuleFile(this.projectDir, path)) {
            void this.refreshIgnoreRules(this.projectDir);
        }
        // Fail open: an unknown filtering root must never discard source
        // events. Unreachable in practice (the root is published before the
        // watcher exists and cleared after it is disposed), but the safe
        // direction is forward-not-drop.
        if (
            this.projectDir !== undefined &&
            this.filterRoot !== undefined &&
            isWatchPathIgnored(
                this.projectDir,
                this.filterRoot,
                path,
                undefined,
                (rel) => this.isRuleIgnored(rel),
            )
        ) {
            this.filteredEvents += 1;
            return;
        }
        this.pending.push({ type, path });
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush().catch((e) => {
                // A rejected flush must not die as an unhandled rejection
                // (per-action failures travel in result.errors, so a
                // rejection here means a host dependency threw): report
                // through the error surface; the next watcher event starts
                // the next flush and the session serializes behind it.
                this.logger.error(e instanceof Error ? e : String(e));
            });
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
            // The engine just re-baselined (doc 13 §6.3): re-read the rules
            // with the same freshness the root gets — a rule change whose
            // event never reached schedule is picked up here.
            void this.refreshIgnoreRules(projectDir);
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
        if (result.errors.length > 0) {
            // A failed batch must reach the user where they work (DEC-6):
            // the per-error detail stays in the channel above; the error
            // surface (notification + Show Details) carries the count.
            this.logger.error(
                t(
                    'Development sync: {0} change(s) failed to apply. Show Details lists every failure.',
                    result.errors.length,
                ),
            );
        }
        // A dropped event is never fully silent (DEC-9): one aggregate line
        // per batch at verbose level — a per-event warning would spam every
        // engine output write the watcher reports.
        if (this.filteredEvents > 0) {
            this.logger.verbose?.(
                `Filtered ${this.filteredEvents} watcher event(s) below the output root or outside the project — not synced.`,
            );
            this.filteredEvents = 0;
        }
    }
}
