import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId } from '../util/project';

type BuildStateAction = 'include' | 'devonly' | 'exclude';

/**
 * Registers the two build-state buttons shown on every mod row:
 *
 * - One include/exclude toggle displaying the mod's CURRENT state (eye =
 *   included, closed eye = excluded); clicking flips to the other state.
 *   A dev-only mod still counts as included in the dev build, so it shows
 *   the eye. This button is never dimmed.
 * - One dev_branch-only indicator (beaker): lit while the mod IS dev-only
 *   (clicking turns it off) and dimmed otherwise (clicking turns it on).
 *
 * Commands are named for the state they display; the executed modconfig
 * action is the toggle. Clicks run immediately and the tree description
 * mirrors the new state after refresh.
 */
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
                // Palette use is disabled for these state commands; reaching
                // here without a tree node falls back to the mod picker.
                const picked = await pickModId(
                    `Select mod to ${
                        action === 'devonly'
                            ? 'build in dev_branch only'
                            : action
                    }`,
                );
                if (!picked) {
                    return;
                }
                await execute('modconfig', [picked, action]);
                return;
            }
            await execute('modconfig', [modId, action], undefined, {
                projectDir: modNode.projectDir.fsPath,
            });
        }),
    );
}
