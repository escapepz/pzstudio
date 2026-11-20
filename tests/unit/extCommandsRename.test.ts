'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import { defaultGetConfiguration } from '../helpers/vscode-mock';

import * as vscode from 'vscode';
import { registerRenameCommand } from '../../packages/vscode-extension/src/commands/rename';
import { createCommandRunner } from '../../packages/vscode-extension/src/util/execute';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;
const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;
const folder = (parts: string[]) => ({
    uri: new UriCtor(parts),
    name: parts[parts.length - 1] || 'root',
});
const fsPath = (parts: string[]) => new UriCtor(parts).fsPath;

const projectJson = (mods: Record<string, unknown>) =>
    new TextEncoder().encode(JSON.stringify({ mods, excludes: [] }));

/** readFile serves exactly one project.json at "/<root>/project.json". */
function withProjectJson(root: string, mods: Record<string, unknown>) {
    asMock(vscode.workspace.fs.readFile).mockImplementation(
        async (uri: { path: string }) => {
            if (uri.path === `/${root}/project.json`) {
                return projectJson(mods);
            }
            throw new Error('ENOENT');
        },
    );
}

let updateCalls: Array<[string, unknown, number?]>;

/**
 * Records configuration.update calls while keeping the faithful
 * resource-aware configuration model for reads.
 */
function spyConfigurationUpdates() {
    updateCalls = [];
    asMock(vscode.workspace.getConfiguration).mockImplementation(
        (section?: string, resource?: unknown) => {
            const conf = defaultGetConfiguration(section, resource);
            const original = conf.update.bind(conf);
            conf.update = (key: string, value: unknown, target?: number) => {
                updateCalls.push([key, value, target]);
                return original(key, value, target);
            };
            return conf as never;
        },
    );
}

interface Harness {
    studio: { run: ReturnType<typeof vi.fn> };
    handler: (node?: unknown) => Promise<void>;
}

/**
 * Registers rename on the REAL command runner wired to a studio stub, so
 * consent is judged by what actually reaches the engine (studio.run) —
 * not just by which modals opened.
 */
function setup(): Harness {
    const studio = { run: vi.fn(async () => {}) };
    const output = vscode.window.createOutputChannel('test');
    const runner = createCommandRunner(studio as never, output as never);
    registerRenameCommand(runner);
    const calls = asMock(vscode.commands.registerCommand).mock.calls as Array<
        [string, (node?: unknown) => Promise<void>]
    >;
    const entry = calls.find(([id]) => id === 'pzstudio.rename');
    expect(entry).toBeDefined();
    return { studio, handler: entry![1] };
}

