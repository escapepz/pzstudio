import { describe, expect, it, vi } from 'vitest';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
    attachBuiltItems,
    maybeLinkBuiltItems,
    resolveDistModel,
    writeBuiltItemMarker,
} from '../../packages/cli/src/lib/linkStep';
import { NodeFileSystem } from '@pzstudio/platform-node';
import {
    computeProjectId,
    markerPath,
    resolveBuildOutputPath,
    writeOutputMarker,
    type IProjectConfig,
    type OutputMarker,
} from '@pzstudio/core';

import type { ProjectFileSystem } from '@pzstudio/platform';

// A minimal but valid project config: the marker assembly reads
// workshop.title + mods (devOnly flags) and the planner reads outdir.
function makeConfig(distDir: string, title = 'Item'): IProjectConfig {
    return {
        workshop: { title },
        outdir: distDir,
        mods: { my_mod: {}, other_mod: {} },
    } as unknown as IProjectConfig;
}

let root: string;
let dist: string;
let workshop: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pz-link-'));
    dist = join(root, 'dist');
    workshop = join(root, 'workshop');
    mkdirSync(dist, { recursive: true });
    mkdirSync(workshop, { recursive: true });
});

afterEach(() => {
    delete process.env.PZSTUDIO_WORKSHOP_ROOT;
    rmSync(root, { recursive: true, force: true });
});

/** Real junction-happy fixture: one built item with content + marker. */
async function seedBuiltItem(
    config: IProjectConfig,
    variant: 'main' | 'development',
    opts: { projectDir?: string } = {},
): Promise<string> {
    const itemDir = resolveBuildOutputPath(config, variant);
    await fsp.mkdir(join(itemDir, 'Contents', 'mods', 'my_mod'), {
        recursive: true,
    });
    writeFileSync(join(itemDir, 'workshop.txt'), 'title=Item\n');
    writeFileSync(
        join(itemDir, 'Contents', 'mods', 'my_mod', 'mod.info'),
        'name=my_mod\n',
    );
    await writeOutputMarker(realNodeFs(), {
        config,
        variant,
        projectDir: opts.projectDir ?? root,
        engineVersion: '0.0.0-test',
        outputRoot: config.outdir,
    });
    return itemDir;
}

/** The production marker-write adapter rides node:fs/promises; the fixture
 * uses the real NodeFileSystem — same ProjectFileSystem contract. */
function realNodeFs(): ProjectFileSystem {
    return new NodeFileSystem();
}

describe('resolveDistModel', () => {
    it('defaults outdir to <projectRoot>/dist when unset (still schema v2)', () => {
        const dm = resolveDistModel(root, {});
        expect(dm.mode).toBe('dist');
        expect(dm.outDir).toBe(resolve(join(root, 'dist')));
        expect(isAbsolute(dm.outDir)).toBe(true);
    });

    it('dist mode when outdir is inside the project root', () => {
        const dm = resolveDistModel(root, { outdir: join(root, 'dist') });
        expect(dm.mode).toBe('dist');
        expect(dm.outDir).toBe(resolve(join(root, 'dist')));
    });

    it('legacy mode when outdir is outside the project root (Review Focus 6)', () => {
        const dm = resolveDistModel(root, { outdir: join(root, '..', 'out') });
        expect(dm.mode).toBe('legacy');
    });

    it('legacy mode when outdir equals the project root itself', () => {
        const dm = resolveDistModel(root, { outdir: root });
        expect(dm.mode).toBe('legacy');
    });

    it('prefix-sibling trap: project\\dist2 is NOT inside project\\dist', () => {
        const dm = resolveDistModel(root, { outdir: dist + '2' });
        // dist+'2' is a SIBLING of dist, still inside root — dist mode, but
        // the boundary check must not confuse the shared prefix.
        expect(dm.mode).toBe('dist');
        const outside = resolveDistModel(root, {
            outdir: join(root + '-sibling', 'dist'),
        });
        expect(outside.mode).toBe('legacy');
    });

    it('workshopRoot: explicit config wins over env, env wins over factory default', () => {
        const explicit = resolveDistModel(root, {
            workshopRoot: join(root, 'ws'),
        });
        expect(explicit.workshopRoot).toBe(resolve(join(root, 'ws')));

        process.env.PZSTUDIO_WORKSHOP_ROOT = join(root, 'ws-env');
        const viaEnv = resolveDistModel(root, {});
        expect(viaEnv.workshopRoot).toBe(resolve(join(root, 'ws-env')));

        delete process.env.PZSTUDIO_WORKSHOP_ROOT;
        const factory = resolveDistModel(root, {});
        expect(factory.workshopRoot).toBe(
            resolve(join(homedir(), 'Zomboid', 'Workshop')),
        );
    });
});

