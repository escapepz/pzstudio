import * as vscode from 'vscode';
import type { PzStudio } from '@pzstudio/cli/api';
import { resolveFlags } from '../util/flags';
import { resolveProjectDir } from '../util/project';

export const PZ_TASK_TYPE = 'pzstudio';

export type PZTaskTarget = 'production' | 'development' | 'both' | 'clean';

export interface PZTaskDefinition extends vscode.TaskDefinition {
    target: string;
}

class PZTaskTerminal implements vscode.Pseudoterminal {
    private readonly writeEmitter = new vscode.EventEmitter<string>();
    readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    private readonly closeEmitter = new vscode.EventEmitter<void>();
    onDidClose: vscode.Event<void> = this.closeEmitter.event;

    constructor(
        private readonly target: PZTaskTarget,
        private readonly studio: PzStudio,
        private readonly onBuildSuccess?: () => void,
    ) {}

    open(): void {
        void this.run();
    }

    close(): void {}

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

            const flags = resolveFlags(
                command,
                this.target === 'clean' ? undefined : this.target,
                dir.fsPath,
            );

            await this.studio.run(command, [], {
                flags,
                projectDir: dir.fsPath,
            });
            if (command === 'build') {
                this.onBuildSuccess?.();
            }
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
    constructor(
        private readonly studio: PzStudio,
        private readonly onBuildSuccess?: () => void,
    ) {}

    provideTasks(): vscode.Task[] {
        return [
            createTask('production', this.studio, this.onBuildSuccess),
            createTask('development', this.studio, this.onBuildSuccess),
            createTask('both', this.studio, this.onBuildSuccess),
            createTask('clean', this.studio, this.onBuildSuccess),
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
            return createTask(target, this.studio, this.onBuildSuccess);
        }
        return undefined;
    }
}

function createTask(
    target: PZTaskTarget,
    studio: PzStudio,
    onBuildSuccess?: () => void,
): vscode.Task {
    const definition: PZTaskDefinition = { type: PZ_TASK_TYPE, target };
    const name =
        target === 'clean' ? 'pzstudio: clean' : `pzstudio: build (${target})`;
    return new vscode.Task(
        definition,
        vscode.TaskScope.Workspace,
        name,
        PZ_TASK_TYPE,
        new vscode.CustomExecution(
            async () => new PZTaskTerminal(target, studio, onBuildSuccess),
        ),
    );
}
