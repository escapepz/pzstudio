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
import { resolveModInfoTargets as resolveModInfoTargetsIn } from './helper';

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
    };
}
