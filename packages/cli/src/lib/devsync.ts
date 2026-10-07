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
import { legacyLogger } from './logger';
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
 * is the session's sink: BuildSession host.log reports route through it
 * (and, from commit 6, the plan-input io scopes too).
 */
export interface DevSyncCoreDeps {
    /** Host settings layers for plan-input resolution; undefined = no host layer. */
    settings?: PzStudioHostSettings | (() => PzStudioHostSettings | undefined);
    /** Session logger (host.log forwarding). */
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
            const config = resolveProjectConfigFor(
                projectPath,
                resolveDep(deps.settings),
            );
            if (!config) {
                throw new Error(
                    'You must execute this command within a project directory!',
                );
            }
            const workshopTemplateDir =
                options.workshopTemplateDir ??
                resolveTemplateDir('workshop', {
                    settings: resolveDep(deps.settings),
                    templateTransport: resolveDep(deps.templateTransport),
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
 * Legacy facade export (§13): observable side effects preserved — the CLI
 * project dir anchor is set for the session's lifetime because relative
 * outdirs in project.json and the vs-code settings bridge resolve against
 * it (the same contract every other legacy consumer relies on) — then the
 * session delegates to the explicit core composing RAW legacy deps per
 * apply (ambient-blind accessors, never the engine lock). A concurrent v2
 * invocation's context is never inherited.
 */
export function createDevSync(
    projectPath: string,
    options: DevSyncOptions = {},
): BuildSession {
    setProjectDir(projectPath);

    return createDevSyncCore(
        projectPath,
        {
            settings: legacySettings,
            logger: legacyLogger(),
            templateTransport: legacyTransport,
        },
        options,
    );
}

/** Re-exported so hosts can build deltas without touching core internals. */
export type {
    BuildSession,
    BuildVariant,
    FileDelta,
    SessionApplyResult,
} from '@pzstudio/core';
