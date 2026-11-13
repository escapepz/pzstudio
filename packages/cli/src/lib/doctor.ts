/**
 * Host-side doctor wiring for Node hosts (the CLI and the VS Code
 * extension, which bundles this API): gathers the inputs the host is
 * responsible for — the effective output directory and the project
 * template cache location — then hands over to the host-blind engine in
 * @pzstudio/core. Diagnostics themselves never live here.
 */
import { basename, join, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
    NodeFileSystem,
    NODE_CAPABILITIES,
    inspectMaterializeSlot,
} from '@pzstudio/platform-node';
import {
    runDoctor,
    DoctorReport,
    resolveBuildOutputPath,
    computeProjectId,
    copyMarkerPath,
    readCopySlotMarker,
    type IProjectConfig,
    type WorkshopLinkCheckInput,
} from '@pzstudio/core';
import {
    getExternalProjectDir,
    getOutDir,
    legacySettings,
    readProjectConfig,
    setProjectDir,
} from './helper';
import { probeTemplateCacheDir, getConfigPath } from './templateManager';
import { legacyLogger, engineIo } from './logger';
import type { PzStudioHostSettings, PzStudioLogger } from './invocation';
import {
    nodeLinkFs,
    promisesFileSystem,
    resolveMaterialization,
    workshopReadMarker,
    type MaterializationResolution,
} from './linkStep';

export interface ProjectDoctorOptions {
    /**
     * The running game build (e.g. "42.2.0") to check
     * pzBuildCompatibility against. When omitted the check is skipped.
     */
    gameBuild?: string;
}

/**
 * Explicit dependencies for the doctor core (doc 11 §17 commit 5, R1):
 * `settings` may be a snapshot or an accessor (resolved once — a doctor
 * run is finite); the logger is the run's sink, threaded into the plan
 * io scopes (doc 11 §17 commit 6, Appendix C). No anchor, no ambient
 * context.
 */
export interface ProjectDoctorCoreDeps {
    settings?: PzStudioHostSettings | (() => PzStudioHostSettings | undefined);
    logger: PzStudioLogger;
    gameBuild?: string;
}

/** Resolves a `value | accessor` dependency at the moment of use. */
function resolveDep<T>(dep: T | (() => T)): T {
    return typeof dep === 'function' ? (dep as () => T)() : dep;
}

/**
 * Runs the full doctor for one explicit project directory. Invalid
 * project.json or an unreadable global config never throw here — they are
 * exactly the findings doctor reports. The core uses only its explicit
 * dependencies (R1): outdir tiers resolve against projectPath with the
 * supplied settings layers, the template probe reads the supplied layers,
 * and every config/outdir/probe emission routes through the supplied
 * logger's io scope (commit 6, Appendix C) — no temporary global anchor,
 * no ambient invocation context, lock-free.
 */
export async function runProjectDoctorCore(
    projectPath: string,
    deps: ProjectDoctorCoreDeps,
): Promise<DoctorReport> {
    const settings = resolveDep(deps.settings);
    const io = { logger: deps.logger };

    let outDir: string | undefined;
    let workshop:
        | Awaited<ReturnType<typeof resolveDoctorWorkshopInputs>>
        | undefined;
    try {
        const config = readProjectConfig(
            join(projectPath, 'project.json'),
            true,
            io,
        );
        if (config) {
            outDir = getOutDir(config, undefined, {
                projectDir: projectPath,
                settings,
                logger: deps.logger,
            });
            workshop = await resolveDoctorWorkshopInputs(
                projectPath,
                config,
                outDir,
            );
        }
    } catch {
        // An invalid project.json is itself a doctor finding (reported
        // by the engine); output-directory checks are skipped for this
        // run.
    }

    let template: { dir: string; name: string } | undefined;
    try {
        template = probeTemplateCacheDir('project', {
            settings,
            logger: deps.logger,
        });
    } catch {
        // No template configured or unreadable global config: nothing
        // to check.
    }

    return await runDoctor(new NodeFileSystem(), {
        projectDir: projectPath,
        outDir,
        templateDir: template?.dir,
        templateName: template?.name,
        capabilities: NODE_CAPABILITIES,
        gameBuild: deps.gameBuild,
        workshopLinks: workshop?.workshopLinks,
        materialization: workshop?.materialization,
    });
}

/**
 * Host-side materialize inputs for the doctor (dist-always amendment §9):
 * the materialize decision, and the per-item deployment-slot states (pure
 * reads via the platform-node materialize inspector — the doctor never
 * attaches). Only item dirs that EXIST in dist get a slot check; a missing
 * variant has no built item to report on. The machine-level `materialize`
 * key is read SILENTLY from the global config (readGlobalConfig() emits a
 * verbose through the raw legacy sink, which would pollute the R1 mirror
 * contract); a corrupt/unreadable config degrades to undefined.
 */
