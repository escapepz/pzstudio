import { mkdirSync, writeFileSync, cpSync } from 'fs';
import { basename, resolve } from 'path';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { CliError } from '../errors';
import { extractFlag, hasFlag } from '../args';
import {
    OUTCOME_FAILURE,
    OUTCOME_SUCCESS,
    OUTCOME_WARNING,
    OperationOutcome,
    throwOnOutcomeFailures,
} from '../outcome';
import {
    FileOperation,
    collectIncludedModIds,
    planBuild,
    resolveBuildOutputPath,
    workshopTextForVariant,
    type MaterializeMode,
} from '@pzstudio/core';
import {
    distRootOf,
    gatherPlanInput,
    projectDir,
    removeDirRecursive,
    resolveProjectConfig,
} from '../helper';
import {
    assertNoAliasRouteSync,
    type CliMutationRouteOptions,
} from '../mutation-route-guard';
import { info, verbose, warn } from '../logger';
import { isStandaloneBin } from '../runtime-context';
import { maybePrintFirstBuildUrl } from '../first-run';
import {
    readGlobalConfig,
    resolveTemplateDirForEngine,
    scaffoldProject,
} from '../templateManager';
import {
    maybeMaterializeBuiltItems,
    resolveMaterialization,
    writeBuiltItemMarker,
    type MaterializationResolution,
} from '../linkStep';

addHelp(
    'build',
    `Build your project and package it for the workshop.

    Builds always write the canonical dist/ output inside the project. When
    an outdir is configured (project.json or 'pzstudio outdir'), each built
    item is deployed there: a junction by default ('symlink'), or a verified
    copy ('copy').

    NOTE: This command is for packaging only. To generate mod.info files in your source tree,
    use 'pzstudio modinfo generate'.

    Usages:
        pzstudio build               - Builds the target from project.json build.target (main by default).
        pzstudio build --production  - Builds only the main workshop output.
        pzstudio build --development - Builds only the dev_branch workshop output.
        pzstudio build --both        - Builds both the main and dev_branch workshop outputs.
        pzstudio build --no-materialize        - Build dist/ only; skip deployment this run.
        pzstudio build --materialize=copy      - Force copy-mode deployment this run.
        pzstudio build --verbose     - Enable diagnostic output.`,
);

/**
 * Executes the operations produced by planBuild. This is the only I/O layer of
 * the build: everything above it is pure planning. Exported so the sync
 * engine's filesystem-based executor can be kept in parity by tests.
 *
 * When `options.outputRoot` declares the configured build output root, every
 * mutating operation is guarded against alias routes before it touches the
 * filesystem (F23-WRITE P0, doc 17 §11.4 — the CLI tier of the Core guard):
 * a symbolic link or junction anywhere on a mutation's route below the root —
 * including a write's leaf — aborts the plan with an explicit refusal naming
 * the link; operations that already ran remain on disk (disclosed partial
 * output, the existing mid-plan abort shape). Without an output root the
 * executor keeps today's behavior.
 */
export function executeBuildPlan(
    operations: FileOperation[],
    options?: CliMutationRouteOptions,
) {
    const outputRoot = options?.outputRoot;
    for (const operation of operations) {
        switch (operation.type) {
            case 'log':
                if (operation.level === 'warn') warn(operation.message);
                else if (operation.level === 'verbose')
                    verbose(operation.message);
                else info(operation.message);
                break;
            case 'removeDir':
                assertNoAliasRouteSync(
                    outputRoot,
                    operation.path,
                    'delete',
                    `removeDir '${operation.path}'`,
                );
                removeDirRecursive(operation.path);
                break;
            case 'makeDir':
                assertNoAliasRouteSync(
                    outputRoot,
                    operation.path,
                    'write',
                    `makeDir '${operation.path}'`,
                );
                mkdirSync(operation.path, { recursive: true });
                break;
            case 'copyTree':
                scaffoldProject(operation.from, operation.to, false, false, {
                    excludeIgnoreFile: operation.excludeIgnoreFile,
                    ignoreDotFiles: operation.ignoreDotFiles,
                    ignoreItems: operation.ignoreItems,
                    outputRoot,
                });
                break;
            case 'writeFile':
                assertNoAliasRouteSync(
                    outputRoot,
                    operation.path,
                    'write',
                    `writeFile '${operation.path}'`,
                );
                writeFileSync(operation.path, operation.content);
                break;
            case 'copyFile':
                assertNoAliasRouteSync(
                    outputRoot,
                    operation.to,
                    'write',
                    `copyFile to '${operation.to}'`,
                );
                cpSync(operation.from, operation.to);
                break;
        }
    }
}

