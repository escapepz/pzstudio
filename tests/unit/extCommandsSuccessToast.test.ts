'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { createCommandRunner } from '../../packages/vscode-extension/src/util/execute';
import { notifyActionSuccess } from '../../packages/vscode-extension/src/util/firstSuccess';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

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

function setup(run?: () => Promise<void>) {
    const studio = studioStub(run);
    const output = vscode.window.createOutputChannel('test');
    return createCommandRunner(
        studio as never,
        output as never,
        undefined,
        notifyActionSuccess,
    );
}

describe('success toasts on command completion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
        withSingleProject();
    });

    it('toasts the clean completion once the run resolves', async () => {
        const runner = setup();

        await runner('clean');

        expect(
            asMock(vscode.window.showInformationMessage),
        ).toHaveBeenCalledWith('PZStudio: output cleaned.');
    });

    it('does NOT toast when the clean run fails', async () => {
        const runner = setup(async () => {
            throw new Error('boom');
        });

        await expect(runner('clean')).resolves.toBeUndefined();

        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();
    });

    it('toasts the new-project completion', async () => {
        const runner = setup();

        await runner('new');

        expect(
            asMock(vscode.window.showInformationMessage),
        ).toHaveBeenCalledWith('PZStudio: project created.');
    });

    it('toasts the add-mod completion', async () => {
        const runner = setup();

        await runner('add');

        expect(
            asMock(vscode.window.showInformationMessage),
        ).toHaveBeenCalledWith('PZStudio: mod added.');
    });

    it('does not toast for commands outside the quiet set', async () => {
        const runner = setup();

        await runner('delete');

        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();
    });
});
