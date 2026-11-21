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

            expect(fs.writes.length).toBeLessThanOrEqual(120);
            const mainRoot = variantRoot(`${MOD_ROOT}/gen`, 'main');
            const devRoot = variantRoot(`${MOD_ROOT}/gen`, 'development');
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

            const mainRoot = `${MOD_ROOT}/GEN/${MAIN_OUT_PREFIX}`;
            const devRoot = `${MOD_ROOT}/GEN/${DEV_OUT_PREFIX}`;
            expect(fs.writes.length).toBeLessThanOrEqual(160);
            expect(
                maxNesting(keysUnder(fs, `${MOD_ROOT}/GEN`)),
            ).toBeLessThanOrEqual(2);
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
            expect(
                await fs.readText(
                    `${mainRoot}/Contents/mods/my_mod/GEN/staging/collide.lua`,
                ),
            ).toBe('collide');
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
        const fs = new F23Fs();
        fs.order = 'alphabetical';
        fs.writeCap = 500;
        fs.listCap = 12000;
        const holder = {
            config: configFor(`${MOD_ROOT}/gen`, {
                excludes: ['staging'],
            }),
        };
        await seedProject(fs, holder.config);
        await seedCaseVariantRoot(fs);
        const { host } = createHost(fs, holder);
        const session = new BuildSession(host);
        await session.start(['main', 'development']);
        await fs.writeText(
            `${MOD_ROOT}/gen/${MAIN_OUT_PREFIX}/Contents/mods/my_mod/stale-marker.lua`,
            'stale',
        );
        fs.writes = [];
        const nestingBefore = maxNesting(keysUnder(fs, `${MOD_ROOT}/gen`));
        const rebuild = await session.apply([
            { type: 'change', path: `${PROJECT_DIR}\\project.json` },
        ]);
        expect(rebuild.errors).toEqual([]);

        const mainRoot = variantRoot(`${MOD_ROOT}/gen`, 'main');
        expect(fs.writes.length).toBeLessThanOrEqual(240);
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
        ).toBeLessThanOrEqual(nestingBefore + 2);
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
            expect(keysUnder(fs, expectStale)).toEqual(before);
            const root = variantRoot(outdir, 'main');
            expect(
                await fs.readText(
                    `${root}/Contents/mods/my_mod/media/lua/hello.lua`,
                ),
            ).toBe('print("v1")');
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
            `${mainRoot}/.pzstudio-output.json`,
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
            `${devRoot}/.pzstudio-output.json`,
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
        expect(fs.writes.length).toBeLessThanOrEqual(160);
        expect(
            maxNesting(keysUnder(fs, `${MOD_ROOT}/GEN`)),
        ).toBeLessThanOrEqual(2);
    });
});

describe('F23-E1a-SYM: symlink directory aliases (OPEN defect, documented)', () => {
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

        await expect(
            new BuildSession(host).start(['main', 'development']),
        ).rejects.toThrow(/budget exceeded/);
    });
});
