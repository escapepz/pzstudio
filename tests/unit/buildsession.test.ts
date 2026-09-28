import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFileSystem } from '../helpers/memory-file-system';
import {
    BuildSession,
    BuildSessionHost,
    BuildVariant,
    classifyDelta,
    coalesceDeltas,
    FileDelta,
} from '../../packages/core/src/buildsession';
import type { PlanBuildInput } from '../../packages/core/src/buildplan';
import type { IProjectConfig } from '../../packages/core/src/project';

const TEMPLATE_DIR = '/templates/workshop';
const PROJECT_DIR = '/proj';
const OUT_DIR = '/out';
const MAIN_OUT = '/out/Sync Project';
const DEV_OUT = '/out/Sync Project - dev_branch';

function baseConfig(): IProjectConfig {
    return {
        workshop: {
            id: 12345,
            title: 'Sync Project',
            visibility: 'public',
            tags: [],
        },
        mods: {
            my_mod: { name: 'My Mod', description: 'A mod.' },
        },
        excludes: [],
        outdir: OUT_DIR,
    } as unknown as IProjectConfig;
}

/**
 * A fake session host: getPlanInput() reads the same facts the CLI's build
 * command reads (mod.info presence/content, branch folders, workshop
 * metadata) — but through the injected memory filesystem. The config lives
 * in a mutable holder so tests can mutate project.json's meaning and let a
 * full rebuild pick it up.
 */
function createHost(
    fs: MemoryFileSystem,
    config: IProjectConfig,
): {
    host: BuildSessionHost;
    logs: string[];
    setConfig(next: IProjectConfig): void;
} {
    const logs: string[] = [];
    const holder = { config };
    const host: BuildSessionHost = {
        fs,
        getPlanInput: async (): Promise<Omit<PlanBuildInput, 'variant'>> => {
            const modSourceStates: PlanBuildInput['modSourceStates'] = {};
            for (const modId of Object.keys(holder.config.mods)) {
                const state = {
                    branchFolders: [] as string[],
                    modInfoExists: {} as Record<string, boolean>,
                    modInfoContent: {} as Record<string, string | undefined>,
                };
                state.modInfoExists[''] = false;
                state.modInfoContent[''] = undefined;
                try {
                    state.modInfoContent[''] = await fs.readText(
                        `${PROJECT_DIR}/${modId}/mod.info`,
                    );
                    state.modInfoExists[''] = true;
                } catch {
                    // no root mod.info
                }
                const entries = await fs.list(`${PROJECT_DIR}/${modId}`);
                for (const entry of entries) {
                    if (entry.type !== 'directory') continue;
                    try {
                        await fs.stat(`${entry.uri}/media`);
                        state.branchFolders.push(entry.name);
                        state.modInfoExists[entry.name] = false;
                        try {
                            state.modInfoContent[entry.name] =
                                await fs.readText(`${entry.uri}/mod.info`);
                            state.modInfoExists[entry.name] = true;
                        } catch {
                            // branch without mod.info
                        }
                    } catch {
                        // not a Build 42 branch folder
                    }
                }
                modSourceStates[modId] = state;
            }
            let descriptionLines: string[] = [];
            try {
                descriptionLines = (
                    await fs.readText(`${PROJECT_DIR}/workshop/description.txt`)
                ).split(/\r?\n/);
            } catch {
                // no description file
            }
            let previewPngExists = false;
            try {
                await fs.stat(`${PROJECT_DIR}/workshop/preview.png`);
                previewPngExists = true;
            } catch {
                // no preview
            }
            return {
                config: holder.config,
                workshopTemplateDir: TEMPLATE_DIR,
                projectDir: PROJECT_DIR,
                modSourceStates,
                descriptionLines,
                previewPngExists,
            };
        },
        log: (level, message) => logs.push(`${level}:${message}`),
    };
    return { host, logs, setConfig: (next) => (holder.config = next) };
}

async function seedProject(
    fs: MemoryFileSystem,
    config: IProjectConfig,
): Promise<void> {
    await fs.writeText(`${PROJECT_DIR}/project.json`, JSON.stringify(config));
    await fs.writeText(
        `${TEMPLATE_DIR}/Contents/template-file.txt`,
        'template',
    );
    await fs.writeText(
        `${PROJECT_DIR}/my_mod/media/lua/shared/hello.lua`,
        'print("v1")',
    );
    await fs.writeText(
        `${PROJECT_DIR}/my_mod/media/lua/shared/util.lua`,
        'print("util")',
    );
}

