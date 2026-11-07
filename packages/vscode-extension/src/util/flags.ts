import * as vscode from 'vscode';

/**
 * `explicitBuildTarget` (a VS Code task target) replaces — never extends —
 * the pzstudio.build.target setting for `build`: the CLI rejects
 * conflicting target flags (UX-01), so a task asking for development while
 * the setting says production must resolve to exactly `--development`.
 * Only the `build` command reads it; `clean` never emits a target flag.
 *
 * `projectDir` (UX-05) scopes every flag read to the operated project's
 * folder resource, so folder-scoped values apply per project. Without a
 * project context (global update) no resource is passed and no opened
 * folder's values can be borrowed.
 */
export function resolveFlags(
    command: string,
    explicitBuildTarget?: string,
    projectDir?: string,
): string[] {
    const config = vscode.workspace.getConfiguration(
        'pzstudio',
        projectDir ? vscode.Uri.file(projectDir) : undefined,
    );
    const flags: string[] = [];

    if (config.get<boolean>('verbose')) {
        flags.push('--verbose');
    }

    if (command === 'new' || command === 'add') {
        if (config.get<boolean>('offline')) {
            flags.push('--offline');
        }
        if (config.get<boolean>('forceUpdate')) {
            flags.push('--force-update');
        }
    }

    // --symlinks only exists on `new` (junction shared template folders);
    // `add` dropped the no-op flag (ee0855a) and the parser now rejects
    // unknown options, so it must not be sent for other commands.
    if (command === 'new' && config.get<boolean>('useSymlinks')) {
        flags.push('--symlinks');
    }

    if (command === 'build') {
        const target =
            explicitBuildTarget ?? config.get<string>('build.target');
        if (target === 'production') {
            flags.push('--production');
        } else if (target === 'development') {
            flags.push('--development');
        } else if (target === 'both') {
            flags.push('--both');
        }
    }

    return flags;
}
