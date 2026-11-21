import { existsSync } from 'fs';
import { resolve } from 'path';
import { resolveBuildOutputPath } from '@pzstudio/core';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { CliError } from '../errors';
import {
    OUTCOME_FAILURE,
    OUTCOME_SUCCESS,
    throwOnOutcomeFailures,
    OperationOutcome,
} from '../outcome';
import {
    distRootOf,
    projectDir,
    removeDirRecursive,
    resolveProjectConfig,
} from '../helper';
import { assertNoAliasRouteSync } from '../mutation-route-guard';
import { info, log, verbose } from '../logger';

addHelp(
    'clean',
    `Clean your output directory from the current built project.
    Removes both the main workshop output and the development output if they exist.

    Usages:
        pzstudio clean - Clean your output directory from the current built project.`,
);

export function cleanOutputPath(
    outputRoot: string | undefined,
    targetPath: string,
): void {
    assertNoAliasRouteSync(
        outputRoot,
        targetPath,
        'delete',
        `clean '${targetPath}'`,
    );
    removeDirRecursive(targetPath);
}

export function cleanCmd() {
    const projectConfig = resolveProjectConfig();

    if (!projectConfig) {
        throw new CliError('No pzstudio project found.');
    }

    const startTime = performance.now();

    const projectPath = resolve(projectDir());
    const outDir = distRootOf(projectPath);
    const cleanConfig = { ...projectConfig, outdir: outDir };
    const mainOutPath = resolveBuildOutputPath(cleanConfig, 'main');
    const devOutPath = resolveBuildOutputPath(cleanConfig, 'development');

    let cleaned = false;
    const outcomes: OperationOutcome[] = [];
    const failures: string[] = [];

    if (existsSync(mainOutPath)) {
        info(`Cleaning main output directory at '${mainOutPath}'...`);
        try {
            cleanOutputPath(outDir, mainOutPath);
            info(`- Removed: ${mainOutPath}`);
            verbose(`Cleaned: ${mainOutPath}`);
            cleaned = true;
            outcomes.push(OUTCOME_SUCCESS);
        } catch (e) {
            failures.push(e instanceof Error ? e.message : String(e));
            outcomes.push(OUTCOME_FAILURE);
        }
    }

    if (existsSync(devOutPath)) {
        info(`Cleaning development output directory at '${devOutPath}'...`);
        try {
            cleanOutputPath(outDir, devOutPath);
            info(`- Removed: ${devOutPath}`);
            verbose(`Cleaned: ${devOutPath}`);
            cleaned = true;
            outcomes.push(OUTCOME_SUCCESS);
        } catch (e) {
            failures.push(e instanceof Error ? e.message : String(e));
            outcomes.push(OUTCOME_FAILURE);
        }
    }

    if (!cleaned && failures.length === 0) {
        verbose(`Checked '${mainOutPath}' and '${devOutPath}'.`);
        log('Already clean.');
        return;
    }

    throwOnOutcomeFailures(outcomes, failures.join('\n'));

    const endTime = performance.now();
    log(`Clean complete in ${((endTime - startTime) / 1000).toFixed(2)}s!`);
}

registerCommand({
    name: 'clean',
    summary: 'Clean your output directory from the current built project.',
    silent: true,
    run: () => cleanCmd(),
});
