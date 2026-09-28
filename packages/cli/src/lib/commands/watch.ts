import { relative, sep } from 'path';
import chokidar from 'chokidar';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { hasFlag } from '../args';
import type { BuildVariant, FileDelta } from '@pzstudio/core';
import { projectDir, resolveProjectConfig } from '../helper';
import { info, verbose, warn } from '../logger';
import { createDevSync } from '../devsync';

addHelp(
    'watch',
    `Watch your project and keep your workshop outputs synced while you work.

    The Development Sync Engine re-plans and re-executes the smallest correct
    change: saved files are applied incrementally, mod.info and ignore-rule
    edits re-sync their mod, and project.json edits trigger a full rebuild.

    Usages:
        pzstudio watch               - Syncs both the main and dev_branch outputs.
        pzstudio watch --production  - Syncs only the main workshop output.
        pzstudio watch --development - Syncs only the dev_branch workshop output.
        pzstudio watch --both        - Syncs both workshop outputs.
        pzstudio watch --verbose     - Enable diagnostic output.

    Press Ctrl+C to stop.`,
);

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

export async function watchCmd() {
    const projectConfig = resolveProjectConfig();
    if (!projectConfig) {
        throw new Error(
            'You must execute this command within a project directory!',
        );
    }

    const isProduction = hasFlag('production');
    const isDevelopment = hasFlag('development');
    const isBoth = hasFlag('both');
    if (isProduction && isDevelopment) {
        throw new Error(
            'Conflicting targets selected: Use either --production or --development, not both.',
        );
    }
    if (isBoth && (isProduction || isDevelopment)) {
        throw new Error(
            'Conflicting targets selected: --both cannot be combined with --production or --development.',
        );
    }
    const variants = resolveWatchVariants({
        production: isProduction,
        development: isDevelopment,
        both: isBoth,
    });

    const projectPath = projectDir();
    const outDir = projectConfig.outdir!;
    verbose(`Project root: ${projectPath}`);
    verbose(`Output root: ${outDir}`);
    info(
        `Starting development sync for '${projectConfig.workshop.title}' (${variants.join(' + ')})...`,
    );
    info(`Press Ctrl+C to stop.`);

    const session = createDevSync(projectPath);
    // Initial full build: on failure the session is stopped and the command
    // exits — watching an output that could not be built helps nobody.
    try {
        await session.start(variants);
    } catch (e) {
        await session.stop();
        throw e;
    }

    const pending: FileDelta[] = [];
    let timer: NodeJS.Timeout | undefined;
    const flush = async () => {
        const batch = pending.splice(0, pending.length);
        if (batch.length === 0) return;
        const result = await session.apply(batch);
        for (const message of result.errors) {
            warn(`- ${message}`);
        }
    };
    const schedule = (type: FileDelta['type'], path: string) => {
        pending.push({ type, path });
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            void flush();
        }, WATCH_DEBOUNCE_MS);
    };

    const watcher = chokidar.watch(projectPath, {
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 250,
            pollInterval: 100,
        },
        ignored: (target: string) =>
            isWatchPathIgnored(projectPath, outDir, target),
    });
    watcher.on('add', (p) => schedule('create', p));
    watcher.on('change', (p) => schedule('change', p));
    watcher.on('unlink', (p) => schedule('delete', p));
    // Directory events are skipped on purpose: the game only consumes files,
    // and the sync engine does not materialize empty directories.
    watcher.on('error', (e) => warn(`Watcher error: ${(e as Error).message}`));

    let stopping = false;
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
    });
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        if (timer) clearTimeout(timer);
        await watcher.close();
        await session.stop();
        resolveStopped();
    };
    process.once('SIGINT', () => {
        void shutdown();
    });

    await stopped;
    info(`Development sync stopped.`);
}

registerCommand({
    name: 'watch',
    summary: 'Watch for changes and keep your output directory synced.',
    silent: true,
    run: () => watchCmd(),
});
