import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId } from '../util/project';

type BuildStateAction = 'include' | 'devonly' | 'exclude';

/**
 * Registers the per-mod build-state toggles (included / dev only / excluded).
 * The inline buttons show the two states a row can switch to; clicking runs
 * immediately — the tree description mirrors the new state after refresh.
 */
export function registerModStateCommands(
    execute: ExecutePZCommand,
): vscode.Disposable[] {
    return (
        [
            [
                'pzstudio.modInclude',
                'include',
                'Select mod to include in build',
            ],
            [
                'pzstudio.modDevOnly',
                'devonly',
                'Select mod to build in dev_branch only',
            ],
            [
                'pzstudio.modExclude',
                'exclude',
                'Select mod to exclude from build',
            ],
        ] as Array<[string, BuildStateAction, string]>
    ).map(([command, action, prompt]) =>
        vscode.commands.registerCommand(command, async (node?: unknown) => {
            const modNode = asModNode(node);
            const modId = modNode?.modId ?? (await pickModId(prompt));
            if (!modId) {
                return;
            }
            await execute('modconfig', [modId, action], undefined, {
                projectDir: modNode?.projectDir.fsPath,
            });
        }),
    );
}
