import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { pickModId } from '../util/project';

export function registerRenameCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.rename', async () => {
        const modId = await pickModId('Select mod to rename');
        if (!modId) return;

        const newName = await vscode.window.showInputBox({
            prompt: 'Enter new Mod Name',
        });
        if (!newName) return;

        await execute('rename', [modId, newName]);
    });
}
