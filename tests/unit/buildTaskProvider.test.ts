'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});
vi.mock('@pzstudio/cli/api', () => ({
    runCLI: vi.fn(async () => {}),
    setProjectDir: vi.fn(),
    setLogger: vi.fn(),
    setVsCodeSettings: vi.fn(),
    resolveModInfoTargets: vi.fn(() => []),
}));

import * as vscode from 'vscode';
import {
    configurationStore,
    defaultGetConfiguration,
} from '../helpers/vscode-mock';
// The REAL engine lock primitive (side-effect-free module): the queued-task
// test below models the host instance's studio.run faithfully —
// createPzStudio.run wraps its whole lifecycle in withEngineLock (doc 11 §9).
import { withEngineLock } from '../../packages/cli/src/lib/invocation';
import {
    BuildTaskProvider,
    PZ_TASK_TYPE,
} from '../../packages/vscode-extension/src/providers/buildTaskProvider';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

/** Minimal PzStudio stub: the task terminal only ever calls studio.run. */
interface StudioStub {
    run: import('vitest').Mock;
}

function studioStub(implementation?: () => Promise<void>): StudioStub {
    return { run: vi.fn(implementation ?? (async () => {})) };
}

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
        // Fresh default configuration per test: resolveFlags reads
        // pzstudio.* settings, and a target pinned by one test must not
        // leak into the next.
        asMock(vscode.workspace.getConfiguration).mockImplementation(
            () =>
                ({
                    get: vi.fn(
                        (_key: string, defaultValue?: unknown) => defaultValue,
                    ),
                    inspect: vi.fn(() => undefined),
                    update: vi.fn(),
                }) as never,
        );
    });

    const folder = (name: string) => ({
        uri: new (vscode.Uri as unknown as new (parts: string[]) => vscode.Uri)(
            [name],
        ),
        name,
    });

    it('provides the four default tasks', () => {
        const tasks = new BuildTaskProvider(studioStub()).provideTasks();
        expect(tasks.map((t) => (t as { name: string }).name)).toEqual([
            'pzstudio: build (production)',
            'pzstudio: build (development)',
            'pzstudio: build (both)',
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
        const provider = new BuildTaskProvider(studioStub());
        const task = provider.resolveTask({
            definition: { type: PZ_TASK_TYPE, target: 'development' },
        } as never) as { name: string } | undefined;

        expect(task?.name).toBe('pzstudio: build (development)');
    });

    it('ignores tasks with an unknown target', () => {
        const provider = new BuildTaskProvider(studioStub());
        expect(
            provider.resolveTask({
                definition: { type: PZ_TASK_TYPE, target: 'bogus' },
            } as never),
        ).toBeUndefined();
    });

    /** Opens the terminal for one task and starts capturing its writes. */
    async function startTask(target: string, studio: StudioStub) {
        const provider = new BuildTaskProvider(studio as never);
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
        const done = vi.waitFor(() => {
            expect(
                writes.some((w) => /completed\.|failed:|skipped:/.test(w)),
            ).toBe(true);
        });
        return { writes, done };
    }

    async function runTask(target: string, studio: StudioStub) {
        const { writes, done } = await startTask(target, studio);
        await done;
        return writes;
    }

    it('runs build through the host instance with the production flag', async () => {
        const studio = studioStub();
        const writes = await runTask('production', studio);

        expect(studio.run).toHaveBeenCalledTimes(1);
        expect(studio.run).toHaveBeenCalledWith('build', [], {
            flags: ['--production'],
            projectDir: path.sep + path.join('proj'),
        });
        // The legacy engine doors left the task provider with the v2 cutover.
        const { runCLI, setProjectDir } =
            (await import('@pzstudio/cli/api')) as {
                runCLI: import('vitest').Mock;
                setProjectDir: import('vitest').Mock;
            };
        expect(runCLI).not.toHaveBeenCalled();
        expect(setProjectDir).not.toHaveBeenCalled();
        expect(writes.join('')).toContain('pzstudio build started...');
        expect(writes.join('')).toContain('pzstudio build completed.');
    });

    it('runs build through the host instance with the development flag', async () => {
        const studio = studioStub();
        const writes = await runTask('development', studio);

        expect(studio.run).toHaveBeenCalledWith('build', [], {
            flags: ['--development'],
            projectDir: path.sep + path.join('proj'),
        });
        expect(writes.join('')).toContain('pzstudio build completed.');
    });

    it('runs build through the host instance with the both flag', async () => {
        const studio = studioStub();
        const writes = await runTask('both', studio);

        expect(studio.run).toHaveBeenCalledWith('build', [], {
            flags: ['--both'],
            projectDir: path.sep + path.join('proj'),
        });
        expect(writes.join('')).toContain('pzstudio build completed.');
    });

    it('runs clean without branch flags', async () => {
        const studio = studioStub();
        const writes = await runTask('clean', studio);

        expect(studio.run).toHaveBeenCalledWith('clean', [], {
            flags: [],
            projectDir: path.sep + path.join('proj'),
        });
        expect(writes.join('')).toContain('pzstudio clean completed.');
    });

    // UX-01: the task target must OVERRIDE pzstudio.build.target — every
    // configured × task combination resolves to exactly one target flag
    // (never the setting flag layered under the task flag, which the CLI
    // rejects as conflicting options).
    const CONFIGURED_TARGETS = [
        'default',
        'production',
        'development',
        'both',
    ] as const;
    const TASK_BUILD_TARGETS = ['production', 'development', 'both'] as const;
    const TARGET_FLAG: Record<(typeof TASK_BUILD_TARGETS)[number], string> = {
        production: '--production',
        development: '--development',
        both: '--both',
    };

    /** Pins pzstudio.build.target (verbose stays unset unless asked). */
    function withConfiguredTarget(target: string, verbose = false) {
        asMock(vscode.workspace.getConfiguration).mockImplementation(
            () =>
                ({
                    get: vi.fn(
                        (key: string) =>
                            ({
                                'build.target': target,
                                verbose: verbose || undefined,
                            })[key],
                    ),
                    inspect: vi.fn(() => undefined),
                    update: vi.fn(),
                }) as never,
        );
    }

    describe.each(CONFIGURED_TARGETS)(
        'with pzstudio.build.target=%s',
        (configured) => {
            beforeEach(() => {
                withConfiguredTarget(configured);
            });

            it.each(TASK_BUILD_TARGETS)(
                'task %s runs build with exactly one target flag',
                async (taskTarget) => {
                    const studio = studioStub();
                    await runTask(taskTarget, studio);

                    // Exact options match: exactly one explicit build-target
                    // flag (the task's), no contradictory duplicate, and the
                    // configured target is overridden, not appended to.
                    expect(studio.run).toHaveBeenCalledTimes(1);
                    expect(studio.run).toHaveBeenCalledWith('build', [], {
                        flags: [TARGET_FLAG[taskTarget]],
                        projectDir: path.sep + path.join('proj'),
                    });
                },
            );

            it('task clean runs clean with no build-target flag', async () => {
                const studio = studioStub();
                await runTask('clean', studio);

                expect(studio.run).toHaveBeenCalledWith('clean', [], {
                    flags: [],
                    projectDir: path.sep + path.join('proj'),
                });
            });
        },
    );

    it('keeps --verbose alongside the overriding task target', async () => {
        withConfiguredTarget('production', true);
        const studio = studioStub();
        await runTask('development', studio);

        // The task target wins over the setting; non-target flags are
        // untouched — exactly one target flag, verbose preserved.
        expect(studio.run).toHaveBeenCalledWith('build', [], {
            flags: ['--verbose', '--development'],
            projectDir: path.sep + path.join('proj'),
        });
    });

    it('reports a skip when there is no project', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [];
        const studio = studioStub();
        const writes = await runTask('production', studio);
        expect(writes.join('')).toContain('skipped: no PZ project');
        expect(studio.run).not.toHaveBeenCalled();
    });

    it('reports run failures through the terminal', async () => {
        const studio = studioStub(async () => {
            throw new Error('boom');
        });
        const writes = await runTask('production', studio);
        expect(writes.join('')).toContain('pzstudio build failed: boom');
    });

    // UX-05: the task resolves its flags for the resolved project's folder
    // resource. Folder-scoped non-target flags (verbose) must reach the
    // invocation, and the task target keeps beating the folder-level
    // configured target (UX-01).
    describe('UX-05 resource-scoped flags', () => {
        const UriCtor = vscode.Uri as unknown as new (
            parts: string[],
        ) => vscode.Uri;

        beforeEach(() => {
            configurationStore.reset();
            asMock(vscode.workspace.getConfiguration).mockImplementation(
                defaultGetConfiguration as never,
            );
        });

        function withSingleFolderProject(values: Record<string, unknown>) {
            const folder = new UriCtor(['proj']);
            (
                vscode.workspace as unknown as { workspaceFolders: unknown }
            ).workspaceFolders = [{ uri: folder, name: 'proj' }];
            configurationStore.folders[folder.fsPath] = { ...values };
        }

        it('carries folder-scoped --verbose alongside the task target', async () => {
            withSingleFolderProject({
                'pzstudio.verbose': true,
                'pzstudio.build.target': 'production',
            });
            const studio = studioStub();
            await runTask('development', studio);

            expect(studio.run).toHaveBeenCalledWith('build', [], {
                flags: ['--verbose', '--development'],
                projectDir: path.sep + path.join('proj'),
            });
        });

        it('keeps the task target above the folder-level target with one flag', async () => {
            withSingleFolderProject({
                'pzstudio.build.target': 'production',
            });
            const studio = studioStub();
            await runTask('development', studio);

            expect(studio.run).toHaveBeenCalledWith('build', [], {
                flags: ['--development'],
                projectDir: path.sep + path.join('proj'),
            });
        });
    });

    it('has no task-specific busy guard: concurrent tasks both dispatch', async () => {
        const studio = studioStub();
        const first = await startTask('production', studio);
        const second = await startTask('production', studio);
        await Promise.all([first.done, second.done]);

        // No refusal, no warning — both tasks reach the host instance (they
        // serialize on the engine lock instead, doc 11 §9).
        expect(studio.run).toHaveBeenCalledTimes(2);
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
    });

    it('queues a task behind an in-flight engine invocation and completes FIFO without deadlock', async () => {
        const events: string[] = [];
        let releaseA!: () => void;
        const gateA = new Promise<void>((r) => {
            releaseA = r;
        });

        // Operation A acquires and holds the engine invocation.
        const opA = withEngineLock(async () => {
            events.push('a:start');
            await gateA;
            events.push('a:end');
        });
        try {
            await vi.waitFor(() => expect(events).toContain('a:start'));

            // The task terminal runs through the host instance; the stub's
            // run enters the same lock the real createPzStudio.run does, so
            // the queued behavior asserted below is the engine's contract.
            const studio: StudioStub = {
                run: vi.fn(() =>
                    withEngineLock(async () => {
                        events.push('task:start');
                        events.push('task:end');
                    }),
                ),
            };

            const { writes, done } = await startTask('production', studio);

            // The task dispatches but is QUEUED: it must not execute while A
            // holds the lock (A's gate is still closed), and the terminal
            // has reported the start but not the completion.
            await vi.waitFor(() => expect(studio.run).toHaveBeenCalledTimes(1));
            expect(events).toEqual(['a:start']);
            expect(writes.join('')).toContain('pzstudio build started...');
            expect(writes.join('')).not.toContain('completed.');

            releaseA();
            await done;
            await opA;

            // FIFO: A ran to completion first, then the task — no interleave,
            // no dropped task, no deadlock; terminal status lines unchanged.
            expect(events).toEqual([
                'a:start',
                'a:end',
                'task:start',
                'task:end',
            ]);
            expect(writes.join('')).toContain('pzstudio build completed.');
        } finally {
            // Never leave a parked invocation holding the lock.
            releaseA();
            await Promise.allSettled([opA]);
        }
    });
});
