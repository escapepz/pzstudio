import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { newCmd } from '../../src/lib/commands/new';
import {
    projectDir,
    readProjectConfig,
    resolveProjectConfig,
    updateProjectConfig,
    updateExperimentalScripts,
} from '../../src/lib/helper';
import {
    resolveTemplateDir,
    readGlobalConfig,
    scaffoldProject,
    scaffoldTemplateFolder,
} from '../../src/lib/templateManager';
import { hasFlag, extractFlag } from '../../src/lib/args';

vi.mock('fs');
vi.mock('../../src/lib/logger');
vi.mock('../../src/lib/args');
vi.mock('../../src/lib/templateManager');
vi.mock('../../src/lib/helper', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/lib/helper')>()),
    projectDir: vi.fn(),
    readProjectConfig: vi.fn(),
    resolveProjectConfig: vi.fn(),
    updateProjectConfig: vi.fn(),
    updateExperimentalScripts: vi.fn(),
}));

describe('newCmd --path (issue #43)', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        vi.mocked(hasFlag).mockReturnValue(false);
        vi.mocked(extractFlag).mockReturnValue(undefined);
        vi.mocked(projectDir).mockReturnValue(path.resolve('/cwd') as any);
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

        expect(scaffoldProject).toHaveBeenCalledWith(
            '/tpl/project',
            path.join(path.resolve('/dest/projects'), 'my_mod'),
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

        expect(scaffoldProject).toHaveBeenCalledWith(
            '/tpl/project',
            path.join(path.resolve('/cwd'), 'my_mod'),
            false,
            false,
            expect.anything(),
        );
    });
});
