import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { expect } from '../expect';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import {
    formatTitleToId,
    projectDir,
    removeDirRecursive,
    resolveProjectConfig,
    updateExperimentalScripts,
    updateProjectConfig,
} from '../helper';
import { log, verbose, warn } from '../logger';
import { hasFlag } from '../args';
import { resolveTemplateDir, scaffoldProject } from '../templateManager';

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
    --verbose        - Enable diagnostic output.`,
);

export function addCmd(modName: string, modId?: string) {
    // Validate params
    expect('param [modName]', modName, 'string');
    expect('param [modId]', modId, 'string|undefined');

    const projectPath = projectDir();
    const projectConfig = resolveProjectConfig();
    // Check if we are in a project directory
    if (!projectConfig) {
        throw new Error(
            'You must execute this command within a project directory!',
        );
    }

    const isOffline = hasFlag('offline');
    const forceUpdate = hasFlag('force-update');

    // US2: Check for local .template-mod tier-0 guard
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
        templateModPath = resolveTemplateDir('mod', isOffline, forceUpdate);
        verbose(`Mod template path: ${templateModPath}`);
    }

    // Prepare mod id
    modId = formatTitleToId(modId ?? modName);

    // Check if mod already exists
    if (projectConfig.mods[modId] || existsSync(join(projectPath, modId))) {
        throw new Error(`A mod with id '${modId}' already exists!`);
    }

    // Copy mod template. Junctions are intentionally NOT used here: a mod
    // folder must diverge from its template, and the seeded local
    // .template-mod cache is the project's editable override — always copy.
    verbose(
        `Scaffolding mod from ${templateModPath} to ${join(projectPath, modId)}`,
    );

    // Ownership guard: the rollback below may only remove artifacts THIS
    // invocation created. The preflight above rejected an existing mod id
    // and directory, so nothing registered here is ever pre-existing.
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

        // Seed the local cache only when this invocation introduced it: a
        // pre-existing (possibly empty) .template-mod is never rolled back.
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

        // Update config
        projectConfig.mods[modId] = {
            name: modName,
            description: '',
        };
        updateProjectConfig(join(projectPath, 'project.json'), projectConfig);
    } catch (e) {
        // Roll back exactly what was created, newest first; a failed
        // cleanup must not mask the original error.
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

    // Run experimental scripts
    updateExperimentalScripts('addMod', projectPath, modId);

    // Done
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
