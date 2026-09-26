import { basename, join } from 'path';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { hasFlag } from '../args';
import {
    FileOperation,
    ModSourceState,
    PlanBuildInput,
    collectIncludedModIds,
    planBuild,
} from '../core/buildplan';
import {
    projectDir,
    readWorkshopDescriptionLines,
    resolveModInfoTargets,
    resolveProjectConfig,
} from '../helper';
import { info, log, verbose, warn } from '../logger';
import { resolveTemplateDir, scaffoldProject } from '../templateManager';

addHelp(
    'build',
    `Build your project and package it for the workshop.

    NOTE: This command is for packaging only. To generate mod.info files in your source tree,
    use 'pzstudio modinfo generate'.

    Usages:
        pzstudio build               - Builds only the main workshop output (Default).
        pzstudio build --production  - Builds only the main workshop output.
        pzstudio build --development - Builds only the dev_branch workshop output.
        pzstudio build --verbose     - Enable diagnostic output.`,
);

/**
 * Executes the operations produced by planBuild. This is the only I/O layer of
 * the build: everything above it is pure planning.
 */
function executeBuildPlan(operations: FileOperation[]) {
    for (const operation of operations) {
        switch (operation.type) {
            case 'log':
                if (operation.level === 'warn') warn(operation.message);
                else if (operation.level === 'verbose')
                    verbose(operation.message);
                else log(operation.message);
                break;
            case 'removeDir':
                rmSync(operation.path, { recursive: true, force: true });
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

/**
 * Snapshots the source tree of a mod so the planner can decide mod.info
 * targeting without touching the filesystem. The output is a fresh copy of
 * this tree, so source decisions match the ones previously made on the output.
 */
function gatherModSourceState(
    projectPath: string,
    modId: string,
): ModSourceState {
    const state: ModSourceState = { branchFolders: [], modInfoExists: {} };

    state.modInfoExists[''] = existsSync(join(projectPath, modId, 'mod.info'));
    for (const branchPath of resolveModInfoTargets(modId, projectPath)) {
        const branchName = basename(branchPath);
        state.branchFolders.push(branchName);
        state.modInfoExists[branchName] = existsSync(
            join(branchPath, 'mod.info'),
        );
    }
    return state;
}

export async function buildCmd() {
    const projectConfig = resolveProjectConfig();

    // Check if we are in a project directory
    if (!projectConfig) {
        throw new Error(
            'You must execute this command within a project directory!',
        );
    }

    const startTime = performance.now();

    const projectPath = projectDir();
    const outDir = projectConfig.outdir!;
    verbose(`Project root: ${projectPath}`);
    verbose(`Output root: ${outDir}`);

    const isProduction = hasFlag('production');
    const isDevelopment = hasFlag('development');
    verbose(
        `Targets: production=${isProduction}, development=${isDevelopment}`,
    );

    // Conflict detection
    if (isProduction && isDevelopment) {
        throw new Error(
            'Conflicting targets selected: Use either --production or --development, not both.',
        );
    }

    const noFlags = !isProduction && !isDevelopment;

    verbose(`Resolving workshop template...`);
    const templateWorkshopPath = resolveTemplateDir('workshop');
    verbose(`Workshop template path: ${templateWorkshopPath}`);

    // Snapshot the source tree once; every fs decision below is derived from
    // it by the pure planner.
    const modSourceStates: Record<string, ModSourceState> = {};
    for (const modId of Object.keys(projectConfig.mods)) {
        modSourceStates[modId] = gatherModSourceState(projectPath, modId);
    }

    const planInput: Omit<PlanBuildInput, 'variant'> = {
        config: projectConfig,
        workshopTemplateDir: templateWorkshopPath,
        projectDir: projectPath,
        modSourceStates,
        descriptionLines: readWorkshopDescriptionLines(projectPath),
        previewPngExists: existsSync(
            join(projectPath, 'workshop', 'preview.png'),
        ),
    };

    // Build main workshop (Default or explicit --production)
    if (noFlags || isProduction) {
        const mainModIds = collectIncludedModIds(projectConfig, 'main');
        if (mainModIds.length === 0) {
            warn(
                'All mods are dev-only or excluded — nothing to build for the main workshop output. Use --development to build the dev_branch output.',
            );
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
            log(`\nBuilding main workshop...`);
            executeBuildPlan(planBuild({ ...planInput, variant: 'main' }));
        }
    }

    // Build dev_branch workshop (Only if --development is specified)
    if (isDevelopment) {
        const devModIds = collectIncludedModIds(projectConfig, 'development');
        if (devModIds.length === 0) {
            warn(
                'All mods are excluded — nothing to build for the dev_branch workshop output.',
            );
        } else {
            log(`\nBuilding dev_branch workshop...`);
            executeBuildPlan(
                planBuild({ ...planInput, variant: 'development' }),
            );
        }
    }

    const endTime = performance.now();
    info(`Build complete in ${((endTime - startTime) / 1000).toFixed(2)}s!`);
}

registerCommand({
    name: 'build',
    summary: 'Build your project and package it for the workshop.',
    silent: true,
    run: () => buildCmd(),
});
