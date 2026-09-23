import * as vscode from 'vscode';
import { runCLI, setProjectDir } from 'pzstudio-cli/api';
import { resolveFlags } from './flags';
import { pickProjectFolder } from './project';

export type ExecutePZCommand = (
    command: string,
    args?: string[],
    extraFlags?: string[],
) => Promise<void>;

export function createCommandRunner(
    outputChannel: vscode.OutputChannel,
): ExecutePZCommand {
    // One command at a time: runCLI is not reentrant (shared global state
    // for project dir/settings), so overlap would mis-parse flags.
    const busyCommands = new Set<string>();

    return async (command, args = [], extraFlags = []) => {
        if (busyCommands.has(command)) {
            vscode.window.showWarningMessage(
                `PZStudio: command '${command}' is already running.`,
            );
            return;
        }
        busyCommands.add(command);

        try {
            const folder = await pickProjectFolder();
            setProjectDir(folder?.uri.fsPath);

            // Flags are passed explicitly to runCLI — no process.argv mutation.
            const flags = [...resolveFlags(command), ...extraFlags];
            const verboseMode = flags.includes('--verbose');

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `PZStudio: ${command}`,
                    cancellable: false,
                },
                async () => {
                    try {
                        await runCLI(command, args, { flags });
                    } catch (e) {
                        // Already surfaced by logger.error
                    }
                },
            );

            if (verboseMode) {
                outputChannel.show(true);
            }
        } finally {
            busyCommands.delete(command);
        }
    };
}
