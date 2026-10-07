import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resolve } from 'path';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';
import type { TemplateTransport } from '@pzstudio/platform';
import type { PzStudioHostSettings } from '../../packages/cli/src/lib/invocation';

import { createPzStudio } from '../../packages/cli/src/lib/studio';
import {
    createDevSync,
    createDevSyncCore,
} from '../../packages/cli/src/lib/devsync';
import {
    runProjectDoctor,
    runProjectDoctorCore,
} from '../../packages/cli/src/lib/doctor';
import {
    resolveModInfoTargets,
    readProjectConfig,
    applyProjectDefaults,
    getOutDir,
    setProjectDir,
    getExternalProjectDir,
    setProjectRootAnchor,
    legacyDiscoveryStart,
    setVsCodeSettings,
    legacySettings,
} from '../../packages/cli/src/lib/helper';
import {
    resolveTemplateDir,
    probeTemplateCacheDir,
    readGlobalConfig,
    cloneRemoteTemplate,
    cloneRemoteTemplateWithIo,
    getConfigPath,
} from '../../packages/cli/src/lib/templateManager';
import {
    setLogger,
    legacyLogger,
    setVerbose,
    setQuiet,
    setDebug,
} from '../../packages/cli/src/lib/logger';
import {
    setTemplateTransport,
    legacyTransport,
    GitTransport,
    FetchTransport,
} from '../../packages/cli/src/lib/transport';
import { CliError } from '../../packages/cli/src/lib/errors';
import { setCliIO } from '../../packages/cli/src/lib/parser';
import { getCommand } from '../../packages/cli/src/lib/registry';
import { runCLI } from '../../packages/cli/src/lib/cli';
import { getActiveInvocationContext } from '../../packages/cli/src/lib/invocation';
import * as helperModule from '../../packages/cli/src/lib/helper';
import * as coreModule from '../../packages/core/src/index';

/* ------------------------------------------------------------------ */
/* Fixtures and capture helpers                                        */
/* ------------------------------------------------------------------ */

function recordingLogger() {
    const calls: Array<{ method: string; message: any }> = [];
    const logger = {
        log: (m: any) => calls.push({ method: 'log', message: m }),
        info: (m: any) => calls.push({ method: 'info', message: m }),
        warn: (m: any) => calls.push({ method: 'warn', message: m }),
        error: (e: any) => calls.push({ method: 'error', message: e }),
        verbose: (m: any) => calls.push({ method: 'verbose', message: m }),
    };
    return { calls, logger };
}

let tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = createTempDir();
    tempDirs.push(dir);
    return dir;
}

/** A minimal valid project fixture (no outdir: host layers decide). */
function makeProjectDir(title: string): string {
    const dir = makeTempDir();
    fs.writeFileSync(
        path.join(dir, 'project.json'),
        JSON.stringify({
            workshop: { title, visibility: 'public', tags: [] },
            mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
            excludes: [],
        }),
    );
    return dir;
}

/** A DevSync-ready fixture: a mod with a source file and a template dir. */
function makeSyncProject(includeOutdir = true): {
    root: string;
    projectDir: string;
    templateDir: string;
    outDir: string;
} {
    const root = makeTempDir();
    const projectDir = path.join(root, 'proj');
    const templateDir = path.join(root, 'templates', 'workshop');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(projectDir, 'my_mod', 'media', 'lua'), {
        recursive: true,
    });
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(
        path.join(projectDir, 'project.json'),
        JSON.stringify({
            workshop: { title: 'Sync Project', visibility: 'public', tags: [] },
            mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
            excludes: [],
            ...(includeOutdir ? { outdir: 'out' } : {}),
        }),
    );
    fs.writeFileSync(
        path.join(projectDir, 'my_mod', 'media', 'lua', 'hello.lua'),
        'print("v1")',
    );
    fs.writeFileSync(path.join(templateDir, 'template-file.txt'), 'template');
    return { root, projectDir, templateDir, outDir };
}

function sentinelTransport(name: 'git' | 'fetch' = 'git'): TemplateTransport {
    return {
        name,
        download: () => {},
        refresh: () => false,
        isCacheValid: () => false,
    };
}

/** CliIO capture sink for raw-tier emission equivalence checks. */
function captureIO(): { stdout: string[]; stderr: string[] } {
    const captured = { stdout: [] as string[], stderr: [] as string[] };
    const sink: CliIO = {
        stdout: (t) => captured.stdout.push(t),
        stderr: (t) => captured.stderr.push(t),
    };
    setCliIO(sink);
    return captured;
}

/**
 * Copies the bundled legacy templates into the fake home without running
 * the bootstrap. Fixture prep for tests that need the legacy fallback dir
 * present while asserting some OTHER emission — distinct from the removed
 * commit-5 workaround (that one pre-seeded the marker to HIDE the bootstrap
 * emission; this seeds the directory as test data, bootstrap-free by
 * construction because the target already exists).
 */
function seedLegacyTemplates(): void {
    const fakeHome = (globalThis as any).__PZSTUDIO_FAKE_HOME as string;
    const bundled = path.join(process.cwd(), '.template-legacy');
    const target = path.join(fakeHome, '.pzstudio', '.template-legacy');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(bundled, target, { recursive: true });
}

/** Temporarily replaces a registered command's run (test-only swap). */
function withCommandRun(
    name: string,
    swapped: () => Promise<void>,
): () => void {
    const def = getCommand(name)!;
    const original = def.run;
    def.run = swapped;
    return () => {
        def.run = original;
    };
}

const helperNs = helperModule as unknown as Record<string, any>;
const coreNs = coreModule as unknown as Record<string, any>;

afterEach(() => {
    vi.restoreAllMocks();
    setLogger(undefined);
    setCliIO(undefined);
    setProjectDir(undefined);
    setProjectRootAnchor(undefined);
    setTemplateTransport(undefined);
    setVsCodeSettings(undefined, undefined);
    setVerbose(false);
    setQuiet(false);
    setDebug(false);
    for (const dir of tempDirs) deleteDir(dir);
    tempDirs = [];
});

/* ------------------------------------------------------------------ */
/* 1. Doctor: legacy vs core golden report equivalence                 */
/* ------------------------------------------------------------------ */

describe('doctor legacy-vs-core golden equivalence', () => {
    it('identical DoctorReport on a healthy fixture', async () => {
        const proj = makeProjectDir('Doctor Golden');

        const legacy = await runProjectDoctor(proj, { gameBuild: '42.20.1' });
        const core = await runProjectDoctorCore(proj, {
            settings: legacySettings(),
            logger: legacyLogger(),
            gameBuild: '42.20.1',
        });

        expect(core).toEqual(legacy);
        // Sanity: the golden actually ran against the fixture.
        expect(legacy.projectDir).toBe(proj);
    });

    it('identical DoctorReport when host settings layers are set', async () => {
        const proj = makeProjectDir('Doctor Golden Settings');
        const outDir = makeTempDir();
        setVsCodeSettings({ outdir: path.join(outDir, 'ws-out') });

        const legacy = await runProjectDoctor(proj, { gameBuild: '42.20.1' });
        const core = await runProjectDoctorCore(proj, {
            settings: legacySettings(),
            logger: legacyLogger(),
            gameBuild: '42.20.1',
        });

        expect(core).toEqual(legacy);
    });

    it('identical DoctorReport when project.json is corrupt (finding, not a throw)', async () => {
        const proj = makeTempDir();
        fs.writeFileSync(path.join(proj, 'project.json'), '{ not json');

        const legacy = await runProjectDoctor(proj);
        const core = await runProjectDoctorCore(proj, {
            settings: legacySettings(),
            logger: legacyLogger(),
        });

        expect(core).toEqual(legacy);
    });
});

/* ------------------------------------------------------------------ */
/* 2. DevSync: plan-input equivalence legacy vs core                   */
/* ------------------------------------------------------------------ */

