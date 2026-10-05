import { mkdirSync, writeFileSync, cpSync } from 'fs';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { CliError } from '../errors';
import { hasFlag } from '../args';
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
} from '@pzstudio/core';
import {
    gatherPlanInput,
    projectDir,
    removeDirRecursive,
    resolveProjectConfig,
} from '../helper';
import { info, verbose, warn } from '../logger';
import { resolveTemplateDir, scaffoldProject } from '../templateManager';

addHelp(
    'build',
    `Build your project and package it for the workshop.

    NOTE: This command is for packaging only. To generate mod.info files in your source tree,
    use 'pzstudio modinfo generate'.

    Usages:
        pzstudio build               - Builds the target from project.json build.target (main by default).
        pzstudio build --production  - Builds only the main workshop output.
        pzstudio build --development - Builds only the dev_branch workshop output.
        pzstudio build --both        - Builds both the main and dev_branch workshop outputs.
        pzstudio build --verbose     - Enable diagnostic output.`,
);

/**
 * Executes the operations produced by planBuild. This is the only I/O layer of
 * the build: everything above it is pure planning. Exported so the sync
 * engine's filesystem-based executor can be kept in parity by tests.
 */
export function executeBuildPlan(operations: FileOperation[]) {
    for (const operation of operations) {
        switch (operation.type) {
            case 'log':
                if (operation.level === 'warn') warn(operation.message);
                else if (operation.level === 'verbose')
                    verbose(operation.message);
                else info(operation.message);
                break;
            case 'removeDir':
                removeDirRecursive(operation.path);
                break;
            case 'makeDir':
                mkdirSync(operation.path, { recursive: true });
                break;
            case 'copyTree':
                scaffoldProject(operation.from, operation.to, false, false, {
                    excludeIgnoreFile: operation.excludeIgnoreFile,
                    ignoreDotFiles: operation.ignoreDotFiles,
                    ignoreItems: operation.ignoreItems,
                });
                break;
            case 'writeFile':
                writeFileSync(operation.path, operation.content);
                break;
            case 'copyFile':
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

    const projectPath = projectDir();
    const outDir = projectConfig.outdir!;
    verbose(`Project root: ${projectPath}`);
    verbose(`Output root: ${outDir}`);

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

    const templateWorkshopPath = resolveTemplateDir('workshop');
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
                executeBuildPlan(planBuild({ ...planInput, variant: 'main' }));
                variantOutcomes.push(OUTCOME_SUCCESS);
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
                );
                variantOutcomes.push(OUTCOME_SUCCESS);
            }
        } catch (e) {
            variantErrors.push(e instanceof Error ? e.message : String(e));
            variantOutcomes.push(OUTCOME_FAILURE);
        }
    }

    throwOnOutcomeFailures(variantOutcomes, variantErrors.join('\n'));

    const endTime = performance.now();
    info(`Build complete in ${((endTime - startTime) / 1000).toFixed(2)}s!`);
}

registerCommand({
    name: 'build',
    summary: 'Build your project and package it for the workshop.',
    silent: true,
    flags: [
        { name: 'production', conflicts: ['development', 'both'] },
        { name: 'development', conflicts: ['production', 'both'] },
        { name: 'both', conflicts: ['production', 'development'] },
    ],
    run: () => buildCmd(),
});
