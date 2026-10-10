import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asProjectNode } from '../providers/projectExplorer';
import {
    readProjectSummary,
    resolveProjectDirResult,
    warnNoProject,
} from '../util/project';
import { basename } from 'path';
import { confirmBeforeRun, disableConfirmBeforeRun } from '../util/confirm';

export function registerCleanCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.clean',
        async (node?: unknown) => {
            const nodeDir = asProjectNode(node)?.projectDir;
            const resolved = nodeDir
                ? { status: 'resolved' as const, dir: nodeDir }
                : await resolveProjectDirResult('clean');

            if (resolved.status !== 'resolved') {
                // Cancelled (UX-02): abort silently — no second prompt, no
                // "no project" warning. Only a project-less workspace warns.
                if (resolved.status === 'no-project') {
                    warnNoProject('clean');
                }
                return;
            }
            const dir = resolved.dir;

            // Name the workshop in the confirm so a wrong-project pick
            // is obvious before anything is deleted.
            const { title } = await readProjectSummary(dir);
            const decision = await confirmBeforeRun(
                'clean',
                title ?? basename(dir.fsPath),
            );
            if (decision === 'cancel') {
                return;
            }
            if (decision === 'never') {
                await disableConfirmBeforeRun(dir.fsPath);
            }

            await execute('clean', [], undefined, { projectDir: dir.fsPath });
        },
    );
}
