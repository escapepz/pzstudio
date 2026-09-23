import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { pickModId } from '../util/project';

export function registerDeleteCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.delete', async () => {
        const modId = await pickModId('Select mod to delete');
        if (!modId) return;

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete mod '${modId}'? This cannot be undone.`,
            { modal: true },
            'Yes',
        );
        if (confirm !== 'Yes') return;

        await execute('delete', [modId]);
    });
}
