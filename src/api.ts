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
} from './lib/core/buildplan';
export type {
    FileOperation,
    ModSourceState,
    PlanBuildInput,
} from './lib/core/buildplan';
export { patchModInfoId } from './lib/core/textgen';
export {
    resolveTemplateDir,
    cloneRemoteTemplate,
    scaffoldProject,
} from './lib/templateManager';
export {
    setTemplateTransport,
    TemplateTransport,
    GitTransport,
    FetchTransport,
} from './lib/transport';
