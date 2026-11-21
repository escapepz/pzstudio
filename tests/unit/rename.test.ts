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
        setInvocationOptions({ yes: true });
        vi.mocked(projectDir).mockReturnValue('/proj' as any);
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

        vi.mocked(fs.existsSync).mockImplementation((p: any) => {
            return String(p).replace(/\\/g, '/').endsWith('/old_mod');
        });

        vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    });

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

    it('warns for subdirectories carrying the old mod id (media/lua/<ctx>/<old-id>)', () => {
        vi.mocked(fs.readFileSync).mockReturnValue('old_mod says hi' as any);
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

        expect(
            fs.existsSync(join('/proj', 'new_mod/media/lua/server/old_mod')),
        ).toBe(true);
        expect(
            fs.existsSync(join('/proj', 'new_mod/media/lua/client/old_mod')),
        ).toBe(true);
        expect(fs.renameSync).not.toHaveBeenCalled();

        const warned = vi
            .mocked(logger.warn)
            .mock.calls.map(([message]) => norm(message));
        expect(warned).toContain(
            "subdirectory '/proj/new_mod/media/lua/server/old_mod' still carries the old mod id 'old_mod'",
        );
        expect(warned).toContain(
            "subdirectory '/proj/new_mod/media/lua/client/old_mod' still carries the old mod id 'old_mod'",
        );

        const scaffolded = vi
            .mocked(scaffoldProject)
            .mock.calls[0].slice(0, 2)
            .map(norm);
        expect(scaffolded).toEqual(['/proj/old_mod', '/proj/new_mod']);
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            '/proj/new_mod/scripts/script.lua',
            'new_mod says hi',
            { encoding: 'utf-8' },
        );
        const updated = vi.mocked(updateProjectConfig).mock.calls[0][1] as any;
        expect(updated.mods.old_mod).toBeUndefined();
        expect(updated.mods.new_mod).toBeDefined();
    });

    it('warns for nested old-id directory names and never renames anything', () => {
        vi.mocked(fs.readFileSync).mockReturnValue('' as any);
        vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
            const entries: Record<string, any[]> = {
                '/proj/new_mod': [dirent('42')],
                '/proj/new_mod/42': [dirent('media')],
                '/proj/new_mod/42/media': [dirent('lua')],
                '/proj/new_mod/42/media/lua': [dirent('client')],
                '/proj/new_mod/42/media/lua/client': [dirent('old_mod_patch')],
                '/proj/new_mod/42/media/lua/client/old_mod_patch': [],
            };
            return entries[norm(dir)] ?? [];
        });
        vi.mocked(fs.existsSync).mockImplementation((p: any) => {
            return norm(p).endsWith('/old_mod') || norm(p).endsWith('_patch');
        });

        renameCmd('old_mod', 'new_mod');

        const nested = join(
            '/proj',
            'new_mod/42/media/lua/client/old_mod_patch',
        );
        expect(fs.existsSync(nested)).toBe(true);
        expect(fs.renameSync).not.toHaveBeenCalled();
        expect(
            vi.mocked(logger.warn).mock.calls.map(([message]) => norm(message)),
        ).toContain(
            "subdirectory '/proj/new_mod/42/media/lua/client/old_mod_patch' still carries the old mod id 'old_mod'",
        );
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
        const warned = vi
            .mocked(logger.warn)
            .mock.calls.map(([message]) => norm(message));
        expect(
            warned.filter(
                (message) =>
                    message.includes('docs') || message.includes('poster.png'),
            ),
        ).toEqual([]);
    });

    it('never warns for or touches a link entry (junctions/symlinks are user state)', () => {
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

        expect(fs.existsSync(join('/proj', 'new_mod/media/lua/old_mod'))).toBe(
            true,
        );
        expect(fs.renameSync).not.toHaveBeenCalled();
        const warned = vi
            .mocked(logger.warn)
            .mock.calls.map(([message]) => norm(message));
        expect(
            warned.filter((message) =>
                message.includes('/proj/new_mod/media/lua/old_mod'),
            ),
        ).toEqual([]);
    });

    it('completes the core rename and exits 0 while old-id subdirectories survive with warns', () => {
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

        expect(() => renameCmd('old_mod', 'new_mod')).not.toThrow();

        expect(fs.renameSync).not.toHaveBeenCalled();
        expect(
            vi.mocked(logger.warn).mock.calls.map(([message]) => norm(message)),
        ).toContain(
            "subdirectory '/proj/new_mod/media/lua/server/old_mod' still carries the old mod id 'old_mod'",
        );
        expect(updateProjectConfig).toHaveBeenCalled();
    });

    it('dry-run previews Would warn lines and changes nothing on disk', () => {
        setInvocationOptions({ yes: true, 'dry-run': true });
        vi.mocked(fs.readFileSync).mockReturnValue('' as any);
        vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
            const entries: Record<string, any[]> = {
                '/proj/old_mod': [dirent('media')],
                '/proj/old_mod/media': [dirent('lua')],
                '/proj/old_mod/media/lua': [dirent('server')],
                '/proj/old_mod/media/lua/server': [dirent('old_mod')],
                '/proj/old_mod/media/lua/server/old_mod': [],
            };
            return entries[norm(dir)] ?? [];
        });

        renameCmd('old_mod', 'new_mod');

        const output = vi
            .mocked(logger.log)
            .mock.calls.map(([message]) => norm(message));
        expect(output).toContain(
            "Would warn: subdirectory '/proj/old_mod/media/lua/server/old_mod' still carries the old mod id 'old_mod'",
        );
        expect(
            output.filter((message) =>
                message.includes('Would: rename subdirectory'),
            ),
        ).toEqual([]);
        expect(fs.renameSync).not.toHaveBeenCalled();
        expect(fs.writeFileSync).not.toHaveBeenCalled();
        expect(fs.rmSync).not.toHaveBeenCalled();
        expect(scaffoldProject).not.toHaveBeenCalled();
        expect(updateProjectConfig).not.toHaveBeenCalled();
    });
});
