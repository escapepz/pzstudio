import * as vscode from 'vscode';
import { setLogger, setProjectDir, setVsCodeSettings } from 'pzstudio-cli/api';
import { createPZLogger } from './util/logger';
import {
    subscribeToConfigurationChanges,
    updateVsCodeSettings,
} from './util/settings';
import { createCommandRunner } from './util/execute';
import { registerAllCommands } from './commands';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel(
        'Project Zomboid Studio',
    );

    setLogger(createPZLogger(outputChannel));

    updateVsCodeSettings();
    context.subscriptions.push(subscribeToConfigurationChanges());

    const executePZCommand = createCommandRunner(outputChannel);

    context.subscriptions.push(
        outputChannel,
        ...registerAllCommands(context, executePZCommand),
    );
}

export function deactivate() {
    setLogger(undefined);
    setProjectDir(undefined);
    setVsCodeSettings(undefined, undefined);
}
