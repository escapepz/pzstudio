/**
 * F23-E1a regression — copyTree destination exclusion vs path aliases.
 *
 * Doc 15 §7 (F23-E1a, blocker): the 47abe28 fix compares the destination
 * chain in the PLAN's path spelling (segmentsBelow — only a Windows drive
 * prefix compares case-insensitively) against walk-relative paths built
 * from ON-DISK names returned by fs.list. On a case-insensitive,
 * case-preserving filesystem (NTFS default, macOS default) a destination
 * chain whose stored spelling differs in case from the plan's — concretely
 * an outdir root stored as `GEN` while the config says `gen`, kept alive
 * through removeDir by non-variant content under it (removeDir targets only
 * the variant root) — makes every comparison miss: the walk re-enters the
 * destination it is writing. The 47abe28 docstring claim that a
 * case-variant twin "could contribute at most one bounded generation" is
 * void (measured: nesting depth 6 under alphabetical order, 400-write
 * budget trip under insertion order — doc 15 §7).
 *
 * Coverage matrix (brief §3):
 * - A: case-exact destination on the case-insensitive fs — the existing F23
 *   guarantees (bounds, exact output trees, order independence) must hold.
 * - B: case-variant destination on the case-insensitive fs — the escape.
 * - C: the same layout on a case-SENSITIVE fs — `GEN` and `gen` are
 *   distinct directories; distinct-path semantics must be preserved (no
 *   global lowercasing: legitimate POSIX source under a case twin of the
 *   chain must still be incorporated).
 * - D: case-only title/outdir-root changes and rapid A→B→A migrations.
 * - E: similar-prefix siblings — no lexical false positives.
 * - F: legitimate source under the output root outside the destination
 *   subtree (staging/collide.lua) stays incorporated.
 * - G: main + development variants — bounded termination and the exact
 *   expected output trees in the case-variant flow.
 *
 * Alias classes NOT fixed here (doc 15 §7, demonstrated in the symlink
 * describe below): symlink directory aliases (the walker dereferences
 * links and descends by the link's own name, so name-based containment
 * cannot see that a link resolves into the destination). Windows short
 * (8.3) names and other platform normalization aliases are recorded as
 * residual in the same class. Closing those requires resolved-path
 * containment (a realpath/identity-style filesystem capability) —
 * identified, not invented here.
 */
import { describe, it, expect } from 'vitest';
import {
    DEV_OUT_PREFIX,
    F23Fs,
    ListOrder,
    MAIN_OUT_PREFIX,
    MOD_ROOT,
    PROJECT_DIR,
    configFor,
    createHost,
    keysUnder,
    maxNesting,
    seedProject,
    variantRoot,
} from '../helpers/copytree-f23-harness';
import { CaseInsensitiveFs, SymlinkFs } from '../helpers/alias-file-systems';
import { BuildSession } from '../../packages/core/src/buildsession';

/**
 * Seeds the case-variant fixture: an exact-case project plus an outdir root
 * stored as `GEN` (capital) holding legitimate non-variant content, while
 * the config spells the outdir `gen` (lowercase). On a case-insensitive fs
 * these are the same directory; on a case-sensitive fs they are distinct.
 */
async function seedCaseVariantRoot(
    fs: F23Fs,
    extra?: { note?: boolean },
): Promise<void> {
    await fs.writeText(`${MOD_ROOT}/GEN/staging/collide.lua`, 'collide');
    if (extra?.note) {
        await fs.writeText(`${MOD_ROOT}/GEN/notes/readme.txt`, 'note');
    }
}

describe('F23-E1a-A: case-exact destination on a case-insensitive filesystem', () => {
    it.each<ListOrder>(['alphabetical', 'insertion'])(
        'keeps the F23 guarantees under %s listing order',
        async (order) => {
            const fs = new CaseInsensitiveFs();
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
            await new BuildSession(host).start(['main', 'development']);

            // Same bounds and the same exact key sets as the case-sensitive
            // suite (copytree-destination-exclusion.test.ts F23-R2): when
            // every spelling matches exactly, case-insensitive resolution
            // must not change behavior at all.
            expect(fs.writes.length).toBeLessThanOrEqual(120);
            const mainRoot = variantRoot(`${MOD_ROOT}/gen`, 'main');
            const devRoot = variantRoot(`${MOD_ROOT}/gen`, 'development');
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
            expect(
                maxNesting(keysUnder(fs, `${MOD_ROOT}/gen`)),
            ).toBeLessThanOrEqual(2);
        },
    );
});

