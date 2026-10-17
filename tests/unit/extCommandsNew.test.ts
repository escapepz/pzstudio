'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
// The REAL normalization the CLI engine applies (packages/cli/src/lib/
// commands/new.ts derives the created directory with this exact function
// re-exported from @pzstudio/core). The mock models the engine's actual
// created path with it — never a call-count response.
import { formatTitleToId } from '@pzstudio/core';
import { registerNewCommands } from '../../packages/vscode-extension/src/commands/new';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

const NO_WORKSPACE_ERROR =
    'PZStudio: Open a workspace folder before creating a project here.';

const execute = vi.fn(async () => {});

const fileNotFound = () =>
    Object.assign(new Error('entry not found'), { code: 'FileNotFound' });

/* ------------------------------------------------------------------ */
/* Path-aware fs model. The engine side of the mock writes the project */
/* at the path the real CLI produces (packages/cli/src/lib/commands/   */
/* new.ts: join(--path destination, formatTitleToId(modId || title),   */
/* 'project.json')), using the real @pzstudio/core normalization; the  */
/* vscode.workspace.fs stubs read the same model. Success detection is */
/* therefore exercised against the exact created URI, not call counts. */
/* ------------------------------------------------------------------ */

interface FsModel {
    dirs: Set<string>;
    files: Set<string>;
}

/** Every fs URI the probe (or any test flow) touched, in order. */
let probedPaths: string[];

/** The fs model installed for the current test (refreshed in beforeEach). */
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

/**
 * Engine mock: models `pzstudio new <title> [modId] --path <destination>` —
 * returns the implementation to install on the execute runner mock.
 */
function engineCreatesProject(fsModel: FsModel) {
    return async (_command: string, args: string[], extraFlags?: string[]) => {
        const [projectTitle, modId] = args as [string, string];
        const flagIndex = extraFlags?.indexOf('--path') ?? -1;
        const destination =
            flagIndex >= 0 ? extraFlags?.[flagIndex + 1] : undefined;
        if (!destination) throw new Error('engine mock: missing --path');
        // The exact CLI derivation (packages/cli/src/lib/commands/new.ts
        // line 81): the real @pzstudio/core formatTitleToId, modId wins
        // over the title — never a copy inside the extension.
        const id = formatTitleToId(modId || projectTitle);
        const projectDir = path.join(destination, id);
        fsModel.dirs.add(keyOf(projectDir));
        fsModel.files.add(keyOf(path.join(projectDir, 'project.json')));
    };
}

/**
 * Binds vscode.workspace.fs.stat/readDirectory to the model and records
 * every touched URI in probedPaths (test 9 inspects the exact URIs the
 * probe examined). stat on an unknown path rejects with FileNotFound,
 * exactly like the real host; readDirectory on an absent directory
 * rejects too, so an undeterminable probe can only fail closed.
 */
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
        // Drop unconsumed mockResolvedValueOnce entries from earlier tests.
        asMock(vscode.window.showInputBox).mockReset();
        asMock(vscode.window.showOpenDialog).mockReset();
        asMock(vscode.window.showQuickPick).mockReset();
        probedPaths = [];
        // Fresh empty fs model per test: the picked destination exists but
        // holds nothing, the default engine mock writes nothing. Creation
        // tests install engineCreatesProject on top of it.
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

    /* The CLI engine creates the project at
     * join(destination, formatTitleToId(modId || title), 'project.json') —
     * the mock models exactly that path with the real @pzstudio/core
     * normalization, so every assertion below examines the created URI. */

    it('records the destination when a confirmed blank Mod ID creates the title-derived directory (A13)', async () => {
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        // Confirmed blank Mod ID: the engine derives the directory from the
        // title (formatTitleToId('My Title') → 'my_title').
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
        // Explicit ID that needs normalization: 'My Cool ID' → 'my_cool_id'.
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

        // The engine writes <destination>/<modId>/project.json, never
        // <destination>/project.json: the probe must not have examined the
        // destination-root project.json at all.
        expect(probedPaths).not.toContain(
            keyOf(path.join('/picked', 'project.json')),
        );
        expect(context.workspaceState.update).toHaveBeenCalledWith(
            'pzstudio.lastNewProjectDestination',
            vscode.Uri.file('/picked').fsPath,
        );
    });

    it('does not remember the destination when the engine run produced no project (A13)', async () => {
        // The runner swallows engine failures ("already surfaced by
        // logger.error"), so "creation failed" is only observable on disk:
        // no project dir with a project.json appeared under the destination.
        const context = mockContext();
        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('');
        // Default engine mock resolves without writing anything.

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')();

        expect(execute).toHaveBeenCalled();
        expect(context.workspaceState.update).not.toHaveBeenCalled();
    });

    it('does not remember the destination when a project already exists there (A13)', async () => {
        const context = mockContext();
        // An existing project with the same normalized id: the CLI's
        // existence check (packages/cli/src/lib/commands/new.ts) throws
        // before creating anything, the runner swallows it, and the fs is
        // unchanged — no new child project.json, no recorded destination.
        addProjectJson(model, path.join('/picked', 'my_id'));

        asMock(vscode.window.showOpenDialog).mockResolvedValue([
            vscode.Uri.file('/picked'),
        ]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('My Title')
            .mockResolvedValueOnce('my_id');
        // Engine: the CLI throws 'dir already exists' and the runner
        // swallows it ("already surfaced by logger.error") — modeled as a
        // resolving runner call that writes nothing to the fs.
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
        // The failure still surfaces to the host; the destination must not
        // be recorded for the next picker default.
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
            // Run 1: destination picked, then cancelled at the Mod ID prompt.
            .mockResolvedValueOnce([vscode.Uri.file('/picked')])
            // Run 2: destination picked, engine fails without creating.
            .mockResolvedValueOnce([vscode.Uri.file('/second')])
            // Run 3: destination picked, genuine creation.
            .mockResolvedValue([vscode.Uri.file('/third')]);
        asMock(vscode.window.showInputBox)
            .mockResolvedValueOnce('First')
            .mockResolvedValueOnce(undefined) // cancelled at Mod ID
            .mockResolvedValueOnce('Second')
            .mockResolvedValueOnce('second_id')
            .mockResolvedValueOnce('Third')
            .mockResolvedValueOnce('third_id');
        // Run 2: the engine failure is swallowed by the runner, nothing is
        // written to the fs. Run 3 uses the real created-path engine mock.
        execute
            .mockImplementationOnce(async () => {})
            .mockImplementation(engineCreatesProject(model));

        registerNewCommands(context, execute);
        await commandHandler('pzstudio.new')(); // cancelled at Mod ID
        await commandHandler('pzstudio.new')(); // failed engine run
        await commandHandler('pzstudio.new')(); // genuine success

        expect(execute).toHaveBeenCalledTimes(2); // cancels never reach it
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
        // A13/UX-14: cancelling the picker aborts instead of falling back
        // to the configured default.
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
