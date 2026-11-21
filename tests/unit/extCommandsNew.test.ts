'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { formatTitleToId } from '@pzstudio/core';
import { registerNewCommands } from '../../packages/vscode-extension/src/commands/new';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

const NO_WORKSPACE_ERROR =
    'PZStudio: Open a workspace folder before creating a project here.';

const execute = vi.fn(async () => {});

const fileNotFound = () =>
    Object.assign(new Error('entry not found'), { code: 'FileNotFound' });

interface FsModel {
    dirs: Set<string>;
    files: Set<string>;
}

let probedPaths: string[];

let model: FsModel;

const keyOf = (fsPath: string) => path.normalize(fsPath);

function createFsModel(): FsModel {
    return { dirs: new Set(), files: new Set() };
}

function seedDestination(model: FsModel, fsPath: string) {
    model.dirs.add(keyOf(fsPath));
}

function addProjectJson(model: FsModel, projectDir: string) {
    model.dirs.add(keyOf(projectDir));
    model.files.add(keyOf(path.join(projectDir, 'project.json')));
}

function engineCreatesProject(fsModel: FsModel) {
    return async (_command: string, args: string[], extraFlags?: string[]) => {
        const [projectTitle, modId] = args as [string, string];
        const flagIndex = extraFlags?.indexOf('--path') ?? -1;
        const destination =
            flagIndex >= 0 ? extraFlags?.[flagIndex + 1] : undefined;
        if (!destination) throw new Error('engine mock: missing --path');
        const id = formatTitleToId(modId || projectTitle);
        const projectDir = path.join(destination, id);
        fsModel.dirs.add(keyOf(projectDir));
        fsModel.files.add(keyOf(path.join(projectDir, 'project.json')));
    };
}

