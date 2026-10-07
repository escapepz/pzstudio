import * as vscode from 'vscode';
import type {
    BuildSession,
    FileDelta,
    PzStudio,
    PzStudioLogger,
} from '@pzstudio/cli/api';
import { summarizeApplyResult, WATCH_DEBOUNCE_MS } from '@pzstudio/cli/api';

/**
 * Desktop auto-sync: ONE core BuildSession driven by a workspace
 * FileSystemWatcher. Watch writes into the workshop output folders, so this
 * feature is Node-host only — the web build never registers the command.
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
export class DevSyncController implements vscode.Disposable {
    private readonly studio: PzStudio;
    private readonly logger: PzStudioLogger;
    private session: BuildSession | undefined;
    private watcher: vscode.FileSystemWatcher | undefined;
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
            await session.start(['main', 'development']);

            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(projectDir), '**/*'),
            );
            watcher.onDidCreate((uri) => this.schedule('create', uri.fsPath));
            watcher.onDidChange((uri) => this.schedule('change', uri.fsPath));
            watcher.onDidDelete((uri) => this.schedule('delete', uri.fsPath));

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
        const batch = this.pending.splice(0, this.pending.length);
        if (!session || batch.length === 0) {
            return;
        }
        const result = await session.apply(batch);
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
