import { relative } from 'path';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { hasFlag } from '../args';
import type { FileDelta } from '@pzstudio/core';
import { projectDir, resolveProjectConfig } from '../helper';
import { info, verbose, warn } from '../logger';
import { createDevSync } from '../devsync';
import { isWatchPathIgnored, resolveWatchVariants } from '../watch-shared';

type ParcelWatcher = typeof import('@parcel/watcher');

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

export {
    isWatchPathIgnored,
    resolveWatchVariants,
    WATCH_DEBOUNCE_MS,
} from '../watch-shared';

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
        }, 300);
    };

    // @parcel/watcher — the same watcher engine VS Code's FileSystemWatcher
    // uses, so the CLI and the extension behave identically. Events arrive
    // in batches; the debounce coalesces editor save bursts, replacing
    // chokidar's awaitWriteFinish.
    //
    // Required lazily: the VS Code extension inlines this module through the
    // api surface (the command registry self-registers on import), and a
    // top-level require would crash its activation — the native binding is
    // only resolvable from the CLI package. Only the real watch command ever
    // executes this line.
    const { subscribe } = require('@parcel/watcher') as ParcelWatcher;
    const subscription = await subscribe(
        projectPath,
        (err, events) => {
            if (err) {
                warn(`Watcher error: ${(err as Error).message}`);
                return;
            }
            for (const event of events) {
                if (isWatchPathIgnored(projectPath, outDir, event.path)) {
                    continue;
                }
                // parcel's 'update' is our 'change'; directories pass
                // through as create/delete events and the session decides
                // what they mean (it never writes a directory as a file).
                const type: FileDelta['type'] =
                    event.type === 'update'
                        ? 'change'
                        : event.type === 'delete'
                          ? 'delete'
                          : 'create';
                schedule(type, event.path);
            }
        },
        {
            // Cheaper to drop the output tree natively than to filter its
            // events after delivery (watching our own writes is pure noise).
            ignore: (() => {
                const outRel = relative(projectPath, outDir);
                if (!outRel || outRel.startsWith('..')) {
                    return undefined;
                }
                return [outRel, `${outRel}/**`];
            })(),
        },
    );

    let stopping = false;
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
    });
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        if (timer) clearTimeout(timer);
        await subscription.unsubscribe();
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
