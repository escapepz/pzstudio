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
import type { TemplateTransport } from '@pzstudio/platform';
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

        expect(filter(join(tmpRoot, 'root-ignored'), '')).toBe(false);
        expect(filter(join(tmpRoot, 'subfolder', 'root-ignored'), '')).toBe(
            true,
        );
        expect(filter(join(tmpRoot, 'subfolder', 'sub-ignored'), '')).toBe(
            false,
        );
    });

    it('honors .gitignore globs co-located with the filter root', () => {
        actualFs.writeFileSync(join(tmpRoot, '.gitignore'), 'build/\n*.tmp\n');
        actualFs.mkdirSync(join(tmpRoot, 'build'));
        actualFs.writeFileSync(join(tmpRoot, 'build', 'x.lua'), 'test');
        actualFs.writeFileSync(join(tmpRoot, 'a.tmp'), 'test');
        actualFs.writeFileSync(join(tmpRoot, 'keep.lua'), 'test');

        const filter = createIgnoreFilter(tmpRoot);

        expect(filter(join(tmpRoot, 'build'), '')).toBe(false);
        expect(filter(join(tmpRoot, 'build', 'x.lua'), '')).toBe(false);
        expect(filter(join(tmpRoot, 'a.tmp'), '')).toBe(false);
        expect(filter(join(tmpRoot, 'keep.lua'), '')).toBe(true);
    });

    it('honors .gitignore with .pzstudioignore outranking it at the same level', () => {
        actualFs.writeFileSync(join(tmpRoot, '.gitignore'), '*.log\n');
        actualFs.writeFileSync(join(tmpRoot, '.pzstudioignore'), '!a.log\n');
        actualFs.writeFileSync(join(tmpRoot, 'a.log'), 'test');
        actualFs.writeFileSync(join(tmpRoot, 'b.log'), 'test');

        const filter = createIgnoreFilter(tmpRoot);

        expect(filter(join(tmpRoot, 'a.log'), '')).toBe(true);
        expect(filter(join(tmpRoot, 'b.log'), '')).toBe(false);
    });

    it('lets nested .gitignore rules decide closest-wins like the core engine', () => {
        actualFs.writeFileSync(join(tmpRoot, '.gitignore'), '*.log\n');
        actualFs.mkdirSync(join(tmpRoot, 'media'));
        actualFs.writeFileSync(
            join(tmpRoot, 'media', '.gitignore'),
            '!keep.log\n',
        );
        actualFs.writeFileSync(join(tmpRoot, 'other.log'), 'test');
        actualFs.writeFileSync(join(tmpRoot, 'media', 'keep.log'), 'test');
        actualFs.writeFileSync(join(tmpRoot, 'media', 'other.log'), 'test');

        const filter = createIgnoreFilter(tmpRoot);

        expect(filter(join(tmpRoot, 'other.log'), '')).toBe(false);
        expect(filter(join(tmpRoot, 'media', 'keep.log'), '')).toBe(true);
        expect(filter(join(tmpRoot, 'media', 'other.log'), '')).toBe(true);
    });

    it('keeps the rails: mod.info and the rule files survive rules that name them', () => {
        actualFs.writeFileSync(
            join(tmpRoot, '.pzstudioignore'),
            'mod.info\n.gitignore\nnested\n',
        );
        actualFs.writeFileSync(join(tmpRoot, '.gitignore'), '*.info\n');
        actualFs.mkdirSync(join(tmpRoot, 'nested'));
        actualFs.writeFileSync(
            join(tmpRoot, 'nested', '.gitignore'),
            '*.log\n',
        );
        actualFs.writeFileSync(join(tmpRoot, 'mod.info'), 'test');
        actualFs.writeFileSync(join(tmpRoot, 'nested', 'media.log'), 'test');
        actualFs.writeFileSync(join(tmpRoot, 'nested', 'media.lua'), 'test');

        const filter = createIgnoreFilter(tmpRoot);

        expect(filter(join(tmpRoot, 'mod.info'), '')).toBe(true);
        expect(filter(join(tmpRoot, '.gitignore'), '')).toBe(true);
        expect(filter(join(tmpRoot, '.pzstudioignore'), '')).toBe(true);
        expect(filter(join(tmpRoot, 'nested', '.gitignore'), '')).toBe(true);
        expect(filter(join(tmpRoot, 'nested', 'media.log'), '')).toBe(false);
        expect(filter(join(tmpRoot, 'nested', 'media.lua'), '')).toBe(true);
    });
});

