import * as vscode from 'vscode';
import { createPzStudio } from '@pzstudio/cli/api';
import { createPZLogger } from './util/logger';
import { initExtensionL10n } from './util/l10n';
import { readPzStudioHostSettings } from './util/settings';
import { createCommandRunner } from './util/execute';
import { DevSyncController } from './util/devsync';
import { createProjectDiagnostics } from './util/doctor';
import { registerAllCommands } from './commands';
import { registerExplorerCommands } from './commands/explorer';
import { registerWatchCommand } from './commands/watch';
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

    // Refresh the explorer when any project.json changes (new/added/renamed/
    // deleted mods all touch it).
    const projectJsonWatcher =
        vscode.workspace.createFileSystemWatcher('**/project.json');
    projectJsonWatcher.onDidChange(() => projectExplorer.requestRefresh());
    projectJsonWatcher.onDidCreate(() => projectExplorer.requestRefresh());
    projectJsonWatcher.onDidDelete(() => projectExplorer.requestRefresh());

    const executePZCommand = createCommandRunner(studio, outputChannel, () =>
        projectExplorer.requestRefresh(),
    );

    // Development Sync Engine: one controller shared by the palette toggle.
    // The session comes from the host instance (per-apply settings
    // freshness, instance-logger routing — commit 9).
    const devSync = new DevSyncController(studio, pzLogger);

    context.subscriptions.push(
        outputChannel,
        devSync,
        // The provider owns the per-project diagnostics cache (UX-07);
        // dropping it with the subscriptions is the cache's lifecycle end.
        projectExplorer,
        ...registerAllCommands(context, executePZCommand, studio),
        registerWatchCommand(devSync),
        registerDoctorCommand(runProjectDiagnostics),
        treeView,
        projectJsonWatcher,
        ...registerExplorerCommands(projectExplorer),
        vscode.tasks.registerTaskProvider(
            PZ_TASK_TYPE,
            new BuildTaskProvider(studio),
        ),
        // Re-read pzstudio.language and repaint the tree when it changes.
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('pzstudio.language')) {
                await initExtensionL10n(context);
                projectExplorer.refresh();
            }
        }),
    );
}

export function deactivate() {
    // Nothing to clean up: the host instance and all its owned state
    // (logger, settings, transport) die with the extension context; DevSync
    // stops via disposal (the controller is already in subscriptions).
}
