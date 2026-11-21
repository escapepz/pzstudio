import * as vscode from 'vscode';

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