describe('devsync plan-input equivalence', () => {
    function spyGatherPlanInput(): Array<any[]> {
        const captured: Array<any[]> = [];
        const realGather = helperNs.gatherPlanInput;
        vi.spyOn(helperNs, 'gatherPlanInput').mockImplementation(
            (...args: any[]) => {
                captured.push(args);
                return realGather(...args);
            },
        );
        return captured;
    }

    it('legacy createDevSync and createDevSyncCore resolve the same plan input on the same fixture', async () => {
        const { projectDir, templateDir } = makeSyncProject();
        const captured = spyGatherPlanInput();

        const legacySession = createDevSync(projectDir, {
            workshopTemplateDir: templateDir,
            quiet: true,
        });
        await legacySession.start(['main']);
        await legacySession.stop();

        const coreSession = createDevSyncCore(
            projectDir,
            {
                settings: legacySettings(),
                logger: legacyLogger(),
                templateTransport: legacyTransport(),
            },
            { workshopTemplateDir: templateDir, quiet: true },
        );
        await coreSession.start(['main']);
        await coreSession.stop();

        expect(captured).toHaveLength(2);
        expect(captured[1]).toEqual(captured[0]);
        // Sanity: the plan input carries the session's own project path and
        // the resolved config (tier-1 outdir against the walked root).
        expect(captured[0][0]).toBe(projectDir);
        expect(captured[0][1].outdir).toBe(path.join(projectDir, 'out'));
    });

    it('core deps are evaluated per plan input (accessor freshness)', async () => {
        // No project outdir: the settings workspace layer is the outdir
        // tier that actually decides (tier 2), so its per-apply freshness
        // is observable in the plan input.
        const { projectDir, templateDir } = makeSyncProject(false);
        const outA = makeTempDir();
        const outB = makeTempDir();
        let layers: PzStudioHostSettings | undefined = {
            workspace: { outdir: outA },
        };
        const captured = spyGatherPlanInput();

        const session = createDevSyncCore(
            projectDir,
            {
                // The template override keeps template resolution fixed so
                // the settings layers are the only moving part.
                settings: () => layers,
                logger: legacyLogger(),
                templateTransport: legacyTransport(),
            },
            { workshopTemplateDir: templateDir, quiet: true },
        );
        await session.start(['main']);
        layers = { workspace: { outdir: outB } };
        await session.rebuild();
        await session.stop();

        expect(captured).toHaveLength(2);
        expect(captured[0][1].outdir).toBe(resolve(outA));
        expect(captured[1][1].outdir).toBe(resolve(outB));
    });
});

/* ------------------------------------------------------------------ */
/* 3. Legacy createDevSync keeps its anchor-write side effect          */
/* ------------------------------------------------------------------ */

