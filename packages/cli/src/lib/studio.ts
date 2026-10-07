/**
 * API v2 — the createPzStudio instance API (doc 11 §7, commit 4). One host
 * context: project default, logger, settings and template transport are
 * instance-owned inputs, and every run() feeds the same locked engine
 * lifecycle the legacy facade uses (§8.1). R0 (§8.0): the v2 path never
 * reads and never writes a legacy facade slot — "omitted on the instance"
 * is a meaningful state, resolved at composition against the owner defaults
 * (logger.ts's real default engine logger, transport.ts's real host-default
 * transport), never a fallback trigger into the facade.
 *
 * The remaining §7 methods (createDevSync / runProjectDoctor /
 * resolveModInfoTargets) land with the explicit-context cores (doc 11 §17
 * commits 5/6) and are intentionally absent here. Dead code for consumers
 * until the extension migrates (commit 7).
 */

import { resolve } from 'path';
import type { TemplateTransport } from '@pzstudio/platform';
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
     *  (git if available, else fetch — materialized lazily). */
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
 * transport.ts's real host-default transport; per-call projectDir ??
 * factory projectDir; always 'embedded') and enters the same locked
 * lifecycle as runCLI — acquiring the process-wide engine lock, installing
 * a self-contained context for exactly one run, and restoring it in the
 * finally on every path.
 */
export function createPzStudio(options?: PzStudioOptions): PzStudio {
    const factory = options ?? {};
    return {
        run(command, args, runOptions) {
            // Composition (§8.1) — before any engine call, no legacy slot
            // is read (R0).
            const settingsProvider = toSettingsProvider(factory.settings);
            const inputs: InvocationInputs = {
                logger: factory.logger ?? defaultEngineLogger(),
                templateTransport:
                    factory.templateTransport ?? hostDefaultTransport(),
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
    };
}
