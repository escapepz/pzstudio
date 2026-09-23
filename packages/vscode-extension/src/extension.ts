import * as vscode from 'vscode';
import { setLogger, setProjectDir, setVsCodeSettings } from 'pzstudio-cli/api';
import { createPZLogger } from './util/logger';
import {
    subscribeToConfigurationChanges,
    updateVsCodeSettings,
} from './util/settings';
import { createCommandRunner } from './util/execute';
import { registerAllCommands } from './commands';
import { registerExplorerCommands } from './commands/explorer';
import {
    PROJECT_EXPLORER_VIEW_ID,
    ProjectExplorerProvider,
} from './providers/projectExplorer';
import { BuildTaskProvider, PZ_TASK_TYPE } from './providers/buildTaskProvider';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel(
        'Project Zomboid Studio',
    );

    setLogger(createPZLogger(outputChannel));

    updateVsCodeSettings();
    context.subscriptions.push(subscribeToConfigurationChanges());

    const projectExplorer = new ProjectExplorerProvider();
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

    context.subscriptions.push(
        outputChannel,
        ...registerAllCommands(context, executePZCommand),
        treeView,
        projectJsonWatcher,
        ...registerExplorerCommands(projectExplorer),
        vscode.tasks.registerTaskProvider(
            PZ_TASK_TYPE,
            new BuildTaskProvider(),
        ),
    );
}

export function deactivate() {
    setLogger(undefined);
    setProjectDir(undefined);
    setVsCodeSettings(undefined, undefined);
}
