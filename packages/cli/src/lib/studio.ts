/**
 * API v2 — the createPzStudio instance API (doc 11 §7, commits 4/6). One
 * host context: project default, logger, settings and template transport
 * are instance-owned inputs; every run() feeds the same locked engine
 * lifecycle the legacy facade uses (§8.1), and the non-engine operations
 * (createDevSync / runProjectDoctor / resolveModInfoTargets) run through
 * the explicit cores with instance dependencies only — outside the engine
 * lock, touching no legacy anchor/settings/logger/transport slot (§8.0
 * R0/R1). Every v2-reachable emission routes through the instance logger:
 * the lifecycle via the ambient context, the non-engine plan inputs via
 * the explicit io scopes threaded since commit 6 (Appendix C).
 */

import { resolve } from 'path';
import type { TemplateTransport } from '@pzstudio/platform';
import type { DoctorReport } from '@pzstudio/core';
import { defaultEngineLogger } from './logger';
import { hostDefaultTransport } from './transport';
import {
    installInvocationContext,
    withEngineLock,
    type InvocationInputs,
    type PzStudioHostSettings,
    type PzStudioLogger,
    type PzStudioSettingsProvider,
} from './invocation';
import { runInvocationLifecycle, type LifecycleFacade } from './cli';
import { createDevSyncCore, DevSyncOptions, BuildSession } from './devsync';
import { runProjectDoctorCore, ProjectDoctorOptions } from './doctor';
import {
    resolveProjectConfigFor,
    resolveModInfoTargets as resolveModInfoTargetsIn,
} from './helper';
import { CliError } from './errors';

/**
 * Public v2 type surface (§7). The pure types are owned by invocation.ts
 * (context-pure, doc 11 commit 1) and re-exported here under the public
 * names.
 */
export type {
    PzStudioLogger,
    PzStudioHostSettings,
    PzStudioSettingsLayer,
    PzStudioSettingsContext,
    PzStudioSettingsProvider,
} from './invocation';
export type { BuildSession, DevSyncOptions } from './devsync';
export type { ProjectDoctorOptions } from './doctor';
export type { DoctorReport };

export interface PzStudioOptions {
    /**
     * Optional default project discovery start (-C semantics) for calls
     * that omit projectDir. NOT an anchor: discovery still walks up and
     * fails closed; project-less commands ignore it.
     */
    projectDir?: string;
    /** Default: the real default engine logger owned by logger.ts. */
    logger?: PzStudioLogger;
    /** A plain snapshot is accepted and wrapped as a context-ignoring
     *  provider (§10); a provider is invoked exactly once per run, after
     *  parsing, with the effective project. Default: no host layer. */
    settings?: PzStudioHostSettings | PzStudioSettingsProvider;
    /** Default: the real host-default transport owned by transport.ts
     *  (git if available, else fetch — materialized lazily), constructed
     *  with the instance logger so its emissions land in the instance's
     *  sink (doc 11 §12/§17 commit 6). */
    templateTransport?: TemplateTransport;
}

export interface PzRunOptions {
    /** Same contract as RunCLIOptions.flags. */
    flags?: string[];
    /**
     * Explicit project discovery start for THIS invocation (wins over the
     * factory default; loses to a parsed --project flag).
     */
    projectDir?: string;
}

export interface PzStudio {
    /**
     * Run a CLI command through the shared parse/validate/execute engine.
     * Same embedded contract as runCLI: never prompts, throws errors, no
     * process.exit, no argv mutation.
     */
    run(
        command: string,
        args?: string[],
        options?: PzRunOptions,
    ): Promise<void>;

    /**
     * Long-lived per-project sync session; reads settings via the
     * instance provider (with the session's projectDir) on every plan
     * input; logs via the instance logger. Touches no legacy state and
     * never takes the engine lock.
     */
    createDevSync(projectDir: string, options?: DevSyncOptions): BuildSession;

