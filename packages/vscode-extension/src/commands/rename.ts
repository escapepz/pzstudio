import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId } from '../util/project';
import { confirmBeforeRun, disableConfirmBeforeRun } from '../util/confirm';
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

            // Shared destructive consent (bf4-n07): the same
            // pzstudio.confirmBeforeRun modal gate build/clean/delete use —
            // a disabled setting skips the modal, "Don't Ask Again" persists
            // the bypass on the project's workspace folder.
            const decision = await confirmBeforeRun('rename', modId, newName);
            if (decision === 'cancel') {
                return;
            }
            if (decision === 'never') {
                await disableConfirmBeforeRun(projectDir.fsPath);
            }

            // The embedded API refuses destructive commands without --yes
            // (CLI-9): our confirm above IS the confirmation, so forward it.
            await execute('rename', [modId, newName], ['--yes'], {
                projectDir: projectDir.fsPath,
            });
        },
    );
}
