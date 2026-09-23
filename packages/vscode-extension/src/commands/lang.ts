import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { pickModId } from '../util/project';

export function registerLangCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.lang', async () => {
        const modId = await pickModId('Select mod');
        if (!modId) return;

        const language = await vscode.window.showInputBox({
            prompt: 'Enter language code (e.g. EN, FR, PTBR)',
        });
        if (!language) return;

        await execute('lang', [modId, language]);
    });
}
