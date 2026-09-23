import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asProjectNode } from '../providers/projectExplorer';
import { resolveProjectDir } from '../util/project';
import { basename } from 'path';
import { confirmBeforeRun, disableConfirmBeforeRun } from '../util/confirm';

export function registerCleanCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.clean',
        async (node?: unknown) => {
            const projectDir =
                asProjectNode(node)?.projectDir.fsPath ??
                (await resolveProjectDir('clean'))?.fsPath;

            if (projectDir) {
                const decision = await confirmBeforeRun(
                    'clean',
                    basename(projectDir),
                );
                if (decision === 'cancel') {
                    return;
                }
                if (decision === 'never') {
                    await disableConfirmBeforeRun(projectDir);
                }
            }

            await execute('clean', [], undefined, { projectDir });
        },
    );
}