describe('writeBuiltItemMarker (standalone build path)', () => {
    /** Production precondition: the build created the item dir before the
     * marker write (the marker is written after the variant succeeded). */
    function seedItemDir(
        config: IProjectConfig,
        variant: 'main' | 'development',
    ): string {
        const itemDir = resolveBuildOutputPath(config, variant);
        mkdirSync(join(itemDir, 'Contents', 'mods', 'my_mod'), {
            recursive: true,
        });
        return itemDir;
    }

    it('writes the marker next to the built item with the CLI engine version', async () => {
        const config = makeConfig(dist);
        const cliVersion = (
            JSON.parse(
                readFileSync(
                    resolve(__dirname, '../../packages/cli/package.json'),
                    'utf-8',
                ),
            ) as { version: string }
        ).version;
        seedItemDir(config, 'main');
        await writeBuiltItemMarker(config, 'main', root, dist);
        const markerPathValue = markerPath(
            resolveBuildOutputPath(config, 'main'),
        );
        expect(existsSync(markerPathValue)).toBe(true);
        const marker = JSON.parse(
            readFileSync(markerPathValue, 'utf-8'),
        ) as OutputMarker;
        expect(marker.projectId).toBe(await computeProjectId(root));
        expect(marker.itemTitle).toBe('Item');
        expect(marker.mods).toContain('my_mod');
        expect(marker.engineVersion).toBe(cliVersion);
    });

    it('rebuild is idempotent except createdAt; tmp write-ahead artifact is cleaned', async () => {
        const config = makeConfig(dist);
        seedItemDir(config, 'main');
        await writeBuiltItemMarker(config, 'main', root, dist);
        const first = JSON.parse(
            readFileSync(
                markerPath(resolveBuildOutputPath(config, 'main')),
                'utf-8',
            ),
        ) as OutputMarker;
        await writeBuiltItemMarker(config, 'main', root, dist);
        const second = JSON.parse(
            readFileSync(
                markerPath(resolveBuildOutputPath(config, 'main')),
                'utf-8',
            ),
        ) as OutputMarker;
        const { createdAt: _a, ...restFirst } = first;
        const { createdAt: _b, ...restSecond } = second;
        expect(restSecond).toEqual(restFirst);
        expect(
            existsSync(
                `${markerPath(resolveBuildOutputPath(config, 'main'))}.tmp`,
            ),
        ).toBe(false);
    });

    it('no junction activity in legacy mode (build gate, ledger ruling)', async () => {
        const config = makeConfig(dist);
        const dm = resolveDistModel(root, { outdir: join(root, '..', 'out') });
        expect(dm.mode).toBe('legacy');
        const outcomes = await maybeLinkBuiltItems(
            dm,
            [basename(resolveBuildOutputPath(config, 'main'))],
            { projectRoot: root, usage: { recordOp: vi.fn() } },
        );
        expect(outcomes).toEqual([]);
        // Not a single entry was created in the workshop root.
        expect(await fsp.readdir(workshop)).toEqual([]);
    });

    it('dist mode delegates to the attach step (one outcome per item)', async () => {
        const config = makeConfig(dist);
        const itemDir = resolveBuildOutputPath(config, 'main');
        await fsp.mkdir(join(itemDir, 'Contents', 'mods', 'my_mod'), {
            recursive: true,
        });
        writeFileSync(join(itemDir, 'workshop.txt'), 'title=Item\n');
        await writeOutputMarker(new NodeFileSystem(), {
            config,
            variant: 'main',
            projectDir: root,
            engineVersion: '0.0.0-test',
            outputRoot: dist,
        });
        const dm = resolveDistModel(root, {
            outdir: dist,
            workshopRoot: workshop,
        });
        const outcomes = await maybeLinkBuiltItems(dm, [basename(itemDir)], {
            projectRoot: root,
            usage: { recordOp: vi.fn() },
            onSurface: () => {},
        });
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].ok).toBe(true);
    });
});

