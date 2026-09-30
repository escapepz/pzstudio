import * as vscode from 'vscode';

export function resolveFlags(command: string): string[] {
    const config = vscode.workspace.getConfiguration('pzstudio');
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
        const target = config.get<string>('build.target');
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
