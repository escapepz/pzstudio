import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId } from '../util/project';
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

            const confirm = await vscode.window.showWarningMessage(
                t(
                    "Are you sure you want to delete mod '{0}'? This cannot be undone.",
                    modId,
                ),
                { modal: true },
                t('Yes'),
            );
            if (confirm !== t('Yes')) return;

            // The embedded API refuses destructive commands without --yes
            // (CLI-9): our modal above IS the confirmation, so forward it.
            await execute('delete', [modId], ['--yes'], {
                projectDir: projectDir.fsPath,
            });
        },
    );
}