function installFsModel(model: FsModel) {
    const stat = asMock(vscode.workspace.fs.stat);
    stat.mockReset();
    stat.mockImplementation(async (uri: vscode.Uri) => {
        probedPaths.push(uri.fsPath);
        const key = keyOf(uri.fsPath);
        if (model.files.has(key)) return { type: vscode.FileType.File };
        if (model.dirs.has(key)) return { type: vscode.FileType.Directory };
        throw fileNotFound();
    });

    const readDirectory = asMock(vscode.workspace.fs.readDirectory);
    readDirectory.mockReset();
    readDirectory.mockImplementation(async (uri: vscode.Uri) => {
        probedPaths.push(uri.fsPath);
        const dirKey = keyOf(uri.fsPath);
        if (!model.dirs.has(dirKey)) throw fileNotFound();
        const entries: Array<[string, number]> = [];
        for (const dir of model.dirs) {
            if (path.dirname(dir) === dirKey) {
                entries.push([path.basename(dir), vscode.FileType.Directory]);
            }
        }
        for (const file of model.files) {
            if (path.dirname(file) === dirKey) {
                entries.push([path.basename(file), vscode.FileType.File]);
            }
        }
        return entries;
    });
}

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
        asMock(vscode.window.showInputBox).mockReset();
        asMock(vscode.window.showOpenDialog).mockReset();
        asMock(vscode.window.showQuickPick).mockReset();
        probedPaths = [];
        model = createFsModel();
        seedDestination(model, '/picked');
        installFsModel(model);
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

    it('records the destination when a confirmed blank Mod ID creates the title-derived directory (A13)', async () => {
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');
        execute.mockImplementation(engineCreatesProject(model));

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();

        const createdDir = path.join('/picked', formatTitleToId('My Title'));
        expect(
            model.files.has(keyOf(path.join(createdDir, 'project.json'))),
        ).toBe(true);
        expect(context.workspaceState.update).toHaveBeenCalledTimes(1);
        expect(context.workspaceState.update).toHaveBeenCalledWith(
            'pzstudio.lastNewProjectDestination',
            vscode.Uri.file('/picked').fsPath,
        );
    });

    it('records the destination when an explicit Mod ID creates the normalized explicit-ID directory (A13)', async () => {
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('My Cool ID');
        execute.mockImplementation(engineCreatesProject(model));

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();

        expect(execute).toHaveBeenCalledWith(
            'new',
            ['My Title', 'My Cool ID'],
            ['--path', vscode.Uri.file('/picked').fsPath],
            { projectDir: vscode.Uri.file('/picked').fsPath },
        );
        const createdDir = path.join('/picked', formatTitleToId('My Cool ID'));
        expect(
            model.files.has(keyOf(path.join(createdDir, 'project.json'))),
        ).toBe(true);
        expect(context.workspaceState.update).toHaveBeenCalledTimes(1);
        expect(context.workspaceState.update).toHaveBeenCalledWith(
            'pzstudio.lastNewProjectDestination',
            vscode.Uri.file('/picked').fsPath,
        );
    });

    it('records a successful creation exactly once (A13)', async () => {
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('my_id');
        execute.mockImplementation(engineCreatesProject(model));

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();

        expect(execute).toHaveBeenCalledTimes(1);
        expect(context.workspaceState.update).toHaveBeenCalledTimes(1);
        expect(context.workspaceState.update).toHaveBeenCalledWith(
            'pzstudio.lastNewProjectDestination',
            vscode.Uri.file('/picked').fsPath,
        );
    });

    it('never probes <destination>/project.json as the created project', async () => {
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('my_id');
        execute.mockImplementation(engineCreatesProject(model));

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();

        expect(probedPaths).not.toContain(
            keyOf(path.join('/picked', 'project.json')),
        );
        expect(context.workspaceState.update).toHaveBeenCalledWith(
            'pzstudio.lastNewProjectDestination',
            vscode.Uri.file('/picked').fsPath,
        );
    });

    it('does not remember the destination when the engine run produced no project (A13)', async () => {
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();

        expect(execute).toHaveBeenCalled();
        expect(context.workspaceState.update).not.toHaveBeenCalled();
    });

    it('does not remember the destination when a project already exists there (A13)', async () => {
        const context = mockContext();
        addProjectJson(model, path.join('/picked', 'my_id'));

        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('my_id');
        execute.mockImplementationOnce(async () => {});

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();

        expect(execute).toHaveBeenCalled();
        expect(context.workspaceState.update).not.toHaveBeenCalled();
    });

    it('does not remember the destination when the Project Title prompt is cancelled (A13)', async () => {
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();

        expect(execute).not.toHaveBeenCalled();
        expect(context.workspaceState.update).not.toHaveBeenCalled();
    });

    it('does not remember the destination when the optional Mod ID prompt is cancelled (A13)', async () => {
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce(undefined);

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();

        expect(execute).not.toHaveBeenCalled();
        expect(context.workspaceState.update).not.toHaveBeenCalled();
    });

    it('does not remember the destination when project creation fails (A13)', async () => {
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');
        execute.mockImplementationOnce(async () => {
            throw new Error('engine failure');
        });

        registerNewCommands(context, execute);
        await expect(commandHandler('pzstudio.new')()).rejects.toThrow(
            'engine failure',
        );
        expect(context.workspaceState.update).not.toHaveBeenCalled();
    });

    it('does not remember the destination when the folder picker is cancelled (A13)', async () => {
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue(undefined);

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();

        expect(execute).not.toHaveBeenCalled();
        expect(context.workspaceState.update).not.toHaveBeenCalled();
    });

    it('failed or cancelled creations never poison the last-used destination (A13)', async () => {
        const context = mockContext();
        seedDestination(model, '/second');
        seedDestination(model, '/third');
        asMock(vscode.window.showOpenDialog)
            .mockResolvedValueOnce([vscode.Uri.file('/picked')])
            .mockResolvedValueOnce([vscode.Uri.file('/second')])
            .mockResolvedValue([vscode.Uri.file('/third')]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('First')
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce('Second')
            .mockResolvedValueOnce('second_id')
            .mockResolvedValueOnce('Third')
            .mockResolvedValueOnce('third_id');
        execute
            .mockImplementationOnce(async () => {})
            .mockImplementation(engineCreatesProject(model));

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();
        await commandHandler('pzstudio.new')(); // failed engine run
        await commandHandler('pzstudio.new')(); // genuine success

        expect(execute).toHaveBeenCalledTimes(2);
        expect(context.workspaceState.update).toHaveBeenCalledTimes(1);
        expect(context.workspaceState.update).toHaveBeenCalledWith(
            'pzstudio.lastNewProjectDestination',
            vscode.Uri.file('/third').fsPath,
        );
    });

    it('uses pzstudio.newProject.defaultLocation as the initial picker location and cancel aborts', async () => {
        withSettings({ defaultLocation: '/prefs' });
        asMock(vscode.window.showOpenDialog).mockResolvedValue(undefined);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');

        await commandHandler('pzstudio.new')();

        const options = asMock(vscode.window.showOpenDialog).mock.calls[0][0];
        expect(options.defaultUri?.path).toBe('/prefs');
        expect(execute).not.toHaveBeenCalled();
    });

    it('offers the last used destination as the initial picker location and cancel aborts', async () => {
        registerNewCommands(mockContext('/last'), execute);
        asMock(vscode.window.showOpenDialog).mockResolvedValue(undefined);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');

        await commandHandler('pzstudio.new')();

        const options = asMock(vscode.window.showOpenDialog).mock.calls[0][0];
        expect(options.defaultUri?.path).toBe('/last');
        expect(execute).not.toHaveBeenCalled();
    });

    it('offers the first workspace folder as the final initial picker location and cancel aborts', async () => {
        setFolders([folder('/w1', 'w1')]);
        asMock(vscode.window.showOpenDialog).mockResolvedValue([]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');

        await commandHandler('pzstudio.new')();

        const options = asMock(vscode.window.showOpenDialog).mock.calls[0][0];
        expect(options.defaultUri?.path).toBe('/w1');
        expect(execute).not.toHaveBeenCalled();
    });

    it('aborts silently when the picker is cancelled without any default', async () => {
        asMock(vscode.window.showOpenDialog).mockResolvedValue(undefined);

        await commandHandler('pzstudio.new')();

        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
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

    it('aborts when the optional Mod ID input is cancelled after the title', async () => {
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce(undefined);

        await commandHandler('pzstudio.new')();

        expect(execute).not.toHaveBeenCalled();
    });

    it('aborts silently when the destination picker is cancelled, even with a configured default', async () => {
        withSettings({ defaultLocation: '/prefs' });
        asMock(vscode.window.showOpenDialog).mockResolvedValue(undefined);

        await commandHandler('pzstudio.new')();

        expect(execute).not.toHaveBeenCalled();
        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('aborts silently when the picker is dismissed with an empty selection', async () => {
        setFolders([folder('/w1', 'w1')]);
        asMock(vscode.window.showOpenDialog).mockResolvedValue([]);

        await commandHandler('pzstudio.new')();

        expect(execute).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
});
