/**
 * F23 regression — copyTree destination-subtree exclusion.
 *
 * F23 (doc 14 §4/EXP-7, §16.3/G3-F23c): the Core executor's copyTree
 * (packages/core/src/execute.ts) lists directories live while copying and
 * applies no destination exclusion. In a case-6 layout (outdir inside a
 * configured mod folder — doc 13 §3.1 case 6, a supported doctor-flagged
 * layout) the walk re-enters its own freshly written output: each level
 * re-reads what the previous level wrote and every write extends the path
 * by one fixed mod-output suffix, so there is no fixed point.
 *
 * Verified shapes (each pinned here against the real engine):
 * - clean case-6 build: bounded under alphabetical readdir, but unbounded
 *   under adverse listing orders (insertion/reverse) — EXP-7;
 * - stale-root adoption (session started on <mod>/gen-a, config adopts
 *   <mod>/gen-b): unbounded deterministically under plain alphabetical
 *   order — G3-F23c;
 * - even the bounded first build is not one generation: the dev walk
 *   re-copies the main variant's completed tree as source (pre-existing
 *   source-inclusion policy, preserved by the fix).
 *
 * Every flow runs against the real BuildSession/planBuild/executor with an
 * instrumented memory filesystem: configurable listing order, a strict
 * write budget and a list budget so a regression fails quickly and
 * deterministically instead of exhausting memory or relying on timeouts.
 *
 * Scope notes:
 * - The fix under test excludes exactly the operation's own destination
 *   subtree (segment-aware). It must NOT exclude the whole configured
 *   outdir, a stale former output root, legitimate source under the output
 *   root outside the destination subtree, or siblings with similar string
 *   prefixes (R3).
 * - E1 (the engine's removeDir destroys user files pre-placed inside a
 *   future variant folder) is a separate, unresolved source-ownership
 *   defect. R5 reproduces it for documentation only and asserts the F23
 *   fix introduces no destruction beyond the engine's own removeDir
 *   semantics. These assertions document current behavior; they do not
 *   endorse it.
 */
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

            // Bounded execution: every file the correct output contains was
            // written at most a small constant number of times.
            expect(fs.writes.length).toBeLessThanOrEqual(120);

            // Source → output mapping, main variant (mod id 'my_mod').
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

            // Ignore semantics preserved: closest .pzstudioignore, dotfiles,
            // .gitkeep, project excludes.
            expect(fs.files.has(`${mainMod}/media/old.lua`)).toBe(false);
            expect(fs.files.has(`${mainMod}/scratch/x.lua`)).toBe(false);
            expect(fs.files.has(`${mainMod}/.gitkeep`)).toBe(false);
            expect(fs.files.has(`${mainMod}/.dotfile`)).toBe(false);
            expect(fs.files.has(`${mainMod}/.pzstudioignore`)).toBe(false);
            expect(fs.files.has(`${mainMod}/staging/keep.lua`)).toBe(false);

            // mod.info generation (no source mod.info): main id.
            expect(await fs.readText(`${mainMod}/mod.info`)).toBe(
                'id=my_mod\nname=My Mod\ndescription=A mod.',
            );
            // Workshop metadata: main carries the workshop id.
            expect(await fs.readText(`${mainRoot}/workshop.txt`)).toBe(
                'version=1\nid=12345\ntitle=Sync Project\ntags=\nvisibility=public',
            );

            // Development variant: suffixed ids, unlisted visibility, title
            // suffix, dev mod.info id alignment.
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

            // The exact output key sets. The embedded copies under
            // Contents/mods/<id>/gen/... are the pre-existing source
            // inclusion policy (the output tree lies inside the mod source,
            // so the walk consumes it as source); the destination exclusion
            // must not remove them, and — the F23 point — must not let the
            // walk re-enter its own destination and grow them further.
            expect(keysUnder(fs, mainRoot)).toEqual([
                `${mainRoot}/Contents/mods/my_mod/gen/Sync Project/Contents/template-file.txt`,
                `${mainRoot}/Contents/mods/my_mod/media/lua/hello.lua`,
                `${mainRoot}/Contents/mods/my_mod/media/lua/util.lua`,
                `${mainRoot}/Contents/mods/my_mod/media/other.lua`,
                `${mainRoot}/Contents/mods/my_mod/mod.info`,
                `${mainRoot}/Contents/template-file.txt`,
                `${mainRoot}/workshop.txt`,
            ]);
            expect(keysUnder(fs, devRoot)).toEqual([
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
            // The dev walk re-copies the main variant's completed tree
            // (pre-existing policy, depth ≥ 2) — but nothing deeper: each
            // plan execution may add at most one embedding generation on
            // top of the pre-existing tree (0 here); anything beyond is
            // F23 re-entry.
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
    /**
     * Session starts on case-6 root gen-a (completed build for both
     * variants); the config then adopts gen-b while stale gen-a remains on
     * disk. Pre-fix this recursed unboundedly under plain alphabetical
     * order (and tripped the budget in the very first build under adverse
     * orders).
     */
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

        // Sanity: the first build completed on gen-a.
        expect(
            await fs.readText(
                `${variantRoot(`${MOD_ROOT}/gen-a`, 'main')}/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe('print("v1")');

        // Snapshot the stale root before the adoption.
        const genAKeys = keysUnder(fs, `${MOD_ROOT}/gen-a`);
        const genAContents = new Map(
            genAKeys.map((key) => [key, Buffer.from(fs.files.get(key)!)]),
        );

        // Adopt gen-b: structural change → DevSync full rebuild.
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

            // Strict budget: the correct adoption writes every output file a
            // bounded number of times. Pre-fix, the walk re-descended its
            // own freshly written destination and this assertion failed via
            // BudgetExceededError after 400 writes (measured: 500+ writes at
            // nesting depth 10 under alphabetical order).
            expect(fs.writes.length).toBeLessThanOrEqual(300);

            const mainRoot = variantRoot(`${MOD_ROOT}/gen-b`, 'main');
            const devRoot = variantRoot(`${MOD_ROOT}/gen-b`, 'development');

            // Source-derived output present at the policy paths, both
            // variants. mod.info is generated (no source mod.info): the dev
            // variant generates the suffixed id.
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

            // Stale former output root preserved on disk, byte for byte —
            // the adoption rebuild's removeDir targets only gen-b's variant
            // folders, and the fix must not widen that.
            expect(keysUnder(fs, `${MOD_ROOT}/gen-a`)).toEqual(genAKeys);
            for (const [key, content] of genAContents) {
                expect(Buffer.from(fs.files.get(key)!)).toEqual(content);
            }

            // Engine deletes are exactly the adoption's own removeDir +
            // makeDir sentinel operations — no new destructive behavior.
            expect(fs.deletes.sort()).toEqual(
                [
                    `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}`,
                    `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}/.pzstudio-mkdir`,
                    `${MOD_ROOT}/gen-b/${DEV_OUT_PREFIX}`,
                    `${MOD_ROOT}/gen-b/${DEV_OUT_PREFIX}/.pzstudio-mkdir`,
                ].sort(),
            );

            // Nesting bound — the precise F23 invariant. The pre-existing
            // source-inclusion policy composes embeddings across operations
            // (each plan execution copies the other variant's current output
            // and the stale root as source), so absolute depth grows with
            // build history; what the destination exclusion guarantees is
            // that ONE plan execution adds at most ONE generation on top of
            // the pre-existing tree (two plan executions run per apply —
            // main and development). Pre-fix, the adoption recursion drove
            // the depth from 2 to 10+ within a single operation; here the
            // increment is exactly +2 (measured).
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

        // Pre-adoption source material, all of it legitimate source per the
        // current inclusion policy:
        // - collide.lua under the FUTURE root, outside the variant folders
        //   (the EXP-3b/G3-correction-1 positive incorporation case — the
        //   over-broad "mask the whole output root" fix loses exactly this);
        // - a directory whose name is a string PREFIX of the output mod
        //   folder name (my_mod → my_mod_x) and of the adopted root
        //   (gen-b → gen-b2) — segment-aware containment must not drop
        //   them; naive prefix matching would.
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

        // collide.lua incorporated at the embedded case-6 path (live-tree
        // read), both variants.
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

        // String-prefix siblings copied (segment-aware exclusion).
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

        // The stale former output root is NOT excluded merely for having
        // been an output: gen-a's completed tree is embedded once per the
        // pre-existing source inclusion policy (bounded).
        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/gen-a/Sync Project/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe('print("v1")');

        // And the destination subtree itself was not re-entered: no
        // gen-b-nested copy of the walk's own output exists beyond the
        // pre-existing policy's composition growth (at most one generation
        // per plan execution — see R1's nesting-bound comment).
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

        // Main: dev-only mods ship in the development output only.
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
        // No embedding at all outside case-6: the output never lies inside
        // the copied source.
        expect(maxNesting(keysUnder(fs, '/out'))).toBe(1);
        expect(keysUnder(fs, mainRoot)).toEqual([
            `${mainRoot}/Contents/mods/my_mod/media/lua/hello.lua`,
            `${mainRoot}/Contents/mods/my_mod/media/lua/util.lua`,
            `${mainRoot}/Contents/mods/my_mod/media/other.lua`,
            `${mainRoot}/Contents/mods/my_mod/mod.info`,
            `${mainRoot}/Contents/template-file.txt`,
            `${mainRoot}/workshop.txt`,
        ]);
        // Dev-only mod present in the dev output only (no source files, so
        // only the generated mod.info; the output folder carries the
        // suffixed id like every variant output folder).
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
        // Structural change that keeps the same root: a tags update.
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
        // Stale former root, completed build shape, still on disk.
        await fs.writeText(
            `${MOD_ROOT}/gen-a/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/media/lua/hello.lua`,
            'stale',
        );
        const { host } = createHost(fs, holder);
        const session = new BuildSession(host);
        await session.start(['main', 'development']);

        // Scoped trigger: edit the source mod.info.
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

        // Bounded: removeDir + one bounded copyTree per variant.
        expect(fs.writes.length).toBeLessThanOrEqual(100);

        const mainRoot = variantRoot(`${MOD_ROOT}/gen-b`, 'main');
        const devRoot = variantRoot(`${MOD_ROOT}/gen-b`, 'development');

        // Source mod.info copy behavior: main verbatim, dev id-patched.
        expect(
            await fs.readText(`${mainRoot}/Contents/mods/my_mod/mod.info`),
        ).toBe('id=my_mod\nname=My Mod v2\n');
        expect(
            await fs.readText(`${devRoot}/Contents/mods/my_mod_dev/mod.info`),
        ).toBe('id=my_mod_dev\nname=My Mod v2\n');
        // Media content re-synced from source.
        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe('print("v1")');
        // The stale sibling root is embedded once (pre-existing policy),
        // never recursively re-entered: the whole apply adds at most one
        // generation per plan execution on top of the pre-start tree.
        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/gen-a/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe('stale');
        expect(
            maxNesting(keysUnder(fs, `${MOD_ROOT}/gen-b`)),
        ).toBeLessThanOrEqual(nestingBefore + 2);

        // Scoped deletes: the per-variant removeDir of the mod output folder
        // plus the makeDir sentinels — nothing else.
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
    it('adoption destroys pre-placed future-variant-folder files (E1, unresolved) and nothing else', async () => {
        const fs = new F23Fs();
        fs.order = 'alphabetical';
        fs.writeCap = 150;
        fs.listCap = 6000;
        const holder = { config: configFor(`${MOD_ROOT}/gen-a`) };
        await seedProject(fs, holder.config);
        const { host } = createHost(fs, holder);
        const session = new BuildSession(host);
        await session.start(['main', 'development']);

        // E1 reproduction (EXP-3a): a user file inside the FUTURE root's
        // variant folder. This documents an UNRESOLVED source-ownership
        // defect (E1): the engine's own removeDir deletes it during
        // adoption. It is recorded here as current behavior — NOT endorsed
        // as acceptable — and its existence must not weaken the
        // preservation assertions below.
        await fs.writeText(
            `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/extra.lua`,
            'E1 casualty',
        );
        // Outside the variant folders: must survive the adoption untouched.
        await fs.writeText(`${MOD_ROOT}/gen-b/staging/keep.lua`, 'keep');
        // A source edit that must reach the rebuilt output.
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
        expect(result.fullRebuild).toBe(true);
        expect(result.errors).toEqual([]);

        // E1 documentation: the future-variant-folder file is gone.
        expect(
            fs.files.has(
                `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/extra.lua`,
            ),
        ).toBe(false);

        // Nothing outside the engine's own removeDir targets was deleted:
        // the delete log is exactly the two variant folders + sentinels.
        expect(fs.deletes.sort()).toEqual(
            [
                `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}`,
                `${MOD_ROOT}/gen-b/${MAIN_OUT_PREFIX}/.pzstudio-mkdir`,
                `${MOD_ROOT}/gen-b/${DEV_OUT_PREFIX}`,
                `${MOD_ROOT}/gen-b/${DEV_OUT_PREFIX}/.pzstudio-mkdir`,
            ].sort(),
        );

        // The outdir file outside variant folders survives on disk.
        expect(await fs.readText(`${MOD_ROOT}/gen-b/staging/keep.lua`)).toBe(
            'keep',
        );
        // ...and is incorporated as source (pre-existing policy).
        expect(
            await fs.readText(
                `${variantRoot(`${MOD_ROOT}/gen-b`, 'main')}/Contents/mods/my_mod/gen-b/staging/keep.lua`,
            ),
        ).toBe('keep');

        // The stale root is preserved byte for byte.
        expect(keysUnder(fs, `${MOD_ROOT}/gen-a`)).toEqual(genAKeys);
        for (const [key, content] of genAContents) {
            expect(Buffer.from(fs.files.get(key)!)).toEqual(content);
        }

        // The source edit reached the output in both variants.
        expect(
            await fs.readText(
                `${variantRoot(`${MOD_ROOT}/gen-b`, 'main')}/Contents/mods/my_mod/media/lua/late.lua`,
            ),
        ).toBe('late');
        expect(
            await fs.readText(
                `${variantRoot(`${MOD_ROOT}/gen-b`, 'development')}/Contents/mods/my_mod_dev/media/lua/late.lua`,
            ),
        ).toBe('late');

        // Bounded, as everywhere else in this suite.
        expect(fs.writes.length).toBeLessThanOrEqual(300);
    });
});
