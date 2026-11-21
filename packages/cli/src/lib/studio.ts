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
import { recordApiSpan, recordApiSpanSync } from './usage';
import {
    distRootOf,
    findProjectRoot,
    resolveProjectConfigFor,
    resolveModInfoTargets as resolveModInfoTargetsIn,
} from './helper';
import { CliError } from './errors';

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
    projectDir?: string;
    logger?: PzStudioLogger;
    settings?: PzStudioHostSettings | PzStudioSettingsProvider;
    templateTransport?: TemplateTransport;
}

export interface PzRunOptions {
    flags?: string[];
    projectDir?: string;
}

export interface PzStudio {
    run(
        command: string,
        args?: string[],
        options?: PzRunOptions,
    ): Promise<void>;

    createDevSync(projectDir: string, options?: DevSyncOptions): BuildSession;

    runProjectDoctor(
        projectDir: string,
        options?: ProjectDoctorOptions,
    ): Promise<DoctorReport>;

    resolveModInfoTargets(modId: string, projectDir: string): string[];

    resolveOutDir(projectDir: string): string;
}

function toSettingsProvider(
    settings?: PzStudioHostSettings | PzStudioSettingsProvider,
): PzStudioSettingsProvider | undefined {
    if (!settings) return undefined;
    if (typeof settings === 'function') return settings;
    return () => settings;
}

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

export function createPzStudio(options?: PzStudioOptions): PzStudio {
    const factory = options ?? {};
    const settingsProvider = toSettingsProvider(factory.settings);
    const instanceLogger = (): PzStudioLogger =>
        factory.logger ?? defaultEngineLogger();

    return {
        run(command, args, runOptions) {
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
            return recordApiSpanSync('devsync.create', projectDir, () =>
                createDevSyncCore(
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
                ),
            );
        },

        async runProjectDoctor(projectDir, doctorOptions) {
            return await recordApiSpan('doctor.api', projectDir, () =>
                runProjectDoctorCore(projectDir, {
                    settings: settingsProvider
                        ? settingsProvider({ projectDir })
                        : undefined,
                    logger: instanceLogger(),
                    gameBuild: doctorOptions?.gameBuild,
                }),
            );
        },

        resolveModInfoTargets(modId, projectDir) {
            return resolveModInfoTargetsIn(modId, projectDir);
        },

        resolveOutDir(projectDir) {
            const config = resolveProjectConfigFor(
                projectDir,
                settingsProvider ? settingsProvider({ projectDir }) : undefined,
                { logger: instanceLogger() },
            );
            if (!config) {
                throw new CliError('No pzstudio project found.', {
                    cause: `Searched from '${projectDir}' up to the filesystem root for a project.json.`,
                    tryHint: `Run 'pzstudio new <title>' to create a project, or point at one with 'pzstudio -C <dir> <command>'.`,
                });
            }
            const discovered = findProjectRoot(projectDir);
            if (!discovered) {
                throw new CliError('No pzstudio project found.', {
                    cause: `Searched from '${projectDir}' up to the filesystem root for a project.json.`,
                    tryHint: `Run 'pzstudio new <title>' to create a project, or point at one with 'pzstudio -C <dir> <command>'.`,
                });
            }
            return distRootOf(discovered);
        },
    };
}
