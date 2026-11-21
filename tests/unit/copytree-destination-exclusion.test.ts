import { describe, it, expect } from 'vitest';
import {
    DEV_OUT_PREFIX,
    F23Fs,
    ListOrder,
    MAIN_OUT_PREFIX,
    MOD,
    MOD_ROOT,
    PROJECT_DIR,
    configFor,
    createHost,
    keysUnder,
    maxNesting,
    seedProject,
    variantRoot,
} from '../helpers/copytree-f23-harness';
import { BuildSession } from '../../packages/core/src/buildsession';
import { executeFileOperations } from '../../packages/core/src/execute';
import {
    collectIncludedModIds,
    planBuild,
} from '../../packages/core/src/buildplan';

describe('F23-R2: clean case-6 build from an empty destination', () => {
    it.each<ListOrder>(['alphabetical', 'insertion', 'reverse'])(
        'bounds both variants under %s listing order with the exact planned output',
        async (order) => {
            const fs = new F23Fs();
            fs.order = order;
            fs.writeCap = 200;
            fs.listCap = 4000;
            const holder = {
                config: configFor(`${MOD_ROOT}/gen`, {
                    excludes: ['staging'],
                }),
            };
            await seedProject(fs, holder.config);
            const { host } = createHost(fs, holder);

            const session = new BuildSession(host);
            await session.start(['main', 'development']);

            const mainRoot = variantRoot(`${MOD_ROOT}/gen`, 'main');
            const devRoot = variantRoot(`${MOD_ROOT}/gen`, 'development');

            expect(fs.writes.length).toBeLessThanOrEqual(120);

            const mainMod = `${mainRoot}/Contents/mods/my_mod`;
            expect(await fs.readText(`${mainMod}/media/lua/hello.lua`)).toBe(
                'print("v1")',
            );
            expect(await fs.readText(`${mainMod}/media/lua/util.lua`)).toBe(
                'print("util")',
            );
            expect(await fs.readText(`${mainMod}/media/other.lua`)).toBe(
                'other',
            );
            expect(
                await fs.readText(`${mainRoot}/Contents/template-file.txt`),
            ).toBe('tpl');

            expect(fs.files.has(`${mainMod}/media/old.lua`)).toBe(false);
            expect(fs.files.has(`${mainMod}/scratch/x.lua`)).toBe(false);
            expect(fs.files.has(`${mainMod}/.gitkeep`)).toBe(false);
            expect(fs.files.has(`${mainMod}/.dotfile`)).toBe(false);
            expect(fs.files.has(`${mainMod}/.pzstudioignore`)).toBe(false);
            expect(fs.files.has(`${mainMod}/staging/keep.lua`)).toBe(false);

            expect(await fs.readText(`${mainMod}/mod.info`)).toBe(
                'id=my_mod\nname=My Mod\ndescription=A mod.',
            );
            expect(await fs.readText(`${mainRoot}/workshop.txt`)).toBe(
                'version=1\nid=12345\ntitle=Sync Project\ntags=\nvisibility=public',
            );

            const devMod = `${devRoot}/Contents/mods/my_mod_dev`;
            expect(await fs.readText(`${devMod}/media/lua/hello.lua`)).toBe(
                'print("v1")',
            );
            expect(await fs.readText(`${devMod}/mod.info`)).toBe(
                'id=my_mod_dev\nname=My Mod\ndescription=A mod.',
            );
            expect(await fs.readText(`${devRoot}/workshop.txt`)).toBe(
                'version=1\ntitle=Sync Project - dev_branch\ntags=\nvisibility=unlisted',
            );

            expect(keysUnder(fs, mainRoot)).toEqual([
                `${mainRoot}/.pzstudio-output.json`,
                `${mainRoot}/Contents/mods/my_mod/gen/Sync Project/Contents/template-file.txt`,
                `${mainRoot}/Contents/mods/my_mod/media/lua/hello.lua`,
                `${mainRoot}/Contents/mods/my_mod/media/lua/util.lua`,
                `${mainRoot}/Contents/mods/my_mod/media/other.lua`,
                `${mainRoot}/Contents/mods/my_mod/mod.info`,
                `${mainRoot}/Contents/template-file.txt`,
                `${mainRoot}/workshop.txt`,
            ]);
            expect(keysUnder(fs, devRoot)).toEqual([
                `${devRoot}/.pzstudio-output.json`,
                `${devRoot}/Contents/mods/my_mod_dev/gen/Sync Project - dev_branch/Contents/template-file.txt`,
                `${devRoot}/Contents/mods/my_mod_dev/gen/Sync Project/Contents/mods/my_mod/gen/Sync Project/Contents/template-file.txt`,
                `${devRoot}/Contents/mods/my_mod_dev/gen/Sync Project/Contents/mods/my_mod/media/lua/hello.lua`,
                `${devRoot}/Contents/mods/my_mod_dev/gen/Sync Project/Contents/mods/my_mod/media/lua/util.lua`,
                `${devRoot}/Contents/mods/my_mod_dev/gen/Sync Project/Contents/mods/my_mod/media/other.lua`,
                `${devRoot}/Contents/mods/my_mod_dev/gen/Sync Project/Contents/mods/my_mod/mod.info`,
                `${devRoot}/Contents/mods/my_mod_dev/gen/Sync Project/Contents/template-file.txt`,
                `${devRoot}/Contents/mods/my_mod_dev/gen/Sync Project/workshop.txt`,
                `${devRoot}/Contents/mods/my_mod_dev/media/lua/hello.lua`,
                `${devRoot}/Contents/mods/my_mod_dev/media/lua/util.lua`,
                `${devRoot}/Contents/mods/my_mod_dev/media/other.lua`,
                `${devRoot}/Contents/mods/my_mod_dev/mod.info`,
                `${devRoot}/Contents/template-file.txt`,
                `${devRoot}/workshop.txt`,
            ]);
            expect(
                maxNesting(keysUnder(fs, `${MOD_ROOT}/gen`)),
            ).toBeLessThanOrEqual(2);
        },
    );

    it('produces identical output and identical write counts under every listing order', async () => {
        const perOrder: Record<ListOrder, { keys: string[]; writes: number }> =
            {} as never;
        for (const order of [
            'alphabetical',
            'insertion',
            'reverse',
        ] as ListOrder[]) {
            const fs = new F23Fs();
            fs.order = order;
            fs.writeCap = 200;
            fs.listCap = 4000;
            const holder = {
                config: configFor(`${MOD_ROOT}/gen`, {
                    excludes: ['staging'],
                }),
            };
            await seedProject(fs, holder.config);
            const { host } = createHost(fs, holder);
            const session = new BuildSession(host);
            await session.start(['main', 'development']);
            perOrder[order] = {
                keys: keysUnder(fs, `${MOD_ROOT}/gen`),
                writes: fs.writes.length,
            };
        }
        expect(perOrder.alphabetical.keys).toEqual(perOrder.insertion.keys);
        expect(perOrder.alphabetical.keys).toEqual(perOrder.reverse.keys);
        expect(perOrder.alphabetical.writes).toBe(perOrder.insertion.writes);
        expect(perOrder.alphabetical.writes).toBe(perOrder.reverse.writes);
    });
});

