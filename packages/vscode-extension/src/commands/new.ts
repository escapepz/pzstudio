import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { t } from '../util/l10n';

export function registerNewCommand(
    context: vscode.ExtensionContext,
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.new', async () => {
        const projectTitle = await vscode.window.showInputBox({
            prompt: t('Enter Project Title'),
            placeHolder: t('My Awesome Mod'),
        });
        if (!projectTitle) return;

        const modId = await vscode.window.showInputBox({
            prompt: t(
                'Enter Mod ID (Optional, leave blank for auto-generated)',
            ),
            placeHolder: 'my_awesome_mod',
        });

        // Issue #43: let the user pick where the project is created,
        // instead of always using the current workspace folder.
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const lastUsed = context.workspaceState.get<string>(
            'pzstudio.lastNewProjectDestination',
        );
        const defaultUri =
            workspaceFolder ??
            (lastUsed ? vscode.Uri.file(lastUsed) : undefined);

        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: t('Select Destination Folder'),
            title: t("Create project '{0}' in...", projectTitle),
            defaultUri,
        });

        // A selection wins; cancelling falls back to the default
        // (workspace folder or last used destination)
        let destination: string | undefined;
        if (picked && picked.length > 0) {
            destination = picked[0].fsPath;
            context.workspaceState.update(
                'pzstudio.lastNewProjectDestination',
                destination,
            );
        } else if (defaultUri) {
            destination = defaultUri.fsPath;
        }

        if (!destination) {
            vscode.window.showWarningMessage(
                t(
                    'PZStudio: No destination folder selected, project creation cancelled.',
                ),
            );
            return;
        }

        await execute(
            'new',
            [projectTitle, modId || ''],
            ['--path', destination],
        );
    });
}
