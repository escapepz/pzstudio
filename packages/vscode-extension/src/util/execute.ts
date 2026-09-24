import * as vscode from 'vscode';
import { runCLI, setProjectDir } from 'pzstudio-cli/api';
import { resolveFlags } from './flags';
import { resolveProjectDir } from './project';

export interface ExecuteOptions {
    /**
     * Project directory to run against (fsPath). When set — e.g. from a tree
     * view context menu — the folder picker is skipped entirely.
     */
    projectDir?: string;
}

export type ExecutePZCommand = (
    command: string,
    args?: string[],
    extraFlags?: string[],
    options?: ExecuteOptions,
) => Promise<void>;

export function createCommandRunner(
    outputChannel: vscode.OutputChannel,
    onFinished?: () => void,
): ExecutePZCommand {
    // One command at a time: runCLI is not reentrant (shared global state
    // for project dir/settings), so overlap would mis-parse flags.
    const busyCommands = new Set<string>();

    return async (command, args = [], extraFlags = [], options = {}) => {
        if (busyCommands.has(command)) {
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "PZStudio: command '{0}' is already running.",
                    command,
                ),
            );
            return;
        }
        busyCommands.add(command);

        try {
            if (options.projectDir) {
                setProjectDir(options.projectDir);
            } else {
                // F1 / keybinding entry points have no tree context: detect
                // from the active editor, else quick-pick. No project at all
                // → warn instead of surfacing the raw CLI error.
                const dir = await resolveProjectDir(command);
                if (!dir) {
                    vscode.window.showWarningMessage(
                        vscode.l10n.t(
                            "PZStudio: no PZ project (project.json) found in this workspace — nothing to {0}. Use 'PZStudio: New Project' to create one.",
                            command,
                        ),
                    );
                    return;
                }
                setProjectDir(dir.fsPath);
            }

            // Flags are passed explicitly to runCLI — no process.argv mutation.
            const flags = [...resolveFlags(command), ...extraFlags];
            const verboseMode = flags.includes('--verbose');

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: vscode.l10n.t('PZStudio: {0}', command),
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
            onFinished?.();
        }
    };
}