describe('legacy createDevSync anchor side effect (§13)', () => {
    it('leaves externalProjectDir anchored at the session path for its lifetime', async () => {
        const { projectDir, templateDir } = makeSyncProject();
        const previous = makeTempDir();
        setProjectDir(previous);

        const session = createDevSync(projectDir, {
            workshopTemplateDir: templateDir,
            quiet: true,
        });

        expect(getExternalProjectDir()).toBe(projectDir);
        expect(getExternalProjectDir()).not.toBe(previous);

        await session.start(['main']);

        // Still anchored after applies (the observable §13 contract a
        // subsequent legacy runCLI discovery relies on).
        expect(getExternalProjectDir()).toBe(projectDir);
        expect(legacyDiscoveryStart()).toBe(projectDir);
        await session.stop();
    });

    it('the core never touches the anchor', async () => {
        const { projectDir, templateDir } = makeSyncProject();

        const session = createDevSyncCore(
            projectDir,
            {
                settings: undefined,
                logger: legacyLogger(),
                templateTransport: legacyTransport(),
            },
            { workshopTemplateDir: templateDir, quiet: true },
        );
        await session.start(['main']);
        await session.stop();

        expect(getExternalProjectDir()).toBeUndefined();
        expect(legacyDiscoveryStart()).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* 4. Legacy doctor keeps save → set → run → restore                   */
/* ------------------------------------------------------------------ */

describe('legacy doctor save/restore side effect (§13)', () => {
    it('restores the previous anchor on success', async () => {
        const proj = makeProjectDir('Doctor Restore');
        const previous = makeTempDir();
        setProjectDir(previous);

        await runProjectDoctor(proj, { gameBuild: '42.20.1' });

        expect(getExternalProjectDir()).toBe(previous);
    });

    it('sets the anchor during the run and restores it when the run fails', async () => {
        const proj = makeProjectDir('Doctor Restore Failure');
        const previous = makeTempDir();
        setProjectDir(previous);

        let during: string | undefined;
        vi.spyOn(coreNs, 'runDoctor').mockImplementationOnce(async () => {
            during = getExternalProjectDir();
            throw new Error('boom');
        });

        await expect(runProjectDoctor(proj)).rejects.toThrow('boom');

        expect(during).toBe(proj);
        expect(getExternalProjectDir()).toBe(previous);
    });
});

/* ------------------------------------------------------------------ */
/* 5. ModInfo: implicit default resolves the RAW project root          */
/* ------------------------------------------------------------------ */

describe('legacy modinfo resolved-root semantics (§8.0/§13)', () => {
    it('an anchor nested below the project root resolves upward to the real root', () => {
        const projRoot = makeProjectDir('ProjRoot');
        fs.mkdirSync(path.join(projRoot, 'modA', 'branch', 'media'), {
            recursive: true,
        });
        const nested = path.join(projRoot, 'docs', 'deep');
        fs.mkdirSync(nested, { recursive: true });
        setProjectRootAnchor(nested);

        // Implicit default: walk-up from the raw anchor — the exact
        // pre-migration projectDir() algorithm over raw state.
        expect(resolveModInfoTargets('modA')).toEqual([
            path.join(projRoot, 'modA', 'branch'),
        ]);
        // Identical to the explicit-root call.
        expect(resolveModInfoTargets('modA', projRoot)).toEqual(
            resolveModInfoTargets('modA'),
        );
    });

    it('stays fail-closed from an anchor with no project above it', () => {
        const nowhere = makeTempDir();
        setProjectRootAnchor(nowhere);

        expect(() => resolveModInfoTargets('modA')).toThrow(CliError);
        expect(() => resolveModInfoTargets('modA')).toThrow(
            /No pzstudio project found/,
        );
    });
});

/* ------------------------------------------------------------------ */
/* 6. The same modinfo behavior while a v2 invocation is active        */
/* ------------------------------------------------------------------ */

describe('modinfo resolved-root with an active v2 run', () => {
    it('resolves the legacy root from the raw anchor — never the v2 project', async () => {
        const projV2 = makeProjectDir('ProjV2');
        const projRoot = makeProjectDir('ProjRoot');
        fs.mkdirSync(path.join(projRoot, 'modA', 'branch', 'media'), {
            recursive: true,
        });
        const nested = path.join(projRoot, 'docs', 'deep');
        fs.mkdirSync(nested, { recursive: true });
        setProjectRootAnchor(nested);

        const studio = createPzStudio({ projectDir: projV2 });
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        let parked: Promise<void> = Promise.resolve();
        let restore: () => void = () => {};
        try {
            parked = studio.run('list', [], {
                flags: ['--project', projV2],
            });
            restore = withCommandRun('list', async () => {
                await gate;
            });
            await vi.waitFor(() =>
                expect(getActiveInvocationContext()).toBeDefined(),
            );

            const targets = resolveModInfoTargets('modA');
            expect(targets).toEqual([path.join(projRoot, 'modA', 'branch')]);
            expect(targets[0].startsWith(projV2)).toBe(false);
            expect(targets[0]).not.toBe(nested);
        } finally {
            release();
            restore();
            await parked.catch(() => {});
        }
        expect(getActiveInvocationContext()).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* 7. First R1 overlap cases: legacy ops next to an active v2 run      */
/* ------------------------------------------------------------------ */

describe('R1 overlap: legacy non-engine ops beside an active v2 run', () => {
    /**
     * Shared frame: a parked v2 run (lock held, ambient installed) plus
     * populated legacy facade state, deliberately different from the v2
     * instance's dependencies. done() releases the gate, restores the
     * swapped command and settles the parked run — always call it in a
     * finally. The legacy-template bootstrap marker is deliberately NOT
     * pre-seeded (the commit-5 workaround is gone): every test here runs
     * cold, and commit 6's io threading is what keeps the bootstrap and
     * template emissions out of the v2 logger.
     */
    async function parkedV2Frame() {
        const projV2 = makeProjectDir('V2Project');
        const v2Out = makeTempDir();
        const L2 = recordingLogger();
        const T2 = sentinelTransport('fetch');
        vi.spyOn(T2, 'download');
        vi.spyOn(T2, 'refresh');
        vi.spyOn(T2, 'isCacheValid');

        const projLegacy = makeProjectDir('LegacyProject');
        fs.mkdirSync(path.join(projLegacy, 'my_mod', 'media', 'lua'), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(projLegacy, 'my_mod', 'media', 'lua', 'hello.lua'),
            'print("v1")',
        );
        const templateDir = path.join(makeTempDir(), 'tpl-workshop');
        fs.mkdirSync(templateDir, { recursive: true });
        fs.writeFileSync(path.join(templateDir, 'template-file.txt'), 'tpl');
        const legacyOut = makeTempDir();
        const L1 = recordingLogger();

        // Legacy facade state — deliberately different from the instance's.
        setLogger(L1.logger);
        setVsCodeSettings({
            outdir: legacyOut,
            templates: {
                project: { url: 'https://github.com/legacy/doctor-fixture' },
            },
        });
        setTemplateTransport(sentinelTransport('git'));

        const studio = createPzStudio({
            projectDir: projV2,
            logger: L2.logger,
            settings: () => ({ workspace: { outdir: v2Out } }),
            templateTransport: T2,
        });

        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const parked = studio.run('list', [], {
            flags: ['--project', projV2],
        });
        const restoreCommand = withCommandRun('list', async () => {
            await gate;
        });
        await vi.waitFor(() =>
            expect(getActiveInvocationContext()).toBeDefined(),
        );

        return {
            projV2,
            v2Out,
            projLegacy,
            templateDir,
            legacyOut,
            L1,
            L2,
            T2,
            done: async () => {
                release();
                restoreCommand();
                await parked;
            },
        };
    }

    it('legacy DevSync apply uses only raw legacy deps', async () => {
        const frame = await parkedV2Frame();
        const l2Count = frame.L2.calls.length;
        let session:
            | {
                  start: (v: string[]) => Promise<void>;
                  stop: () => Promise<void>;
              }
            | undefined;
        try {
            session = createDevSync(frame.projLegacy, {
                workshopTemplateDir: frame.templateDir,
            });
            await session.start(['main']);
            await session.stop();

            // Project: the session resolved ITS OWN explicit path (and the
            // legacy wrapper left the anchor write intact).
            expect(getExternalProjectDir()).toBe(frame.projLegacy);
            // Settings: the outdir tier took the LEGACY workspace layer
            // (the project.json defines no outdir) — the sync landed in
            // legacyOut; v2Out is untouched.
            expect(
                fs.existsSync(path.join(frame.legacyOut, 'LegacyProject')),
            ).toBe(true);
            expect(fs.readdirSync(frame.v2Out)).toEqual([]);
            // Logger: session emissions routed to the legacy slot; the v2
            // logger received nothing from the legacy operation.
            expect(frame.L1.calls.length).toBeGreaterThan(0);
            expect(frame.L1.calls.some((c) => c.method === 'info')).toBe(true);
            expect(frame.L2.calls.length).toBe(l2Count);
        } finally {
            if (session) await session.stop().catch(() => {});
            await frame.done();
        }
        expect(getActiveInvocationContext()).toBeUndefined();
    });

    it('legacy Doctor run uses only raw legacy deps', async () => {
        const frame = await parkedV2Frame();
        const l2Count = frame.L2.calls.length;
        try {
            const inputs: any[] = [];
            const realRunDoctor = coreNs.runDoctor;
            vi.spyOn(coreNs, 'runDoctor').mockImplementation(
                async (...args: any[]) => {
                    inputs.push(args[1]);
                    return realRunDoctor(...args);
                },
            );

            const report = await runProjectDoctor(frame.projLegacy, {
                gameBuild: '42.20.1',
            });

            // The engine hand-off received the legacy-composed inputs:
            // outdir from the LEGACY workspace layer, template probe from
            // the LEGACY template layers — never the v2 instance's.
            expect(inputs).toHaveLength(1);
            expect(inputs[0].projectDir).toBe(frame.projLegacy);
            expect(inputs[0].outDir).toBe(resolve(frame.legacyOut));
            const legacyLayers: PzStudioHostSettings = {
                workspace: {
                    templates: {
                        project: {
                            url: 'https://github.com/legacy/doctor-fixture',
                        },
                    },
                },
            };
            const expectedTemplate = probeTemplateCacheDir('project', {
                settings: legacyLayers,
            });
            expect(inputs[0].templateDir).toBe(expectedTemplate!.dir);
            // A settings-less probe resolves the default-template cache —
            // different dir, proving the legacy layers (not a fallback) fed
            // the core.
            expect(inputs[0].templateDir).not.toBe(
                probeTemplateCacheDir('project')!.dir,
            );
            // Same report the core produces with the same raw legacy snapshot.
            expect(report).toEqual(
                await runProjectDoctorCore(frame.projLegacy, {
                    settings: legacySettings(),
                    logger: legacyLogger(),
                    gameBuild: '42.20.1',
                }),
            );
            // The v2 logger received nothing from the legacy operation.
            expect(frame.L2.calls.length).toBe(l2Count);
        } finally {
            await frame.done();
        }
        expect(getActiveInvocationContext()).toBeUndefined();
    });

    it('legacy ModInfo resolution uses only raw legacy state', async () => {
        const frame = await parkedV2Frame();
        const l2Count = frame.L2.calls.length;
        try {
            const nested = path.join(frame.projLegacy, 'docs', 'deep');
            fs.mkdirSync(nested, { recursive: true });
            fs.mkdirSync(
                path.join(frame.projLegacy, 'my_mod', 'branch', 'media'),
                { recursive: true },
            );
            setProjectRootAnchor(nested);

            const targets = resolveModInfoTargets('my_mod');

            // Resolved from the raw legacy anchor's real root — never the
            // v2 project and never the bare anchor directory.
            expect(targets).toEqual([
                path.join(frame.projLegacy, 'my_mod', 'branch'),
            ]);
            expect(targets[0].startsWith(frame.projV2)).toBe(false);
            expect(frame.L2.calls.length).toBe(l2Count);
        } finally {
            await frame.done();
        }
        expect(getActiveInvocationContext()).toBeUndefined();
    });

    it('template resolution through the explicit scope is transport- and settings-isolated', async () => {
        const frame = await parkedV2Frame();
        const l2Count = frame.L2.calls.length;
        try {
            const T1 = sentinelTransport('git');
            const t1Valid = vi.spyOn(T1, 'isCacheValid').mockReturnValue(true);

            const legacyLayers: PzStudioHostSettings = {
                workspace: {
                    templates: {
                        workshop: { url: 'https://github.com/legacy/tpl' },
                    },
                },
            };
            const l1Count = frame.L1.calls.length;
            const dir = resolveTemplateDir('workshop', {
                settings: legacyLayers,
                templateTransport: T1,
            });

            // The cache path derives from the PASSED settings' url,
            // validated by the PASSED transport — cache hit, no clone, no
            // ambient touch.
            expect(dir).toBe(
                probeTemplateCacheDir('workshop', {
                    settings: legacyLayers,
                })!.dir,
            );
            expect(t1Valid).toHaveBeenCalledWith(dir);
            // The v2 instance transport was never consulted.
            expect(frame.T2.isCacheValid).not.toHaveBeenCalled();
            expect(frame.T2.download).not.toHaveBeenCalled();
            expect(frame.T2.refresh).not.toHaveBeenCalled();
            // Nor the v2 settings: a settings-less probe resolves the
            // default-template cache — a different dir.
            expect(dir).not.toBe(probeTemplateCacheDir('workshop')!.dir);
            // Commit 6 (Appendix C): the scope form omits the io logger →
            // raw legacy routing. COLD frame: the one-time bootstrap info —
            // the exact emission the commit-5 test had to pre-seed away —
            // occurs naturally and lands in the LEGACY slot, never in the
            // v2 logger.
            expect(
                frame.L1.calls
                    .slice(l1Count)
                    .some(
                        (c) =>
                            c.method === 'info' &&
                            String(c.message).includes(
                                '- Bootstrapping legacy templates',
                            ),
                    ),
            ).toBe(true);
            expect(frame.L2.calls.length).toBe(l2Count);
        } finally {
            await frame.done();
        }
        expect(getActiveInvocationContext()).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* 8. Outdir tier order: project > ws > user > global > default        */
/* ------------------------------------------------------------------ */

describe('getOutDir explicit scope: exact tier order', () => {
    const layers = (ws?: string, user?: string) => ({
        workspace: ws ? { outdir: ws } : undefined,
        user: user ? { outdir: user } : undefined,
    });

    it('tier 1: project outdir wins over every layer and resolves against the scope root', () => {
        const projectRoot = makeTempDir();
        expect(
            getOutDir(
                { outdir: 'out' } as any,
                { outdir: 'C:/global' } as any,
                {
                    projectDir: projectRoot,
                    settings: layers('C:/ws', 'C:/user'),
                },
            ),
        ).toBe(path.join(projectRoot, 'out'));
    });

    it('tier 2: workspace layer when the project has no outdir', () => {
        expect(
            getOutDir({} as any, undefined, {
                projectDir: makeTempDir(),
                settings: layers('C:/ws-out'),
            }),
        ).toBe(resolve('C:/ws-out'));
    });

    it('tier 3: user layer when the workspace layer has no outdir', () => {
        expect(
            getOutDir({} as any, undefined, {
                projectDir: makeTempDir(),
                settings: layers(undefined, 'C:/user-out'),
            }),
        ).toBe(resolve('C:/user-out'));
    });

    it('workspace beats user when both define an outdir', () => {
        expect(
            getOutDir({} as any, undefined, {
                projectDir: makeTempDir(),
                settings: layers('C:/ws-out', 'C:/user-out'),
            }),
        ).toBe(resolve('C:/ws-out'));
    });

    it('tier 4: global config when no project/host layer defines one', () => {
        expect(
            getOutDir({} as any, { outdir: 'C:/global-out' } as any, {
                projectDir: makeTempDir(),
                settings: layers(),
            }),
        ).toBe(resolve('C:/global-out'));
    });

    it('tier 5: default when nothing defines an outdir', () => {
        const home = (globalThis as any).__PZSTUDIO_FAKE_HOME as string;
        expect(
            getOutDir({} as any, { outdir: undefined } as any, {
                projectDir: makeTempDir(),
                settings: layers(),
            }),
        ).toBe(path.join(home, 'Zomboid', 'Workshop'));
    });

    it('without a scope the ambient-branched form is unchanged (legacy slots still apply)', () => {
        setVsCodeSettings({ outdir: 'C:/slot-out' });
        expect(getOutDir({} as any)).toBe(resolve('C:/slot-out'));
    });
});

/* ------------------------------------------------------------------ */
/* 9. Commit 6 (Appendix C): explicit io threading — the emission      */
/*    inventory captured per reachable path, not sampled               */
/* ------------------------------------------------------------------ */

describe('commit 6 io threading (Appendix C): explicit io scopes', () => {
    const fakeHome = () => (globalThis as any).__PZSTUDIO_FAKE_HOME as string;

    it('readProjectConfig: [MIGRATION] warning and defaults verboses route to the io logger', () => {
        const { calls, logger } = recordingLogger();
        const proj = makeTempDir();
        fs.writeFileSync(
            path.join(proj, 'project.json'),
            JSON.stringify({
                // root-level "title" triggers the migration warning
                title: 'Old Title',
                workshop: {
                    title: 'Old Title',
                    visibility: 'public',
                    tags: [],
                },
                mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
            }),
        );

        const config = readProjectConfig(
            path.join(proj, 'project.json'),
            true,
            { logger },
        );

        expect(config).toBeDefined();
        expect(
            calls.some(
                (c) =>
                    c.method === 'warn' &&
                    String(c.message).includes('[MIGRATION]') &&
                    String(c.message).includes('needs migration'),
            ),
        ).toBe(true);
        expect(
            calls.some(
                (c) =>
                    c.method === 'verbose' &&
                    String(c.message).includes(
                        "Mod 'my_mod' defaulting poster",
                    ),
            ),
        ).toBe(true);
    });

    it('applyProjectDefaults verboses route to the io logger', () => {
        const { calls, logger } = recordingLogger();

        applyProjectDefaults(
            { workshop: { title: 'X', visibility: 'public', tags: [] } },
            { logger },
        );

        expect(
            calls.some(
                (c) =>
                    c.method === 'verbose' &&
                    String(c.message).includes('Defaulting excludes'),
            ),
        ).toBe(true);
    });

    it('getOutDir: the default-path verbose routes to the scope logger (tier 5)', () => {
        const { calls, logger } = recordingLogger();

        const dir = getOutDir({} as any, { outdir: undefined } as any, {
            projectDir: makeTempDir(),
            settings: {},
            logger,
        });

        expect(dir).toBe(path.join(fakeHome(), 'Zomboid', 'Workshop'));
        expect(
            calls.some(
                (c) =>
                    c.method === 'verbose' &&
                    String(c.message).includes(
                        'Defaulting output directory to:',
                    ),
            ),
        ).toBe(true);
    });

    it('readGlobalConfig: read verbose and corrupt/validation warns route to the io logger', () => {
        const { calls, logger } = recordingLogger();
        fs.mkdirSync(path.join(fakeHome(), '.pzstudio'), { recursive: true });
        // Valid JSON that FAILS validation — the corrupt-config warning path.
        fs.writeFileSync(
            getConfigPath(),
            JSON.stringify({ useSymlinks: 'yes' }),
        );

        const config = readGlobalConfig(true, { logger });

        // In-memory defaults survive (the warning path's contract).
        expect(config.useSymlinks).toBe(true);
        expect(
            calls.some(
                (c) =>
                    c.method === 'verbose' &&
                    String(c.message).includes('Reading global config from:'),
            ),
        ).toBe(true);
        expect(
            calls.some(
                (c) =>
                    c.method === 'warn' &&
                    String(c.message).includes(
                        'Validation failed for global config',
                    ),
            ),
        ).toBe(true);
        expect(
            calls.some(
                (c) =>
                    c.method === 'warn' &&
                    String(c.message).includes(
                        'Continuing with in-memory defaults',
                    ),
            ),
        ).toBe(true);
    });

    it('probeTemplateCacheDir threads its global-config read verbose through the scope logger (doctor row)', () => {
        const { calls, logger } = recordingLogger();

        probeTemplateCacheDir('workshop', { settings: {}, logger });

        expect(
            calls.some(
                (c) =>
                    c.method === 'verbose' &&
                    String(c.message).includes('Reading global config from:'),
            ),
        ).toBe(true);
    });

    it('cloneRemoteTemplateWithIo: the clone-failure warning routes to the io logger', () => {
        const { calls, logger } = recordingLogger();
        const T = sentinelTransport('git');
        vi.spyOn(T, 'download').mockImplementation(() => {
            throw new Error('clone exploded');
        });

        expect(
            cloneRemoteTemplateWithIo(
                'https://github.com/x/y.git',
                makeTempDir(),
                undefined,
                T,
                { logger },
            ),
        ).toBe(false);
        expect(
            calls.some(
                (c) =>
                    c.method === 'warn' &&
                    String(c.message).includes('- clone exploded'),
            ),
        ).toBe(true);
    });

    it('published cloneRemoteTemplate keeps its baseline signature: the omitted-io clone-fail warning routes raw legacy (R1)', () => {
        const { calls, logger } = recordingLogger();
        setLogger(logger);
        const T = sentinelTransport('git');
        vi.spyOn(T, 'download').mockImplementation(() => {
            throw new Error('raw clone exploded');
        });

        // 4-arg call — the exact baseline published shape; no io scope.
        expect(
            cloneRemoteTemplate(
                'https://github.com/x/y.git',
                makeTempDir(),
                undefined,
                T,
            ),
        ).toBe(false);
        expect(
            calls.some(
                (c) =>
                    c.method === 'warn' &&
                    String(c.message).includes('- raw clone exploded'),
            ),
        ).toBe(true);
        setLogger(undefined);
    });

    it('resolveTemplateDir cold-cache inventory: bootstrap info, cache/legacy verboses, clone-fail and legacy-fallback warns route to the io logger', () => {
        const { calls, logger } = recordingLogger();
        const T = sentinelTransport('git');
        vi.spyOn(T, 'isCacheValid').mockReturnValue(false);
        vi.spyOn(T, 'download').mockImplementation(() => {
            throw new Error('clone exploded');
        });

        // Official default url → after the failed clone the legacy fallback
        // applies; the fake home is cold, so the one-time bootstrap runs.
        const dir = resolveTemplateDir('workshop', {
            templateTransport: T,
            logger,
        });

        expect(dir).toBe(
            path.join(
                fakeHome(),
                '.pzstudio',
                '.template-legacy',
                '.template-workshop',
            ),
        );
        const has = (method: string, fragment: string) =>
            calls.some(
                (c) =>
                    c.method === method && String(c.message).includes(fragment),
            );
        expect(has('info', '- Bootstrapping legacy templates')).toBe(true);
        expect(has('verbose', 'Reading global config from:')).toBe(true);
        expect(has('verbose', 'Resolved cacheDir:')).toBe(true);
        expect(has('verbose', 'Resolved legacyDir:')).toBe(true);
        expect(has('warn', '- clone exploded')).toBe(true);
        expect(has('warn', 'Failed to clone template from')).toBe(true);
        expect(has('warn', 'Falling back to offline legacy template')).toBe(
            true,
        );
    });

    it('resolveTemplateDir: the community-template warning routes to the io logger', () => {
        const { calls, logger } = recordingLogger();
        const T = sentinelTransport('git');
        vi.spyOn(T, 'isCacheValid').mockReturnValue(false);

        // Community url → no legacy fallback → actionable throw.
        expect(() =>
            resolveTemplateDir('workshop', {
                settings: {
                    workspace: {
                        templates: {
                            workshop: {
                                url: 'https://github.com/community/not-verified.git',
                            },
                        },
                    },
                },
                templateTransport: T,
                logger,
            }),
        ).toThrow(/Failed to resolve template/);
        expect(
            calls.some(
                (c) =>
                    c.method === 'warn' &&
                    String(c.message).includes(
                        '⚠ Cloning from community template',
                    ),
            ),
        ).toBe(true);
    });

    it('resolveTemplateDir: invalid-cache, offline-fallback and refresh-failure warnings route to the io logger', () => {
        seedLegacyTemplates();
        const url =
            'https://github.com/escapepz/pzstudio-template-workshop.git';
        const layers = {
            workspace: { templates: { workshop: { url } } },
        };

        // Invalid cache: the dir exists but holds no valid cache.
        const cacheDir = probeTemplateCacheDir('workshop', {
            settings: layers,
        })!.dir;
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, 'junk.txt'), 'junk');

        const invalid = recordingLogger();
        const T1 = sentinelTransport('git');
        vi.spyOn(T1, 'download').mockImplementation(() => {
            throw new Error('clone exploded');
        });
        resolveTemplateDir('workshop', {
            settings: layers,
            templateTransport: T1,
            logger: invalid.logger,
        });
        expect(
            invalid.calls.some(
                (c) =>
                    c.method === 'warn' &&
                    String(c.message).includes(
                        `Template cache at ${cacheDir} is invalid. Re-cloning...`,
                    ),
            ),
        ).toBe(true);

        // Offline fallback: no cache, non-empty legacy dir.
        const offline = recordingLogger();
        const offlineDir = resolveTemplateDir('workshop', {
            isOffline: true,
            settings: layers,
            templateTransport: sentinelTransport('git'),
            logger: offline.logger,
        });
        expect(offlineDir).toContain('.template-workshop');
        expect(
            offline.calls.some(
                (c) =>
                    c.method === 'warn' &&
                    String(c.message).includes(
                        'Template not found in cache. Falling back to offline legacy template.',
                    ),
            ),
        ).toBe(true);

        // Forced refresh failure on a valid cache.
        const refresh = recordingLogger();
        const T3 = sentinelTransport('git');
        vi.spyOn(T3, 'isCacheValid').mockReturnValue(true);
        vi.spyOn(T3, 'refresh').mockReturnValue(false);
        vi.spyOn(T3, 'download').mockImplementation(() => {
            throw new Error('clone exploded');
        });
        resolveTemplateDir('workshop', {
            forceUpdate: true,
            settings: layers,
            templateTransport: T3,
            logger: refresh.logger,
        });
        expect(
            refresh.calls.some(
                (c) =>
                    c.method === 'warn' &&
                    String(c.message).includes(
                        'Failed to refresh template cache. Re-cloning...',
                    ),
            ),
        ).toBe(true);
    });
});

/* ------------------------------------------------------------------ */
/* 10. Commit 6: transport constructor sinks                           */
/* ------------------------------------------------------------------ */

describe('commit 6 transport constructor sinks (Appendix C)', () => {
    it('GitTransport refresh emissions route to the constructor sink', () => {
        const { calls, logger } = recordingLogger();

        // A non-repo dir makes the real git fetch fail fast (no network).
        expect(
            new GitTransport({ logger }).refresh(makeTempDir(), undefined),
        ).toBe(false);

        expect(
            calls.some(
                (c) =>
                    c.method === 'info' &&
                    String(c.message).includes(
                        '- Refreshing template cache at',
                    ),
            ),
        ).toBe(true);
        expect(
            calls.some(
                (c) =>
                    c.method === 'warn' &&
                    /git fetch failed|Failed to run git fetch/.test(
                        String(c.message),
                    ),
            ),
        ).toBe(true);
    });

    it('GitTransport download info routes to the constructor sink (fires before the clone attempt)', () => {
        const { calls, logger } = recordingLogger();

        // GIT_ALLOW_PROTOCOL=file (suite setup) fails the https clone
        // instantly; the info emission happens BEFORE the spawn either way.
        expect(() =>
            new GitTransport({ logger }).download(
                'https://github.com/owner/repo.git',
                undefined,
                makeTempDir(),
            ),
        ).toThrow();
        expect(
            calls.some(
                (c) =>
                    c.method === 'info' &&
                    String(c.message).includes(
                        '- Cloning template from https://github.com/owner/repo.git',
                    ),
            ),
        ).toBe(true);
    });

    it('FetchTransport download verbose/info and no-manifest refresh warn route to the constructor sink', () => {
        const { calls, logger } = recordingLogger();
        const t = new FetchTransport({ logger });
        // The archive fetch itself is not under test — only its emissions.
        // The empty archive makes the extraction throw AFTER the verbose
        // and info emissions have fired, which is exactly what we capture.
        vi.spyOn(t as any, 'fetchArchive').mockReturnValue(new Uint8Array());
        expect(() =>
            t.download(
                'https://github.com/owner/repo.git',
                undefined,
                makeTempDir(),
            ),
        ).toThrow();

        expect(
            calls.some(
                (c) =>
                    c.method === 'verbose' &&
                    String(c.message).includes(
                        '- Fetching template archive from',
                    ),
            ),
        ).toBe(true);
        expect(
            calls.some(
                (c) =>
                    c.method === 'info' &&
                    String(c.message).includes(
                        '- Downloaded template owner/repo',
                    ),
            ),
        ).toBe(true);

        const noManifest = recordingLogger();
        new FetchTransport({ logger: noManifest.logger }).refresh(
            makeTempDir(),
            undefined,
        );
        expect(
            noManifest.calls.some(
                (c) =>
                    c.method === 'warn' &&
                    String(c.message).includes(
                        'has no manifest; cannot refresh',
                    ),
            ),
        ).toBe(true);
    });
});

/* ------------------------------------------------------------------ */
/* 11. Commit 6: R1 raw-legacy default routing                         */
/* ------------------------------------------------------------------ */

describe('commit 6 R1 raw-legacy default routing', () => {
    const fakeHome = () => (globalThis as any).__PZSTUDIO_FAKE_HOME as string;

    /**
     * Minimal parked-v2 frame: a v2 run holding the lock with its ambient
     * installed and its instance logger/transport deliberately separate
     * from the legacy slots. v2Count snapshots the instance logger's call
     * count once the run is truly parked (inside the swapped command body),
     * so later assertions are race-free.
     */
    async function parkedV2SinkFrame() {
        const projV2 = makeProjectDir('V2Project');
        const V2 = recordingLogger();
        const L1 = recordingLogger();
        const T2 = sentinelTransport('fetch');
        vi.spyOn(T2, 'isCacheValid');

        const studio = createPzStudio({
            projectDir: projV2,
            logger: V2.logger,
            templateTransport: T2,
        });

        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        let parkedFlag = false;
        const parked = studio.run('list', [], {
            flags: ['--project', projV2],
        });
        const restoreCommand = withCommandRun('list', async () => {
            parkedFlag = true;
            await gate;
        });
        await vi.waitFor(() => expect(parkedFlag).toBe(true));

        return {
            projV2,
            V2,
            L1,
            T2,
            v2Count: V2.calls.length,
            done: async () => {
                release();
                restoreCommand();
                await parked;
            },
        };
    }

    it('an omitted io scope routes exactly like the explicit raw legacy sink (legacy default-sink equivalence)', () => {
        setVerbose(true);

        // Via the legacy logger slot (externalLogger):
        const L = recordingLogger();
        setLogger(L.logger);
        readGlobalConfig(false); // omitted io → raw tier
        const afterOmitted = L.calls.length;
        expect(afterOmitted).toBeGreaterThan(0);
        readGlobalConfig(false, { logger: legacyLogger() }); // explicit raw sink
        expect(L.calls.length).toBe(afterOmitted + 1);
        expect(L.calls[afterOmitted].method).toBe('verbose');
        expect(String(L.calls[afterOmitted].message)).toBe(
            String(L.calls[afterOmitted - 1].message),
        );
        setLogger(undefined);

        // Via the raw stdout/stderr sink (no external logger): identical
        // captured streams.
        const first = captureIO();
        readGlobalConfig(false);
        const firstStderr = [...first.stderr];
        expect(firstStderr.join('')).toContain('Reading global config from:');
        setCliIO(undefined);
        const second = captureIO();
        readGlobalConfig(false, { logger: legacyLogger() });
        expect(second.stderr).toEqual(firstStderr);
    });

    it('an omitted io scope beside an active v2 run still routes raw legacy (default-sink equivalence under overlap)', async () => {
        const frame = await parkedV2SinkFrame();
        setLogger(frame.L1.logger);
        setVerbose(true);
        try {
            readGlobalConfig(false); // omitted io
            expect(
                frame.L1.calls.some(
                    (c) =>
                        c.method === 'verbose' &&
                        String(c.message).includes(
                            'Reading global config from:',
                        ),
                ),
            ).toBe(true);
            expect(frame.V2.calls.length).toBe(frame.v2Count);
        } finally {
            await frame.done();
        }
        expect(getActiveInvocationContext()).toBeUndefined();
    });

    it('a legacy resolveTemplateDir() with omitted io scope routes raw-legacy beside an active v2 run (R1 iii)', async () => {
        const frame = await parkedV2SinkFrame();
        setLogger(frame.L1.logger);
        setVerbose(true);
        try {
            // The positional form's only visible transport is the engine
            // reader (the parked v2 instance's) — made valid so the path
            // stops at the cache hit. The assertion targets EMISSION
            // routing: every emission must land raw legacy, none in V2.
            vi.spyOn(frame.T2, 'isCacheValid').mockReturnValue(true);
            const l1Start = frame.L1.calls.length;

            const dir = resolveTemplateDir('workshop'); // positional, no scope

            expect(frame.T2.isCacheValid).toHaveBeenCalledWith(dir);
            const l1 = frame.L1.calls.slice(l1Start);
            expect(
                l1.some(
                    (c) =>
                        c.method === 'info' &&
                        String(c.message).includes(
                            '- Bootstrapping legacy templates',
                        ),
                ),
            ).toBe(true);
            expect(
                l1.some(
                    (c) =>
                        c.method === 'verbose' &&
                        String(c.message).includes('Resolved cacheDir:'),
                ),
            ).toBe(true);
            expect(
                l1.some(
                    (c) =>
                        c.method === 'verbose' &&
                        String(c.message).includes('Resolved legacyDir:'),
                ),
            ).toBe(true);
            expect(frame.V2.calls.length).toBe(frame.v2Count);
        } finally {
            await frame.done();
        }
        expect(getActiveInvocationContext()).toBeUndefined();
    });

    it('an omitted transport sink routes raw legacy: beside an active v2 run its emissions land in the legacy slot, never the v2 logger', async () => {
        const frame = await parkedV2SinkFrame();
        setLogger(frame.L1.logger);
        try {
            new GitTransport().refresh(makeTempDir(), undefined);
            expect(
                frame.L1.calls.some(
                    (c) =>
                        c.method === 'info' &&
                        String(c.message).includes(
                            '- Refreshing template cache at',
                        ),
                ),
            ).toBe(true);
            expect(frame.V2.calls.length).toBe(frame.v2Count);
        } finally {
            await frame.done();
        }
        expect(getActiveInvocationContext()).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* 12. Commit 6 acceptance: R1 cold overlap with a LEGACY cold         */
/*     template operation (replaces the commit-5 pre-seed workaround)  */
/* ------------------------------------------------------------------ */

describe('commit 6 R1 cold overlap: legacy cold template op beside a parked v2 run', () => {
    it('every bootstrap/cache/template/transport emission lands in the legacy logger; the v2 logger receives none', async () => {
        const projV2 = makeProjectDir('V2Project');
        const v2Out = makeTempDir();
        const V2 = recordingLogger();
        const T2 = sentinelTransport('fetch');
        vi.spyOn(T2, 'isCacheValid');
        vi.spyOn(T2, 'download');
        vi.spyOn(T2, 'refresh');

        const legacyOut = makeTempDir();
        const L1 = recordingLogger();

        // Legacy facade state — populated, deliberately different from the
        // instance's. The sticky transport is a REAL GitTransport so the
        // transport-tier emissions occur naturally; its omitted constructor
        // sink routes raw legacy.
        setLogger(L1.logger);
        setVerbose(true);
        setVsCodeSettings({ outdir: legacyOut });
        setTemplateTransport(new GitTransport());

        const studio = createPzStudio({
            projectDir: projV2,
            logger: V2.logger,
            settings: () => ({ workspace: { outdir: v2Out } }),
            templateTransport: T2,
        });

        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        let parkedFlag = false;
        const parked = studio.run('list', [], {
            flags: ['--project', projV2],
        });
        const restoreCommand = withCommandRun('list', async () => {
            parkedFlag = true;
            await gate;
        });
        await vi.waitFor(() => expect(parkedFlag).toBe(true));

        let session:
            | {
                  stop: () => Promise<void>;
              }
            | undefined;
        try {
            const v2Count = V2.calls.length;
            const l1Start = L1.calls.length;

            // LEGACY cold template operation: the legacy DevSync wrapper —
            // raw legacy deps per apply, NO template override, cold fake
            // home. The plan input bootstraps the legacy templates, reads
            // the global config, resolves the workshop template and clones
            // (failing fast against the suite's git protocol lockdown) —
            // all emissions occur naturally.
            const projLegacy = makeProjectDir('LegacyProject');
            fs.mkdirSync(path.join(projLegacy, 'my_mod', 'media', 'lua'), {
                recursive: true,
            });
            fs.writeFileSync(
                path.join(projLegacy, 'my_mod', 'media', 'lua', 'hello.lua'),
                'print("v1")',
            );

            session = createDevSync(projLegacy);
            await session.start(['main']);
            await session.stop();

            // ALL legacy emissions landed in L1 — the full Appendix C
            // inventory this path can emit, captured, not sampled.
            const l1 = L1.calls.slice(l1Start);
            const has = (method: string, fragment: string) =>
                l1.some(
                    (c) =>
                        c.method === method &&
                        String(c.message).includes(fragment),
                );
            expect(has('info', '- Bootstrapping legacy templates')).toBe(true);
            expect(has('verbose', 'Reading global config from:')).toBe(true);
            expect(has('verbose', 'Resolved cacheDir:')).toBe(true);
            expect(has('verbose', 'Resolved legacyDir:')).toBe(true);
            expect(
                has(
                    'info',
                    '- Cloning template from https://github.com/escapepz/pzstudio-template-workshop.git',
                ),
            ).toBe(true);
            expect(has('warn', 'Failed to clone template from')).toBe(true);
            expect(has('warn', 'Falling back to offline legacy template')).toBe(
                true,
            );

            // The v2 logger received NONE of them — and nothing at all
            // during the legacy operation's window.
            expect(V2.calls.length).toBe(v2Count);
            expect(
                V2.calls.some((c) =>
                    l1.some(
                        (legacy) =>
                            legacy.method === c.method &&
                            String(legacy.message) === String(c.message),
                    ),
                ),
            ).toBe(false);

            // Config fingerprint: the sync resolved through the RAW legacy
            // settings (the outdir slot) — the v2 outdir is untouched.
            expect(fs.existsSync(path.join(legacyOut, 'LegacyProject'))).toBe(
                true,
            );
            expect(fs.readdirSync(v2Out)).toEqual([]);
        } finally {
            if (session) await session.stop().catch(() => {});
            release();
            restoreCommand();
            await parked.catch(() => {});
        }
        expect(getActiveInvocationContext()).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* 13. Commit 6: the mirror direction — v2 non-engine ops use the      */
/*     instance logger even with the legacy slots populated            */
/* ------------------------------------------------------------------ */

describe('commit 6 R1 mirror: v2 non-engine ops log to the instance with legacy slots populated', () => {
    it('studio.createDevSync routes the cold plan-input emissions to the instance logger; the legacy slot stays silent', async () => {
        const legacyOut = makeTempDir();
        const L1 = recordingLogger();
        const T1 = sentinelTransport('git');
        vi.spyOn(T1, 'isCacheValid');
        vi.spyOn(T1, 'download');
        vi.spyOn(T1, 'refresh');

        // Aggressively populated legacy facade state.
        setLogger(L1.logger);
        setVerbose(true);
        setProjectDir(makeTempDir());
        setVsCodeSettings({
            outdir: legacyOut,
            templates: {
                workshop: {
                    url: 'https://github.com/legacy/should-not-win.git',
                },
            },
        });
        setTemplateTransport(T1);

        const v2Out = makeTempDir();
        const V2 = recordingLogger();
        const studio = createPzStudio({
            logger: V2.logger,
            settings: () => ({ workspace: { outdir: v2Out } }),
            // No templateTransport: the host default is constructed with
            // the instance logger (§12, commit 6) — a real GitTransport
            // whose emissions must land in V2.
        });

        const proj = makeProjectDir('MirrorProject');
        fs.mkdirSync(path.join(proj, 'my_mod', 'media', 'lua'), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(proj, 'my_mod', 'media', 'lua', 'hello.lua'),
            'print("v1")',
        );

        const session = studio.createDevSync(proj);
        await session.start(['main']);
        await session.stop();

        const has = (method: string, fragment: string) =>
            V2.calls.some(
                (c) =>
                    c.method === method && String(c.message).includes(fragment),
            );
        expect(has('info', '- Bootstrapping legacy templates')).toBe(true);
        expect(has('verbose', 'Reading global config from:')).toBe(true);
        expect(has('verbose', 'Resolved cacheDir:')).toBe(true);
        expect(
            has(
                'info',
                '- Cloning template from https://github.com/escapepz/pzstudio-template-workshop.git',
            ),
        ).toBe(true);
        expect(has('warn', 'Failed to clone template from')).toBe(true);
        expect(has('warn', 'Falling back to offline legacy template')).toBe(
            true,
        );

        // The legacy logger received NOTHING — not even the gated verboses.
        expect(L1.calls).toEqual([]);
        // The legacy sticky transport was never consulted.
        expect(T1.isCacheValid).not.toHaveBeenCalled();
        expect(T1.download).not.toHaveBeenCalled();
        // Settings fingerprint: the instance's workspace layer decided;
        // the legacy outdir slot is untouched.
        expect(fs.existsSync(path.join(v2Out, 'MirrorProject'))).toBe(true);
        expect(fs.readdirSync(legacyOut)).toEqual([]);
    });

    it('studio.runProjectDoctor routes its emissions to the instance logger ([MIGRATION] + probe verboses)', async () => {
        const L1 = recordingLogger();
        setLogger(L1.logger);
        setVerbose(true);
        setVsCodeSettings({ outdir: 'C:/legacy-doctor-out' });

        const V2 = recordingLogger();
        const studio = createPzStudio({ logger: V2.logger });

        const proj = makeTempDir();
        fs.writeFileSync(
            path.join(proj, 'project.json'),
            JSON.stringify({
                // root-level "title" → the [MIGRATION] warning path
                title: 'Old Doctor',
                workshop: {
                    title: 'Old Doctor',
                    visibility: 'public',
                    tags: [],
                },
                mods: {},
            }),
        );

        await studio.runProjectDoctor(proj, { gameBuild: '42.20.1' });

        expect(
            V2.calls.some(
                (c) =>
                    c.method === 'warn' &&
                    String(c.message).includes('[MIGRATION]'),
            ),
        ).toBe(true);
        expect(
            V2.calls.some(
                (c) =>
                    c.method === 'verbose' &&
                    String(c.message).includes('Reading global config from:'),
            ),
        ).toBe(true);
        expect(L1.calls).toEqual([]);
    });

    it('studio.resolveModInfoTargets emits nothing and both sinks stay silent', () => {
        const L1 = recordingLogger();
        setLogger(L1.logger);

        const V2 = recordingLogger();
        const studio = createPzStudio({ logger: V2.logger });
        const projRoot = makeProjectDir('ModInfoTargets');
        fs.mkdirSync(path.join(projRoot, 'modA', 'branch', 'media'), {
            recursive: true,
        });

        expect(studio.resolveModInfoTargets('modA', projRoot)).toEqual([
            path.join(projRoot, 'modA', 'branch'),
        ]);
        expect(L1.calls).toEqual([]);
        expect(V2.calls).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* 14. PzStudio §7 final surface                                       */
/* ------------------------------------------------------------------ */

describe('PzStudio §7 final surface', () => {
    it('exposes the full normative shape: run, createDevSync, runProjectDoctor, resolveModInfoTargets', () => {
        const studio = createPzStudio();
        expect(typeof studio.run).toBe('function');
        expect(typeof studio.createDevSync).toBe('function');
        expect(typeof studio.runProjectDoctor).toBe('function');
        expect(typeof studio.resolveModInfoTargets).toBe('function');
    });

    it('resolveModInfoTargets(modId, projectDir) equals the helper with an explicit baseDir', () => {
        const studio = createPzStudio();
        const projRoot = makeProjectDir('SurfaceModInfo');
        fs.mkdirSync(path.join(projRoot, 'modA', 'branch', 'media'), {
            recursive: true,
        });
        fs.mkdirSync(path.join(projRoot, 'modA', 'noMedia'), {
            recursive: true,
        });

        expect(studio.resolveModInfoTargets('modA', projRoot)).toEqual(
            resolveModInfoTargets('modA', projRoot),
        );
        expect(studio.resolveModInfoTargets('modA', projRoot)).toEqual([
            path.join(projRoot, 'modA', 'branch'),
        ]);
    });

    it('createDevSync re-evaluates the settings provider per plan input with the session projectDir', async () => {
        const { projectDir, templateDir } = makeSyncProject();
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({
            settings: provider,
            logger: recordingLogger().logger,
        });

        const session = studio.createDevSync(projectDir, {
            workshopTemplateDir: templateDir,
            quiet: true,
        });
        await session.start(['main']);
        expect(provider.mock.calls.length).toBeGreaterThan(0);
        for (const call of provider.mock.calls) {
            expect(call).toEqual([{ projectDir }]);
        }
        const afterStart = provider.mock.calls.length;

        await session.rebuild();
        await session.stop();

        expect(provider.mock.calls.length).toBe(afterStart + 1);
    });

    it('runProjectDoctor resolves settings exactly once with the explicit projectDir context', async () => {
        const proj = makeProjectDir('DoctorProviderOnce');
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({
            settings: provider,
            logger: recordingLogger().logger,
        });

        await studio.runProjectDoctor(proj);

        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider).toHaveBeenCalledWith({ projectDir: proj });
    });

    it('createDevSync and runProjectDoctor run outside the engine lock (a parked v2 run does not queue them)', async () => {
        const projV2 = makeProjectDir('V2Lock');
        const studio = createPzStudio();
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        let parkedFlag = false;
        const parked = studio.run('list', [], {
            flags: ['--project', projV2],
        });
        const restoreCommand = withCommandRun('list', async () => {
            parkedFlag = true;
            await gate;
        });
        await vi.waitFor(() => expect(parkedFlag).toBe(true));

        try {
            // Another instance's doctor completes while the first run
            // still holds the lock — non-engine ops never queue (§13).
            const projDoctor = makeProjectDir('LockFreeDoctor');
            await expect(
                createPzStudio({
                    logger: recordingLogger().logger,
                }).runProjectDoctor(projDoctor),
            ).resolves.toBeDefined();
            expect(getActiveInvocationContext()).toBeDefined();
        } finally {
            release();
            restoreCommand();
            await parked.catch(() => {});
        }
        expect(getActiveInvocationContext()).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* 15. Commit 6 engine routing: emissions from inside the io-threaded  */
/*     helper layer follow the invocation logger on BOTH doors (§12).  */
/*     The R1 raw default only covers legacy non-engine omissions —    */
/*     engine commands pass engineIo(), never raw, never the slot.     */
/* ------------------------------------------------------------------ */

describe('commit 6 engine routing: helper-layer emissions keep the invocation logger under studio.run()', () => {
    const fakeHome = () => (globalThis as any).__PZSTUDIO_FAKE_HOME as string;

    /** A project.json in the LEGACY shape (root-level title) so that reading it emits the [MIGRATION] warning. */
    function makeLegacyShapeProject(title: string): string {
        const dir = makeTempDir();
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
                title,
                workshop: { title, visibility: 'public', tags: [] },
                mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
            }),
        );
        return dir;
    }

    it('studio.run(list) routes the [MIGRATION] warning and the defaulting verboses to the instance logger — never the legacy slot nor the raw sink', async () => {
        const proj = makeLegacyShapeProject('Engine List');
        const L1 = recordingLogger();
        const raw = captureIO();

        // Conflicting legacy facade state, verbosity wide open: if any
        // helper emission routed raw, L1 (or the captured streams) would
        // receive it.
        setLogger(L1.logger);
        setVerbose(true);

        const V2 = recordingLogger();
        const studio = createPzStudio({ logger: V2.logger });
        // Verbosity is per-invocation (the parsed --verbose flag): the v2
        // run deliberately does not consume the legacy setVerbose slot (R0).
        await studio.run('list', [], {
            flags: ['--verbose', '--project', proj],
        });

        const has = (method: string, fragment: string) =>
            V2.calls.some(
                (c) =>
                    c.method === method && String(c.message).includes(fragment),
            );
        // Helper-layer emissions (readProjectConfig → [MIGRATION];
        // applyProjectDefaults → poster default verbose; the migration
        // path materializes excludes, so only mod-level defaults remain):
        expect(has('warn', '[MIGRATION]')).toBe(true);
        expect(has('verbose', "Mod 'my_mod' defaulting poster to:")).toBe(true);
        // The command's own engine-tier emission is still there:
        expect(has('log', 'my_mod')).toBe(true);

        // NONE of it landed in the legacy slot or the raw streams.
        expect(L1.calls).toEqual([]);
        expect(raw.stderr.join('')).not.toContain('[MIGRATION]');
        expect(raw.stdout.join('')).not.toContain('[MIGRATION]');
    });

    it('studio.run(update) routes the full template-resolution inventory (refresh, clone, fallback, bootstrap) to the instance logger', async () => {
        // Pre-seed VALID template caches (non-empty + .git) for every
        // category so the forced update exercises the refresh path first,
        // then the real (protocol-locked) git failure cascade.
        const templatesRoot = path.join(fakeHome(), '.pzstudio', 'templates');
        for (const repo of [
            'pzstudio-template-project',
            'pzstudio-template-mod',
            'pzstudio-template-workshop',
            'pzstudio-template-language',
        ]) {
            const cache = path.join(templatesRoot, 'escapepz', repo);
            fs.mkdirSync(path.join(cache, '.git'), { recursive: true });
            fs.writeFileSync(path.join(cache, 'seeded.txt'), 'cache');
        }

        const L1 = recordingLogger();
        setLogger(L1.logger);
        setVerbose(true);

        const V2 = recordingLogger();
        // No templateTransport override: the host default transport is
        // constructed with the instance logger (§12), so transport-owned
        // emissions must also land in V2.
        const studio = createPzStudio({ logger: V2.logger });
        const proj = makeProjectDir('Engine Update');
        await studio.run('update', [], {
            flags: ['--verbose', '--project', proj],
        });

        const has = (method: string, fragment: string) =>
            V2.calls.some(
                (c) =>
                    c.method === method && String(c.message).includes(fragment),
            );
        // Config-read verboses (readGlobalConfig inside resolveTemplateDir):
        expect(has('verbose', 'Reading global config from:')).toBe(true);
        expect(has('verbose', 'Resolved cacheDir:')).toBe(true);
        expect(has('verbose', 'Resolved legacyDir:')).toBe(true);
        // Transport-tier emissions (GitTransport refresh + download):
        expect(has('info', '- Refreshing template cache at')).toBe(true);
        expect(has('warn', 'git fetch failed')).toBe(true);
        expect(
            has('warn', 'Failed to refresh template cache. Re-cloning...'),
        ).toBe(true);
        expect(has('info', '- Cloning template from https://')).toBe(true);
        // resolveTemplateDir fallback emissions:
        expect(has('warn', "Failed to clone template from 'https://")).toBe(
            true,
        );
        expect(has('warn', 'Falling back to offline legacy template for')).toBe(
            true,
        );
        // Cold-cache bootstrap emission (bootstrapLegacyTemplates):
        expect(has('info', '- Bootstrapping legacy templates')).toBe(true);
        // The command's own aggregate emission:
        expect(has('info', 'All template caches refreshed successfully!')).toBe(
            true,
        );

        // The legacy slot received NOTHING.
        expect(L1.calls).toEqual([]);
    });

    it('mirror pin: legacy runCLI(list) routes the same helper-layer emissions to the legacy slot', async () => {
        const proj = makeLegacyShapeProject('Legacy List');
        const L1 = recordingLogger();
        setLogger(L1.logger);
        setVerbose(true);

        await runCLI('list', [], { flags: ['--verbose', '--project', proj] });

        const has = (method: string, fragment: string) =>
            L1.calls.some(
                (c) =>
                    c.method === method && String(c.message).includes(fragment),
            );
        expect(has('warn', '[MIGRATION]')).toBe(true);
        expect(has('verbose', "Mod 'my_mod' defaulting poster to:")).toBe(true);
        expect(has('log', 'my_mod')).toBe(true);
    });
});
