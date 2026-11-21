import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId } from '../util/project';
import { confirmBeforeRun, disableConfirmBeforeRun } from '../util/confirm';
import { t } from '../util/l10n';

export function registerDeleteCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.delete',
        async (node?: unknown) => {
            const modNode = asModNode(node);
            const picked = modNode
                ? { modId: modNode.modId, projectDir: modNode.projectDir }
                : await pickModId(t('Select mod to delete'), {
                      action: 'delete mods from',
                  });
            if (!picked) return;
            const { modId, projectDir } = picked;

            const decision = await confirmBeforeRun('delete', modId);
            if (decision === 'cancel') {
                return;
            }
            if (decision === 'never') {
                await disableConfirmBeforeRun(projectDir.fsPath);
            }

            await execute('delete', [modId], ['--yes'], {
                projectDir: projectDir.fsPath,
            });
        },
    );
}
