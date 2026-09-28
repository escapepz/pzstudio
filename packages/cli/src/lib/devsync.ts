/**
 * Wires a core BuildSession to the Node host: fresh resolved config, workshop
 * template resolution and per-mod source snapshots on every plan input. ONE
 * factory serves `pzstudio watch` and the VS Code extension's auto-sync, so
 * both hosts feed deltas into the same engine.
 */
import { BuildSession, BuildSessionHost } from '@pzstudio/core';
import { NodeFileSystem } from '@pzstudio/platform-node';
import { gatherPlanInput, resolveProjectConfig, setProjectDir } from './helper';
import { resolveTemplateDir } from './templateManager';
import { log, verbose, warn } from './logger';

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
 * Creates a sync session anchored at a project directory. The CLI project
 * dir anchor is set globally because relative outdirs in project.json and
 * the vs-code settings bridge resolve against it — the same contract every
 * other command path relies on.
 */
export function createDevSync(
    projectPath: string,
    options: DevSyncOptions = {},
): BuildSession {
    setProjectDir(projectPath);

    const host: BuildSessionHost = {
        fs: new NodeFileSystem(),
        getPlanInput: async () => {
            const config = resolveProjectConfig();
            if (!config) {
                throw new Error(
                    'You must execute this command within a project directory!',
                );
            }
            const workshopTemplateDir =
                options.workshopTemplateDir ?? resolveTemplateDir('workshop');
            return gatherPlanInput(projectPath, config, workshopTemplateDir);
        },
        log: options.quiet
            ? undefined
            : (level, message) => {
                  if (level === 'warn') warn(message);
                  else if (level === 'verbose') verbose(message);
                  else log(message);
              },
    };
    return new BuildSession(host);
}

/** Re-exported so hosts can build deltas without touching core internals. */
export type {
    BuildSession,
    BuildVariant,
    FileDelta,
    SessionApplyResult,
} from '@pzstudio/core';
