import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { expect } from '../expect';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import {
    formatTitleToId,
    projectDir,
    readRawProjectOutdir,
    removeDirRecursive,
    resolveProjectConfig,
    updateExperimentalScripts,
    updateProjectConfig,
} from '../helper';
import { log, verbose, warn } from '../logger';
import { hasFlag } from '../args';
import { CliError } from '../errors';
import { CliUsageError } from '../parser';
import {
    resolveTemplateDirForEngine,
    scaffoldProject,
} from '../templateManager';

addHelp(
    'add',
    `Add a mod to your project.

    Usages:
        pzstudio add <modName> - Add a mod to your project.
        pzstudio add <modName> <modId> - Add a mod to your project.

    Flags:
    --offline        - Bypass network updates and use local cache or legacy templates.
    --force-update   - Force refresh of cached templates from remote.
    --transport <git|fetch> - Template download method (default: git when available, else fetch).
    --verbose        - Enable diagnostic output.

    Note:
    --yes is not applicable to add (nothing to confirm; only delete and rename use it).`,
);

export function addCmd(modName: string, modId?: string) {
    if (hasFlag('yes')) {
        throw new CliUsageError(
            'The --yes flag is not applicable to command [add]: add is not destructive, so there is nothing to confirm (only delete and rename use it).',
        );
    }

    expect('param [modName]', modName, 'string');
    expect('param [modId]', modId, 'string|undefined');

    const projectPath = projectDir();
    const projectConfig = resolveProjectConfig();
    if (!projectConfig) {
        throw new CliError('No pzstudio project found.');
    }

    const isOffline = hasFlag('offline');
    const forceUpdate = hasFlag('force-update');

    const localTemplatePath = join(projectPath, '.template-mod');
    let templateModPath: string;
    let usedLocalTemplate = false;

    if (
        existsSync(localTemplatePath) &&
        readdirSync(localTemplatePath).length > 0
    ) {
        templateModPath = localTemplatePath;
        usedLocalTemplate = true;
        verbose(`Using local .template-mod from project root`);
    } else {
        verbose(`Resolving remote/default mod template...`);
        templateModPath = resolveTemplateDirForEngine(
            'mod',
            isOffline,
            forceUpdate,
        );
        verbose(`Mod template path: ${templateModPath}`);
    }

    const typedModId = modId;
    modId = formatTitleToId(modId || modName);

    if (!modId) {
        throw new CliError(
            `Cannot derive a valid mod id from '${modName}' (the result would be empty).`,
            {
                tryHint:
                    'Use a name or id containing letters, digits or underscores.',
            },
        );
    }

    if (projectConfig.mods[modId] || existsSync(join(projectPath, modId))) {
        const typedNote =
            typedModId && typedModId !== modId
                ? ` (you typed '${typedModId}' — ids are normalized to lowercase with underscores)`
                : '';
        throw new CliError(
            `A mod with id '${modId}' already exists!${typedNote}`,
        );
    }

    const rawOutdir = readRawProjectOutdir(projectPath);

    verbose(
        `Scaffolding mod from ${templateModPath} to ${join(projectPath, modId)}`,
    );

    const createdPaths: string[] = [];
    try {
        scaffoldProject(
            templateModPath,
            join(projectPath, modId),
            false,
            false,
            {
                excludeIgnoreFile: true,
                ignoreDotFiles: false,
            },
        );
        createdPaths.push(join(projectPath, modId));

        if (!usedLocalTemplate) {
            const cacheExisted = existsSync(localTemplatePath);
            scaffoldProject(templateModPath, localTemplatePath, false, false, {
                excludeIgnoreFile: true,
                ignoreDotFiles: false,
            });
            if (!cacheExisted) {
                createdPaths.push(localTemplatePath);
            }
        }

        projectConfig.mods[modId] = {
            name: modName,
            description: '',
        };
        projectConfig.outdir = rawOutdir;
        updateProjectConfig(join(projectPath, 'project.json'), projectConfig);
    } catch (e) {
        for (const created of createdPaths.reverse()) {
            try {
                removeDirRecursive(created);
                verbose(`Rolled back: ${created}`);
            } catch (_cleanup) {
                warn(`Failed to roll back '${created}'; remove it manually.`);
            }
        }
        throw e;
    }

    updateExperimentalScripts('addMod', projectPath, modId);

    log(`Added mod '${modName}' with id '${modId}'`);
}

registerCommand({
    name: 'add',
    summary: 'Add a mod to your project.',
    flags: [{ name: 'offline' }, { name: 'force-update' }],
    positionals: [
        { name: 'modName', required: true },
        { name: 'modId', required: false },
    ],
    run: (ctx) => addCmd(ctx.positionals[0], ctx.positionals[1]),
});
