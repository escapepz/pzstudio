import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import fs from 'fs';
import * as logger from '../../packages/cli/src/lib/logger';
import { renameCmd } from '../../packages/cli/src/lib/commands/rename';
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
    });

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
});