export async function resolveDoctorWorkshopInputs(
    projectPath: string,
    config: IProjectConfig,
    effectiveOutdir?: string,
): Promise<{
    materialization: MaterializationResolution;
    workshopLinks?: WorkshopLinkCheckInput[];
}> {
    const root = resolve(projectPath);
    const materialization = resolveMaterialization({
        projectRoot: root,
        effectiveOutdir,
        projectMaterialize: config.build?.materialize,
        globalMaterialize: readMaterializeFromGlobalConfig(),
    });
    if (materialization.action !== 'materialize') {
        return { materialization };
    }

    const platform =
        process.platform === 'win32' ? ('win32' as const) : ('posix' as const);
    const readMarker = workshopReadMarker(root);
    const projectId = await computeProjectId(root);
    const distRoot = materialization.distRoot;
    const targetNonLocal =
        materialization.mode === 'symlink' &&
        (materialization.outDir!.startsWith('\\\\') ||
            materialization.outDir!.startsWith('//'));

    const items = (['main', 'development'] as const)
        .map((variant) =>
            resolveBuildOutputPath({ ...config, outdir: distRoot }, variant),
        )
        .filter((dir) => existsSync(dir))
        .map((dir) => ({ name: basename(dir) }));
    const workshopLinks: WorkshopLinkCheckInput[] = await Promise.all(
        items.map(async ({ name }) => {
            const inspection = await inspectMaterializeSlot(
                nodeLinkFs,
                join(materialization.outDir!, name),
                join(distRoot, name),
                {
                    platform,
                    readMarker,
                    readCopyMarker: (slotDir) =>
                        readCopySlotMarker(
                            promisesFileSystem,
                            copyMarkerPath(slotDir),
                        ),
                    copyIdentity: { projectId, itemId: name },
                },
            );
            return {
                item: name,
                // Doctor vocabulary: the inspector's ABSENT (no slot at W)
                // reads as a missing deployment; OK_LINK reads as
                // attached-ok.
                state:
                    inspection.state === 'ABSENT'
                        ? 'MISSING_LINK'
                        : inspection.state === 'OK_LINK'
                          ? 'ATTACHED_OK'
                          : inspection.state,
                detail: inspection.detail,
                vdfPath: join(distRoot, `${name}.workshop.vdf`),
            };
        }),
    );
    return {
        materialization: { ...materialization, targetNonLocal },
        workshopLinks,
    };
}

/**
 * Reads the flat machine-level `materialize` key straight from the global
 * config file, SILENTLY (R1 mirror contract — `readGlobalConfig()` emits a
 * verbose through the raw legacy sink). A corrupt/unreadable config
 * degrades to undefined (the hard default 'symlink' applies).
 */
function readMaterializeFromGlobalConfig(): 'symlink' | 'copy' | undefined {
    try {
        const raw = readFileSync(getConfigPath(), 'utf-8');
        const parsed = JSON.parse(raw) as {
            materialize?: 'symlink' | 'copy';
        };
        return parsed.materialize;
    } catch {
        return undefined;
    }
}

/**
 * Shared §13 composition: the historical save → set project → run →
 * restore anchor dance (restored on every success/failure path — a
 * library call must not leak global state into its host) around the
 * explicit core with RAW legacy settings and the given emission target.
 */
async function runProjectDoctorWithLogger(
    projectPath: string,
    options: ProjectDoctorOptions,
    logger: PzStudioLogger,
): Promise<DoctorReport> {
    const previousProjectDir = getExternalProjectDir();
    setProjectDir(projectPath);
    try {
        return await runProjectDoctorCore(projectPath, {
            settings: legacySettings(),
            logger,
            gameBuild: options.gameBuild,
        });
    } finally {
        setProjectDir(previousProjectDir);
    }
}

/**
 * Legacy facade export (§13): delegates to the explicit core with RAW
 * legacy deps (ambient-blind, lock-free); a concurrent v2 invocation's
 * context is never inherited. Published signature and raw-legacy default
 * are frozen: the engine's own doctor command supplies its invocation
 * logger through the internal engine path below, never by widening this
 * facade.
 */
export async function runProjectDoctor(
    projectPath: string,
    options: ProjectDoctorOptions = {},
): Promise<DoctorReport> {
    return runProjectDoctorWithLogger(projectPath, options, legacyLogger());
}

/**
 * INTERNAL engine-command path (doc 11 §12/§13 — not re-exported from
 * `@pzstudio/cli/api`): the §13 facade composition with ONLY the emission
 * target swapped for the context-aware engineIo() logger, so the doctor
 * command's plan-input emissions follow the active invocation logger.
 * Settings stay raw legacy and the anchor dance is preserved; ambient
 * awareness enters only through this explicit engine caller.
 */
export async function runProjectDoctorForEngine(
    projectPath: string,
    options: ProjectDoctorOptions = {},
): Promise<DoctorReport> {
    return runProjectDoctorWithLogger(projectPath, options, engineIo().logger);
}