describe('F23-E1a-B: case-variant destination on a case-insensitive filesystem', () => {
    it.each<ListOrder>(['alphabetical', 'insertion'])(
        'recognizes its own destination despite the case variant (%s listing order)',
        async (order) => {
            const fs = new CaseInsensitiveFs();
            fs.order = order;
            fs.writeCap = 400;
            fs.listCap = 6000;
            const holder = {
                config: configFor(`${MOD_ROOT}/gen`, {
                    excludes: ['staging'],
                }),
            };
            await seedProject(fs, holder.config);
            await seedCaseVariantRoot(fs);
            const { host } = createHost(fs, holder);
            await new BuildSession(host).start(['main', 'development']);

            // The output lives under the STORED spelling of the outdir root
            // (GEN) — case-preserving storage — with fresh subfolders in the
            // plan's spelling. Pre-fix the walk re-entered this destination:
            // extra embedded generations (nesting > 2) and, under adverse
            // orders, budget trips (doc 15 §7's measurement).
            const mainRoot = `${MOD_ROOT}/GEN/${MAIN_OUT_PREFIX}`;
            const devRoot = `${MOD_ROOT}/GEN/${DEV_OUT_PREFIX}`;
            expect(fs.writes.length).toBeLessThanOrEqual(160);
            expect(
                maxNesting(keysUnder(fs, `${MOD_ROOT}/GEN`)),
            ).toBeLessThanOrEqual(2);
            // Destination content is exactly one copy of the source, not a
            // self-embedded cascade: no `my_mod/GEN/.../my_mod/GEN` chain.
            expect(
                await fs.readText(
                    `${mainRoot}/Contents/mods/my_mod/media/lua/hello.lua`,
                ),
            ).toBe('print("v1")');
            expect(
                await fs.readText(
                    `${devRoot}/Contents/mods/my_mod_dev/mod.info`,
                ),
            ).toBe('id=my_mod_dev\nname=My Mod\ndescription=A mod.');
            // The non-variant source under the output root is incorporated.
            expect(
                await fs.readText(
                    `${mainRoot}/Contents/mods/my_mod/GEN/staging/collide.lua`,
                ),
            ).toBe('collide');
            // And nothing outside the destination subtree leaked a
            // case-variant output root: the only on-disk outdir spelling is
            // the stored one.
            expect(
                keysUnder(fs, MOD_ROOT).some((key) => key.includes('/gen/')),
            ).toBe(false);
        },
    );
});

describe('F23-E1a-C: the same case-variant layout on a case-SENSITIVE filesystem', () => {
    it('treats GEN and gen as distinct paths: GEN source is incorporated, gen destination is created fresh', async () => {
        const fs = new F23Fs();
        fs.order = 'alphabetical';
        fs.writeCap = 200;
        fs.listCap = 6000;
        const holder = {
            config: configFor(`${MOD_ROOT}/gen`, {
                excludes: ['staging'],
            }),
        };
        await seedProject(fs, holder.config);
        await seedCaseVariantRoot(fs);
        const { host } = createHost(fs, holder);
        await new BuildSession(host).start(['main', 'development']);

        // Distinct-path semantics: the destination is a NEW tree under
        // `gen` (plan spelling, nothing stored case-variant), while `GEN` is
        // ordinary source — its content must be incorporated.
        const mainRoot = variantRoot(`${MOD_ROOT}/gen`, 'main');
        expect(fs.writes.length).toBeLessThanOrEqual(120);
        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/GEN/staging/collide.lua`,
            ),
        ).toBe('collide');
        expect(await fs.readText(`${MOD_ROOT}/GEN/staging/collide.lua`)).toBe(
            'collide',
        );
        expect(
            maxNesting(keysUnder(fs, `${MOD_ROOT}/gen`)),
        ).toBeLessThanOrEqual(2);
    });

    it('with a stale case-variant twin of the destination itself, only the exact destination subtree is excluded', async () => {
        // The POSIX counterexample to any global-lowercase "fix": BOTH
        // `GEN/` (user content) and `gen/` (a stale earlier output) exist on
        // a case-sensitive filesystem. The exclusion must drop only `gen`'s
        // subtree and still incorporate `GEN`'s content as source.
        const fs = new F23Fs();
        fs.order = 'alphabetical';
        fs.writeCap = 200;
        fs.listCap = 6000;
        const holder = {
            config: configFor(`${MOD_ROOT}/gen`, {
                excludes: ['staging'],
            }),
        };
        await seedProject(fs, holder.config);
        await seedCaseVariantRoot(fs);
        // A stale output tree under the exact destination spelling. The
        // engine's own removeDir deletes its variant folders before the
        // walk (E1 boundary, documented in F23-R5); the `GEN` twin is not
        // touched by it and must remain legitimate source.
        await fs.writeText(
            `${MOD_ROOT}/gen/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/stale-marker.lua`,
            'stale',
        );
        const { host } = createHost(fs, holder);
        await new BuildSession(host).start(['main', 'development']);

        const mainRoot = variantRoot(`${MOD_ROOT}/gen`, 'main');
        expect(fs.writes.length).toBeLessThanOrEqual(120);
        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/GEN/staging/collide.lua`,
            ),
        ).toBe('collide');
        expect(
            fs.files.has(
                `${mainRoot}/Contents/mods/my_mod/gen/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/stale-marker.lua`,
            ),
        ).toBe(false);
        expect(
            maxNesting(keysUnder(fs, `${MOD_ROOT}/gen`)),
        ).toBeLessThanOrEqual(2);
    });
});

