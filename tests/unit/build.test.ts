import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import * as logger from '../../packages/cli/src/lib/logger';
import { buildCmd } from '../../packages/cli/src/lib/commands/build';
import {
    gatherPlanInput,
    projectDir,
    readWorkshopDescriptionLines,
    resolveModInfoTargets,
    resolveProjectConfig,
} from '../../packages/cli/src/lib/helper';
import {
    scaffoldProject,
    resolveTemplateDir,
} from '../../packages/cli/src/lib/templateManager';
import { hasFlag } from '../../packages/cli/src/lib/args';

// The real helper implementation, outside the module mock: tests that mock
// gatherPlanInput must restore the delegate so overrides cannot leak.
const actualHelper = await vi.importActual<
    typeof import('../../packages/cli/src/lib/helper')
>('../../packages/cli/src/lib/helper');

vi.mock('fs');
vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/templateManager');
vi.mock('../../packages/cli/src/lib/args', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../packages/cli/src/lib/args')
    >()),
    hasFlag: vi.fn(),
}));
vi.mock('../../packages/cli/src/lib/helper', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('../../packages/cli/src/lib/helper')
        >();
    return {
        ...actual,
        projectDir: vi.fn(),
        resolveProjectConfig: vi.fn(),
        resolveModInfoTargets: vi.fn(),
        readWorkshopDescriptionLines: vi.fn(),
        // Delegates to the real implementation: most tests drive the real
        // snapshot logic through the fs mocks; branch-folder scenarios
        // override this mock with a hand-written plan input.
        gatherPlanInput: vi.fn(actual.gatherPlanInput),
    };
});

