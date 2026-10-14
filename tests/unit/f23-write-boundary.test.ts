/**
 * F23-WRITE P0 regression — alias-route containment at the Core mutation
 * boundaries (doc 17 §11.4, the contract-only interim containment).
 *
 * Every RED row below reproduces one executed silent escape from doc 17 §2
 * (B4-ii, B4-iii, B4-iv, A1/A5, A2, A6, A7/B5) against the real Core
 * planner/executor/session on an emulated filesystem whose write/delete
 * semantics resolve directory links exactly like the OS (see
 * tests/helpers/write-boundary-fs.ts). The post-fix expectation in every
 * case: the mutation is refused explicitly, the victim's bytes are unchanged
 * AT THE RESOLVED PHYSICAL LANDING (the stored key), and no success is
 * reported (no `errors: []`).
 *
 * GREEN rows pin behavior that must survive the guard unchanged: fresh
 * creation on a clean chain (every first build), case-6 layouts with
 * legitimate source under the output root, and the self-healing missing-leaf
 * delete. The two permanent F23 suites (copytree-destination-exclusion,
 * copytree-case-alias) carry the rest of the preservation matrix with the
 * guard active end-to-end (BuildSession always declares its output root).
 *
 * Not covered here and deliberately so (doc 17 §11.4 "what the P0 does NOT
 * stop"): alias retargeting between the guard's observation and the OS call
 * (TOCTOU — pinned in the native suite), hard-linked file leaves (native
 * experiment, recorded in doc 17's successor record), 8.3 short names, E1
 * ownership destruction inside the resolved configured root.
 */
import { describe, it, expect } from 'vitest';
import {
    F23Fs,
    MOD_ROOT,
    PROJECT_DIR,
    configFor,
    createHost,
    keysUnder,
    seedProject,
} from '../helpers/copytree-f23-harness';
import { AliasRouteFs } from '../helpers/write-boundary-fs';
import {
    BuildSession,
    planScopedModRebuild,
} from '../../packages/core/src/buildsession';
import { executeFileOperations } from '../../packages/core/src/execute';
import {
    planBuild,
    planModOperations,
} from '../../packages/core/src/buildplan';

const OUT_DIR = '/out';
const MAIN_OUT = `${OUT_DIR}/Sync Project`;
const MAIN_MOD = `${MAIN_OUT}/Contents/mods/my_mod`;
const OUTPUT_ROOT_OPTIONS = { outputRoot: OUT_DIR };

/** Fresh alias-route fixture: seeded project + plan-input host on /out. */
async function fixture() {
    const fs = new AliasRouteFs();
    const holder = { config: configFor(OUT_DIR) };
    await seedProject(fs, holder.config);
    const { host } = createHost(fs, holder);
    return { fs, holder, host };
}

/** Byte-exact snapshot of every stored key under a prefix. */
function snapshot(fs: F23Fs, prefix: string): Map<string, Uint8Array> {
    return new Map(
        keysUnder(fs, prefix).map((key) => [
            key,
            new Uint8Array(fs.files.get(key)!),
        ]),
    );
}

function expectSameBytes(fs: F23Fs, before: Map<string, Uint8Array>): void {
    for (const [key, bytes] of before) {
        expect(fs.files.has(key)).toBe(true);
        expect(Buffer.from(fs.files.get(key)!)).toEqual(Buffer.from(bytes));
    }
}

describe('F23-WB: recursive deletion through a junction ancestor (B4-ii, A7/B5)', () => {
    it('refuses the scoped rebuild reset before the removeDir and leaves the mod source byte-identical', async () => {
        const { fs, host } = await fixture();
        const input = await host.getPlanInput();
        // A junction requires its parent chain on a real filesystem: anchor
        // the destination structure, then plant the max-damage junction —
        // Contents/mods → the project root turns the scoped rebuild's
        // removeDir(outModsPath) into source destruction.
        await fs.writeText(`${MAIN_OUT}/Contents/.anchor`, 'a');
        fs.links.set(`${MAIN_OUT}/Contents/mods`, PROJECT_DIR);
        const sourceBefore = snapshot(fs, `${PROJECT_DIR}/my_mod`);

        await expect(
            executeFileOperations(
                fs,
                planScopedModRebuild(input, 'main', 'my_mod'),
                undefined,
                OUTPUT_ROOT_OPTIONS,
            ),
        ).rejects.toThrow(/Refusing removeDir .*'mods'.*symbolic link/s);

        // The source tree is byte-identical — nothing was deleted through
        // the junction (pre-fix: media/mod.info gone, errors: []).
        expectSameBytes(fs, sourceBefore);
        expect(await fs.readText(`${MOD_ROOT}/media/lua/hello.lua`)).toBe(
            'print("v1")',
        );
    });

    it('refuses the scoped rebuild reset onto an external victim and prevents re-materialization inside it', async () => {
        const { fs, host } = await fixture();
        const input = await host.getPlanInput();
        await fs.writeText('/victim/my_mod/keep.lua', 'SCOPED-KEEP');
        await fs.writeText('/victim/TOP-SENTINEL.txt', 'B5-TOP');
        await fs.writeText(`${MAIN_OUT}/Contents/.anchor`, 'a');
        fs.links.set(`${MAIN_OUT}/Contents/mods`, '/victim');

        await expect(
            executeFileOperations(
                fs,
                planScopedModRebuild(input, 'main', 'my_mod'),
                undefined,
                OUTPUT_ROOT_OPTIONS,
            ),
        ).rejects.toThrow(/Refusing removeDir .*'mods'.*symbolic link/s);

        // Victim content survives byte-exact; nothing was re-materialized.
        expect(await fs.readText('/victim/my_mod/keep.lua')).toBe(
            'SCOPED-KEEP',
        );
        expect(await fs.readText('/victim/TOP-SENTINEL.txt')).toBe('B5-TOP');
        expect(keysUnder(fs, '/victim/my_mod')).toEqual([
            '/victim/my_mod/keep.lua',
        ]);
    });
});

