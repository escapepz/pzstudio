'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import {
    findEnclosingProjectDir,
    findProjectDirs,
    getModSummaries,
    pickModId,
    readModConfig,
    resolveProjectDir,
    PROJECT_SCAN_LIMITS,
} from '../../packages/vscode-extension/src/util/project';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;
const folder = (parts: string[]) => ({
    uri: new UriCtor(parts),
    name: parts[parts.length - 1] || 'root',
});

const PROJECT_JSON = JSON.stringify({
    mods: {
        mod_a: { name: 'A' },
        mod_b: { name: 'B', build: { devOnly: true } },
    },
    excludes: ['mod_b'],
});

/** stat succeeds only for ".../project.json" under `projectRoots`. */
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

describe('getModSummaries / pickModId', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['proj'])];
        (
            vscode.window as unknown as { activeTextEditor: unknown }
        ).activeTextEditor = undefined;
        // clearAllMocks keeps stale implementations, so every mock the
        // discovery path touches is set explicitly here.
        statProjects(['/proj']);
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
    });

    it('reads mod summaries from project.json', async () => {
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            new TextEncoder().encode(PROJECT_JSON),
        );
        await expect(getModSummaries(new UriCtor(['proj']))).resolves.toEqual([
            { id: 'mod_a', name: 'A' },
            { id: 'mod_b', name: 'B' },
        ]);
    });

    it('returns an empty list when project.json is unreadable', async () => {
        asMock(vscode.workspace.fs.readFile).mockRejectedValue(
            new Error('ENOENT'),
        );
        await expect(getModSummaries(new UriCtor(['proj']))).resolves.toEqual(
            [],
        );
    });

    it('pickModId quick-picks the mods of a resolved subfolder project', async () => {
        // The project lives in a depth-1 subfolder: the old picker only
        // read the workspace root's project.json and fell back to typed
        // input here instead of offering the mod list.
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['root'])];
        statProjects(['/root/alpha']);
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([
            ['alpha', vscode.FileType.Directory],
        ] as never);
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            new TextEncoder().encode(PROJECT_JSON),
        );
        asMock(vscode.window.showQuickPick).mockResolvedValue({
            label: 'mod_a',
            description: 'A',
            mod: { id: 'mod_a', name: 'A' },
        });

        const picked = await pickModId('Pick one');

        expect(picked?.modId).toBe('mod_a');
        expect(picked?.projectDir.path).toBe('/root/alpha');
        expect(asMock(vscode.window.showInputBox)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showQuickPick)).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ label: 'mod_a', description: 'A' }),
                expect.objectContaining({ label: 'mod_b', description: 'B' }),
            ]),
            expect.objectContaining({ placeHolder: 'Pick one' }),
        );
    });

    it('pickModId auto-selects when the project has a single mod', async () => {
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            new TextEncoder().encode('{"mods":{"only_mod":{"name":"Only"}}}'),
        );

        const picked = await pickModId('Pick one');

        expect(picked?.modId).toBe('only_mod');
        expect(picked?.projectDir.path).toBe('/proj');
        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showInputBox)).not.toHaveBeenCalled();
    });

    it('pickModId falls back to free text when there are no mods', async () => {
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            new TextEncoder().encode('{"mods":{}}'),
        );
        asMock(vscode.window.showInputBox).mockResolvedValue('typed_id');

        const picked = await pickModId('Pick one');

        expect(picked?.modId).toBe('typed_id');
        expect(picked?.projectDir.path).toBe('/proj');
        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
    });

    it('pickModId warns and aborts when the workspace has no project', async () => {
        statProjects([]);
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);

        await expect(pickModId('Pick one')).resolves.toBeUndefined();
        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            expect.stringContaining('no PZ project'),
        );
    });

    it('pickModId uses an explicit projectDir without discovery', async () => {
        statProjects([]);
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            new TextEncoder().encode('{"mods":{"given_mod":{}}}'),
        );

        const picked = await pickModId('Pick one', {
            projectDir: new UriCtor(['explicit']),
        });

        expect(picked?.modId).toBe('given_mod');
        expect(picked?.projectDir.path).toBe('/explicit');
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
    });
});

describe('findProjectDirs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('discovers a project in the workspace root', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['proj'])];
        statProjects(['/proj']);
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);

        const { dirs, truncated } = await findProjectDirs();
        expect(dirs.map((d) => d.path)).toEqual(['/proj']);
        expect(truncated).toBe(false);
    });

    it('discovers depth-1 subfolder projects and skips node_modules', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['root'])];
        statProjects(['/root/alpha']);
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([
            ['alpha', vscode.FileType.Directory],
            ['node_modules', vscode.FileType.Directory],
            ['plain', vscode.FileType.Directory],
            ['file.txt', vscode.FileType.File],
        ] as never);

        const { dirs, truncated } = await findProjectDirs();
        expect(dirs.map((d) => d.path)).toEqual(['/root/alpha']);
        expect(truncated).toBe(false);
    });

    it('reports truncation past the scan limits', async () => {
        const roots = Array.from(
            { length: PROJECT_SCAN_LIMITS.maxRootProjects + 2 },
            (_, i) => folder(['root' + i]),
        );
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = roots;
        statProjects(roots.map((r) => r.uri.path));
        asMock(vscode.workspace.fs.readDirectory).mockRejectedValue(
            new Error('ENOENT'),
        );

        const { dirs, truncated } = await findProjectDirs();
        expect(dirs).toHaveLength(PROJECT_SCAN_LIMITS.maxRootProjects);
        expect(truncated).toBe(true);
    });
});