describe('templateManager - config and resolution', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe('readGlobalConfig', () => {
        it('should return defaults if config does not exist (no factory outdir — dist-always)', () => {
            vi.spyOn(fs, 'existsSync').mockReturnValue(false);
            const config = readGlobalConfig();
            expect(config.templates).toBeDefined();
            expect(config.useSymlinks).toBe(true);
            expect(config.outdir).toBeUndefined();
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
            );
            expect(config.useSymlinks).toBe(false);
            expect(config.outdir).toBe('/custom/out');
        });
    });

    describe('resolveTemplateDir', () => {
        it('should resolve built-in workshop template', () => {
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
            vi.spyOn(fs, 'readdirSync').mockReturnValue([] as any);
            expect(() => resolveTemplateDir('mod', true)).toThrow(
                'No valid cached or legacy template found',
            );
        });
        it('should ignore project-level template overrides and use global config', () => {
            const projectSpy = vi.spyOn(helper, 'resolveProjectConfig');

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

            expect(projectSpy).not.toHaveBeenCalled();

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
                    });
                return 'backup-outdir';
            });
            const writeSpy = vi.spyOn(fs, 'writeFileSync');

            templateManager.migrateGlobalConfigIfNeeded();

            expect(writeSpy).toHaveBeenCalled();
            const lastCall =
                writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
            const written = JSON.parse(lastCall[1] as string);
            expect(written.useSymlinks).toBe(true);
            expect(written.templates.project.url).toBe('old');
            expect(written.templates.mod).toBeDefined();
            expect(written.outdir).toBe('backup-outdir'); // Migration stamp
        });
    });
});

