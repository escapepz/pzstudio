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
import { legacyLogger } from './logger';
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
 * run is finite); the logger is the run's sink (threaded into the io
 * scopes in commit 6). No anchor, no ambient context.
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
 * supplied settings layers, the template probe reads the supplied layers —
 * no temporary global anchor, no ambient invocation context, lock-free.
 */
export async function runProjectDoctorCore(
    projectPath: string,
    deps: ProjectDoctorCoreDeps,
): Promise<DoctorReport> {
    const settings = resolveDep(deps.settings);

    let outDir: string | undefined;
    try {
        const config = readProjectConfig(join(projectPath, 'project.json'));
        if (config) {
            outDir = getOutDir(config, undefined, {
                projectDir: projectPath,
                settings,
            });
        }
    } catch {
        // An invalid project.json is itself a doctor finding (reported
        // by the engine); output-directory checks are skipped for this
        // run.
    }

    let template: { dir: string; name: string } | undefined;
    try {
        template = probeTemplateCacheDir('project', { settings });
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
 * Legacy facade export (§13): the historical save → set project → run →
 * restore anchor dance is preserved exactly — restored on every
 * success/failure path — because this is a library call that must not leak
 * global state into its host (the extension process). The run delegates to
 * the explicit core with RAW legacy deps (ambient-blind, lock-free); a
 * concurrent v2 invocation's context is never inherited.
 */
export async function runProjectDoctor(
    projectPath: string,
    options: ProjectDoctorOptions = {},
): Promise<DoctorReport> {
    const previousProjectDir = getExternalProjectDir();
    setProjectDir(projectPath);
    try {
        return await runProjectDoctorCore(projectPath, {
            settings: legacySettings(),
            logger: legacyLogger(),
            gameBuild: options.gameBuild,
        });
    } finally {
        setProjectDir(previousProjectDir);
    }
}
