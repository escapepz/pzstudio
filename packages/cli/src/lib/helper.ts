import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'fs';
import {
    IProjectConfig,
    IVsCodeSettings,
    ModSourceState,
    PlanBuildInput,
    TemplateCategory,
    ITemplateConfig,
} from '@pzstudio/core';
import { emitWarn, emitVerbose, engineIo, info, warn, verbose } from './logger';
import { CliError } from './errors';
import {
    getActiveInvocationContext,
    type IoScope,
    type PzStudioHostSettings,
    type PzStudioLogger,
} from './invocation';
import {
    GlobalConfig,
    readGlobalConfig,
    writeGlobalConfig,
} from './templateManager';
import {
    ValidationContext,
    validateProject,
    migration,
    applyProjectDefaults as applyProjectDefaultsPure,
    type MigrationHostOptions,
} from '@pzstudio/core';

export function migrationHostOptions(): MigrationHostOptions {
    return {
        readBackupOutdir: () => {
            const backupPath = join(homedir(), '.pzstudio', '.pzstudio.bak');
            if (!existsSync(backupPath)) return undefined;
            try {
                return readFileSync(backupPath, 'utf-8').trim() || undefined;
            } catch {
                return undefined;
            }
        },
        defaultOutdir: join(homedir(), 'Zomboid', 'Workshop'),
    };
}

let vscodeWorkspaceSettings: IVsCodeSettings | undefined;
let vscodeUserSettings: IVsCodeSettings | undefined;

export function setVsCodeSettings(
    workspaceSettings?: IVsCodeSettings,
    userSettings?: IVsCodeSettings,
) {
    vscodeWorkspaceSettings = workspaceSettings;
    vscodeUserSettings = userSettings;
}

export function getVsCodeSettings(): IVsCodeSettings | undefined {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        const wsTemplates = ctx.settings?.workspace?.templates || {};
        const userTemplates = ctx.settings?.user?.templates || {};

        const templates: Partial<Record<TemplateCategory, ITemplateConfig>> =
            {};
        for (const cat of [
            'project',
            'mod',
            'workshop',
            'language',
        ] as TemplateCategory[]) {
            const val = wsTemplates[cat] ?? userTemplates[cat];
            if (val) templates[cat] = val;
        }

        return {
            templates:
                Object.keys(templates).length > 0 ? templates : undefined,
            outdir:
                ctx.settings?.workspace?.outdir ?? ctx.settings?.user?.outdir,
            useSymlinks:
                ctx.settings?.workspace?.useSymlinks ??
                ctx.settings?.user?.useSymlinks,
        };
    }

    if (!vscodeWorkspaceSettings && !vscodeUserSettings) return undefined;

    const wsTemplates = vscodeWorkspaceSettings?.templates || {};
    const userTemplates = vscodeUserSettings?.templates || {};

    const templates: Partial<Record<TemplateCategory, ITemplateConfig>> = {};
    for (const cat of [
        'project',
        'mod',
        'workshop',
        'language',
    ] as TemplateCategory[]) {
        const val = wsTemplates[cat] ?? userTemplates[cat];
        if (val) templates[cat] = val;
    }

    return {
        templates: Object.keys(templates).length > 0 ? templates : undefined,
        outdir: vscodeWorkspaceSettings?.outdir ?? vscodeUserSettings?.outdir,
        useSymlinks:
            vscodeWorkspaceSettings?.useSymlinks ??
            vscodeUserSettings?.useSymlinks,
    };
}