// bf4-n07: the rename command used to show its own modal that ignored
// pzstudio.confirmBeforeRun and had no persisted bypass — unlike
// build/clean/delete since d05-F9. It must use the shared confirmBeforeRun
// helper exactly like them: the setting disables the modal, dismissal
// aborts, and "Don't Ask Again" persists confirmBeforeRun=false for the
// project's workspace folder.
describe('pzstudio.rename command (bf4-n07)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vscode.workspace.configurationStore.reset();
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [];
        (
            vscode.window as unknown as { activeTextEditor: unknown }
        ).activeTextEditor = undefined;
        // Pickers dismissed, inputs cancelled and modals closed unless a
        // test opts in.
        asMock(vscode.window.showQuickPick).mockResolvedValue(undefined);
        asMock(vscode.window.showInputBox).mockResolvedValue(undefined);
        asMock(vscode.window.showWarningMessage).mockResolvedValue(undefined);
    });

    it('asks the shared modal by default and forwards --yes on confirm', async () => {
        const { studio, handler } = setup();
        asMock(vscode.window.showInputBox).mockResolvedValue('renamed_mod');
        asMock(vscode.window.showWarningMessage).mockResolvedValue(
            vscode.l10n.t('Rename'),
        );

        await handler({
            modId: 'my_mod',
            projectDir: new UriCtor(['proj']),
        });

        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            expect.stringContaining("Rename mod 'my_mod' to 'renamed_mod'?"),
            { modal: true },
            vscode.l10n.t('Rename'),
            vscode.l10n.t("Don't Ask Again"),
        );
        expect(studio.run).toHaveBeenCalledWith(
            'rename',
            ['my_mod', 'renamed_mod'],
            {
                flags: ['--yes'],
                projectDir: fsPath(['proj']),
            },
        );
    });

    it('aborts without running when the modal is dismissed', async () => {
        const { studio, handler } = setup();
        asMock(vscode.window.showInputBox).mockResolvedValue('renamed_mod');

        await handler({
            modId: 'my_mod',
            projectDir: new UriCtor(['proj']),
        });

        // The only warning message is the confirm modal itself.
        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledTimes(
            1,
        );
        expect(studio.run).not.toHaveBeenCalled();
    });

    it('aborts without running when the new-name input is cancelled', async () => {
        const { studio, handler } = setup();

        await handler({
            modId: 'my_mod',
            projectDir: new UriCtor(['proj']),
        });

        expect(asMock(vscode.window.showInputBox)).toHaveBeenCalledTimes(1);
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
        expect(studio.run).not.toHaveBeenCalled();
    });

    it('runs without a modal when the setting is disabled', async () => {
        vscode.workspace.configurationStore.global[
            'pzstudio.confirmBeforeRun'
        ] = false;
        const { studio, handler } = setup();
        asMock(vscode.window.showInputBox).mockResolvedValue('renamed_mod');

        await handler({
            modId: 'my_mod',
            projectDir: new UriCtor(['proj']),
        });

        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
        expect(studio.run).toHaveBeenCalledWith(
            'rename',
            ['my_mod', 'renamed_mod'],
            {
                flags: ['--yes'],
                projectDir: fsPath(['proj']),
            },
        );
    });

    it("persists the Don't-Ask-Again bypass for the project's folder", async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['proj'])];
        // The config mock resolves folder scope through the store's keys.
        vscode.workspace.configurationStore.folders[fsPath(['proj'])] = {};
        withProjectJson('proj', { my_mod: {} });
        const { studio, handler } = setup();
        asMock(vscode.window.showInputBox).mockResolvedValue('renamed_mod');
        asMock(vscode.window.showWarningMessage).mockResolvedValue(
            vscode.l10n.t("Don't Ask Again"),
        );
        spyConfigurationUpdates();

        await handler({
            modId: 'my_mod',
            projectDir: new UriCtor(['proj']),
        });

        // Same persistence build/clean/delete get: confirmBeforeRun=false
        // written into the WorkspaceFolder scope of the operated project.
        expect(updateCalls).toContainEqual([
            'confirmBeforeRun',
            false,
            vscode.ConfigurationTarget.WorkspaceFolder,
        ]);
        // The bypass was written for the project's folder resource.
        expect(
            vscode.workspace.configurationStore.folders[fsPath(['proj'])][
                'pzstudio.confirmBeforeRun'
            ],
        ).toBe(false);
        // "Don't Ask Again" is not a cancel: the rename still ran.
        expect(studio.run).toHaveBeenCalledWith(
            'rename',
            ['my_mod', 'renamed_mod'],
            {
                flags: ['--yes'],
                projectDir: fsPath(['proj']),
            },
        );
    });

    it('resolves the project and its single mod through the picker path', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['proj'])];
        asMock(vscode.workspace.fs.stat).mockResolvedValue({
            type: vscode.FileType.File,
        });
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
        withProjectJson('proj', { my_mod: {} });
        const { studio, handler } = setup();
        asMock(vscode.window.showInputBox).mockResolvedValue('renamed_mod');
        asMock(vscode.window.showWarningMessage).mockResolvedValue(
            vscode.l10n.t('Rename'),
        );

        await handler(undefined);

        // Single project, single mod: no pickers at all.
        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
        expect(studio.run).toHaveBeenCalledWith(
            'rename',
            ['my_mod', 'renamed_mod'],
            {
                flags: ['--yes'],
                projectDir: fsPath(['proj']),
            },
        );
    });

    it('aborts silently when the mod picker is dismissed', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['proj'])];
        asMock(vscode.workspace.fs.stat).mockResolvedValue({
            type: vscode.FileType.File,
        });
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
        withProjectJson('proj', { alpha: {}, beta: {} });
        const { studio, handler } = setup();

        await handler(undefined);

        // Dismissed mod quick-pick: no input box, no confirm modal, no run,
        // no warning.
        expect(asMock(vscode.window.showQuickPick)).toHaveBeenCalledTimes(1);
        expect(asMock(vscode.window.showInputBox)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
        expect(studio.run).not.toHaveBeenCalled();
    });
});
