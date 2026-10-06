/**
 * InvocationContext machinery for API v2 (docs/vscode-extension/11 §8,
 * Appendix B). This module owns the context types, the active-context
 * storage with its install/restore helper and the engine lock primitive.
 *
 * Import direction (normative, §8.0): it imports ONLY @pzstudio/core and
 * @pzstudio/platform — never a state-owner module (helper.ts / logger.ts /
 * transport.ts / args.ts / interaction.ts) — so the presence-branched
 * readers can import it without creating a cycle. Concrete defaults and
 * raw legacy accessors live with their state owners; this module only
 * RECEIVES fully-resolved values, it never constructs a default.
 */

import type { IVsCodeSettings } from '@pzstudio/core';
import type { TemplateTransport } from '@pzstudio/platform';

/**
 * Semantic host logger — structurally identical to the legacy ILogger.
 * Stream contract unchanged: stdout carries command data, stderr carries
 * progress, warnings, diagnostics and errors.
 */
export interface PzStudioLogger {
    log(message: string): void; // data
    info(message: string): void; // progress
    warn(message: string): void; // warning
    error(error: string | Error): void; // failure
    verbose?(message: string): void; // debug (optional; engine default sink falls back to stderr)
    clear?(): void; // optional; still unused by the engine
}

/**
 * One host settings layer. Domain-neutral alias for the v2 public surface;
 * structurally and semantically identical to the core `IVsCodeSettings`.
 * Core is NOT refactored for this naming concern; the legacy bridge keeps
 * using the core name.
 */
export type PzStudioSettingsLayer = IVsCodeSettings;

/**
 * One host settings snapshot — the same data the CLI merges today
 * (workspace over user over ~/.pzstudio/config.json). Host-generic: the
 * names describe layers, not VS Code.
 */
export interface PzStudioHostSettings {
    workspace?: PzStudioSettingsLayer;
    user?: PzStudioSettingsLayer;
}

/**
 * Resource hint passed to the settings provider. Host-neutral on purpose —
 * a plain absolute fsPath-like string, never a vscode.Uri.
 */
export interface PzStudioSettingsContext {
    projectDir?: string;
}

/**
 * Called exactly once per operation, AFTER parsing, with the EFFECTIVE
 * project the command will target (§8.1/§10) — the parsed -C/--project
 * flag included. A `undefined` result means "no host layer".
 */
export type PzStudioSettingsProvider = (
    context: PzStudioSettingsContext,
) => PzStudioHostSettings | undefined;

/**
 * How the current invocation may talk to the user. Same union as
 * interaction.ts's, re-declared here as a context-pure type so this module
 * never imports a state-owner module; the two are structurally compatible.
 */
export type InteractionMode = 'interactive' | 'non-interactive' | 'embedded';

/**
 * Pure defaults carrier — invocation.ts only RECEIVES these values, it
 * never constructs them. The real default engine logger is owned by
 * logger.ts; the real host-default TemplateTransport is owned by
 * transport.ts; the front doors (cli.ts / studio.ts) compose fully-
 * resolved InvocationInputs from instance/call values ?? those owners
 * (§8.1).
 */
export interface InvocationDefaults {
    logger: PzStudioLogger; // received fully resolved
    templateTransport: TemplateTransport; // received fully resolved
}

/**
 * What a caller (v2 instance or legacy facade) brings to one run. logger
 * and templateTransport arrive ALREADY RESOLVED (composition in cli.ts /
 * studio.ts — §8.1); the settings PROVIDER travels unresolved; it is
 * invoked after parsing with the effective project (§8.1).
 */
export interface InvocationInputs extends InvocationDefaults {
    /** Unresolved at install time; a plain PzStudioHostSettings is
     *  accepted and internally wrapped as a context-ignoring provider (§10). */
    settingsProvider?: PzStudioSettingsProvider | PzStudioHostSettings;
    /** undefined → the discovery tier falls to process.cwd(). */
    projectDir?: string;
    /** 'embedded' for both the v2 and the legacy embedded library shape. */
    interactionMode: InteractionMode;
}

/**
 * Installed BEFORE parse (base), completed after parse (settings +
 * runtime fields). Rule R0 (§8.0): the installed context is
 * self-contained — logger/transport were resolved at composition and are
 * received, never defaulted here; readers NEVER fall through per-field to
 * legacy slots; they branch on context presence only.
 */
