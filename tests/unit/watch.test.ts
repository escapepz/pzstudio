import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    isWatchPathIgnored,
    resolveWatchVariants,
    WATCH_DEBOUNCE_MS,
} from '../../packages/cli/src/lib/watch-shared';
import { createIgnoreMatcher } from '../../packages/core/src/execute';
import {
    createDevSync,
    createDevSyncForEngine,
} from '../../packages/cli/src/lib/devsync';
import { watchCmd } from '../../packages/cli/src/lib/commands/watch';
import * as logger from '../../packages/cli/src/lib/logger';
import { hasFlag } from '../../packages/cli/src/lib/args';
import {
    projectDir,
    resolveProjectConfig,
    setProjectDir,
} from '../../packages/cli/src/lib/helper';
import { readGlobalConfig } from '../../packages/cli/src/lib/templateManager';
import { createRequire } from 'node:module';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';

vi.mock('../../packages/cli/src/lib/logger', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('../../packages/cli/src/lib/logger')
        >();
    return {
        ...actual,
        info: vi.fn(),
        verbose: vi.fn(),
        warn: vi.fn(),
    };
});
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
    };
});
vi.mock(
    '../../packages/cli/src/lib/templateManager',
    async (importOriginal) => {
        const actual =
            await importOriginal<
                typeof import('../../packages/cli/src/lib/templateManager')
            >();
        return {
            ...actual,
            readGlobalConfig: vi.fn(),
        };
    },
);
vi.mock('../../packages/cli/src/lib/devsync', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('../../packages/cli/src/lib/devsync')
        >();
    return {
        ...actual,
        createDevSyncForEngine: vi.fn(),
    };
});

const nodeRequire = createRequire(path.join(process.cwd(), '/'));

describe('resolveWatchVariants (pure)', () => {
    it('defaults to syncing both outputs', () => {
        expect(resolveWatchVariants({})).toEqual(['main', 'development']);
        expect(WATCH_DEBOUNCE_MS).toBeGreaterThan(0);
    });

    it('maps each target flag to its variant', () => {
        expect(resolveWatchVariants({ both: true })).toEqual([
            'main',
            'development',
        ]);
        expect(resolveWatchVariants({ production: true })).toEqual(['main']);
        expect(resolveWatchVariants({ development: true })).toEqual([
            'development',
        ]);
    });

    it('follows project.json build.target when no flag is given', () => {
        expect(resolveWatchVariants({}, 'production')).toEqual(['main']);
        expect(resolveWatchVariants({}, 'development')).toEqual([
            'development',
        ]);
        expect(resolveWatchVariants({}, 'both')).toEqual([
            'main',
            'development',
        ]);
        expect(resolveWatchVariants({}, undefined)).toEqual([
            'main',
            'development',
        ]);
    });

    it('lets target flags win over project.json build.target', () => {
        expect(resolveWatchVariants({ both: true }, 'production')).toEqual([
            'main',
            'development',
        ]);
        expect(resolveWatchVariants({ production: true }, 'both')).toEqual([
            'main',
        ]);
    });
});

describe('isWatchPathIgnored (pure)', () => {
    const projectPath = path.join(os.tmpdir(), 'pzstudio-watch-proj');
    const outDir = path.join(projectPath, 'Output');

    it('watches the project root itself', () => {
        expect(isWatchPathIgnored(projectPath, outDir, projectPath)).toBe(
            false,
        );
    });

    it('skips paths outside the project', () => {
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, '..', 'elsewhere'),
            ),
        ).toBe(true);
    });

    it('skips the output directory and everything below it', () => {
        expect(isWatchPathIgnored(projectPath, outDir, outDir)).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(outDir, 'Contents', 'mods', 'my_mod'),
            ),
        ).toBe(true);
    });

    it('skips dot segments but keeps .pzstudioignore files', () => {
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, '.git'),
            ),
        ).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', '.template-mod', 'x.lua'),
            ),
        ).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', 'media', '.DS_Store'),
            ),
        ).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', '.pzstudioignore'),
            ),
        ).toBe(false);
    });

    it('keeps .gitignore rule files (re-baseline parity) while unrelated dot entries stay dropped', () => {
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', '.gitignore'),
            ),
        ).toBe(false);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, '.gitignore'),
            ),
        ).toBe(false);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', '.git', 'HEAD'),
            ),
        ).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', 'media', '.gitignore.bak'),
            ),
        ).toBe(true);
    });

    it('keeps normal project files', () => {
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', 'media', 'lua', 'a.lua'),
            ),
        ).toBe(false);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'project.json'),
            ),
        ).toBe(false);
    });
});

