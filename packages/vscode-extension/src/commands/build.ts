import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asProjectNode } from '../providers/projectExplorer';
import { readProjectSummary, resolveProjectDir } from '../util/project';
import { basename } from 'path';
import { confirmBeforeRun, disableConfirmBeforeRun } from '../util/confirm';

export function registerBuildCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.build',
        async (node?: unknown) => {
            const dir =
                asProjectNode(node)?.projectDir ??
                (await resolveProjectDir('build'));

            if (dir) {
                // Name the workshop in the confirm so a wrong-project pick
                // is obvious before anything is written.
                const { title } = await readProjectSummary(dir);
                const decision = await confirmBeforeRun(
                    'build',
                    title ?? basename(dir.fsPath),
                );
                if (decision === 'cancel') {
                    return;
                }
                if (decision === 'never') {
                    await disableConfirmBeforeRun(dir.fsPath);
                }
            }

            await execute('build', [], undefined, { projectDir: dir?.fsPath });
        },
    );
}