    /**
     * Full diagnostics for one project — explicit context, no anchor
     * save/restore, resolved once with the given projectDir. Same
     * DoctorReport; lock-free.
     */
    runProjectDoctor(
        projectDir: string,
        options?: ProjectDoctorOptions,
    ): Promise<DoctorReport>;

    /**
     * Branch folders of `modId` under `projectDir` that should carry a
     * mod.info (the existing helper with the implicit baseDir removed).
     */
    resolveModInfoTargets(modId: string, projectDir: string): string[];

    /**
     * Resolves the effective build output directory for ONE project —
     * the same five-tier resolution the DevSync plan input and `build`
     * use: project.json outdir (against the project root) > workspace
     * host layer > user host layer > global CLI config > default.
     *
     * A current resolved-configuration reader: it reads the instance's
     * settings provider exactly once with the given projectDir and
     * threads the instance logger for the resolver's emissions
     * ([MIGRATION] warns, defaulting verboses). The result is a fresh
     * read at call time — NOT a handle on a running BuildSession's
     * baseline, and not synchronized with one.
     *
     * Synchronous, lock-free, touches no legacy state (R0/R1). It
     * performs the config-resolution step of a plan input ONLY — no
     * template resolution, no source snapshots, no DevSync session.
     *
     * Failure contract (fail closed): throws exactly what the
     * config-resolution step of the session's first plan input would
     * throw for the same directory — the structured no-project CliError
     * when no project.json exists at or above `projectDir`, the parse
     * error for corrupt JSON, and the validation error when project.json
     * is invalid. A missing or invalid resolved outdir additionally
     * throws rather than returning an unchecked optional. Returns an
     * absolute, platform-native path (path.resolve semantics).
     *
     * Pass the same projectDir string the session was created with. The
     * result is the OUTPUT ROOT (the outdir tier), not a per-variant
     * folder.
     */
    resolveOutDir(projectDir: string): string;
}

/**
 * §10: a plain PzStudioHostSettings snapshot is accepted and internally
 * wrapped as a context-ignoring provider; a function travels as-is;
 * undefined = no host layer.
 */
function toSettingsProvider(
    settings?: PzStudioHostSettings | PzStudioSettingsProvider,
): PzStudioSettingsProvider | undefined {
    if (!settings) return undefined;
    if (typeof settings === 'function') return settings;
    return () => settings;
}

/**
 * The v2 facade behavior of the shared lifecycle: settings resolve exactly
 * once post-parse with the EFFECTIVE project — parsed --project (resolved
 * exactly as the anchor will be) ?? per-call ?? factory ?? cwd (§10/§11) —
 * and the runtime values are never written through to the legacy slots
 * (R0, §13.1 v2 column).
 */
function createV2Facade(
    provider: PzStudioSettingsProvider | undefined,
): LifecycleFacade {
    return {
        resolveSettings: (invocation, ctx) => {
            const options = invocation.options;
            const parsedProject =
                typeof options.project === 'string'
                    ? resolve(options.project)
                    : undefined;
            const effectiveProject =
                parsedProject ?? ctx.projectDir ?? process.cwd();
            ctx.settings = provider
                ? provider({ projectDir: effectiveProject })
                : undefined;
        },
        writeInteractionMode: () => {},
        writeVerbosity: () => {},
        writeAnchor: () => {},
        writeStickyTransport: () => {},
        writeInvocationOptions: () => {},
    };
}

/**
 * Creates one PzStudio host context. The instance holds only its inputs:
 * every run composes fully-resolved InvocationInputs (instance logger ??
 * logger.ts's real default engine logger; instance transport ??
 * transport.ts's real host-default transport — constructed with the
 * instance logger; per-call projectDir ?? factory projectDir; always
 * 'embedded') and enters the same locked lifecycle as runCLI — acquiring
 * the process-wide engine lock, installing a self-contained context for
 * exactly one run, and restoring it in the finally on every path. The
 * non-engine methods delegate to the explicit cores with the instance
 * logger and the instance settings/transport — never a legacy slot, never
 * the engine lock (§13 v2 column).
 */
