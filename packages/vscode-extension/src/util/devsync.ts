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

function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isRootProjectJson(projectDir: string, path: string): boolean {
    return normalizePath(path) === `${normalizePath(projectDir)}/project.json`;
}

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
    private fsWatcher: RecursiveFsWatcherHandle | undefined;
    private readonly useFsWatcher: boolean;
    private projectDir: string | undefined;
    private filterRoot: string | undefined;
    private ignoreMatcher: ((rel: string) => boolean) | undefined;
    private pending: FileDelta[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private starting = false;
    private filteredEvents = 0;

    constructor(
        studio: PzStudio,
        logger: PzStudioLogger,
        options?: { useFsWatcher?: boolean },
    ) {
        this.studio = studio;
        this.logger = logger;
        this.useFsWatcher = options?.useFsWatcher === true;
    }

    get active(): boolean {
        return this.session !== undefined;
    }

    async start(projectDir: string): Promise<void> {
        if (this.active || this.starting) {
            return;
        }
        this.starting = true;
        try {
            const session = this.studio.createDevSync(projectDir);
            let filterRoot = this.studio.resolveOutDir(projectDir);
            await session.start(['main', 'development']);
            try {
                filterRoot = this.studio.resolveOutDir(projectDir);
            } catch {}

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
                : // resolves inside a workspace folder); the historical
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
                const message = e instanceof Error ? e.message : String(e);
                this.logger.error(
                    new Error(
                        `Development sync: watcher registration failed (${message}) — file changes cannot be observed, stopping the session.`,
                    ),
                );
                await this.stop();
                throw e;
            }
            this.logger.info(
                `Development sync: watching '${watcherBase.base.toString()}' for changes (**/*).`,
            );

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

            this.projectDir = projectDir;
            this.filterRoot = filterRoot;
            this.watcher = watcher;
            this.session = session;
        } catch (e) {
            this.logger.warn(e instanceof Error ? e.message : String(e));
            await this.stop();
            throw e;
        } finally {
            this.starting = false;
        }
    }

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

    private async refreshIgnoreRules(projectDir: string): Promise<void> {
        let matcher: ((rel: string) => boolean) | undefined;
        try {
            const rules = await readIgnoreRulesForDir(
                ruleFileFs,
                vscode.Uri.file(projectDir).toString(),
            );
            matcher = createIgnoreMatcher({ '': rules }).isIgnored;
        } catch (e) {
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

    private isRuleIgnored(rel: string): boolean {
        return this.ignoreMatcher?.(rel) ?? false;
    }

    private schedule(type: FileDelta['type'], path: string): void {
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
        if (this.projectDir && isRootProjectJson(this.projectDir, path)) {
            try {
                this.filterRoot = this.studio.resolveOutDir(this.projectDir);
            } catch {}
        }
        if (this.projectDir && isRootRuleFile(this.projectDir, path)) {
            void this.refreshIgnoreRules(this.projectDir);
        }
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
        if (
            this.session === session &&
            projectDir !== undefined &&
            this.projectDir === projectDir &&
            (result.fullRebuild || result.scoped.length > 0)
        ) {
            try {
                this.filterRoot = this.studio.resolveOutDir(projectDir);
            } catch {}
            void this.refreshIgnoreRules(projectDir);
        }
        const summary = summarizeApplyResult(result);
        if (summary) {
            this.logger.log(`- ${summary}.`);
        }
        for (const message of result.errors) {
            this.logger.warn(`- ${message}`);
        }
        if (result.errors.length > 0) {
            this.logger.error(
                t(
                    'Development sync: {0} change(s) failed to apply. Show Details lists every failure.',
                    result.errors.length,
                ),
            );
        }
        if (this.filteredEvents > 0) {
            this.logger.verbose?.(
                `Filtered ${this.filteredEvents} watcher event(s) below the output root or outside the project — not synced.`,
            );
            this.filteredEvents = 0;
        }
    }
}