describe('buildCmd', () => {
    const project = {
        workshop: {
            id: 12345,
            title: 'Test Project',
            visibility: 'public',
            tags: [],
        },
        mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
        excludes: [],
        outdir: '/out',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // mockReturnValue values set by branch-folder tests must not leak
        // into the tests that drive the real snapshot logic.
        vi.mocked(gatherPlanInput).mockImplementation(
            actualHelper.gatherPlanInput,
        );
        vi.mocked(projectDir).mockReturnValue('/proj' as any);
        vi.mocked(resolveProjectConfig).mockImplementation(
            () => JSON.parse(JSON.stringify(project)) as any,
        );
        vi.mocked(scaffoldProject).mockReturnValue(undefined as any);
        vi.mocked(resolveTemplateDir).mockReturnValue(
            '/templates/workshop' as any,
        );
        vi.mocked(resolveModInfoTargets).mockReturnValue([] as any);
        vi.mocked(readWorkshopDescriptionLines).mockReturnValue([] as any);
        vi.mocked(hasFlag).mockReturnValue(false as any);

        // Only workshop/preview.png exists in the project root (normalize
        // separators: join() produces backslashes on Windows)
        vi.mocked(fs.existsSync).mockImplementation((p: any) => {
            return String(p)
                .replace(/\\/g, '/')
                .endsWith('/workshop/preview.png');
        });
    });

    it('should throw when executed outside of a project directory', async () => {
        vi.mocked(resolveProjectConfig).mockReturnValue(undefined as any);

        await expect(buildCmd()).rejects.toThrow('No pzstudio project found.');
    });

    it('should throw when both target flags are selected', async () => {
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'production' || name === 'development',
        );

        await expect(buildCmd()).rejects.toThrow(
            'Conflicting targets selected',
        );
    });

    it('should plan and execute a main build by default', async () => {
        await buildCmd();

        expect(fs.rmSync).toHaveBeenCalledWith(
            expect.stringContaining('Test Project'),
            { recursive: true, force: true, maxRetries: 5, retryDelay: 200 },
        );
        expect(fs.mkdirSync).toHaveBeenCalledWith(
            expect.stringContaining('Test Project'),
            { recursive: true },
        );
        expect(scaffoldProject).toHaveBeenCalledWith(
            '/templates/workshop',
            expect.stringContaining('Test Project'),
            false,
            false,
            { excludeIgnoreFile: true, ignoreDotFiles: true },
        );
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringMatching(/my_mod\/mod\.info$/),
            expect.stringContaining('id=my_mod'),
        );
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringMatching(/Test Project\/workshop\.txt$/),
            expect.stringContaining('version=1'),
        );
        expect(fs.cpSync).toHaveBeenCalledWith(
            expect.stringMatching(/workshop\/preview\.png$/),
            expect.stringMatching(/Test Project\/preview\.png$/),
        );
    });

    it('should build only the dev variant with --development', async () => {
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'development',
        );

        await buildCmd();

        // One template copy: the dev output only
        const templateCopies = vi
            .mocked(scaffoldProject)
            .mock.calls.filter((call) => call[0] === '/templates/workshop');
        expect(templateCopies).toHaveLength(1);
        expect(templateCopies[0][1]).toContain('Test Project - dev_branch');
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringMatching(
                /dev_branch\/Contents\/mods\/my_mod_dev\/mod\.info$/,
            ),
            expect.stringContaining('id=my_mod_dev'),
        );
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringMatching(/dev_branch\/workshop\.txt$/),
            expect.stringContaining('visibility=unlisted'),
        );
    });

    it('should build only the main output with --production', async () => {
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'production',
        );

        await buildCmd();

        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringMatching(/Test Project\/workshop\.txt$/),
            expect.anything(),
        );
        const workshopWrite = vi
            .mocked(fs.writeFileSync)
            .mock.calls.find((call) =>
                String(call[0]).replace(/\\/g, '/').endsWith('workshop.txt'),
            );
        expect(workshopWrite?.[1]).not.toContain('dev_branch');
    });

    it('should generate mod.info in branch folders from the source snapshot', async () => {
        vi.mocked(gatherPlanInput).mockReturnValue({
            config: JSON.parse(JSON.stringify(project)),
            workshopTemplateDir: '/templates/workshop',
            projectDir: '/proj',
            modSourceStates: {
                my_mod: {
                    branchFolders: ['42_branch'],
                    modInfoExists: { '': true, '42_branch': false },
                    modInfoContent: { '': 'id=my_mod\n' },
                },
            },
            descriptionLines: [],
            previewPngExists: true,
        } as any);

        await buildCmd();

        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringMatching(/my_mod\/42_branch\/mod\.info$/),
            expect.stringContaining('id=my_mod'),
        );
    });

    it('should skip mod.info generation when the snapshot says it exists', async () => {
        vi.mocked(gatherPlanInput).mockReturnValue({
            config: JSON.parse(JSON.stringify(project)),
            workshopTemplateDir: '/templates/workshop',
            projectDir: '/proj',
            modSourceStates: {
                my_mod: {
                    branchFolders: ['42_branch'],
                    modInfoExists: { '': false, '42_branch': true },
                    modInfoContent: {
                        '42_branch': 'id=my_mod\nname=My Mod\n',
                    },
                },
            },
            descriptionLines: [],
            previewPngExists: true,
        } as any);

        await buildCmd();

        const modInfoWrite = vi
            .mocked(fs.writeFileSync)
            .mock.calls.find((call) =>
                String(call[0]).replace(/\\/g, '/').endsWith('mod.info'),
            );
        expect(modInfoWrite).toBeUndefined();
        expect(logger.log).toHaveBeenCalledWith(
            expect.stringContaining(
                'already exists, build.modInfo: "auto-if-missing"',
            ),
        );
    });

    it('should rewrite the id of an existing mod.info in the dev output', async () => {
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'development',
        );
        vi.mocked(fs.existsSync).mockImplementation((p: any) => {
            const normalized = String(p).replace(/\\/g, '/');
            return (
                normalized.endsWith('/workshop/preview.png') ||
                normalized.endsWith('/my_mod/mod.info')
            );
        });
        vi.mocked(fs.readFileSync).mockReturnValue(
            'id=my_mod\nname=My Mod\nposter=poster.png\n' as any,
        );

        await buildCmd();

        const modInfoWrite = vi
            .mocked(fs.writeFileSync)
            .mock.calls.find((call) =>
                String(call[0])
                    .replace(/\\/g, '/')
                    .endsWith('dev_branch/Contents/mods/my_mod_dev/mod.info'),
            );
        expect(modInfoWrite?.[1]).toBe(
            'id=my_mod_dev\nname=My Mod\nposter=poster.png\n',
        );
    });

    it('should keep an existing mod.info verbatim in the main output', async () => {
        vi.mocked(fs.existsSync).mockImplementation((p: any) => {
            const normalized = String(p).replace(/\\/g, '/');
            return (
                normalized.endsWith('/workshop/preview.png') ||
                normalized.endsWith('/my_mod/mod.info')
            );
        });
        vi.mocked(fs.readFileSync).mockReturnValue(
            'id=my_mod\nname=My Mod\n' as any,
        );

        await buildCmd();

        const modInfoWrite = vi
            .mocked(fs.writeFileSync)
            .mock.calls.find((call) =>
                String(call[0]).replace(/\\/g, '/').endsWith('mod.info'),
            );
        expect(modInfoWrite).toBeUndefined();
        expect(logger.log).toHaveBeenCalledWith(
            expect.stringContaining(
                'already exists, build.modInfo: "auto-if-missing"',
            ),
        );
    });

    it('should skip the main build and warn when all mods are dev-only', async () => {
        vi.mocked(resolveProjectConfig).mockImplementation(
            () =>
                JSON.parse(
                    JSON.stringify({
                        ...project,
                        mods: {
                            my_mod: {
                                name: 'My Mod',
                                description: 'A mod.',
                                build: { devOnly: true },
                            },
                        },
                    }),
                ) as any,
        );

        await buildCmd();

        // Nothing may touch the output: the previous build must survive.
        expect(fs.rmSync).not.toHaveBeenCalled();
        expect(fs.mkdirSync).not.toHaveBeenCalled();
        expect(scaffoldProject).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                'nothing to build for the main workshop output',
            ),
        );
    });

    it('should warn about dev-only mods skipped in a partial main build', async () => {
        vi.mocked(resolveProjectConfig).mockImplementation(
            () =>
                JSON.parse(
                    JSON.stringify({
                        ...project,
                        mods: {
                            mod_a: { name: 'A', description: 'd' },
                            mod_b: {
                                name: 'B',
                                description: 'd',
                                build: { devOnly: true },
                            },
                        },
                    }),
                ) as any,
        );

        await buildCmd();

        expect(fs.rmSync).toHaveBeenCalledWith(
            expect.stringContaining('Test Project'),
            { recursive: true, force: true, maxRetries: 5, retryDelay: 200 },
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                'Dev-only mods skipped in the main build: mod_b',
            ),
        );
    });

    it('should skip the dev build and warn when all mods are excluded', async () => {
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'development',
        );
        vi.mocked(resolveProjectConfig).mockImplementation(
            () =>
                JSON.parse(
                    JSON.stringify({ ...project, excludes: ['my_mod'] }),
                ) as any,
        );

        await buildCmd();

        expect(scaffoldProject).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                'nothing to build for the dev_branch workshop output',
            ),
        );
    });

    it('should build both outputs with --both', async () => {
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'both',
        );

        await buildCmd();

        const templateCopies = vi
            .mocked(scaffoldProject)
            .mock.calls.filter((call) => call[0] === '/templates/workshop');
        expect(templateCopies).toHaveLength(2);
        expect(templateCopies[0][1]).toContain('Test Project');
        expect(templateCopies[1][1]).toContain('Test Project - dev_branch');
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringMatching(/Test Project\/workshop\.txt$/),
            expect.anything(),
        );
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringMatching(/dev_branch\/workshop\.txt$/),
            expect.anything(),
        );
    });

    it('should build both outputs from project.json build.target without flags', async () => {
        vi.mocked(resolveProjectConfig).mockImplementation(
            () =>
                JSON.parse(
                    JSON.stringify({ ...project, build: { target: 'both' } }),
                ) as any,
        );

        await buildCmd();

        const templateCopies = vi
            .mocked(scaffoldProject)
            .mock.calls.filter((call) => call[0] === '/templates/workshop');
        expect(templateCopies).toHaveLength(2);
    });

    it('should let an explicit flag override project.json build.target', async () => {
        vi.mocked(resolveProjectConfig).mockImplementation(
            () =>
                JSON.parse(
                    JSON.stringify({ ...project, build: { target: 'both' } }),
                ) as any,
        );
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'production',
        );

        await buildCmd();

        const templateCopies = vi
            .mocked(scaffoldProject)
            .mock.calls.filter((call) => call[0] === '/templates/workshop');
        expect(templateCopies).toHaveLength(1);
        expect(templateCopies[0][1]).not.toContain('dev_branch');
    });

    it('should build only the dev output from project.json build.target=development', async () => {
        vi.mocked(resolveProjectConfig).mockImplementation(
            () =>
                JSON.parse(
                    JSON.stringify({
                        ...project,
                        build: { target: 'development' },
                    }),
                ) as any,
        );

        await buildCmd();

        const templateCopies = vi
            .mocked(scaffoldProject)
            .mock.calls.filter((call) => call[0] === '/templates/workshop');
        expect(templateCopies).toHaveLength(1);
        expect(templateCopies[0][1]).toContain('Test Project - dev_branch');
    });

    it('should throw when --both is combined with another target flag', async () => {
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'both' || name === 'production',
        );

        await expect(buildCmd()).rejects.toThrow(
            'Conflicting targets selected: --both',
        );
    });

    it('should still build the dev output when the main output is locked', async () => {
        // First rmSync call is the main variant's removeDir: simulate a lock.
        vi.mocked(fs.rmSync).mockImplementationOnce(() => {
            const e = new Error('not empty') as NodeJS.ErrnoException;
            e.code = 'ENOTEMPTY';
            throw e;
        });
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'both',
        );

        await expect(buildCmd()).rejects.toThrow(
            "Cannot delete '/out/Test Project' — the folder is in use by another program",
        );

        // The dev variant was still planned and executed.
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringMatching(/dev_branch\/workshop\.txt$/),
            expect.anything(),
        );
    });
});