export interface InvocationContext {
    /** Always present (received resolved). */
    logger: PzStudioLogger;
    /** Resolved post-parse; undefined = no host layer. */
    settings: PzStudioHostSettings | undefined;
    /** Always present (received resolved). */
    templateTransport: TemplateTransport;
    /** Per-call ?? factory default (input tier). */
    projectDir: string | undefined;
    interactionMode: InteractionMode;
    /**
     * Runtime fields, filled from parsed options inside the lifecycle
     * (§8.1). On the legacy path the same values are additionally written
     * through to the legacy slots (§13.1); on the v2 path they live on the
     * context only.
     */
    verbose: boolean;
    quiet: boolean;
    debug: boolean;
    invocationOptions: Record<string, string | boolean | undefined>;
    /** parsed --project ?? projectDir.
     *  effectiveProject = anchor ?? process.cwd() — the settings
     *  provider's context. */
    anchor: string | undefined;
}

/**
 * Rule R1 (§8.0): raw, ambient-blind accessors for legacy non-engine
 * wrappers. They read the legacy slots DIRECTLY and bypass the active
 * context — a legacy DevSync apply, doctor run, template op or modinfo
 * default-arg next to an active v2 run composes exclusively from these.
 * Discovery START and resolved PROJECT ROOT are two distinct operations
 * and are never collapsed.
 *
 * Type-level contract only: the concrete accessors are exported by the
 * state-owner modules that own the raw state (logger.ts → legacyLogger,
 * helper.ts → legacySettings / legacyDiscoveryStart / legacyProjectDir,
 * transport.ts → legacyTransport) and land with them.
 */
export interface LegacyFacadeAccessors {
    /** externalLogger ?? raw stdout/stderr sink. */
    legacyLogger(): PzStudioLogger;
    /** The two vscode slots, raw. */
    legacySettings(): PzStudioHostSettings | undefined;
    /** activeTransport ?? host default. */
    legacyTransport(): TemplateTransport;
    /** projectRootAnchor ?? externalProjectDir. */
    legacyDiscoveryStart(): string | undefined;
    /**
     * The existing projectDir() algorithm over raw state ONLY:
     * legacyDiscoveryStart() → walk upward to the nearest project.json →
     * fail-closed with the same structured error. NEVER activeContext.
     */
    legacyProjectDir(): string;
}

/* --------------------------------------------------------------------------
 * Active-context storage (§8.2 property 2: invocation-scoped ambient)
 * ----------------------------------------------------------------------- */

let activeContext: InvocationContext | undefined;

/**
 * The active ambient context while an engine invocation is installed, else
 * undefined. Presence-branched readers (§8.0 R0) branch on exactly this —
 * never on per-field nullish checks against legacy slots.
 */
export function getActiveInvocationContext(): InvocationContext | undefined {
    return activeContext;
}

export interface InstalledInvocationContext {
    /** The installed base context; runtime fields are filled from parsed
     *  options inside the lifecycle (§8.1). */
    context: InvocationContext;
    /** Restores the previous ambient; called in the lifecycle's finally. */
    restore(): void;
}

/**
 * Installs a self-contained base context for one run lifecycle and returns
 * its restore. logger/templateTransport arrive fully resolved via
 * InvocationDefaults; settings stay unresolved (resolved post-parse with
 * the effective project, §8.1); runtime fields start neutral and are
 * filled from parsed options inside the lifecycle. Nothing is sticky:
 * restore() puts back exactly the previous ambient.
 */
export function installInvocationContext(
    inputs: InvocationInputs,
): InstalledInvocationContext {
    const previous = activeContext;
    const context: InvocationContext = {
        logger: inputs.logger,
        settings: undefined,
        templateTransport: inputs.templateTransport,
        projectDir: inputs.projectDir,
        interactionMode: inputs.interactionMode,
        verbose: false,
        quiet: false,
        debug: false,
        invocationOptions: {},
        anchor: undefined,
    };
    activeContext = context;
    return {
        context,
        restore(): void {
            activeContext = previous;
        },
    };
}

/* --------------------------------------------------------------------------
 * Engine invocation lock (§9: FIFO promise chain, process-wide)
 * ----------------------------------------------------------------------- */

let engineLockTail: Promise<unknown> = Promise.resolve();

/**
 * Runs `body` under the process-wide engine invocation lock: overlapping
 * engine invocations queue FIFO instead of racing (§9 — the one
 * intentional behavior change of the migration; all sequential/user-visible
 * behavior is preserved). The lock spans the ENTIRE §8.1 lifecycle.
 * Non-engine operations (DevSync applies, doctor, template ops) must not
 * take it — R1 keeps them lock-free. A rejected body neither stalls the
 * chain nor silences the caller's error.
 */
export function withEngineLock<T>(body: () => Promise<T>): Promise<T> {
    const result = engineLockTail.then(body, body);
    engineLockTail = result.then(
        (): undefined => undefined,
        (): undefined => undefined,
    );
    return result;
}
