import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';

export function registerAddCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.add', async () => {
        const modName = await vscode.window.showInputBox({
            prompt: 'Enter Mod Name',
            placeHolder: 'My New Mod',
        });
        if (!modName) return;

        const modId = await vscode.window.showInputBox({
            prompt: 'Enter Mod ID (Optional, leave blank for auto-generated)',
            placeHolder: 'my_new_mod',
        });

        await execute('add', [modName, modId || '']);
    });
}
