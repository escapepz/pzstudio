import { existsSync, mkdirSync, writeFileSync, cpSync } from 'fs';
import { basename, join, resolve } from 'path';
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
} from '@pzstudio/core';
import { printJsonEnvelope } from '../json';
import {
    distRootOf,
    gatherPlanInput,
    projectDir,
    removeDirRecursive,
    resolveProjectConfig,
} from '../helper';
import { parseMaterializeFlag } from '../watch-shared';
import {
    assertNoAliasRouteSync,
    type CliMutationRouteOptions,
} from '../mutation-route-guard';
import { error, info, verbose, warn } from '../logger';
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
        pzstudio build --json        - Print a machine-readable envelope instead of the human report.
        pzstudio build --verbose     - Enable diagnostic output.`,
);

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

    if (!projectConfig) {
        throw new CliError('No pzstudio project found.');
    }

    const startTime = performance.now();

    const projectPath = resolve(projectDir());
    const distRoot = distRootOf(projectPath);
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
        buildMain = true;
    }
    verbose(`Targets: main=${buildMain}, development=${buildDev}`);

    const isAggregateBuild = buildMain && buildDev;
    const modFolderMissing = (modId: string) =>
        !existsSync(join(projectPath, modId));
    const missingOnDiskSuffix = (missingMods: string[]) =>
        missingMods.length > 0
            ? ` (${missingMods
                  .map((modId) => `${modId}: missing on disk`)
                  .join(', ')})`
            : '';

    const templateWorkshopPath = resolveTemplateDirForEngine('workshop');
    const planInput = gatherPlanInput(
        projectPath,
        projectConfig,
        templateWorkshopPath,
    );

    const variantOutcomes: OperationOutcome[] = [];
    const variantErrors: string[] = [];
    const builtItems: Array<{
        name: string;
        variant: 'main' | 'development';
    }> = [];

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
                const missingMods = mainModIds.filter(modFolderMissing);
                for (const modId of missingMods) {
                    error(
                        new CliError(
                            `mod ${modId} is missing on disk: ${join(
                                projectPath,
                                modId,
                            )}`,
                        ),
                    );
                }
                const survivorModIds = mainModIds.filter(
                    (modId) => !missingMods.includes(modId),
                );
                const variantPlanConfig = {
                    ...planInput.config,
                    mods: Object.fromEntries(
                        survivorModIds.map((modId) => [
                            modId,
                            planInput.config.mods[modId],
                        ]),
                    ),
                };
                executeBuildPlan(
                    planBuild({
                        ...planInput,
                        config: variantPlanConfig,
                        variant: 'main',
                    }),
                    { outputRoot: distRoot },
                );
                if (missingMods.length > 0) {
                    for (const modId of missingMods) {
                        variantErrors.push(
                            `mod ${modId} is missing on disk: ${join(
                                projectPath,
                                modId,
                            )}`,
                        );
                    }
                    variantOutcomes.push(OUTCOME_FAILURE);
                } else {
                    variantOutcomes.push(OUTCOME_SUCCESS);
                    builtItems.push({
                        name: basename(
                            resolveBuildOutputPath(planInput.config, 'main'),
                        ),
                        variant: 'main',
                    });
                    try {
                        await writeBuiltItemMarker(
                            planInput.config,
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
                if (isAggregateBuild) {
                    info(
                        `Build summary (main): ${survivorModIds.length} ok, ${missingMods.length} failed${missingOnDiskSuffix(missingMods)}`,
                    );
                }
            }
        } catch (e) {
            variantErrors.push(e instanceof Error ? e.message : String(e));
            variantOutcomes.push(OUTCOME_FAILURE);
        }
    }

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
                const missingMods = devModIds.filter(modFolderMissing);
                for (const modId of missingMods) {
                    error(
                        new CliError(
                            `mod ${modId} is missing on disk: ${join(
                                projectPath,
                                modId,
                            )}`,
                        ),
                    );
                }
                const survivorModIds = devModIds.filter(
                    (modId) => !missingMods.includes(modId),
                );
                const variantPlanConfig = {
                    ...planInput.config,
                    mods: Object.fromEntries(
                        survivorModIds.map((modId) => [
                            modId,
                            planInput.config.mods[modId],
                        ]),
                    ),
                };
                executeBuildPlan(
                    planBuild({
                        ...planInput,
                        config: variantPlanConfig,
                        variant: 'development',
                    }),
                    { outputRoot: distRoot },
                );
                if (missingMods.length > 0) {
                    for (const modId of missingMods) {
                        variantErrors.push(
                            `mod ${modId} is missing on disk: ${join(
                                projectPath,
                                modId,
                            )}`,
                        );
                    }
                    variantOutcomes.push(OUTCOME_FAILURE);
                } else {
                    variantOutcomes.push(OUTCOME_SUCCESS);
                    builtItems.push({
                        name: basename(
                            resolveBuildOutputPath(
                                planInput.config,
                                'development',
                            ),
                        ),
                        variant: 'development',
                    });
                    try {
                        await writeBuiltItemMarker(
                            planInput.config,
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
                if (isAggregateBuild) {
                    info(
                        `Build summary (dev_branch): ${survivorModIds.length} ok, ${missingMods.length} failed${missingOnDiskSuffix(missingMods)}`,
                    );
                }
            }
        } catch (e) {
            variantErrors.push(e instanceof Error ? e.message : String(e));
            variantOutcomes.push(OUTCOME_FAILURE);
        }
    }

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

    if (hasFlag('json')) {
        printJsonEnvelope('build', {
            items: builtItems,
            durationMs: Math.round(endTime - startTime),
        });
    }

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
        {
            name: 'materialize',
            takesValue: true,
            conflicts: ['no-materialize'],
        },
        { name: 'no-materialize', conflicts: ['materialize'] },
        { name: 'json' },
    ],
    run: () => buildCmd(),
});
