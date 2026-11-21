import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId } from '../util/project';
import { t } from '../util/l10n';

type BuildStateAction = 'include' | 'devonly' | 'exclude';

export function registerModStateCommands(
    execute: ExecutePZCommand,
): vscode.Disposable[] {
    const defs = [
        {
            command: 'pzstudio.modIncluded',
            action: 'exclude' as BuildStateAction,
        },
        {
            command: 'pzstudio.modExcluded',
            action: 'include' as BuildStateAction,
        },
        {
            command: 'pzstudio.modDevOnly',
            action: 'include' as BuildStateAction,
        },
        {
            command: 'pzstudio.modDevOnly.dim',
            action: 'devonly' as BuildStateAction,
        },
    ];

    return defs.map(({ command, action }) =>
        vscode.commands.registerCommand(command, async (node?: unknown) => {
            const modNode = asModNode(node);
            const modId = modNode?.modId;
            if (!modId) {
                const picked = await pickModId(t('Select mod'), {
                    action: 'change mod build states in',
                });
                if (!picked) {
                    return;
                }
                await execute('modconfig', [picked.modId, action], undefined, {
                    projectDir: picked.projectDir.fsPath,
                });
                return;
            }
            await execute('modconfig', [modId, action], undefined, {
                projectDir: modNode.projectDir.fsPath,
            });
        }),
    );
}