describe('isWatchPathIgnored — containment invariants (doc 13 §10-C)', () => {
    const parent = path.join(os.tmpdir(), 'pzstudio-watch-containment');
    const projectPath = path.join(parent, 'proj');

    it('outDir equals the project root: source paths are not ignored (case 1, rule is a no-op)', () => {
        expect(
            isWatchPathIgnored(
                projectPath,
                projectPath,
                path.join(projectPath, 'my_mod', 'media', 'lua', 'a.lua'),
            ),
        ).toBe(false);
        expect(
            isWatchPathIgnored(
                projectPath,
                projectPath,
                path.join(projectPath, 'project.json'),
            ),
        ).toBe(false);
    });

    it('outDir is a project ancestor: source paths are not ignored (case 2, the ".." guard)', () => {
        expect(
            isWatchPathIgnored(
                projectPath,
                parent,
                path.join(projectPath, 'my_mod', 'media', 'a.lua'),
            ),
        ).toBe(false);
        expect(
            isWatchPathIgnored(
                projectPath,
                parent,
                path.join(projectPath, 'project.json'),
            ),
        ).toBe(false);
    });

    it('similar path prefixes never falsely contain (case 5)', () => {
        const siblingOut = path.join(parent, 'proj-out');
        expect(
            isWatchPathIgnored(
                projectPath,
                siblingOut,
                path.join(projectPath, 'my_mod', 'a.lua'),
            ),
        ).toBe(false);
        const innerSiblingOut = path.join(projectPath, 'my_mod2');
        expect(
            isWatchPathIgnored(
                projectPath,
                innerSiblingOut,
                path.join(projectPath, 'my_mod', 'a.lua'),
            ),
        ).toBe(false);
        expect(
            isWatchPathIgnored(
                projectPath,
                innerSiblingOut,
                path.join(innerSiblingOut, 'x.lua'),
            ),
        ).toBe(true);
    });

    it('outDir nested in a configured mod folder: the output subtree is ignored, sibling mod sources are not (case 6)', () => {
        const outDir = path.join(projectPath, 'my_mod', 'generated-A');
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(
                    outDir,
                    'My Title',
                    'Contents',
                    'mods',
                    'my_mod',
                    'media',
                    'lua',
                    'x.lua',
                ),
            ),
        ).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', 'media', 'lua', 'x.lua'),
            ),
        ).toBe(false);
    });
});

describe('isWatchPathIgnored — injected ignore matcher', () => {
    const projectPath = path.join(os.tmpdir(), 'pzstudio-watch-rules');
    const outDir = path.join(projectPath, 'dist');

    it('drops a source path matching a root .gitignore rule (old callers unchanged)', () => {
        const matcher = createIgnoreMatcher({
            '': { pzstudio: null, git: ['scratch/**', '*.log'] },
        }).isIgnored;
        const target = path.join(projectPath, 'scratch', 'out.lua');
        expect(isWatchPathIgnored(projectPath, outDir, target)).toBe(false);
        expect(
            isWatchPathIgnored(projectPath, outDir, target, undefined, matcher),
        ).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'notes.log'),
                undefined,
                matcher,
            ),
        ).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'keep.lua'),
                undefined,
                matcher,
            ),
        ).toBe(false);
    });

    it('the output-root rail wins: dist events drop without consulting the rules, and dist/** never stretches into nested sources', () => {
        const matcher = createIgnoreMatcher({
            '': { pzstudio: null, git: ['dist/**'] },
        }).isIgnored;
        let consulted = 0;
        const spy = (rel: string) => {
            consulted += 1;
            return matcher(rel);
        };
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(outDir, 'My Title', 'x.lua'),
                undefined,
                spy,
            ),
        ).toBe(true);
        expect(consulted).toBe(0);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', 'dist', 'x.lua'),
                undefined,
                spy,
            ),
        ).toBe(false);
        expect(consulted).toBe(1);
    });
});

