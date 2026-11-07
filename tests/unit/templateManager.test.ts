import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as templateManager from '../../packages/cli/src/lib/templateManager';
import * as helper from '../../packages/cli/src/lib/helper';
import {
    createIgnoreFilter,
    readGlobalConfig,
    resolveTemplateDir,
    getConfigPath,
} from '../../packages/cli/src/lib/templateManager';
import fs, { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import * as logger from '../../packages/cli/src/lib/logger';

vi.mock('../../packages/cli/src/lib/logger');
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    const mocks = {
        existsSync: vi.fn(actual.existsSync),
        readFileSync: vi.fn(actual.readFileSync),
        lstatSync: vi.fn(actual.lstatSync),
        readdirSync: vi.fn(actual.readdirSync),
        rmSync: vi.fn(actual.rmSync),
        mkdirSync: vi.fn(actual.mkdirSync),
        writeFileSync: vi.fn(actual.writeFileSync),
        cpSync: vi.fn(actual.cpSync),
    };
    return {
        ...actual,
        ...mocks,
        default: {
            ...actual.default,
            ...mocks,
        },
    };
});

describe('templateManager - createIgnoreFilter', () => {
    let tmpRoot: string;
    let actualFs: any;

    beforeEach(async () => {
        vi.restoreAllMocks();
        // createIgnoreFilter needs a real directory for relative() and dirname()
        actualFs = await vi.importActual('fs');
        tmpRoot = actualFs.mkdtempSync(join(tmpdir(), 'pzstudio-test-'));

        vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
            actualFs.existsSync(p),
        );
        vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, e: any) =>
            actualFs.readFileSync(p, e)) as any);
        vi.spyOn(fs, 'lstatSync').mockImplementation((p) =>
            actualFs.lstatSync(p),
        );
    });

    afterEach(async () => {
        if (tmpRoot && actualFs) {
            actualFs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('T006 - filters literal files correctly based on .pzstudioignore', () => {
        actualFs.writeFileSync(
            join(tmpRoot, '.pzstudioignore'),
            'ignored-file.txt\n',
        );
        actualFs.writeFileSync(join(tmpRoot, 'ignored-file.txt'), 'test');
        actualFs.writeFileSync(join(tmpRoot, 'kept-file.txt'), 'test');

        const filter = createIgnoreFilter(tmpRoot);

        expect(filter(join(tmpRoot, 'ignored-file.txt'), '')).toBe(false);
        expect(filter(join(tmpRoot, 'kept-file.txt'), '')).toBe(true);
    });
    it('T006 - filters literal folders correctly based on .pzstudioignore', () => {
        actualFs.writeFileSync(
            join(tmpRoot, '.pzstudioignore'),
            'ignored-folder\n',
        );
        actualFs.mkdirSync(join(tmpRoot, 'ignored-folder'));
        actualFs.writeFileSync(
            join(tmpRoot, 'ignored-folder', 'file.txt'),
            'test',
        );

        const filter = createIgnoreFilter(tmpRoot);

        expect(filter(join(tmpRoot, 'ignored-folder'), '')).toBe(false);
        expect(filter(join(tmpRoot, 'ignored-folder', 'file.txt'), '')).toBe(
            false,
        );

        actualFs.mkdirSync(join(tmpRoot, 'kept-folder'));
        expect(filter(join(tmpRoot, 'kept-folder'), '')).toBe(true);
    });

    it('T008 - non-matching literals, whitespace handling', () => {
        actualFs.writeFileSync(
            join(tmpRoot, '.pzstudioignore'),
            '  spaced-file.txt  \n\n',
        );
        actualFs.writeFileSync(join(tmpRoot, 'spaced-file.txt'), 'test');
        actualFs.writeFileSync(join(tmpRoot, 'other-file.txt'), 'test');

        const filter = createIgnoreFilter(tmpRoot);

        expect(filter(join(tmpRoot, 'spaced-file.txt'), '')).toBe(false);
        expect(filter(join(tmpRoot, 'other-file.txt'), '')).toBe(true);
    });

    it('T008 - folder-prefix matching with explicit trailing slash', () => {
        actualFs.writeFileSync(
            join(tmpRoot, '.pzstudioignore'),
            'my-folder/\n',
        );
        actualFs.mkdirSync(join(tmpRoot, 'my-folder'));
        actualFs.writeFileSync(join(tmpRoot, 'my-folder', 'file.txt'), 'test');

        const filter = createIgnoreFilter(tmpRoot);

        expect(filter(join(tmpRoot, 'my-folder'), '')).toBe(false);
        expect(filter(join(tmpRoot, 'my-folder', 'file.txt'), '')).toBe(false);
    });

    it('T008 - long-path stability', () => {
        actualFs.writeFileSync(
            join(tmpRoot, '.pzstudioignore'),
            'deep/nested/folder\n',
        );
        actualFs.mkdirSync(join(tmpRoot, 'deep'));
        actualFs.mkdirSync(join(tmpRoot, 'deep', 'nested'));
        actualFs.mkdirSync(join(tmpRoot, 'deep', 'nested', 'folder'));
        actualFs.writeFileSync(
            join(tmpRoot, 'deep', 'nested', 'folder', 'file.txt'),
            'test',
        );

        const filter = createIgnoreFilter(tmpRoot);

        expect(filter(join(tmpRoot, 'deep'), '')).toBe(true);
        expect(filter(join(tmpRoot, 'deep', 'nested'), '')).toBe(true);
        expect(filter(join(tmpRoot, 'deep', 'nested', 'folder'), '')).toBe(
            false,
        );
        expect(
            filter(join(tmpRoot, 'deep', 'nested', 'folder', 'file.txt'), ''),
        ).toBe(false);
    });

    it('T010 - built-in exclusions', () => {
        actualFs.mkdirSync(join(tmpRoot, '.git'));
        actualFs.writeFileSync(join(tmpRoot, '.git', 'config'), 'test');
        actualFs.writeFileSync(join(tmpRoot, '.gitmodules'), 'test');
        actualFs.writeFileSync(join(tmpRoot, '.gitkeep'), 'test');
        actualFs.mkdirSync(join(tmpRoot, '.github'));
        actualFs.writeFileSync(
            join(tmpRoot, '.github', 'workflows.yml'),
            'test',
        );

        const filter = createIgnoreFilter(tmpRoot);

        expect(filter(join(tmpRoot, '.git'), '')).toBe(false);
        expect(filter(join(tmpRoot, '.git', 'config'), '')).toBe(false);
        expect(filter(join(tmpRoot, '.gitmodules'), '')).toBe(false);
        expect(filter(join(tmpRoot, '.gitkeep'), '')).toBe(false);
        expect(filter(join(tmpRoot, '.github'), '')).toBe(false);
        expect(filter(join(tmpRoot, '.github', 'workflows.yml'), '')).toBe(
            false,
        );
    });

    it('T010 - nested .pzstudioignore resolves to closest', () => {
        actualFs.writeFileSync(
            join(tmpRoot, '.pzstudioignore'),
            'root-ignored\n',
        );
        actualFs.mkdirSync(join(tmpRoot, 'subfolder'));
        actualFs.writeFileSync(
            join(tmpRoot, 'subfolder', '.pzstudioignore'),
            'sub-ignored\n',
        );

        actualFs.writeFileSync(join(tmpRoot, 'root-ignored'), 'test');
        actualFs.writeFileSync(
            join(tmpRoot, 'subfolder', 'root-ignored'),
            'test',
        );
        actualFs.writeFileSync(
            join(tmpRoot, 'subfolder', 'sub-ignored'),
            'test',
        );

        const filter = createIgnoreFilter(tmpRoot);

        // At root
        expect(filter(join(tmpRoot, 'root-ignored'), '')).toBe(false);
        // At subfolder (since subfolder/.pzstudioignore doesn't ignore 'root-ignored')
        expect(filter(join(tmpRoot, 'subfolder', 'root-ignored'), '')).toBe(
            true,
        );
        // At subfolder, ignored by subfolder
        expect(filter(join(tmpRoot, 'subfolder', 'sub-ignored'), '')).toBe(
            false,
        );
    });
});

describe('templateManager - config and resolution', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe('readGlobalConfig', () => {
        it('should return defaults if config does not exist', () => {
            vi.spyOn(fs, 'existsSync').mockReturnValue(false);
            const config = readGlobalConfig();
            expect(config.templates).toBeDefined();
            expect(config.useSymlinks).toBe(true);
            expect(config.outdir).toBeDefined();
        });

        it('should normalize empty templates to defaults', () => {
            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(fs, 'readFileSync').mockReturnValue(
                JSON.stringify({ templates: {} }),
            );
            const config = readGlobalConfig();
            expect(config.templates.project).toBeDefined();
            expect(config.templates.project?.url).toContain(
                'pzstudio-template-project',
            );
        });

        it('should normalize missing useSymlinks to true', () => {
            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(fs, 'readFileSync').mockReturnValue(
                JSON.stringify({ templates: {} }),
            );
            const config = readGlobalConfig();
            expect(config.useSymlinks).toBe(true);
        });

        it('should treat an empty config file as missing keys', () => {
            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(fs, 'readFileSync').mockReturnValue('');
            const config = readGlobalConfig();
            expect(config.templates).toBeDefined();
            expect(config.useSymlinks).toBe(true);
            expect(config.outdir).toBeDefined();
        });

        it('should preserve existing user values', () => {
            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(fs, 'readFileSync').mockReturnValue(
                JSON.stringify({
                    templates: { project: { url: 'custom-url' } },
                    useSymlinks: false,
                    outdir: '/custom/out',
                }),
            );
            const config = readGlobalConfig();
            expect(config.templates.project?.url).toBe('custom-url');
            expect(config.templates.mod?.url).toContain(
                'pzstudio-template-mod',
            ); // Filled default
            expect(config.useSymlinks).toBe(false);
            expect(config.outdir).toBe('/custom/out');
        });
    });

    describe('resolveTemplateDir', () => {
        it('should resolve built-in workshop template', () => {
            // Cache-hit on the DEFAULT template url. The online path with
            // an empty cache would perform a real network clone, which a
            // unit test must never do.
            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(fs, 'lstatSync').mockReturnValue({
                isDirectory: () => true,
            } as any);
            vi.spyOn(fs, 'readdirSync').mockReturnValue(['.git'] as any);
            const path = resolveTemplateDir('workshop');
            expect(path).toContain('workshop');
        });

        it('should resolve built-in mod template', () => {
            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(fs, 'lstatSync').mockReturnValue({
                isDirectory: () => true,
            } as any);
            vi.spyOn(fs, 'readdirSync').mockReturnValue(['.git'] as any);
            const path = resolveTemplateDir('mod');
            expect(path).toContain('mod');
        });

        it('should resolve from global config if available', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    templates: { mod: { url: 'my-custom-url' } },
                }) as any,
            );
            vi.mocked(fs.lstatSync).mockReturnValue({
                isDirectory: () => true,
            } as any);
            vi.mocked(fs.readdirSync).mockReturnValue(['.git'] as any);

            const path = resolveTemplateDir('mod', true);
            expect(path).toContain('my-custom-url');
        });

        it('should throw if template cannot be resolved offline', () => {
            vi.spyOn(fs, 'existsSync').mockReturnValue(false);
            vi.spyOn(fs, 'readdirSync').mockReturnValue([] as any); // To make isDirNonEmpty return false for legacy
            expect(() => resolveTemplateDir('mod', true)).toThrow(
                'No valid cached or legacy template found',
            );
        });
        it('should ignore project-level template overrides and use global config', () => {
            const projectSpy = vi.spyOn(helper, 'resolveProjectConfig');

            // Mock global config to return a specific URL
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(
                JSON.stringify({
                    templates: { mod: { url: 'global-url' } },
                }) as any,
            );
            vi.mocked(fs.lstatSync).mockReturnValue({
                isDirectory: () => true,
            } as any);
            vi.mocked(fs.readdirSync).mockReturnValue(['.git'] as any);

            const path = resolveTemplateDir('mod', true);

            // Verify project config was never even consulted
            expect(projectSpy).not.toHaveBeenCalled();

            // Verify global config URL was used
            expect(path).toContain('global-url');
            expect(path).not.toContain('project-url');
        });
    });

    describe('migrateGlobalConfigIfNeeded', () => {
        it('should migrate legacy config.json and materialize defaults', () => {
            const configPath = getConfigPath();
            vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
                if (typeof p !== 'string') return false;
                return p.includes('config.json') || p.includes('.pzstudio');
            });
            // Use different values for different files to avoid collision
            vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
                if (String(p).includes('config.json'))
                    return JSON.stringify({ templates: {} });
                return 'backup-outdir';
            });
            const writeSpy = vi.spyOn(fs, 'writeFileSync');

            templateManager.migrateGlobalConfigIfNeeded();

            expect(writeSpy).toHaveBeenCalled();
            const lastCall =
                writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
            const written = JSON.parse(lastCall[1] as string);
            expect(written.useSymlinks).toBe(true);
            expect(written.templates.project).toBeDefined();
            expect(written.outdir).toBe('backup-outdir');
        });

        it('should preserve existing values during migration', () => {
            const configPath = getConfigPath();
            vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
                if (typeof p !== 'string') return false;
                return p.includes('config.json') || p.includes('.pzstudio');
            });
            vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
                if (String(p).includes('config.json'))
                    return JSON.stringify({
                        templates: { project: { url: 'old' } },
                        useSymlinks: false,
                    });
                return 'backup-outdir';
            });
            const writeSpy = vi.spyOn(fs, 'writeFileSync');

            templateManager.migrateGlobalConfigIfNeeded();

            expect(writeSpy).toHaveBeenCalled();
            const lastCall =
                writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
            const written = JSON.parse(lastCall[1] as string);
            expect(written.useSymlinks).toBe(false);
            expect(written.templates.project.url).toBe('old');
            expect(written.templates.mod).toBeDefined(); // Filled default
        });
    });
});

