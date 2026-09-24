import * as vscode from 'vscode';
import { ProjectExplorerProvider } from '../providers/projectExplorer';

export function registerExplorerCommands(
    provider: ProjectExplorerProvider,
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('pzstudio.explorer.refresh', () =>
            provider.refresh(),
        ),
        // Both toggle entries drive the same handler; the eye/eye-closed
        // pair is switched in the manifest via SHOW_ALL_FILES_CONTEXT_KEY.
        vscode.commands.registerCommand('pzstudio.explorer.toggleFiles', () =>
            provider.toggleShowAllFiles(),
        ),
        vscode.commands.registerCommand(
            'pzstudio.explorer.toggleFiles.hidden',
            () => provider.toggleShowAllFiles(),
        ),
    ];
}