describe('resolveProjectDir', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('auto-selects the only discovered project', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['only'])];
        statProjects(['/only']);
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);

        const dir = await resolveProjectDir('build');
        expect(dir?.path).toBe('/only');
        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
    });

    it('quick-picks among several discovered projects, labeled by workshop title', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['one']), folder(['two'])];
        statProjects(['/one', '/two']);
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
        asMock(vscode.workspace.fs.readFile).mockImplementation((async (uri: {
            path: string;
        }) => {
            const titles: Record<string, string> = {
                '/one/project.json': JSON.stringify({
                    workshop: { title: 'Title One', id: 111 },
                }),
                '/two/project.json': JSON.stringify({
                    workshop: { title: 'Title Two' },
                }),
            };
            if (titles[uri.path]) {
                return new TextEncoder().encode(titles[uri.path]);
            }
            throw new Error('ENOENT');
        }) as never);
        asMock(vscode.window.showQuickPick).mockResolvedValue({
            label: 'two',
            description: 'Title Two',
            detail: '/two',
            dir: new UriCtor(['two']),
        });

        const dir = await resolveProjectDir('build');
        expect(dir?.path).toBe('/two');
        expect(asMock(vscode.window.showQuickPick)).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    label: 'one',
                    description: 'Title One',
                }),
                expect.objectContaining({
                    label: 'two',
                    description: 'Title Two',
                }),
            ]),
            expect.objectContaining({
                placeHolder: 'Select the project to build',
            }),
        );
    });

    it('returns undefined when there is no project at all', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['empty'])];
        statProjects([]);
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);

        await expect(resolveProjectDir('build')).resolves.toBeUndefined();
    });

    it('prefers the project enclosing the active editor', async () => {
        const root = folder(['deep']);
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [root];
        statProjects(['/deep']);
        const activeUri = new UriCtor(['deep', 'media', 'lua', 'x.lua']);
        (
            vscode.window as unknown as { activeTextEditor: unknown }
        ).activeTextEditor = { document: { uri: activeUri } };

        const dir = await resolveProjectDir('build');
        expect(dir?.path).toBe('/deep');
        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
    });
});

describe('findEnclosingProjectDir', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('walks up from a nested file to the project root', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['wsproj'])];
        statProjects(['/wsproj']);
        const startPath = path.join(
            new UriCtor(['wsproj']).fsPath,
            'media',
            'lua',
            'script.lua',
        );

        const dir = await findEnclosingProjectDir(startPath);
        expect(dir?.path).toBe('/wsproj');
    });

    it('returns undefined when nothing encloses the path', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [folder(['wsproj'])];
        statProjects([]);
        const startPath = path.join(
            new UriCtor(['wsproj']).fsPath,
            'media',
            'x.lua',
        );

        await expect(
            findEnclosingProjectDir(startPath),
        ).resolves.toBeUndefined();
    });
});

describe('readModConfig', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('extracts fields, modInfo and the build state', async () => {
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            new TextEncoder().encode(PROJECT_JSON),
        );
        // mod_b is excluded → excluded wins over dev-only.
        const snapshot = await readModConfig(new UriCtor(['proj']), 'mod_b');
        expect(snapshot).toEqual({
            fields: { name: 'B' },
            modInfo: undefined,
            state: 'excluded',
        });
    });

    it('reports dev-only state for non-excluded mods', async () => {
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            new TextEncoder().encode(
                JSON.stringify({
                    mods: { mod_b: { build: { devOnly: true } } },
                }),
            ),
        );
        const devOnly = await readModConfig(new UriCtor(['proj']), 'mod_b');
        expect(devOnly?.state).toBe('dev only');
    });

    it('returns undefined for missing mods and unreadable files', async () => {
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            new TextEncoder().encode(PROJECT_JSON),
        );
        await expect(
            readModConfig(new UriCtor(['proj']), 'ghost'),
        ).resolves.toBeUndefined();

        asMock(vscode.workspace.fs.readFile).mockRejectedValue(
            new Error('ENOENT'),
        );
        await expect(
            readModConfig(new UriCtor(['proj']), 'mod_a'),
        ).resolves.toBeUndefined();
    });
});
