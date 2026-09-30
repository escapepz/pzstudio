import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import fs from 'fs';
import { migrateCmd } from '../../packages/cli/src/lib/commands/migrate';
import {
    findProjectDir,
    resolveModInfoTargets,
    updateProjectConfig,
} from '../../packages/cli/src/lib/helper';
import {
    getConfigPath,
    writeGlobalConfig,
} from '../../packages/cli/src/lib/templateManager';

vi.mock('fs');
vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/templateManager');
vi.mock('../../packages/cli/src/lib/helper', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../packages/cli/src/lib/helper')
    >()),
    findProjectDir: vi.fn(),
    resolveModInfoTargets: vi.fn(),
    updateProjectConfig: vi.fn(),
}));

const CONFIG_PATH = '/pz/config.json';
const PROJECT_PATH = join('/proj', 'project.json');

/** Reads each mocked file by its normalized path suffix. */
function mockFiles(files: Record<string, string>, existing: string[]) {
    const existingSuffixes = existing.map((suffix) =>
        suffix.replace(/\\/g, '/'),
    );
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const normalized = String(p).replace(/\\/g, '/');
        return existingSuffixes.some((suffix) => normalized.endsWith(suffix));
    });
    vi.mocked(fs.readFileSync).mockImplementation(((p: any) => {
        const normalized = String(p).replace(/\\/g, '/');
        const match = Object.entries(files).find(([suffix]) =>
            normalized.endsWith(suffix),
        );
        if (!match) throw new Error(`Unexpected read: ${normalized}`);
        return match[1];
    }) as any);
}

