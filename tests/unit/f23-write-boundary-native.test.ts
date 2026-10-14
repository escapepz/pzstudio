/**
 * F23-WRITE P0 — native NTFS junction tier (Windows-only).
 *
 * The alias-route containment guard (packages/core mutation boundaries) is
 * asserted here against the real NodeFileSystem adapter on REAL Windows
 * NTFS directory junctions — the doc 17 §2 methodology, now permanent. The
 * emulated tier (f23-write-boundary.test.ts) carries the same classes on
 * every CI host; this tier proves the guard against the OS's own alias
 * resolution and pins the Node adapter's link-reporting contract.
 *
 * Honesty split (carried from doc 17 §3): junctions are directory aliases;
 * file symlinks need developer mode/admin on Windows and are NOT executed
 * here — the write-leaf symlink class is covered by the emulated tier, and
 * its native equivalence is asserted by the same OS mechanism, not executed.
 *
 * Documented residual (not a test, by design): an alias RETARGETED between
 * the guard's inspection and the OS call (doc 17 §2 B6) is a structural
 * TOCTOU window no decide-then-act guard can close on today's path-string
 * contract — only narrowed by scan placement. An alias INSERTED before
 * mutation-time inspection (A6) IS detected; that distinction is pinned in
 * the A6 test below. No all-schedules protection is claimed anywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { NodeFileSystem } from '../../packages/platform-node/src/index';
import {
    BuildSession,
    planScopedModRebuild,
} from '../../packages/core/src/buildsession';
import { planBuild } from '../../packages/core/src/buildplan';
import {
    executeFileOperations,
    type OperationLogger,
} from '../../packages/core/src/execute';
import type { BuildSessionHost } from '../../packages/core/src/buildsession';
import type { PlanBuildInput } from '../../packages/core/src/buildplan';
import type { IProjectConfig } from '../../packages/core/src/project';
import type { FileOperation } from '../../packages/core/src/buildplan';

let sandbox: string;

beforeEach(async () => {
    sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'f23-write-boundary-'));
    // Standard fixture: source mod, template, configured outdir root.
    await fsp.mkdir(path.join(sandbox, 'proj', 'my_mod', 'media', 'lua'), {
        recursive: true,
    });
    await fsp.writeFile(
        path.join(sandbox, 'proj', 'my_mod', 'media', 'lua', 'hello.lua'),
        'hello-v1',
    );
    await fsp.writeFile(
        path.join(sandbox, 'proj', 'my_mod', 'media', 'other.lua'),
        'other-v1',
    );
    await fsp.mkdir(path.join(sandbox, 'tpl', 'Contents'), { recursive: true });
    await fsp.writeFile(
        path.join(sandbox, 'tpl', 'Contents', 'template-file.txt'),
        'tpl',
    );
    await fsp.mkdir(path.join(sandbox, 'out'));
});

afterEach(async () => {
    await fsp.rm(sandbox, { recursive: true, force: true, maxRetries: 5 });
});

const PROJ = () => path.join(sandbox, 'proj');
const OUT = () => path.join(sandbox, 'out');
const OUT_VP = () => path.join(OUT(), 'Sync Project');
const OUT_MOD = () => path.join(OUT_VP(), 'Contents', 'mods', 'my_mod');

function config(): IProjectConfig {
    return {
        workshop: {
            id: 12345,
            title: 'Sync Project',
            visibility: 'public',
            tags: [],
        },
        mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
        excludes: [],
        outdir: OUT(),
    } as unknown as IProjectConfig;
}

async function planInput(): Promise<Omit<PlanBuildInput, 'variant'>> {
    const state = {
        branchFolders: [] as string[],
        modInfoExists: {} as Record<string, boolean>,
        modInfoContent: {} as Record<string, string | undefined>,
    };
    state.modInfoExists[''] = false;
    state.modInfoContent[''] = undefined;
    try {
        state.modInfoContent[''] = await fsp.readFile(
            path.join(PROJ(), 'my_mod', 'mod.info'),
            'utf8',
        );
        state.modInfoExists[''] = true;
    } catch {
        // no root mod.info (Build 41 layout)
    }
    return {
        config: config(),
        workshopTemplateDir: path.join(sandbox, 'tpl'),
        projectDir: PROJ(),
        modSourceStates: { my_mod: state },
        descriptionLines: [],
        previewPngExists: false,
    };
}

function host(fs: NodeFileSystem): {
    host: BuildSessionHost;
    logs: string[];
} {
    const logs: string[] = [];
    return {
        host: {
            fs,
            getPlanInput: planInput,
            log: (level: Parameters<OperationLogger>[0], message: string) =>
                logs.push(`${level}:${message}`),
        },
        logs,
    };
}

/** Creates a real NTFS junction (no privilege required). */
async function junction(link: string, target: string): Promise<void> {
    await fsp.symlink(target, link, 'junction');
}

