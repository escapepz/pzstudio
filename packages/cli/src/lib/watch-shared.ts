/**
 * Pure watch helpers shared by the CLI watch command, the api surface and
 * the tests. Kept free of any watcher library import so hosts that consume
 * the api (the esbuild-bundled extension) never pull a native watcher into
 * their bundle — each host wires its own watcher and only borrows the
 * decision logic from here.
 */
import { relative, sep } from 'path';
import type { BuildVariant } from '@pzstudio/core';

/** How long file-system events are collected before one sync pass runs. */
export const WATCH_DEBOUNCE_MS = 300;

/**
 * Pure: target flags to synced variants. Unlike `build` (main only by
 * default), watch syncs BOTH outputs unless told otherwise — a development
 * session wants the dev_branch live and the packaging output current.
 */
export function resolveWatchVariants(flags: {
    production?: boolean;
    development?: boolean;
    both?: boolean;
}): BuildVariant[] {
    if (flags.both) return ['main', 'development'];
    if (flags.production) return ['main'];
    if (flags.development) return ['development'];
    return ['main', 'development'];
}

/**
 * Pure: should the watcher skip a path? Skips the output directory (watching
 * it would feed the engine its own writes) and every dot segment (.git,
 * .template-mod, ...) — except .pzstudioignore files, which steer the ignore
 * rules and are worth re-syncing on.
 */
export function isWatchPathIgnored(
    projectPath: string,
    outDir: string,
    target: string,
): boolean {
    const rel = relative(projectPath, target);
    if (rel === '') return false; // the watched root itself
    if (rel.startsWith('..')) return true; // outside the project
    const outRel = relative(projectPath, outDir);
    if (
        !outRel.startsWith('..') &&
        (rel === outRel || rel.startsWith(outRel + sep))
    ) {
        return true;
    }
    return rel
        .split(sep)
        .some(
            (segment) =>
                segment.startsWith('.') && segment !== '.pzstudioignore',
        );
}
