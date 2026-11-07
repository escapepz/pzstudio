import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';

export function registerUpdateCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    // Update refreshes the GLOBAL template caches (the CLI's updateCmd never
    // resolves a project), so it runs through the shared runner without a
    // project requirement: no picker, no "no project" warning, in any
    // workspace — including an empty one (UX-03).
    return vscode.commands.registerCommand('pzstudio.update', () =>
        execute('update', [], undefined, { requiresProject: false }),
    );
}
