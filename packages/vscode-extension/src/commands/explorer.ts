import * as vscode from 'vscode';
import { ProjectExplorerProvider } from '../providers/projectExplorer';

export function registerExplorerCommands(
    provider: ProjectExplorerProvider,
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('pzstudio.explorer.refresh', () =>
            provider.refresh(),
        ),
        vscode.commands.registerCommand('pzstudio.explorer.toggleFiles', () =>
            provider.toggleShowAllFiles(),
        ),
    ];
}
