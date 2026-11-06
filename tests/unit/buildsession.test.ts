import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFileSystem } from '../helpers/memory-file-system';
import type { ProjectFileSystem } from '@pzstudio/platform';
import {
    BuildSession,
    BuildSessionHost,
    BuildVariant,
    classifyDelta,
    coalesceDeltas,
    FileDelta,
    summarizeApplyResult,
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
        // A write that keeps failing with a transient lock: both variants
        // fail, the distinct cause is reported once, and the session stays
        // usable for the next batch.
        let failWrites = false;
        const failingFs: ProjectFileSystem = Object.create(fs);
        failingFs.write = async (uri: string, data: Uint8Array) => {
            if (failWrites && uri.includes('/shared/hello.lua')) {
                // Both variants hit the same lock; the engine reports the
                // distinct causes once each, so the message is identical.
                throw Object.assign(
                    new Error("EBUSY: resource busy, open 'hello.lua'"),
                    { code: 'EBUSY' },
                );
            }
            await fs.write(uri, data);
        };
        const { host } = createHost(failingFs, config);
        const session = new BuildSession(host);
        await session.start();

        await fs.writeText(
            `${PROJECT_DIR}/my_mod/media/lua/shared/hello.lua`,
            'print("locked")',
        );
        failWrites = true;
        const result = await session.apply([
            { type: 'change', path: '/proj/my_mod/media/lua/shared/hello.lua' },
        ]);
        failWrites = false;
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('EBUSY');
        expect(result.incremental).toBe(0);

        // The session stays usable.
        const second = await session.apply([
            { type: 'change', path: '/proj/my_mod/media/lua/shared/hello.lua' },
        ]);
        expect(second.errors).toEqual([]);
        expect(second.incremental).toBe(2);
        expect(
            await fs.readText(
                `${MAIN_OUT}/Contents/mods/my_mod/media/lua/shared/hello.lua`,
            ),
        ).toBe('print("locked")');
        await session.stop();
    });

    it('normalizes a failed scoped plan-input fetch into result.errors', async () => {
        // The scoped phase re-reads the world through the host; when that
        // read rejects (project resolution, template lookup, source
        // snapshotting), apply() must still resolve — never throw — with
        // the failure collected and the committed baseline untouched.
        await fs.writeText(
            `${PROJECT_DIR}/my_mod/mod.info`,
            'id=my_mod\nname=My Mod\n',
        );
        const { host } = createHost(fs, config);
        let fetches = 0;
        let failFetch = false;
        const failingHost: BuildSessionHost = {
            ...host,
            getPlanInput: async () => {
                fetches += 1;
                if (failFetch) {
                    return Promise.reject(new Error('plan input unreadable'));
                }
                return host.getPlanInput();
            },
        };
        const session = new BuildSession(failingHost);
        await session.start();
        expect(fetches).toBe(1);

        await fs.writeText(
            `${PROJECT_DIR}/my_mod/mod.info`,
            'id=my_mod\nname=Renamed Mod\n',
        );
        await fs.writeText(
            `${PROJECT_DIR}/my_mod/media/lua/shared/hello.lua`,
            'print("v2")',
        );
        failFetch = true;
        const result = await session.apply([
            { type: 'change', path: `${PROJECT_DIR}/my_mod/mod.info` },
            {
                type: 'change',
                path: `${PROJECT_DIR}/my_mod/media/lua/shared/hello.lua`,
            },
        ]);
        failFetch = false;

        // Resolved with the failure collected — not a rejection, and not
        // represented as a successful scoped sync.
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('plan input unreadable');
        expect(result.scoped).toEqual([]);
        expect(result.fullRebuild).toBe(false);
        // The batch's earlier incremental phase keeps its committed
        // writes…
        expect(result.incremental).toBe(2);
        expect(
            await fs.readText(
                `${MAIN_OUT}/Contents/mods/my_mod/media/lua/shared/hello.lua`,
            ),
        ).toBe('print("v2")');
        // …while the scoped rebuild never ran: the output mod.info is
        // unchanged.
        expect(
            await fs.readText(`${MAIN_OUT}/Contents/mods/my_mod/mod.info`),
        ).toBe('id=my_mod\nname=My Mod\n');
        // Exactly one fetch for the failed batch: no retry, no replay.
        expect(fetches).toBe(2);

        // The baseline survived and the queue accepts the next batch: the
        // same scoped change rebuilds once the host reads again.
        const second = await session.apply([
            { type: 'change', path: `${PROJECT_DIR}/my_mod/mod.info` },
        ]);
        expect(second.errors).toEqual([]);
        expect(second.scoped).toEqual([
            { modId: 'my_mod', variants: ['main', 'development'] },
        ]);
        expect(
            await fs.readText(`${MAIN_OUT}/Contents/mods/my_mod/mod.info`),
        ).toContain('name=Renamed Mod');
        await session.stop();
    });

    it('normalizes a non-Error scoped plan-input rejection with a usable message', async () => {
        const { host } = createHost(fs, config);
        let rejectString = false;
        const failingHost: BuildSessionHost = {
            ...host,
            getPlanInput: async () => {
                if (rejectString) {
                    // A non-Error rejection value: describeError's
                    // String(e) fallback must still produce a usable
                    // message at this boundary.
                    return Promise.reject('plan input vanished');
                }
                return host.getPlanInput();
            },
        };
        const session = new BuildSession(failingHost);
        await session.start();

        rejectString = true;
        const result = await session.apply([
            { type: 'change', path: `${PROJECT_DIR}/my_mod/mod.info` },
        ]);
        expect(result.errors).toEqual(['plan input vanished']);
        expect(result.scoped).toEqual([]);
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

describe('BuildSession transient sources and batch summary', () => {
    let fs: MemoryFileSystem;
    let config: IProjectConfig;

    beforeEach(async () => {
        fs = new MemoryFileSystem();
        config = baseConfig();
        await seedProject(fs, config);
    });

    it('skips change events whose source vanished before the sync', async () => {
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        // Watchers deliver events for transient files too (atomic saves,
        // temp copies like "_init.lua.git"); by the time the batch runs the
        // file is gone. That is not a sync failure.
        const result = await session.apply([
            {
                type: 'change',
                path: '/proj/my_mod/media/lua/client/mod/_init.lua.git',
            },
        ]);

        expect(result.errors).toEqual([]);
        expect(result.incremental).toBe(0);
        expect(result.ignored).toBe(1);
        await session.stop();
    });

    it('skips a vanished create and still syncs the real save afterwards', async () => {
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        const vanished = await session.apply([
            { type: 'create', path: '/proj/my_mod/media/lua/new.lua' },
        ]);
        expect(vanished.errors).toEqual([]);
        expect(vanished.ignored).toBe(1);

        await fs.writeText(`${PROJECT_DIR}/my_mod/media/lua/new.lua`, '-- new');
        const real = await session.apply([
            { type: 'create', path: '/proj/my_mod/media/lua/new.lua' },
        ]);
        expect(real.errors).toEqual([]);
        expect(real.incremental).toBe(2);
        expect(
            await fs.readText(
                `${MAIN_OUT}/Contents/mods/my_mod/media/lua/new.lua`,
            ),
        ).toBe('-- new');
        await session.stop();
    });

    it('summarizeApplyResult describes what a batch did', () => {
        expect(
            summarizeApplyResult({
                incremental: 2,
                scoped: [],
                fullRebuild: false,
                ignored: 0,
                errors: [],
            }),
        ).toBe('2 file(s) synced');
        expect(
            summarizeApplyResult({
                incremental: 0,
                scoped: [
                    { modId: 'a', variants: ['main'] },
                    { modId: 'b', variants: ['main'] },
                ],
                fullRebuild: false,
                ignored: 0,
                errors: [],
            }),
        ).toBe('re-synced mod(s): a, b');
        expect(
            summarizeApplyResult({
                incremental: 1,
                scoped: [],
                fullRebuild: true,
                ignored: 0,
                errors: [],
            }),
        ).toBe('1 file(s) synced; full rebuild');
        expect(
            summarizeApplyResult({
                incremental: 0,
                scoped: [],
                fullRebuild: false,
                ignored: 5,
                errors: [],
            }),
        ).toBe('');
    });
});

/**
 * E1 Stage-1 ownership guard, scoped by DEC-2=c (Owner, 2026-11-07): the
 * fail-closed boundary applies to destinations inside a configured mod's
 * source folder (the case-6 layout, doc 15 §1); out-of-mod output roots
 * keep the committed adoption behavior — a recorded, temporary deviation
 * from doc 18 B1-A until the receipt ledger provides cross-session
 * ownership evidence. Every fixture below therefore plants foreign content
 * at an in-mod root unless it is explicitly pinning the out-of-mod adopt.
 */
describe('BuildSession E1 ownership guard (fail-closed output mutation)', () => {
    let fs: MemoryFileSystem;
    let config: IProjectConfig;

    beforeEach(async () => {
        fs = new MemoryFileSystem();
        config = baseConfig();
        await seedProject(fs, config);
    });

    it('full rebuild fails closed on a non-empty unowned in-mod root, preserves it, and adopts once cleared', async () => {
        const { host, setConfig } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        // A foreign, non-empty destination at the future output root inside
        // the mod source (case-6): the adoption full rebuild must refuse to
        // delete it (E1 fail-closed) instead of silently replacing it with
        // generated output. A second foreign file exercises the
        // incremental-delete window after the failed adoption re-bases the
        // session onto the new config.
        const moved = baseConfig();
        moved.outdir = '/proj/my_mod/nested-out';
        setConfig(moved);
        await fs.writeText(
            '/proj/my_mod/nested-out/Sync Project/Contents/mods/foreign/precious.lua',
            'user data',
        );
        await fs.writeText(
            '/proj/my_mod/nested-out/Sync Project/Contents/mods/my_mod/media/lua/victim.lua',
            'victim',
        );

        const refused = await session.apply([
            { type: 'change', path: '/proj/project.json' },
        ]);
        // The main variant's destination is refused and reported through
        // the existing error contract — never a silent success…
        expect(refused.errors).toHaveLength(1);
        expect(refused.errors[0]).toContain('Refusing full rebuild removeDir');
        expect(refused.errors[0]).toContain(
            '/proj/my_mod/nested-out/Sync Project',
        );
        expect(refused.fullRebuild).toBe(false);
        // …the development variant's destination was absent (safe to
        // create) and still builds…
        expect(
            await fs.readText(
                '/proj/my_mod/nested-out/Sync Project - dev_branch/Contents/mods/my_mod_dev/media/lua/shared/hello.lua',
            ),
        ).toBe('print("v1")');
        // …and the unproven content is preserved byte-exact, with nothing
        // written into the refused destination.
        expect(
            await fs.readText(
                '/proj/my_mod/nested-out/Sync Project/Contents/mods/foreign/precious.lua',
            ),
        ).toBe('user data');
        expect(
            fs.files.has('/proj/my_mod/nested-out/Sync Project/workshop.txt'),
        ).toBe(false);
        // The former root is untouched.
        expect(fs.files.has(`${MAIN_OUT}/workshop.txt`)).toBe(true);

        // An incremental delete below the unowned in-mod root fails closed
        // too — the M6–M8 destructive window.
        const deleteRefused = await session.apply([
            { type: 'delete', path: '/proj/my_mod/media/lua/victim.lua' },
        ]);
        expect(deleteRefused.errors).toHaveLength(1);
        expect(deleteRefused.errors[0]).toContain(
            'Refusing incremental delete',
        );
        expect(
            await fs.readText(
                '/proj/my_mod/nested-out/Sync Project/Contents/mods/my_mod/media/lua/victim.lua',
            ),
        ).toBe('victim');

        // Recovery: once the destination is cleared, the same batch adopts
        // it (empty destinations build) and the session continues.
        await fs.delete('/proj/my_mod/nested-out', { recursive: true });
        const adopted = await session.apply([
            { type: 'change', path: '/proj/project.json' },
        ]);
        expect(adopted.errors).toEqual([]);
        expect(adopted.fullRebuild).toBe(true);
        expect(
            await fs.readText(
                '/proj/my_mod/nested-out/Sync Project/Contents/mods/my_mod/media/lua/shared/hello.lua',
            ),
        ).toBe('print("v1")');

        // Inside output the session itself produced, deletes proceed.
        const deleted = await session.apply([
            { type: 'delete', path: '/proj/my_mod/media/lua/shared/util.lua' },
        ]);
        expect(deleted.errors).toEqual([]);
        expect(deleted.incremental).toBe(2);
        expect(
            fs.files.has(
                '/proj/my_mod/nested-out/Sync Project/Contents/mods/my_mod/media/lua/shared/util.lua',
            ),
        ).toBe(false);
        await session.stop();
    });

    it('hidden dot entries defeat the empty-destination check', async () => {
        const { host, setConfig } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        // Only hidden content at the future in-mod variant root: an
        // enumeration that skipped dot entries would call this destination
        // empty and delete the user's data.
        const moved = baseConfig();
        moved.outdir = '/proj/my_mod/dot-out';
        setConfig(moved);
        await fs.writeText(
            '/proj/my_mod/dot-out/Sync Project/.git/config',
            'git',
        );
        await fs.writeText('/proj/my_mod/dot-out/Sync Project/.hidden', 'h');

        const result = await session.apply([
            { type: 'change', path: '/proj/project.json' },
        ]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('/proj/my_mod/dot-out/Sync Project');
        expect(
            await fs.readText('/proj/my_mod/dot-out/Sync Project/.git/config'),
        ).toBe('git');
        expect(
            await fs.readText('/proj/my_mod/dot-out/Sync Project/.hidden'),
        ).toBe('h');
        await session.stop();
    });

    it('scoped rebuild fails closed on a foreign mod folder at an unowned root', async () => {
        const { host, setConfig } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        // An out-of-band outdir move into the mod source (no project.json
        // delta): a mod.info edit re-reads the config in the scoped phase,
        // so the scoped plan's removeDir targets the NEW in-mod root. A
        // foreign file inside the future mod folder must stop it before any
        // mutation.
        const moved = baseConfig();
        moved.outdir = '/proj/my_mod/scoped-out';
        setConfig(moved);
        await fs.writeText(
            '/proj/my_mod/scoped-out/Sync Project/Contents/mods/my_mod/keepme.lua',
            'user',
        );

        const result = await session.apply([
            { type: 'change', path: '/proj/my_mod/mod.info' },
        ]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('Refusing scoped rebuild removeDir');
        expect(result.errors[0]).toContain(
            '/proj/my_mod/scoped-out/Sync Project/Contents/mods/my_mod',
        );
        // Attempted scoped work is still reported alongside the errors
        // (the existing failed-scoped convention) — never a clean success.
        expect(result.scoped).toEqual([
            { modId: 'my_mod', variants: ['main', 'development'] },
        ]);
        // The foreign file survived and the engine wrote nothing into the
        // refused destination…
        expect(
            await fs.readText(
                '/proj/my_mod/scoped-out/Sync Project/Contents/mods/my_mod/keepme.lua',
            ),
        ).toBe('user');
        expect(
            fs.files.has(
                '/proj/my_mod/scoped-out/Sync Project/Contents/mods/my_mod/mod.info',
            ),
        ).toBe(false);
        // …while the absent dev destination built normally.
        expect(
            await fs.readText(
                '/proj/my_mod/scoped-out/Sync Project - dev_branch/Contents/mods/my_mod_dev/media/lua/shared/hello.lua',
            ),
        ).toBe('print("v1")');
        await session.stop();
    });

    it('start() adopts a non-empty out-of-mod destination — the committed behavior DEC-2=c preserves', async () => {
        // DEC-2=c: destinations outside every mod folder keep the committed
        // adoption behavior — a fresh session may replace its configured
        // output root exactly as `pzstudio build` always has, foreign
        // content included. This is the recorded deviation from doc 18
        // B1-A until the receipt ledger (doc 18 §2–§9) provides
        // cross-session ownership evidence; the in-mod equivalent refuses.
        await fs.writeText(
            `${MAIN_OUT}/Contents/mods/foreign/precious.lua`,
            'user data',
        );
        const { host } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();
        // The root was replaced with generated output…
        expect(fs.files.has(`${MAIN_OUT}/workshop.txt`)).toBe(true);
        expect(
            fs.files.has(`${MAIN_OUT}/Contents/mods/foreign/precious.lua`),
        ).toBe(false);
        // …and a fresh session adopts the non-empty root again: the
        // repeated `pzstudio build` / watch-restart loop stays intact for
        // out-of-mod roots.
        const second = new BuildSession(host);
        await second.start();
        expect(fs.files.has(`${MAIN_OUT}/workshop.txt`)).toBe(true);
        await second.stop();
    });

    it('start() refuses per variant regardless of iteration order — a foreign in-mod dev-only root is preserved too', async () => {
        // DEC-2=c: the refusal applies per variant at in-mod destinations.
        const case6 = baseConfig();
        case6.outdir = '/proj/my_mod/nested';
        await fs.writeText(
            '/proj/my_mod/nested/Sync Project - dev_branch/Contents/mods/foreign/keep.lua',
            'user data',
        );
        const { host, setConfig } = createHost(fs, config);
        setConfig(case6);
        const session = new BuildSession(host);
        await expect(session.start()).rejects.toThrow(
            /Refusing full rebuild removeDir/,
        );
        expect(
            await fs.readText(
                '/proj/my_mod/nested/Sync Project - dev_branch/Contents/mods/foreign/keep.lua',
            ),
        ).toBe('user data');
        expect(
            fs.files.has(
                '/proj/my_mod/nested/Sync Project - dev_branch/workshop.txt',
            ),
        ).toBe(false);
        // Variant independence: the absent main destination still built.
        expect(
            fs.files.has('/proj/my_mod/nested/Sync Project/workshop.txt'),
        ).toBe(true);
    });

    it('after a refused adoption, later incremental writes cannot overwrite foreign in-mod content', async () => {
        const { host, setConfig } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        const moved = baseConfig();
        moved.outdir = '/proj/my_mod/nested-out';
        setConfig(moved);
        // A foreign file at exactly the path a later source change would
        // write, inside the otherwise non-empty unowned in-mod root.
        await fs.writeText(
            '/proj/my_mod/nested-out/Sync Project/Contents/mods/my_mod/media/lua/shared/hello.lua',
            'foreign bytes',
        );
        const refused = await session.apply([
            { type: 'change', path: '/proj/project.json' },
        ]);
        expect(refused.errors).toHaveLength(1);

        // The failed adoption re-based the session onto the new config: a
        // later plain change must not silently write into the unowned root
        // — the decision is made at the variant-root boundary, so a missing
        // leaf elsewhere in the tree proves nothing either.
        await fs.writeText(
            `${PROJECT_DIR}/my_mod/media/lua/shared/hello.lua`,
            'print("v2")',
        );
        const write = await session.apply([
            {
                type: 'change',
                path: '/proj/my_mod/media/lua/shared/hello.lua',
            },
        ]);
        expect(write.errors).toHaveLength(1);
        expect(write.errors[0]).toContain('Refusing incremental write');
        expect(write.errors[0]).toContain(
            '/proj/my_mod/nested-out/Sync Project',
        );
        // The foreign same-path file is intact.
        expect(
            await fs.readText(
                '/proj/my_mod/nested-out/Sync Project/Contents/mods/my_mod/media/lua/shared/hello.lua',
            ),
        ).toBe('foreign bytes');
        await session.stop();
    });

    it('workshop-text and preview writes respect the ownership boundary', async () => {
        const { host, setConfig } = createHost(fs, config);
        const session = new BuildSession(host);
        await session.start();

        const moved = baseConfig();
        moved.outdir = '/proj/my_mod/nested-out';
        setConfig(moved);
        // Foreign metadata at the exact rewrite target inside the unowned
        // in-mod main root.
        await fs.writeText(
            '/proj/my_mod/nested-out/Sync Project/workshop.txt',
            'user text',
        );
        const refused = await session.apply([
            { type: 'change', path: '/proj/project.json' },
        ]);
        expect(refused.errors).toHaveLength(1);

        await fs.writeText(
            `${PROJECT_DIR}/workshop/description.txt`,
            'brand new line',
        );
        const textResult = await session.apply([
            { type: 'change', path: '/proj/workshop/description.txt' },
        ]);
        expect(textResult.errors).toHaveLength(1);
        expect(textResult.errors[0]).toContain('Refusing workshop.txt rewrite');
        // The foreign metadata is intact; the owned dev root still rewrote.
        expect(
            await fs.readText(
                '/proj/my_mod/nested-out/Sync Project/workshop.txt',
            ),
        ).toBe('user text');
        expect(
            await fs.readText(
                '/proj/my_mod/nested-out/Sync Project - dev_branch/workshop.txt',
            ),
        ).toContain('brand new line');

        await fs.writeText(`${PROJECT_DIR}/workshop/preview.png`, 'PNGDATA');
        const previewResult = await session.apply([
            { type: 'change', path: '/proj/workshop/preview.png' },
        ]);
        expect(previewResult.errors).toHaveLength(1);
        expect(previewResult.errors[0]).toContain('Refusing preview.png copy');
        expect(
            fs.files.has('/proj/my_mod/nested-out/Sync Project/preview.png'),
        ).toBe(false);
        expect(
            fs.files.has(
                '/proj/my_mod/nested-out/Sync Project - dev_branch/preview.png',
            ),
        ).toBe(true);
        await session.stop();
    });
});
