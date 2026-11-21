'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { registerBuildCommand } from '../../packages/vscode-extension/src/commands/build';
import { registerCleanCommand } from '../../packages/vscode-extension/src/commands/clean';
import { createCommandRunner } from '../../packages/vscode-extension/src/util/execute';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;
const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;
const folder = (parts: string[]) => ({
    uri: new UriCtor(parts),
    name: parts[parts.length - 1] || 'root',
});
const fsPath = (parts: string[]) => new UriCtor(parts).fsPath;

function statProjects(projectRoots: string[]) {
    asMock(vscode.workspace.fs.stat).mockImplementation(
        async (uri: { path: string }) => {
            const match = uri.path.match(/^(.+)\/project\.json$/);
            if (match && projectRoots.includes(match[1])) {
                return { type: vscode.FileType.File };
            }
            throw new Error('ENOENT');
        },
    );
}

function withProjects(...roots: string[]) {
    (
        vscode.workspace as unknown as { workspaceFolders: unknown }
    ).workspaceFolders = roots.map((r) => folder([r]));
    statProjects(roots.map((r) => '/' + r));
    asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
}

interface Harness {
    studio: { run: ReturnType<typeof vi.fn> };
    handler: (node?: unknown) => Promise<void>;
}

function setup(action: 'build' | 'clean', run?: () => Promise<void>): Harness {
    const studio = { run: vi.fn(run ?? (async () => {})) };
    const output = vscode.window.createOutputChannel('test');
    const runner = createCommandRunner(studio as never, output as never);
    registerBuildCommand(runner);
    registerCleanCommand(runner);
    const calls = asMock(vscode.commands.registerCommand).mock.calls as Array<
        [string, (node?: unknown) => Promise<void>]
    >;
    const entry = calls.find(([id]) =>
        action === 'build' ? id === 'pzstudio.build' : id === 'pzstudio.clean',
    );
    expect(entry).toBeDefined();
    return { studio, handler: entry![1] };
}

