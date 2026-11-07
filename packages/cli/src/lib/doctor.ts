/**
 * Host-side doctor wiring for Node hosts (the CLI and the VS Code
 * extension, which bundles this API): gathers the inputs the host is
 * responsible for — the effective output directory and the project
 * template cache location — then hands over to the host-blind engine in
 * @pzstudio/core. Diagnostics themselves never live here.
 */
import { join } from 'path';
import { NodeFileSystem, NODE_CAPABILITIES } from '@pzstudio/platform-node';
import { runDoctor, DoctorReport } from '@pzstudio/core';
import {
    getExternalProjectDir,
    getOutDir,
    legacySettings,
    readProjectConfig,
    setProjectDir,
} from './helper';
import { probeTemplateCacheDir } from './templateManager';
import { legacyLogger, engineIo } from './logger';
import type { PzStudioHostSettings, PzStudioLogger } from './invocation';

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
    });
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
