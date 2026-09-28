export { runCLI, RunCLIOptions } from './lib/cli';
export { setLogger, ILogger } from './lib/logger';
export {
    resolveModInfoTargets,
    setProjectDir,
    setVsCodeSettings,
} from './lib/helper';
export {
    collectIncludedModIds,
    planBuild,
    resolveBuildOutputPath,
    sanitizeFolderName,
} from '@pzstudio/core';
export type {
    FileOperation,
    ModSourceState,
    PlanBuildInput,
} from '@pzstudio/core';
export { patchModInfoId } from '@pzstudio/core';
export {
    resolveTemplateDir,
    cloneRemoteTemplate,
    scaffoldProject,
} from './lib/templateManager';
export { createDevSync } from './lib/devsync';
export type {
    DevSyncOptions,
    BuildSession,
    BuildVariant,
    FileDelta,
    SessionApplyResult,
} from './lib/devsync';
export {
    resolveWatchVariants,
    isWatchPathIgnored,
    WATCH_DEBOUNCE_MS,
} from './lib/commands/watch';
export {
    setTemplateTransport,
    TemplateTransport,
    GitTransport,
    FetchTransport,
} from './lib/transport';