export function getResolvedTemplates(
    globalConfig: GlobalConfig,
): Partial<Record<TemplateCategory, ITemplateConfig>> | undefined {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        const wsTemplates = ctx.settings?.workspace?.templates || {};
        const userTemplates = ctx.settings?.user?.templates || {};
        const globalTemplates = globalConfig.templates || {};

        const merged: Partial<Record<TemplateCategory, ITemplateConfig>> = {};
        for (const cat of [
            'project',
            'mod',
            'workshop',
            'language',
        ] as TemplateCategory[]) {
            const val =
                wsTemplates[cat] ?? userTemplates[cat] ?? globalTemplates[cat];
            if (val) merged[cat] = val;
        }

        return merged;
    }

    const wsTemplates = vscodeWorkspaceSettings?.templates || {};
    const userTemplates = vscodeUserSettings?.templates || {};
    const globalTemplates = globalConfig.templates || {};

    const merged: Partial<Record<TemplateCategory, ITemplateConfig>> = {};
    for (const cat of [
        'project',
        'mod',
        'workshop',
        'language',
    ] as TemplateCategory[]) {
        const val =
            wsTemplates[cat] ?? userTemplates[cat] ?? globalTemplates[cat];
        if (val) merged[cat] = val;
    }

    return merged;
}

export function getResolvedUseSymlinks(
    globalConfig: GlobalConfig,
): boolean | undefined {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        return (
            ctx.settings?.workspace?.useSymlinks ??
            ctx.settings?.user?.useSymlinks ??
            globalConfig.useSymlinks
        );
    }
    return (
        vscodeWorkspaceSettings?.useSymlinks ??
        vscodeUserSettings?.useSymlinks ??
        globalConfig.useSymlinks
    );
}

export function legacySettings(): PzStudioHostSettings | undefined {
    if (!vscodeWorkspaceSettings && !vscodeUserSettings) return undefined;
    return {
        workspace: vscodeWorkspaceSettings,
        user: vscodeUserSettings,
    };
}

export function mergeHostSettingsLayers(
    settings: PzStudioHostSettings | undefined,
): IVsCodeSettings | undefined {
    if (!settings) return undefined;

    const wsTemplates = settings.workspace?.templates || {};
    const userTemplates = settings.user?.templates || {};

    const templates: Partial<Record<TemplateCategory, ITemplateConfig>> = {};
    for (const cat of [
        'project',
        'mod',
        'workshop',
        'language',
    ] as TemplateCategory[]) {
        const val = wsTemplates[cat] ?? userTemplates[cat];
        if (val) templates[cat] = val;
    }

    return {
        templates: Object.keys(templates).length > 0 ? templates : undefined,
        outdir: settings.workspace?.outdir ?? settings.user?.outdir,
        useSymlinks:
            settings.workspace?.useSymlinks ?? settings.user?.useSymlinks,
    };
}

export function removeDirRecursive(target: string): void {
    try {
        rmSync(target, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
        });
    } catch (e) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code;
        if (
            code === 'ENOTEMPTY' ||
            code === 'EBUSY' ||
            code === 'EPERM' ||
            code === 'EACCES'
        ) {
            throw new Error(
                `Cannot delete '${target}' — the folder is in use by another program (the game, Steam, or Explorer). Close it and try again.`,
                { cause: e },
            );
        }
        throw e;
    }
}

export function resolveProjectConfig(): IProjectConfig | undefined {
    const io = engineIo();
    const project = readProjectConfig(undefined, true, io);
    if (!project) return undefined;

    const global = readGlobalConfig(false, io);

    return {
        ...project,
        outdir: getOutDir(project, global, undefined, io),
    };
}

export function resolveProjectConfigFor(
    dir: string,
    settings?: PzStudioHostSettings | undefined,
    io?: IoScope | undefined,
): IProjectConfig | undefined {
    const start = findProjectRoot(dir);
    if (!start) {
        throw new CliError('No pzstudio project found.', {
            cause: `Searched from '${dir}' up to the filesystem root for a project.json.`,
            tryHint: `Run 'pzstudio new <title>' to create a project, or point at one with 'pzstudio -C <dir> <command>'.`,
        });
    }
    const project = readProjectConfig(join(start, 'project.json'), true, io);
    if (!project) return undefined;

    const global = readGlobalConfig(false, io);

    return {
        ...project,
        outdir: getOutDir(project, global, {
            projectDir: start,
            settings,
            logger: io?.logger,
        }),
    };
}

