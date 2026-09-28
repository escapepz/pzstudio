import * as vscode from 'vscode';
import { t } from '../util/l10n';
import { resolveProjectDir, warnNoProject } from '../util/project';
import { DevSyncController } from '../util/devsync';

/**
 * Palette toggle for the Development Sync Engine. Starting resolves the
 * project like every other command (tree context does not exist on a
 * palette run) and hands the folder to the controller; the controller keeps
 * running across command invocations until toggled off.
 */
export function registerWatchCommand(
    controller: DevSyncController,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.watch', async () => {
        if (controller.active) {
            await controller.stop();
            vscode.window.showInformationMessage(
                t('PZStudio: development sync stopped.'),
            );
            return;
        }

        const action = 'start the development sync in';
        const dir = await resolveProjectDir(action);
        if (!dir) {
            warnNoProject(action);
            return;
        }
        await controller.start(dir.fsPath);
        vscode.window.showInformationMessage(
            t(
                "PZStudio: development sync started for '{0}' — run the command again to stop.",
                dir.path.split('/').pop() ?? dir.fsPath,
            ),
        );
    });
}
