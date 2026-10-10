'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});
vi.mock('@pzstudio/cli/api', () => ({
    createPzStudio: vi.fn(() => ({ run: vi.fn(async () => {}) })),
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
import { createCommandRunner } from '../../packages/vscode-extension/src/util/execute';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

/** Minimal PzStudio stub: the runner only ever calls studio.run. */
function studioStub(implementation?: () => Promise<void>) {
    return { run: vi.fn(implementation ?? (async () => {})) };
}

const folder = (parts: string[]) => ({
    uri: new (vscode.Uri as unknown as new (parts: string[]) => vscode.Uri)(
        parts,
    ),
    name: parts[parts.length - 1] || 'root',
});

function withSingleProject(root = 'proj') {
    (
        vscode.workspace as unknown as { workspaceFolders: unknown }
    ).workspaceFolders = [folder([root])];
    asMock(vscode.workspace.fs.stat).mockImplementation(
        async (uri: { path: string }) => {
            if (uri.path.endsWith('project.json')) {
                return { type: vscode.FileType.File };
            }
            throw new Error('ENOENT');
        },
    );
    asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
}

describe('createCommandRunner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Fresh default configuration per test: resolveFlags reads
        // pzstudio.* settings, and implementations mocked by one test must
        // not leak into the next.
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
        asMock(vscode.window.withProgress).mockImplementation(
            async (_o: unknown, task: () => unknown) => task(),
        );
        asMock(vscode.commands.executeCommand).mockClear();
    });

    it('warns and skips when the workspace has no project', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [];
        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub();
        const runner = createCommandRunner(studio as never, output as never);

        await runner('build');

        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            expect.stringContaining('no PZ project (project.json)'),
        );
        expect(studio.run).not.toHaveBeenCalled();
    });

    it('resolves the project dir and runs it through the host instance', async () => {
        withSingleProject();
        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub();
        const runner = createCommandRunner(studio as never, output as never);

        await runner('build', ['someMod'], ['--extra']);

        expect(studio.run).toHaveBeenCalledWith('build', ['someMod'], {
            flags: ['--extra'],
            projectDir: path.sep + path.join('proj'),
        });
        // The legacy anchor write left the runner with the v2 cutover.
        const { setProjectDir, runCLI } =
            (await import('@pzstudio/cli/api')) as {
                setProjectDir: import('vitest').Mock;
                runCLI: import('vitest').Mock;
            };
        expect(setProjectDir).not.toHaveBeenCalled();
        expect(runCLI).not.toHaveBeenCalled();
        expect(asMock(output.show)).not.toHaveBeenCalled();
    });

    it('shows the output channel in verbose mode', async () => {
        withSingleProject();
        asMock(vscode.workspace.getConfiguration).mockReturnValue({
            get: vi.fn((key: string) => (key === 'verbose' ? true : undefined)),
            inspect: vi.fn(() => undefined),
            update: vi.fn(),
        } as never);
        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub();
        const runner = createCommandRunner(studio as never, output as never);

        await runner('build');

        expect(asMock(output.show)).toHaveBeenCalledWith(true);
        expect(studio.run).toHaveBeenCalledWith('build', [], {
            flags: ['--verbose'],
            projectDir: path.sep + path.join('proj'),
        });
    });

    it('builds with the configured target for palette runs (no override)', async () => {
        withSingleProject();
        asMock(vscode.workspace.getConfiguration).mockImplementation(
            () =>
                ({
                    get: vi.fn((key: string) =>
                        key === 'build.target' ? 'production' : undefined,
                    ),
                    inspect: vi.fn(() => undefined),
                    update: vi.fn(),
                }) as never,
        );
        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub();
        const runner = createCommandRunner(studio as never, output as never);

        await runner('build');

        // Normal Build semantics unchanged: the setting's flag, exactly
        // once — the explicit-target override is task-only (UX-01).
        expect(studio.run).toHaveBeenCalledWith('build', [], {
            flags: ['--production'],
            projectDir: path.sep + path.join('proj'),
        });
    });

    it('keeps the progress presentation', async () => {
        withSingleProject();
        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub();
        const runner = createCommandRunner(studio as never, output as never);

        await runner('build');

        expect(asMock(vscode.window.withProgress)).toHaveBeenCalledWith(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'PZStudio: build',
                cancellable: false,
            },
            expect.any(Function),
        );
    });

    it('swallows run failures and still finishes', async () => {
        withSingleProject();
        const onFinished = vi.fn();
        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub(async () => {
            throw new Error('boom');
        });
        const runner = createCommandRunner(
            studio as never,
            output as never,
            onFinished,
        );

        await expect(runner('build')).resolves.toBeUndefined();

        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
        expect(onFinished).toHaveBeenCalledTimes(1);
        expect(asMock(output.show)).not.toHaveBeenCalled();
    });

    it('guards against overlapping runs of the same command', async () => {
        withSingleProject();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        asMock(vscode.window.withProgress).mockImplementation(() => gate);
        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub();
        const runner = createCommandRunner(studio as never, output as never);

        const first = runner('build');
        await vi.waitFor(() => {
            // first run is inside the progress gate now
            expect(gate).toBeInstanceOf(Promise);
        });
        await runner('build'); // second call while busy

        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            expect.stringContaining("command 'build' is already running"),
        );
        release();
        await first;
    });

    it('uses the provided projectDir without any picker', async () => {
        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub();
        const runner = createCommandRunner(studio as never, output as never);

        await runner('clean', [], [], { projectDir: 'C:/somewhere/proj' });

        expect(studio.run).toHaveBeenCalledWith('clean', [], {
            flags: [],
            projectDir: 'C:/somewhere/proj',
        });
        const { setProjectDir } = (await import('@pzstudio/cli/api')) as {
            setProjectDir: import('vitest').Mock;
        };
        expect(setProjectDir).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
    });

    // UX-03: `update` refreshes the GLOBAL template caches — the CLI never
    // resolves a project for it, so the runner must not gate it on project
    // resolution either (no picker, no "no project" warning, no projectDir
    // passed to the engine). Every project-scoped command keeps the old
    // requirement.
    describe('project-less global update (UX-03)', () => {
        function withFoldersButNoProject() {
            (
                vscode.workspace as unknown as { workspaceFolders: unknown }
            ).workspaceFolders = [folder(['plain'])];
            asMock(vscode.workspace.fs.stat).mockRejectedValue(
                new Error('ENOENT'),
            );
            asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
        }

        function withTwoProjects() {
            (
                vscode.workspace as unknown as { workspaceFolders: unknown }
            ).workspaceFolders = [folder(['one']), folder(['two'])];
            asMock(vscode.workspace.fs.stat).mockImplementation(
                async (uri: { path: string }) => {
                    if (uri.path.endsWith('project.json')) {
                        return { type: vscode.FileType.File };
                    }
                    throw new Error('ENOENT');
                },
            );
            asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
        }

        async function updateRunner(studio = studioStub()) {
            const output = vscode.window.createOutputChannel('test');
            const runner = createCommandRunner(
                studio as never,
                output as never,
            );
            return { runner, studio };
        }

        it('runs in a workspace without a project instead of warning and skipping', async () => {
            withFoldersButNoProject();
            const { runner, studio } = await updateRunner();

            await runner('update', [], [], { requiresProject: false });

            expect(studio.run).toHaveBeenCalledTimes(1);
            expect(studio.run).toHaveBeenCalledWith('update', [], {
                flags: [],
            });
            expect(
                asMock(vscode.window.showWarningMessage),
            ).not.toHaveBeenCalled();
        });

        it('runs in an empty VS Code workspace (no folders at all)', async () => {
            (
                vscode.workspace as unknown as { workspaceFolders: unknown }
            ).workspaceFolders = [];
            const { runner, studio } = await updateRunner();

            await runner('update', [], [], { requiresProject: false });

            expect(studio.run).toHaveBeenCalledTimes(1);
            expect(studio.run).toHaveBeenCalledWith('update', [], {
                flags: [],
            });
            expect(
                asMock(vscode.window.showWarningMessage),
            ).not.toHaveBeenCalled();
        });

        it('never picks a project, even when one exists (global operation)', async () => {
            withSingleProject();
            const { runner, studio } = await updateRunner();

            await runner('update', [], [], { requiresProject: false });

            expect(studio.run).toHaveBeenCalledWith('update', [], {
                flags: [],
            });
            expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
            expect('projectDir' in asMock(studio.run).mock.calls[0][2]).toBe(
                false,
            );
        });

        it('runs exactly once among multiple projects, without a picker', async () => {
            withTwoProjects();
            const { runner, studio } = await updateRunner();

            await runner('update', [], [], { requiresProject: false });

            expect(studio.run).toHaveBeenCalledTimes(1);
            expect(studio.run).toHaveBeenCalledWith('update', [], {
                flags: [],
            });
            expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
        });

        it('is not anchored to the project of a previous command run', async () => {
            withSingleProject();
            const output = vscode.window.createOutputChannel('test');
            const studio = studioStub();
            const runner = createCommandRunner(
                studio as never,
                output as never,
            );

            await runner('build');
            await runner('update', [], [], { requiresProject: false });

            const buildOptions = asMock(studio.run).mock.calls[0][2];
            const updateOptions = asMock(studio.run).mock.calls[1][2];
            expect(buildOptions).toEqual({
                flags: [],
                projectDir: path.sep + path.join('proj'),
            });
            expect(updateOptions).toEqual({ flags: [] });
            expect('projectDir' in updateOptions).toBe(false);
        });

        it('still honors --verbose and the output-channel show', async () => {
            withFoldersButNoProject();
            asMock(vscode.workspace.getConfiguration).mockReturnValue({
                get: vi.fn((key: string) =>
                    key === 'verbose' ? true : undefined,
                ),
                inspect: vi.fn(() => undefined),
                update: vi.fn(),
            } as never);
            const output = vscode.window.createOutputChannel('test');
            const studio = studioStub();
            const runner = createCommandRunner(
                studio as never,
                output as never,
            );

            await runner('update', [], [], { requiresProject: false });

            expect(studio.run).toHaveBeenCalledWith('update', [], {
                flags: ['--verbose'],
            });
            expect(asMock(output.show)).toHaveBeenCalledWith(true);
        });

        it('keeps the error semantics when the update run throws', async () => {
            withFoldersButNoProject();
            const onFinished = vi.fn();
            const output = vscode.window.createOutputChannel('test');
            const studio = studioStub(async () => {
                throw new Error('cache boom');
            });
            const runner = createCommandRunner(
                studio as never,
                output as never,
                onFinished,
            );

            await expect(
                runner('update', [], [], { requiresProject: false }),
            ).resolves.toBeUndefined();

            expect(onFinished).toHaveBeenCalledTimes(1);
            expect(asMock(output.show)).not.toHaveBeenCalled();
        });

        it('keeps the same-command busy guard for overlapping updates', async () => {
            withFoldersButNoProject();
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            asMock(vscode.window.withProgress).mockImplementation(() => gate);
            const { runner } = await updateRunner();

            const first = runner('update', [], [], { requiresProject: false });
            await vi.waitFor(() => {
                expect(gate).toBeInstanceOf(Promise);
            });
            await runner('update', [], [], { requiresProject: false });

            expect(
                asMock(vscode.window.showWarningMessage),
            ).toHaveBeenCalledWith(
                expect.stringContaining("command 'update' is already running"),
            );
            release();
            await first;
        });
    });

    it('still requires a project for clean when none exists (UX-03 does not loosen project-scoped commands)', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['plain'])];
        asMock(vscode.workspace.fs.stat).mockRejectedValue(new Error('ENOENT'));
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub();
        const runner = createCommandRunner(studio as never, output as never);

        await runner('clean');

        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            expect.stringContaining('no PZ project (project.json)'),
        );
        expect(studio.run).not.toHaveBeenCalled();
    });
});