describe('templateManager - refreshLegacyTemplates', () => {
    let actualFs: any;
    let bundledDirs: string[] = [];

    const fakeHome = (): string =>
        (globalThis as any).__PZSTUDIO_FAKE_HOME as string;
    const globalLegacyDir = (): string =>
        join(fakeHome(), '.pzstudio', '.template-legacy');
    const stampPathIn = (dir: string): string =>
        join(dir, '.pzstudio-templates.json');

    // Task 1's build script (scripts/update-build-date.js) writes the stamp
    // as { version, buildDate } with a 4-space indent and trailing newline;
    // fixtures use the same shape.
    const stamp = (version: string, buildDate: string): string =>
        JSON.stringify({ version, buildDate }, null, 4) + '\n';

    /**
     * Builds a bundled .template-legacy fixture: .template-project/x.txt is
     * always present, the Task 1 stamp file when version+buildDate are.
     */
    function makeBundledLegacyDir(
        version?: string,
        buildDate?: string,
    ): string {
        const dir = actualFs.mkdtempSync(join(tmpdir(), 'pzstudio-bundled-'));
        actualFs.mkdirSync(join(dir, '.template-project'), {
            recursive: true,
        });
        actualFs.writeFileSync(
            join(dir, '.template-project', 'x.txt'),
            'template',
        );
        if (version !== undefined && buildDate !== undefined) {
            actualFs.writeFileSync(stampPathIn(dir), stamp(version, buildDate));
        }
        bundledDirs.push(dir);
        return dir;
    }

    function writeGlobalLegacyEntry(name: string, content: string): void {
        actualFs.mkdirSync(globalLegacyDir(), { recursive: true });
        actualFs.writeFileSync(join(globalLegacyDir(), name), content);
    }

    beforeEach(async () => {
        vi.restoreAllMocks();
        actualFs = await vi.importActual('fs');
        bundledDirs = [];
        // Vitest 4's restoreAllMocks also resets the vi.fn(actual.*)
        // wrappers this file's fs mock factory installed, so re-prime them:
        // C1-C6 verify real filesystem behavior through the module under
        // test, not mocks.
        vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync as any);
        vi.mocked(fs.readFileSync).mockImplementation(
            actualFs.readFileSync as any,
        );
        vi.mocked(fs.lstatSync).mockImplementation(actualFs.lstatSync as any);
        vi.mocked(fs.readdirSync).mockImplementation(
            actualFs.readdirSync as any,
        );
        vi.mocked(fs.mkdirSync).mockImplementation(actualFs.mkdirSync as any);
        vi.mocked(fs.writeFileSync).mockImplementation(
            actualFs.writeFileSync as any,
        );
        vi.mocked(fs.rmSync).mockImplementation(actualFs.rmSync as any);
        vi.mocked(fs.cpSync).mockImplementation(actualFs.cpSync as any);
        // vi.restoreAllMocks leaves call records on the auto-mocked logger
        // module fns (see helper.test.ts) — clear them for call isolation.
        vi.mocked(logger.emitInfo).mockClear();
        vi.mocked(logger.emitWarn).mockClear();
        vi.mocked(logger.emitVerbose).mockClear();
    });

    afterEach(() => {
        for (const dir of bundledDirs) {
            actualFs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('C1 - equal stamps: up-to-date, global dir untouched', () => {
        const bundled = makeBundledLegacyDir('v', 'b');
        writeGlobalLegacyEntry('.pzstudio-templates.json', stamp('v', 'b'));
        // The marker proves the up-to-date path never rewrites the cache.
        writeGlobalLegacyEntry('marker.txt', 'keep me');

        const status = templateManager.refreshLegacyTemplates(
            undefined,
            bundled,
        );

        expect(status).toBe('up-to-date');
        expect(logger.emitInfo).toHaveBeenCalledWith(
            undefined,
            'Legacy templates up to date.',
        );
        expect(actualFs.existsSync(join(globalLegacyDir(), 'marker.txt'))).toBe(
            true,
        );
    });

    it('C2 - older global stamp: refreshed from the bundled copy', () => {
        const bundled = makeBundledLegacyDir('a', 'd1');
        // The marker rides in the bundled copy and must land in the cache.
        actualFs.writeFileSync(join(bundled, 'marker.txt'), 'from bundled');
        writeGlobalLegacyEntry('.pzstudio-templates.json', stamp('a', 'd0'));
        writeGlobalLegacyEntry('stale-only.txt', 'old global content');

        const status = templateManager.refreshLegacyTemplates(
            undefined,
            bundled,
        );

        expect(status).toBe('refreshed');
        expect(logger.emitInfo).toHaveBeenCalledWith(
            undefined,
            'Legacy templates refreshed (a, d1).',
        );
        // Global content now equals the bundled copy: marker copied in,
        // global-only file washed out, stamp matches the bundled one.
        expect(actualFs.existsSync(join(globalLegacyDir(), 'marker.txt'))).toBe(
            true,
        );
        expect(
            actualFs.existsSync(join(globalLegacyDir(), 'stale-only.txt')),
        ).toBe(false);
        expect(
            actualFs.existsSync(
                join(globalLegacyDir(), '.template-project', 'x.txt'),
            ),
        ).toBe(true);
        expect(
            actualFs.readFileSync(stampPathIn(globalLegacyDir()), 'utf-8'),
        ).toBe(stamp('a', 'd1'));
    });

    it('C3 - global without a stamp: refreshed, planted .git file removed', () => {
        const bundled = makeBundledLegacyDir('a', 'd1');
        // A pre-stamp cache can carry a stray .git gitfile; the wholesale
        // replace must wash it out together with the missing stamp.
        writeGlobalLegacyEntry('.git', 'gitdir: ../.git/modules/pzstudio');

        const status = templateManager.refreshLegacyTemplates(
            undefined,
            bundled,
        );

        expect(status).toBe('refreshed');
        expect(actualFs.existsSync(join(globalLegacyDir(), '.git'))).toBe(
            false,
        );
        expect(actualFs.existsSync(stampPathIn(globalLegacyDir()))).toBe(true);
        expect(
            actualFs.existsSync(
                join(globalLegacyDir(), '.template-project', 'x.txt'),
            ),
        ).toBe(true);
    });

    it('C4 - bundled copy without a stamp: skipped, global dir untouched', () => {
        const bundled = makeBundledLegacyDir(); // no stamp file
        writeGlobalLegacyEntry('marker.txt', 'untouched');

        const status = templateManager.refreshLegacyTemplates(
            undefined,
            bundled,
        );

        expect(status).toBe('skipped');
        expect(logger.emitVerbose).toHaveBeenCalledWith(
            undefined,
            expect.stringContaining('skip'),
        );
        expect(actualFs.existsSync(join(globalLegacyDir(), 'marker.txt'))).toBe(
            true,
        );
        expect(actualFs.existsSync(stampPathIn(globalLegacyDir()))).toBe(false);
    });

    it('C5 - corrupt global stamp JSON: refreshed, not a crash', () => {
        const bundled = makeBundledLegacyDir('a', 'd1');
        writeGlobalLegacyEntry('.pzstudio-templates.json', '{oops');

        const status = templateManager.refreshLegacyTemplates(
            undefined,
            bundled,
        );

        expect(status).toBe('refreshed');
        expect(
            actualFs.readFileSync(stampPathIn(globalLegacyDir()), 'utf-8'),
        ).toBe(stamp('a', 'd1'));
    });

    it('C6 - nonexistent bundledDirOverride: skipped', () => {
        const missing = join(tmpdir(), 'pzstudio-no-such-bundled');
        actualFs.rmSync(missing, { recursive: true, force: true });

        const status = templateManager.refreshLegacyTemplates(
            undefined,
            missing,
        );

        expect(status).toBe('skipped');
        // A skip must not create or touch the global cache.
        expect(actualFs.existsSync(globalLegacyDir())).toBe(false);
    });

    it('C7 - failed copy: throw propagates and no stamp is stranded', () => {
        const bundled = makeBundledLegacyDir('a', 'd1');
        writeGlobalLegacyEntry('.pzstudio-templates.json', stamp('a', 'd0'));

        // Simulate a copy that got part-way before failing: delegate to the
        // real cpSync with the implementation's own args (filter included)
        // and throw afterwards. A plain-throwing mock would prove nothing —
        // with nothing copied there is no stamp to strand under either
        // ordering.
        vi.mocked(fs.cpSync).mockImplementation(((
            src: any,
            dest: any,
            opts: any,
        ) => {
            actualFs.cpSync(src, dest, opts);
            throw new Error('simulated cpSync failure');
        }) as any);

        expect(() =>
            templateManager.refreshLegacyTemplates(undefined, bundled),
        ).toThrow('simulated cpSync failure');

        // The copy really ran — template content landed in the global cache
        // — but the stamp did not: a failed refresh can never leave a stamp
        // behind, or every future update would report "up to date" on a
        // broken (missing categories) cache forever.
        expect(
            actualFs.existsSync(
                join(globalLegacyDir(), '.template-project', 'x.txt'),
            ),
        ).toBe(true);
        expect(actualFs.existsSync(stampPathIn(globalLegacyDir()))).toBe(false);
    });

    it('C8 - failed bootstrap copy: warn fires, no throw escapes, no stamp stranded', () => {
        // bootstrapLegacyTemplates has no bundledDirOverride seam: pin the
        // bundled source through the cwd probe (the __dirname probes miss
        // under vitest). The fixture must carry a stamp — an unstamped dev
        // source could never strand one, so without it this test could not
        // tell the two orderings apart.
        const prevCwd = process.cwd();
        const cwdRoot = actualFs.mkdtempSync(join(tmpdir(), 'pzstudio-cwd-'));
        bundledDirs.push(cwdRoot);
        const bundled = join(cwdRoot, '.template-legacy');
        actualFs.mkdirSync(join(bundled, '.template-project'), {
            recursive: true,
        });
        actualFs.writeFileSync(
            join(bundled, '.template-project', 'x.txt'),
            'template',
        );
        actualFs.writeFileSync(stampPathIn(bundled), stamp('a', 'd1'));

        // Same simulate-a-part-way-copy shape as C7: real copy first (the
        // implementation's own args, filter included), failure afterwards.
        vi.mocked(fs.cpSync).mockImplementation(((
            src: any,
            dest: any,
            opts: any,
        ) => {
            actualFs.cpSync(src, dest, opts);
            throw new Error('simulated bootstrap cpSync failure');
        }) as any);

        try {
            process.chdir(cwdRoot);

            // The offline path keeps this off the network; the fresh fake
            // home is cold, so the one-time bootstrap runs its copy first
            // and its failure leaves nothing for the resolution to use.
            expect(() => resolveTemplateDir('mod', true)).toThrow(
                'No valid cached or legacy template found',
            );

            // Bootstrap started and took the warn path (it never throws).
            expect(logger.emitInfo).toHaveBeenCalledWith(
                undefined,
                expect.stringContaining('Bootstrapping legacy templates'),
            );
            expect(logger.emitWarn).toHaveBeenCalledWith(
                undefined,
                expect.stringContaining('Failed to bootstrap legacy templates'),
            );

            // The copy really ran — but no stamp: a failed bootstrap copy
            // can never strand a stamp that pins a partial cache as
            // current (same invariant as C7, at the second site).
            expect(
                actualFs.existsSync(
                    join(globalLegacyDir(), '.template-project', 'x.txt'),
                ),
            ).toBe(true);
            expect(actualFs.existsSync(stampPathIn(globalLegacyDir()))).toBe(
                false,
            );
        } finally {
            process.chdir(prevCwd);
        }
    });
});