describe('coalesceDeltas (pure)', () => {
    it('keeps only the final state per path', () => {
        const coalesced = coalesceDeltas([
            { type: 'create', path: '/p/a.lua' },
            { type: 'change', path: '/p/a.lua' },
            { type: 'change', path: '/p/b.lua' },
            { type: 'delete', path: '/p/b.lua' },
            { type: 'delete', path: '/p/c.lua' },
            { type: 'create', path: '/p/c.lua' },
        ]);
        // create→change collapses to the create (the write is identical);
        // any→delete stays a delete; delete→create becomes a create.
        expect(coalesced).toEqual([
            { type: 'create', path: '/p/a.lua' },
            { type: 'delete', path: '/p/b.lua' },
            { type: 'create', path: '/p/c.lua' },
        ]);
    });

    it('normalizes backslashes for identity but keeps the latest path', () => {
        const coalesced = coalesceDeltas([
            { type: 'change', path: '\\p\\a.lua' },
            { type: 'change', path: '/p/a.lua' },
        ]);
        expect(coalesced).toHaveLength(1);
        expect(coalesced[0].path).toBe('/p/a.lua');
    });
});

describe('classifyDelta (pure)', () => {
    const config = baseConfig();
    config.mods.dev_mod = {
        name: 'Dev',
        description: 'd',
        build: { devOnly: true },
    } as never;
    config.mods.excluded_mod = { name: 'X', description: 'd' } as never;
    config.excludes = ['excluded_mod'];
    const planInput: Omit<PlanBuildInput, 'variant'> = {
        config,
        workshopTemplateDir: TEMPLATE_DIR,
        projectDir: PROJECT_DIR,
        modSourceStates: {},
        descriptionLines: [],
        previewPngExists: false,
    };

    it('classifies project.json as a structural full rebuild', () => {
        expect(
            classifyDelta(
                { type: 'change', path: `${PROJECT_DIR}\\project.json` },
                planInput,
            ),
        ).toMatchObject({ kind: 'full-rebuild' });
    });

    it('classifies workshop metadata', () => {
        expect(
            classifyDelta(
                { type: 'change', path: '/proj/workshop/description.txt' },
                planInput,
            ),
        ).toMatchObject({ kind: 'workshop-text' });
        expect(
            classifyDelta(
                { type: 'create', path: '/proj/workshop/preview.png' },
                planInput,
            ),
        ).toMatchObject({ kind: 'workshop-preview' });
        expect(
            classifyDelta(
                { type: 'change', path: '/proj/workshop/other.txt' },
                planInput,
            ),
        ).toMatchObject({ kind: 'ignore' });
    });

    it('classifies mod files with their included variants', () => {
        expect(
            classifyDelta(
                { type: 'change', path: '/proj/my_mod/media/lua/a.lua' },
                planInput,
            ),
        ).toEqual({
            kind: 'mod-file',
            modId: 'my_mod',
            relativePath: 'media/lua/a.lua',
            variants: ['main', 'development'],
            type: 'change',
        });
        // Dev-only mods only qualify for the development variant.
        expect(
            classifyDelta(
                { type: 'change', path: '/proj/dev_mod/media/lua/d.lua' },
                planInput,
            ),
        ).toMatchObject({
            kind: 'mod-file',
            modId: 'dev_mod',
            variants: ['development'],
        });
    });

    it('routes mod.info and .pzstudioignore events to scoped rebuilds', () => {
        expect(
            classifyDelta(
                { type: 'change', path: '/proj/my_mod/mod.info' },
                planInput,
            ),
        ).toMatchObject({ kind: 'mod-scoped', modId: 'my_mod' });
        expect(
            classifyDelta(
                { type: 'create', path: '/proj/my_mod/media/.pzstudioignore' },
                planInput,
            ),
        ).toMatchObject({ kind: 'mod-scoped', modId: 'my_mod' });
    });

    it('ignores dot entries, excluded mods and unknown folders', () => {
        expect(
            classifyDelta(
                { type: 'change', path: '/proj/.template-mod/x/y.lua' },
                planInput,
            ),
        ).toMatchObject({ kind: 'ignore' });
        expect(
            classifyDelta(
                { type: 'change', path: '/proj/my_mod/media/.DS_Store' },
                planInput,
            ),
        ).toMatchObject({ kind: 'ignore' });
        expect(
            classifyDelta(
                { type: 'change', path: '/proj/excluded_mod/a.lua' },
                planInput,
            ),
        ).toMatchObject({ kind: 'ignore' });
        expect(
            classifyDelta(
                { type: 'change', path: '/proj/not_a_mod/a.lua' },
                planInput,
            ),
        ).toMatchObject({ kind: 'ignore' });
        expect(
            classifyDelta(
                { type: 'change', path: '/elsewhere/a.lua' },
                planInput,
            ),
        ).toMatchObject({ kind: 'ignore' });
    });
});

