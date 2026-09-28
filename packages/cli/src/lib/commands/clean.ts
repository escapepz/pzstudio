import { existsSync } from 'fs';
import { resolveBuildOutputPath } from '../core/buildplan';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { removeDirRecursive, resolveProjectConfig } from '../helper';
import { log, verbose } from '../logger';

addHelp(
    'clean',
    `Clean your output directory from the current built project.
    Removes both the main workshop output and the development output if they exist.

    Usages:
        pzstudio clean - Clean your output directory from the current built project.`,
);

export function cleanCmd() {
    const projectConfig = resolveProjectConfig();

    // Check if we are in a project directory
    if (!projectConfig) {
        throw new Error(
            'You must execute this command within a project directory!',
        );
    }

    const startTime = performance.now();

    const mainOutPath = resolveBuildOutputPath(projectConfig, 'main');
    const devOutPath = resolveBuildOutputPath(projectConfig, 'development');

    let cleaned = false;
    const failures: string[] = [];

    // Clean main output
    if (existsSync(mainOutPath)) {
        log(`Cleaning main output directory at '${mainOutPath}'...`);
        try {
            removeDirRecursive(mainOutPath);
            verbose(`Cleaned: ${mainOutPath}`);
            cleaned = true;
        } catch (e) {
            failures.push(e instanceof Error ? e.message : String(e));
        }
    }

    // Clean development output — always attempted, even when the main
    // output could not be deleted.
    if (existsSync(devOutPath)) {
        log(`Cleaning development output directory at '${devOutPath}'...`);
        try {
            removeDirRecursive(devOutPath);
            verbose(`Cleaned: ${devOutPath}`);
            cleaned = true;
        } catch (e) {
            failures.push(e instanceof Error ? e.message : String(e));
        }
    }

    if (failures.length > 0) {
        throw new Error(failures.join('\n'));
    }

    if (!cleaned) {
        throw new Error(
            `No build output found to clean (checked '${mainOutPath}' and '${devOutPath}')`,
        );
    }

    const endTime = performance.now();
    log(`Clean complete in ${((endTime - startTime) / 1000).toFixed(2)}s!`);
}

registerCommand({
    name: 'clean',
    summary: 'Clean your output directory from the current built project.',
    silent: true,
    run: () => cleanCmd(),
});
