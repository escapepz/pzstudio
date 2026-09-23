import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asProjectNode } from '../providers/projectExplorer';

export function registerBuildCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.build', (node?: unknown) =>
        execute('build', [], undefined, {
            projectDir: asProjectNode(node)?.projectDir.fsPath,
        }),
    );
}
