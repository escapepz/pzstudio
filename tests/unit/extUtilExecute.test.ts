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
});