describe('createDevSync (Node host integration)', () => {
    const dirs: string[] = [];

    afterEach(() => {
        setProjectDir(undefined);
        for (const dir of dirs.splice(0)) {
            deleteDir(dir);
        }
    });

    function makeProject(): {
        root: string;
        templateDir: string;
        projectDir: string;
    } {
        const root = createTempDir();
        dirs.push(root);

        const projectDir = path.join(root, 'proj');
        const templateDir = path.join(root, 'templates', 'workshop');
        fs.mkdirSync(path.join(projectDir, 'my_mod', 'media', 'lua'), {
            recursive: true,
        });
        fs.mkdirSync(templateDir, { recursive: true });
        fs.writeFileSync(
            path.join(projectDir, 'project.json'),
            JSON.stringify({
                workshop: {
                    title: 'Watch Project',
                    visibility: 'public',
                    tags: [],
                },
                mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
                excludes: [],
                outdir: path.join(root, 'out'),
            }),
        );
        fs.writeFileSync(
            path.join(projectDir, 'my_mod', 'media', 'lua', 'hello.lua'),
            'print("v1")',
        );
        fs.writeFileSync(
            path.join(templateDir, 'template-file.txt'),
            'template',
        );
        return { root, templateDir, projectDir };
    }

    it('runs the initial build through the real Node host helpers', async () => {
        const { templateDir, projectDir } = makeProject();
        const session = createDevSync(projectDir, {
            workshopTemplateDir: templateDir,
            quiet: true,
        });
        await session.start(['main']);

        const outFile = path.join(
            projectDir,
            'dist',
            'Watch Project',
            'Contents',
            'mods',
            'my_mod',
            'media',
            'lua',
            'hello.lua',
        );
        expect(fs.readFileSync(outFile, 'utf8')).toBe('print("v1")');
        await session.stop();
    });

    it('applies a source delta through the real Node filesystem', async () => {
        const { templateDir, projectDir } = makeProject();
        const session = createDevSync(projectDir, {
            workshopTemplateDir: templateDir,
            quiet: true,
        });
        await session.start(['main', 'development']);

        const source = path.join(
            projectDir,
            'my_mod',
            'media',
            'lua',
            'hello.lua',
        );
        fs.writeFileSync(source, 'print("v2")');
        const result = await session.apply([{ type: 'change', path: source }]);
        expect(result.errors).toEqual([]);
        expect(result.incremental).toBe(2);

        const mainOut = path.join(
            projectDir,
            'dist',
            'Watch Project',
            'Contents',
            'mods',
            'my_mod',
            'media',
            'lua',
            'hello.lua',
        );
        const devOut = path.join(
            projectDir,
            'dist',
            'Watch Project - dev_branch',
            'Contents',
            'mods',
            'my_mod_dev',
            'media',
            'lua',
            'hello.lua',
        );
        expect(fs.readFileSync(mainOut, 'utf8')).toBe('print("v2")');
        expect(fs.readFileSync(devOut, 'utf8')).toBe('print("v2")');
        await session.stop();
    });
});

