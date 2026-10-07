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
} from '../../packages/cli/src/lib/transport';
import { CliError } from '../../packages/cli/src/lib/errors';
import { setCliIO } from '../../packages/cli/src/lib/parser';
import { getCommand } from '../../packages/cli/src/lib/registry';
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
     * finally.
     */
    async function parkedV2Frame() {
        // Pre-seed the legacy-template bootstrap marker: the one-time
        // bootstrap info emission is routed through the engine tier while a
        // v2 run is active (io-scope threading is migration Commit 6, not
        // this commit) and would otherwise pollute the L2 isolation counts.
        const legacyMarker = path.join(
            (globalThis as any).__PZSTUDIO_FAKE_HOME as string,
            '.pzstudio',
            '.template-legacy',
        );
        fs.mkdirSync(legacyMarker, { recursive: true });
        fs.writeFileSync(path.join(legacyMarker, 'seed.txt'), 'seed');

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