export function createPzStudio(options?: PzStudioOptions): PzStudio {
    const factory = options ?? {};
    const settingsProvider = toSettingsProvider(factory.settings);
    const instanceLogger = (): PzStudioLogger =>
        factory.logger ?? defaultEngineLogger();

    return {
        run(command, args, runOptions) {
            // Composition (§8.1) — before any engine call, no legacy slot
            // is read (R0).
            const inputs: InvocationInputs = {
                logger: instanceLogger(),
                templateTransport:
                    factory.templateTransport ??
                    hostDefaultTransport({ logger: instanceLogger() }),
                projectDir: runOptions?.projectDir ?? factory.projectDir,
                interactionMode: 'embedded',
                settingsProvider,
            };
            const facade = createV2Facade(settingsProvider);
            return withEngineLock(async () => {
                const installed = installInvocationContext(inputs);
                try {
                    return await runInvocationLifecycle(
                        command,
                        args,
                        { flags: runOptions?.flags },
                        installed.context,
                        facade,
                    );
                } finally {
                    installed.restore();
                }
            });
        },

        createDevSync(projectDir, devOptions) {
            // Per-apply settings freshness (§10): the provider is invoked
            // on every plan input with the session's explicit project —
            // never an ambient and never the legacy slots.
            return createDevSyncCore(
                projectDir,
                {
                    settings: () =>
                        settingsProvider
                            ? settingsProvider({ projectDir })
                            : undefined,
                    logger: instanceLogger(),
                    templateTransport:
                        factory.templateTransport ??
                        hostDefaultTransport({
                            logger: instanceLogger(),
                        }),
                },
                devOptions,
            );
        },

        async runProjectDoctor(projectDir, doctorOptions) {
            // A doctor run is finite: settings resolve exactly once, with
            // the operation's explicit project context (§13 doctor row).
            return await runProjectDoctorCore(projectDir, {
                settings: settingsProvider
                    ? settingsProvider({ projectDir })
                    : undefined,
                logger: instanceLogger(),
                gameBuild: doctorOptions?.gameBuild,
            });
        },

        resolveModInfoTargets(modId, projectDir) {
            return resolveModInfoTargetsIn(modId, projectDir);
        },

        resolveOutDir(projectDir) {
            // The SAME resolver call the DevSync plan input makes
            // (devsync.ts getPlanInput), with the instance provider and
            // instance logger threaded exactly as createDevSync does —
            // one fresh read per call, never an ambient, never the
            // legacy slots, never the engine lock.
            const config = resolveProjectConfigFor(
                projectDir,
                settingsProvider ? settingsProvider({ projectDir }) : undefined,
                { logger: instanceLogger() },
            );
            if (!config) {
                // Unreachable in practice (resolveProjectConfigFor fails
                // closed first); kept for type soundness — fail closed,
                // never guess.
                throw new CliError('No pzstudio project found.', {
                    cause: `Searched from '${projectDir}' up to the filesystem root for a project.json.`,
                    tryHint: `Run 'pzstudio new <title>' to create a project, or point at one with 'pzstudio -C <dir> <command>'.`,
                });
            }
            const outdir = config.outdir;
            // IProjectConfig.outdir is OPTIONAL in its declared type, so
            // the `string` return is earned here, not asserted with `!`.
            // The scope-form getOutDir always yields a non-empty string at
            // runtime (every falsy tier falls through to the default),
            // making this guard unreachable today — but the contract fails
            // closed rather than resting on an unchecked optional.
            if (typeof outdir !== 'string' || outdir.length === 0) {
                throw new CliError(
                    `Failed to resolve the output directory for '${projectDir}'.`,
                    {
                        cause: 'The resolved project configuration has no usable outdir.',
                        tryHint:
                            'Check the outdir tiers: project.json, host settings, ~/.pzstudio/config.json.',
                    },
                );
            }
            return outdir;
        },
    };
}
