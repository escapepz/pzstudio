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
    inspectWorkshopLink,
} from '@pzstudio/platform-node';
import {
    runDoctor,
    DoctorReport,
    resolveBuildOutputPath,
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
import { nodeLinkFs, resolveDistModel, workshopReadMarker } from './linkStep';

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
                readWorkshopRootFromGlobalConfig(),
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
        distModel: workshop?.distModel,
        workshopRootNonLocal: workshop?.workshopRootNonLocal,
    });
}

/**
 * Reads `workshopRoot` straight from the global config file, SILENTLY.
 * `readGlobalConfig()` emits a verbose through the raw legacy sink, which
 * would pollute the R1 mirror contract (exactly one emission per op on
 * threaded paths — caught by cliCores). A corrupt/unreadable config
 * degrades to undefined (factory-default workshop root), the same
 * fail-soft the usage recorder applies to its config read.
 */
function readWorkshopRootFromGlobalConfig(): string | undefined {
    try {
        const raw = readFileSync(getConfigPath(), 'utf-8');
        const parsed = JSON.parse(raw) as { workshopRoot?: string };
        return parsed.workshopRoot;
    } catch {
        return undefined;
    }
}

/**
 * Host-side dist-model inputs for the doctor: the dist-model decision, the
 * per-item workshop-link states (pure reads via the platform-node link
 * manager — the doctor never attaches), the non-local workshop-root flag,
 * and each item's absolute workshop VDF path for the copyable steamcmd
 * hint. Only item dirs that EXIST get a link check; a missing variant has
 * no built item to report on.
 */
export async function resolveDoctorWorkshopInputs(
    projectPath: string,
    config: IProjectConfig,
    workshopRoot?: string,
): Promise<{
    distModel: ReturnType<typeof resolveDistModel>;
    workshopLinks?: WorkshopLinkCheckInput[];
    workshopRootNonLocal?: boolean;
}> {
    const dm = resolveDistModel(resolve(projectPath), {
        outdir: config.outdir,
        workshopRoot,
    });
    const workshopRootNonLocal =
        dm.workshopRoot.startsWith('\\\\') || dm.workshopRoot.startsWith('//');
    if (dm.mode !== 'dist') {
        return { distModel: dm, workshopRootNonLocal };
    }
    const platform =
        process.platform === 'win32' ? ('win32' as const) : ('posix' as const);
    const readMarker = workshopReadMarker(resolve(projectPath));
    const items = (['main', 'development'] as const)
        .map((variant) => resolveBuildOutputPath(config, variant))
        .filter((dir) => existsSync(dir))
        .map((dir) => ({ name: basename(dir), dir }));
    const workshopLinks: WorkshopLinkCheckInput[] = await Promise.all(
        items.map(async ({ name, dir }) => {
            const inspection = await inspectWorkshopLink(
                nodeLinkFs,
                join(dm.workshopRoot, name),
                join(dm.outDir, name),
                { platform, readMarker },
            );
            return {
                item: name,
                // Doctor vocabulary: the cascade's ATTACHABLE (no slot at
                // W) reads as a missing link; its OK_LINK reads as
                // attached-ok.
                state:
                    inspection.state === 'ATTACHABLE'
                        ? 'MISSING_LINK'
                        : inspection.state === 'OK_LINK'
                          ? 'ATTACHED_OK'
                          : inspection.state,
                detail: inspection.detail,
                vdfPath: join(dm.outDir, `${name}.workshop.vdf`),
            };
        }),
    );
    return { distModel: dm, workshopLinks, workshopRootNonLocal };
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