describe('attachBuiltItems', () => {
    it('attaches one junction per built item (main + dev_branch) into workshopRoot', async () => {
        const config = makeConfig(dist);
        const mainDir = await seedBuiltItem(config, 'main');
        const configDev = makeConfig(dist, 'Item');
        const devDir = await seedBuiltItem(configDev, 'development');

        const surfaces: string[] = [];
        const results = await attachBuiltItems({
            projectRoot: root,
            outDir: dist,
            workshopRoot: workshop,
            itemNames: [basename(mainDir), basename(devDir)],
            usage: { recordOp: vi.fn() },
            onSurface: (line) => surfaces.push(line),
        });

        expect(results).toHaveLength(2);
        expect(results.every((r) => r.ok && r.state === 'OK_LINK')).toBe(true);
        const mainLink = join(workshop, basename(mainDir));
        const st = await fsp.lstat(mainLink);
        expect(st.isSymbolicLink()).toBe(true);
        expect(await fsp.realpath(mainLink)).toBe(await fsp.realpath(mainDir));
        // Content is reachable through the junction (the game consumer).
        expect(readFileSync(join(mainLink, 'workshop.txt'), 'utf-8')).toContain(
            'title=Item',
        );
        expect(surfaces.length).toBeGreaterThanOrEqual(2);
    });

    it('projectRoot spelling with .. segments still matches the marker identity (carry-forward A)', async () => {
        const config = makeConfig(dist);
        await seedBuiltItem(config, 'main');
        const wonkyRoot = join(root, 'nested', '..', '.');
        const results = await attachBuiltItems({
            projectRoot: wonkyRoot,
            outDir: dist,
            workshopRoot: workshop,
            itemNames: [basename(resolveBuildOutputPath(config, 'main'))],
            usage: { recordOp: vi.fn() },
            onSurface: () => {},
        });
        expect(results[0].ok).toBe(true);
        expect(results[0].state).toBe('OK_LINK');
    });

    it('refusal is non-fatal: surfaces the error code + CLI flag suggestion, next item still attaches', async () => {
        const config = makeConfig(dist);
        const mainDir = await seedBuiltItem(config, 'main');
        // A real non-empty directory occupies the dev slot.
        const devName = basename(resolveBuildOutputPath(config, 'development'));
        const devSlot = join(workshop, devName);
        await fsp.mkdir(devSlot, { recursive: true });
        writeFileSync(
            join(devSlot, 'workshop.txt'),
            'title=hand made\nid=12345\n',
        );

        const surfaces: Array<{ line: string; level: string }> = [];
        const results = await attachBuiltItems({
            projectRoot: root,
            outDir: dist,
            workshopRoot: workshop,
            itemNames: [basename(mainDir), devName],
            usage: { recordOp: vi.fn() },
            onSurface: (line, level) => surfaces.push({ line, level }),
        });

        expect(results[0].ok).toBe(true);
        expect(results[1].ok).toBe(false);
        expect(results[1].state).toBe('CONFLICT_REAL_DIR');
        const warnLine = surfaces.find(
            (s) => s.level === 'warn' && s.line.includes(devName),
        );
        expect(warnLine).toBeDefined();
        expect(warnLine!.line).toContain('ERR_WORKSHOP_DIR_EXISTS_REAL');
        expect(warnLine!.line).toContain('--backup-existing-workshop');
        // The refused slot was never touched.
        expect(existsSync(devSlot)).toBe(true);
    });

    it('--backup-existing-workshop renames the real dir aside and attaches (usage link.backup)', async () => {
        const config = makeConfig(dist);
        await seedBuiltItem(config, 'main');
        const itemName = basename(resolveBuildOutputPath(config, 'main'));
        const slot = join(workshop, itemName);
        await fsp.mkdir(slot, { recursive: true });
        writeFileSync(
            join(slot, 'workshop.txt'),
            'title=hand made\nid=12345\n',
        );
        const usage = { recordOp: vi.fn() };

        const results = await attachBuiltItems({
            projectRoot: root,
            outDir: dist,
            workshopRoot: workshop,
            itemNames: [itemName],
            backupExisting: true,
            usage: usage as never,
            onSurface: () => {},
        });

        expect(results[0].ok).toBe(true);
        expect(results[0].backupPath).toBeTruthy();
        expect(existsSync(results[0].backupPath!)).toBe(true);
        expect(
            await fsp
                .lstat(join(workshop, itemName))
                .then((s) => s.isSymbolicLink()),
        ).toBe(true);
        const ops = usage.recordOp.mock.calls.map((c) => c[0].op);
        expect(ops).toContain('link.backup');
        expect(ops).toContain('link.attach');
    });

    it('usage events carry no paths or item names (privacy rule)', async () => {
        const config = makeConfig(dist);
        await seedBuiltItem(config, 'main');
        const usage = { recordOp: vi.fn() };
        await attachBuiltItems({
            projectRoot: root,
            outDir: dist,
            workshopRoot: workshop,
            itemNames: [basename(resolveBuildOutputPath(config, 'main'))],
            usage: usage as never,
            onSurface: () => {},
        });
        expect(usage.recordOp.mock.calls.length).toBeGreaterThan(0);
        for (const call of usage.recordOp.mock.calls) {
            const serialized = JSON.stringify(call[0]);
            expect(serialized).not.toContain(root);
            expect(serialized).not.toContain('Item');
        }
    });

    it('thrown fs errors never propagate (Review Focus 4: outcome untouched by construction)', async () => {
        const config = makeConfig(dist);
        await seedBuiltItem(config, 'main');
        // W is a FILE — the cascade refuses NOT_DIRECTORY without mutation,
        // and even a throwing realFs must not reject the promise.
        const itemName = basename(resolveBuildOutputPath(config, 'main'));
        await fsp.writeFile(join(workshop, itemName), 'not a dir');
        const results = await attachBuiltItems({
            projectRoot: root,
            outDir: dist,
            workshopRoot: workshop,
            itemNames: [itemName],
            usage: { recordOp: vi.fn() },
            onSurface: () => {},
        });
        expect(results[0].ok).toBe(false);
    });
});
