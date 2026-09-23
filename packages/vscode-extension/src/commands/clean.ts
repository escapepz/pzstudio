import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asProjectNode } from '../providers/projectExplorer';

export function registerCleanCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.clean', (node?: unknown) =>
        execute('clean', [], undefined, {
            projectDir: asProjectNode(node)?.projectDir.fsPath,
        }),
    );
}
