import type { IVsCodeSettings } from '@pzstudio/core';
import type { TemplateTransport } from '@pzstudio/platform';

export interface PzStudioLogger {
    log(message: string): void;
    info(message: string): void; // progress
    warn(message: string): void; // warning
    error(error: string | Error): void; // failure
    verbose?(message: string): void; // debug (optional; engine default sink falls back to stderr)
    clear?(): void; // optional; still unused by the engine
}

export type PzStudioSettingsLayer = IVsCodeSettings;

export interface PzStudioHostSettings {
    workspace?: PzStudioSettingsLayer;
    user?: PzStudioSettingsLayer;
}

export interface PzStudioSettingsContext {
    projectDir?: string;
}

export type PzStudioSettingsProvider = (
    context: PzStudioSettingsContext,
) => PzStudioHostSettings | undefined;

export interface IoScope {
    logger: PzStudioLogger;
}

export type InteractionMode = 'interactive' | 'non-interactive' | 'embedded';

export interface InvocationDefaults {
    logger: PzStudioLogger;
    templateTransport: TemplateTransport; // received fully resolved
}

export interface InvocationInputs extends InvocationDefaults {
    settingsProvider?: PzStudioSettingsProvider | PzStudioHostSettings;
    projectDir?: string;
    interactionMode: InteractionMode;
}

export interface InvocationContext {
    logger: PzStudioLogger;
    settings: PzStudioHostSettings | undefined;
    templateTransport: TemplateTransport;
    projectDir: string | undefined;
    interactionMode: InteractionMode;
    verbose: boolean;
    quiet: boolean;
    debug: boolean;
    invocationOptions: Record<string, string | boolean | undefined>;
    anchor: string | undefined;
}

export interface LegacyFacadeAccessors {
    legacyLogger(): PzStudioLogger;
    legacySettings(): PzStudioHostSettings | undefined;
    legacyTransport(): TemplateTransport;
    legacyDiscoveryStart(): string | undefined;
    legacyProjectDir(): string;
}

let activeContext: InvocationContext | undefined;

export function getActiveInvocationContext(): InvocationContext | undefined {
    return activeContext;
}

export interface InstalledInvocationContext {
    context: InvocationContext;
    restore(): void;
}

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

let engineLockTail: Promise<unknown> = Promise.resolve();

export function withEngineLock<T>(body: () => Promise<T>): Promise<T> {
    const result = engineLockTail.then(body, body);
    engineLockTail = result.then(
        (): undefined => undefined,
        (): undefined => undefined,
    );
    return result;
}
