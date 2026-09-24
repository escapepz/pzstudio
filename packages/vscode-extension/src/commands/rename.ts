import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId } from '../util/project';

export function registerRenameCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.rename',
        async (node?: unknown) => {
            const modNode = asModNode(node);
            const modId =
                modNode?.modId ??
                (await pickModId(vscode.l10n.t('Select mod to rename')));
            if (!modId) return;

            const newName = await vscode.window.showInputBox({
                prompt: vscode.l10n.t(
                    "Enter new mod ID for '{0}' (renames the folder and the project.json key, not the mod's display name)",
                    modId,
                ),
            });
            if (!newName) return;

            await execute('rename', [modId, newName], undefined, {
                projectDir: modNode?.projectDir.fsPath,
            });
        },
    );
}
