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
    workshopTemplateDir?: string;
    quiet?: boolean;
}

export interface DevSyncCoreDeps {
    settings?: PzStudioHostSettings | (() => PzStudioHostSettings | undefined);
    logger: PzStudioLogger;
    templateTransport: TemplateTransport | (() => TemplateTransport);
}

function resolveDep<T>(dep: T | (() => T)): T {
    return typeof dep === 'function' ? (dep as () => T)() : dep;
}

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

export function createDevSync(
    projectPath: string,
    options: DevSyncOptions = {},
): BuildSession {
    return createDevSyncWithLogger(projectPath, options, legacyLogger());
}

export function createDevSyncForEngine(
    projectPath: string,
    options: DevSyncOptions = {},
): BuildSession {
    return createDevSyncWithLogger(projectPath, options, engineIo().logger);
}

export type {
    BuildSession,
    BuildVariant,
    FileDelta,
    SessionApplyResult,
} from '@pzstudio/core';