describe('F23-WB: copy redirection through destination aliases (A1/A2/A5/A6)', () => {
    it('refuses copyTree onto an adopted destination whose media entry is a junction into the source (A1)', async () => {
        const { fs, host } = await fixture();
        const input = await host.getPlanInput();
        // Adoption shape: the destination pre-exists (no reset in the plan).
        await fs.writeText(`${MAIN_MOD}/pre-existing.txt`, 'HERE');
        await fs.writeText(`${MOD_ROOT}/victimdir/userfile.lua`, 'USER-DATA');
        fs.links.set(`${MAIN_MOD}/media`, `${MOD_ROOT}/victimdir`);

        await expect(
            executeFileOperations(
                fs,
                planModOperations(
                    { ...input, variant: 'main' },
                    'main',
                    'my_mod',
                ),
                undefined,
                OUTPUT_ROOT_OPTIONS,
            ),
        ).rejects.toThrow(/symbolic link/s);

        // The victim keeps its bytes and gains nothing (pre-fix: the whole
        // media tree materialized inside victimdir, silently).
        expect(await fs.readText(`${MOD_ROOT}/victimdir/userfile.lua`)).toBe(
            'USER-DATA',
        );
        expect(keysUnder(fs, `${MOD_ROOT}/victimdir`)).toEqual([
            `${MOD_ROOT}/victimdir/userfile.lua`,
        ]);
    });

    it('refuses copyTree when a destination ancestor is a junction to an external directory (A2)', async () => {
        const { fs, host } = await fixture();
        const input = await host.getPlanInput();
        await fs.writeText('/ext-victim2/keep.txt', 'EXT2-KEEP');
        await fs.writeText(`${MAIN_OUT}/Contents/.anchor`, 'a');
        fs.links.set(`${MAIN_OUT}/Contents/mods`, '/ext-victim2');

        await expect(
            executeFileOperations(
                fs,
                planModOperations(
                    { ...input, variant: 'main' },
                    'main',
                    'my_mod',
                ),
                undefined,
                OUTPUT_ROOT_OPTIONS,
            ),
        ).rejects.toThrow(/symbolic link/s);

        expect(await fs.readText('/ext-victim2/keep.txt')).toBe('EXT2-KEEP');
        expect(keysUnder(fs, '/ext-victim2')).toEqual([
            '/ext-victim2/keep.txt',
        ]);
    });

    it('refuses a writeFile whose leaf is a file symlink (class 5)', async () => {
        const { fs } = await fixture();
        await fs.writeText('/ext-leaf/workshop.txt', 'USER-ORIGINAL-BYTES');
        await fs.writeText(`${MAIN_OUT}/.anchor`, 'a');
        fs.links.set(`${MAIN_OUT}/workshop.txt`, '/ext-leaf/workshop.txt');

        await expect(
            executeFileOperations(
                fs,
                [
                    {
                        type: 'writeFile',
                        path: `${MAIN_OUT}/workshop.txt`,
                        content: 'version=1\n',
                    },
                ],
                undefined,
                OUTPUT_ROOT_OPTIONS,
            ),
        ).rejects.toThrow(
            /Refusing writeFile .*'workshop\.txt'.*symbolic link/s,
        );

        expect(await fs.readText('/ext-leaf/workshop.txt')).toBe(
            'USER-ORIGINAL-BYTES',
        );
    });

    it('detects an alias inserted after the reset, before the copy ops (A6), disclosing partial output', async () => {
        const { fs, host } = await fixture();
        const input = await host.getPlanInput();
        const plan = planBuild({ ...input, variant: 'main' });
        // The plan's reset runs first; the junction is planted in the window
        // AFTER the reset and BEFORE the copy ops — a fresh build's reset is
        // a silent no-op, so only mutation-time inspection can catch it.
        const resetOps = plan.slice(0, 2);
        const restOps = plan.slice(2);
        await executeFileOperations(
            fs,
            resetOps,
            undefined,
            OUTPUT_ROOT_OPTIONS,
        );

        await fs.writeText('/victim6/keep.txt', 'A6-KEEP');
        fs.links.set(`${MAIN_MOD}/media`, '/victim6');

        await expect(
            executeFileOperations(fs, restOps, undefined, OUTPUT_ROOT_OPTIONS),
        ).rejects.toThrow(/symbolic link/s);

        // Victim untouched (pre-fix: the walk wrote hello.lua/other.lua into
        // it through the junction, silently).
        expect(await fs.readText('/victim6/keep.txt')).toBe('A6-KEEP');
        expect(keysUnder(fs, '/victim6')).toEqual(['/victim6/keep.txt']);
        // Partial-build state is disclosed, not hidden: operations that ran
        // before the refusal (reset, template copy) remain on disk.
        expect(
            await fs.readText(`${MAIN_OUT}/Contents/template-file.txt`),
        ).toBe('tpl');
    });
});

