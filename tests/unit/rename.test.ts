import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import fs from 'fs';
import * as logger from '../../packages/cli/src/lib/logger';
import { renameCmd } from '../../packages/cli/src/lib/commands/rename';
import { setInvocationOptions } from '../../packages/cli/src/lib/args';
import {
    projectDir,
    readProjectConfig,
    updateProjectConfig,
    updateExperimentalScripts,
    getFilesRecursively,
} from '../../packages/cli/src/lib/helper';
import { scaffoldProject } from '../../packages/cli/src/lib/templateManager';

vi.mock('fs');
vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/templateManager');
vi.mock('../../packages/cli/src/lib/helper', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../packages/cli/src/lib/helper')
    >()),
    projectDir: vi.fn(),
    readProjectConfig: vi.fn(),
    updateProjectConfig: vi.fn(),
    updateExperimentalScripts: vi.fn(),
    getFilesRecursively: vi.fn(),
}));

describe('renameCmd', () => {
    const project = {
        workshop: { title: 'Test', visibility: 'public', tags: [] },
        mods: { old_mod: { name: 'Old', description: 'd' } },
        excludes: [],
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // Destructive gate (CLI-9): unit tests invoke the command directly
        // in embedded mode — publish --yes as the confirmation intent.
        setInvocationOptions({ yes: true });
        vi.mocked(projectDir).mockReturnValue('/proj' as any);
        // Fresh copy per call: renameCmd mutates the config it receives
        vi.mocked(readProjectConfig).mockImplementation(
            () => JSON.parse(JSON.stringify(project)) as any,
        );
        vi.mocked(scaffoldProject).mockReturnValue(undefined as any);
        vi.mocked(updateProjectConfig).mockReturnValue(undefined as any);
        vi.mocked(updateExperimentalScripts).mockReturnValue(undefined as any);
        vi.mocked(getFilesRecursively).mockReturnValue([
            '/proj/new_mod/scripts/script.lua',
            '/proj/new_mod/media/texture.png',
        ] as any);

        // Only the old mod directory "exists" (normalize separators: join()
        // produces backslashes on Windows)
        vi.mocked(fs.existsSync).mockImplementation((p: any) => {
            return String(p).replace(/\\/g, '/').endsWith('/old_mod');
        });

        // The d14-B5 subdirectory sweep walks the renamed tree; an empty
        // tree keeps the pre-sweep tests focused on their own behavior.
        vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    });

    /** Builds a fake withFileTypes dirent for the readdirSync mock. */
    const dirent = (name: string, isDirectory = true) =>
        ({
            name,
            isDirectory: () => isDirectory,
            isSymbolicLink: () => false,
        }) as any;

    const norm = (p: any) => String(p).replace(/\\/g, '/');

    it('should replace the mod id in text files', () => {
        vi.mocked(fs.readFileSync).mockReturnValue('old_mod says hi' as any);

        renameCmd('old_mod', 'new_mod');

        expect(fs.writeFileSync).toHaveBeenCalledWith(
            '/proj/new_mod/scripts/script.lua',
            'new_mod says hi',
            { encoding: 'utf-8' },
        );
    });

    it('should skip binary files entirely (no read, no write)', () => {
        vi.mocked(fs.readFileSync).mockReturnValue('old_mod' as any);

        renameCmd('old_mod', 'new_mod');

        const pngRead = vi
            .mocked(fs.readFileSync)
            .mock.calls.find((c) => String(c[0]).endsWith('texture.png'));
        expect(pngRead).toBeUndefined();

        const pngWrite = vi
            .mocked(fs.writeFileSync)
            .mock.calls.find((c) => String(c[0]).endsWith('texture.png'));
        expect(pngWrite).toBeUndefined();
    });

    it('should move the mod entry from old id to new id in project.json', () => {
        vi.mocked(fs.readFileSync).mockReturnValue('' as any);

        renameCmd('old_mod', 'new_mod');

        expect(updateProjectConfig).toHaveBeenCalledWith(
            join('/proj', 'project.json'),
            expect.objectContaining({
                mods: expect.objectContaining({ new_mod: expect.anything() }),
            }),
        );
        const updated = vi.mocked(updateProjectConfig).mock.calls[0][1] as any;
        expect(updated.mods.old_mod).toBeUndefined();
    });

    it('should throw when the old mod does not exist', () => {
        expect(() => renameCmd('missing_mod', 'new_mod')).toThrow(
            "Mod 'missing_mod' does not exist!",
        );
    });

    it('should throw when the new mod id is already taken', () => {
        vi.mocked(fs.existsSync).mockImplementation(() => true);

        expect(() => renameCmd('old_mod', 'new_mod')).toThrow(/already exists/);
    });

    it('should log skipped binary files in verbose mode', () => {
        vi.mocked(fs.readFileSync).mockReturnValue('' as any);

        renameCmd('old_mod', 'new_mod');

        expect(logger.verbose).toHaveBeenCalledWith(
            expect.stringContaining('texture.png'),
        );
    });

    // d14-B5: the PZ lua convention names media/lua/{server,client,shared}/
    // folders after the mod id — a rename must move them to the new id.
    it('renames subdirectories carrying the old mod id (media/lua/<ctx>/<old-id>)', () => {
        vi.mocked(fs.readFileSync).mockReturnValue('' as any);
        vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
            const entries: Record<string, any[]> = {
                '/proj/new_mod': [dirent('media')],
                '/proj/new_mod/media': [dirent('lua')],
                '/proj/new_mod/media/lua': [dirent('server'), dirent('client')],
                '/proj/new_mod/media/lua/server': [dirent('old_mod')],
                '/proj/new_mod/media/lua/server/old_mod': [],
                '/proj/new_mod/media/lua/client': [dirent('old_mod')],
                '/proj/new_mod/media/lua/client/old_mod': [],
            };
            return entries[norm(dir)] ?? [];
        });

        renameCmd('old_mod', 'new_mod');

        const renames = vi
            .mocked(fs.renameSync)
            .mock.calls.map(([from, to]) => [norm(from), norm(to)]);
        expect(renames).toContainEqual([
            '/proj/new_mod/media/lua/server/old_mod',
            '/proj/new_mod/media/lua/server/new_mod',
        ]);
        expect(renames).toContainEqual([
            '/proj/new_mod/media/lua/client/old_mod',
            '/proj/new_mod/media/lua/client/new_mod',
        ]);
        // Children before parents (deepest-first execution order).
        const indexes = renames.map(([from]) =>
            from.indexOf('/media/lua/server/old_mod') >= 0
                ? 0
                : from.indexOf('/media/lua/client/old_mod') >= 0
                  ? 1
                  : -1,
        );
        expect(indexes.filter((i) => i >= 0)).toEqual([0, 1]);
    });

    it('refuses fail-closed when a subdirectory destination already exists', () => {
        vi.mocked(fs.readFileSync).mockReturnValue('' as any);
        vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
            const entries: Record<string, any[]> = {
                '/proj/new_mod': [dirent('media')],
                '/proj/new_mod/media': [dirent('lua')],
                '/proj/new_mod/media/lua': [dirent('server')],
                '/proj/new_mod/media/lua/server': [dirent('old_mod')],
                '/proj/new_mod/media/lua/server/old_mod': [],
            };
            return entries[norm(dir)] ?? [];
        });
        vi.mocked(fs.existsSync).mockImplementation((p: any) => {
            return (
                norm(p).endsWith('/old_mod') ||
                norm(p).endsWith('/server/new_mod')
            );
        });

        expect(() => renameCmd('old_mod', 'new_mod')).toThrow(/already exists/);
        expect(fs.renameSync).not.toHaveBeenCalled();
    });

    it('leaves directories whose names do not carry the mod id untouched', () => {
        vi.mocked(fs.readFileSync).mockReturnValue('' as any);
        vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
            const entries: Record<string, any[]> = {
                '/proj/new_mod': [dirent('docs'), dirent('poster.png', false)],
                '/proj/new_mod/docs': [],
            };
            return entries[norm(dir)] ?? [];
        });

        renameCmd('old_mod', 'new_mod');

        expect(fs.renameSync).not.toHaveBeenCalled();
    });

    it('never renames a link entry (junctions/symlinks are user state)', () => {
        vi.mocked(fs.readFileSync).mockReturnValue('' as any);
        vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
            const entries: Record<string, any[]> = {
                '/proj/new_mod': [dirent('media')],
                '/proj/new_mod/media': [dirent('lua')],
                '/proj/new_mod/media/lua': [dirent('old_mod')],
            };
            const result = entries[norm(dir)] ?? [];
            if (norm(dir) === '/proj/new_mod/media/lua') {
                result[0] = {
                    name: 'old_mod',
                    isDirectory: () => true,
                    isSymbolicLink: () => true,
                } as any;
            }
            return result;
        });

        renameCmd('old_mod', 'new_mod');

        expect(fs.renameSync).not.toHaveBeenCalled();
    });
});
