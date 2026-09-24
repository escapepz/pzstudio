'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});
vi.mock('pzstudio-cli/api', () => ({
    runCLI: vi.fn(async () => {}),
    setProjectDir: vi.fn(),
    setLogger: vi.fn(),
    setVsCodeSettings: vi.fn(),
    resolveModInfoTargets: vi.fn(() => []),
}));

import * as vscode from 'vscode';
import {
    BuildTaskProvider,
    PZ_TASK_TYPE,
} from '../../packages/vscode-extension/src/providers/buildTaskProvider';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

const TaskCtor = vscode.Task as unknown as new (
    definition: unknown,
    scope: unknown,
    name: string,
    source: string,
    execution: unknown,
) => {
    definition: unknown;
    name: string;
    execution: { callback: () => Thenable<unknown> };
};

describe('BuildTaskProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder('proj')];
        asMock(vscode.workspace.fs.stat).mockImplementation(
            async (uri: { path: string }) => {
                if (uri.path.endsWith('project.json')) {
                    return { type: vscode.FileType.File };
                }
                throw new Error('ENOENT');
            },
        );
        asMock(vscode.window.withProgress).mockImplementation(
            async (_o: unknown, task: () => unknown) => task(),
        );
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
    });

    const folder = (name: string) => ({
        uri: new (vscode.Uri as unknown as new (parts: string[]) => vscode.Uri)(
            [name],
        ),
        name,
    });

    it('provides the three default tasks', () => {
        const tasks = new BuildTaskProvider().provideTasks();
        expect(tasks.map((t) => (t as { name: string }).name)).toEqual([
            'pzstudio: build (production)',
            'pzstudio: build (development)',
            'pzstudio: clean',
        ]);
        expect(
            tasks.every(
                (t) =>
                    (t as { definition: { type: string } }).definition.type ===
                    PZ_TASK_TYPE,
            ),
        ).toBe(true);
    });

    it('resolves hand-declared tasks with a valid target', () => {
        const provider = new BuildTaskProvider();
        const task = provider.resolveTask({
            definition: { type: PZ_TASK_TYPE, target: 'development' },
        } as never) as { name: string } | undefined;

        expect(task?.name).toBe('pzstudio: build (development)');
    });

    it('ignores tasks with an unknown target', () => {
        const provider = new BuildTaskProvider();
        expect(
            provider.resolveTask({
                definition: { type: PZ_TASK_TYPE, target: 'bogus' },
            } as never),
        ).toBeUndefined();
    });

    async function runTask(target: string) {
        const provider = new BuildTaskProvider();
        provider.provideTasks();
        // createTask is internal — go through resolveTask to reach it.
        const task = new TaskCtor(
            { type: PZ_TASK_TYPE, target },
            vscode.TaskScope.Workspace,
            'x',
            PZ_TASK_TYPE,
            new vscode.CustomExecution(async () => ({}) as never),
        );
        const resolved = provider.resolveTask(task as never) as {
            execution: { callback: () => Thenable<unknown> };
        };
        const terminal = (await resolved.execution.callback()) as {
            open: () => void;
            onDidWrite: { event: unknown };
        };
        // The terminal fires writes through its EventEmitter; capture them.
        const writes: string[] = [];
        const emitterInstance = (
            terminal as unknown as {
                writeEmitter: { fire: (v: string) => void };
            }
        ).writeEmitter;
        asMock(emitterInstance.fire).mockImplementation((v: string) => {
            writes.push(v);
        });
        terminal.open();
        await vi.waitFor(() => {
            expect(
                writes.some((w) => /completed\.|failed:|skipped:/.test(w)),
            ).toBe(true);
        });
        return writes;
    }

    it('runs build in-process with the production flag', async () => {
        const writes = await runTask('production');

        const { runCLI, setProjectDir } =
            (await import('pzstudio-cli/api')) as {
                runCLI: import('vitest').Mock;
                setProjectDir: import('vitest').Mock;
            };
        expect(setProjectDir).toHaveBeenCalledWith(expect.any(String));
        expect(runCLI).toHaveBeenCalledWith('build', [], {
            flags: ['--production'],
        });
        expect(writes.join('')).toContain('pzstudio build started...');
        expect(writes.join('')).toContain('pzstudio build completed.');
    });

    it('runs clean without branch flags', async () => {
        const writes = await runTask('clean');

        const { runCLI } = (await import('pzstudio-cli/api')) as {
            runCLI: import('vitest').Mock;
        };
        expect(runCLI).toHaveBeenCalledWith('clean', [], { flags: [] });
        expect(writes.join('')).toContain('pzstudio clean completed.');
    });

    it('reports a skip when there is no project', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [];
        const writes = await runTask('production');
        expect(writes.join('')).toContain('skipped: no PZ project');
        const { runCLI } = (await import('pzstudio-cli/api')) as {
            runCLI: import('vitest').Mock;
        };
        expect(runCLI).not.toHaveBeenCalled();
    });

    it('reports CLI failures through the terminal', async () => {
        const { runCLI } = (await import('pzstudio-cli/api')) as {
            runCLI: import('vitest').Mock;
        };
        asMock(runCLI).mockRejectedValueOnce(new Error('boom'));
        const writes = await runTask('production');
        expect(writes.join('')).toContain('pzstudio build failed: boom');
    });
});
