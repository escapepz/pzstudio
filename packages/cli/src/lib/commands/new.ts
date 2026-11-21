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
import { engineIo, info, log, verbose, warn } from '../logger';
import { extractFlag, hasFlag } from '../args';
import {
    resolveTemplateDirForEngine,
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
    expect('param [projectTitle]', projectTitle, 'string');
    expect('param [modId]', modId, 'string|undefined');

    const isOffline = hasFlag('offline');
    const forceUpdate = hasFlag('force-update');

    const destFlag = extractFlag('path');
    const destDir = destFlag ? resolve(destFlag) : discoveryStartDir();
    verbose(`Project destination directory: ${destDir}`);

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
        hasFlag('symlinks') || readGlobalConfig(false, engineIo()).useSymlinks;

    const templateProjectPath = resolveTemplateDirForEngine(
        'project',
        isOffline,
        forceUpdate,
    );

    modId = formatTitleToId(modId || projectTitle);
    if (!modId) {
        throw new Error(
            `Cannot derive a valid mod id from '${modId || projectTitle}': it must contain at least one letter or digit.`,
        );
    }

    const projectPath = join(destDir, modId);
    if (existsSync(projectPath)) {
        throw new Error(
            `The project '${projectTitle}' dir '${modId}' already exists!`,
        );
    }

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
        templateModPath = resolveTemplateDirForEngine(
            'mod',
            isOffline,
            forceUpdate,
        );
    }

    let templateWorkshopPath: string;
    if (
        existsSync(cwdTemplateWorkshopPath) &&
        readdirSync(cwdTemplateWorkshopPath).length > 0
    ) {
        templateWorkshopPath = cwdTemplateWorkshopPath;
        verbose(`Using local .template-workshop from CWD`);
    } else {
        templateWorkshopPath = resolveTemplateDirForEngine(
            'workshop',
            isOffline,
            forceUpdate,
        );
    }

    const templateLanguagePath = resolveTemplateDirForEngine(
        'language',
        isOffline,
        forceUpdate,
    );

    info(`- Creating project '${projectTitle}' dir '${modId}' ...`);

    const stagingPath = join(
        destDir,
        `.${modId}.staging-${Date.now().toString(36)}`,
    );

    try {
        scaffoldProject(templateProjectPath, stagingPath, useSymlinks, false, {
            ignoreItems: ['.libraries'],
        });

        info(`- Creating mod '${modId}'...`);
        scaffoldProject(templateModPath, join(stagingPath, modId), useSymlinks);

        info(`- Creating shared template folders...`);

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

        info(`- Creating workshop folder...`);
        scaffoldProject(
            templateWorkshopPath,
            join(stagingPath, 'workshop'),
            useSymlinks,
        );

        info(`- Updating project config...`);
        const newProjectConfigPath = join(stagingPath, 'project.json');
        const newProjectConfig = readProjectConfig(
            newProjectConfigPath,
            true,
            engineIo(),
        );
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
        newProjectConfig.outdir = '~/Zomboid/Workshop';
        updateProjectConfig(newProjectConfigPath, newProjectConfig);

        renameSync(stagingPath, projectPath);
    } catch (e) {
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

    updateExperimentalScripts('addProject', projectPath);
    updateExperimentalScripts('addMod', projectPath, modId);

    info(`The project '${projectTitle}' has been created at '${projectPath}'`);

    log(
        `Next: cd '${projectPath}'\n` +
            '\n' +
            'If installed globally:\n' +
            '    pzstudio doctor\n' +
            '    pzstudio watch\n' +
            '\n' +
            'Using npx:\n' +
            '    npx -y @pzstudio/cli@latest doctor\n' +
            '    npx -y @pzstudio/cli@latest watch',
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