describe('migrateCmd', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(findProjectDir).mockReturnValue('/proj' as any);
        vi.mocked(getConfigPath).mockReturnValue(CONFIG_PATH as any);
        vi.mocked(writeGlobalConfig).mockReturnValue(undefined as any);
        vi.mocked(updateProjectConfig).mockReturnValue(undefined as any);
        vi.mocked(resolveModInfoTargets).mockReturnValue([] as any);
    });

    describe('config.json migration', () => {
        it('should upgrade a legacy config and write it', async () => {
            mockFiles({ 'config.json': '{}' }, [CONFIG_PATH]);

            await migrateCmd();

            expect(writeGlobalConfig).toHaveBeenCalledTimes(1);
            const upgraded = vi.mocked(writeGlobalConfig).mock
                .calls[0][0] as any;
            expect(upgraded.useSymlinks).toBe(true);
            expect(upgraded.templates).toBeDefined();
            expect(upgraded.outdir).toBeDefined();
        });

        it('should treat an empty config.json as an empty object', async () => {
            mockFiles({ 'config.json': '' }, [CONFIG_PATH]);

            await migrateCmd();

            expect(writeGlobalConfig).toHaveBeenCalledTimes(1);
        });

        it('should leave an up-to-date config untouched', async () => {
            mockFiles(
                {
                    'config.json': JSON.stringify({
                        useSymlinks: true,
                        templates: { project: 'user/repo' },
                        outdir: '/games',
                    }),
                },
                [CONFIG_PATH],
            );

            await migrateCmd();

            expect(writeGlobalConfig).not.toHaveBeenCalled();
        });

        it('should fail with a friendly error on corrupt JSON', async () => {
            mockFiles({ 'config.json': '{invalid' }, [CONFIG_PATH]);

            await expect(migrateCmd()).rejects.toThrow(
                /Failed to parse '.*config\.json'[\s\S]*run 'pzstudio migrate' again/,
            );
        });
    });

    describe('project.json migration', () => {
        it('should upgrade legacy root fields into the workshop section', async () => {
            mockFiles(
                {
                    'config.json': JSON.stringify({
                        useSymlinks: true,
                        templates: {},
                        outdir: '/games',
                    }),
                    'project.json': JSON.stringify({
                        id: 'm1',
                        title: 'T',
                        authors: ['a'],
                        mods: { m1: { name: 'M' } },
                    }),
                },
                [CONFIG_PATH, PROJECT_PATH],
            );

            await migrateCmd();

            expect(updateProjectConfig).toHaveBeenCalledTimes(1);
            const [path, upgraded, overwrite] = vi.mocked(updateProjectConfig)
                .mock.calls[0] as any[];
            expect(path).toBe(PROJECT_PATH);
            expect(overwrite).toBe(true);
            expect(upgraded.workshop.id).toBe('m1');
            expect(upgraded.workshop.title).toBe('T');
            expect(upgraded.id).toBeUndefined();
            expect(upgraded.title).toBeUndefined();
            expect(upgraded.authors).toBeUndefined();
            expect(upgraded.excludes).toEqual([]);
        });

        it('should report when no project.json exists', async () => {
            mockFiles(
                {
                    'config.json': JSON.stringify({
                        useSymlinks: true,
                        templates: {},
                        outdir: '/games',
                    }),
                },
                [CONFIG_PATH],
            );

            await migrateCmd();

            expect(updateProjectConfig).not.toHaveBeenCalled();
        });
    });

    describe('mod.info sync', () => {
        const upToDateConfig = JSON.stringify({
            useSymlinks: true,
            templates: {},
            outdir: '/games',
        });
        const project = {
            workshop: { title: 'T' },
            mods: {
                m1: { name: 'Old Name', description: 'Existing' },
            },
            excludes: [],
        };
        const modInfo =
            'name=New Name\nid=m1\ndescription=New Desc\nauthor=Someone';

        beforeEach(() => {
            mockFiles(
                {
                    'config.json': upToDateConfig,
                    'project.json': JSON.stringify(project),
                    'mod.info': modInfo,
                },
                [CONFIG_PATH, PROJECT_PATH, '/m1/mod.info'],
            );
        });

        it('should import only missing fields and never overwrite or sync the id', async () => {
            await migrateCmd();

            expect(updateProjectConfig).toHaveBeenCalledTimes(1);
            const [path, updated, overwrite] = vi.mocked(updateProjectConfig)
                .mock.calls[0] as any[];
            expect(path).toBe(PROJECT_PATH);
            expect(overwrite).toBe(true);
            expect(updated.mods.m1.name).toBe('Old Name');
            expect(updated.mods.m1.description).toBe('Existing');
            expect(updated.mods.m1.author).toBe('Someone');
        });

        it('should prefer the root mod.info over branch folders', async () => {
            vi.mocked(resolveModInfoTargets).mockReturnValue([
                '/proj/m1/42_branch',
            ] as any);

            await migrateCmd();

            expect(resolveModInfoTargets).not.toHaveBeenCalled();
        });

        it('should stop after the first branch folder that was modified', async () => {
            vi.mocked(fs.existsSync).mockImplementation((p: any) => {
                const normalized = String(p).replace(/\\/g, '/');
                return (
                    normalized.endsWith('config.json') ||
                    normalized.endsWith('project.json') ||
                    normalized.endsWith('/m1/branch_a/mod.info') ||
                    normalized.endsWith('/m1/branch_b/mod.info')
                );
            });
            vi.mocked(fs.readFileSync).mockImplementation(((p: any) => {
                const normalized = String(p).replace(/\\/g, '/');
                if (normalized.endsWith('config.json')) return upToDateConfig;
                if (normalized.endsWith('project.json'))
                    return JSON.stringify(project);
                if (normalized.endsWith('mod.info')) return modInfo;
                throw new Error(`Unexpected read: ${normalized}`);
            }) as any);
            vi.mocked(resolveModInfoTargets).mockReturnValue([
                '/proj/m1/branch_a',
                '/proj/m1/branch_b',
            ] as any);

            await migrateCmd();

            const branchReads = vi
                .mocked(fs.readFileSync)
                .mock.calls.filter((call) =>
                    String(call[0]).replace(/\\/g, '/').includes('branch_'),
                );
            expect(branchReads).toHaveLength(1);
            expect(String(branchReads[0][0]).replace(/\\/g, '/')).toContain(
                'branch_a',
            );
        });
    });
});
