import { relative, sep } from 'path';
import type {
    BuildVariant,
    MaterializeMode,
    ProjectBuildTarget,
} from '@pzstudio/core';
import { CliError } from './errors';
import { CliUsageError } from './parser';
import type { MaterializationResolution } from './linkStep';

export const WATCH_DEBOUNCE_MS = 300;

export const ERR_WATCH_COPY_MODE_UNSUPPORTED =
    'ERR_WATCH_COPY_MODE_UNSUPPORTED';

export function parseMaterializeFlag(
    raw: string | undefined,
): MaterializeMode | undefined {
    if (raw === undefined) return undefined;
    if (raw !== 'symlink' && raw !== 'copy') {
        throw new CliUsageError(
            `Invalid --materialize value '${raw}' (expected one of: symlink, copy).`,
        );
    }
    return raw;
}

export function assertWatchMaterializable(
    materialization: MaterializationResolution,
): void {
    if (
        materialization.action !== 'materialize' ||
        materialization.mode !== 'copy'
    ) {
        return;
    }
    throw new CliError(
        `watch cannot deploy in copy mode to '${materialization.outDir}'.`,
        {
            cause: `${ERR_WATCH_COPY_MODE_UNSUPPORTED}: a full reconciled copy after every watched change is heavy and maximizes Windows file-lock (EBUSY/EPERM) collisions while the game runs — and silently switching to a junction would override your explicit "copy" configuration.`,
            tryHint:
                'Set "build": { "materialize": "symlink" } in project.json (or "materialize": "symlink" in ~/.pzstudio/config.json), run one-shot "pzstudio build" instead, or pass --no-materialize to watch dist/ only.',
        },
    );
}

export function watchIgnoreGlobs(
    projectPath: string,
    outDir: string,
    deploymentRoot?: string,
): string[] | undefined {
    const roots = deploymentRoot ? [outDir, deploymentRoot] : [outDir];
    const globs: string[] = [];
    for (const root of roots) {
        const rootRel = relative(projectPath, root);
        if (!rootRel || rootRel.startsWith('..')) continue;
        globs.push(rootRel, `${rootRel}/**`);
    }
    return globs.length > 0 ? globs : undefined;
}

export function resolveWatchVariants(
    flags: {
        production?: boolean;
        development?: boolean;
        both?: boolean;
    },
    configTarget?: ProjectBuildTarget,
): BuildVariant[] {
    if (flags.both) return ['main', 'development'];
    if (flags.production) return ['main'];
    if (flags.development) return ['development'];
    if (configTarget === 'production') return ['main'];
    if (configTarget === 'development') return ['development'];
    return ['main', 'development'];
}

export function isWatchPathIgnored(
    projectPath: string,
    outDir: string,
    target: string,
    deploymentRoot?: string,
    extraIgnored?: (rel: string) => boolean,
): boolean {
    const rel = relative(projectPath, target);
    if (rel === '') return false;
    if (rel.startsWith('..')) return true; // outside the project
    const ignoredRoots = deploymentRoot ? [outDir, deploymentRoot] : [outDir];
    for (const root of ignoredRoots) {
        const rootRel = relative(projectPath, root);
        if (rootRel.startsWith('..') || rootRel === '') continue;
        if (rel === rootRel || rel.startsWith(rootRel + sep)) {
            return true;
        }
    }
    if (
        rel
            .split(sep)
            .some(
                (segment) =>
                    segment.startsWith('.') &&
                    segment !== '.pzstudioignore' &&
                    segment !== '.gitignore',
            )
    ) {
        return true;
    }
    return extraIgnored?.(rel) ?? false;
}
