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

/** One planned subdirectory rename: `<from>` carries the old mod id. */
interface SubdirectoryRenamePlan {
    from: string;
    to: string;
}

/**
 * Walks the mod tree and collects every directory whose NAME carries the
 * old mod id (sweep d14-B5). The PZ lua convention names the per-context
 * folders under `media/lua/{server,client,shared}/` after the mod id, so a
 * rename that only rewrites file contents leaves `server/<old-id>/` behind
 * and the built mod silently loses its server init. Replacement uses the
 * same replaceAll semantics as the file-content rewrite, so nested
 * occurrences (`<old-id>_patch`) rename too. Link entries are never
 * touched. The plan comes back deepest-first: a child renames before its
 * parent, so no collected path goes stale mid-execution.
 */
function planSubdirectoryRenames(
    root: string,
    oldModId: string,
    newModId: string,
): SubdirectoryRenamePlan[] {
    const plan: SubdirectoryRenamePlan[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            // Links are user state (a junction/symlink entry is never a
            // directory to move): renaming a link would retarget it.
            if (entry.isSymbolicLink() || !entry.isDirectory()) {
                continue;
            }
            const childPath = join(dir, entry.name);
            walk(childPath);
            if (entry.name.includes(oldModId)) {
                plan.push({
                    from: childPath,
                    to: join(dir, entry.name.replaceAll(oldModId, newModId)),
                });
            }
        }
    };
    walk(root);
    // Children first — every descendant path is longer than its ancestor's,
    // so descending length is exactly a children-before-parents order.
    plan.sort((a, b) => b.from.length - a.from.length);
    return plan;
}

/** Warns (never moves) for each directory still carrying the old mod id. */
function warnSubdirectoriesCarryingOldId(
    plan: SubdirectoryRenamePlan[],
    oldModId: string,
): void {
    for (const step of plan) {
        warn(
            `subdirectory '${step.from}' still carries the old mod id '${oldModId}'`,
        );
    }
}

export function renameCmd(oldModId: string, newModId: string) {
    const projectPath = projectDir();
    const projectConfig = readProjectConfig(undefined, true, engineIo());

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
            for (const step of planSubdirectoryRenames(
                oldPath,
                oldModId,
                newModId,
            )) {
                log(
                    `Would warn: subdirectory '${step.from}' still carries the old mod id '${oldModId}'`,
                );
            }
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
        info(`- Renaming mod '${oldModId}' to '${newModId}'...`);
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

    // Sweep d14-B5 (owner re-decision): directory NAMES carry the mod id too
    // (the PZ lua convention names media/lua/{server,client,shared}/<modId>/
    // after the mod), but user-designed skeleton directories must NEVER be
    // moved — one stderr warn per directory still carrying the old id, and
    // the core rename behaves exactly as before.
    const subdirectoryPlan = planSubdirectoryRenames(
        newPath,
        oldModId,
        newModId,
    );
    warnSubdirectoriesCarryingOldId(subdirectoryPlan, oldModId);

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
    flags: [{ name: 'dry-run' }],
    run: (ctx) => renameCmd(ctx.positionals[0], ctx.positionals[1]),
});
