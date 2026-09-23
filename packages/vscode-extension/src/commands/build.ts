import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asProjectNode } from '../providers/projectExplorer';
import { resolveProjectDir } from '../util/project';
import { basename } from 'path';
import { confirmBeforeRun, disableConfirmBeforeRun } from '../util/confirm';

export function registerBuildCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.build',
        async (node?: unknown) => {
            const projectDir =
                asProjectNode(node)?.projectDir.fsPath ??
                (await resolveProjectDir('build'))?.fsPath;

            if (projectDir) {
                const decision = await confirmBeforeRun(
                    'build',
                    basename(projectDir),
                );
                if (decision === 'cancel') {
                    return;
                }
                if (decision === 'never') {
                    await disableConfirmBeforeRun(projectDir);
                }
            }

            await execute('build', [], undefined, { projectDir });
        },
    );
}
