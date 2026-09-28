import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import fs from 'fs';
import { deleteCmd } from '../../packages/cli/src/lib/commands/delete';
import {
    projectDir,
    resolveProjectConfig,
    updateProjectConfig,
    updateExperimentalScripts,
} from '../../packages/cli/src/lib/helper';

vi.mock('fs');
vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/helper', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../packages/cli/src/lib/helper')
    >()),
    projectDir: vi.fn(),
    resolveProjectConfig: vi.fn(),
    updateProjectConfig: vi.fn(),
    updateExperimentalScripts: vi.fn(),
}));

describe('deleteCmd', () => {
    const project = {
        workshop: { title: 'Test', visibility: 'public', tags: [] },
        mods: {
            old_mod: { name: 'Old', description: 'd' },
            kept_mod: { name: 'Kept', description: 'd' },
        },
        excludes: ['old_mod', 'kept_mod'],
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(projectDir).mockReturnValue('/proj' as any);
        // Fresh copy per call: deleteCmd mutates the config it receives
        vi.mocked(resolveProjectConfig).mockImplementation(
            () => JSON.parse(JSON.stringify(project)) as any,
        );
        vi.mocked(updateProjectConfig).mockReturnValue(undefined as any);
        vi.mocked(updateExperimentalScripts).mockReturnValue(undefined as any);

        // Only the old mod directory "exists" (normalize separators: join()
        // produces backslashes on Windows)
        vi.mocked(fs.existsSync).mockImplementation((p: any) => {
            return String(p).replace(/\\/g, '/').endsWith('/old_mod');
        });
    });

    it('should delete the mod directory and remove the entry from project.json', () => {
        deleteCmd('old_mod');

        expect(fs.rmSync).toHaveBeenCalledWith(join('/proj', 'old_mod'), {
            force: true,
            recursive: true,
        });

        expect(updateProjectConfig).toHaveBeenCalledWith(
            join('/proj', 'project.json'),
            expect.objectContaining({
                mods: expect.objectContaining({
                    kept_mod: expect.anything(),
                }),
            }),
        );
        const updated = vi.mocked(updateProjectConfig).mock.calls[0][1] as any;
        expect(updated.mods.old_mod).toBeUndefined();
        expect(updated.excludes).toEqual(['kept_mod']);

        expect(updateExperimentalScripts).toHaveBeenCalledWith(
            'removeMod',
            '/proj',
            'old_mod',
        );
    });

    it('should throw when the mod is unknown to the project', () => {
        expect(() => deleteCmd('missing_mod')).toThrow(
            "Mod 'missing_mod' not found in project.json!",
        );
        expect(fs.rmSync).not.toHaveBeenCalled();
        expect(updateProjectConfig).not.toHaveBeenCalled();
    });

    it('should still update project.json when the directory is missing', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false as any);

        deleteCmd('old_mod');

        expect(fs.rmSync).not.toHaveBeenCalled();
        expect(updateProjectConfig).toHaveBeenCalledTimes(1);
        expect(updateExperimentalScripts).toHaveBeenCalledTimes(1);
    });

    it('should reject a non-string mod id', () => {
        expect(() => deleteCmd(12345 as any)).toThrow(
            "Expected param [modId] to be 'string', but got 'number'",
        );
    });
});
