import { existsSync } from 'fs';
import { join } from 'path';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { log, verbose } from '../logger';
import { projectDir, readProjectConfig } from '../helper';

addHelp(
    'list',
    `List the mods in your project.

    Usages:
        pzstudio list - List the mods in your project with their status.`,
);

export function listCmd() {
    const projectConfig = readProjectConfig();

    // Check if we are in a project directory
    if (!projectConfig) {
        throw new Error(
            'You must execute this command within a project directory!',
        );
    }

    const modIds = Object.keys(projectConfig.mods);
    if (modIds.length === 0) {
        log(`No mods in project '${projectConfig.workshop.title}'.`);
        return;
    }

    log(`Mods in project '${projectConfig.workshop.title}':`);
    for (const modId of modIds) {
        const onDisk = existsSync(join(projectDir(), modId));
        const excluded = projectConfig.excludes.includes(modId);
        verbose(`Mod '${modId}': onDisk=${onDisk}, excluded=${excluded}`);

        const status = !onDisk
            ? 'missing on disk'
            : excluded
              ? 'on disk, excluded from workshop build'
              : 'on disk, included';
        log(`    ${modId.padEnd(20)} ${status}`);
    }
}

registerCommand({
    name: 'list',
    summary: 'List the mods in your project.',
    run: () => listCmd(),
});
