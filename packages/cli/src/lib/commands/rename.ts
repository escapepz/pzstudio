import { join, extname } from 'path';
import {
    existsSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
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
import { engineIo, info, log, verbose, warn } from '../logger';
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

function collectSubdirectoriesCarryingOldId(
    root: string,
    oldModId: string,
): string[] {
    const paths: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || !entry.isDirectory()) {
                continue;
            }
            const childPath = join(dir, entry.name);
            walk(childPath);
            if (entry.name.includes(oldModId)) {
                paths.push(childPath);
            }
        }
    };
    walk(root);
    return paths;
}

function warnSubdirectoriesCarryingOldId(
    paths: string[],
    oldModId: string,
): void {
    for (const path of paths) {
        warn(
            `subdirectory '${path}' still carries the old mod id '${oldModId}'`,
        );
    }
}

export function renameCmd(oldModId: string, newModId: string) {
    const projectPath = projectDir();
    const projectConfig = readProjectConfig(undefined, true, engineIo());

    if (!projectConfig) {
        throw new CliError('No pzstudio project found.');
    }

    expect('param [oldModId]', oldModId, 'string');
    expect('param [newModId]', newModId, 'string');

    if (!projectConfig.mods[oldModId]) {
        throw new CliError(`Mod '${oldModId}' does not exist!`, {
            tryHint: `Run 'pzstudio list' to see the mods of this project.`,
        });
    }

    if (
        projectConfig.mods[newModId] ||
        existsSync(join(projectPath, newModId))
    ) {
        throw new Error(`A mod with id '${newModId}' already exists!`);
    }

    const oldPath = join(projectPath, oldModId);
    const newPath = join(projectPath, newModId);
    const folderExists = existsSync(oldPath);
    if (!folderExists && !existsSync(newPath)) {
        throw new Error(
            `Mod folder '${oldModId}' was not found on disk. Remove it from project.json instead (edit the file directly) or restore the folder before renaming.`,
        );
    }

    if (hasFlag('dry-run')) {
        if (folderExists) {
            log(`Would: rename folder '${oldPath}' to '${newPath}'`);
            log(
                `Would: rewrite occurrences of '${oldModId}' in the folder's text files with '${newModId}'`,
            );
            for (const path of collectSubdirectoriesCarryingOldId(
                oldPath,
                oldModId,
            )) {
                log(
                    `Would warn: subdirectory '${path}' still carries the old mod id '${oldModId}'`,
                );
            }
        }
        log(
            `Would: rename the project.json mods key '${oldModId}' to '${newModId}'`,
        );
        log('No files were changed.');
        return;
    }

    confirmDestructive(
        'rename',
        [oldModId, newModId],
        `Rename mod '${oldModId}' to '${newModId}' (folder + project.json key)?`,
    );

    if (folderExists) {
        info(`- Renaming mod '${oldModId}' to '${newModId}'...`);
        verbose(`Copying ${oldPath} to ${newPath}`);
        scaffoldProject(oldPath, newPath, false, false);
        verbose(`Removing old mod directory: ${oldPath}`);
        rmSync(oldPath, { force: true, recursive: true });
    }

    getFilesRecursively(newPath).forEach((file) => {
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

    warnSubdirectoriesCarryingOldId(
        collectSubdirectoriesCarryingOldId(newPath, oldModId),
        oldModId,
    );

    projectConfig.mods[newModId] = projectConfig.mods[oldModId];
    delete projectConfig.mods[oldModId];
    if (projectConfig.excludes.includes(oldModId)) {
        projectConfig.excludes = projectConfig.excludes.map((id) =>
            id === oldModId ? newModId : id,
        );
    }
    updateProjectConfig(join(projectPath, 'project.json'), projectConfig);
    log(`- Mod '${oldModId}' updated to '${newModId}' in project.json!`);

    updateExperimentalScripts('renameMod', projectPath, oldModId, newModId);
}

registerCommand({
    name: 'rename',
    summary: 'Rename a mod id from your project.',
    positionals: [
        { name: 'oldModId', required: true },
        { name: 'newModId', required: true },
    ],
    flags: [{ name: 'dry-run' }],
    run: (ctx) => renameCmd(ctx.positionals[0], ctx.positionals[1]),
});
