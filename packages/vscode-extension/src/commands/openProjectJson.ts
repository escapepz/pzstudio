import * as vscode from 'vscode';
import { asProjectNode } from '../providers/projectExplorer';

export function registerOpenProjectJsonCommand(): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.openProjectJson',
        async (node?: unknown) => {
            const projectDir = asProjectNode(node)?.projectDir;
            if (!projectDir) {
                return;
            }
            await vscode.commands.executeCommand(
                'vscode.open',
                vscode.Uri.joinPath(projectDir, 'project.json'),
            );
        },
    );
}
