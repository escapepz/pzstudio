import { join, extname } from 'path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { expect } from '../expect';
import { CliError } from '../errors';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { BINARY_FILE_EXTENSIONS } from '@pzstudio/core';
import {
    getFilesRecursively,
    projectDir,
    readProjectConfig,
    updateExperimentalScripts,
    updateProjectConfig,
} from '../helper';
import { log, verbose } from '../logger';
import { scaffoldProject } from '../templateManager';
import { confirmDestructive } from '../interaction';
import { hasFlag } from '../args';

addHelp(
    'rename',
    `Rename a mod id in your project (folder + project.json key).

    The mod's "name" field is left untouched — this renames the id only.

    Usages:
        pzstudio rename <oldModId> <newModId> - Rename a mod id in your project.
        pzstudio rename <oldModId> <newModId> --yes - Skip the confirmation prompt (required in non-interactive sessions).
        pzstudio rename <oldModId> <newModId> --dry-run - Preview what would be renamed without changing anything.`,
);

export function renameCmd(oldModId: string, newModId: string) {
    const projectPath = projectDir();
    const projectConfig = readProjectConfig();

    // Check if we are in a project directory
    if (!projectConfig) {
        throw new CliError('No pzstudio project found.');
    }

    // Validate params
    expect('param [oldModId]', oldModId, 'string');
    expect('param [newModId]', newModId, 'string');

    // Check if old mod id already exists
    if (!projectConfig.mods[oldModId]) {
        throw new CliError(`Mod '${oldModId}' does not exist!`, {
            tryHint: `Run 'pzstudio list' to see the mods of this project.`,
        });
    }

    // Check if mod already exists
    if (
        projectConfig.mods[newModId] ||
        existsSync(join(projectPath, newModId))
    ) {
        throw new Error(`A mod with id '${newModId}' already exists!`);
    }

    // The mod folder is required to rewrite occurrences of the old id in the
    // mod's files; a config-only entry has nothing to rewrite.
    const oldPath = join(projectPath, oldModId);
    const newPath = join(projectPath, newModId);
    const folderExists = existsSync(oldPath);
    if (!folderExists && !existsSync(newPath)) {
        throw new Error(
            `Mod folder '${oldModId}' was not found on disk. Remove it from project.json instead (edit the file directly) or restore the folder before renaming.`,
        );
    }

    // Dry run (CLI-9): compute the plan, show it, change nothing.
    if (hasFlag('dry-run')) {
        if (folderExists) {
            log(`Would: rename folder '${oldPath}' to '${newPath}'`);
            log(
                `Would: rewrite occurrences of '${oldModId}' in the folder's text files with '${newModId}'`,
            );
        }
        log(
            `Would: rename the project.json mods key '${oldModId}' to '${newModId}'`,
        );
        log('No files were changed.');
        return;
    }

    // Destructive consent (CLI-9): prompts on a TTY unless --yes; refused
    // with a usage error in non-interactive sessions without --yes; the
    // embedded API never prompts (the host owns confirmation).
    confirmDestructive(
        'rename',
        [oldModId, newModId],
        `Rename mod '${oldModId}' to '${newModId}' (folder + project.json key)?`,
    );

    // Rename mod
    if (folderExists) {
        log(`- Renaming mod '${oldModId}' to '${newModId}'...`);
        verbose(`Copying ${oldPath} to ${newPath}`);
        scaffoldProject(oldPath, newPath, false, false);
        verbose(`Removing old mod directory: ${oldPath}`);
        rmSync(oldPath, { force: true, recursive: true });
    }

    // Update code
    getFilesRecursively(newPath).forEach((file) => {
        // Binary files would get corrupted by a utf-8 read/replace/write cycle
        if (BINARY_FILE_EXTENSIONS.has(extname(file).toLowerCase())) {
            verbose(`Skipping binary file: ${file}`);
            return;
        }

        const content = readFileSync(file, 'utf-8');
        const newContent = content.replaceAll(oldModId, newModId);
        if (content !== newContent) {
            writeFileSync(file, newContent, { encoding: 'utf-8' });
            log(`- Updated file ${file} with new mod id '${newModId}'`);
        }
    });

    // Update config
    projectConfig.mods[newModId] = projectConfig.mods[oldModId];
    delete projectConfig.mods[oldModId];
    // Keep the build state consistent: an excluded mod stays excluded
    // under its new id.
    if (projectConfig.excludes.includes(oldModId)) {
        projectConfig.excludes = projectConfig.excludes.map((id) =>
            id === oldModId ? newModId : id,
        );
    }
    updateProjectConfig(join(projectPath, 'project.json'), projectConfig);
    log(`- Mod '${oldModId}' updated to '${newModId}' in project.json!`);

    // Update experimental package scripts
    updateExperimentalScripts('renameMod', projectPath, oldModId, newModId);
}

registerCommand({
    name: 'rename',
    summary: 'Rename a mod id from your project.',
    positionals: [
        { name: 'oldModId', required: true },
        { name: 'newModId', required: true },
    ],
    flags: [{ name: 'yes' }, { name: 'dry-run' }],
    run: (ctx) => renameCmd(ctx.positionals[0], ctx.positionals[1]),
});
