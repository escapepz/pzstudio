import * as vscode from 'vscode';
import { ProjectExplorerProvider } from '../providers/projectExplorer';

export function registerExplorerRefreshCommand(
    provider: ProjectExplorerProvider,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.explorer.refresh', () =>
        provider.refresh(),
    );
}