describe('BuildSession (fs-driven sync engine)', () => {
    let fs: MemoryFileSystem;
    let config: IProjectConfig;

    beforeEach(async () => {
        fs = new MemoryFileSystem();
        config = baseConfig();
        await seedProject(fs, config);
    });

    it('start() performs the full build for both variants', async () => {
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        expect(await fs.readText(`${MAIN_OUT}/workshop.txt`)).toContain(
            'id=12345',
        );
        expect(await fs.readText(`${DEV_OUT}/workshop.txt`)).toContain(
            'title=Sync Project - dev_branch',
        );
        expect(
            await fs.readText(
                `${MAIN_OUT}/Contents/mods/my_mod/media/lua/shared/hello.lua`,
            ),
        ).toBe('print("v1")');
        expect(
            await fs.readText(
                `${DEV_OUT}/Contents/mods/my_mod_dev/media/lua/shared/hello.lua`,
            ),
        ).toBe('print("v1")');
        // mod.info is generated (auto-if-missing, no source mod.info)
        expect(
            await fs.readText(`${MAIN_OUT}/Contents/mods/my_mod/mod.info`),
        ).toContain('id=my_mod');
        await session.stop();
    });

    it('apply() syncs a plain Lua change incrementally into both variants', async () => {
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        await fs.writeText(
            `${PROJECT_DIR}/my_mod/media/lua/shared/hello.lua`,
            'print("v2")',
        );
        const result = await session.apply([
            { type: 'change', path: '/proj/my_mod/media/lua/shared/hello.lua' },
        ]);

        expect(result.errors).toEqual([]);
        expect(result.incremental).toBe(2);
        expect(result.fullRebuild).toBe(false);
        expect(result.scoped).toEqual([]);
        expect(
            await fs.readText(
                `${MAIN_OUT}/Contents/mods/my_mod/media/lua/shared/hello.lua`,
            ),
        ).toBe('print("v2")');
        expect(
            await fs.readText(
                `${DEV_OUT}/Contents/mods/my_mod_dev/media/lua/shared/hello.lua`,
            ),
        ).toBe('print("v2")');
        // Nothing else was touched: the pre-existing util.lua copy is still
        // the original and workshop.txt still has the id (no full rebuild).
        expect(
            await fs.readText(
                `${MAIN_OUT}/Contents/mods/my_mod/media/lua/shared/util.lua`,
            ),
        ).toBe('print("util")');
        expect(await fs.readText(`${MAIN_OUT}/workshop.txt`)).toContain(
            'id=12345',
        );
        await session.stop();
    });

    it('apply() creates and deletes files in the output', async () => {
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        await fs.writeText(`${PROJECT_DIR}/my_mod/media/lua/new.lua`, '-- new');
        const created = await session.apply([
            { type: 'create', path: '/proj/my_mod/media/lua/new.lua' },
        ]);
        expect(created.incremental).toBe(2);
        expect(
            await fs.readText(
                `${MAIN_OUT}/Contents/mods/my_mod/media/lua/new.lua`,
            ),
        ).toBe('-- new');

        const deleted = await session.apply([
            { type: 'delete', path: '/proj/my_mod/media/lua/new.lua' },
        ]);
        expect(deleted.incremental).toBe(2);
        await expect(
            fs.readText(`${MAIN_OUT}/Contents/mods/my_mod/media/lua/new.lua`),
        ).rejects.toThrow('ENOENT');
        await expect(
            fs.readText(
                `${DEV_OUT}/Contents/mods/my_mod_dev/media/lua/new.lua`,
            ),
        ).rejects.toThrow('ENOENT');
        await session.stop();
    });

    it('routes a mod.info change through a scoped rebuild with id patching', async () => {
        await fs.writeText(
            `${PROJECT_DIR}/my_mod/mod.info`,
            'id=my_mod\nname=My Mod\n',
        );
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();
        // Both outputs carry the source mod.info (auto-if-missing)…
        expect(
            await fs.readText(`${MAIN_OUT}/Contents/mods/my_mod/mod.info`),
        ).toContain('id=my_mod');
        expect(
            await fs.readText(`${DEV_OUT}/Contents/mods/my_mod_dev/mod.info`),
        ).toContain('id=my_mod_dev');

        await fs.writeText(
            `${PROJECT_DIR}/my_mod/mod.info`,
            'id=my_mod\nname=Renamed Mod\n',
        );
        const result = await session.apply([
            { type: 'change', path: '/proj/my_mod/mod.info' },
        ]);

        expect(result.errors).toEqual([]);
        expect(result.scoped).toEqual([
            { modId: 'my_mod', variants: ['main', 'development'] },
        ]);
        expect(
            await fs.readText(`${MAIN_OUT}/Contents/mods/my_mod/mod.info`),
        ).toContain('name=Renamed Mod');
        // The development output keeps the folder-name-aligned id.
        expect(
            await fs.readText(`${DEV_OUT}/Contents/mods/my_mod_dev/mod.info`),
        ).toBe('id=my_mod_dev\nname=Renamed Mod\n');
        await session.stop();
    });

    it('respects .pzstudioignore rules when applying deltas', async () => {
        await fs.writeText(`${PROJECT_DIR}/my_mod/.pzstudioignore`, 'dev/\n');
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();
        // The ignore file itself is never copied (excludeIgnoreFile)…
        expect(
            fs.files.has(`${MAIN_OUT}/Contents/mods/my_mod/.pzstudioignore`),
        ).toBe(false);

        await fs.writeText(`${PROJECT_DIR}/my_mod/dev/scratch.lua`, 'x');
        const result = await session.apply([
            { type: 'create', path: '/proj/my_mod/dev/scratch.lua' },
        ]);
        expect(result.ignored).toBe(1);
        expect(result.incremental).toBe(0);
        expect(
            fs.files.has(`${MAIN_OUT}/Contents/mods/my_mod/dev/scratch.lua`),
        ).toBe(false);
        await session.stop();
    });

    it('skips deltas for dev-only mods in the main variant', async () => {
        config.mods.dev_mod = {
            name: 'Dev',
            description: 'd',
            build: { devOnly: true },
        } as never;
        await fs.writeText(`${PROJECT_DIR}/dev_mod/media/lua/d.lua`, 'dev');

        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();
        expect(
            fs.files.has(
                `${DEV_OUT}/Contents/mods/dev_mod_dev/media/lua/d.lua`,
            ),
        ).toBe(true);
        expect(
            fs.files.has(`${MAIN_OUT}/Contents/mods/dev_mod/media/lua/d.lua`),
        ).toBe(false);

        await fs.writeText(`${PROJECT_DIR}/dev_mod/media/lua/d.lua`, 'dev2');
        const result = await session.apply([
            { type: 'change', path: '/proj/dev_mod/media/lua/d.lua' },
        ]);
        // Only the development output was touched.
        expect(result.incremental).toBe(1);
        expect(
            await fs.readText(
                `${DEV_OUT}/Contents/mods/dev_mod_dev/media/lua/d.lua`,
            ),
        ).toBe('dev2');
        await session.stop();
    });

    it('rewrites workshop.txt when description.txt changes', async () => {
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        await fs.writeText(
            `${PROJECT_DIR}/workshop/description.txt`,
            'brand new line',
        );
        const result = await session.apply([
            { type: 'change', path: '/proj/workshop/description.txt' },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.incremental).toBe(2);
        expect(await fs.readText(`${MAIN_OUT}/workshop.txt`)).toContain(
            'description=brand new line',
        );
        expect(await fs.readText(`${DEV_OUT}/workshop.txt`)).toContain(
            'description=brand new line',
        );
        await session.stop();
    });

    it('rebuilds fully and re-baselines when project.json changes', async () => {
        const { host, setConfig } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        // The user renamed the mod's display name in project.json.
        const next = baseConfig();
        next.mods.my_mod = { name: 'Renamed', description: 'A mod.' };
        setConfig(next);
        // The session host reads the holder, so getPlanInput() sees it.

        const result = await session.apply([
            { type: 'change', path: '/proj/project.json' },
        ]);
        expect(result.fullRebuild).toBe(true);
        expect(result.errors).toEqual([]);
        // The regenerated mod.info now carries the new name.
        expect(
            await fs.readText(`${MAIN_OUT}/Contents/mods/my_mod/mod.info`),
        ).toContain('name=Renamed');
        await session.stop();
    });

    it('honors the variant subset the session was started with', async () => {
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start(['development']);
        expect(fs.files.has(`${MAIN_OUT}/workshop.txt`)).toBe(false);

        const result = await session.apply([
            { type: 'change', path: '/proj/my_mod/media/lua/shared/hello.lua' },
        ]);
        expect(result.incremental).toBe(1);
        expect(
            await fs.readText(
                `${DEV_OUT}/Contents/mods/my_mod_dev/media/lua/shared/hello.lua`,
            ),
        ).toBe('print("v1")');
        await session.stop();
    });

    it('collects per-action errors instead of throwing', async () => {
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        // A change event for a file that does not exist in the source tree.
        const result = await session.apply([
            { type: 'change', path: '/proj/my_mod/media/lua/ghost.lua' },
        ]);
        expect(result.errors).toHaveLength(1);
        expect(result.incremental).toBe(0);
        // The session stays usable.
        await fs.writeText(`${PROJECT_DIR}/my_mod/media/lua/real.lua`, 'ok');
        const second = await session.apply([
            { type: 'create', path: '/proj/my_mod/media/lua/real.lua' },
        ]);
        expect(second.errors).toEqual([]);
        expect(second.incremental).toBe(2);
        await session.stop();
    });

    it('serializes overlapping apply() calls in order', async () => {
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        // Fire two batches without awaiting the first.
        await fs.writeText(
            `${PROJECT_DIR}/my_mod/media/lua/shared/hello.lua`,
            'a1',
        );
        const first = session.apply([
            { type: 'change', path: '/proj/my_mod/media/lua/shared/hello.lua' },
        ]);
        await fs.writeText(
            `${PROJECT_DIR}/my_mod/media/lua/shared/hello.lua`,
            'a2',
        );
        const second = session.apply([
            { type: 'change', path: '/proj/my_mod/media/lua/shared/hello.lua' },
        ]);
        await Promise.all([first, second]);

        expect(
            await fs.readText(
                `${DEV_OUT}/Contents/mods/my_mod_dev/media/lua/shared/hello.lua`,
            ),
        ).toBe('a2');
        await session.stop();
    });

    it('apply() is a no-op after stop()', async () => {
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();
        await session.stop();

        const result = await session.apply([
            { type: 'change', path: '/proj/my_mod/media/lua/shared/hello.lua' },
        ]);
        expect(result.incremental).toBe(0);
        expect(result.fullRebuild).toBe(false);
    });

    it('skips directory events without writing them as files', async () => {
        // Watchers report directory creations like file creations (the
        // extension's FileSystemWatcher and @parcel/watcher alike).
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        // The directory has content so stat() resolves it as a directory.
        await fs.writeText(`${PROJECT_DIR}/my_mod/media/lua/sub/x.lua`, 'x');
        const result = await session.apply([
            { type: 'create', path: `${PROJECT_DIR}/my_mod/media/lua/sub` },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.ignored).toBe(1);
        expect(result.incremental).toBe(0);
        // No file was materialized at the directory path in the output.
        expect(
            fs.files.has(`${MAIN_OUT}/Contents/mods/my_mod/media/lua/sub`),
        ).toBe(false);
        // The directory's content still syncs like any file event.
        const fileResult = await session.apply([
            {
                type: 'create',
                path: `${PROJECT_DIR}/my_mod/media/lua/sub/x.lua`,
            },
        ]);
        expect(fileResult.errors).toEqual([]);
        expect(fileResult.incremental).toBe(2);
        expect(
            await fs.readText(
                `${MAIN_OUT}/Contents/mods/my_mod/media/lua/sub/x.lua`,
            ),
        ).toBe('x');
        await session.stop();
    });
});
