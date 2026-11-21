import { describe, it, expect } from 'vitest';
import {
    F23Fs,
    MOD_ROOT,
    PROJECT_DIR,
    configFor,
    createHost,
    keysUnder,
    seedProject,
    variantRoot,
} from '../helpers/copytree-f23-harness';
import { AliasRouteFs } from '../helpers/write-boundary-fs';
import {
    BuildSession,
    planScopedModRebuild,
} from '../../packages/core/src/buildsession';
import { executeFileOperations } from '../../packages/core/src/execute';
import {
    modIdForVariant,
    planBuild,
    planModOperations,
} from '../../packages/core/src/buildplan';

const OUT_DIR = '/out';
const MAIN_OUT = `${OUT_DIR}/Sync Project`;
const MAIN_MOD = `${MAIN_OUT}/Contents/mods/my_mod`;
const DEV_OUT = variantRoot(OUT_DIR, 'development');
const DEV_MOD = `${DEV_OUT}/Contents/mods/${modIdForVariant('my_mod', 'development')}`;
const OUTPUT_ROOT_OPTIONS = { outputRoot: OUT_DIR };

async function fixture() {
    const fs = new AliasRouteFs();
    const holder = { config: configFor(OUT_DIR) };
    await seedProject(fs, holder.config);
    const { host } = createHost(fs, holder);
    return { fs, holder, host };
}

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

describe('F23-WB: harness conformance (emulated OS alias semantics)', () => {
    it('writes through an ancestor link land at the physical target, and a write-leaf link is followed', async () => {
        const fs = new AliasRouteFs();
        fs.links.set('/root/alias', '/victim');
        await fs.write(
            '/root/alias/child/file.txt',
            new TextEncoder().encode('PAYLOAD'),
        );

        expect(fs.files.has('/victim/child/file.txt')).toBe(true);
        expect(Buffer.from(fs.files.get('/victim/child/file.txt')!)).toEqual(
            Buffer.from(new TextEncoder().encode('PAYLOAD')),
        );
        expect(fs.files.has('/root/alias/child/file.txt')).toBe(false);
        expect(fs.writes).toEqual(['/victim/child/file.txt']);

        fs.links.set(`${MAIN_OUT}/Contents/mods`, '/victim');
        await fs.writeText(
            `${MAIN_OUT}/Contents/mods/my_mod/media/lua/hello.lua`,
            'print("v1")',
        );
        expect(fs.files.has('/victim/my_mod/media/lua/hello.lua')).toBe(true);
        expect(
            fs.files.has(
                `${MAIN_OUT}/Contents/mods/my_mod/media/lua/hello.lua`,
            ),
        ).toBe(false);

        fs.links.set('/root/leaf.txt', '/victim/real.txt');
        await fs.writeText('/root/leaf.txt', 'LEAF');
        expect(fs.files.has('/victim/real.txt')).toBe(true);
        expect(await fs.readText('/victim/real.txt')).toBe('LEAF');
        expect(fs.files.has('/root/leaf.txt')).toBe(false);
    });

    it('recursive deletion through an ancestor link removes the resolved subtree at the physical target', async () => {
        const fs = new AliasRouteFs();
        await fs.writeText('/victim/my_mod/media/lua/hello.lua', 'VICTIM-LUA');
        await fs.writeText('/victim/TOP-SENTINEL.txt', 'TOP');
        fs.links.set('/root/alias', '/victim');

        await fs.delete('/root/alias/my_mod/media', { recursive: true });

        expect(fs.files.has('/victim/my_mod/media/lua/hello.lua')).toBe(false);
        expect(fs.files.has('/victim/TOP-SENTINEL.txt')).toBe(true);
        expect(await fs.readText('/victim/TOP-SENTINEL.txt')).toBe('TOP');
        expect(fs.links.has('/root/alias')).toBe(true);
    });

    it('deleting an alias as the final component removes only the link, never the target (B1)', async () => {
        const fs = new AliasRouteFs();
        await fs.writeText('/victim/data.txt', 'TARGET-KEEP');
        fs.links.set('/root/alias', '/victim');

        await fs.delete('/root/alias', { recursive: true });

        expect(fs.links.has('/root/alias')).toBe(false);
        expect(await fs.readText('/victim/data.txt')).toBe('TARGET-KEEP');
        await expect(fs.read('/root/alias/data.txt')).rejects.toThrow(/ENOENT/);
    });

    it('alias-free paths keep the plain memory semantics unchanged', async () => {
        const fs = new AliasRouteFs();
        await fs.writeText('/plain/dir/file.txt', 'PLAIN');

        expect(fs.files.has('/plain/dir/file.txt')).toBe(true);
        expect(await fs.readText('/plain/dir/file.txt')).toBe('PLAIN');
        expect((await fs.stat('/plain/dir')).type).toBe('directory');
        expect(await fs.list('/plain/dir')).toEqual([
            { name: 'file.txt', uri: '/plain/dir/file.txt', type: 'file' },
        ]);
        await fs.delete('/plain/dir/file.txt');
        expect(fs.files.has('/plain/dir/file.txt')).toBe(false);

        await fs.writeText('rel/file.txt', 'REL');
        expect(fs.files.has('rel/file.txt')).toBe(true);
        expect(await fs.readText('rel/file.txt')).toBe('REL');
    });

    it('dangling aliases keep the modeled link semantics (read/stat ENOENT, B1 removal, modeled landings)', async () => {
        const fs = new AliasRouteFs();
        fs.links.set('/root/dangle', '/nowhere');

        await expect(fs.stat('/root/dangle')).rejects.toThrow(/ENOENT/);
        await expect(fs.read('/root/dangle/f.txt')).rejects.toThrow(/ENOENT/);

        await fs.writeText('/root/dangle/f.txt', 'MATERIALIZED');
        expect(fs.files.has('/nowhere/f.txt')).toBe(true);
        expect(await fs.readText('/nowhere/f.txt')).toBe('MATERIALIZED');
        expect(fs.files.has('/root/dangle/f.txt')).toBe(false);

        await fs.delete('/root/dangle/f.txt', { recursive: true });
        expect(fs.files.has('/nowhere/f.txt')).toBe(false);
        expect(fs.links.has('/root/dangle')).toBe(true);

        fs.links.set('/root/dangle2', '/also-nowhere');
        await fs.delete('/root/dangle2/not-there.lua', { recursive: true });
        expect(fs.links.has('/root/dangle2')).toBe(true);

        await fs.delete('/root/dangle');
        expect(fs.links.has('/root/dangle')).toBe(false);
        expect(fs.links.has('/root/dangle2')).toBe(true);
    });
});

