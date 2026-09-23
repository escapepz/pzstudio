import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId } from '../util/project';

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

            await execute(
                'modinfo',
                ['generate', ...(modId ? [modId] : [])],
                undefined,
                { projectDir: modNode?.projectDir.fsPath },
            );
        },
    );
}