describe('F23-R1: stale output root adoption (G3-F23c)', () => {
    async function runAdoption(order: ListOrder): Promise<{
        fs: F23Fs;
        genAKeys: string[];
        genAContents: Map<string, Buffer>;
        nestingBefore: number;
    }> {
        const fs = new F23Fs();
        fs.order = order;
        fs.writeCap = 150;
        fs.listCap = 6000;
        const holder = { config: configFor(`${MOD_ROOT}/gen-a`) };
        await seedProject(fs, holder.config);
        const { host } = createHost(fs, holder);

        const session = new BuildSession(host);
        await session.start(['main', 'development']);

        expect(
            await fs.readText(
                `${variantRoot(`${MOD_ROOT}/gen-a`, 'main')}/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe('print("v1")');

        const genAKeys = keysUnder(fs, `${MOD_ROOT}/gen-a`);
        const genAContents = new Map(
            genAKeys.map((key) => [key, Buffer.from(fs.files.get(key)!)]),
        );

        const nestingBefore = maxNesting(keysUnder(fs, MOD_ROOT));
        fs.writes = [];
        fs.deletes = [];
        fs.writeCap = 400;
        holder.config = configFor(`${MOD_ROOT}/gen-b`);
        const result = await session.apply([
            { type: 'change', path: `${PROJECT_DIR}\\project.json` },
        ]);
        expect(result.fullRebuild).toBe(true);
        expect(result.errors).toEqual([]);
        return { fs, genAKeys, genAContents, nestingBefore };
    }

    it.each<ListOrder>(['alphabetical', 'insertion', 'reverse'])(
        'bounds the adoption rebuild under %s listing order',
        async (order) => {
            const { fs, genAKeys, genAContents, nestingBefore } =
                await runAdoption(order);

            expect(fs.writes.length).toBeLessThanOrEqual(300);

            const mainRoot = variantRoot(`${MOD_ROOT}/gen-b`, 'main');
            const devRoot = variantRoot(`${MOD_ROOT}/gen-b`, 'development');

            for (const [root, modId, modInfo] of [
                [
                    mainRoot,
                    'my_mod',
                    'id=my_mod\nname=My Mod\ndescription=A mod.',
                ],
                [
                    devRoot,
                    'my_mod_dev',
                    'id=my_mod_dev\nname=My Mod\ndescription=A mod.',
                ],
            ] as const) {
                expect(
                    await fs.readText(
                        `${root}/Contents/mods/${modId}/media/lua/hello.lua`,
                    ),
                ).toBe('print("v1")');
                expect(
                    await fs.readText(
                        `${root}/Contents/mods/${modId}/media/lua/util.lua`,
                    ),
                ).toBe('print("util")');
                expect(
                    await fs.readText(
                        `${root}/Contents/mods/${modId}/mod.info`,
                    ),
                ).toBe(modInfo);
                expect(
                    await fs.readText(`${root}/Contents/template-file.txt`),
                ).toBe('tpl');
                expect(await fs.readText(`${root}/workshop.txt`)).toContain(
                    'title=Sync Project',
                );
            }

            expect(keysUnder(fs, `${MOD_ROOT}/gen-a`)).toEqual(genAKeys);
            for (const [key, content] of genAContents) {
                expect(Buffer.from(fs.files.get(key)!)).toEqual(content);
            }

            expect(fs.deletes.sort()).toEqual(
                [
                    `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}`,
                    `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}/.pzstudio-mkdir`,
                    `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}/.pzstudio-output.json.tmp`,
                    `${MOD_ROOT}/gen-b/${DEV_OUT_PREFIX}`,
                    `${MOD_ROOT}/gen-b/${DEV_OUT_PREFIX}/.pzstudio-mkdir`,
                    `${MOD_ROOT}/gen-b/${DEV_OUT_PREFIX}/.pzstudio-output.json.tmp`,
                ].sort(),
            );

            expect(
                maxNesting(keysUnder(fs, `${MOD_ROOT}/gen-b`)),
            ).toBeLessThanOrEqual(nestingBefore + 2);
        },
    );

    it('produces identical adoption outputs under every listing order', async () => {
        const perOrder: Record<ListOrder, string[]> = {} as never;
        for (const order of [
            'alphabetical',
            'insertion',
            'reverse',
        ] as ListOrder[]) {
            const { fs } = await runAdoption(order);
            perOrder[order] = keysUnder(fs, `${MOD_ROOT}/gen-b`);
        }
        expect(perOrder.alphabetical).toEqual(perOrder.insertion);
        expect(perOrder.alphabetical).toEqual(perOrder.reverse);
    });
});

describe('F23-R3: destination exclusion precision', () => {
    it('excludes only the operation destination subtree — collide.lua, prefix siblings and stale roots survive', async () => {
        const fs = new F23Fs();
        fs.order = 'alphabetical';
        fs.writeCap = 150;
        fs.listCap = 6000;
        const holder = { config: configFor(`${MOD_ROOT}/gen-a`) };
        await seedProject(fs, holder.config);
        const { host } = createHost(fs, holder);
        const session = new BuildSession(host);
        await session.start(['main', 'development']);

        await fs.writeText(`${MOD_ROOT}/gen-b/staging/collide.lua`, 'collide');
        await fs.writeText(`${MOD_ROOT}/my_mod_x/nested/other.lua`, 'sibling');
        await fs.writeText(`${MOD_ROOT}/gen-b2/nested/other.lua`, 'prefix');

        fs.writes = [];
        fs.writeCap = 400;
        const nestingBefore = maxNesting(keysUnder(fs, MOD_ROOT));
        holder.config = configFor(`${MOD_ROOT}/gen-b`);
        const result = await session.apply([
            { type: 'change', path: `${PROJECT_DIR}\\project.json` },
        ]);
        expect(result.fullRebuild).toBe(true);
        expect(result.errors).toEqual([]);
        expect(fs.writes.length).toBeLessThanOrEqual(300);

        const mainRoot = variantRoot(`${MOD_ROOT}/gen-b`, 'main');
        const devRoot = variantRoot(`${MOD_ROOT}/gen-b`, 'development');

        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/gen-b/staging/collide.lua`,
            ),
        ).toBe('collide');
        expect(
            await fs.readText(
                `${devRoot}/Contents/mods/my_mod_dev/gen-b/staging/collide.lua`,
            ),
        ).toBe('collide');

        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/my_mod_x/nested/other.lua`,
            ),
        ).toBe('sibling');
        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/gen-b2/nested/other.lua`,
            ),
        ).toBe('prefix');

        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/gen-a/Sync Project/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe('print("v1")');

        expect(
            maxNesting(keysUnder(fs, `${MOD_ROOT}/gen-b`)),
        ).toBeLessThanOrEqual(nestingBefore + 2);
        expect(
            fs.files.has(
                `${mainRoot}/Contents/mods/my_mod/gen-b/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/mod.info`,
            ),
        ).toBe(false);
    });
});

