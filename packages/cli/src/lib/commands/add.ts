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
        throw new CliError('No pzstudio project found.');
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
        templateModPath = resolveTemplateDirForEngine(
            'mod',
            isOffline,
            forceUpdate,
        );
        verbose(`Mod template path: ${templateModPath}`);
    }

    // Prepare mod id (D1): an omitted or confirmed-empty mod id derives
    // from the mod name; an explicit non-empty id keeps its normalization.
    modId = formatTitleToId(modId || modName);

    // An id that normalizes to empty must never fall through to the
    // root-directory collision probe: join(projectPath, '') IS the project
    // root, so the empty id would read as "the root is already a mod".
    if (!modId) {
        throw new CliError(
            `Cannot derive a valid mod id from '${modName}' (the result would be empty).`,
            {
                tryHint:
                    'Use a name or id containing letters, digits or underscores.',
            },
        );
    }

    // Check if mod already exists
    if (projectConfig.mods[modId] || existsSync(join(projectPath, modId))) {
        throw new Error(`A mod with id '${modId}' already exists!`);
    }

    // D3-a fail-closed: snapshot the RAW configured outdir BEFORE any
    // filesystem mutation. If the config became unreadable since
    // resolveProjectConfig(), this throws here — before scaffoldProject
    // runs — instead of mid-try, where a swallowed failure would authorize
    // a write-back that discards the configured outdir.
    const rawOutdir = readRawProjectOutdir(projectPath);

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
        // D3-a: write back the RAW configured outdir captured above (before
        // scaffolding), never the runtime-resolved one resolveProjectConfig
        // merged in — a project without `outdir` stays without one, an
        // explicit one survives exactly (undefined is dropped by
        // JSON.stringify).
        projectConfig.outdir = rawOutdir;
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
