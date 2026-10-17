'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { registerAddCommand } from '../../packages/vscode-extension/src/commands/add';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

const execute = vi.fn(async () => {});

function commandHandler(name: string): () => Promise<void> {
    const calls = asMock(vscode.commands.registerCommand).mock.calls.filter(
        ([id]) => id === name,
    );
    const call = calls[calls.length - 1];
    if (!call) {
        throw new Error(`command not registered: ${name}`);
    }
    return call[1] as () => Promise<void>;
}

/**
 * Anchors project resolution: an active editor inside an opened folder,
 * with fs.stat mocked so findEnclosingProjectDir resolves a project dir.
 */
function anchorProject() {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: vscode.Uri.file('/proj'), name: 'proj' },
    ];
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
        document: { uri: vscode.Uri.file('/proj/mods/file.lua') },
    };
    asMock(vscode.workspace.fs.stat).mockResolvedValue({} as never);
}

describe('Add Mod command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        asMock(vscode.window.showInputBox).mockReset();
        anchorProject();
        registerAddCommand(execute);
    });

    it('passes an explicit Mod ID through to the engine', async () => {
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My New Mod')
            .mockResolvedValueOnce('my_id');

        await commandHandler('pzstudio.add')();

        expect(execute).toHaveBeenCalledWith(
            'add',
            ['My New Mod', 'my_id'],
            undefined,
            { projectDir: expect.any(String) },
        );
    });

    it('passes a confirmed blank Mod ID through for auto-generation', async () => {
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My New Mod')
            .mockResolvedValueOnce('');

        await commandHandler('pzstudio.add')();

        expect(execute).toHaveBeenCalledWith(
            'add',
            ['My New Mod', ''],
            undefined,
            { projectDir: expect.any(String) },
        );
    });

    it('aborts without invoking the engine when the Mod ID input is cancelled', async () => {
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My New Mod')
            .mockResolvedValueOnce(undefined);

        await commandHandler('pzstudio.add')();

        expect(execute).not.toHaveBeenCalled();
    });

    it('aborts without invoking the engine when the Mod Name input is cancelled', async () => {
        asMock(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

        await commandHandler('pzstudio.add')();

        expect(execute).not.toHaveBeenCalled();
        expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    });

    it('aborts without invoking the engine when the Mod Name is confirmed blank', async () => {
        asMock(vscode.window.showInputBox).mockResolvedValueOnce('');

        await commandHandler('pzstudio.add')();

        expect(execute).not.toHaveBeenCalled();
        expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    });
});
