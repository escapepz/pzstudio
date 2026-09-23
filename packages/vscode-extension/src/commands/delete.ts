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
                modNode?.modId ?? (await pickModId('Select mod to delete'));
            if (!modId) return;

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to delete mod '${modId}'? This cannot be undone.`,
                { modal: true },
                'Yes',
            );
            if (confirm !== 'Yes') return;

            await execute('delete', [modId], undefined, {
                projectDir: modNode?.projectDir.fsPath,
            });
        },
    );
}
