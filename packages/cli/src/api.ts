export { runCLI, RunCLIOptions } from './lib/cli';
export { setLogger, ILogger } from './lib/logger';
// Direct logger access for hosts that run long-lived sessions (the
// extension auto-sync reports sync errors through the bridged channel).
export { log, info, warn, verbose } from './lib/logger';
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
export { matchBuildCompatibility, runDoctor } from '@pzstudio/core';
export { summarizeApplyResult } from '@pzstudio/core';
export type {
    Diagnostic,
    DiagnosticModule,
    DiagnosticSeverity,
    DoctorInput,
    DoctorReport,
} from '@pzstudio/core';
export { runProjectDoctor } from './lib/doctor';
export type { ProjectDoctorOptions } from './lib/doctor';
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
} from './lib/watch-shared';
export {
    setTemplateTransport,
    TemplateTransport,
    GitTransport,
    FetchTransport,
} from './lib/transport';