describe('F23-E1a-D: case-only changes and rapid A→B→A migrations', () => {
    it('a case-only title change replaces the case-variant variant folder and stays bounded', async () => {
        const fs = new CaseInsensitiveFs();
        fs.order = 'alphabetical';
        fs.writeCap = 400;
        fs.listCap = 6000;
        const holder = {
            config: configFor(`${MOD_ROOT}/gen`, {
                excludes: ['staging'],
                title: 'sync project',
            }),
        };
        await seedProject(fs, holder.config);
        const { host } = createHost(fs, holder);
        const session = new BuildSession(host);
        await session.start(['main', 'development']);
        // Era 1 output is stored under the lowercase variant folders.
        expect(
            keysUnder(fs, `${MOD_ROOT}/gen/sync project`).length,
        ).toBeGreaterThan(0);
        const nestingBefore = maxNesting(keysUnder(fs, `${MOD_ROOT}/gen`));

        fs.writes = [];
        holder.config = configFor(`${MOD_ROOT}/gen`, {
            excludes: ['staging'],
            title: 'Sync Project',
        });
        const result = await session.apply([
            { type: 'change', path: `${PROJECT_DIR}\\project.json` },
        ]);
        expect(result.fullRebuild).toBe(true);
        expect(result.errors).toEqual([]);
        expect(fs.writes.length).toBeLessThanOrEqual(300);

        // removeDir resolves the variant folders case-insensitively, so the
        // old-case folders are gone as top-level entries; the only surviving
        // old-case spellings are embedded COPIES inside the new trees (the
        // pre-existing source-inclusion policy embeds the other variant's
        // stale tree, exactly like the case-exact suite's exact key sets).
        expect(keysUnder(fs, `${MOD_ROOT}/gen/sync project`)).toEqual([]);
        expect(
            keysUnder(fs, `${MOD_ROOT}/gen/sync project - dev_branch`),
        ).toEqual([]);
        expect(
            await fs.readText(
                `${MOD_ROOT}/gen/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe('print("v1")');
        expect(
            maxNesting(keysUnder(fs, `${MOD_ROOT}/gen`)),
        ).toBeLessThanOrEqual(nestingBefore + 2);
    });

    it('a case-only outdir-root change keeps the stored root spelling and stays bounded', async () => {
        const fs = new CaseInsensitiveFs();
        fs.order = 'alphabetical';
        fs.writeCap = 400;
        fs.listCap = 6000;
        const holder = {
            config: configFor(`${MOD_ROOT}/gen`, {
                excludes: ['staging'],
            }),
        };
        await seedProject(fs, holder.config);
        // Non-variant content under the (exact-case) outdir root: survives
        // every rebuild's removeDir and is legitimate source.
        await fs.writeText(`${MOD_ROOT}/gen/notes/readme.txt`, 'note');
        const { host } = createHost(fs, holder);
        const session = new BuildSession(host);
        await session.start(['main', 'development']);

        fs.writes = [];
        const nestingBefore = maxNesting(keysUnder(fs, `${MOD_ROOT}/gen`));
        holder.config = configFor(`${MOD_ROOT}/GEN`, {
            excludes: ['staging'],
        });
        const result = await session.apply([
            { type: 'change', path: `${PROJECT_DIR}\\project.json` },
        ]);
        expect(result.fullRebuild).toBe(true);
        expect(result.errors).toEqual([]);
        expect(fs.writes.length).toBeLessThanOrEqual(300);

        // Case-preserving storage: the stored root keeps its original
        // spelling `gen`; the rebuild writes into it and excludes it
        // correctly regardless of the config's new case.
        expect(keysUnder(fs, `${MOD_ROOT}/GEN`)).toEqual([]);
        const mainRoot = `${MOD_ROOT}/gen/${MAIN_OUT_PREFIX}`;
        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe('print("v1")');
        expect(
            await fs.readText(
                `${mainRoot}/Contents/mods/my_mod/gen/notes/readme.txt`,
            ),
        ).toBe('note');
        expect(await fs.readText(`${MOD_ROOT}/gen/notes/readme.txt`)).toBe(
            'note',
        );
        expect(
            maxNesting(keysUnder(fs, `${MOD_ROOT}/gen`)),
        ).toBeLessThanOrEqual(nestingBefore + 2);
    });

    it('rapid A→B→A outdir migrations stay bounded and exact on the case-insensitive filesystem', async () => {
        // No case variance in this flow (both roots spelled identically in
        // config and on disk), so the exact-case exclusion already bounds
        // it. The test pins the alias-class adjacency: case-insensitive
        // RESOLUTION must not break repeated adoptions. Budgets absorb the
        // engine's pre-existing per-file .pzstudioignore probing (every
        // candidate file lists its ancestor dirs, so listings scale with
        // files × depth over the policy-composed tree — measured ~11k
        // listings for the second adoption, growth bounded, not a
        // recursion signal).
        const fs = new CaseInsensitiveFs();
        fs.order = 'alphabetical';
        fs.writeCap = 500;
        fs.listCap = 30000;
        const holder = { config: configFor(`${MOD_ROOT}/gen-a`) };
        await seedProject(fs, holder.config);
        const { host } = createHost(fs, holder);
        const session = new BuildSession(host);
        await session.start(['main', 'development']);

        for (const [outdir, expectStale] of [
            [`${MOD_ROOT}/gen-b`, `${MOD_ROOT}/gen-a`],
            [`${MOD_ROOT}/gen-a`, `${MOD_ROOT}/gen-b`],
        ] as const) {
            const before = keysUnder(fs, expectStale);
            const nestingBefore = maxNesting(keysUnder(fs, MOD_ROOT));
            fs.writes = [];
            holder.config = configFor(outdir);
            const result = await session.apply([
                { type: 'change', path: `${PROJECT_DIR}\\project.json` },
            ]);
            expect(result.fullRebuild).toBe(true);
            expect(result.errors).toEqual([]);
            expect(fs.writes.length).toBeLessThanOrEqual(500);
            // The just-abandoned root is preserved byte for byte (the
            // adoption policy F23-R1 pins on the case-sensitive fs).
            expect(keysUnder(fs, expectStale)).toEqual(before);
            const root = variantRoot(outdir, 'main');
            expect(
                await fs.readText(
                    `${root}/Contents/mods/my_mod/media/lua/hello.lua`,
                ),
            ).toBe('print("v1")');
            // One plan execution may add at most one embedding generation
            // on top of the pre-existing tree (two executions per apply).
            expect(maxNesting(keysUnder(fs, MOD_ROOT))).toBeLessThanOrEqual(
                nestingBefore + 2,
            );
        }
    });
});

describe('F23-E1a-E: similar-prefix siblings on a case-insensitive filesystem', () => {
    it('incorporates prefix siblings of the case-variant destination chain', async () => {
        const fs = new CaseInsensitiveFs();
        fs.order = 'alphabetical';
        fs.writeCap = 400;
        fs.listCap = 6000;
        const holder = {
            config: configFor(`${MOD_ROOT}/gen`, {
                excludes: ['staging'],
            }),
        };
        await seedProject(fs, holder.config);
        await seedCaseVariantRoot(fs);
        // String-prefix siblings of every chain level: `gen` → `gen-b2`,
        // `my_mod` → `my_mod_x`, and the variant folder `Sync Project` →
        // `Sync Project Extras` (inside the stored outdir root).
        await fs.writeText(
            `${MOD_ROOT}/gen-b2/nested/other.lua`,
            'prefix-root',
        );
        await fs.writeText(
            `${MOD_ROOT}/my_mod_x/nested/other.lua`,
            'sibling-mod',
        );
        await fs.writeText(
            `${MOD_ROOT}/GEN/${MAIN_OUT_PREFIX} Extras/note.txt`,
            'prefix-title',
        );
        const { host } = createHost(fs, holder);
        await new BuildSession(host).start(['main', 'development']);

        const mainMod = `${MOD_ROOT}/GEN/${MAIN_OUT_PREFIX}/Contents/mods/my_mod`;
        expect(fs.writes.length).toBeLessThanOrEqual(160);
        expect(await fs.readText(`${mainMod}/gen-b2/nested/other.lua`)).toBe(
            'prefix-root',
        );
        expect(await fs.readText(`${mainMod}/my_mod_x/nested/other.lua`)).toBe(
            'sibling-mod',
        );
        expect(
            await fs.readText(
                `${mainMod}/GEN/${MAIN_OUT_PREFIX} Extras/note.txt`,
            ),
        ).toBe('prefix-title');
    });
});

describe('F23-E1a-F: legitimate source under the output root outside the destination subtree', () => {
    it('keeps staging/collide.lua and sibling files incorporated in both variants', async () => {
        const fs = new CaseInsensitiveFs();
        fs.order = 'alphabetical';
        fs.writeCap = 400;
        fs.listCap = 6000;
        const holder = {
            config: configFor(`${MOD_ROOT}/gen`, {
                excludes: ['staging'],
            }),
        };
        await seedProject(fs, holder.config);
        await seedCaseVariantRoot(fs, { note: true });
        const { host } = createHost(fs, holder);
        await new BuildSession(host).start(['main', 'development']);

        for (const [modId, root] of [
            ['my_mod', `${MOD_ROOT}/GEN/${MAIN_OUT_PREFIX}`],
            ['my_mod_dev', `${MOD_ROOT}/GEN/${DEV_OUT_PREFIX}`],
        ] as const) {
            const mod = `${root}/Contents/mods/${modId}`;
            expect(await fs.readText(`${mod}/GEN/staging/collide.lua`)).toBe(
                'collide',
            );
            expect(await fs.readText(`${mod}/GEN/notes/readme.txt`)).toBe(
                'note',
            );
        }
        // On disk too: the fix excludes only the destination subtree and
        // never deletes or overwrites the adopted-root source.
        expect(await fs.readText(`${MOD_ROOT}/GEN/staging/collide.lua`)).toBe(
            'collide',
        );
        expect(await fs.readText(`${MOD_ROOT}/GEN/notes/readme.txt`)).toBe(
            'note',
        );
        expect(fs.writes.length).toBeLessThanOrEqual(160);
    });
});

describe('F23-E1a-G: exact output trees, both variants, in the case-variant flow', () => {
    it('produces the exact planned trees under the stored outdir-root spelling', async () => {
        const fs = new CaseInsensitiveFs();
        fs.order = 'alphabetical';
        fs.writeCap = 400;
        fs.listCap = 6000;
        const holder = {
            config: configFor(`${MOD_ROOT}/gen`, {
                excludes: ['staging'],
            }),
        };
        await seedProject(fs, holder.config);
        await seedCaseVariantRoot(fs);
        const { host } = createHost(fs, holder);
        await new BuildSession(host).start(['main', 'development']);

        const mainRoot = `${MOD_ROOT}/GEN/${MAIN_OUT_PREFIX}`;
        const devRoot = `${MOD_ROOT}/GEN/${DEV_OUT_PREFIX}`;
        expect(keysUnder(fs, mainRoot)).toEqual([
            `${mainRoot}/Contents/mods/my_mod/GEN/Sync Project/Contents/template-file.txt`,
            `${mainRoot}/Contents/mods/my_mod/GEN/staging/collide.lua`,
            `${mainRoot}/Contents/mods/my_mod/media/lua/hello.lua`,
            `${mainRoot}/Contents/mods/my_mod/media/lua/util.lua`,
            `${mainRoot}/Contents/mods/my_mod/media/other.lua`,
            `${mainRoot}/Contents/mods/my_mod/mod.info`,
            `${mainRoot}/Contents/template-file.txt`,
            `${mainRoot}/workshop.txt`,
        ]);
        expect(keysUnder(fs, devRoot)).toEqual([
            `${devRoot}/Contents/mods/my_mod_dev/GEN/Sync Project - dev_branch/Contents/template-file.txt`,
            `${devRoot}/Contents/mods/my_mod_dev/GEN/Sync Project/Contents/mods/my_mod/GEN/Sync Project/Contents/template-file.txt`,
            `${devRoot}/Contents/mods/my_mod_dev/GEN/Sync Project/Contents/mods/my_mod/GEN/staging/collide.lua`,
            `${devRoot}/Contents/mods/my_mod_dev/GEN/Sync Project/Contents/mods/my_mod/media/lua/hello.lua`,
            `${devRoot}/Contents/mods/my_mod_dev/GEN/Sync Project/Contents/mods/my_mod/media/lua/util.lua`,
            `${devRoot}/Contents/mods/my_mod_dev/GEN/Sync Project/Contents/mods/my_mod/media/other.lua`,
            `${devRoot}/Contents/mods/my_mod_dev/GEN/Sync Project/Contents/mods/my_mod/mod.info`,
            `${devRoot}/Contents/mods/my_mod_dev/GEN/Sync Project/Contents/template-file.txt`,
            `${devRoot}/Contents/mods/my_mod_dev/GEN/Sync Project/workshop.txt`,
            `${devRoot}/Contents/mods/my_mod_dev/GEN/staging/collide.lua`,
            `${devRoot}/Contents/mods/my_mod_dev/media/lua/hello.lua`,
            `${devRoot}/Contents/mods/my_mod_dev/media/lua/util.lua`,
            `${devRoot}/Contents/mods/my_mod_dev/media/other.lua`,
            `${devRoot}/Contents/mods/my_mod_dev/mod.info`,
            `${devRoot}/Contents/template-file.txt`,
            `${devRoot}/workshop.txt`,
        ]);
        // Both variants terminated within a bounded write budget.
        expect(fs.writes.length).toBeLessThanOrEqual(160);
        expect(
            maxNesting(keysUnder(fs, `${MOD_ROOT}/GEN`)),
        ).toBeLessThanOrEqual(2);
    });
});

describe('F23-E1a-SYM: symlink directory aliases (OPEN defect, documented)', () => {
    // Doc 15 §7: the walker dereferences symlinks (resolveEntryType) and
    // descends by the link's OWN name, so a link that resolves into the
    // operation's destination (or into an ancestor of itself) is entered
    // under a name the destination exclusion cannot recognize. Closing this
    // requires containment on the RESOLVED path — a realpath/identity-style
    // filesystem capability that does not exist in ProjectFileSystem. These
    // tests pin the current behavior deterministically so the gap stays
    // visible; they are documentation of an OPEN alias class, not an
    // endorsement, and they must fail loudly when a resolved-path fix lands.

    it('a link inside the source resolving into the destination re-enters it (policy violation, open)', async () => {
        const fs = new SymlinkFs();
        fs.order = 'alphabetical';
        fs.writeCap = 400;
        fs.listCap = 6000;
        const holder = { config: configFor(`${MOD_ROOT}/gen`) };
        await seedProject(fs, holder.config);
        fs.links.set(`${MOD_ROOT}/zzz-outlink`, `${MOD_ROOT}/gen/Sync Project`);
        const { host } = createHost(fs, holder);
        await new BuildSession(host).start(['main', 'development']);

        // The walk copied the destination subtree back into itself through
        // the link — the name-based exclusion never saw it. Bounded here
        // (each directory is listed once per descent), but it is exactly
        // the F23 re-entry shape: output consumed as source. mod.info is
        // written after the walk, so the re-entered copy carries the media
        // files the walk itself had just written.
        const mainMod = `${MOD_ROOT}/gen/${MAIN_OUT_PREFIX}/Contents/mods/my_mod`;
        expect(
            fs.files.has(
                `${mainMod}/zzz-outlink/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe(true);
        expect(fs.writes.length).toBeLessThanOrEqual(300);
    });

    it('a cyclic link inside the source recurses until the write budget trips (open)', async () => {
        const fs = new SymlinkFs();
        fs.order = 'alphabetical';
        fs.writeCap = 100;
        fs.listCap = 6000;
        const holder = { config: configFor(`/out`) };
        await seedProject(fs, holder.config);
        fs.links.set(`${MOD_ROOT}/media/zzz-cycle`, `${MOD_ROOT}/media`);
        const { host } = createHost(fs, holder);

        // Not even a case-6 layout: a plain build recurses through the
        // self-referential link forever (each depth re-lists `media` live
        // and finds the link again). The budget turns it into a
        // deterministic failure instead of a hang; BuildSession wraps the
        // per-variant failure in a plain Error, so match the message.
        await expect(
            new BuildSession(host).start(['main', 'development']),
        ).rejects.toThrow(/budget exceeded/);
    });
});
