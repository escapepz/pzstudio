import * as vscode from 'vscode';
import {
    analyzeGameLogFile,
    buildProjectContext,
    createPzStudio,
} from '@pzstudio/cli/api';
import type { ConsoleLogProjectContext } from '@pzstudio/cli/api';
import { createPZLogger, type PZLoggerErrorAction } from './util/logger';
import { initExtensionL10n, t } from './util/l10n';
import { readPzStudioHostSettings } from './util/settings';
import { createCommandRunner } from './util/execute';
import { notifyFirstBuildSuccess } from './util/firstSuccess';
import { DevSyncController } from './util/devsync';
import {
    DevSyncManager,
    DevSyncStateService,
    type DevSyncState,
} from './util/devSyncState';
import { createProjectDiagnostics } from './util/doctor';
import { registerAllCommands } from './commands';
import { registerAnalyzeGameLogCommand } from './commands/analyzeGameLog';
import { registerExplorerCommands } from './commands/explorer';
import {
    registerWatchCommand,
    registerDevSyncStatusBar,
} from './commands/watch';
import { registerDoctorCommand } from './commands/doctor';
import {
    PROJECT_EXPLORER_VIEW_ID,
    ProjectExplorerProvider,
    SHOW_ALL_FILES_CONTEXT_KEY,
} from './providers/projectExplorer';
import { BuildTaskProvider, PZ_TASK_TYPE } from './providers/buildTaskProvider';

/**
 * UX-15 Task 4: the error-notification actions the DevSync controller's
 * logger offers. Only a run in flight has something to stop — off (including
 * the idle-with-lastError state a failed run lands in) the factory returns
 * no action, so the offered button can never be dead. The getter is lazy:
 * the manager does not exist when the logger is constructed (the controller
 * needs the logger first), and the thunk only ever RUNS when an apply-error
 * notification is built — mid-run, long after activation — so the
 * construction cycle it breaks is safe.
 */
export function devSyncErrorActions(
    getManager: () => DevSyncManager | undefined,
): () => PZLoggerErrorAction[] {
    return () => {
        const manager = getManager();
        if (!manager || manager.state.phase === 'idle') {
            return [];
        }
        return [
            {
                label: t('Stop Sync'),
                // Safe anytime: stop() is idempotent — syncing tears down,
                // starting queues the stop, idle/stopping no-op (the
                // manager contract). The notification may outlive the run
                // it reported; a late click then lands on a no-op.
                run: (): void => {
                    void manager.stop();
                },
            },
        ];
    };
}

/**
 * UX-15 Task 4: the explorer badge — the DevSyncManager's state painted onto
 * the project explorer's tree view through the same onDidChange subscription
 * pattern the status bar uses (commands/watch.ts). A run mid-flight badges 1
 * — the manager publishes no pending count, so the badge is the state
 * indicator, not a precision meter (the same mid-flight rule the status bar
 * paints by: starting/syncing/stopping all count as in flight) — and idle
 * clears it, including the idle-with-lastError state a failed run lands in.
 */
export function registerDevSyncTreeBadge<T>(
    manager: DevSyncManager,
    treeView: vscode.TreeView<T>,
): vscode.Disposable {
    // The folder-title convention commands/watch.ts renders the status bar
    // with: the projectTitle once beginSyncing published it, else the
    // projectDir's last segment (both separators fold).
    const runTitle = (state: DevSyncState): string =>
        state.projectTitle ??
        state.projectDir?.split(/[\\/]/).filter(Boolean).pop() ??
        state.projectDir ??
        '';

    const render = (state: DevSyncState): void => {
        if (state.phase === 'idle') {
            treeView.badge = undefined;
            return;
        }
        const title = runTitle(state);
        let tooltip: string;
        if (state.phase === 'starting') {
            tooltip = t(
                "PZStudio: development sync for '{0}' is starting…",
                title,
            );
        } else if (state.phase === 'stopping') {
            tooltip = t(
                "PZStudio: development sync for '{0}' is stopping…",
                title,
            );
        } else {
            tooltip = t("PZStudio: development sync running for '{0}'.", title);
        }
        treeView.badge = { value: 1, tooltip };
    };

    render(manager.state);
    const subscription = manager.onDidChange(render);
    return {
        dispose(): void {
            subscription.dispose();
        },
    };
}

