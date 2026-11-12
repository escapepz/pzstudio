import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
    assertWatchMaterializable,
    parseMaterializeFlag,
    watchIgnoreGlobs,
    isWatchPathIgnored,
    ERR_WATCH_COPY_MODE_UNSUPPORTED,
} from '../../packages/cli/src/lib/watch-shared';
import { maybeMaterializeBuiltItems } from '../../packages/cli/src/lib/linkStep';
import type { MaterializationResolution } from '../../packages/cli/src/lib/linkStep';
import { NodeFileSystem } from '@pzstudio/platform-node';
import {
    resolveBuildOutputPath,
    writeOutputMarker,
    type IProjectConfig,
} from '@pzstudio/core';

const materialize = (
    overrides: Partial<MaterializationResolution> = {},
): MaterializationResolution => ({
    action: 'materialize',
    mode: 'symlink',
    outDir: 'C:/deploy',
    distRoot: 'C:/proj/dist',
    ...overrides,
});

describe('watch materialize helpers (dist-always amendment §7)', () => {
    describe('parseMaterializeFlag', () => {
        it('passes undefined through (no per-invocation override)', () => {
            expect(parseMaterializeFlag(undefined)).toBeUndefined();
        });

        it('accepts symlink and copy', () => {
            expect(parseMaterializeFlag('symlink')).toBe('symlink');
            expect(parseMaterializeFlag('copy')).toBe('copy');
        });

        it('rejects none — never an enum value', () => {
            expect(() => parseMaterializeFlag('none')).toThrow(
                'Invalid --materialize value "none"',
            );
        });

        it('rejects any other value naming the flag', () => {
            expect(() => parseMaterializeFlag('hardlink')).toThrow(
                /--materialize/,
            );
        });
    });

    describe('assertWatchMaterializable', () => {
        it('refuses copy mode with the structured code and the three escapes', () => {
            let thrown: unknown;
            try {
                assertWatchMaterializable(materialize({ mode: 'copy' }));
            } catch (e) {
                thrown = e;
            }
            const cliErr = thrown as {
                message: string;
                cause?: unknown;
                tryHint?: string;
            };
            expect(cliErr).toBeDefined();
            expect(String(cliErr.message)).toContain(
                'watch cannot deploy in copy mode',
            );
            expect(String(cliErr.cause)).toContain(
                ERR_WATCH_COPY_MODE_UNSUPPORTED,
            );
            expect(String(cliErr.tryHint)).toContain(
                '"materialize": "symlink"',
            );
            expect(String(cliErr.tryHint)).toContain('pzstudio build');
            expect(String(cliErr.tryHint)).toContain('--no-materialize');
        });

        it('allows symlink mode', () => {
            expect(() =>
                assertWatchMaterializable(materialize({ mode: 'symlink' })),
            ).not.toThrow();
        });

        it('allows skip (no target or --no-materialize) regardless of mode', () => {
            expect(() =>
                assertWatchMaterializable(
                    materialize({ action: 'skip', mode: 'copy' }),
                ),
            ).not.toThrow();
        });
    });

    describe('watchIgnoreGlobs', () => {
        const project = 'C:/proj';

        it('ignores the dist root when it sits inside the project', () => {
            expect(
                watchIgnoreGlobs(project, path.join(project, 'dist')),
            ).toEqual(['dist', 'dist/**']);
        });

        it('adds the deployment root when it sits inside the project (junction loop)', () => {
            expect(
                watchIgnoreGlobs(
                    project,
                    path.join(project, 'dist'),
                    path.join(project, 'deploy'),
                ),
            ).toEqual(['dist', 'dist/**', 'deploy', 'deploy/**']);
        });

        it('drops a deployment root outside the project (the watcher never sees it)', () => {
            expect(
                watchIgnoreGlobs(
                    project,
                    path.join(project, 'dist'),
                    'C:/Users/me/Zomboid/Workshop',
                ),
            ).toEqual(['dist', 'dist/**']);
        });

        it('returns undefined when the engine root is outside the project', () => {
            expect(
                watchIgnoreGlobs(project, 'C:/Users/me/Zomboid/Workshop'),
            ).toBeUndefined();
        });
    });

    describe('isWatchPathIgnored with a deployment root', () => {
        const project = path.resolve('C:/proj');
        const dist = path.join(project, 'dist');
        const deploy = path.join(project, 'deploy');

        it('ignores events under the in-project deployment root', () => {
            expect(
                isWatchPathIgnored(
                    project,
                    dist,
                    path.join(deploy, 'My Item', 'workshop.txt'),
                    deploy,
                ),
            ).toBe(true);
        });

        it('keeps legitimate source events outside both roots', () => {
            expect(
                isWatchPathIgnored(
                    project,
                    dist,
                    path.join(project, 'my_mod', 'media', 'lua', 'a.lua'),
                    deploy,
                ),
            ).toBe(false);
        });

        it('keeps the deployment-root check inert when the root is outside the project', () => {
            // An external deploy root never enters the loop check — but an
            // IN-PROJECT source under the same watch must stay delivered.
            const external = path.resolve('C:/deploy-external');
            expect(
                isWatchPathIgnored(
                    project,
                    dist,
                    path.join(project, 'my_mod', 'media', 'lua', 'b.lua'),
                    external,
                ),
            ).toBe(false);
        });
    });
});

