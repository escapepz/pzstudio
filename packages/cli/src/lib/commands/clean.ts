import { existsSync } from 'fs';
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
import { removeDirRecursive, resolveProjectConfig } from '../helper';
import { assertNoAliasRouteSync } from '../mutation-route-guard';
import { info, log, verbose } from '../logger';

addHelp(
    'clean',
    `Clean your output directory from the current built project.
    Removes both the main workshop output and the development output if they exist.

    Usages:
        pzstudio clean - Clean your output directory from the current built project.`,
);

/**
 * Removes one clean target below the configured output root — the clean
 * tier of the F23-WRITE P0 CLI guard (doc 17 §11.4, the same invariant the
 * build executor applies to its removeDir operations): the target must sit
 * inside the configured root and its route is authorized before anything
 * is deleted, while the root itself stays un-inspected (INV-A — a
 * user-configured junction outdir keeps cleaning). The delete leaf is
 * link-safe by the guard's B1 semantics: a junction at the target is
 * removed as a link, never followed. Exported so the clean guard is
 * testable in parity with executeBuildPlan.
 */
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

    // Check if we are in a project directory
    if (!projectConfig) {
        throw new CliError('No pzstudio project found.');
    }

    const startTime = performance.now();

    const outDir = projectConfig.outdir!;
    const mainOutPath = resolveBuildOutputPath(projectConfig, 'main');
    const devOutPath = resolveBuildOutputPath(projectConfig, 'development');

    let cleaned = false;
    const outcomes: OperationOutcome[] = [];
    const failures: string[] = [];

    // Clean main output
    if (existsSync(mainOutPath)) {
        info(`Cleaning main output directory at '${mainOutPath}'...`);
        try {
            cleanOutputPath(outDir, mainOutPath);
            verbose(`Cleaned: ${mainOutPath}`);
            cleaned = true;
            outcomes.push(OUTCOME_SUCCESS);
        } catch (e) {
            failures.push(e instanceof Error ? e.message : String(e));
            outcomes.push(OUTCOME_FAILURE);
        }
    }

    // Clean development output — always attempted, even when the main
    // output could not be deleted.
    if (existsSync(devOutPath)) {
        info(`Cleaning development output directory at '${devOutPath}'...`);
        try {
            cleanOutputPath(outDir, devOutPath);
            verbose(`Cleaned: ${devOutPath}`);
            cleaned = true;
            outcomes.push(OUTCOME_SUCCESS);
        } catch (e) {
            failures.push(e instanceof Error ? e.message : String(e));
            outcomes.push(OUTCOME_FAILURE);
        }
    }

    // Nothing to do is a clean result, not a failure (CLI-6): the output
    // directories are exactly what the command promises.
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
