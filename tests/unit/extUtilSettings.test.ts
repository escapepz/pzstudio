'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import {
    configurationStore,
    defaultGetConfiguration,
} from '../helpers/vscode-mock';
import { readPzStudioHostSettings } from '../../packages/vscode-extension/src/util/settings';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;
const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;

/**
 * Configuration stub whose inspect() mirrors a workspace where every layer
 * is exercised: workspace-only values, global-only values, both, and
 * neither. readPzStudioHostSettings must surface exactly the same
 * workspaceValue/globalValue snapshot the old push bridge fed
 * setVsCodeSettings (doc 11 §10 — UX-05 preserved bit-for-bit).
 */
function withLayeredConfig() {
    const table: Record<string, Record<string, unknown>> = {
        pzstudio: {
            outdir: { workspaceValue: 'C:/ws/out', globalValue: 'C:/user/out' },
            useSymlinks: { workspaceValue: false, globalValue: true },
        },
        'pzstudio.templates.project': {
            url: {
                workspaceValue: 'https://ws/project.git',
                globalValue: 'https://user/project.git',
            },
            ref: { workspaceValue: '42.17.0' },
        },
        'pzstudio.templates.mod': {
            url: { globalValue: 'https://user/mod.git' },
            ref: { globalValue: '42.13.0' },
        },
        'pzstudio.templates.workshop': {},
        'pzstudio.templates.language': {
            url: { workspaceValue: 'https://ws/lang.git' },
        },
    };
    asMock(vscode.workspace.getConfiguration).mockImplementation(
        (section: string) =>
            ({
                get: vi.fn(),
                inspect: vi.fn((key: string) => table[section]?.[key]),
                update: vi.fn(),
            }) as never,
    );
}

describe('readPzStudioHostSettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: nothing configured anywhere (implementations mocked by
        // one test must not leak into the next).
        asMock(vscode.workspace.getConfiguration).mockImplementation(
            () =>
                ({
                    get: vi.fn(),
                    inspect: vi.fn(() => undefined),
                    update: vi.fn(),
                }) as never,
        );
    });

    it('returns the same workspace/global layer shapes the pushed bridge fed the CLI', () => {
        withLayeredConfig();

        expect(readPzStudioHostSettings({ projectDir: 'C:/proj' })).toEqual({
            workspace: {
                templates: {
                    project: { url: 'https://ws/project.git', ref: '42.17.0' },
                    language: { url: 'https://ws/lang.git' },
                },
                outdir: 'C:/ws/out',
                useSymlinks: false,
            },
            user: {
                templates: {
                    project: { url: 'https://user/project.git' },
                    mod: { url: 'https://user/mod.git', ref: '42.13.0' },
                },
                outdir: 'C:/user/out',
                useSymlinks: true,
            },
        });
    });

    it('yields all-undefined layers when nothing is configured', () => {
        expect(readPzStudioHostSettings({ projectDir: 'C:/proj' })).toEqual({
            workspace: {
                templates: undefined,
                outdir: undefined,
                useSymlinks: undefined,
            },
            user: {
                templates: undefined,
                outdir: undefined,
                useSymlinks: undefined,
            },
        });
    });
});

/**
 * UX-05: the settings declared `scope: "resource"` in the manifest must be
 * resolved for the folder that owns the operated project. The provider
 * receives the effective projectDir from the v2 lifecycle; the adapter maps
 * it onto a resource-aware VS Code configuration so
 * folder > workspace > user values compose per project — never borrowed
 * across folders, never flattened into one snapshot.
 */
