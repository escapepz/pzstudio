import * as vscode from 'vscode';
import { createPzStudio } from '@pzstudio/cli/api';
import { createPZLogger } from './util/logger';
import { initExtensionL10n } from './util/l10n';
import { readPzStudioHostSettings } from './util/settings';
import { createCommandRunner } from './util/execute';
import { notifyFirstBuildSuccess } from './util/firstSuccess';
import { DevSyncController } from './util/devsync';
import { DevSyncManager, DevSyncStateService } from './util/devSyncState';
import { createProjectDiagnostics } from './util/doctor';
import { registerAllCommands } from './commands';
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
    // toggle and the status-bar indicator below are its only consumers;
    // both gate on state.phase, so a click can never re-anchor a live run.
    const devSyncService = new DevSyncStateService();
    const devSync = new DevSyncController(studio, pzLogger);
    const devSyncManager = new DevSyncManager(devSync, devSyncService);

    // UX-15: the status-bar indicator — with the toggle's success popups
    // gone, this item is the run's user surface. It fires the existing
    // `pzstudio.watch` command, so clicking it runs the identical gated
    // toggle; disposal with the subscriptions detaches the state
    // subscription and the item together.
    const devSyncStatusBar = registerDevSyncStatusBar(devSyncManager);

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
        // UX-16: user-invoked doctor failures route through the host logger
        // (one notification, channel detail, Show Details) — the runner
        // itself stays notification-free.
        registerDoctorCommand(runProjectDiagnostics, (error) =>
            pzLogger.error(error instanceof Error ? error : String(error)),
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
