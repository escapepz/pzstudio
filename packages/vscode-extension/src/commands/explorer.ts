import * as vscode from 'vscode';
import { ProjectExplorerProvider } from '../providers/projectExplorer';

export function registerExplorerCommands(
    provider: ProjectExplorerProvider,
): vscode.Disposable[] {
    return [
        // The title-bar Refresh is the explicit diagnostic refresh path:
        // it drops the cached badges (UX-07) so the rescan recomputes them,
        // unlike presentation refreshes which reuse valid cache entries.
        vscode.commands.registerCommand('pzstudio.explorer.refresh', () =>
            provider.refresh({ invalidateDiagnostics: true }),
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