/**
 * The game-log analyzer's attribution context, resolved per run: the first
 * workspace folder containing a project.json (the explorer's root-scan
 * discovery rule, util/project.ts). buildProjectContext (CLI host) maps the
 * project's mods to `{ modId, displayName, sourceRootUri }` with
 * filesystem-path roots; each root is remapped to a vscode file URI here so
 * attributed findings pin diagnostics on clickable files instead of dead
 * paths. No project folder (or no readable config) → undefined/throw — the
 * command handler routes both through the shared error sink.
 */
async function resolveGameLogContext(): Promise<
    ConsoleLogProjectContext | undefined
> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        try {
            await vscode.workspace.fs.stat(
                vscode.Uri.joinPath(folder.uri, 'project.json'),
            );
        } catch {
            continue; // no project.json in this root
        }
        const context = buildProjectContext(folder.uri.fsPath);
        if (!context) {
            return undefined;
        }
        return {
            mods: (context.mods ?? []).map((mod) => ({
                ...mod,
                sourceRootUri: vscode.Uri.file(mod.sourceRootUri).toString(),
            })),
        };
    }
    return undefined;
}

export async function activate(context: vscode.ExtensionContext) {
    // Load the display-language override before any UI string is produced.
    await initExtensionL10n(context);

    const outputChannel = vscode.window.createOutputChannel('PZ Studio');

    // One host-owned PzStudio instance for the entire extension lifetime
    // (doc 11 §17 commit 11): project context comes from the tree picker /
    // active editor on every command run (runner, task provider), the
    // session from the DevSync controller, or the explicit path the doctor /
    // modinfo handler resolves. The logger and settings provider below own
    // every v2-reachable emission path — the legacy facade slots are no
    // longer written by the extension runtime.
    const pzLogger = createPZLogger(outputChannel);

    const studio = createPzStudio({
        logger: pzLogger,
        settings: (ctx) => readPzStudioHostSettings(ctx),
    });

    // Shared diagnostics run (doctor quick-pick + explorer badge) bound to
    // the host instance — explicit project context, no legacy anchor
    // juggling (doc 11 §17 commit 10).
    const runProjectDiagnostics = createProjectDiagnostics(studio);

    const projectExplorer = new ProjectExplorerProvider(
        context.extensionUri,
        runProjectDiagnostics,
    );
    // Publish the toggle state up front so the eye/eye-closed title button
    // resolves its when-clause before the first click.
    projectExplorer.syncShowAllFilesContext();
    const treeView = vscode.window.createTreeView(PROJECT_EXPLORER_VIEW_ID, {
        treeDataProvider: projectExplorer,
    });

    // Development Sync Engine (UX-15): ONE manager for the whole extension
    // lifetime — the lifecycle wrapper that drives the controller and
    // publishes every transition through the state service. The palette
    // toggle, the status-bar indicator and the explorer badge below are its
    // only consumers; all gate on state.phase, so a click can never
    // re-anchor a live run.
    const devSyncService = new DevSyncStateService();
    // UX-15 Task 4: the controller gets its OWN logger over the same
    // channel — the one error surface whose notification carries the
    // 'Stop Sync' action (the apply errors, DEC-6). Every other error
    // surface (doctor, the command runner, the CLI engine) keeps the plain
    // logger with Show Details only. devsync.ts is untouched: its sync
    // logic already routes apply errors through logger.error.
    // The two annotations are load-bearing: the getter closes over
    // devSyncManager before its declaration, and without them TS's
    // circular inference would land both as implicit any (TS7022).
    const devSync: DevSyncController = new DevSyncController(
        studio,
        createPZLogger(
            outputChannel,
            devSyncErrorActions(() => devSyncManager),
        ),
    );
    const devSyncManager: DevSyncManager = new DevSyncManager(
        devSync,
        devSyncService,
    );

    // UX-15: the status-bar indicator — with the toggle's success popups
    // gone, this item is the run's user surface. It fires the existing
    // `pzstudio.watch` command, so clicking it runs the identical gated
    // toggle; disposal with the subscriptions detaches the state
    // subscription and the item together.
    const devSyncStatusBar = registerDevSyncStatusBar(devSyncManager);

    // UX-15 Task 4: the explorer badge — the manager's state painted onto
    // the tree view created above, through the same subscription pattern
    // the status bar follows; disposal detaches it like any subscription.
    const devSyncBadge = registerDevSyncTreeBadge(devSyncManager, treeView);

    // Refresh the explorer when any project.json changes (new/added/renamed/
    // deleted mods all touch it).
    const projectJsonWatcher =
        vscode.workspace.createFileSystemWatcher('**/project.json');
    projectJsonWatcher.onDidChange(() => projectExplorer.requestRefresh());
    projectJsonWatcher.onDidCreate(() => projectExplorer.requestRefresh());
    projectJsonWatcher.onDidDelete(() => projectExplorer.requestRefresh());

    const executePZCommand = createCommandRunner(
        studio,
        outputChannel,
        () => projectExplorer.requestRefresh(),
        (cmd) => notifyFirstBuildSuccess(context, cmd),
    );

    // UX-16: user-invoked failures route through the host logger (one
    // notification, channel detail, Show Details) — the handlers themselves
    // stay notification-free. Shared by doctor and the game-log analyzer.
    const hostErrorSink = (error: unknown): void =>
        pzLogger.error(error instanceof Error ? error : String(error));

    context.subscriptions.push(
        outputChannel,
        // The manager owns the controller AND the state service — disposal
        // settles a mid-start run through the queued stop, then tears both
        // down (UX-15).
        devSyncManager,
        // The provider owns the per-project diagnostics cache (UX-07);
        // dropping it with the subscriptions is the cache's lifecycle end.
        projectExplorer,
        ...registerAllCommands(context, executePZCommand, studio),
        registerWatchCommand(devSyncManager),
        devSyncStatusBar,
        // UX-15 Task 4: dropping it with the subscriptions detaches the
        // badge's state subscription (the tree view itself disposes above).
        devSyncBadge,
        // UX-16: user-invoked doctor failures route through the host logger
        // (one notification, channel detail, Show Details) — the runner
        // itself stays notification-free.
        registerDoctorCommand(runProjectDiagnostics, hostErrorSink),
        // The game-log analyzer registers next to doctor (same UX-16 sink):
        // it needs the resolved attribution context — the plain
        // registerAllCommands list could not provide one, so its findings
        // never carried a sourceFile and diagnostics shipped dead.
        registerAnalyzeGameLogCommand(
            async (logPath?: string) =>
                analyzeGameLogFile(logPath, await resolveGameLogContext()),
            hostErrorSink,
        ),
        treeView,
        projectJsonWatcher,
        ...registerExplorerCommands(projectExplorer),
        vscode.tasks.registerTaskProvider(
            PZ_TASK_TYPE,
            new BuildTaskProvider(studio, () =>
                notifyFirstBuildSuccess(context, 'build'),
            ),
        ),
        // Re-read pzstudio.language and repaint the tree when it changes;
        // UX-11: pzstudio.gameBuild is invisible to the project.json
        // fingerprint, so changing it bumps a full diagnostics invalidation
        // (in-flight runs severed) and repaints the Explorer badges.
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('pzstudio.language')) {
                await initExtensionL10n(context);
                projectExplorer.refresh();
            }
            if (e.affectsConfiguration('pzstudio.gameBuild')) {
                projectExplorer.invalidateDiagnostics();
                projectExplorer.refresh();
            }
        }),
    );
}

export function deactivate() {
    // Nothing to clean up: the host instance and all its owned state
    // (logger, settings, transport) die with the extension context; DevSync
    // stops via disposal (the manager is already in subscriptions — it
    // settles a mid-start run through the queued stop, then disposes the
    // controller and the state service).
}