describe('F23-WB: incremental sync through planted aliases (B4-iii/B4-iv, no race)', () => {
    /** Clean single-variant session on the alias fs, then media swapped for a link. */
    async function sessionWithMediaLink(target: string) {
        const { fs, host } = await fixture();
        const session = new BuildSession(host);
        await session.start(['main']);
        // The only way an alias can exist at the destination media: the real
        // directory is removed first (creation over it fails EEXIST).
        await fs.delete(`${MAIN_MOD}/media`, { recursive: true });
        fs.links.set(`${MAIN_MOD}/media`, target);
        return { fs, session };
    }

    it('refuses an incremental delete that would remove the mod source file (B4-iii)', async () => {
        const { fs, session } = await sessionWithMediaLink(`${MOD_ROOT}/media`);
        const result = await session.apply([
            { type: 'delete', path: `${MOD_ROOT}\\media\\lua\\hello.lua` },
        ]);

        // No silent success: the refusal is visible in the result.
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.join('\n')).toMatch(/symbolic link/);
        expect(result.incremental).toBe(0);
        // The source file survives byte-exact (pre-fix: deleted, errors: []).
        expect(await fs.readText(`${MOD_ROOT}/media/lua/hello.lua`)).toBe(
            'print("v1")',
        );
    });

    it('refuses an incremental write that would overwrite an external victim (B4-iv)', async () => {
        const { fs, session } = await sessionWithMediaLink('/ext-victim-iv');
        await fs.writeText('/ext-victim-iv/lua/hello.lua', 'VICTIM-BYTES');

        const result = await session.apply([
            { type: 'change', path: `${MOD_ROOT}\\media\\lua\\hello.lua` },
        ]);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.join('\n')).toMatch(/symbolic link/);
        expect(await fs.readText('/ext-victim-iv/lua/hello.lua')).toBe(
            'VICTIM-BYTES',
        );
    });

    it('refuses an incremental write whose leaf is a file symlink into an external victim (B4-iv leaf form)', async () => {
        const { fs, host } = await fixture();
        const session = new BuildSession(host);
        await session.start(['main']);
        await fs.writeText('/ext-leaf/lua/hello.lua', 'LEAF-VICTIM-BYTES');
        await fs.delete(`${MAIN_MOD}/media/lua/hello.lua`);
        fs.links.set(
            `${MAIN_MOD}/media/lua/hello.lua`,
            '/ext-leaf/lua/hello.lua',
        );

        const result = await session.apply([
            { type: 'change', path: `${MOD_ROOT}\\media\\lua\\hello.lua` },
        ]);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.join('\n')).toMatch(/symbolic link/);
        expect(result.incremental).toBe(0);
        expect(await fs.readText('/ext-leaf/lua/hello.lua')).toBe(
            'LEAF-VICTIM-BYTES',
        );
    });
});

