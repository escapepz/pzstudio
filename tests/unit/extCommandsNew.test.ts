'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { registerNewCommands } from '../../packages/vscode-extension/src/commands/new';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

const NO_DESTINATION_WARNING =
    'PZStudio: No destination folder selected, project creation cancelled.';
const NO_WORKSPACE_ERROR =
    'PZStudio: Open a workspace folder before creating a project here.';

const execute = vi.fn(async () => {});

function mockContext(lastUsed?: string): vscode.ExtensionContext {
    return {
        extensionUri: vscode.Uri.file('/ext'),
        workspaceState: {
            get: vi.fn((_key: string) => lastUsed),
            update: vi.fn(async () => {}),
        },
    } as unknown as vscode.ExtensionContext;
}

function withSettings(options: { defaultLocation?: string } = {}) {
    asMock(vscode.workspace.getConfiguration).mockImplementation(
        () =>
            ({
                get: vi.fn(
                    (_key: string, defaultValue?: unknown) => defaultValue,
                ),
                inspect: vi.fn((key: string) =>
                    key === 'newProject.defaultLocation' &&
                    options.defaultLocation !== undefined
                        ? { globalValue: options.defaultLocation }
                        : undefined,
                ),
                update: vi.fn(),
            }) as never,
    );
}

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

function setFolders(folders: Array<{ uri: vscode.Uri; name: string }>) {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders =
        folders;
}

function folder(path: string, name: string) {
    return { uri: vscode.Uri.file(path), name };
}

describe('New Project commands', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Drop unconsumed mockResolvedValueOnce entries from earlier tests.
        asMock(vscode.window.showInputBox).mockReset();
        asMock(vscode.window.showOpenDialog).mockReset();
        asMock(vscode.window.showQuickPick).mockReset();
        withSettings();
        setFolders([]);
        registerNewCommands(mockContext(), execute);
    });

    it('registers both pzstudio.new and pzstudio.newHere', () => {
        const names = asMock(vscode.commands.registerCommand).mock.calls.map(
            ([id]) => id,
        );
        expect(names).toContain('pzstudio.new');
        expect(names).toContain('pzstudio.newHere');
    });

    it('opens the folder picker before prompting for project details', async () => {
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('my_id');

        await commandHandler('pzstudio.new')();

        const pickerOrder = asMock(vscode.window.showOpenDialog).mock
            .invocationCallOrder[0];
        const inputOrder = asMock(vscode.window.showInputBox).mock
            .invocationCallOrder[0];
        expect(pickerOrder).toBeLessThan(inputOrder);
    });

    it('creates the picked project with --path and the destination as project dir', async () => {
        const pickedUri = vscode.Uri.file('/picked');
        asMock(vscode.window.showOpenDialog).mockResolvedValue([pickedUri]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('my_id');

        await commandHandler('pzstudio.new')();

        expect(execute).toHaveBeenCalledWith(
            'new',
            ['My Title', 'my_id'],
            ['--path', pickedUri.fsPath],
            { projectDir: pickedUri.fsPath },
        );
    });

    it('uses the remembered destination when it is picked', async () => {
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();

        expect(context.workspaceState.update).toHaveBeenCalledWith(
            'pzstudio.lastNewProjectDestination',
            vscode.Uri.file('/picked').fsPath,
        );
    });

    it('uses pzstudio.newProject.defaultLocation as the picker default and cancel fallback', async () => {
        withSettings({ defaultLocation: '/prefs' });
        asMock(vscode.window.showOpenDialog).mockResolvedValue(undefined);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');

        await commandHandler('pzstudio.new')();

        const options = asMock(vscode.window.showOpenDialog).mock.calls[0][0];
        expect(options.defaultUri?.path).toBe('/prefs');
        expect(execute).toHaveBeenCalledWith(
            'new',
            ['My Title', ''],
            ['--path', vscode.Uri.file('/prefs').fsPath],
            { projectDir: vscode.Uri.file('/prefs').fsPath },
        );
    });

    it('falls back to the last used destination when no setting is configured', async () => {
        registerNewCommands(mockContext('/last'), execute);
        asMock(vscode.window.showOpenDialog).mockResolvedValue(undefined);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');

        await commandHandler('pzstudio.new')();

        const options = asMock(vscode.window.showOpenDialog).mock.calls[0][0];
        expect(options.defaultUri?.path).toBe('/last');
        expect(execute).toHaveBeenCalledWith(
            'new',
            ['My Title', ''],
            ['--path', vscode.Uri.file('/last').fsPath],
            { projectDir: vscode.Uri.file('/last').fsPath },
        );
    });

    it('falls back to the first workspace folder as the final default', async () => {
        setFolders([folder('/w1', 'w1')]);
        asMock(vscode.window.showOpenDialog).mockResolvedValue([]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');

        await commandHandler('pzstudio.new')();

        const options = asMock(vscode.window.showOpenDialog).mock.calls[0][0];
        expect(options.defaultUri?.path).toBe('/w1');
        expect(execute).toHaveBeenCalledWith(
            'new',
            ['My Title', ''],
            ['--path', vscode.Uri.file('/w1').fsPath],
            { projectDir: vscode.Uri.file('/w1').fsPath },
        );
    });

    it('warns and does nothing when the picker is cancelled without any default', async () => {
        asMock(vscode.window.showOpenDialog).mockResolvedValue(undefined);

        await commandHandler('pzstudio.new')();

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            NO_DESTINATION_WARNING,
        );
        expect(execute).not.toHaveBeenCalled();
    });

    it('New Project Here errors when no workspace folder is open', async () => {
        await commandHandler('pzstudio.newHere')();

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            NO_WORKSPACE_ERROR,
        );
        expect(execute).not.toHaveBeenCalled();
    });

    it('New Project Here uses the single workspace folder directly', async () => {
        setFolders([folder('/w1', 'w1')]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('my_id');

        await commandHandler('pzstudio.newHere')();

        expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledWith(
            'new',
            ['My Title', 'my_id'],
            ['--path', vscode.Uri.file('/w1').fsPath],
            { projectDir: vscode.Uri.file('/w1').fsPath },
        );
    });

    it('New Project Here asks which folder to use in multi-root workspaces', async () => {
        const second = folder('/w2', 'w2');
        setFolders([folder('/w1', 'w1'), second]);
        asMock(vscode.window.showQuickPick).mockResolvedValue({
            label: second.name,
            description: second.uri.fsPath,
            folder: second,
        });
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');

        await commandHandler('pzstudio.newHere')();

        const options = asMock(vscode.window.showQuickPick).mock.calls[0][1];
        expect(options.placeHolder).toBe(
            'Select the workspace folder for the new project',
        );
        expect(execute).toHaveBeenCalledWith(
            'new',
            ['My Title', ''],
            ['--path', second.uri.fsPath],
            { projectDir: second.uri.fsPath },
        );
    });

    it('New Project Here does nothing when the folder quick-pick is dismissed', async () => {
        setFolders([folder('/w1', 'w1'), folder('/w2', 'w2')]);
        asMock(vscode.window.showQuickPick).mockResolvedValue(undefined);

        await commandHandler('pzstudio.newHere')();

        expect(execute).not.toHaveBeenCalled();
    });
});
