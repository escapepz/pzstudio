import * as vscode from 'vscode';
import type { PzStudio } from '@pzstudio/cli/api';
import { existsSync } from 'fs';
import { join } from 'path';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId } from '../util/project';
import { t } from '../util/l10n';

export function registerModinfoCommand(
    execute: ExecutePZCommand,
    studio: PzStudio,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.modinfoGenerate',
        async (node?: unknown) => {
            const modNode = asModNode(node);
            const picked = modNode
                ? { modId: modNode.modId, projectDir: modNode.projectDir }
                : await pickModId(t('Select mod to generate mod.info for'), {
                      action: 'generate mod.info for',
                  });
            if (!picked) {
                return;
            }
            const { modId, projectDir } = picked;

            // Generation never overwrites silently: when a mod.info already
            // exists in a branch folder, ask before passing --force. The
            // target branches resolve through the host instance with the
            // explicit project — no legacy project anchor write (doc 11 §17
            // commit 10).
            let extraFlags: string[] | undefined;
            const existing = studio
                .resolveModInfoTargets(modId, projectDir.fsPath)
                .filter((dir) => existsSync(join(dir, 'mod.info')));
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

            await execute('modinfo', ['generate', modId], extraFlags, {
                projectDir: projectDir.fsPath,
            });
        },
    );
}