describe('F23-R4: other build paths', () => {
    it('plain full build via planBuild + executor with a non-case-6 outdir is bounded and exact (both variants)', async () => {
        const fs = new F23Fs();
        fs.order = 'alphabetical';
        fs.writeCap = 200;
        fs.listCap = 4000;
        const holder = {
            config: configFor('/out', {
                excludes: ['staging'],
                devOnlySecondMod: true,
            }),
        };
        await seedProject(fs, holder.config);
        const { host } = createHost(fs, holder);
        const baseInput = await host.getPlanInput();

        expect(collectIncludedModIds(holder.config, 'main')).toEqual([
            'my_mod',
        ]);
        expect(collectIncludedModIds(holder.config, 'development')).toEqual([
            'my_mod',
            'dev_mod',
        ]);

        await executeFileOperations(
            fs,
            planBuild({ ...baseInput, variant: 'main' }),
        );
        await executeFileOperations(
            fs,
            planBuild({ ...baseInput, variant: 'development' }),
        );

        expect(fs.writes.length).toBeLessThanOrEqual(120);
        const mainRoot = variantRoot('/out', 'main');
        const devRoot = variantRoot('/out', 'development');
        expect(maxNesting(keysUnder(fs, '/out'))).toBe(1);
        expect(keysUnder(fs, mainRoot)).toEqual([
            `${mainRoot}/Contents/mods/my_mod/media/lua/hello.lua`,
            `${mainRoot}/Contents/mods/my_mod/media/lua/util.lua`,
            `${mainRoot}/Contents/mods/my_mod/media/other.lua`,
            `${mainRoot}/Contents/mods/my_mod/mod.info`,
            `${mainRoot}/Contents/template-file.txt`,
            `${mainRoot}/workshop.txt`,
        ]);
        expect(keysUnder(fs, devRoot)).toEqual([
            `${devRoot}/Contents/mods/dev_mod_dev/mod.info`,
            `${devRoot}/Contents/mods/my_mod_dev/media/lua/hello.lua`,
            `${devRoot}/Contents/mods/my_mod_dev/media/lua/util.lua`,
            `${devRoot}/Contents/mods/my_mod_dev/media/other.lua`,
            `${devRoot}/Contents/mods/my_mod_dev/mod.info`,
            `${devRoot}/Contents/template-file.txt`,
            `${devRoot}/workshop.txt`,
        ]);
        expect(
            await fs.readText(`${devRoot}/Contents/mods/dev_mod_dev/mod.info`),
        ).toBe('id=dev_mod_dev\nname=Dev Mod\ndescription=d.');
        expect(await fs.readText(`${mainRoot}/workshop.txt`)).toBe(
            'version=1\nid=12345\ntitle=Sync Project\ntags=\nvisibility=public',
        );
        expect(await fs.readText(`${devRoot}/workshop.txt`)).toBe(
            'version=1\ntitle=Sync Project - dev_branch\ntags=\nvisibility=unlisted',
        );
    });

    it('plain full build (no session) with a case-6 outdir is bounded under adverse listing orders', async () => {
        for (const order of [
            'alphabetical',
            'insertion',
            'reverse',
        ] as ListOrder[]) {
            const fs = new F23Fs();
            fs.order = order;
            fs.writeCap = 200;
            fs.listCap = 4000;
            const holder = { config: configFor(`${MOD_ROOT}/gen`) };
            await seedProject(fs, holder.config);
            const { host } = createHost(fs, holder);
            const baseInput = await host.getPlanInput();
            const nestingBefore = maxNesting(keysUnder(fs, MOD_ROOT));
            await executeFileOperations(
                fs,
                planBuild({ ...baseInput, variant: 'main' }),
            );
            await executeFileOperations(
                fs,
                planBuild({ ...baseInput, variant: 'development' }),
            );
            expect(fs.writes.length).toBeLessThanOrEqual(150);
            expect(
                maxNesting(keysUnder(fs, `${MOD_ROOT}/gen`)),
            ).toBeLessThanOrEqual(nestingBefore + 2);
            expect(
                await fs.readText(
                    `${variantRoot(`${MOD_ROOT}/gen`, 'main')}/Contents/mods/my_mod/media/lua/hello.lua`,
                ),
            ).toBe('print("v1")');
        }
    });

    it('DevSync full rebuild without adoption (same root) stays bounded and exact', async () => {
        const fs = new F23Fs();
        fs.order = 'alphabetical';
        fs.writeCap = 150;
        fs.listCap = 6000;
        const holder = { config: configFor(`${MOD_ROOT}/gen`) };
        await seedProject(fs, holder.config);
        const { host } = createHost(fs, holder);
        const session = new BuildSession(host);
        await session.start(['main', 'development']);

        fs.writes = [];
        const next = configFor(`${MOD_ROOT}/gen`);
        (next.workshop as { tags: string[] }).tags = ['newtag'];
        holder.config = next;
        const result = await session.apply([
            { type: 'change', path: `${PROJECT_DIR}\\project.json` },
        ]);
        expect(result.fullRebuild).toBe(true);
        expect(result.errors).toEqual([]);
        expect(fs.writes.length).toBeLessThanOrEqual(150);
        expect(
            await fs.readText(
                `${variantRoot(`${MOD_ROOT}/gen`, 'main')}/workshop.txt`,
            ),
        ).toBe(
            'version=1\nid=12345\ntitle=Sync Project\ntags=newtag\nvisibility=public',
        );
    });

    it('scoped rebuild (mod.info delta) in a case-6 layout with a stale sibling root is bounded and exact (both variants)', async () => {
        const fs = new F23Fs();
        fs.order = 'alphabetical';
        fs.writeCap = 150;
        fs.listCap = 6000;
        const holder = { config: configFor(`${MOD_ROOT}/gen-b`) };
        await seedProject(fs, holder.config, { withSourceModInfo: true });
        await fs.writeText(
            `${MOD_ROOT}/gen-a/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/media/lua/hello.lua`,
            'stale',
        );
        const { host } = createHost(fs, holder);
        const session = new BuildSession(host);
        await session.start(['main', 'development']);

        const nestingBefore = maxNesting(keysUnder(fs, MOD_ROOT));
        fs.writes = [];
        fs.deletes = [];
        await fs.writeText(
            `${MOD_ROOT}/mod.info`,
            'id=my_mod\nname=My Mod v2\n',
        );
        const result = await session.apply([
            { type: 'change', path: `${MOD_ROOT}\\mod.info` },
        ]);
        expect(result.fullRebuild).toBe(false);
        expect(result.errors).toEqual([]);
        expect(result.scoped).toEqual([
            { modId: MOD, variants: ['main', 'development'] },
        ]);

        expect(fs.writes.length).toBeLessThanOrEqual(100);

        const mainRoot = variantRoot(`${MOD_ROOT}/gen-b`, 'main');
        const devRoot = variantRoot(`${MOD_ROOT}/gen-b`, 'development');

        expect(
            await fs.readText(`${mainRoot}/Contents/mods/my_mod/mod.info`),
        ).toBe('id=my_mod\nname=My Mod v2\n');
        expect(
            await fs.readText(`${devRoot}/Contents/mods/my_mod_dev/mod.info`),
        ).toBe('id=my_mod_dev\nname=My Mod v2\n');
        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe('print("v1")');
        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/gen-a/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe('stale');
        expect(
            maxNesting(keysUnder(fs, `${MOD_ROOT}/gen-b`)),
        ).toBeLessThanOrEqual(nestingBefore + 2);

        expect(fs.deletes.sort()).toEqual(
            [
                `${mainRoot}/Contents/mods/my_mod`,
                `${devRoot}/Contents/mods/my_mod_dev`,
                `${mainRoot}/.pzstudio-mkdir`,
                `${devRoot}/.pzstudio-mkdir`,
            ].sort(),
        );
    });
});

