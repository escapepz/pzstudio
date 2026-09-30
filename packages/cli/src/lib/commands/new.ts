import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { expect } from '../expect';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import {
    formatTitleToId,
    projectDir,
    readProjectConfig,
    resolveProjectConfig,
    updateExperimentalScripts,
    updateProjectConfig,
} from '../helper';
import { info, log, verbose } from '../logger';
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

    // Destination: --path wins over the current working directory (issue #43)
    const destFlag = extractFlag('path');
    const destDir = destFlag ? resolve(destFlag) : projectDir();
    verbose(`Project destination directory: ${destDir}`);

    // The "inside a project" guard only applies to cwd-based creation;
    // with an explicit --path the user already chose the destination.
    if (!destFlag) {
        const existingProject = resolveProjectConfig();
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
    scaffoldProject(templateProjectPath, projectPath, useSymlinks, false, {
        ignoreItems: ['.libraries'],
    });

    // Copy mod template into the project mod folder
    log(`- Creating mod '${modId}'...`);
    scaffoldProject(templateModPath, join(projectPath, modId), useSymlinks);

    // Link or copy shared template folders
    log(`- Creating shared template folders...`);

    scaffoldTemplateFolder(
        templateModPath,
        join(projectPath, '.template-mod'),
        useSymlinks,
    );

    scaffoldTemplateFolder(
        templateLanguagePath,
        join(projectPath, '.template-language'),
        useSymlinks,
    );

    const templateLibrariesPath = join(templateProjectPath, '.libraries');
    if (existsSync(templateLibrariesPath)) {
        scaffoldTemplateFolder(
            templateLibrariesPath,
            join(projectPath, '.libraries'),
            useSymlinks,
        );
    }

    // Copy workshop template
    log(`- Creating workshop folder...`);
    scaffoldProject(
        templateWorkshopPath,
        join(projectPath, 'workshop'),
        useSymlinks,
    );

    // Update config
    log(`- Updating project config...`);
    const newProjectConfigPath = join(projectPath, 'project.json');
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

    // Run experimental scripts
    updateExperimentalScripts('addProject', projectPath);
    updateExperimentalScripts('addMod', projectPath, modId);

    // Done
    info(`The project '${projectTitle}' has been created at '${projectPath}'`);
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
