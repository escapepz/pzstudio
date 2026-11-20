/**
 * Pure watch helpers shared by the CLI watch command, the api surface and
 * the tests. Kept free of any watcher library import so hosts that consume
 * the api (the esbuild-bundled extension) never pull a native watcher into
 * their bundle — each host wires its own watcher and only borrows the
 * decision logic from here.
 */
import { relative, sep } from 'path';
import type {
    BuildVariant,
    MaterializeMode,
    ProjectBuildTarget,
} from '@pzstudio/core';
import { CliError } from './errors';
import { CliUsageError } from './parser';
import type { MaterializationResolution } from './linkStep';

/** How long file-system events are collected before one sync pass runs. */
export const WATCH_DEBOUNCE_MS = 300;

/** Watch refuses copy-mode deployment — never silently forced to symlink. */
export const ERR_WATCH_COPY_MODE_UNSUPPORTED =
    'ERR_WATCH_COPY_MODE_UNSUPPORTED';

/**
 * Parses the shared `--materialize=<symlink|copy>` value flag. `undefined`
 * passes through (no per-invocation override); anything else is a usage
 * error naming the flag — same exit-2 semantics and message style as the
 * parse-stage enum check on --transport (d11-F8: the handler path must not
 * downgrade an invalid enum value to a runtime error). Shared by build and
 * watch.
 */
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

/**
 * Fail fast: `watch` refuses to start when a deployment target exists and
 * the effective materialize mode is 'copy' (expert contract, 2026-11-12
 * decision 3). A debounced full reconcile after every watched change is
 * heavy and maximizes Windows file-lock collisions while the game runs,
 * and silently forcing 'symlink' would override explicit user config —
 * so the command refuses instead. 'skip' and 'symlink' pass through.
 */
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

/**
 * Pure: parcel-watcher ignore globs for the engine's write root and — when
 * the deployment root sits INSIDE the watched project — the deployment
 * root too (a junction inside the project surfaces the engine's writes at
 * the deployment path; watching them would feed the engine its own writes
 * through the link). Roots outside the project never deliver events, so
 * they need no glob. Returns undefined when nothing inside the project is
 * ignorable.
 */
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

/**
 * Pure: target flags and the project.json `build.target` to synced
 * variants. Unlike `build` (main only by default), watch syncs BOTH outputs
 * unless told otherwise — a development session wants the dev_branch live
 * and the packaging output current. Explicit flags always win; with no
 * flag, a set `build.target` steers the default ('production' → main,
 * 'development' → development, 'both' → both) and an unset target keeps
 * both.
 */
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

/**
 * Pure: should the watcher skip a path? Skips the output directory (watching
 * it would feed the engine its own writes), the deployment root when it
 * sits inside the project (same loop, surfaced through the junction), and
 * every dot segment (.git, .template-mod, ...) — except the rule files
 * .gitignore and .pzstudioignore: a rule-file change steers the ignore
 * rules, and a mod-scoped one must reach the engine, whose classifyDelta
 * re-baselines the owning mod. LAST, `extraIgnored` — the host's matcher
 * over the ROOT-level .gitignore/.pzstudioignore rules, built by the caller
 * — is consulted as the final drop-condition on the project-relative path
 * (the same `rel` this function computes, platform separators; the core
 * matcher folds them itself): the rails above always decide their own
 * subtrees first, so a rule only ever adds drops outside them and is never
 * the thing keeping them safe.
 */
export function isWatchPathIgnored(
    projectPath: string,
    outDir: string,
    target: string,
    deploymentRoot?: string,
    extraIgnored?: (rel: string) => boolean,
): boolean {
    const rel = relative(projectPath, target);
    if (rel === '') return false; // the watched root itself
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