describe('watchCmd — banner names the variant source', () => {
    const project = {
        workshop: {
            title: 'Test Project',
            visibility: 'public',
            tags: [],
        },
        mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
        excludes: [],
    };

    const configWith = (build?: Record<string, unknown>) =>
        JSON.parse(JSON.stringify({ ...project, build })) as any;

    const bannerLine = (): string | undefined =>
        vi
            .mocked(logger.info)
            .mock.calls.map((call) => String(call[0]))
            .find((message) => message.startsWith('Syncing'));

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(projectDir).mockReturnValue('/proj' as any);
        vi.mocked(resolveProjectConfig).mockReturnValue(configWith());
        vi.mocked(readGlobalConfig).mockReturnValue(undefined as any);
        vi.mocked(hasFlag).mockReturnValue(false);
        vi.mocked(createDevSyncForEngine).mockReturnValue({
            start: vi.fn().mockRejectedValue(new Error('stop-after-banner')),
            apply: vi.fn(),
            stop: vi.fn().mockResolvedValue(undefined),
        } as any);
    });

    it('names build.target as the variant source when config decided the variants', async () => {
        vi.mocked(resolveProjectConfig).mockReturnValue(
            configWith({ target: 'development' }),
        );

        await expect(watchCmd()).rejects.toThrow('stop-after-banner');

        expect(bannerLine()).toBe(
            "Syncing 'Test Project' (development — build.target) — press Ctrl+C to stop.",
        );
    });

    it('omits the source suffix when a flag decided the variants', async () => {
        vi.mocked(resolveProjectConfig).mockReturnValue(
            configWith({ target: 'development' }),
        );
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'both',
        );

        await expect(watchCmd()).rejects.toThrow('stop-after-banner');

        expect(bannerLine()).toBe(
            "Syncing 'Test Project' (main + development) — press Ctrl+C to stop.",
        );
    });

    it('keeps the banner byte-identical with no flag and no build.target', async () => {
        await expect(watchCmd()).rejects.toThrow('stop-after-banner');

        expect(bannerLine()).toBe(
            "Syncing 'Test Project' (main + development) — press Ctrl+C to stop.",
        );
    });
});

describe('watchCmd — the stop line names the exit convention (d12-U4)', () => {
    let subscribeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(projectDir).mockReturnValue('/proj' as any);
        vi.mocked(resolveProjectConfig).mockReturnValue({
            workshop: { title: 'Test Project', visibility: 'public', tags: [] },
            mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
            excludes: [],
        } as any);
        vi.mocked(readGlobalConfig).mockReturnValue(undefined as any);
        vi.mocked(hasFlag).mockReturnValue(false);
        vi.mocked(createDevSyncForEngine).mockReturnValue({
            start: vi.fn().mockResolvedValue(undefined),
            apply: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
        } as any);
        const watcher = nodeRequire('@parcel/watcher') as {
            subscribe: (...args: any[]) => any;
        };
        subscribeSpy = vi.spyOn(watcher, 'subscribe').mockResolvedValue({
            unsubscribe: vi.fn().mockResolvedValue(undefined),
        } as any);
    });

    afterEach(() => {
        subscribeSpy.mockRestore();
    });

    it('stops on SIGINT with exit 130 and says so in the stop line', async () => {
        const previousExitCode = process.exitCode;
        const baseline = process.listenerCount('SIGINT');
        try {
            const stopped = watchCmd();
            const deadline = Date.now() + 5000;
            while (process.listenerCount('SIGINT') <= baseline) {
                if (Date.now() > deadline) {
                    throw new Error(
                        'watchCmd never installed its SIGINT handler',
                    );
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
            }

            process.emit('SIGINT');
            await stopped;

            expect(process.exitCode).toBe(130);
            expect(
                vi
                    .mocked(logger.info)
                    .mock.calls.map((call) => String(call[0])),
            ).toContain(
                'Development sync stopped. (exit 130 — Ctrl+C/SIGINT convention)',
            );
        } finally {
            process.exitCode = previousExitCode;
        }
    });
});
