import * as vscode from 'vscode';
import type { PzStudio } from '@pzstudio/cli/api';
import { resolveFlags } from './flags';
import { resolveProjectDir, warnNoProject } from './project';
import { t } from './l10n';

export interface ExecuteOptions {
    projectDir?: string;
    requiresProject?: boolean;
}

export type ExecutePZCommand = (
    command: string,
    args?: string[],
    extraFlags?: string[],
    options?: ExecuteOptions,
) => Promise<void>;

const COMMAND_LABEL_KEYS: Record<string, string> = {
    build: 'Build',
    clean: 'Clean',
    update: 'Update',
    new: 'New Project',
    add: 'Add Mod',
    delete: 'Delete Mod',
    rename: 'Rename Mod ID',
    lang: 'New Language',
    modinfo: 'Generate ModInfo',
    modconfig: 'Configure Mod',
};

export function commandLabel(command: string): string {
    const key = COMMAND_LABEL_KEYS[command];
    return key ? t(key) : command;
}

export function createCommandRunner(
    studio: PzStudio,
    outputChannel: vscode.OutputChannel,
    onFinished?: () => void,
    onSuccess?: (command: string) => void,
): ExecutePZCommand {
    const busyCommands = new Set<string>();

    return async (command, args = [], extraFlags = [], options = {}) => {
        if (busyCommands.has(command)) {
            vscode.window.showWarningMessage(
                t(
                    "PZStudio: command '{0}' is already running.",
                    commandLabel(command),
                ),
            );
            return;
        }
        busyCommands.add(command);

        try {
            let projectDir = options.projectDir;
            if (!projectDir && options.requiresProject !== false) {
                const dir = await resolveProjectDir(command);
                if (!dir) {
                    warnNoProject(command);
                    return;
                }
                projectDir = dir.fsPath;
            }

            const flags = [
                ...resolveFlags(command, undefined, projectDir),
                ...extraFlags,
            ];
            const verboseMode = flags.includes('--verbose');

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: t('PZStudio: {0}', commandLabel(command)),
                    cancellable: false,
                },
                async () => {
                    try {
                        const runOptions: {
                            flags: string[];
                            projectDir?: string;
                        } = { flags };
                        if (projectDir) {
                            runOptions.projectDir = projectDir;
                        }
                        await studio.run(command, args, runOptions);
                        onSuccess?.(command);
                    } catch (e) {}
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