/**
 * UX-05: the runner resolves the project first, then the flags — so the
 * flag settings must be read for THAT project's folder resource. Two
 * projects in two folders get different flags; the project-less global
 * update stays resource-less and borrows nothing.
 */
describe('createCommandRunner (UX-05 project-scoped flag resolution)', () => {
    const UriCtor = vscode.Uri as unknown as new (
        parts: string[],
    ) => vscode.Uri;

    beforeEach(() => {
        vi.clearAllMocks();
        configurationStore.reset();
        asMock(vscode.workspace.getConfiguration).mockImplementation(
            defaultGetConfiguration as never,
        );
        asMock(vscode.window.withProgress).mockImplementation(
            async (_o: unknown, task: () => unknown) => task(),
        );
        (
            vscode.window as unknown as { activeTextEditor: unknown }
        ).activeTextEditor = undefined;
    });

    function withTwoProjectFolders() {
        const folderA = new UriCtor(['ws', 'project-a']);
        const folderB = new UriCtor(['ws', 'project-b']);
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [
            { uri: folderA, name: 'project-a' },
            { uri: folderB, name: 'project-b' },
        ];
        configurationStore.folders[folderA.fsPath] = {
            'pzstudio.build.target': 'production',
        };
        configurationStore.folders[folderB.fsPath] = {
            'pzstudio.build.target': 'development',
        };
        return { folderA, folderB };
    }

    it('resolves the configured target per project folder for explicit-context runs', async () => {
        const { folderA, folderB } = withTwoProjectFolders();
        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub();
        const runner = createCommandRunner(studio as never, output as never);

        await runner('build', [], [], { projectDir: folderA.fsPath });
        await runner('build', [], [], { projectDir: folderB.fsPath });

        expect(asMock(studio.run).mock.calls[0][2]).toEqual({
            flags: ['--production'],
            projectDir: folderA.fsPath,
        });
        expect(asMock(studio.run).mock.calls[1][2]).toEqual({
            flags: ['--development'],
            projectDir: folderB.fsPath,
        });
    });

    it('resolves the flags for the auto-resolved project, not resource-less', async () => {
        const single = new UriCtor(['solo', 'proj']);
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [{ uri: single, name: 'proj' }];
        configurationStore.folders[single.fsPath] = {
            'pzstudio.verbose': true,
        };
        asMock(vscode.workspace.fs.stat).mockImplementation(
            async (uri: { path: string }) => {
                if (uri.path.endsWith('project.json')) {
                    return { type: vscode.FileType.File };
                }
                throw new Error('ENOENT');
            },
        );
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);

        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub();
        const runner = createCommandRunner(studio as never, output as never);

        await runner('build');

        expect(asMock(studio.run)).toHaveBeenCalledWith('build', [], {
            flags: ['--verbose'],
            projectDir: single.fsPath,
        });
    });

    it('resolves no folder flags for the project-less global update', async () => {
        const { folderA } = withTwoProjectFolders();
        configurationStore.folders[folderA.fsPath]['pzstudio.verbose'] = true;
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [{ uri: folderA, name: 'project-a' }];
        asMock(vscode.workspace.fs.stat).mockRejectedValue(new Error('ENOENT'));
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);

        const output = vscode.window.createOutputChannel('test');
        const studio = studioStub();
        const runner = createCommandRunner(studio as never, output as never);

        // UX-03 + §6F: update runs without a project and without borrowing
        // any opened folder's resource-scoped flags.
        await runner('update', [], [], { requiresProject: false });

        expect(asMock(studio.run)).toHaveBeenCalledWith('update', [], {
            flags: [],
        });
    });
});
