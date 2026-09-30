import { join, extname } from 'path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { expect } from '../expect';
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

addHelp(
    'rename',
    `Rename a mod id in your project (folder + project.json key).

    The mod's "name" field is left untouched — this renames the id only.

    Usages:
        pzstudio rename <oldModId> <newModId> - Rename a mod id in your project.`,
);

export function renameCmd(oldModId: string, newModId: string) {
    const projectPath = projectDir();
    const projectConfig = readProjectConfig();

    // Check if we are in a project directory
    if (!projectConfig) {
        throw new Error(
            'You must execute this command within a project directory!',
        );
    }

    // Validate params
    expect('param [oldModId]', oldModId, 'string');
    expect('param [newModId]', newModId, 'string');

    // Check if old mod id already exists
    if (!projectConfig.mods[oldModId]) {
        throw new Error(`Mod '${oldModId}' does not exist!`);
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
    if (!existsSync(oldPath) && !existsSync(newPath)) {
        throw new Error(
            `Mod folder '${oldModId}' was not found on disk. Remove it from project.json instead (edit the file directly) or restore the folder before renaming.`,
        );
    }

    // Rename mod
    if (existsSync(oldPath)) {
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
    run: (ctx) => renameCmd(ctx.positionals[0], ctx.positionals[1]),
});
