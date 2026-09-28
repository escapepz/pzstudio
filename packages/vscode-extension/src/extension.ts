import * as vscode from 'vscode';
import { setLogger, setProjectDir, setVsCodeSettings } from 'pzstudio-cli/api';
import { createPZLogger } from './util/logger';
import { initExtensionL10n } from './util/l10n';
import {
    subscribeToConfigurationChanges,
    updateVsCodeSettings,
} from './util/settings';
import { createCommandRunner } from './util/execute';
import { DevSyncController } from './util/devsync';
import { registerAllCommands } from './commands';
import { registerExplorerCommands } from './commands/explorer';
import { registerWatchCommand } from './commands/watch';
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

    setLogger(createPZLogger(outputChannel));

    updateVsCodeSettings();
    context.subscriptions.push(subscribeToConfigurationChanges());

    const projectExplorer = new ProjectExplorerProvider(context.extensionUri);
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

    const executePZCommand = createCommandRunner(outputChannel, () =>
        projectExplorer.requestRefresh(),
    );

    // Development Sync Engine: one controller shared by the palette toggle.
    const devSync = new DevSyncController();

    context.subscriptions.push(
        outputChannel,
        devSync,
        ...registerAllCommands(context, executePZCommand),
        registerWatchCommand(devSync),
        treeView,
        projectJsonWatcher,
        ...registerExplorerCommands(projectExplorer),
        vscode.tasks.registerTaskProvider(
            PZ_TASK_TYPE,
            new BuildTaskProvider(),
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
