import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import { expect } from '../expect';
import { CliError } from '../errors';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { info, log, verbose, warn } from '../logger';
import {
    projectDir,
    resolveProjectConfig,
    updateExperimentalScripts,
    updateProjectConfig,
} from '../helper';
import { confirmDestructive } from '../interaction';
import { hasFlag } from '../args';

addHelp(
    'delete',
    `Delete a mod from your project.

    Usages:
        pzstudio delete <modId> - Delete a mod from your project.
        pzstudio delete <modId> --verbose - Enable diagnostic output.
        pzstudio delete <modId> --yes - Skip the confirmation prompt (required in non-interactive sessions).
        pzstudio delete <modId> --dry-run - Preview what would be deleted without changing anything.`,
);

export function deleteCmd(modId: string) {
    const projectConfig = resolveProjectConfig();

    // Check if we are in a project directory
    if (!projectConfig) {
        throw new CliError('No pzstudio project found.');
    }

    // Validate params
    expect('param [modId]', modId, 'string');

    // Fail fast: refuse to touch anything if the mod is unknown to the project
    if (!projectConfig.mods[modId]) {
        throw new CliError(`Mod '${modId}' not found in project.json!`, {
            cause: 'project.json only lists mods registered with pzstudio add.',
            tryHint: `Run 'pzstudio list' to see the mods of this project.`,
        });
    }

    const projectPath = projectDir();
    const projectConfigPath = join(projectPath, 'project.json');
    const modPath = join(projectPath, modId);

    // Dry run (CLI-9): compute the plan, show it, change nothing.
    if (hasFlag('dry-run')) {
        log(`Would: delete mod '${modId}' directory (${modPath})`);
        log(`Would: remove mod '${modId}' from ${projectConfigPath}`);
        log('No files were changed.');
        return;
    }

    // Destructive consent (CLI-9): prompts on a TTY unless --yes; refused
    // with a usage error in non-interactive sessions without --yes; the
    // embedded API never prompts (the host owns confirmation).
    confirmDestructive(
        'delete',
        [modId],
        `Delete mod '${modId}' (directory + project.json entry)?`,
    );

    // Delete mod directory
    info(`Deleting mod '${modId}' directory...`);
    if (existsSync(modPath)) {
        verbose(`Removing mod directory: ${modPath}`);
        rmSync(modPath, { force: true, recursive: true });
        info(`Mod '${modId}' directory deleted!`);
    } else {
        verbose(`Mod directory not found at: ${modPath}`);
        warn(`Mod '${modId}' directory not found, skipping...`);
    }

    // Delete mod from project.json
    info(`Deleting mod '${modId}' from project.json...`);
    delete projectConfig.mods[modId];
    projectConfig.excludes = projectConfig.excludes.filter(
        (e: string) => e !== modId,
    );
    updateProjectConfig(projectConfigPath, projectConfig);
    info(`Mod '${modId}' deleted from project.json!`);

    // Run experimental scripts
    updateExperimentalScripts('removeMod', projectPath, modId);
}

registerCommand({
    name: 'delete',
    summary: 'Delete a mod from your project.',
    positionals: [{ name: 'modId', required: true }],
    flags: [{ name: 'dry-run' }],
    run: (ctx) => deleteCmd(ctx.positionals[0]),
});
