import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';

export function registerUpdateCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.update', () =>
        execute('update'),
    );
}
