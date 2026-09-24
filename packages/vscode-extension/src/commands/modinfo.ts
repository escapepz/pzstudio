import * as vscode from 'vscode';
import { resolveModInfoTargets, setProjectDir } from 'pzstudio-cli/api';
import { existsSync } from 'fs';
import { join } from 'path';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId, resolveProjectDir } from '../util/project';
import { t } from '../util/l10n';

export function registerModinfoCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.modinfoGenerate',
        async (node?: unknown) => {
            const modNode = asModNode(node);
            const modId =
                modNode?.modId ??
                (await pickModId(t('Select mod to generate mod.info for')));
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
                        t(
                            "mod.info already exists in {0} branch folder(s) of '{1}'. Overwrite?",
                            String(existing.length),
                            modId,
                        ),
                        { modal: true },
                        t('Overwrite'),
                    );
                    if (overwrite !== t('Overwrite')) {
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
