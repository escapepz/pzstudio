import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { pickModId } from '../util/project';
import { t } from '../util/l10n';

export function registerLangCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.lang', async () => {
        const picked = await pickModId(t('Select mod'), {
            action: 'add a language to',
        });
        if (!picked) return;

        const language = await vscode.window.showInputBox({
            prompt: t('Enter language code (e.g. EN, FR, PTBR)'),
        });
        if (!language) return;

        await execute('lang', [picked.modId, language], undefined, {
            projectDir: picked.projectDir.fsPath,
        });
    });
}