let externalProjectDir: string | undefined;
let projectRootAnchor: string | undefined;

export function setProjectDir(dir: string | undefined) {
    externalProjectDir = dir;
}

export function getExternalProjectDir(): string | undefined {
    return externalProjectDir;
}

export function setProjectRootAnchor(dir: string | undefined) {
    projectRootAnchor = dir;
}

export function discoveryStartDir(): string {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        return ctx.anchor ?? ctx.projectDir ?? process.cwd();
    }
    return projectRootAnchor ?? externalProjectDir ?? process.cwd();
}

export function findProjectRoot(startDir: string): string | undefined {
    let currentDir = startDir;
    while (true) {
        if (existsSync(join(currentDir, 'project.json'))) {
            return currentDir;
        }
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir) {
            break;
        }
        currentDir = parentDir;
    }
    return undefined;
}

export function findProjectDir(): string | undefined {
    return findProjectRoot(discoveryStartDir());
}

export function projectDir(): string {
    const start = discoveryStartDir();
    const found = findProjectRoot(start);
    if (!found) {
        throw new CliError('No pzstudio project found.', {
            cause: `Searched from '${start}' up to the filesystem root for a project.json.`,
            tryHint: `Run 'pzstudio new <title>' to create a project, or point at one with 'pzstudio -C <dir> <command>'.`,
        });
    }
    return found;
}

export function legacyDiscoveryStart(): string | undefined {
    return projectRootAnchor ?? externalProjectDir;
}

export function legacyProjectDir(): string {
    const start = legacyDiscoveryStart() ?? process.cwd();
    const found = findProjectRoot(start);
    if (!found) {
        throw new CliError('No pzstudio project found.', {
            cause: `Searched from '${start}' up to the filesystem root for a project.json.`,
            tryHint: `Run 'pzstudio new <title>' to create a project, or point at one with 'pzstudio -C <dir> <command>'.`,
        });
    }
    return found;
}

export function readProjectConfig(
    path?: string,
    validate: boolean = true,
    io?: IoScope | undefined,
): IProjectConfig | undefined {
    const configPath = path ?? join(projectDir(), 'project.json');
    if (!existsSync(configPath)) return undefined;

    const content = readFileSync(configPath, 'utf8');
    let config: any;
    try {
        config = JSON.parse(content);
    } catch (err) {
        throw new Error(
            `Failed to parse '${basename(configPath)}': ${(err as Error).message}. Fix the JSON syntax and try again.`,
            { cause: err },
        );
    }

    if (validate) {
        const migrationCheck = migration.checkProject(config);
        if (migrationCheck.needsMigration) {
            emitWarn(
                io,
                `[MIGRATION] ${basename(configPath)} needs migration: ${migrationCheck.reason}`,
            );
            config = migration.upgradeProject(config, {
                onNotice: (message) => emitWarn(io, `[MIGRATION] ${message}`),
            });
        }

        const context = new ValidationContext(basename(configPath));
        validateProject(config, context);
        if (context.hasErrors()) {
            throw new Error(
                `Validation failed for ${basename(configPath)}:\n${context.formatErrors()}`,
            );
        }
    }

    return applyProjectDefaults(config, io);
}

export function applyProjectDefaults(
    config: any,
    io?: IoScope | undefined,
): IProjectConfig {
    return applyProjectDefaultsPure(config, (message) =>
        emitVerbose(io, message),
    );
}

