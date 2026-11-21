import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { planBuild } from '../../packages/core/src/buildplan';
import type { PlanBuildInput } from '../../packages/core/src/buildplan';
import type { IProjectConfig } from '../../packages/core/src/project';
import { executeBuildPlan } from '../../packages/cli/src/lib/commands/build';
import { cleanOutputPath } from '../../packages/cli/src/lib/commands/clean';
import { assertNoAliasDestinationEntry } from '../../packages/cli/src/lib/mutation-route-guard';
import {
    createIgnoreFilter,
    scaffoldProject,
} from '../../packages/cli/src/lib/templateManager';

let sandbox: string;

beforeEach(async () => {
    sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-mutation-route-'));
    await fsp.mkdir(path.join(sandbox, 'proj', 'my_mod', 'media', 'lua'), {
        recursive: true,
    });
    await fsp.writeFile(
        path.join(sandbox, 'proj', 'my_mod', 'media', 'lua', 'hello.lua'),
        'hello-v1',
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
const OUT_DEV_VP = () => path.join(OUT(), 'Sync Project - dev_branch');
const OUT_MOD = () => path.join(OUT_VP(), 'Contents', 'mods', 'my_mod');

function config(outdir = OUT()): IProjectConfig {
    return {
        workshop: {
            id: 12345,
            title: 'Sync Project',
            visibility: 'public',
            tags: [],
        },
        mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
        excludes: [],
        outdir,
    } as unknown as IProjectConfig;
}

function planInput(outdir = OUT()): Omit<PlanBuildInput, 'variant'> {
    return {
        config: config(outdir),
        workshopTemplateDir: path.join(sandbox, 'tpl'),
        projectDir: PROJ(),
        modSourceStates: {
            my_mod: {
                branchFolders: [],
                modInfoExists: { '': false },
                modInfoContent: { '': undefined },
            },
        },
        descriptionLines: [],
        previewPngExists: false,
    };
}

async function junction(link: string, target: string): Promise<void> {
    await fsp.symlink(target, link, 'junction');
}

async function treeSnapshot(root: string): Promise<Record<string, string>> {
    const snap: Record<string, string> = {};
    const walk = async (dir: string, rel: string): Promise<void> => {
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            const child = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                snap[childRel] = '<link>';
            } else if (entry.isDirectory()) {
                await walk(child, childRel);
            } else {
                snap[childRel] = await fsp.readFile(child, 'utf8');
            }
        }
    };
    await walk(root, '');
    return snap;
}

function runResetPrefix(
    variant: 'main' | 'development' = 'main',
    outdir = OUT(),
): ReturnType<typeof planBuild> {
    const plan = planBuild({ ...planInput(outdir), variant });
    if (plan[0].type !== 'removeDir' || plan[1].type !== 'makeDir') {
        throw new Error('planBuild shape changed — update the staging split');
    }
    executeBuildPlan(plan.slice(0, 2), { outputRoot: outdir });
    return plan;
}

describe.skipIf(process.platform !== 'win32')(
    'CLI-P0-R1: external write redirection through a below-root junction (S3)',
    () => {
        it('refuses the mod copyTree onto a junction destination; victim bytes unchanged; partial output disclosed', async () => {
            const victim = path.join(sandbox, 'victim');
            await fsp.mkdir(path.join(victim, 'media', 'lua'), {
                recursive: true,
            });
            await fsp.writeFile(
                path.join(victim, 'media', 'lua', 'hello.lua'),
                'S3-VICTIM-BYTES',
            );
            await fsp.writeFile(path.join(victim, 'SENTINEL.txt'), 'KEEP');

            const plan = runResetPrefix();
            await fsp.mkdir(path.join(OUT_VP(), 'Contents', 'mods'), {
                recursive: true,
            });
            await junction(OUT_MOD(), victim);

            let refusal: Error | undefined;
            try {
                executeBuildPlan(plan.slice(2), { outputRoot: OUT() });
            } catch (e) {
                refusal = e as Error;
            }

            expect(refusal).toBeInstanceOf(Error);
            expect(refusal!.message).toMatch(/symbolic link/i);
            expect(refusal!.message).toContain('my_mod');
            expect(refusal!.message).toContain(OUT_MOD().replace(/\\/g, '/'));
            expect(
                await fsp.readFile(
                    path.join(victim, 'media', 'lua', 'hello.lua'),
                    'utf8',
                ),
            ).toBe('S3-VICTIM-BYTES');
            expect(
                await fsp.readFile(path.join(victim, 'SENTINEL.txt'), 'utf8'),
            ).toBe('KEEP');
            expect(
                fs.existsSync(
                    path.join(OUT_VP(), 'Contents', 'template-file.txt'),
                ),
            ).toBe(true);
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'CLI-P0-R2: cross-variant write redirection (S5)',
    () => {
        it('refuses a main build whose mods junction targets dev territory; dev bytes and entries unchanged', async () => {
            executeBuildPlan(
                planBuild({ ...planInput(), variant: 'development' }),
                { outputRoot: OUT() },
            );
            const devHello = path.join(
                OUT_DEV_VP(),
                'Contents',
                'mods',
                'my_mod_dev',
                'media',
                'lua',
                'hello.lua',
            );
            expect(fs.existsSync(devHello)).toBe(true);
            expect(fs.readFileSync(devHello, 'utf8')).toBe('hello-v1');
            await fsp.writeFile(
                path.join(PROJ(), 'my_mod', 'media', 'lua', 'hello.lua'),
                'hello-v2-MAIN',
            );
            const devBefore = await treeSnapshot(OUT_DEV_VP());

            const plan = runResetPrefix();
            await fsp.mkdir(path.join(OUT_VP(), 'Contents'), {
                recursive: true,
            });
            await junction(
                path.join(OUT_VP(), 'Contents', 'mods'),
                path.join(OUT_DEV_VP(), 'Contents', 'mods'),
            );

            let refusal: Error | undefined;
            try {
                executeBuildPlan(plan.slice(2), { outputRoot: OUT() });
            } catch (e) {
                refusal = e as Error;
            }

            expect(refusal).toBeInstanceOf(Error);
            expect(refusal!.message).toMatch(/symbolic link/i);
            expect(refusal!.message).toContain('mods');
            expect(await treeSnapshot(OUT_DEV_VP())).toEqual(devBefore);
            expect(fs.readFileSync(devHello, 'utf8')).toBe('hello-v1');
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'CLI-P0-R3: dangling below-root destination alias (S7)',
    () => {
        it('converts the cryptic dangling-junction failure into an alias-naming refusal, with no spelled-target mutation', async () => {
            const danglingTarget = path.join(sandbox, 'no-such-target');

            const plan = runResetPrefix();
            await fsp.mkdir(path.join(OUT_VP(), 'Contents'), {
                recursive: true,
            });
            await junction(
                path.join(OUT_VP(), 'Contents', 'mods'),
                danglingTarget,
            );

            let error: Error | undefined;
            try {
                executeBuildPlan(plan.slice(2), { outputRoot: OUT() });
            } catch (e) {
                error = e as Error;
            }

            expect(error).toBeInstanceOf(Error);
            expect(error!.message).toMatch(/symbolic link/i);
            expect(error!.message).toContain('mods');
            expect(fs.existsSync(danglingTarget)).toBe(false);
            expect(fs.existsSync(path.join(danglingTarget, 'my_mod'))).toBe(
                false,
            );
        });
    },
);

function probeFileSymlinkSupport(): boolean {
    const probeDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'cli-symlink-probe-'),
    );
    try {
        const target = path.join(probeDir, 'target.txt');
        fs.writeFileSync(target, 'x');
        fs.symlinkSync(target, path.join(probeDir, 'link.txt'), 'file');
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(probeDir, { recursive: true, force: true, maxRetries: 5 });
    }
}

describe.skipIf(process.platform !== 'win32' || !probeFileSymlinkSupport())(
    'CLI-P0-R4: write-leaf file symlink (native tier, skips without symlink privilege)',
    () => {
        it('writeFile onto a file-symlink leaf is refused; no write-through to the victim', async () => {
            const victimFile = path.join(sandbox, 'victim-file.txt');
            await fsp.writeFile(victimFile, 'R4-VICTIM-BYTES');
            await fsp.mkdir(OUT_VP(), { recursive: true });
            await fsp.symlink(
                victimFile,
                path.join(OUT_VP(), 'leaf.lua'),
                'file',
            );

            expect(() =>
                executeBuildPlan(
                    [
                        {
                            type: 'writeFile',
                            path: path.join(OUT_VP(), 'leaf.lua'),
                            content: 'written-through',
                        },
                    ],
                    { outputRoot: OUT() },
                ),
            ).toThrow(/symbolic link/i);

            expect(await fsp.readFile(victimFile, 'utf8')).toBe(
                'R4-VICTIM-BYTES',
            );
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'CLI-P0-R4: write-leaf alias (junction-native tier)',
    () => {
        it('writeFile onto a junction-named leaf is refused with an alias-naming error (not a cryptic OS error)', async () => {
            const jtarget = path.join(sandbox, 'r4-jtarget');
            await fsp.mkdir(jtarget);
            await fsp.mkdir(OUT_VP(), { recursive: true });
            await junction(path.join(OUT_VP(), 'workshop.txt'), jtarget);

            expect(() =>
                executeBuildPlan(
                    [
                        {
                            type: 'writeFile',
                            path: path.join(OUT_VP(), 'workshop.txt'),
                            content: 'title=leaked',
                        },
                    ],
                    { outputRoot: OUT() },
                ),
            ).toThrow(/symbolic link/i);

            expect(fs.existsSync(path.join(jtarget, 'anything'))).toBe(false);
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'CLI-P0-R5: scaffoldProject destination-entry guard',
    () => {
        const MOD_SRC = () => path.join(sandbox, 'modsrc');

        beforeEach(async () => {
            await fsp.mkdir(path.join(MOD_SRC(), 'media', 'lua'), {
                recursive: true,
            });
            await fsp.writeFile(
                path.join(MOD_SRC(), 'media', 'lua', 'hello.lua'),
                'hello-v1',
            );
        });

        it('refuses a copy whose destination ancestor chain passes through a junction (victim untouched)', async () => {
            const victim = path.join(sandbox, 'victim');
            await fsp.mkdir(path.join(victim, 'my_mod'), { recursive: true });
            await fsp.writeFile(
                path.join(victim, 'my_mod', 'SENTINEL.txt'),
                'R5A-KEEP',
            );
            await fsp.mkdir(path.join(OUT_VP()), { recursive: true });
            await junction(path.join(OUT_VP(), 'Contents'), victim);

            expect(() =>
                scaffoldProject(
                    MOD_SRC(),
                    path.join(OUT_VP(), 'Contents', 'mods', 'my_mod'),
                    false,
                    false,
                    { outputRoot: OUT() },
                ),
            ).toThrow(/symbolic link/i);

            expect(
                await fsp.readFile(
                    path.join(victim, 'my_mod', 'SENTINEL.txt'),
                    'utf8',
                ),
            ).toBe('R5A-KEEP');
            expect(
                fs.existsSync(
                    path.join(victim, 'my_mod', 'media', 'lua', 'hello.lua'),
                ),
            ).toBe(false);
        });

        it('refuses a copy onto a destination root that is itself a junction (no write-through)', async () => {
            const victim = path.join(sandbox, 'victim-b');
            await fsp.mkdir(path.join(victim, 'media', 'lua'), {
                recursive: true,
            });
            await fsp.writeFile(
                path.join(victim, 'media', 'lua', 'hello.lua'),
                'R5B-VICTIM',
            );
            const destDir = path.join(OUT_VP(), 'Contents', 'mods', 'my_mod');
            await fsp.mkdir(path.dirname(destDir), { recursive: true });
            await junction(destDir, victim);

            expect(() =>
                scaffoldProject(MOD_SRC(), destDir, false, false, {
                    outputRoot: OUT(),
                }),
            ).toThrow(/symbolic link/i);

            expect(
                await fsp.readFile(
                    path.join(victim, 'media', 'lua', 'hello.lua'),
                    'utf8',
                ),
            ).toBe('R5B-VICTIM');
        });

        it('refuses a deeper destination entry the walk would descend through, naming it', async () => {
            const victim = path.join(sandbox, 'victim-c');
            await fsp.mkdir(path.join(victim, 'lua'), { recursive: true });
            await fsp.writeFile(
                path.join(victim, 'lua', 'hello.lua'),
                'R5C-VICTIM',
            );
            const destDir = path.join(OUT_VP(), 'Contents', 'mods', 'my_mod');
            await fsp.mkdir(destDir, { recursive: true });
            await junction(path.join(destDir, 'media'), victim);

            let refusal: Error | undefined;
            try {
                scaffoldProject(MOD_SRC(), destDir, false, false, {
                    outputRoot: OUT(),
                });
            } catch (e) {
                refusal = e as Error;
            }

            expect(refusal).toBeInstanceOf(Error);
            expect(refusal!.message).toMatch(/symbolic link/i);
            expect(refusal!.message).toContain('media');

            expect(
                await fsp.readFile(
                    path.join(victim, 'lua', 'hello.lua'),
                    'utf8',
                ),
            ).toBe('R5C-VICTIM');
        });

        it('does not refuse an unrelated destination link the copy never touches', async () => {
            const unrelatedTarget = path.join(sandbox, 'unrelated');
            await fsp.mkdir(unrelatedTarget);
            await fsp.writeFile(
                path.join(unrelatedTarget, 'KEEP.txt'),
                'R5D-KEEP',
            );
            const destDir = path.join(OUT_VP(), 'Contents', 'mods', 'my_mod');
            await fsp.mkdir(destDir, { recursive: true });
            await junction(
                path.join(destDir, 'unrelated-link'),
                unrelatedTarget,
            );

            scaffoldProject(MOD_SRC(), destDir, false, false, {
                outputRoot: OUT(),
            });

            expect(
                fs.readFileSync(
                    path.join(destDir, 'media', 'lua', 'hello.lua'),
                    'utf8',
                ),
            ).toBe('hello-v1');
            expect(
                fs
                    .lstatSync(path.join(destDir, 'unrelated-link'))
                    .isSymbolicLink(),
            ).toBe(true);
            expect(
                fs.readFileSync(path.join(unrelatedTarget, 'KEEP.txt'), 'utf8'),
            ).toBe('R5D-KEEP');
        });

        it('copies normally onto a fresh (missing) destination chain — no false failure', () => {
            const destDir = path.join(OUT_VP(), 'Contents', 'mods', 'my_mod');

            scaffoldProject(MOD_SRC(), destDir, false, false, {
                outputRoot: OUT(),
            });

            expect(
                fs.readFileSync(
                    path.join(destDir, 'media', 'lua', 'hello.lua'),
                    'utf8',
                ),
            ).toBe('hello-v1');
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'CLI-P0-F1: ignored source entry with a junction at its destination name',
    () => {
        const F1_SRC = () => path.join(sandbox, 'f1src');
        const F1_VICTIM = () => path.join(sandbox, 'f1victim');

        beforeEach(async () => {
            await fsp.mkdir(path.join(F1_SRC(), 'media', 'lua'), {
                recursive: true,
            });
            await fsp.writeFile(
                path.join(F1_SRC(), 'media', '.pzstudioignore'),
                'lua\n',
            );
            await fsp.writeFile(
                path.join(F1_SRC(), 'media', 'lua', 'ignored.lua'),
                'F1-IGNORED',
            );
            await fsp.writeFile(
                path.join(F1_SRC(), 'media', 'modfile.txt'),
                'F1-TPL',
            );
            await fsp.mkdir(F1_VICTIM(), { recursive: true });
            await fsp.writeFile(
                path.join(F1_VICTIM(), 'KEEP.txt'),
                'F1-VICTIM-KEEP',
            );
        });

        it('F1-R1: an ignored source entry does not trigger a destination-entry refusal; the junction is untouched and nothing is written through it', async () => {
            const destDir = OUT_MOD();
            await fsp.mkdir(path.join(destDir, 'media'), {
                recursive: true,
            });
            await junction(path.join(destDir, 'media', 'lua'), F1_VICTIM());

            let error: Error | undefined;
            try {
                scaffoldProject(F1_SRC(), destDir, false, false, {
                    outputRoot: OUT(),
                });
            } catch (e) {
                error = e as Error;
            }

            expect(error).toBeUndefined();
            expect(
                await fsp.readFile(
                    path.join(destDir, 'media', 'modfile.txt'),
                    'utf8',
                ),
            ).toBe('F1-TPL');
            expect(
                await fsp.readFile(
                    path.join(destDir, 'media', '.pzstudioignore'),
                    'utf8',
                ),
            ).toBe('lua\n');
            expect(
                fs
                    .lstatSync(path.join(destDir, 'media', 'lua'))
                    .isSymbolicLink(),
            ).toBe(true);
            expect(
                await fsp.readFile(path.join(F1_VICTIM(), 'KEEP.txt'), 'utf8'),
            ).toBe('F1-VICTIM-KEEP');
            expect(fs.existsSync(path.join(F1_VICTIM(), 'ignored.lua'))).toBe(
                false,
            );
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'CLI-P0-R6: mutation-site coverage matrix',
    () => {
        it('removeDir through a junction ANCESTOR is refused; the target behind it survives', async () => {
            const target = path.join(sandbox, 'r6-target');
            await fsp.mkdir(path.join(target, 'inner'), { recursive: true });
            await fsp.writeFile(
                path.join(target, 'inner', 'KEEP.txt'),
                'R6-DEL-KEEP',
            );
            await fsp.mkdir(path.join(OUT_VP(), 'Contents'), {
                recursive: true,
            });
            await junction(path.join(OUT_VP(), 'Contents', 'mods'), target);
            const victim = path.join(OUT_VP(), 'Contents', 'mods', 'my_mod');

            expect(() =>
                executeBuildPlan([{ type: 'removeDir', path: victim }], {
                    outputRoot: OUT(),
                }),
            ).toThrow(/symbolic link/i);

            expect(
                fs.readFileSync(path.join(target, 'inner', 'KEEP.txt'), 'utf8'),
            ).toBe('R6-DEL-KEEP');
        });

        it('removeDir of a junction LEAF removes the link only (G2 delete-leaf exemption)', async () => {
            const target = path.join(sandbox, 'r6-leaf-target');
            await fsp.mkdir(target);
            await fsp.writeFile(path.join(target, 'KEEP.txt'), 'G2-KEEP');
            await fsp.mkdir(OUT_VP(), { recursive: true });
            const leaf = path.join(OUT_VP(), 'linked-variant');
            await junction(leaf, target);

            executeBuildPlan([{ type: 'removeDir', path: leaf }], {
                outputRoot: OUT(),
            });

            expect(fs.existsSync(leaf)).toBe(false);
            expect(fs.readFileSync(path.join(target, 'KEEP.txt'), 'utf8')).toBe(
                'G2-KEEP',
            );
        });

        it('removeDir of a missing leaf on a clean chain stays the self-healing no-op', () => {
            expect(() =>
                executeBuildPlan(
                    [
                        {
                            type: 'removeDir',
                            path: path.join(OUT(), 'never-existed'),
                        },
                    ],
                    { outputRoot: OUT() },
                ),
            ).not.toThrow();
        });

        it('makeDir through a junction ancestor is refused', async () => {
            const target = path.join(sandbox, 'r6-mkdir-target');
            await fsp.mkdir(path.join(target, 'KEEP'), { recursive: true });
            await fsp.mkdir(path.join(OUT_VP(), 'Contents'), {
                recursive: true,
            });
            await junction(path.join(OUT_VP(), 'Contents', 'mods'), target);

            expect(() =>
                executeBuildPlan(
                    [
                        {
                            type: 'makeDir',
                            path: path.join(
                                OUT_VP(),
                                'Contents',
                                'mods',
                                'my_mod',
                            ),
                        },
                    ],
                    { outputRoot: OUT() },
                ),
            ).toThrow(/symbolic link/i);
            expect(fs.existsSync(path.join(target, 'my_mod'))).toBe(false);
        });

        it('makeDir on a fresh chain succeeds (first-build shape)', () => {
            expect(() =>
                executeBuildPlan(
                    [
                        {
                            type: 'makeDir',
                            path: path.join(
                                OUT(),
                                'Sync Project',
                                'Contents',
                                'mods',
                                'my_mod',
                            ),
                        },
                    ],
                    { outputRoot: OUT() },
                ),
            ).not.toThrow();
            expect(
                fs.existsSync(
                    path.join(
                        OUT(),
                        'Sync Project',
                        'Contents',
                        'mods',
                        'my_mod',
                    ),
                ),
            ).toBe(true);
        });

        it('writeFile through a junction ancestor is refused', async () => {
            const victimFile = path.join(sandbox, 'r6-w-victim.txt');
            await fsp.mkdir(path.join(sandbox, 'r6-w-target'), {
                recursive: true,
            });
            await fsp.writeFile(victimFile, 'R6-W-KEEP');
            await fsp.mkdir(path.join(OUT_VP(), 'Contents'), {
                recursive: true,
            });
            await junction(
                path.join(OUT_VP(), 'Contents', 'mods'),
                path.join(sandbox, 'r6-w-target'),
            );

            expect(() =>
                executeBuildPlan(
                    [
                        {
                            type: 'writeFile',
                            path: path.join(
                                OUT_VP(),
                                'Contents',
                                'mods',
                                'my_mod',
                                'mod.info',
                            ),
                            content: 'name=leaked',
                        },
                    ],
                    { outputRoot: OUT() },
                ),
            ).toThrow(/symbolic link/i);
            expect(fs.existsSync(victimFile)).toBe(true);
            expect(
                fs.existsSync(path.join(sandbox, 'r6-w-target', 'my_mod')),
            ).toBe(false);
        });

        it('writeFile onto an existing normal leaf stays allowed (class 4 — ownership is E1, not this guard)', async () => {
            await fsp.mkdir(OUT_VP(), { recursive: true });
            await fsp.writeFile(path.join(OUT_VP(), 'workshop.txt'), 'old');

            expect(() =>
                executeBuildPlan(
                    [
                        {
                            type: 'writeFile',
                            path: path.join(OUT_VP(), 'workshop.txt'),
                            content: 'new',
                        },
                    ],
                    { outputRoot: OUT() },
                ),
            ).not.toThrow();
            expect(
                await fsp.readFile(path.join(OUT_VP(), 'workshop.txt'), 'utf8'),
            ).toBe('new');
        });

        it('copyFile onto a junction leaf is refused', async () => {
            const target = path.join(sandbox, 'r6-cp-target');
            await fsp.mkdir(path.join(target, 'media', 'lua'), {
                recursive: true,
            });
            await fsp.writeFile(
                path.join(target, 'media', 'lua', 'hello.lua'),
                'R6-CP-VICTIM',
            );
            const leaf = path.join(OUT_VP(), 'hello.lua');
            await fsp.mkdir(OUT_VP(), { recursive: true });
            await junction(leaf, target);

            expect(() =>
                executeBuildPlan(
                    [
                        {
                            type: 'copyFile',
                            from: path.join(
                                PROJ(),
                                'my_mod',
                                'media',
                                'lua',
                                'hello.lua',
                            ),
                            to: leaf,
                        },
                    ],
                    { outputRoot: OUT() },
                ),
            ).toThrow(/symbolic link/i);
            expect(
                fs.readFileSync(
                    path.join(target, 'media', 'lua', 'hello.lua'),
                    'utf8',
                ),
            ).toBe('R6-CP-VICTIM');
        });

        it('copyFile to a fresh destination succeeds', async () => {
            const srcFile = path.join(sandbox, 'r6-cp-src.txt');
            await fsp.writeFile(srcFile, 'cp-ok');

            expect(() =>
                executeBuildPlan(
                    [
                        {
                            type: 'copyFile',
                            from: srcFile,
                            to: path.join(OUT_VP(), 'copied.txt'),
                        },
                    ],
                    { outputRoot: OUT() },
                ),
            ).not.toThrow();
            expect(
                await fsp.readFile(path.join(OUT_VP(), 'copied.txt'), 'utf8'),
            ).toBe('cp-ok');
        });

        it('a mutation outside the declared output root is refused outright', () => {
            const outside = path.join(sandbox, 'elsewhere');

            expect(() =>
                executeBuildPlan([{ type: 'makeDir', path: outside }], {
                    outputRoot: OUT(),
                }),
            ).toThrow(/not inside the configured build output root/i);
            expect(fs.existsSync(outside)).toBe(false);
        });

        it('a plain file as a route component is not an alias: the guard defers and the OS error surfaces (Core parity)', async () => {
            await fsp.mkdir(OUT_VP(), { recursive: true });
            await fsp.writeFile(path.join(OUT_VP(), 'Contents'), 'a file');

            expect(() =>
                executeBuildPlan(
                    [
                        {
                            type: 'writeFile',
                            path: path.join(
                                OUT_VP(),
                                'Contents',
                                'mods',
                                'my_mod',
                                'mod.info',
                            ),
                            content: 'x',
                        },
                    ],
                    { outputRoot: OUT() },
                ),
            ).toThrow(/ENOENT|no such file or directory/i);
        });

        it('a route directory that cannot be listed (failure other than not-there) fails explicitly', async () => {
            await fsp.mkdir(OUT_VP(), { recursive: true });

            const realReaddirSync = fs.readdirSync;
            const eperm = new Error(
                'EPERM: operation not permitted, scandir',
            ) as NodeJS.ErrnoException;
            eperm.code = 'EPERM';
            const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((
                dir: any,
            ) => {
                if (
                    String(dir).replace(/\\/g, '/') ===
                    OUT_VP().replace(/\\/g, '/')
                ) {
                    throw eperm;
                }
                return realReaddirSync(dir, { withFileTypes: true });
            }) as any);

            try {
                expect(() =>
                    executeBuildPlan(
                        [
                            {
                                type: 'writeFile',
                                path: path.join(
                                    OUT_VP(),
                                    'Contents',
                                    'mods',
                                    'my_mod',
                                    'mod.info',
                                ),
                                content: 'x',
                            },
                        ],
                        { outputRoot: OUT() },
                    ),
                ).toThrow(/Cannot authorize/i);
            } finally {
                spy.mockRestore();
            }
        });

        it('a case-variant junction name is matched through the stat witness and refused by its stored name', async () => {
            const target = path.join(sandbox, 'r6-case-target');
            await fsp.mkdir(path.join(target, 'media', 'lua'), {
                recursive: true,
            });
            await fsp.writeFile(
                path.join(target, 'media', 'lua', 'hello.lua'),
                'R6-CASE-VICTIM',
            );
            await fsp.mkdir(path.join(OUT_VP(), 'Contents'), {
                recursive: true,
            });
            await junction(path.join(OUT_VP(), 'Contents', 'MODS'), target);

            let refusal: string | undefined;
            try {
                executeBuildPlan(
                    [
                        {
                            type: 'writeFile',
                            path: path.join(
                                OUT_VP(),
                                'Contents',
                                'mods',
                                'my_mod',
                                'mod.info',
                            ),
                            content: 'x',
                        },
                    ],
                    { outputRoot: OUT() },
                );
            } catch (e) {
                refusal = (e as Error).message;
            }

            expect(refusal).toMatch(/symbolic link/i);
            expect(refusal).toContain('MODS');
            expect(
                fs.readFileSync(
                    path.join(target, 'media', 'lua', 'hello.lua'),
                    'utf8',
                ),
            ).toBe('R6-CASE-VICTIM');
        });

        it('without an output root the guard is inactive (opt-in boundary, mirrors Core)', async () => {
            const target = path.join(sandbox, 'r6-optout-target');
            await fsp.mkdir(target);
            await fsp.mkdir(path.join(OUT_VP(), 'Contents'), {
                recursive: true,
            });
            await junction(path.join(OUT_VP(), 'Contents', 'mods'), target);

            expect(() =>
                executeBuildPlan([
                    {
                        type: 'makeDir',
                        path: path.join(OUT_VP(), 'Contents', 'mods', 'my_mod'),
                    },
                ]),
            ).not.toThrow(/symbolic link/i);
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'CLI-P0 preservation: configured-root junctions and alias-free builds',
    () => {
        it('G1: a user-configured junction OUTDIR root still builds at the resolved root (INV-A)', async () => {
            const resolved = path.join(sandbox, 'out-resolved');
            await fsp.mkdir(resolved);
            await fsp.rm(OUT(), { recursive: true, force: true });
            await junction(OUT(), resolved);

            expect(() =>
                executeBuildPlan(
                    planBuild({ ...planInput(), variant: 'main' }),
                    {
                        outputRoot: OUT(),
                    },
                ),
            ).not.toThrow();

            expect(
                fs.readFileSync(
                    path.join(resolved, 'Sync Project', 'workshop.txt'),
                    'utf8',
                ),
            ).toContain('title=Sync Project');
            expect(
                fs.readFileSync(
                    path.join(
                        resolved,
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
            expect(fs.lstatSync(OUT()).isSymbolicLink()).toBe(true);
        });

        it('G1 (clean shape): a removeDir below a junction outdir root proceeds through the root (INV-A applies to clean too)', async () => {
            const resolved = path.join(sandbox, 'out-resolved-clean');
            await fsp.mkdir(path.join(resolved, 'Sync Project', 'Contents'), {
                recursive: true,
            });
            await fsp.writeFile(
                path.join(resolved, 'Sync Project', 'Contents', 'stale.txt'),
                'stale',
            );
            await fsp.rm(OUT(), { recursive: true, force: true });
            await junction(OUT(), resolved);

            expect(() =>
                executeBuildPlan(
                    [
                        {
                            type: 'removeDir',
                            path: path.join(OUT(), 'Sync Project'),
                        },
                    ],
                    { outputRoot: OUT() },
                ),
            ).not.toThrow();
            expect(
                fs.existsSync(
                    path.join(
                        resolved,
                        'Sync Project',
                        'Contents',
                        'stale.txt',
                    ),
                ),
            ).toBe(false);
            expect(fs.lstatSync(OUT()).isSymbolicLink()).toBe(true);
        });

        it('G3: an alias-free full build stays byte-compatible', () => {
            expect(() =>
                executeBuildPlan(
                    planBuild({ ...planInput(), variant: 'main' }),
                    {
                        outputRoot: OUT(),
                    },
                ),
            ).not.toThrow();
            expect(
                fs.readFileSync(path.join(OUT_VP(), 'workshop.txt'), 'utf8'),
            ).toContain('title=Sync Project');
            expect(
                fs.readFileSync(
                    path.join(OUT_VP(), 'Contents', 'template-file.txt'),
                    'utf8',
                ),
            ).toBe('tpl');
            expect(
                fs.readFileSync(
                    path.join(OUT_MOD(), 'media', 'lua', 'hello.lua'),
                    'utf8',
                ),
            ).toBe('hello-v1');
        });

        it('G4: the pre-existing case-6 self-copy defect is neither masked nor altered (recorded, not fixed here)', async () => {
            const case6Out = path.join(PROJ(), 'my_mod', 'gen');
            await fsp.mkdir(case6Out, { recursive: true });

            let error: Error | undefined;
            try {
                executeBuildPlan(
                    planBuild({ ...planInput(case6Out), variant: 'main' }),
                    { outputRoot: case6Out },
                );
            } catch (e) {
                error = e as Error;
            }

            expect(error).toBeInstanceOf(Error);
            expect(error!.message).not.toMatch(/symbolic link/i);
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'CACHE-R1: stale destination-listing authorization divergence',
    () => {
        it('authorizes a later destination entry from a listing captured before the copy created the alias; a fresh lookup refuses', async () => {
            const destParent = path.join(
                OUT_VP(),
                'Contents',
                'mods',
                'my_mod',
            );
            await fsp.mkdir(destParent, { recursive: true });
            const victim = path.join(sandbox, 'cache-r1-victim');
            await fsp.mkdir(victim);
            await fsp.writeFile(
                path.join(victim, 'SENTINEL.txt'),
                'CACHE-R1-KEEP',
            );
            const destAlias = path.join(destParent, 'media');
            const operation = `copyTree destination '${destParent}'`;

            expect(() =>
                assertNoAliasDestinationEntry(destAlias, OUT(), operation),
            ).not.toThrow();

            await junction(destAlias, victim);

            expect(() =>
                assertNoAliasDestinationEntry(destAlias, OUT(), operation),
            ).toThrow(/symbolic link/i);

            expect(
                await fsp.readFile(path.join(victim, 'SENTINEL.txt'), 'utf8'),
            ).toBe('CACHE-R1-KEEP');
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'CACHE-R2: nested physical landing under synchronous cpSync (Node-level evidence)',
    () => {
        it('lands a source subtree through a nested destination junction into the victim, silently, junction intact', async () => {
            const destParent = path.join(
                OUT_VP(),
                'Contents',
                'mods',
                'my_mod',
            );
            await fsp.mkdir(destParent, { recursive: true });
            const victim = path.join(sandbox, 'cache-r2-victim');
            await fsp.mkdir(victim);
            await fsp.writeFile(
                path.join(victim, 'SENTINEL.txt'),
                'BYTE-EXACT-SENTINEL-BEFORE',
            );
            const src = path.join(sandbox, 'cache-r2-src');
            await fsp.mkdir(path.join(src, 'media', 'lua'), {
                recursive: true,
            });
            await fsp.writeFile(
                path.join(src, 'media', 'lua', 'hello.lua'),
                'CACHE-R2-CONTENT',
            );
            await fsp.writeFile(
                path.join(src, 'media', 'modfile.txt'),
                'CACHE-R2-MODFILE',
            );
            await junction(path.join(destParent, 'media'), victim);
            const victimBefore = await treeSnapshot(victim);
            expect(victimBefore['SENTINEL.txt']).toBe(
                'BYTE-EXACT-SENTINEL-BEFORE',
            );

            let error: Error | undefined;
            try {
                fs.cpSync(src, destParent, {
                    recursive: true,
                    filter: () => true,
                });
            } catch (e) {
                error = e as Error;
            }

            expect(error).toBeUndefined();
            expect(
                await fsp.readFile(
                    path.join(victim, 'lua', 'hello.lua'),
                    'utf8',
                ),
            ).toBe('CACHE-R2-CONTENT');
            expect(
                await fsp.readFile(path.join(victim, 'modfile.txt'), 'utf8'),
            ).toBe('CACHE-R2-MODFILE');
            expect(
                await fsp.readFile(path.join(victim, 'SENTINEL.txt'), 'utf8'),
            ).toBe('BYTE-EXACT-SENTINEL-BEFORE');
            expect(
                (
                    await fsp.lstat(path.join(destParent, 'media'))
                ).isSymbolicLink(),
            ).toBe(true);
        });
    },
);

describe.skipIf(process.platform !== 'win32')(
    'CACHE-R3: copy-created alias through the guarded copy path (modeled full sequence)',
    () => {
        it('refuses the later entry before any copy when the copy created the destination alias; the victim and the alias stay untouched', async () => {
            const destParent = path.join(
                OUT_VP(),
                'Contents',
                'mods',
                'my_mod',
            );
            const destDir = path.join(destParent, 'media');
            await fsp.mkdir(destDir, { recursive: true });
            const victim = path.join(sandbox, 'cache-r3-victim');
            await fsp.mkdir(victim);
            await fsp.writeFile(
                path.join(victim, 'SENTINEL.txt'),
                'CACHE-R3-KEEP',
            );
            const src = path.join(sandbox, 'cache-r3-src');
            await fsp.mkdir(path.join(src, 'media', 'lua'), {
                recursive: true,
            });
            await fsp.writeFile(
                path.join(src, 'media', 'lua', 'hello.lua'),
                'CACHE-R3-CONTENT',
            );
            await fsp.writeFile(
                path.join(src, 'media', 'modfile.txt'),
                'CACHE-R3-MODFILE',
            );

            const operation = `copyTree destination '${destParent}'`;
            const filter = createIgnoreFilter(src);

            expect(
                filter(
                    path.join(src, 'media', 'modfile.txt'),
                    path.join(destDir, 'modfile.txt'),
                ),
            ).toBe(true);
            expect(() =>
                assertNoAliasDestinationEntry(
                    path.join(destDir, 'modfile.txt'),
                    OUT(),
                    operation,
                ),
            ).not.toThrow();

            await junction(path.join(destDir, 'lua'), victim);

            expect(
                filter(
                    path.join(src, 'media', 'lua'),
                    path.join(destDir, 'lua'),
                ),
            ).toBe(true);
            let refusal: Error | undefined;
            try {
                assertNoAliasDestinationEntry(
                    path.join(destDir, 'lua'),
                    OUT(),
                    operation,
                );
                fs.cpSync(path.join(src, 'media'), destDir, {
                    recursive: true,
                    filter: () => true,
                });
            } catch (e) {
                refusal = e as Error;
            }

            expect(refusal).toBeDefined();
            expect(refusal!.message).toMatch(/symbolic link/i);
            expect(refusal!.message).toContain('lua');
            expect(fs.existsSync(path.join(victim, 'hello.lua'))).toBe(false);
            expect(
                await fsp.readFile(path.join(victim, 'SENTINEL.txt'), 'utf8'),
            ).toBe('CACHE-R3-KEEP');
            expect(
                (await fsp.lstat(path.join(destDir, 'lua'))).isSymbolicLink(),
            ).toBe(true);
        });
    },
);

describe('clean output path guard (DEC-6)', () => {
    it('refuses a clean target outside the configured output root', async () => {
        const outside = path.join(sandbox, 'elsewhere', 'Sync Project');
        await fsp.mkdir(outside, { recursive: true });
        expect(() => cleanOutputPath(OUT(), outside)).toThrow(
            /not inside the configured build output root/,
        );
        expect(fs.existsSync(outside)).toBe(true);
    });

    it('cleans a variant directory below the configured root', async () => {
        const variant = path.join(OUT(), 'Sync Project');
        await fsp.mkdir(path.join(variant, 'Contents'), { recursive: true });
        await fsp.writeFile(
            path.join(variant, 'Contents', 'stale.txt'),
            'stale',
        );
        expect(() => cleanOutputPath(OUT(), variant)).not.toThrow();
        expect(fs.existsSync(variant)).toBe(false);
        expect(fs.existsSync(OUT())).toBe(true);
    });

    it('without an output root the clean keeps the unguarded behavior (opt-in parity)', async () => {
        const variant = path.join(OUT(), 'Sync Project');
        await fsp.mkdir(variant, { recursive: true });
        expect(() => cleanOutputPath(undefined, variant)).not.toThrow();
        expect(fs.existsSync(variant)).toBe(false);
    });

    it.skipIf(process.platform !== 'win32')(
        'a junction variant leaf is removed link-only — the junction target survives (delete-leaf B1)',
        async () => {
            const victim = path.join(sandbox, 'victim');
            await fsp.mkdir(path.join(victim, 'media'), { recursive: true });
            await fsp.writeFile(path.join(victim, 'media', 'keep.txt'), 'keep');
            const variant = path.join(OUT(), 'Sync Project');
            await junction(variant, victim);
            expect(() => cleanOutputPath(OUT(), variant)).not.toThrow();
            expect(fs.existsSync(variant)).toBe(false);
            expect(
                fs.readFileSync(path.join(victim, 'media', 'keep.txt'), 'utf8'),
            ).toBe('keep');
        },
    );

    it.skipIf(process.platform !== 'win32')(
        'a junction below the variant root is unlinked, not followed — the target survives',
        async () => {
            const victim = path.join(sandbox, 'victim');
            await fsp.mkdir(victim, { recursive: true });
            await fsp.writeFile(path.join(victim, 'keep.txt'), 'keep');
            const variant = path.join(OUT(), 'Sync Project');
            await fsp.mkdir(variant, { recursive: true });
            await junction(path.join(variant, 'linked'), victim);
            expect(() => cleanOutputPath(OUT(), variant)).not.toThrow();
            expect(fs.existsSync(variant)).toBe(false);
            expect(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8')).toBe(
                'keep',
            );
        },
    );
});
