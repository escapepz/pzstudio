import * as vscode from 'vscode';
import { resolveModInfoTargets, setProjectDir } from 'pzstudio-cli/api';
import { existsSync } from 'fs';
import { join } from 'path';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId, resolveProjectDir } from '../util/project';

export function registerModinfoCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.modinfoGenerate',
        async (node?: unknown) => {
            const modNode = asModNode(node);
            const modId =
                modNode?.modId ??
                (await pickModId('Select mod to generate mod.info for'));
            if (!modId) {
                return;
            }

            const projectDir =
                modNode?.projectDir.fsPath ??
                (await resolveProjectDir('mod.info generation'))?.fsPath;

            // Generation never overwrites silently: when a mod.info already
            // exists in a branch folder, ask before passing --force.
            let extraFlags: string[] | undefined;
            if (projectDir) {
                setProjectDir(projectDir);
                const existing = resolveModInfoTargets(modId).filter((dir) =>
                    existsSync(join(dir, 'mod.info')),
                );
                if (existing.length > 0) {
                    const overwrite = await vscode.window.showWarningMessage(
                        `mod.info already exists in ${existing.length} branch folder(s) of '${modId}'. Overwrite?`,
                        { modal: true },
                        'Overwrite',
                    );
                    if (overwrite !== 'Overwrite') {
                        return;
                    }
                    extraFlags = ['--force'];
                }
            }

            await execute('modinfo', ['generate', modId], extraFlags, {
                projectDir,
            });
        },
    );
}