describe('maybeMaterializeBuiltItems symlink pre-pass (COPY_SLOT toggle, Batch B)', () => {
    const ITEM = 'My Item';
    const PLATFORM = process.platform === 'win32' ? 'win32' : 'posix';
    const LINK_TYPE =
        PLATFORM === 'win32' ? ('junction' as const) : ('dir' as const);

    let root: string;
    let distRoot: string;
    let deployRoot: string;
    let distItem: string;
    let slotDir: string;
    let config: IProjectConfig;

    beforeEach(async () => {
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pz-watch-mt-'));
        distRoot = path.join(root, 'dist');
        deployRoot = path.join(root, 'deploy');
        distItem = path.join(distRoot, ITEM);
        slotDir = path.join(deployRoot, ITEM);
        await fsp.mkdir(path.join(distItem, 'Contents'), { recursive: true });
        await fsp.writeFile(
            path.join(distItem, 'workshop.txt'),
            'title=Item\n',
        );
        await fsp.writeFile(path.join(distItem, 'Contents', 'a.lua'), '-- a');
        config = {
            workshop: { title: ITEM },
            outdir: distRoot,
            mods: { my_mod: {} },
        } as unknown as IProjectConfig;
        // The junction attach proves ownership against the dist marker.
        await writeOutputMarker(new NodeFileSystem(), {
            config,
            variant: 'main',
            projectDir: root,
            engineVersion: 'test',
            outputRoot: distRoot,
        });
    });

    afterEach(async () => {
        await fsp.rm(root, { recursive: true, force: true });
    });

    const resolution = (
        mode: 'copy' | 'symlink',
    ): MaterializationResolution => ({
        action: 'materialize',
        mode,
        outDir: deployRoot,
        distRoot,
    });

    function seams(): {
        usage: { recordOp: ReturnType<typeof vi.fn> };
        warnings: string[];
        onSurface: (line: string, level: 'info' | 'warn') => void;
    } {
        const warnings: string[] = [];
        return {
            usage: { recordOp: vi.fn() },
            warnings,
            onSurface: (line, level) => {
                if (level === 'warn') warnings.push(line);
            },
        };
    }

    async function copyDeploy(
        overrides: Record<string, unknown> = {},
    ): Promise<void> {
        const outcomes = await maybeMaterializeBuiltItems(
            resolution('copy'),
            [ITEM],
            {
                projectRoot: root,
                platform: PLATFORM,
                usage: { recordOp: vi.fn() },
                onSurface: () => {},
                ...overrides,
            },
        );
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].ok, outcomes[0].detail).toBe(true);
    }

    it('toggles a proven-clean copy slot to a junction', async () => {
        await copyDeploy();
        expect((await fsp.lstat(slotDir)).isDirectory()).toBe(true);

        const { usage, warnings, onSurface } = seams();
        const outcomes = await maybeMaterializeBuiltItems(
            resolution('symlink'),
            [ITEM],
            {
                projectRoot: root,
                platform: PLATFORM,
                usage,
                onSurface,
            },
        );

        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].ok, outcomes[0].detail).toBe(true);
        expect(warnings).toEqual([]);
        expect((await fsp.lstat(slotDir)).isSymbolicLink()).toBe(true);
        expect(
            await fsp.readFile(path.join(slotDir, 'workshop.txt'), 'utf8'),
        ).toBe('title=Item\n');
        const toggle = usage.recordOp.mock.calls.find(
            ([event]) => event.op === 'materialize.toggle',
        );
        expect(toggle?.[0]).toMatchObject({
            op: 'materialize.toggle',
            status: 'ok',
        });
    });

    it('refuses a hand-edited slot and leaves it untouched', async () => {
        await copyDeploy();
        await fsp.writeFile(
            path.join(slotDir, 'workshop.txt'),
            'title=Item\n# hand-edited\n',
        );

        const { usage, warnings, onSurface } = seams();
        const outcomes = await maybeMaterializeBuiltItems(
            resolution('symlink'),
            [ITEM],
            {
                projectRoot: root,
                platform: PLATFORM,
                usage,
                onSurface,
            },
        );

        const outcome = outcomes.find((o) => o.itemName === ITEM);
        expect(outcome?.ok).toBe(false);
        expect(outcome?.state).toBe('COPY_SLOT_DRIFT');
        const slotStats = await fsp.lstat(slotDir);
        expect(slotStats.isDirectory()).toBe(true);
        expect(slotStats.isSymbolicLink()).toBe(false);
        expect(
            await fsp.readFile(path.join(slotDir, 'workshop.txt'), 'utf8'),
        ).toBe('title=Item\n# hand-edited\n');
        const surfaced = warnings.join('\n');
        expect(surfaced).toContain('COPY_SLOT_DRIFT');
        expect(surfaced).toContain('--backup-existing-workshop');
        expect(surfaced).toContain('OUT of the deployment root');
        const toggle = usage.recordOp.mock.calls.find(
            ([event]) => event.op === 'materialize.toggle',
        );
        expect(toggle?.[0]).toMatchObject({
            op: 'materialize.toggle',
            status: 'error',
            err: { code: 'COPY_SLOT_DRIFT' },
        });
    });

    it('leaves an already-attached junction alone (no toggle op)', async () => {
        const first = await maybeMaterializeBuiltItems(
            resolution('symlink'),
            [ITEM],
            {
                projectRoot: root,
                platform: PLATFORM,
                usage: { recordOp: vi.fn() },
                onSurface: () => {},
            },
        );
        expect(first[0]?.ok, first[0]?.detail).toBe(true);

        const { usage, warnings, onSurface } = seams();
        const outcomes = await maybeMaterializeBuiltItems(
            resolution('symlink'),
            [ITEM],
            {
                projectRoot: root,
                platform: PLATFORM,
                usage,
                onSurface,
            },
        );

        expect(outcomes[0]?.ok, outcomes[0]?.detail).toBe(true);
        expect(warnings).toEqual([]);
        expect((await fsp.lstat(slotDir)).isSymbolicLink()).toBe(true);
        expect(
            usage.recordOp.mock.calls.some(
                ([event]) => event.op === 'materialize.toggle',
            ),
        ).toBe(false);
    });
});
