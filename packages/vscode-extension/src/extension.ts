import * as vscode from 'vscode';
import {
    createPzStudio,
    setLogger,
    setProjectDir,
    setVsCodeSettings,
} from '@pzstudio/cli/api';
import { createPZLogger } from './util/logger';
import { initExtensionL10n } from './util/l10n';
import {
    readPzStudioHostSettings,
    updateVsCodeSettings,
    subscribeToConfigurationChanges,
} from './util/settings';
import { createCommandRunner } from './util/execute';
import { DevSyncController } from './util/devsync';
import { runProjectDiagnostics } from './util/doctor';
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

    // One extension logger for both tiers: the legacy slot still feeds the
    // not-yet-migrated consumers (devsync, doctor, modinfo), and the same
    // instance is handed to the v2 host instance below (runner, task
    // provider). The legacy slot write is retired in commit 11 (doc 11
    // §12/§14).
    const pzLogger = createPZLogger(outputChannel);
    setLogger(pzLogger);

    // TRANSITIONAL COMPATIBILITY BRIDGE (doc 11 §17 commit 7, corrected):
    // the still-legacy consumers (build task provider, DevSync, doctor)
    // read only the raw legacy settings slots (R1), so the same snapshot
    // the v2 provider serves must keep being pushed to them until the last
    // of them migrates — removed with the legacy bridge retirement
    // (commit 11), never consumed by the v2 path.
    updateVsCodeSettings();
    context.subscriptions.push(subscribeToConfigurationChanges());

    // One host instance for the generic runner (doc 11 §17 commit 7): the
    // settings provider reads the same workspace/global layers the push
    // bridge feeds the legacy slots, fresh on every run — the context is
    // intentionally ignored for now (UX-05 preserved until the later
    // frozen commit).
    const studio = createPzStudio({
        logger: pzLogger,
        settings: (ctx) => readPzStudioHostSettings(ctx),
    });

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
    const devSync = new DevSyncController();

    context.subscriptions.push(
        outputChannel,
        devSync,
        ...registerAllCommands(context, executePZCommand),
        registerWatchCommand(devSync),
        registerDoctorCommand(),
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
    setLogger(undefined);
    setProjectDir(undefined);
    setVsCodeSettings(undefined, undefined);
}
