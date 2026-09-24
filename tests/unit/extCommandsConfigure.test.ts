'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { registerConfigureCommand } from '../../packages/vscode-extension/src/commands/configure';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;
const PROJECT_JSON = JSON.stringify({
    mods: { m1: { name: 'Old Name', pack: ['a', 'b'] } },
});

/** Registers the command and returns its handler + the execute spy. */
async function setupHandler() {
    const execute = vi.fn(async () => {});
    registerConfigureCommand(execute as never);
    const calls = asMock(vscode.commands.registerCommand).mock.calls as Array<
        [string, (node?: unknown) => Promise<void>]
    >;
    const entry = calls.find(([id]) => id === 'pzstudio.modConfigure');
    expect(entry).toBeDefined();
    return { handler: entry![1], execute };
}

const modNode = {
    modId: 'm1',
    projectDir: new UriCtor(['proj']),
};

describe('pzstudio.modConfigure', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            new TextEncoder().encode(PROJECT_JSON),
        );
    });

    it('runs modconfig include/devonly/exclude through the inclusion menu', async () => {
        const { handler, execute } = await setupHandler();
        asMock(vscode.window.showQuickPick)
            .mockImplementationOnce(async (items: unknown[]) => items[0]) // inclusion entry
            .mockImplementationOnce(
                async (choices: Array<{ action: string }>) =>
                    choices.find((c) => c.action === 'devonly'),
            );

        await handler(modNode);

        expect(execute).toHaveBeenCalledWith('modconfig', ['m1', 'devonly']);
    });

    it('sets build.modInfo through the note menu', async () => {
        const { handler, execute } = await setupHandler();
        asMock(vscode.window.showQuickPick)
            .mockImplementationOnce(async (items: unknown[]) => items[1]) // modInfo entry
            .mockImplementationOnce(async (choices: string[]) =>
                choices.find((c) => c === 'skip'),
            );

        await handler(modNode);

        expect(execute).toHaveBeenCalledWith('modconfig', [
            'm1',
            'set',
            'modInfo',
            'skip',
        ]);
    });

    it('prefills the current field value and writes non-empty input', async () => {
        const { handler, execute } = await setupHandler();
        asMock(vscode.window.showQuickPick).mockImplementationOnce(
            async (items: Array<{ label: string }>) =>
                items.find((item) => item.label === 'name'),
        );
        asMock(vscode.window.showInputBox).mockResolvedValue('New Name');

        await handler(modNode);

        expect(asMock(vscode.window.showInputBox)).toHaveBeenCalledWith(
            expect.objectContaining({ value: 'Old Name' }),
        );
        expect(execute).toHaveBeenCalledWith('modconfig', [
            'm1',
            'set',
            'name',
            'New Name',
        ]);
    });

    it('unsets a field when the input is cleared', async () => {
        const { handler, execute } = await setupHandler();
        asMock(vscode.window.showQuickPick).mockImplementationOnce(
            async (items: Array<{ label: string }>) =>
                items.find((item) => item.label === 'name'),
        );
        asMock(vscode.window.showInputBox).mockResolvedValue('   ');

        await handler(modNode);

        expect(execute).toHaveBeenCalledWith('modconfig', [
            'm1',
            'unset',
            'name',
        ]);
    });

    it('leaves array fields comma-separated', async () => {
        const { handler, execute } = await setupHandler();
        asMock(vscode.window.showQuickPick).mockImplementationOnce(
            async (items: Array<{ label: string }>) =>
                items.find((item) => item.label === 'pack'),
        );
        asMock(vscode.window.showInputBox).mockImplementation(
            ({ value }: { value?: string }) => Promise.resolve(value),
        );

        await handler(modNode);

        // pack prefill is 'a, b' — unchanged input re-saves the same value.
        expect(asMock(vscode.window.showInputBox)).toHaveBeenCalledWith(
            expect.objectContaining({ value: 'a, b' }),
        );
        expect(execute).toHaveBeenCalledWith('modconfig', [
            'm1',
            'set',
            'pack',
            'a, b',
        ]);
    });

    it('does nothing when the field menu is dismissed', async () => {
        const { handler, execute } = await setupHandler();
        asMock(vscode.window.showQuickPick).mockResolvedValue(undefined);

        await handler(modNode);

        expect(execute).not.toHaveBeenCalled();
    });

    it('warns when the mod config is unreadable', async () => {
        const { handler, execute } = await setupHandler();
        asMock(vscode.workspace.fs.readFile).mockRejectedValue(
            new Error('ENOENT'),
        );

        await handler(modNode);

        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            expect.stringContaining(
                "Cannot read the configuration of mod 'm1'",
            ),
        );
        expect(execute).not.toHaveBeenCalled();
    });
});