describe('F23-WB: recursive deletion through a junction ancestor (B4-ii, A7/B5)', () => {
    it('refuses the scoped rebuild reset before the removeDir and leaves the mod source byte-identical', async () => {
        const { fs, host } = await fixture();
        const input = await host.getPlanInput();
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

        expect(await fs.readText('/victim6/keep.txt')).toBe('A6-KEEP');
        expect(keysUnder(fs, '/victim6')).toEqual(['/victim6/keep.txt']);
        expect(
            await fs.readText(`${MAIN_OUT}/Contents/template-file.txt`),
        ).toBe('tpl');
    });
});

describe('F23-WB: incremental sync through planted aliases (B4-iii/B4-iv, no race)', () => {
    async function sessionWithMediaLink(target: string) {
        const { fs, host } = await fixture();
        const session = new BuildSession(host);
        await session.start(['main']);
        await fs.delete(`${MAIN_MOD}/media`, { recursive: true });
        fs.links.set(`${MAIN_MOD}/media`, target);
        return { fs, session };
    }

    it('refuses an incremental delete that would remove the mod source file (B4-iii)', async () => {
        const { fs, session } = await sessionWithMediaLink(`${MOD_ROOT}/media`);
        const result = await session.apply([
            { type: 'delete', path: `${MOD_ROOT}\\media\\lua\\hello.lua` },
        ]);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.join('\n')).toMatch(/symbolic link/);
        expect(result.incremental).toBe(0);
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
        await fs.writeText(`${MOD_ROOT}/gen/staging/collide.lua`, 'collide');
        const { host } = createHost(fs, holder);
        await new BuildSession(host).start(['main']);

        const mainMod = `${MOD_ROOT}/gen/Sync Project/Contents/mods/my_mod`;
        expect(await fs.readText(`${mainMod}/media/lua/hello.lua`)).toBe(
            'print("v1")',
        );
        expect(await fs.readText(`${mainMod}/gen/staging/collide.lua`)).toBe(
            'collide',
        );
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

describe('F23-WB R2: cross-variant redirection through a destination alias (A3)', () => {
    it('refuses a main-variant destination alias redirecting into the development variant and leaves the dev territory byte-identical', async () => {
        const { fs, host } = await fixture();
        const input = await host.getPlanInput();
        await executeFileOperations(
            fs,
            planBuild({ ...input, variant: 'development' }),
            undefined,
            OUTPUT_ROOT_OPTIONS,
        );
        const devBefore = snapshot(fs, DEV_OUT);
        expect(devBefore.size).toBeGreaterThan(0);

        await fs.writeText(`${MAIN_MOD}/pre-existing.txt`, 'HERE');
        fs.links.set(`${MAIN_MOD}/media`, `${DEV_MOD}/media`);

        const error = await executeFileOperations(
            fs,
            planModOperations({ ...input, variant: 'main' }, 'main', 'my_mod'),
            undefined,
            OUTPUT_ROOT_OPTIONS,
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
            /Refusing copyTree destination .*'media'.*symbolic link/s,
        );

        expectSameBytes(fs, devBefore);
        expect(keysUnder(fs, DEV_OUT)).toEqual([...devBefore.keys()].sort());
        expect(fs.links.has(`${MAIN_MOD}/media`)).toBe(true);
    });
});

describe('F23-WB R7: dangling aliases (B-extra / A3b)', () => {
    it('a dangling alias ancestor on a recursive-deletion route is an explicit refusal naming the alias, never a silent no-op', async () => {
        const { fs, host } = await fixture();
        const input = await host.getPlanInput();
        await fs.writeText(`${MAIN_OUT}/Contents/.anchor`, 'a');
        fs.links.set(`${MAIN_OUT}/Contents/mods`, '/bx-nowhere');
        const everythingBefore = snapshot(fs, '/');

        const error = await executeFileOperations(
            fs,
            planScopedModRebuild(input, 'main', 'my_mod'),
            undefined,
            OUTPUT_ROOT_OPTIONS,
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
            /Refusing removeDir .*'mods'.*symbolic link/s,
        );
        expect((error as Error).message).not.toMatch(/ENOENT|ENOTDIR|EEXIST/);

        expectSameBytes(fs, everythingBefore);
        expect(fs.links.has(`${MAIN_OUT}/Contents/mods`)).toBe(true);
        expect(keysUnder(fs, '/bx-nowhere')).toEqual([]);
    });

    it('a dangling destination entry encountered during copyTree is refused by name, never as a raw filesystem error', async () => {
        const { fs, host } = await fixture();
        const input = await host.getPlanInput();
        await fs.writeText(`${MAIN_MOD}/pre-existing.txt`, 'HERE');
        fs.links.set(`${MAIN_MOD}/media`, '/nowhere-at-all');
        const everythingBefore = snapshot(fs, '/');

        const error = await executeFileOperations(
            fs,
            planModOperations({ ...input, variant: 'main' }, 'main', 'my_mod'),
            undefined,
            OUTPUT_ROOT_OPTIONS,
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
            /Refusing copyTree destination .*'media'.*symbolic link/s,
        );
        expect((error as Error).message).not.toMatch(/ENOENT|ENOTDIR|EEXIST/);

        expectSameBytes(fs, everythingBefore);
        expect(fs.links.has(`${MAIN_MOD}/media`)).toBe(true);
        expect(keysUnder(fs, '/nowhere-at-all')).toEqual([]);
    });
});
