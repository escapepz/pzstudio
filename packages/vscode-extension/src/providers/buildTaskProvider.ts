import * as vscode from 'vscode';
import type { PzStudio } from '@pzstudio/cli/api';
import { resolveFlags } from '../util/flags';
import { resolveProjectDir } from '../util/project';

export const PZ_TASK_TYPE = 'pzstudio';

export type PZTaskTarget = 'production' | 'development' | 'both' | 'clean';

export interface PZTaskDefinition extends vscode.TaskDefinition {
    target: string;
}

/**
 * Runs a pzstudio command as a VS Code task so builds are available from
 * Terminal > Run Task and Ctrl+Shift+B (after configuring the default build
 * task). Execution is in-process through the host PzStudio instance
 * (studio.run), consistent with the commands: detailed logs go to the PZ
 * output channel, the task terminal shows the start/complete/failed status
 * lines. No busy guard: a task started while another command is in-flight
 * queues on the engine invocation lock and runs after it (intentional
 * serialization, doc 11 §9).
 */
class PZTaskTerminal implements vscode.Pseudoterminal {
    private readonly writeEmitter = new vscode.EventEmitter<string>();
    readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    private readonly closeEmitter = new vscode.EventEmitter<void>();
    onDidClose: vscode.Event<void> = this.closeEmitter.event;

    constructor(
        private readonly target: PZTaskTarget,
        private readonly studio: PzStudio,
    ) {}

    open(): void {
        void this.run();
    }

    close(): void {
        // No interactive input; the run finishes on its own.
    }

    private async run() {
        const command = this.target === 'clean' ? 'clean' : 'build';
        this.writeLine(`pzstudio ${command} started...`);

        try {
            const dir = await resolveProjectDir(command);
            if (!dir) {
                this.writeLine(
                    `pzstudio ${command} skipped: no PZ project (project.json) found in this workspace.`,
                );
                return;
            }

            // The task target overrides the configured build target (UX-01):
            // resolveFlags emits the setting's flag only when no explicit
            // target is given, so the invocation carries exactly one target
            // flag — the CLI rejects conflicting ones. `clean` is not a
            // build target: it maps to the clean command, which never
            // receives one. All flag settings read for the resolved
            // project's folder resource (UX-05).
            const flags = resolveFlags(
                command,
                this.target === 'clean' ? undefined : this.target,
                dir.fsPath,
            );

            await this.studio.run(command, [], {
                flags,
                projectDir: dir.fsPath,
            });
            this.writeLine(`pzstudio ${command} completed.`);
        } catch (e) {
            this.writeLine(
                `pzstudio ${command} failed: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        } finally {
            this.closeEmitter.fire();
        }
    }

    private writeLine(message: string): void {
        this.writeEmitter.fire(`${message}\r\n`);
    }
}

export class BuildTaskProvider implements vscode.TaskProvider {
    constructor(private readonly studio: PzStudio) {}

    provideTasks(): vscode.Task[] {
        return [
            createTask('production', this.studio),
            createTask('development', this.studio),
            createTask('both', this.studio),
            createTask('clean', this.studio),
        ];
    }

    resolveTask(task: vscode.Task): vscode.Task | undefined {
        const definition = task.definition as PZTaskDefinition;
        const target = definition?.target as PZTaskTarget;
        if (
            target === 'production' ||
            target === 'development' ||
            target === 'both' ||
            target === 'clean'
        ) {
            return createTask(target, this.studio);
        }
        return undefined;
    }
}

function createTask(target: PZTaskTarget, studio: PzStudio): vscode.Task {
    const definition: PZTaskDefinition = { type: PZ_TASK_TYPE, target };
    const name =
        target === 'clean' ? 'pzstudio: clean' : `pzstudio: build (${target})`;
    return new vscode.Task(
        definition,
        vscode.TaskScope.Workspace,
        name,
        PZ_TASK_TYPE,
        new vscode.CustomExecution(
            async () => new PZTaskTerminal(target, studio),
        ),
    );
}