export function atomicWriteJson(
    filePath: string,
    updated: any,
    overwrite: boolean = false,
) {
    let finalContent = updated;

    if (!overwrite && existsSync(filePath)) {
        try {
            const existing = JSON.parse(readFileSync(filePath, 'utf8'));
            finalContent = { ...existing, ...updated };
        } catch (_e) {}
    }

    if (
        basename(filePath) === 'project.json' &&
        finalContent.useSymlinks !== undefined
    ) {
        delete finalContent.useSymlinks;
    }

    const content = JSON.stringify(finalContent, null, 4);
    const tempPath = `${filePath}.tmp`;

    try {
        writeFileSync(tempPath, content, 'utf8');
        try {
            // Atomic on the same volume; renameSync overwrites on POSIX
            // but not on Windows, so remove the target first.
            rmSync(filePath, { force: true });
            renameSync(tempPath, filePath);
        } catch (_e) {
            rmSync(tempPath, { force: true });
            writeFileSync(filePath, content, 'utf8');
        }
    } catch (_e) {
        writeFileSync(filePath, content, 'utf8');
    }
}

export function readRawProjectOutdir(projectPath: string): string | undefined {
    const configPath = join(projectPath, 'project.json');
    if (!existsSync(configPath)) {
        throw new Error(
            `Cannot snapshot the configured 'outdir': '${basename(configPath)}' is missing. ` +
                'Aborting without changes to avoid discarding the configured outdir.',
        );
    }

    let content: string;
    try {
        content = readFileSync(configPath, 'utf8');
    } catch (err) {
        throw new Error(
            `Cannot snapshot the configured 'outdir': reading '${basename(configPath)}' failed: ${(err as Error).message}. ` +
                'Aborting without changes to avoid discarding the configured outdir.',
            { cause: err },
        );
    }

    let parsed: any;
    try {
        parsed = JSON.parse(content);
    } catch (err) {
        throw new Error(
            `Cannot snapshot the configured 'outdir': '${basename(configPath)}' is not valid JSON: ${(err as Error).message}. ` +
                'Aborting without changes to avoid discarding the configured outdir.',
            { cause: err },
        );
    }

    if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
    ) {
        throw new Error(
            `Cannot snapshot the configured 'outdir': '${basename(configPath)}' does not contain a project config object. ` +
                'Aborting without changes to avoid discarding the configured outdir.',
        );
    }

    if (parsed.outdir === undefined) return undefined;
    if (typeof parsed.outdir !== 'string') {
        throw new Error(
            `Cannot snapshot the configured 'outdir': '${basename(configPath)}' has a non-string 'outdir'. ` +
                'Aborting without changes to avoid discarding the configured outdir.',
        );
    }
    return parsed.outdir;
}

export function updateProjectConfig(
    path: string,
    updatedConfig: IProjectConfig,
    overwrite: boolean = false,
) {
    if (!existsSync(path)) {
        throw new Error('The given path does not exist!');
    }

    atomicWriteJson(path, updatedConfig, overwrite);
}

export { formatTitleToId } from '@pzstudio/core';

export function getFilesRecursively(dir: string, filelist: string[] = []) {
    readdirSync(dir).forEach((file) => {
        filelist = statSync(join(dir, file)).isDirectory()
            ? getFilesRecursively(join(dir, file), filelist)
            : filelist.concat(join(dir, file));
    });
    return filelist;
}

export function migrateStoreDirIfNeeded() {
    const storeDir = join(homedir(), '.pzstudio');

    if (existsSync(storeDir) && statSync(storeDir).isFile()) {
        try {
            const outDirContent = readFileSync(storeDir, 'utf8').trim();

            rmSync(storeDir);
            mkdirSync(storeDir, { recursive: true });

            const backupPath = join(storeDir, '.pzstudio.bak');
            writeFileSync(backupPath, outDirContent);

            const config = readGlobalConfig(true, engineIo());
            config.outdir = outDirContent;
            writeGlobalConfig(config);

            info(`- Migrated legacy .pzstudio file to directory structure`);
        } catch (e) {
            warn(`Failed to migrate legacy store: ${e}`);
        }
    }
}

export function getStoreDir() {
    return join(homedir(), '.pzstudio');
}

