import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { resolveProjectDir, warnNoProject } from '../util/project';
import { t } from '../util/l10n';

export function registerAddCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.add', async () => {
        // Project first, then the mod details — so the user always knows
        // which project a mod is being added to (multi-project workspaces).
        const projectDir = (await resolveProjectDir('add a mod to'))?.fsPath;
        if (!projectDir) {
            warnNoProject('add a mod to');
            return;
        }

        const modName = await vscode.window.showInputBox({
            prompt: t('Enter Mod Name'),
            placeHolder: t('My New Mod'),
        });
        if (!modName) return;

        const modId = await vscode.window.showInputBox({
            prompt: t(
                'Enter Mod ID (Optional, leave blank for auto-generated)',
            ),
            placeHolder: 'my_new_mod',
        });

        await execute('add', [modName, modId || ''], undefined, {
            projectDir,
        });
    });
}
