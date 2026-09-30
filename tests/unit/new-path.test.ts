import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { newCmd } from '../../packages/cli/src/lib/commands/new';
import {
    discoveryStartDir,
    findProjectDir,
    readProjectConfig,
    resolveProjectConfig,
    updateProjectConfig,
    updateExperimentalScripts,
    removeDirRecursive,
} from '../../packages/cli/src/lib/helper';
import {
    resolveTemplateDir,
    readGlobalConfig,
    scaffoldProject,
    scaffoldTemplateFolder,
} from '../../packages/cli/src/lib/templateManager';
import { hasFlag, extractFlag } from '../../packages/cli/src/lib/args';

vi.mock('fs');
vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/args');
vi.mock('../../packages/cli/src/lib/templateManager');
vi.mock('../../packages/cli/src/lib/helper', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../packages/cli/src/lib/helper')
    >()),
    discoveryStartDir: vi.fn(),
    findProjectDir: vi.fn(),
    readProjectConfig: vi.fn(),
    resolveProjectConfig: vi.fn(),
    updateProjectConfig: vi.fn(),
    updateExperimentalScripts: vi.fn(),
    removeDirRecursive: vi.fn(),
}));

describe('newCmd --path (issue #43)', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        vi.mocked(hasFlag).mockReturnValue(false);
        vi.mocked(extractFlag).mockReturnValue(undefined);
        vi.mocked(discoveryStartDir).mockReturnValue(
            path.resolve('/cwd') as any,
        );
        vi.mocked(findProjectDir).mockReturnValue(path.resolve('/cwd') as any);
        vi.mocked(resolveProjectConfig).mockReturnValue(undefined as any);
        vi.mocked(readGlobalConfig).mockReturnValue({
            useSymlinks: false,
        } as any);
        vi.mocked(resolveTemplateDir).mockImplementation(
            (category: any) => `/tpl/${category}` as any,
        );
        vi.mocked(scaffoldProject).mockReturnValue(undefined as any);
        vi.mocked(scaffoldTemplateFolder).mockReturnValue(undefined as any);
        vi.mocked(updateProjectConfig).mockReturnValue(undefined as any);
        vi.mocked(updateExperimentalScripts).mockReturnValue(undefined as any);
        vi.mocked(readProjectConfig).mockReturnValue({
            workshop: {},
            mods: {},
        } as any);
        vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('should create the project inside the --path directory instead of cwd', async () => {
        vi.mocked(extractFlag).mockReturnValue(
            path.resolve('/dest/projects') as any,
        );

        await newCmd('My Mod');

        // The scaffold targets a staging directory and the commit is a
        // same-volume rename onto the destination.
        const [stagingPath, destPath] = vi.mocked(fs.renameSync).mock
            .calls[0] as [string, string];
        expect(stagingPath).toContain('.my_mod.staging-');
        expect(path.dirname(String(stagingPath))).toBe(
            path.resolve('/dest/projects'),
        );
        expect(destPath).toBe(
            path.join(path.resolve('/dest/projects'), 'my_mod'),
        );
        expect(scaffoldProject).toHaveBeenCalledWith(
            '/tpl/project',
            stagingPath,
            false,
            false,
            expect.objectContaining({ ignoreItems: ['.libraries'] }),
        );
        // Never touches the cwd
        const cwdCalls = vi
            .mocked(scaffoldProject)
            .mock.calls.filter((c) =>
                String(c[1]).startsWith(path.resolve('/cwd')),
            );
        expect(cwdCalls).toHaveLength(0);
    });

    it('should bypass the "inside a project directory" guard when --path is given', async () => {
        vi.mocked(extractFlag).mockReturnValue(path.resolve('/dest') as any);
        vi.mocked(resolveProjectConfig).mockReturnValue({
            workshop: { title: 'Existing', visibility: 'public', tags: [] },
            mods: {},
        } as any);

        await expect(newCmd('My Mod')).resolves.not.toThrow();
    });

    it('should still refuse cwd creation when already inside a project', async () => {
        vi.mocked(resolveProjectConfig).mockReturnValue({
            workshop: { title: 'Existing', visibility: 'public', tags: [] },
            mods: {},
        } as any);

        await expect(newCmd('My Mod')).rejects.toThrow(
            'You cannot execute this command within a project directory!',
        );
    });

    it('should throw when the target project directory already exists', async () => {
        vi.mocked(extractFlag).mockReturnValue(path.resolve('/dest') as any);
        vi.mocked(fs.existsSync).mockImplementation(
            (p: any) =>
                String(p) === path.join(path.resolve('/dest'), 'my_mod'),
        );

        await expect(newCmd('My Mod')).rejects.toThrow(/already exists/);
    });

    it('should default to cwd when --path is absent (unchanged behavior)', async () => {
        await newCmd('My Mod');

        const [stagingPath, destPath] = vi.mocked(fs.renameSync).mock
            .calls[0] as [string, string];
        expect(stagingPath).toContain('.my_mod.staging-');
        expect(path.dirname(String(stagingPath))).toBe(path.resolve('/cwd'));
        expect(destPath).toBe(path.join(path.resolve('/cwd'), 'my_mod'));
        expect(scaffoldProject).toHaveBeenCalledWith(
            '/tpl/project',
            stagingPath,
            false,
            false,
            expect.anything(),
        );
    });

    it('should commit through a single rename and keep no staging on success', async () => {
        await newCmd('My Mod');

        expect(fs.renameSync).toHaveBeenCalledTimes(1);
        expect(removeDirRecursive).not.toHaveBeenCalled();
    });

    it('should roll back the staging directory and report no project on failure', async () => {
        vi.mocked(scaffoldProject).mockImplementation(() => {
            throw new Error('template resolution failed');
        });

        await expect(newCmd('My Mod')).rejects.toThrow(
            'No project was created.',
        );

        // The staging directory was removed and nothing was committed.
        expect(removeDirRecursive).toHaveBeenCalledTimes(1);
        const [stagingPath] = vi.mocked(removeDirRecursive).mock.calls[0];
        expect(String(stagingPath)).toContain('.my_mod.staging-');
        expect(fs.renameSync).not.toHaveBeenCalled();
    });
});
