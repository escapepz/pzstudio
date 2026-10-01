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
import { createCommandRunner } from '../../packages/vscode-extension/src/util/execute';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

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
        const runner = createCommandRunner(output as never);

        await runner('build');

        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            expect.stringContaining('no PZ project (project.json)'),
        );
        const { runCLI } = (await import('@pzstudio/cli/api')) as {
            runCLI: import('vitest').Mock;
        };
        expect(runCLI).not.toHaveBeenCalled();
    });

    it('resolves the project dir and runs the CLI with flags', async () => {
        withSingleProject();
        const output = vscode.window.createOutputChannel('test');
        const runner = createCommandRunner(output as never);

        await runner('build', ['someMod'], ['--extra']);

        const { runCLI, setProjectDir } =
            (await import('@pzstudio/cli/api')) as {
                runCLI: import('vitest').Mock;
                setProjectDir: import('vitest').Mock;
            };
        expect(setProjectDir).toHaveBeenCalledWith(
            path.sep + path.join('proj'),
        );
        expect(runCLI).toHaveBeenCalledWith('build', ['someMod'], {
            flags: ['--extra'],
        });
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
        const runner = createCommandRunner(output as never);

        await runner('build');

        expect(asMock(output.show)).toHaveBeenCalledWith(true);
        const { runCLI } = (await import('@pzstudio/cli/api')) as {
            runCLI: import('vitest').Mock;
        };
        expect(runCLI).toHaveBeenCalledWith('build', [], {
            flags: ['--verbose'],
        });
    });

    it('guards against overlapping runs of the same command', async () => {
        withSingleProject();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        asMock(vscode.window.withProgress).mockImplementation(() => gate);
        const output = vscode.window.createOutputChannel('test');
        const runner = createCommandRunner(output as never);

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
        const runner = createCommandRunner(output as never);

        await runner('clean', [], [], { projectDir: 'C:/somewhere/proj' });

        const { runCLI, setProjectDir } =
            (await import('@pzstudio/cli/api')) as {
                runCLI: import('vitest').Mock;
                setProjectDir: import('vitest').Mock;
            };
        expect(setProjectDir).toHaveBeenCalledWith('C:/somewhere/proj');
        expect(runCLI).toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
    });
});
