import { existsSync, readdirSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import { expect } from '../expect';
import { CliError } from '../errors';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import {
    formatTitleToId,
    discoveryStartDir,
    findProjectDir,
    readProjectConfig,
    removeDirRecursive,
    resolveProjectConfig,
    updateExperimentalScripts,
    updateProjectConfig,
} from '../helper';
import { info, log, verbose, warn } from '../logger';
import { extractFlag, hasFlag } from '../args';
import {
    resolveTemplateDir,
    readGlobalConfig,
    scaffoldProject,
    scaffoldTemplateFolder,
} from '../templateManager';

addHelp(
    'new',
    `Create a new project.

    Usages:
    pzstudio new <projectTitle>         - Create a new project with the given title and automatically formatted mod id.
    pzstudio new <projectTitle> <modId> - Create a new project with the given title and mod id.

    Flags:
    --offline              - Bypass network updates and use local cache or legacy templates.
    --force-update         - Force refresh of cached templates from remote.
    --symlinks             - Use directory junctions for template folders (if supported).
    --path <destination>   - Create the project in the given directory instead of the current one.
    --transport <git|fetch> - Template download method (default: git when available, else fetch).`,
);

export async function newCmd(projectTitle: string, modId?: string) {
    // Validate params
    expect('param [projectTitle]', projectTitle, 'string');
    expect('param [modId]', modId, 'string|undefined');

    const isOffline = hasFlag('offline');
    const forceUpdate = hasFlag('force-update');

    // Destination: --path wins over the discovery start (issue #43; -C also
    // steers the default destination since it replaces the discovery start).
    const destFlag = extractFlag('path');
    const destDir = destFlag ? resolve(destFlag) : discoveryStartDir();
    verbose(`Project destination directory: ${destDir}`);

    // The "inside a project" guard only applies to discovery-based creation;
    // with an explicit --path the user already chose the destination. Use
    // non-throwing discovery so creating a project OUTSIDE any project keeps
    // working (fail-closed projectDir() would kill it).
    if (!destFlag) {
        const existingProject = findProjectDir()
            ? resolveProjectConfig()
            : undefined;
        if (existingProject) {
            throw new Error(
                'You cannot execute this command within a project directory!',
            );
        }
    }

    const useSymlinks =
        hasFlag('symlinks') || readGlobalConfig(false).useSymlinks;

    const templateProjectPath = resolveTemplateDir(
        'project',
        isOffline,
        forceUpdate,
    );

    // Prepare mod id
    modId = formatTitleToId(modId || projectTitle);
    if (!modId) {
        throw new Error(
            `Cannot derive a valid mod id from '${modId || projectTitle}': it must contain at least one letter or digit.`,
        );
    }

    // Check if project already exists
    const projectPath = join(destDir, modId);
    if (existsSync(projectPath)) {
        throw new Error(
            `The project '${projectTitle}' dir '${modId}' already exists!`,
        );
    }

    // US2: Check for local templates in current working directory (parent of new project)
    const cwdTemplateModPath = join(process.cwd(), '.template-mod');
    const cwdTemplateWorkshopPath = join(process.cwd(), '.template-workshop');

    let templateModPath: string;
    if (
        existsSync(cwdTemplateModPath) &&
        readdirSync(cwdTemplateModPath).length > 0
    ) {
        templateModPath = cwdTemplateModPath;
        verbose(`Using local .template-mod from CWD`);
    } else {
        templateModPath = resolveTemplateDir('mod', isOffline, forceUpdate);
    }

    let templateWorkshopPath: string;
    if (
        existsSync(cwdTemplateWorkshopPath) &&
        readdirSync(cwdTemplateWorkshopPath).length > 0
    ) {
        templateWorkshopPath = cwdTemplateWorkshopPath;
        verbose(`Using local .template-workshop from CWD`);
    } else {
        templateWorkshopPath = resolveTemplateDir(
            'workshop',
            isOffline,
            forceUpdate,
        );
    }

    const templateLanguagePath = resolveTemplateDir(
        'language',
        isOffline,
        forceUpdate,
    );

    log(`- Creating project '${projectTitle}' dir '${modId}' ...`);

    // PRE-COMMIT: everything is scaffolded into a staging directory next to
    // the destination (same parent, same volume), so the commit below is an
    // atomic rename. The destination path does not exist until the rename.
    const stagingPath = join(
        destDir,
        `.${modId}.staging-${Date.now().toString(36)}`,
    );

    try {
        scaffoldProject(templateProjectPath, stagingPath, useSymlinks, false, {
            ignoreItems: ['.libraries'],
        });

        // Copy mod template into the project mod folder
        log(`- Creating mod '${modId}'...`);
        scaffoldProject(templateModPath, join(stagingPath, modId), useSymlinks);

        // Link or copy shared template folders
        log(`- Creating shared template folders...`);

        scaffoldTemplateFolder(
            templateModPath,
            join(stagingPath, '.template-mod'),
            useSymlinks,
        );

        scaffoldTemplateFolder(
            templateLanguagePath,
            join(stagingPath, '.template-language'),
            useSymlinks,
        );

        const templateLibrariesPath = join(templateProjectPath, '.libraries');
        if (existsSync(templateLibrariesPath)) {
            scaffoldTemplateFolder(
                templateLibrariesPath,
                join(stagingPath, '.libraries'),
                useSymlinks,
            );
        }

        // Copy workshop template
        log(`- Creating workshop folder...`);
        scaffoldProject(
            templateWorkshopPath,
            join(stagingPath, 'workshop'),
            useSymlinks,
        );

        // Update config — validated inside the staging copy so an incomplete
        // scaffold never reaches the commit.
        log(`- Updating project config...`);
        const newProjectConfigPath = join(stagingPath, 'project.json');
        const newProjectConfig = readProjectConfig(newProjectConfigPath);
        if (!newProjectConfig) {
            throw new Error(
                `The project template did not produce a valid '${newProjectConfigPath}'.`,
            );
        }
        newProjectConfig.workshop.title = projectTitle;
        newProjectConfig.mods[modId] = {
            name: projectTitle,
            description: '',
        };
        updateProjectConfig(newProjectConfigPath, newProjectConfig);

        // COMMIT: atomic same-volume rename — the destination only starts
        // existing here.
        renameSync(stagingPath, projectPath);
    } catch (e) {
        // PRE-COMMIT failure: the staging directory belongs to this
        // invocation — remove it and leave the destination untouched.
        try {
            removeDirRecursive(stagingPath);
            verbose(`Removed staging directory: ${stagingPath}`);
        } catch (_cleanup) {
            warn(`Failed to remove staging directory '${stagingPath}'.`);
        }
        throw new CliError('No project was created.', {
            cause: e instanceof Error ? e.message : String(e),
            tryHint: 'Fix the reported cause, then run pzstudio new again.',
        });
    }

    // POST-COMMIT: hooks are non-fatal by policy (updateExperimentalScripts
    // swallows script failures); a failure past the commit never claims
    // rollback.
    updateExperimentalScripts('addProject', projectPath);
    updateExperimentalScripts('addMod', projectPath, modId);

    // Done
    info(`The project '${projectTitle}' has been created at '${projectPath}'`);

    // Golden path (CLI-7): tell the user what to do next — verify with
    // doctor, then start the Development Sync Engine.
    log(
        `Next: cd '${projectPath}' then run 'pzstudio doctor' to verify the project and 'pzstudio watch' to start developing.`,
    );
}

registerCommand({
    name: 'new',
    summary: 'Create a new project.',
    flags: [
        { name: 'path', takesValue: true },
        { name: 'offline' },
        { name: 'force-update' },
        { name: 'symlinks' },
    ],
    positionals: [
        { name: 'title', required: true },
        { name: 'modId', required: false },
    ],
    run: (ctx) => newCmd(ctx.positionals[0], ctx.positionals[1]),
});
