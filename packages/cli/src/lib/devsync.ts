/**
 * Wires a core BuildSession to the Node host: fresh resolved config, workshop
 * template resolution and per-mod source snapshots on every plan input. ONE
 * core serves `pzstudio watch`, the VS Code extension's auto-sync and the
 * API v2 instance (doc 11 §17 commit 5), so all hosts feed deltas into the
 * same engine.
 */
import { BuildSession, BuildSessionHost } from '@pzstudio/core';
import { NodeFileSystem } from '@pzstudio/platform-node';
import type { TemplateTransport } from '@pzstudio/platform';
import {
    gatherPlanInput,
    legacySettings,
    resolveProjectConfigFor,
    setProjectDir,
} from './helper';
import { resolveTemplateDir } from './templateManager';
import { legacyLogger, engineIo } from './logger';
import { legacyTransport } from './transport';
import type { PzStudioHostSettings, PzStudioLogger } from './invocation';

export interface DevSyncOptions {
    /**
     * Overrides workshop template resolution (tests inject a fixture
     * template directory; production resolves the configured template).
     */
    workshopTemplateDir?: string;
    /** Silence the built-in log forwarding (the host renders messages). */
    quiet?: boolean;
}

/**
 * Explicit dependencies for the DevSync core (doc 11 §17 commit 5, R1).
 * `settings` and `templateTransport` may be plain values or accessors: the
 * core evaluates them per plan input, preserving the freshness the ambient
 * readers had (settings/transport changes between applies are picked up)
 * without ever touching an ambient context or a legacy anchor. The logger
 * is the session's sink: BuildSession host.log reports route through it,
 * and so does every plan-input emission — the io scope (doc 11 §17
 * commit 6, Appendix C) threads the same logger through
 * resolveProjectConfigFor, resolveTemplateDir and the transport sink.
 */
export interface DevSyncCoreDeps {
    /** Host settings layers for plan-input resolution; undefined = no host layer. */
    settings?: PzStudioHostSettings | (() => PzStudioHostSettings | undefined);
    /** Session logger (host.log forwarding and plan-input emissions). */
    logger: PzStudioLogger;
    /** Template transport for plan-input template resolution. */
    templateTransport: TemplateTransport | (() => TemplateTransport);
}

/** Resolves a `value | accessor` dependency at the moment of use. */
function resolveDep<T>(dep: T | (() => T)): T {
    return typeof dep === 'function' ? (dep as () => T)() : dep;
}

/**
 * Creates a sync session for ONE explicit project directory. The core owns
 * its project path: plan-input resolution walks upward from it, outdir
 * tiers resolve against it, and nothing reads an ambient invocation
 * context or the legacy project anchor (R1) — it stays lock-free, correct
 * next to an active engine invocation.
 */
export function createDevSyncCore(
    projectPath: string,
    deps: DevSyncCoreDeps,
    options: DevSyncOptions = {},
): BuildSession {
    const host: BuildSessionHost = {
        fs: new NodeFileSystem(),
        getPlanInput: async () => {
            const settings = resolveDep(deps.settings);
            const io = { logger: deps.logger };
            const config = resolveProjectConfigFor(projectPath, settings, io);
            if (!config) {
                throw new Error(
                    'You must execute this command within a project directory!',
                );
            }
            const workshopTemplateDir =
                options.workshopTemplateDir ??
                resolveTemplateDir('workshop', {
                    settings,
                    templateTransport: resolveDep(deps.templateTransport),
                    logger: deps.logger,
                });
            return gatherPlanInput(projectPath, config, workshopTemplateDir);
        },
        log: options.quiet
            ? undefined
            : (level, message) => {
                  if (level === 'warn') deps.logger.warn(message);
                  else if (level === 'verbose') deps.logger.verbose?.(message);
                  else deps.logger.info(message);
              },
    };
    return new BuildSession(host);
}

/**
 * Shared §13 composition: the anchor side effect plus the core with the
 * RAW legacy settings/transport accessors and the given emission target.
 */
function createDevSyncWithLogger(
    projectPath: string,
    options: DevSyncOptions,
    logger: PzStudioLogger,
): BuildSession {
    setProjectDir(projectPath);

    return createDevSyncCore(
        projectPath,
        {
            settings: legacySettings,
            logger,
            templateTransport: legacyTransport,
        },
        options,
    );
}

/**
 * Legacy facade export (§13): observable side effects preserved — the CLI
 * project dir anchor is set for the session's lifetime because relative
 * outdirs in project.json and the vs-code settings bridge resolve against
 * it (the same contract every other legacy consumer relies on) — then the
 * session delegates to the explicit core composing RAW legacy deps per
 * apply (ambient-blind accessors, never the engine lock). A concurrent v2
 * invocation's context is never inherited. Published signature and
 * raw-legacy default are frozen: the engine's own watch command supplies
 * its invocation logger through the internal engine path below, never by
 * widening this facade.
 */
export function createDevSync(
    projectPath: string,
    options: DevSyncOptions = {},
): BuildSession {
    return createDevSyncWithLogger(projectPath, options, legacyLogger());
}

/**
 * INTERNAL engine-command path (doc 11 §12/§13 — not re-exported from
 * `@pzstudio/cli/api`): the §13 facade composition with ONLY the emission
 * target swapped for the context-aware engineIo() logger, so the watch
 * command's plan-input emissions follow the active invocation logger.
 * Settings/transport stay raw legacy and the anchor side effect is
 * preserved; ambient awareness enters only through this explicit engine
 * caller.
 */
export function createDevSyncForEngine(
    projectPath: string,
    options: DevSyncOptions = {},
): BuildSession {
    return createDevSyncWithLogger(projectPath, options, engineIo().logger);
}

/** Re-exported so hosts can build deltas without touching core internals. */
export type {
    BuildSession,
    BuildVariant,
    FileDelta,
    SessionApplyResult,
} from '@pzstudio/core';
