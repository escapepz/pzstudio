import * as vscode from 'vscode';
import { runCLI, setProjectDir } from 'pzstudio-cli/api';
import { resolveFlags } from '../util/flags';
import { resolveProjectDir } from '../util/project';

export const PZ_TASK_TYPE = 'pzstudio';

export type PZTaskTarget = 'production' | 'development' | 'clean';

export interface PZTaskDefinition extends vscode.TaskDefinition {
    target: string;
}

/**
 * Runs a pzstudio command as a VS Code task so builds are available from
 * Terminal > Run Task and Ctrl+Shift+B (after configuring the default build
 * task). Execution is in-process (runCLI), consistent with the commands:
 * detailed logs go to the PZ output channel, the task terminal shows the
 * start/complete/failed status lines.
 */
class PZTaskTerminal implements vscode.Pseudoterminal {
    private readonly writeEmitter = new vscode.EventEmitter<string>();
    readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    private readonly closeEmitter = new vscode.EventEmitter<void>();
    onDidClose: vscode.Event<void> = this.closeEmitter.event;

    constructor(private readonly target: PZTaskTarget) {}

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
            setProjectDir(dir.fsPath);

            const flags = [...resolveFlags(command)];
            if (this.target === 'production') {
                flags.push('--production');
            } else if (this.target === 'development') {
                flags.push('--development');
            }

            await runCLI(command, [], { flags });
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
    provideTasks(): vscode.Task[] {
        return [
            createTask('production'),
            createTask('development'),
            createTask('clean'),
        ];
    }

    resolveTask(task: vscode.Task): vscode.Task | undefined {
        const definition = task.definition as PZTaskDefinition;
        const target = definition?.target as PZTaskTarget;
        if (
            target === 'production' ||
            target === 'development' ||
            target === 'clean'
        ) {
            return createTask(target);
        }
        return undefined;
    }
}

function createTask(target: PZTaskTarget): vscode.Task {
    const definition: PZTaskDefinition = { type: PZ_TASK_TYPE, target };
    const name =
        target === 'clean' ? 'pzstudio: clean' : `pzstudio: build (${target})`;
    return new vscode.Task(
        definition,
        vscode.TaskScope.Workspace,
        name,
        PZ_TASK_TYPE,
        new vscode.CustomExecution(async () => new PZTaskTerminal(target)),
    );
}
