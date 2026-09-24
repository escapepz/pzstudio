import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { pickModId } from '../util/project';
import { t } from '../util/l10n';

export function registerLangCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.lang', async () => {
        const modId = await pickModId(t('Select mod'));
        if (!modId) return;

        const language = await vscode.window.showInputBox({
            prompt: t('Enter language code (e.g. EN, FR, PTBR)'),
        });
        if (!language) return;

        await execute('lang', [modId, language]);
    });
}
