import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';

export function registerCleanCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.clean', () =>
        execute('clean'),
    );
}