export async function buildCmd() {
    const projectConfig = resolveProjectConfig();

    // Check if we are in a project directory
    if (!projectConfig) {
        throw new CliError('No pzstudio project found.');
    }

    const startTime = performance.now();

    // Dist-always amendment (2026-11-12): the canonical build root is
    // ALWAYS `<projectRoot>/dist` (anchored in gatherPlanInput); the
    // user's outdir (any tier) is the DEPLOYMENT target. `projectRoot`
    // resolved once: the marker identity (projectId hash) and the plan
    // input must share the project root's canonical spelling, or the
    // ownership check never matches (Task 3 review carry-forward).
    const projectPath = resolve(projectDir());
    const distRoot = distRootOf(projectPath);
    const flagMaterializeRaw = extractFlag('materialize');
    if (
        flagMaterializeRaw !== undefined &&
        flagMaterializeRaw !== 'symlink' &&
        flagMaterializeRaw !== 'copy'
    ) {
        throw new CliError(
            `Invalid --materialize value "${flagMaterializeRaw}".`,
            {
                tryHint:
                    'Use --materialize=symlink (junction, default) or --materialize=copy (reconciled real copy).',
            },
        );
    }
    const materialization: MaterializationResolution = resolveMaterialization({
        projectRoot: projectPath,
        effectiveOutdir: projectConfig.outdir,
        projectMaterialize: projectConfig.build?.materialize,
        globalMaterialize: readGlobalConfig()?.materialize,
        flagMaterialize: flagMaterializeRaw as MaterializeMode | undefined,
        noMaterialize: hasFlag('no-materialize'),
    });
    verbose(`Project root: ${projectPath}`);
    verbose(`Output root: ${distRoot}`);
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

    const isProduction = hasFlag('production');
    const isDevelopment = hasFlag('development');
    const isBoth = hasFlag('both');
    verbose(
        `Flags: production=${isProduction}, development=${isDevelopment}, both=${isBoth}`,
    );

    // Target resolution: explicit flags win over project.json build.target,
    // which in turn wins over the default (main only). Mutually exclusive
    // flag combinations are rejected by validateInvocation (CLI-1) before
    // the handler runs.
    const configTarget = projectConfig.build?.target;
    let buildMain = false;
    let buildDev = false;
    if (isBoth) {
        buildMain = true;
        buildDev = true;
    } else if (isProduction) {
        buildMain = true;
    } else if (isDevelopment) {
        buildDev = true;
    } else if (configTarget === 'both') {
        buildMain = true;
        buildDev = true;
    } else if (configTarget === 'development') {
        buildDev = true;
    } else {
        // 'production' or unset — the main output only
        buildMain = true;
    }
    verbose(`Targets: main=${buildMain}, development=${buildDev}`);

    const templateWorkshopPath = resolveTemplateDirForEngine('workshop');
    const planInput = gatherPlanInput(
        projectPath,
        projectConfig,
        templateWorkshopPath,
    );

    // Each variant is isolated: a locked output folder in one target must
    // not prevent the other target from being built (--both). The recorded
    // outcomes decide the exit code mechanically (CLI-6): any failure part
    // fails the command after every variant got its chance.
    const variantOutcomes: OperationOutcome[] = [];
    const variantErrors: string[] = [];
    const builtItems: Array<{
        name: string;
        variant: 'main' | 'development';
    }> = [];

    // Build main workshop (Default/project.json target or explicit --production)
    if (buildMain) {
        try {
            const mainModIds = collectIncludedModIds(projectConfig, 'main');
            if (mainModIds.length === 0) {
                warn(
                    'All mods are dev-only or excluded — nothing to build for the main workshop output. Use --development to build the dev_branch output.',
                );
                variantOutcomes.push(OUTCOME_WARNING);
            } else {
                const devOnlyModIds = Object.keys(projectConfig.mods).filter(
                    (modId) =>
                        !(projectConfig.excludes ?? []).includes(modId) &&
                        projectConfig.mods[modId].build?.devOnly,
                );
                if (devOnlyModIds.length > 0) {
                    warn(
                        `Dev-only mods skipped in the main build: ${devOnlyModIds.join(', ')} — they are built into the dev_branch output (--development).`,
                    );
                }
                info(`\nBuilding main workshop...`);
                executeBuildPlan(planBuild({ ...planInput, variant: 'main' }), {
                    outputRoot: distRoot,
                });
                variantOutcomes.push(OUTCOME_SUCCESS);
                builtItems.push({
                    // The ANCHORED plan config carries the dist output root
                    // (the raw project config's outdir is the deployment
                    // target and may be unset — pure build mode).
                    name: basename(
                        resolveBuildOutputPath(planInput.config, 'main'),
                    ),
                    variant: 'main',
                });
                // The dist-side ownership marker is written on EVERY
                // successful variant build (dist-always: there is no
                // legacy mode left to gate it). A failure never fails the
                // variant — fail-closed downstream (a missing marker
                // surfaces as UNOWNED_TARGET).
                try {
                    await writeBuiltItemMarker(
                        projectConfig,
                        'main',
                        projectPath,
                        distRoot,
                    );
                } catch (e) {
                    warn(
                        `Output ownership marker for the main item failed: ${
                            e instanceof Error ? e.message : String(e)
                        }`,
                    );
                }
            }
        } catch (e) {
            variantErrors.push(e instanceof Error ? e.message : String(e));
            variantOutcomes.push(OUTCOME_FAILURE);
        }
    }

    // Build dev_branch workshop (project.json target, --development or --both)
    if (buildDev) {
        try {
            const devModIds = collectIncludedModIds(
                projectConfig,
                'development',
            );
            if (devModIds.length === 0) {
                warn(
                    'All mods are excluded — nothing to build for the dev_branch workshop output.',
                );
                variantOutcomes.push(OUTCOME_WARNING);
            } else {
                info(`\nBuilding dev_branch workshop...`);
                executeBuildPlan(
                    planBuild({ ...planInput, variant: 'development' }),
                    { outputRoot: distRoot },
                );
                variantOutcomes.push(OUTCOME_SUCCESS);
                builtItems.push({
                    name: basename(
                        resolveBuildOutputPath(planInput.config, 'development'),
                    ),
                    variant: 'development',
                });
                try {
                    await writeBuiltItemMarker(
                        projectConfig,
                        'development',
                        projectPath,
                        distRoot,
                    );
                } catch (e) {
                    warn(
                        `Output ownership marker for the dev_branch item failed: ${
                            e instanceof Error ? e.message : String(e)
                        }`,
                    );
                }
            }
        } catch (e) {
            variantErrors.push(e instanceof Error ? e.message : String(e));
            variantOutcomes.push(OUTCOME_FAILURE);
        }
    }

    // Materialize step: expose each successfully built item to the game —
    // a junction per item (mode 'symlink', the default) or a verified,
    // reconciled copy (mode 'copy'), into the configured deployment root.
    // NON-FATAL by contract (Review Focus 4) — every refusal/failure is
    // recorded and surfaced. Runs BEFORE the failure throw: a failed
    // variant must not orphan the deployment of a variant that DID build
    // (final review fix wave #4). No target / --no-materialize: hard no-op.
    const sourceTexts: Record<string, string> = {};
    for (const built of builtItems) {
        sourceTexts[built.name] = workshopTextForVariant(
            projectConfig,
            built.variant,
        );
    }
    await maybeMaterializeBuiltItems(
        materialization,
        builtItems.map((built) => built.name),
        {
            projectRoot: projectPath,
            backupExisting: hasFlag('backup-existing-workshop'),
            forceLink: hasFlag('relink') || hasFlag('force-link'),
            sourceWorkshopTxtByItem: sourceTexts,
            onSurface: (line, level) =>
                level === 'warn' ? warn(line) : info(line),
        },
    );

    throwOnOutcomeFailures(variantOutcomes, variantErrors.join('\n'));

    const endTime = performance.now();
    info(`Build complete in ${((endTime - startTime) / 1000).toFixed(2)}s!`);

    // First-success URL print (one-time per machine, marker-file pinned):
    // only a standalone bin run prints or consumes the marker — an
    // extension-hosted in-process build must never print nor pin it, so
    // the terminal CLI still gets its first print. Progress-class info():
    // stderr, --quiet-suppressible, stdout untouched. Printed after the
    // completion line so the CTA reads as the closing note of the build.
    if (isStandaloneBin()) {
        maybePrintFirstBuildUrl((line) => info(line));
    }
}

registerCommand({
    name: 'build',
    summary: 'Build your project and package it for the workshop.',
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
    run: () => buildCmd(),
});
