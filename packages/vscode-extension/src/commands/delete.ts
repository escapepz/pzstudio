import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId } from '../util/project';

export function registerDeleteCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.delete',
        async (node?: unknown) => {
            const modNode = asModNode(node);
            const modId =
                modNode?.modId ??
                (await pickModId(vscode.l10n.t('Select mod to delete')));
            if (!modId) return;

            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Are you sure you want to delete mod '{0}'? This cannot be undone.",
                    modId,
                ),
                { modal: true },
                vscode.l10n.t('Yes'),
            );
            if (confirm !== vscode.l10n.t('Yes')) return;

            await execute('delete', [modId], undefined, {
                projectDir: modNode?.projectDir.fsPath,
            });
        },
    );
}
