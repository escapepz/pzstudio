import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';

export function registerBuildCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.build', () =>
        execute('build'),
    );
}