describe('F23-R5: source protection boundary', () => {
    it('adoption refuses a non-empty future variant folder before any mutation (E1 fail-closed) and builds only the empty variants', async () => {
        const fs = new F23Fs();
        fs.order = 'alphabetical';
        fs.writeCap = 150;
        fs.listCap = 6000;
        const holder = { config: configFor(`${MOD_ROOT}/gen-a`) };
        await seedProject(fs, holder.config);
        const { host } = createHost(fs, holder);
        const session = new BuildSession(host);
        await session.start(['main', 'development']);

        await fs.writeText(
            `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/extra.lua`,
            'E1 casualty',
        );
        await fs.writeText(`${MOD_ROOT}/gen-b/staging/keep.lua`, 'keep');
        await fs.writeText(`${MOD_ROOT}/media/lua/late.lua`, 'late');

        const genAKeys = keysUnder(fs, `${MOD_ROOT}/gen-a`);
        const genAContents = new Map(
            genAKeys.map((key) => [key, Buffer.from(fs.files.get(key)!)]),
        );

        fs.writes = [];
        fs.deletes = [];
        fs.writeCap = 400;
        holder.config = configFor(`${MOD_ROOT}/gen-b`);
        const result = await session.apply([
            { type: 'change', path: `${PROJECT_DIR}\\project.json` },
        ]);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain(
            `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}`,
        );
        expect(result.fullRebuild).toBe(false);

        expect(
            await fs.readText(
                `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/extra.lua`,
            ),
        ).toBe('E1 casualty');

        expect(fs.deletes.sort()).toEqual(
            [
                `${MOD_ROOT}/gen-b/${DEV_OUT_PREFIX}`,
                `${MOD_ROOT}/gen-b/${DEV_OUT_PREFIX}/.pzstudio-mkdir`,
                `${MOD_ROOT}/gen-b/${DEV_OUT_PREFIX}/.pzstudio-output.json.tmp`,
            ].sort(),
        );

        expect(await fs.readText(`${MOD_ROOT}/gen-b/staging/keep.lua`)).toBe(
            'keep',
        );
        expect(
            await fs.readText(
                `${variantRoot(`${MOD_ROOT}/gen-b`, 'development')}/Contents/mods/my_mod_dev/gen-b/staging/keep.lua`,
            ),
        ).toBe('keep');

        expect(keysUnder(fs, `${MOD_ROOT}/gen-a`)).toEqual(genAKeys);
        for (const [key, content] of genAContents) {
            expect(Buffer.from(fs.files.get(key)!)).toEqual(content);
        }

        expect(
            await fs.readText(
                `${variantRoot(`${MOD_ROOT}/gen-b`, 'development')}/Contents/mods/my_mod_dev/media/lua/late.lua`,
            ),
        ).toBe('late');

        expect(fs.writes.length).toBeLessThanOrEqual(300);
    });
});