describe('templateManager - cache replacement data safety (sweep d15-B5)', () => {
    const fakeHome = () => (globalThis as any).__PZSTUDIO_FAKE_HOME as string;

    let actualFs: any;

    beforeEach(async () => {
        vi.restoreAllMocks();
        actualFs = await vi.importActual('fs');
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
    });

    const modCacheDir = () =>
        join(
            fakeHome(),
            '.pzstudio',
            'templates',
            'escapepz',
            'pzstudio-template-mod',
        );

    const fakeTransport = (behavior: {
        valid: boolean;
        refresh: boolean;
        download?: (url: string, ref: string | undefined, dest: string) => void;
    }): TemplateTransport => ({
        name: 'git',
        isCacheValid: () => behavior.valid,
        refresh: () => behavior.refresh,
        download: behavior.download ?? (() => {}),
    });

    it('a failed replacement clone leaves the previous cache untouched', () => {
        const cacheDir = modCacheDir();
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, 'seeded.txt'), 'cache');

        const downloadTargets: string[] = [];
        const transport = fakeTransport({
            valid: true,
            refresh: false,
            download: (_url, _ref, dest) => {
                downloadTargets.push(dest);
                throw new Error('download 404');
            },
        });

        let result: string | undefined;
        let threw: unknown;
        try {
            result = resolveTemplateDir('mod', {
                forceUpdate: true,
                templateTransport: transport,
            });
        } catch (e) {
            threw = e;
        }

        expect(downloadTargets).toEqual([`${cacheDir}.replacing`]);
        expect(fs.existsSync(cacheDir)).toBe(true);
        expect(fs.readFileSync(join(cacheDir, 'seeded.txt'), 'utf8')).toBe(
            'cache',
        );
        expect(fs.existsSync(`${cacheDir}.replacing`)).toBe(false);
        if (result !== undefined) {
            expect(result).toContain('.template-mod');
        } else {
            expect(String(threw)).toContain('no legacy fallback');
        }
    });

    const fakeCloneDownload = (dest: string): void => {
        mkdirSync(join(dest, '.git'), { recursive: true });
        writeFileSync(join(dest, 'fresh.txt'), 'new');
    };

    it('a successful replacement clone swaps the cache only after staging is secured', () => {
        const cacheDir = modCacheDir();
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, 'stale.txt'), 'old');

        const transport = fakeTransport({
            valid: true,
            refresh: false,
            download: (_url, _ref, dest) => fakeCloneDownload(dest),
        });

        const result = resolveTemplateDir('mod', {
            forceUpdate: true,
            templateTransport: transport,
        });
        expect(result).toBe(cacheDir);
        expect(fs.readFileSync(join(cacheDir, 'fresh.txt'), 'utf8')).toBe(
            'new',
        );
        expect(fs.existsSync(join(cacheDir, 'stale.txt'))).toBe(false);
        expect(fs.existsSync(`${cacheDir}.replacing`)).toBe(false);
    });

    it('an invalid cache is replaced through the same staging swap (never deleted first)', () => {
        const cacheDir = modCacheDir();
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, 'junk.txt'), 'invalid');

        const downloadTargets: string[] = [];
        const transport = fakeTransport({
            valid: false,
            refresh: false,
            download: (_url, _ref, dest) => {
                downloadTargets.push(dest);
                expect(fs.existsSync(cacheDir)).toBe(true);
                fakeCloneDownload(dest);
            },
        });

        const result = resolveTemplateDir('mod', {
            forceUpdate: true,
            templateTransport: transport,
        });
        expect(downloadTargets).toEqual([`${cacheDir}.replacing`]);
        expect(result).toBe(cacheDir);
        expect(fs.readFileSync(join(cacheDir, 'fresh.txt'), 'utf8')).toBe(
            'new',
        );
        expect(fs.existsSync(join(cacheDir, 'junk.txt'))).toBe(false);
        expect(fs.existsSync(`${cacheDir}.replacing`)).toBe(false);
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

    const stamp = (version: string, buildDate: string): string =>
        JSON.stringify({ version, buildDate }, null, 4) + '\n';

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
        const bundled = makeBundledLegacyDir();
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
        expect(actualFs.existsSync(globalLegacyDir())).toBe(false);
    });

    it('C7 - failed copy: throw propagates and the previous legacy dir stays intact (d15-U1)', () => {
        const bundled = makeBundledLegacyDir('a', 'd1');
        writeGlobalLegacyEntry('.pzstudio-templates.json', stamp('a', 'd0'));
        writeGlobalLegacyEntry('old-only.txt', 'previous global content');

        vi.mocked(fs.cpSync).mockImplementation(((
            src: any,
            dest: any,
            opts: any,
        ) => {
            expect(String(dest).replace(/\\/g, '/')).toBe(
                `${globalLegacyDir().replace(/\\/g, '/')}.replacing`,
            );
            actualFs.cpSync(src, dest, opts);
            throw new Error('simulated cpSync failure');
        }) as any);

        expect(() =>
            templateManager.refreshLegacyTemplates(undefined, bundled),
        ).toThrow('simulated cpSync failure');

        expect(
            actualFs.readFileSync(stampPathIn(globalLegacyDir()), 'utf-8'),
        ).toBe(stamp('a', 'd0'));
        expect(
            actualFs.existsSync(join(globalLegacyDir(), 'old-only.txt')),
        ).toBe(true);
        expect(actualFs.existsSync(`${globalLegacyDir()}.replacing`)).toBe(
            false,
        );
    });

    it('C9 - the swap happens only after staging is secured (d15-U1)', () => {
        const bundled = makeBundledLegacyDir('a', 'd1');
        actualFs.writeFileSync(join(bundled, 'marker.txt'), 'from bundled');
        writeGlobalLegacyEntry('.pzstudio-templates.json', stamp('a', 'd0'));
        writeGlobalLegacyEntry('old-only.txt', 'old global content');

        vi.mocked(fs.cpSync).mockImplementation(((
            src: any,
            dest: any,
            opts: any,
        ) => {
            expect(actualFs.existsSync(globalLegacyDir())).toBe(true);
            expect(
                actualFs.existsSync(join(globalLegacyDir(), 'old-only.txt')),
            ).toBe(true);
            actualFs.cpSync(src, dest, opts);
        }) as any);

        const status = templateManager.refreshLegacyTemplates(
            undefined,
            bundled,
        );

        expect(status).toBe('refreshed');
        expect(logger.emitInfo).toHaveBeenCalledWith(
            undefined,
            'Legacy templates refreshed (a, d1).',
        );
        expect(actualFs.existsSync(join(globalLegacyDir(), 'marker.txt'))).toBe(
            true,
        );
        expect(
            actualFs.existsSync(join(globalLegacyDir(), 'old-only.txt')),
        ).toBe(false);
        expect(
            actualFs.readFileSync(stampPathIn(globalLegacyDir()), 'utf-8'),
        ).toBe(stamp('a', 'd1'));
        expect(actualFs.existsSync(`${globalLegacyDir()}.replacing`)).toBe(
            false,
        );
    });

    it('C8 - failed bootstrap copy: warn fires, no throw escapes, no stamp stranded', () => {
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

            expect(() => resolveTemplateDir('mod', true)).toThrow(
                'No valid cached or legacy template found',
            );

            expect(logger.emitInfo).toHaveBeenCalledWith(
                undefined,
                expect.stringContaining('Bootstrapping legacy templates'),
            );
            expect(logger.emitWarn).toHaveBeenCalledWith(
                undefined,
                expect.stringContaining('Failed to bootstrap legacy templates'),
            );

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
