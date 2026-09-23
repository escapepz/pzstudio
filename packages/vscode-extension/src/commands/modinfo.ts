import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { pickModId } from '../util/project';

export function registerModinfoCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.modinfoGenerate',
        async () => {
            const modId = await pickModId(
                'Select mod to generate mod.info for',
            );

            await execute('modinfo', ['generate', ...(modId ? [modId] : [])]);
        },
    );
}
