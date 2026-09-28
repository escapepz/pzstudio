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
export {
    setTemplateTransport,
    TemplateTransport,
    GitTransport,
    FetchTransport,
} from './lib/transport';
