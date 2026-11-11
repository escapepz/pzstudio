import { basename } from 'path';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { CliError } from '../errors';
import { extractFlag, hasFlag } from '../args';
import type { FileDelta } from '@pzstudio/core';
import { resolveBuildOutputPath, summarizeApplyResult } from '@pzstudio/core';
import { distRootOf, projectDir, resolveProjectConfig } from '../helper';
import { readGlobalConfig } from '../templateManager';
import { info, verbose, warn } from '../logger';
import { createDevSyncForEngine } from '../devsync';
import {
    assertWatchMaterializable,
    isWatchPathIgnored,
    parseMaterializeFlag,
    resolveWatchVariants,
    watchIgnoreGlobs,
    WATCH_DEBOUNCE_MS,
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
        pzstudio watch               - Syncs both the main and dev_branch outputs.
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
    // Mutually exclusive flag combinations are rejected by
    // validateInvocation (CLI-1) before the handler runs.
    const variants = resolveWatchVariants({
        production: isProduction,
        development: isDevelopment,
        both: isBoth,
    });

    const projectPath = projectDir();
    // Dist-always: the watcher ignores the canonical dist output tree (the
    // engine's only write target); the deployment target is never a
    // watcher concern — except its junction, which surfaces the same
    // writes when it sits inside the project (see watchIgnoreGlobs).
    const outDir = distRootOf(projectPath);
    // Materialize resolution BEFORE the session starts: the copy-mode
    // refusal must fail the command up front, never mid-session.
    const materialization: MaterializationResolution = resolveMaterialization({
        projectRoot: projectPath,
        effectiveOutdir: projectConfig.outdir,
        projectMaterialize: projectConfig.build?.materialize,
        globalMaterialize: readGlobalConfig()?.materialize,
        flagMaterialize: parseMaterializeFlag(extractFlag('materialize')),
        noMaterialize: hasFlag('no-materialize'),
    });
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
    // Compact single-line banner (CLI-7): what is syncing and how to stop.
    info(
        `Syncing '${projectConfig.workshop.title}' (${variants.join(' + ')}) — press Ctrl+C to stop.`,
    );

    // Engine command: plan-input emissions must follow the active invocation
    // logger (doc 11 §12) via the internal engine path, while the §13 raw
    // legacy settings/transport composition and the anchor side effect stay
    // with the (signature-frozen) facade export.
    const session = createDevSyncForEngine(projectPath);
    // Initial full build: on failure the session is stopped and the command
    // exits — watching an output that could not be built helps nobody.
    try {
        await session.start(variants);
    } catch (e) {
        await session.stop();
        throw e;
    }

    // Materialize after the initial build: one junction per synced item
    // (mode 'symlink'), created ONCE — every subsequent apply flows through
    // the link at O(0) cost, which is exactly why watch runs in symlink
    // mode. Non-fatal by contract; refusals surface and doctor reports.
    if (materialization.action === 'materialize') {
        const anchoredConfig = { ...projectConfig, outdir: outDir };
        const itemNames = variants.map((variant) =>
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
        // A successful sync is otherwise silent: say what a batch did so
        // "nothing happened" is never ambiguous again (same wording the
        // extension's output channel uses).
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
                if (
                    isWatchPathIgnored(
                        projectPath,
                        outDir,
                        event.path,
                        materialization.action === 'materialize'
                            ? materialization.outDir
                            : undefined,
                    )
                ) {
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
            // Cheaper to drop the output trees natively than to filter their
            // events after delivery (watching our own writes is pure noise):
            // the canonical dist root, plus the deployment root when it sits
            // inside the project (a junction surfaces the same writes).
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
    // The command owns its interruption (CLI-6): one handler, one message,
    // exit 130. runCLI no longer installs a process-level handler, so
    // Ctrl+C no longer double-reports.
    process.once('SIGINT', () => {
        process.exitCode = 130;
        void shutdown();
    });

    await stopped;
    info(`Development sync stopped.`);
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
        { name: 'materialize', takesValue: true },
        { name: 'no-materialize' },
    ],
    run: () => watchCmd(),
});