export interface OutDirScope {
    projectDir: string;
    settings?: PzStudioHostSettings | undefined;
    logger?: PzStudioLogger | undefined;
}

export const DIST_DIR_NAME = 'dist';

export function distRootOf(projectPath: string): string {
    return join(resolve(projectPath), DIST_DIR_NAME);
}

export function expandOutdirToken(raw: string): string {
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
        return join(homedir(), raw.slice(1));
    }
    return raw;
}

export function getOutDir(
    project?: IProjectConfig,
    config?: GlobalConfig,
    scope?: OutDirScope,
    io?: IoScope | undefined,
): string | undefined {
    if (scope) {
        const io: IoScope | undefined = scope.logger
            ? { logger: scope.logger }
            : undefined;

        if (project && project.outdir) {
            return resolve(scope.projectDir, expandOutdirToken(project.outdir));
        }

        if (scope.settings?.workspace?.outdir) {
            return resolve(expandOutdirToken(scope.settings.workspace.outdir));
        }

        if (scope.settings?.user?.outdir) {
            return resolve(expandOutdirToken(scope.settings.user.outdir));
        }

        const global = config ?? readGlobalConfig(false, io);
        if (global.outdir) {
            return resolve(expandOutdirToken(global.outdir));
        }

        return undefined;
    }

    const ctx = getActiveInvocationContext();
    if (ctx) {
        if (project && project.outdir) {
            return resolve(projectDir(), expandOutdirToken(project.outdir));
        }

        if (ctx.settings?.workspace?.outdir) {
            return resolve(expandOutdirToken(ctx.settings.workspace.outdir));
        }

        if (ctx.settings?.user?.outdir) {
            return resolve(expandOutdirToken(ctx.settings.user.outdir));
        }

        const global = config ?? readGlobalConfig(false, io);
        if (global.outdir) {
            return resolve(expandOutdirToken(global.outdir));
        }

        return undefined;
    }

    if (project && project.outdir) {
        return resolve(projectDir(), expandOutdirToken(project.outdir));
    }

    if (vscodeWorkspaceSettings?.outdir) {
        return resolve(expandOutdirToken(vscodeWorkspaceSettings.outdir));
    }

    if (vscodeUserSettings?.outdir) {
        return resolve(expandOutdirToken(vscodeUserSettings.outdir));
    }

    const global = config ?? readGlobalConfig(false, io);
    if (global.outdir) {
        return resolve(expandOutdirToken(global.outdir));
    }

    return undefined;
}

export function readWorkshopDescriptionLines(projectPath: string): string[] {
    const workshopDescriptionPath = join(
        projectPath,
        'workshop',
        'description.txt',
    );
    if (!existsSync(workshopDescriptionPath)) return [];
    return readFileSync(workshopDescriptionPath, {
        encoding: 'utf-8',
    }).split(/\r?\n/);
}

export function gatherModSourceState(
    projectPath: string,
    modId: string,
): ModSourceState {
    const state: ModSourceState = {
        branchFolders: [],
        modInfoExists: {},
        modInfoContent: {},
    };

    const snapshotTarget = (target: string, targetDir: string) => {
        const modInfoPath = join(targetDir, 'mod.info');
        state.modInfoExists[target] = existsSync(modInfoPath);
        if (!state.modInfoExists[target]) {
            return;
        }
        try {
            state.modInfoContent![target] = readFileSync(modInfoPath, 'utf8');
        } catch {}
    };

    snapshotTarget('', join(projectPath, modId));
    for (const branchPath of resolveModInfoTargets(modId, projectPath)) {
        const branchName = basename(branchPath);
        state.branchFolders.push(branchName);
        snapshotTarget(branchName, branchPath);
    }
    return state;
}