describe('F23-WB: failure semantics', () => {
    it('a scoped rebuild routed through a junction ancestor surfaces the refusal in SessionApplyResult.errors', async () => {
        const { fs, host } = await fixture();
        const session = new BuildSession(host);
        await session.start(['main']);
        // A full build's reset heals links inside the variant folder (B1);
        // the exposed session flow is the scoped rebuild, whose reset target
        // lies BELOW the junction at Contents/mods. The only way the alias
        // can exist there: the real directory is removed first.
        await fs.delete(`${MAIN_OUT}/Contents/mods`, { recursive: true });
        fs.links.set(`${MAIN_OUT}/Contents/mods`, PROJECT_DIR);
        const sourceBefore = snapshot(fs, `${PROJECT_DIR}/my_mod`);

        const result = await session.apply([
            { type: 'change', path: `${MOD_ROOT}\\mod.info` },
        ]);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.join('\n')).toMatch(/symbolic link/);
        expect(result.scoped).toEqual([
            { modId: 'my_mod', variants: ['main'] },
        ]);
        expectSameBytes(fs, sourceBefore);
    });

    it('a scanner error at an existing route component becomes an explicit refusal, never a silent mutation', async () => {
        const { fs } = await fixture();
        // The parent exists (it holds a marker file) but its listing fails
        // with a non-ENOENT error: authorization cannot be established.
        await fs.writeText(`${MAIN_OUT}/marker.txt`, 'm');
        fs.listFailures.set(
            MAIN_OUT,
            Object.assign(
                new Error(`EACCES: permission denied, scandir '${MAIN_OUT}'`),
                { code: 'EACCES' },
            ),
        );

        await expect(
            executeFileOperations(
                fs,
                [
                    {
                        type: 'writeFile',
                        path: `${MAIN_OUT}/workshop.txt`,
                        content: 'version=1\n',
                    },
                ],
                undefined,
                OUTPUT_ROOT_OPTIONS,
            ),
        ).rejects.toThrow(/cannot be authorized|could not be verified/i);

        expect(fs.files.has(`${MAIN_OUT}/workshop.txt`)).toBe(false);
    });

    it('a mutating operation outside the declared output root is refused', async () => {
        const { fs } = await fixture();
        await expect(
            executeFileOperations(
                fs,
                [
                    {
                        type: 'writeFile',
                        path: '/elsewhere/x.txt',
                        content: 'x',
                    },
                ],
                undefined,
                OUTPUT_ROOT_OPTIONS,
            ),
        ).rejects.toThrow(/not inside the configured build output root/);
        expect(fs.files.has('/elsewhere/x.txt')).toBe(false);
    });
});

describe('F23-WB: preservation (must stay green)', () => {
    it('fresh creation on a clean chain builds both variants byte-identically (first-build shape)', async () => {
        const { fs, host } = await fixture();
        await new BuildSession(host).start(['main', 'development']);

        for (const [modId, root] of [
            ['my_mod', `${OUT_DIR}/Sync Project`],
            ['my_mod_dev', `${OUT_DIR}/Sync Project - dev_branch`],
        ] as const) {
            const mod = `${root}/Contents/mods/${modId}`;
            expect(await fs.readText(`${mod}/media/lua/hello.lua`)).toBe(
                'print("v1")',
            );
            expect(await fs.readText(`${mod}/mod.info`)).toContain(
                `id=${modId}`,
            );
            expect(await fs.readText(`${root}/workshop.txt`)).toContain(
                'title=Sync Project',
            );
        }
        expect(
            await fs.readText(`${MAIN_OUT}/Contents/template-file.txt`),
        ).toBe('tpl');
    });

    it('a case-6 layout with legitimate source under the output root builds and incorporates it (guard adds no false failure)', async () => {
        const fs = new AliasRouteFs();
        const holder = { config: configFor(`${MOD_ROOT}/gen`) };
        await seedProject(fs, holder.config);
        // Legitimate non-variant source under the future output root — the
        // staging/collide.lua class (F23-R3/E1a-F).
        await fs.writeText(`${MOD_ROOT}/gen/staging/collide.lua`, 'collide');
        const { host } = createHost(fs, holder);
        await new BuildSession(host).start(['main']);

        const mainMod = `${MOD_ROOT}/gen/Sync Project/Contents/mods/my_mod`;
        expect(await fs.readText(`${mainMod}/media/lua/hello.lua`)).toBe(
            'print("v1")',
        );
        // Incorporated at the embedded case-6 path...
        expect(await fs.readText(`${mainMod}/gen/staging/collide.lua`)).toBe(
            'collide',
        );
        // ...and preserved on disk.
        expect(await fs.readText(`${MOD_ROOT}/gen/staging/collide.lua`)).toBe(
            'collide',
        );
    });

    it('a missing-leaf delete on a clean chain stays the self-healing no-op', async () => {
        const { fs } = await fixture();
        await expect(
            executeFileOperations(
                fs,
                [
                    { type: 'removeDir', path: `${OUT_DIR}/Sync Project` },
                    { type: 'removeDir', path: `${OUT_DIR}/never-existed` },
                ],
                undefined,
                OUTPUT_ROOT_OPTIONS,
            ),
        ).resolves.toBeUndefined();
    });
});
