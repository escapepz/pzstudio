import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId } from '../util/project';
import { t } from '../util/l10n';

export function registerRenameCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.rename',
        async (node?: unknown) => {
            const modNode = asModNode(node);
            const picked = modNode
                ? { modId: modNode.modId, projectDir: modNode.projectDir }
                : await pickModId(t('Select mod to rename'), {
                      action: 'rename mods in',
                  });
            if (!picked) return;
            const { modId, projectDir } = picked;

            const newName = await vscode.window.showInputBox({
                prompt: t(
                    "Enter new mod ID for '{0}' (renames the folder and the project.json key, not the mod's display name)",
                    modId,
                ),
            });
            if (!newName) return;

            const confirm = await vscode.window.showWarningMessage(
                t("Rename mod '{0}' to '{1}'?", modId, newName),
                { modal: true },
                t('Yes'),
            );
            if (confirm !== t('Yes')) return;

            // The embedded API refuses destructive commands without --yes
            // (CLI-9): our modal above IS the confirmation, so forward it.
            await execute('rename', [modId, newName], ['--yes'], {
                projectDir: projectDir.fsPath,
            });
        },
    );
}