export function gatherPlanInput(
    projectPath: string,
    config: IProjectConfig,
    workshopTemplateDir: string,
): Omit<PlanBuildInput, 'variant'> {
    const modSourceStates: Record<string, ModSourceState> = {};
    for (const modId of Object.keys(config.mods)) {
        modSourceStates[modId] = gatherModSourceState(projectPath, modId);
    }

    return {
        config: { ...config, outdir: distRootOf(projectPath) },
        workshopTemplateDir,
        projectDir: projectPath,
        modSourceStates,
        descriptionLines: readWorkshopDescriptionLines(projectPath),
        previewPngExists: existsSync(
            join(projectPath, 'workshop', 'preview.png'),
        ),
    };
}

export function generateWorkshopText(
    config: IProjectConfig,
    overrideVisibility?: string,
    excludeId: boolean = false,
    titleSuffix?: string,
) {
    return workshopText(config, {
        descriptionLines: readWorkshopDescriptionLines(projectDir()),
        overrideVisibility,
        excludeId,
        titleSuffix,
    });
}

export function generateModInfoText(
    modId: string,
    config: IProjectConfig,
    prefixedId?: string,
) {
    return modInfoText(modId, config, prefixedId);
}

export { parseModInfoText } from '@pzstudio/core';
import { workshopText, modInfoText } from '@pzstudio/core';

export function getModBranchFolders(
    modId: string,
    baseDir: string = legacyProjectDir(),
): string[] {
    const modDir = join(baseDir, modId);
    if (!existsSync(modDir)) return [];

    try {
        return readdirSync(modDir)
            .map((child) => join(modDir, child))
            .filter((childPath) => statSync(childPath).isDirectory());
    } catch (_e) {
        return [];
    }
}

export function resolveModInfoTargets(
    modId: string,
    baseDir: string = legacyProjectDir(),
): string[] {
    const branchFolders = getModBranchFolders(modId, baseDir);
    return branchFolders.filter((folder) => {
        const mediaPath = join(folder, 'media');
        return existsSync(mediaPath) && statSync(mediaPath).isDirectory();
    });
}

export function isExperimentalIntegrationEnabled(projectPath: string): boolean {
    const io = engineIo();
    const project = readProjectConfig(
        join(projectPath, 'project.json'),
        false,
        io,
    );
    const projectValue = project?.experimental?.integration;
    if (projectValue !== undefined) return projectValue === true;

    const globalValue = readGlobalConfig(false, io).experimental?.integration;
    if (globalValue !== undefined) return globalValue === true;

    return false;
}

export function updateExperimentalScripts(
    action: 'addProject' | 'addMod' | 'removeMod' | 'renameMod',
    projectDir: string,
    modId?: string,
    newModId?: string,
) {
    try {
        if (!isExperimentalIntegrationEnabled(projectDir)) {
            verbose(
                'Experimental integration is disabled (default). Set experimental.integration = true in project.json (or the global config) to enable it.',
            );
            return;
        }

        const scriptCandidates = [
            resolve(__dirname, 'scripts/experimental-package-scripts.js'),
            resolve(__dirname, '../scripts/experimental-package-scripts.js'),
            resolve(__dirname, '../../scripts/experimental-package-scripts.js'),
        ];
        const scriptPath = scriptCandidates.find((p) => existsSync(p));
        if (!scriptPath) {
            return;
        }

        const script = require(scriptPath);

        switch (action) {
            case 'addProject':
                if (script.addProjectScripts)
                    script.addProjectScripts(projectDir);
                break;
            case 'addMod':
                if (script.addModScripts && modId)
                    script.addModScripts(projectDir, modId);
                break;
            case 'removeMod':
                if (script.removeModScripts && modId)
                    script.removeModScripts(projectDir, modId);
                break;
            case 'renameMod':
                if (script.renameModScripts && modId && newModId)
                    script.renameModScripts(projectDir, modId, newModId);
                break;
        }
    } catch (e) {
        warn(`Failed to run experimental script: ${e}`);
    }
}