describe.skipIf(process.platform !== 'win32')(
    'F23-WB native: adapter contract (doc 17 §11 header probe, permanent)',
    () => {
        it('NodeFileSystem.list reports a junction as symbolicLink and stat follows it', async () => {
            await fsp.mkdir(path.join(sandbox, 'probe', 'real'), {
                recursive: true,
            });
            await fsp.writeFile(
                path.join(sandbox, 'probe', 'real', 'f.txt'),
                'x',
            );
            await junction(
                path.join(sandbox, 'probe', 'alias'),
                path.join(sandbox, 'probe', 'real'),
            );
            const adapter = new NodeFileSystem();
            const entries = await adapter.list(path.join(sandbox, 'probe'));
            const alias = entries.find((entry) => entry.name === 'alias');
            const real = entries.find((entry) => entry.name === 'real');
            expect(alias?.type).toBe('symbolicLink');
            expect(real?.type).toBe('directory');
            // stat FOLLOWS the junction — insufficient for alias detection;
            // this is why the guard inspects listings, not stat types.
            expect((await adapter.stat(alias!.uri)).type).toBe('directory');
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'F23-WB native: recursive deletion through a junction ancestor',
    () => {
        it('B4-ii: scoped rebuild reset through Contents/mods → source is refused, source byte-identical', async () => {
            const adapter = new NodeFileSystem();
            const { host: sessionHost } = host(adapter);
            const input = await planInput();
            await fsp.mkdir(path.join(OUT_VP(), 'Contents'), {
                recursive: true,
            });
            await junction(path.join(OUT_VP(), 'Contents', 'mods'), PROJ());
            const sourceBefore = await fsp.readFile(
                path.join(PROJ(), 'my_mod', 'media', 'lua', 'hello.lua'),
            );

            const plan = planScopedModRebuild(input, 'main', 'my_mod');
            await expect(
                executeFileOperations(adapter, plan, undefined, {
                    outputRoot: OUT(),
                }),
            ).rejects.toThrow(/symbolic link/i);

            expect(
                await fsp.readFile(
                    path.join(PROJ(), 'my_mod', 'media', 'lua', 'hello.lua'),
                ),
            ).toEqual(sourceBefore);
            expect(
                fs.existsSync(
                    path.join(PROJ(), 'my_mod', 'media', 'other.lua'),
                ),
            ).toBe(true);
            expect(fs.existsSync(path.join(PROJ(), 'my_mod', 'media'))).toBe(
                true,
            );
        });

        it('B4-ii via BuildSession: a scoped rebuild through the junction surfaces the refusal and the source survives', async () => {
            const adapter = new NodeFileSystem();
            const { host: sessionHost } = host(adapter);
            const session = new BuildSession(sessionHost);
            await session.start(['main']);
            // A full build's reset heals links inside the variant folder;
            // the exposed flow is the scoped rebuild (reset target below the
            // junction). The real mods directory must be removed before the
            // junction can take its place (EEXIST).
            await fsp.rm(path.join(OUT_VP(), 'Contents', 'mods'), {
                recursive: true,
                force: true,
            });
            await junction(path.join(OUT_VP(), 'Contents', 'mods'), PROJ());

            const result = await session.apply([
                {
                    type: 'change',
                    path: path.join(PROJ(), 'my_mod', 'mod.info'),
                },
            ]);

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors.join('\n')).toMatch(/symbolic link/i);
            expect(
                fs.existsSync(path.join(PROJ(), 'my_mod', 'media', 'lua')),
            ).toBe(true);
            expect(
                fs.readFileSync(
                    path.join(PROJ(), 'my_mod', 'media', 'lua', 'hello.lua'),
                    'utf8',
                ),
            ).toBe('hello-v1');
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'F23-WB native: incremental sync through a planted junction',
    () => {
        /** Clean build, then the output media swapped for a junction. */
        async function sessionWithMediaJunction(target: string) {
            const adapter = new NodeFileSystem();
            const { host: sessionHost } = host(adapter);
            const session = new BuildSession(sessionHost);
            await session.start(['main']);
            await fsp.rm(path.join(OUT_MOD(), 'media'), {
                recursive: true,
                force: true,
            });
            await junction(path.join(OUT_MOD(), 'media'), target);
            return session;
        }

        it('B4-iii: an incremental delete no longer deletes the source file; the refusal is reported', async () => {
            const session = await sessionWithMediaJunction(PROJ());
            const source = path.join(
                PROJ(),
                'my_mod',
                'media',
                'lua',
                'hello.lua',
            );

            const result = await session.apply([
                { type: 'delete', path: source },
            ]);

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors.join('\n')).toMatch(/symbolic link/i);
            expect(result.incremental).toBe(0);
            expect(fs.readFileSync(source, 'utf8')).toBe('hello-v1');
        });

        it('B4-iv: an incremental change no longer overwrites the external victim; the refusal is reported', async () => {
            const victim = path.join(sandbox, 'victim-iv');
            await fsp.mkdir(path.join(victim, 'lua'), { recursive: true });
            const victimFile = path.join(victim, 'lua', 'hello.lua');
            await fsp.writeFile(victimFile, 'VICTIM-BYTES');
            const session = await sessionWithMediaJunction(victim);

            const result = await session.apply([
                {
                    type: 'change',
                    path: path.join(
                        PROJ(),
                        'my_mod',
                        'media',
                        'lua',
                        'hello.lua',
                    ),
                },
            ]);

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors.join('\n')).toMatch(/symbolic link/i);
            expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-BYTES');
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'F23-WB native: preservation and boundaries',
    () => {
        it('A6: a junction planted after the reset, before the copy ops, is detected at mutation-time inspection', async () => {
            const adapter = new NodeFileSystem();
            const input = await planInput();
            const plan = planBuild({ ...input, variant: 'main' });
            // Split: the plan's reset first, then plant the alias, then the
            // mutating remainder.
            const resetOps = plan.slice(0, 2);
            const restOps = plan.slice(2);
            await executeFileOperations(adapter, resetOps, undefined, {
                outputRoot: OUT(),
            });

            const victim = path.join(sandbox, 'victim6');
            await fsp.mkdir(victim);
            await fsp.writeFile(path.join(victim, 'keep.txt'), 'A6-KEEP');
            await fsp.mkdir(path.join(OUT_MOD()), { recursive: true });
            await junction(path.join(OUT_MOD(), 'media'), victim);

            await expect(
                executeFileOperations(adapter, restOps, undefined, {
                    outputRoot: OUT(),
                }),
            ).rejects.toThrow(/symbolic link/i);

            expect(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8')).toBe(
                'A6-KEEP',
            );
            // Partial output before the refusal is disclosed on disk.
            expect(
                fs.existsSync(
                    path.join(OUT_VP(), 'Contents/template-file.txt'),
                ),
            ).toBe(true);
        });

        it('A4a: a user-configured junction outdir still builds at the resolved root (T2, permissive bound)', async () => {
            // The configured outdir root itself is a junction.
            const target = path.join(sandbox, 'out-target');
            await fsp.mkdir(target);
            await fsp.rm(OUT(), { recursive: true, force: true });
            await junction(OUT(), target);
            // Pre-existing unowned content in the resolved variant folder —
            // its destruction is the E1 boundary (doc 15), pinned here as
            // documented current behavior, NOT an alias-route escape.
            const legacy = path.join(
                target,
                'Sync Project',
                'Contents',
                'mods',
                'legacy',
            );
            await fsp.mkdir(legacy, { recursive: true });
            await fsp.writeFile(
                path.join(legacy, 'userfile.lua'),
                'LEGACY-USER',
            );

            const adapter = new NodeFileSystem();
            const input = await planInput();

            await executeFileOperations(
                adapter,
                planBuild({ ...input, variant: 'main' }),
                undefined,
                { outputRoot: OUT() },
            );

            // The build landed inside the junction's target...
            expect(
                fs.readFileSync(
                    path.join(target, 'Sync Project', 'workshop.txt'),
                    'utf8',
                ),
            ).toContain('title=Sync Project');
            expect(
                fs.readFileSync(
                    path.join(
                        target,
                        'Sync Project',
                        'Contents',
                        'mods',
                        'my_mod',
                        'media',
                        'lua',
                        'hello.lua',
                    ),
                    'utf8',
                ),
            ).toBe('hello-v1');
            // ...and the E1 destruction inside the resolved root still
            // occurs pending doc 15 §11.1 (this is NOT closed by the guard).
            expect(fs.existsSync(path.join(legacy, 'userfile.lua'))).toBe(
                false,
            );
        });

        it('B1: removing a tree containing a junction removes the link, never the target', async () => {
            const adapter = new NodeFileSystem();
            const input = await planInput();
            const jtarget = path.join(sandbox, 'jtarget');
            await fsp.mkdir(jtarget);
            await fsp.writeFile(
                path.join(jtarget, 'B1-TARGET-KEEP.txt'),
                'keep',
            );
            await fsp.mkdir(path.join(OUT_VP(), 'jdir'), { recursive: true });
            await junction(path.join(OUT_VP(), 'jdir', 'jlink'), jtarget);

            // The full-build reset removes OUT_VP (junction inside, as child).
            const { planBuild } =
                await import('../../packages/core/src/buildplan');
            await executeFileOperations(
                adapter,
                planBuild({ ...input, variant: 'main' }),
                undefined,
                { outputRoot: OUT() },
            );

            expect(
                fs.existsSync(path.join(jtarget, 'B1-TARGET-KEEP.txt')),
            ).toBe(true);
            expect(fs.existsSync(path.join(OUT_VP(), 'jdir', 'jlink'))).toBe(
                false,
            );
        });

        it('missing-leaf delete on a clean chain stays the self-healing no-op', async () => {
            const adapter = new NodeFileSystem();
            await expect(
                executeFileOperations(
                    adapter,
                    [
                        {
                            type: 'removeDir',
                            path: path.join(OUT(), 'never-existed'),
                        },
                    ],
                    undefined,
                    { outputRoot: OUT() },
                ),
            ).resolves.toBeUndefined();
        });
    },
);