describe.each(['build', 'clean'] as const)(
    'pzstudio.%s command (UX-02)',
    (action) => {
        const verb = action === 'build' ? 'Build' : 'Clean';

        beforeEach(() => {
            vi.clearAllMocks();
            asMock(vscode.workspace.getConfiguration).mockImplementation(
                () =>
                    ({
                        get: vi.fn(
                            (_key: string, defaultValue?: unknown) =>
                                defaultValue,
                        ),
                        inspect: vi.fn(() => undefined),
                        update: vi.fn(),
                    }) as never,
            );
            (
                vscode.window as unknown as { activeTextEditor: unknown }
            ).activeTextEditor = undefined;
            asMock(vscode.workspace.fs.readFile).mockRejectedValue(
                new Error('ENOENT'),
            );
            asMock(vscode.window.showQuickPick).mockResolvedValue(undefined);
            asMock(vscode.window.showWarningMessage).mockResolvedValue(
                undefined,
            );
        });

        it('aborts on the first picker cancel: no run, no second prompt, no warning', async () => {
            withProjects('one', 'two');
            const { studio, handler } = setup(action);

            await handler(undefined);

            expect(asMock(vscode.window.showQuickPick)).toHaveBeenCalledTimes(
                1,
            );
            expect(
                asMock(vscode.window.showWarningMessage),
            ).not.toHaveBeenCalled();
            expect(studio.run).not.toHaveBeenCalled();
        });

        it('runs the explicitly picked project without a second picker', async () => {
            withProjects('one', 'two');
            const { studio, handler } = setup(action);
            asMock(vscode.window.showQuickPick).mockResolvedValue({
                label: 'two',
                dir: new UriCtor(['two']),
            });
            asMock(vscode.window.showWarningMessage).mockResolvedValue(verb);

            await handler(undefined);

            expect(asMock(vscode.window.showQuickPick)).toHaveBeenCalledTimes(
                1,
            );
            expect(
                asMock(vscode.window.showWarningMessage),
            ).toHaveBeenCalledWith(
                expect.stringContaining("project 'two'"),
                expect.anything(),
                verb,
                expect.anything(),
            );
            expect(studio.run).toHaveBeenCalledWith(action, [], {
                flags: [],
                projectDir: fsPath(['two']),
            });
        });

        it('aborts when the confirmation is dismissed, without warning or run', async () => {
            withProjects('one', 'two');
            const { studio, handler } = setup(action);
            asMock(vscode.window.showQuickPick).mockResolvedValue({
                label: 'two',
                dir: new UriCtor(['two']),
            });

            await handler(undefined);

            expect(asMock(vscode.window.showQuickPick)).toHaveBeenCalledTimes(
                1,
            );
            const warnCalls = asMock(vscode.window.showWarningMessage).mock
                .calls;
            expect(warnCalls).toHaveLength(1);
            expect(warnCalls[0][0]).toContain("project 'two'");
            expect(studio.run).not.toHaveBeenCalled();
        });

        it('auto-selects a single project without a picker', async () => {
            withProjects('only');
            const { studio, handler } = setup(action);
            asMock(vscode.window.showWarningMessage).mockResolvedValue(verb);

            await handler(undefined);

            expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
            expect(studio.run).toHaveBeenCalledWith(action, [], {
                flags: [],
                projectDir: fsPath(['only']),
            });
        });

        it('honors the tree-node context without any picker, over the active editor', async () => {
            withProjects('one', 'two');
            const { studio, handler } = setup(action);
            (
                vscode.window as unknown as { activeTextEditor: unknown }
            ).activeTextEditor = {
                document: { uri: new UriCtor(['one', 'media', 'x.lua']) },
            };
            asMock(vscode.window.showWarningMessage).mockResolvedValue(verb);

            await handler({ projectDir: new UriCtor(['two']) });

            expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
            expect(studio.run).toHaveBeenCalledWith(action, [], {
                flags: [],
                projectDir: fsPath(['two']),
            });
        });

        it('warns and skips when the workspace has no project at all', async () => {
            withProjects();
            const { studio, handler } = setup(action);

            await handler(undefined);

            expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
            expect(
                asMock(vscode.window.showWarningMessage),
            ).toHaveBeenCalledWith(
                expect.stringContaining('no PZ project (project.json)'),
            );
            expect(studio.run).not.toHaveBeenCalled();
        });

        it('honors a changed selection on the next invocation', async () => {
            withProjects('one', 'two');
            const { studio, handler } = setup(action);
            asMock(vscode.window.showWarningMessage).mockResolvedValue(verb);
            const pick = asMock(vscode.window.showQuickPick);

            pick.mockResolvedValueOnce({
                label: 'one',
                dir: new UriCtor(['one']),
            });
            await handler(undefined);
            pick.mockResolvedValueOnce({
                label: 'two',
                dir: new UriCtor(['two']),
            });
            await handler(undefined);

            expect(studio.run).toHaveBeenNthCalledWith(1, action, [], {
                flags: [],
                projectDir: fsPath(['one']),
            });
            expect(studio.run).toHaveBeenNthCalledWith(2, action, [], {
                flags: [],
                projectDir: fsPath(['two']),
            });
        });

        it('does not reuse the previous selection when a later picker is cancelled', async () => {
            withProjects('one', 'two');
            const { studio, handler } = setup(action);
            asMock(vscode.window.showWarningMessage).mockResolvedValue(verb);
            const pick = asMock(vscode.window.showQuickPick);

            pick.mockResolvedValueOnce({
                label: 'one',
                dir: new UriCtor(['one']),
            });
            await handler(undefined);
            pick.mockResolvedValueOnce(undefined); // next invocation cancelled
            await handler(undefined);

            expect(studio.run).toHaveBeenCalledTimes(1);
            expect(studio.run).toHaveBeenCalledWith(action, [], {
                flags: [],
                projectDir: fsPath(['one']),
            });
            expect(pick).toHaveBeenCalledTimes(2);
            expect(
                asMock(vscode.window.showWarningMessage),
            ).toHaveBeenCalledTimes(1);
        });

        it('keeps error semantics when the run throws after a valid selection', async () => {
            withProjects('only');
            const { studio, handler } = setup(action, async () => {
                throw new Error('boom');
            });
            asMock(vscode.window.showWarningMessage).mockResolvedValue(verb);

            await expect(handler(undefined)).resolves.toBeUndefined();

            expect(studio.run).toHaveBeenCalledTimes(1);
        });
    },
);
