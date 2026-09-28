/**
 * @pzstudio/core — browser-safe domain logic for PZ Studio.
 *
 * Everything exported here is free of I/O and Node builtins: it takes plain
 * data (or injected contracts from @pzstudio/platform) in and returns data
 * out. Host packages (cli, vscode-extension) are thin adapters on top.
 */
export * from './project';
export * from './schema-version';
export * from './validation';
export * from './modInfoParser';
export * from './textgen';
export * from './buildplan';
export * from './migration';
export * from './constants';
export * from './defaults';
export * from './errors/TemplateResolutionError';
export * from './project-contract';
