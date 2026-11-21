import { basename } from 'path';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { CliError } from '../errors';
import { extractFlag, hasFlag } from '../args';
import type { FileDelta } from '@pzstudio/core';
import {
    collectIncludedModIds,
    createIgnoreMatcher,
    readIgnoreRulesForDir,
    resolveBuildOutputPath,
    summarizeApplyResult,
} from '@pzstudio/core';
import { distRootOf, projectDir, resolveProjectConfig } from '../helper';
import { readGlobalConfig } from '../templateManager';
import { info, verbose, warn } from '../logger';
import { createDevSyncForEngine } from '../devsync';
import { NodeFileSystem } from '@pzstudio/platform-node';
import {
    assertWatchMaterializable,
    isWatchPathIgnored,
    parseMaterializeFlag,
    resolveWatchVariants,
    watchIgnoreGlobs,
} from '../watch-shared';
import {
    maybeMaterializeBuiltItems,
    resolveMaterialization,
    type MaterializationResolution,
} from '../linkStep';

type ParcelWatcher = typeof import('@parcel/watcher');

addHelp(
    'watch',
    `Watch your project and keep your workshop outputs synced while you work.

    The Development Sync Engine re-plans and re-executes the smallest correct
    change into the project's dist/ output. When an outdir is configured, each
    item is also deployed there — a junction by default ('symlink'); copy
    mode cannot keep up with live edits, so watch refuses it.

    Usages:
        pzstudio watch               - Syncs the outputs selected by project.json build.target (both by default).
        pzstudio watch --production  - Syncs only the main workshop output.
        pzstudio watch --development - Syncs only the dev_branch workshop output.
        pzstudio watch --both        - Syncs both workshop outputs.
        pzstudio watch --no-materialize        - Watch dist/ only; skip deployment.
        pzstudio watch --materialize=copy      - Rejected: watch refuses copy mode.
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
        throw new CliError('No pzstudio project found.');
    }

    const isProduction = hasFlag('production');
    const isDevelopment = hasFlag('development');
    const isBoth = hasFlag('both');
    const variants = resolveWatchVariants(
        {
            production: isProduction,
            development: isDevelopment,
            both: isBoth,
        },
        projectConfig.build?.target,
    );
    const source =
        isProduction || isDevelopment || isBoth
            ? undefined
            : projectConfig.build?.target
              ? 'build.target'
              : undefined;

    const projectPath = projectDir();
    const outDir = distRootOf(projectPath);

    const nodeFs = new NodeFileSystem();
    let ignoreMatcher: ((rel: string) => boolean) | undefined;
    const reloadIgnoreRules = async (): Promise<void> => {
        try {
            ignoreMatcher = createIgnoreMatcher({
                '': await readIgnoreRulesForDir(nodeFs, projectPath),
            }).isIgnored;
        } catch {}
    };
    await reloadIgnoreRules();
    const ignorePredicate = (rel: string): boolean =>
        ignoreMatcher?.(rel) ?? false;
    const materialization: MaterializationResolution = resolveMaterialization({
        projectRoot: projectPath,
        effectiveOutdir: projectConfig.outdir,
        projectMaterialize: projectConfig.build?.materialize,
        globalMaterialize: readGlobalConfig()?.materialize,
        flagMaterialize: parseMaterializeFlag(extractFlag('materialize')),
        noMaterialize: hasFlag('no-materialize'),
    });
    if (materialization.refused) {
        throw new CliError(materialization.refused, {
            tryHint:
                'Set project.json "outdir" to a dedicated directory outside the project (pzstudio new writes "~/Zomboid/Workshop").',
        });
    }
    assertWatchMaterializable(materialization);
    verbose(`Project root: ${projectPath}`);
    verbose(`Output root: ${outDir}`);
    verbose(
        `Deployment: ${
            materialization.action === 'materialize'
                ? materialization.outDir
                : 'disabled (no outdir configured or --no-materialize)'
        }; materialize: ${
            materialization.action === 'materialize'
                ? materialization.mode
                : 'skip'
        }`,
    );
    info(
        `Syncing '${projectConfig.workshop.title}' (${variants.join(' + ')}${source ? ` — ${source}` : ''}) — press Ctrl+C to stop.`,
    );

    const session = createDevSyncForEngine(projectPath);
    try {
        await session.start(variants);
    } catch (e) {
        await session.stop();
        throw e;
    }

    if (materialization.action === 'materialize') {
        const anchoredConfig = { ...projectConfig, outdir: outDir };
        const itemNames = variants
            .filter(
                (variant) =>
                    collectIncludedModIds(projectConfig, variant).length > 0,
            )
            .map((variant) =>
                basename(resolveBuildOutputPath(anchoredConfig, variant)),
            );
        await maybeMaterializeBuiltItems(materialization, itemNames, {
            projectRoot: projectPath,
            backupExisting: hasFlag('backup-existing-workshop'),
            forceLink: hasFlag('relink') || hasFlag('force-link'),
            onSurface: (line, level) =>
                level === 'warn' ? warn(line) : info(line),
        });
    }

    const pending: FileDelta[] = [];
    let timer: NodeJS.Timeout | undefined;
    const flush = async () => {
        const batch = pending.splice(0, pending.length);
        if (batch.length === 0) return;
        const result = await session.apply(batch);
        const summary = summarizeApplyResult(result);
        if (summary) {
            info(`- ${summary}.`);
        }
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
                const name = basename(event.path);
                if (name === '.gitignore' || name === '.pzstudioignore') {
                    void reloadIgnoreRules();
                }
                if (
                    isWatchPathIgnored(
                        projectPath,
                        outDir,
                        event.path,
                        materialization.action === 'materialize'
                            ? materialization.outDir
                            : undefined,
                        ignorePredicate,
                    )
                ) {
                    continue;
                }
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
            ignore: watchIgnoreGlobs(
                projectPath,
                outDir,
                materialization.action === 'materialize'
                    ? materialization.outDir
                    : undefined,
            ),
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
        process.exitCode = 130;
        void shutdown();
    });

    await stopped;
    info(`Development sync stopped. (exit 130 — Ctrl+C/SIGINT convention)`);
}

registerCommand({
    name: 'watch',
    summary: 'Watch for changes and keep your output directory synced.',
    silent: true,
    flags: [
        { name: 'production', conflicts: ['development', 'both'] },
        { name: 'development', conflicts: ['production', 'both'] },
        { name: 'both', conflicts: ['production', 'development'] },
        { name: 'relink' },
        { name: 'force-link' },
        { name: 'backup-existing-workshop' },
        {
            name: 'materialize',
            takesValue: true,
            conflicts: ['no-materialize'],
        },
        { name: 'no-materialize', conflicts: ['materialize'] },
    ],
    run: () => watchCmd(),
});
