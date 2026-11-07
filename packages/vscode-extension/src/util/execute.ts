import * as vscode from 'vscode';
import type { PzStudio } from '@pzstudio/cli/api';
import { resolveFlags } from './flags';
import { resolveProjectDir, warnNoProject } from './project';
import { t } from './l10n';

export interface ExecuteOptions {
    /**
     * Project directory to run against (fsPath). When set — e.g. from a tree
     * view context menu — the folder picker is skipped entirely.
     */
    projectDir?: string;
    /**
     * Whether the command needs a project context (default true). Global
     * operations like `update` refresh host-wide template caches and must
     * run project-less: no picker, no "no project" warning, and no
     * projectDir handed to the engine (its discovery then falls back to
     * cwd, which the v2 lifecycle defines for exactly this case).
     */
    requiresProject?: boolean;
}

export type ExecutePZCommand = (
    command: string,
    args?: string[],
    extraFlags?: string[],
    options?: ExecuteOptions,
) => Promise<void>;

/**
 * UX-17: human-readable labels for the engine commands the runner executes,
 * resolved through the shared l10n bundle (same tables every other runtime
 * string uses — no parallel translation source). The keys reuse the existing
 * confirmed-choice verbs ("Build", "Clean") and mirror the wording of the
 * manifest titles in package.nls.*.json, minus the "PZ Studio:" prefix.
 * Unknown ids fall back to the raw command id, which is still honest — the
 * stable internal ids and the studio.run contract are never translated.
 */
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

/** Localized label for an engine command id; the raw id is the fallback. */
export function commandLabel(command: string): string {
    const key = COMMAND_LABEL_KEYS[command];
    return key ? t(key) : command;
}

export function createCommandRunner(
    studio: PzStudio,
    outputChannel: vscode.OutputChannel,
    onFinished?: () => void,
): ExecutePZCommand {
    // One command of the same name at a time: a second trigger warns instead
    // of queueing (unchanged UX). Cross-command overlap is serialized by the
    // engine lock inside studio.run.
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
            // Explicit project context for THIS invocation (tree menu entry);
            // F1 / keybinding entry points have no tree context: detect from
            // the active editor, else quick-pick. No project at all → warn
            // instead of surfacing the raw CLI error — unless the command is
            // global (requiresProject: false), which runs as-is.
            let projectDir = options.projectDir;
            if (!projectDir && options.requiresProject !== false) {
                const dir = await resolveProjectDir(command);
                if (!dir) {
                    warnNoProject(command);
                    return;
                }
                projectDir = dir.fsPath;
            }

            // Flags are passed through the run options — no process.argv
            // mutation. They resolve for the project resolved above (UX-05):
            // a global run (no projectDir) stays resource-less.
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
                        // No resolved project → no projectDir key at all, so
                        // a global run can never inherit a previous command's
                        // context or an arbitrary first-project anchor.
                        const runOptions: {
                            flags: string[];
                            projectDir?: string;
                        } = { flags };
                        if (projectDir) {
                            runOptions.projectDir = projectDir;
                        }
                        await studio.run(command, args, runOptions);
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