describe('readPzStudioHostSettings (UX-05 resource-scoped settings)', () => {
    /** Two independently configured workspace folders, each owning one project. */
    function withTwoFolders() {
        const folderA = new UriCtor(['ws', 'project-a']);
        const folderB = new UriCtor(['ws', 'project-b']);
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [
            { uri: folderA, name: 'project-a' },
            { uri: folderB, name: 'project-b' },
        ];
        return { folderA, folderB };
    }

    function setFolderSettings(
        folderUri: { fsPath: string },
        values: Record<string, unknown>,
    ): void {
        configurationStore.folders[folderUri.fsPath] = { ...values };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        configurationStore.reset();
        // Restore the faithful store-backed configuration model (the
        // describe above stubs getConfiguration with narrower tables).
        asMock(vscode.workspace.getConfiguration).mockImplementation(
            defaultGetConfiguration as never,
        );
    });

    it('resolves each project its own folder-scoped values, with no cross-leak', () => {
        const { folderA, folderB } = withTwoFolders();
        setFolderSettings(folderA, {
            'pzstudio.outdir': 'out-A',
            'pzstudio.useSymlinks': false,
        });
        setFolderSettings(folderB, {
            'pzstudio.outdir': 'out-B',
            'pzstudio.useSymlinks': true,
        });

        const forA = readPzStudioHostSettings({
            projectDir: folderA.fsPath,
        });
        const forB = readPzStudioHostSettings({
            projectDir: folderB.fsPath,
        });

        expect(forA.workspace).toEqual({
            templates: undefined,
            outdir: 'out-A',
            useSymlinks: false,
        });
        expect(forB.workspace).toEqual({
            templates: undefined,
            outdir: 'out-B',
            useSymlinks: true,
        });
        // The other folder's value is nowhere in either snapshot.
        expect(JSON.stringify(forA)).not.toContain('out-B');
        expect(JSON.stringify(forB)).not.toContain('out-A');
    });

    it('preserves a folder boolean false and empty-string over workspace values (defined-value precedence)', () => {
        const { folderA } = withTwoFolders();
        setFolderSettings(folderA, {
            'pzstudio.useSymlinks': false,
            'pzstudio.outdir': '',
        });
        configurationStore.workspace['pzstudio.useSymlinks'] = true;
        configurationStore.workspace['pzstudio.outdir'] = 'C:/ws/out';

        const snapshot = readPzStudioHostSettings({
            projectDir: folderA.fsPath,
        });

        // false and '' are folder VALUES, not absence: they must not be
        // replaced by the workspace-level truthy settings.
        expect(snapshot.workspace.useSymlinks).toBe(false);
        expect(snapshot.workspace.outdir).toBe('');
    });

    it('falls back to the workspace layer when the folder value is absent', () => {
        const { folderA, folderB } = withTwoFolders();
        setFolderSettings(folderA, {
            'pzstudio.outdir': 'out-A',
        });
        configurationStore.workspace['pzstudio.outdir'] = 'C:/ws/out';

        // project-b has no folder-level outdir: the workspace value applies.
        const forB = readPzStudioHostSettings({ projectDir: folderB.fsPath });
        expect(forB.workspace.outdir).toBe('C:/ws/out');
    });

    it('falls back to the user layer when neither folder nor workspace sets a value', () => {
        const { folderA } = withTwoFolders();
        configurationStore.global['pzstudio.outdir'] = 'C:/user/out';
        configurationStore.global['pzstudio.useSymlinks'] = false;

        const forA = readPzStudioHostSettings({ projectDir: folderA.fsPath });

        expect(forA.workspace.outdir).toBeUndefined();
        expect(forA.user).toEqual({
            templates: undefined,
            outdir: 'C:/user/out',
            useSymlinks: false,
        });
    });

    it('composes template categories per category and per field, not per object', () => {
        const { folderA } = withTwoFolders();
        // Folder A overrides ONLY the project template url; ref stays
        // workspace-level. Other categories keep their own layers.
        setFolderSettings(folderA, {
            'pzstudio.templates.project.url': 'https://folder-a/project.git',
        });
        configurationStore.workspace['pzstudio.templates.project.ref'] =
            '42.17.0';
        configurationStore.workspace['pzstudio.templates.mod.url'] =
            'https://ws/mod.git';
        configurationStore.global['pzstudio.templates.workshop.url'] =
            'https://user/workshop.git';

        const forA = readPzStudioHostSettings({ projectDir: folderA.fsPath });

        expect(forA.workspace.templates).toEqual({
            project: {
                url: 'https://folder-a/project.git',
                ref: '42.17.0',
            },
            mod: { url: 'https://ws/mod.git' },
        });
        // The untouched category resolves through the user layer as before.
        expect(forA.user.templates).toEqual({
            workshop: { url: 'https://user/workshop.git' },
        });
    });

    it('resolves a project nested below a workspace folder through the owning folder', () => {
        const { folderA } = withTwoFolders();
        setFolderSettings(folderA, { 'pzstudio.outdir': 'out-A' });

        const nested = new UriCtor(['ws', 'project-a', 'mods', 'nested-proj']);
        const snapshot = readPzStudioHostSettings({
            projectDir: nested.fsPath,
        });

        expect(snapshot.workspace.outdir).toBe('out-A');
    });

    it('gives a project outside every workspace folder no folder value', () => {
        const { folderA, folderB } = withTwoFolders();
        setFolderSettings(folderA, { 'pzstudio.outdir': 'out-A' });
        setFolderSettings(folderB, { 'pzstudio.outdir': 'out-B' });
        configurationStore.workspace['pzstudio.outdir'] = 'C:/ws/out';
        configurationStore.global['pzstudio.templates.workshop.url'] =
            'https://user/workshop.git';

        const outside = new UriCtor(['elsewhere', 'standalone-proj']);
        const snapshot = readPzStudioHostSettings({
            projectDir: outside.fsPath,
        });

        // The workspace and user layers still apply — no unrelated folder's
        // value is borrowed (case E, and the project-less update context F).
        expect(snapshot.workspace).toEqual({
            templates: undefined,
            outdir: 'C:/ws/out',
            useSymlinks: undefined,
        });
        expect(snapshot.user.templates).toEqual({
            workshop: { url: 'https://user/workshop.git' },
        });
    });

    it('keeps the single-workspace-folder behavior (folder values resolve for its projects)', () => {
        const onlyFolder = new UriCtor(['solo', 'proj']);
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [{ uri: onlyFolder, name: 'proj' }];
        setFolderSettings(onlyFolder, { 'pzstudio.outdir': 'out-solo' });
        configurationStore.workspace['pzstudio.useSymlinks'] = false;
        configurationStore.global['pzstudio.outdir'] = 'C:/user/out';

        const snapshot = readPzStudioHostSettings({
            projectDir: onlyFolder.fsPath,
        });

        expect(snapshot.workspace).toEqual({
            templates: undefined,
            outdir: 'out-solo',
            useSymlinks: false,
        });
        expect(snapshot.user.outdir).toBe('C:/user/out');
    });

    it('reads fresh on every call: a folder setting change is observed on the next run', () => {
        const { folderA } = withTwoFolders();
        setFolderSettings(folderA, { 'pzstudio.outdir': 'out-A-v1' });

        expect(
            readPzStudioHostSettings({ projectDir: folderA.fsPath }).workspace
                .outdir,
        ).toBe('out-A-v1');

        // §12 freshness: no cache — the next provider invocation sees the
        // new value (and the sibling folder never does).
        configurationStore.folders[folderA.fsPath]['pzstudio.outdir'] =
            'out-A-v2';

        expect(
            readPzStudioHostSettings({ projectDir: folderA.fsPath }).workspace
                .outdir,
        ).toBe('out-A-v2');
    });
});
