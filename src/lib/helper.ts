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
    TemplateCategory,
    ITemplateConfig,
} from './project';
import { log, warn, verbose } from './logger';
import {
    GlobalConfig,
    readGlobalConfig,
    writeGlobalConfig,
} from './templateManager';

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
    return (
        vscodeWorkspaceSettings?.useSymlinks ??
        vscodeUserSettings?.useSymlinks ??
        globalConfig.useSymlinks
    );
}

/**
 * Resolves the full project configuration by merging workspace and global settings.
 * Workspace (project.json) settings always take precedence.
 * @returns {IProjectConfig | undefined} The resolved configuration, or undefined if no project.json exists.
 */
export function resolveProjectConfig(): IProjectConfig | undefined {
    const project = readProjectConfig();
    if (!project) return undefined;

    const global = readGlobalConfig(false);

    return {
        ...project,
        outdir: getOutDir(project, global),
    };
}

let externalProjectDir: string | undefined;

/**
 * Sets the project working directory externally (e.g. from VS Code)
 * @param dir The directory path
 */
export function setProjectDir(dir: string | undefined) {
    externalProjectDir = dir;
}

/**
 * Searches for project.json in the current directory and its parents.
 * @param startDir The directory to start searching from
 * @returns The directory containing project.json, or process.cwd() if not found
 */
function findProjectRoot(startDir: string): string {
    let currentDir = startDir;
    while (true) {
        if (existsSync(join(currentDir, 'project.json'))) {
            return currentDir;
        }
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir) {
            break; // Reached filesystem root
        }
        currentDir = parentDir;
    }
    return startDir; // Fallback to start dir if not found
}

/**
 * Returns the current project working directory
 * @returns {string} The current working directory
 */
export function projectDir() {
    return externalProjectDir ?? findProjectRoot(process.cwd());
}

import { ValidationContext, validateProject } from './validation';
import { migration } from './migration';

/**
 * Returns the current project config.
 * Uses atomic read (readFileSync) to avoid require cache issues.
 * @param path Optional path to the project config
 * @param validate Whether to validate the config (default: true)
 * @returns {IProjectConfig} The current project config
 */
export function readProjectConfig(
    path?: string,
    validate: boolean = true,
): IProjectConfig | undefined {
    const configPath = path ?? join(projectDir(), 'project.json');
    if (!existsSync(configPath)) return undefined;

    const content = readFileSync(configPath, 'utf8');
    let config: any;
    try {
        config = JSON.parse(content);
    } catch (err) {
        // A corrupt file is NOT the same as a missing file: surface it
        // instead of letting callers report "not in a project directory".
        throw new Error(
            `Failed to parse '${basename(configPath)}': ${(err as Error).message}. Fix the JSON syntax and try again.`,
            { cause: err },
        );
    }

    if (validate) {
        // Apply migration FIRST so we validate the modern shape
        const migrationCheck = migration.checkProject(config);
        if (migrationCheck.needsMigration) {
            warn(
                `[MIGRATION] ${basename(configPath)} needs migration: ${migrationCheck.reason}`,
            );
            config = migration.upgradeProject(config);
        }

        const context = new ValidationContext(basename(configPath));
        validateProject(config, context);
        if (context.hasErrors()) {
            // Throw instead of process.exit(): library code must not kill
            // the host process (the VS Code extension runs it in-process).
            throw new Error(
                `Validation failed for ${basename(configPath)}:\n${context.formatErrors()}`,
            );
        }
    }

    return applyProjectDefaults(config);
}

/**
 * Applies safe defaults to a project config.
 * @param config The original project config
 * @returns The config with defaults applied
 */
export function applyProjectDefaults(config: any): IProjectConfig {
    if (!config) return config;

    // Default workshop settings
    if (!config.workshop) config.workshop = {};
    if (config.excludes === undefined) {
        verbose(`Defaulting excludes to empty list`);
        config.excludes = [];
    }

    // Default mods settings
    if (config.mods) {
        for (const modId in config.mods) {
            const mod = config.mods[modId];
            if (mod.poster === undefined) {
                verbose(`Mod '${modId}' defaulting poster to: poster.png`);
                mod.poster = 'poster.png';
            }
            if (mod.icon === undefined) {
                verbose(`Mod '${modId}' defaulting icon to: icon.png`);
                mod.icon = 'icon.png';
            }
            if (!mod.build) mod.build = {};
            if (mod.build.modInfo === undefined) {
                mod.build.modInfo = 'auto-if-missing';
            }
        }
    }

    return config as IProjectConfig;
}

/**
 * Performs an atomic write to a JSON file, preserving unknown fields.
 * @param filePath Path to the file
 * @param updated Updated configuration object
 */
export function atomicWriteJson(
    filePath: string,
    updated: any,
    overwrite: boolean = false,
) {
    let finalContent = updated;

    // Preserve unknown fields if file exists and we are not overwriting
    if (!overwrite && existsSync(filePath)) {
        try {
            const existing = JSON.parse(readFileSync(filePath, 'utf8'));
            finalContent = { ...existing, ...updated };
        } catch (_e) {
            // If existing is corrupt, we overwrite with updated
        }
    }

    // Strip useSymlinks from project.json if it exists (no longer supported in workspace)
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
            // Cross-volume or locked target: fall back to a direct write
            rmSync(tempPath, { force: true });
            writeFileSync(filePath, content, 'utf8');
        }
    } catch (_e) {
        // Fallback to direct write if atomic fails
        writeFileSync(filePath, content, 'utf8');
    }
}

/**
 * Updates the a project config
 * @param {string} path The path to the project config
 * @param {IProjectConfig} updated The updated project config
 */
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

/**
 * Format a title to a valid id (Unix-compatible for Windows and Linux)
 * @param {string} title The title to format
 * @returns {string} The formatted id
 */
export function formatTitleToId(title: string) {
    return title
        .toLowerCase()
        .replace(/\s+/g, '_') // Replace spaces with underscores
        .replace(/[^a-z0-9_]/g, ''); // Remove any other special characters
}

/**
 * Returns the files in a directory recursively
 * @param {string} dir The directory to search
 * @param {string[]} filelist The file list
 * @returns {string[]} The files in the directory
 */
export function getFilesRecursively(dir: string, filelist: string[] = []) {
    readdirSync(dir).forEach((file) => {
        filelist = statSync(join(dir, file)).isDirectory()
            ? getFilesRecursively(join(dir, file), filelist)
            : filelist.concat(join(dir, file));
    });
    return filelist;
}

/**
 * Migrate legacy file-based store to directory-based store
 */
export function migrateStoreDirIfNeeded() {
    const storeDir = join(homedir(), '.pzstudio');

    // Check if legacy file exists
    if (existsSync(storeDir) && statSync(storeDir).isFile()) {
        try {
            const outDirContent = readFileSync(storeDir, 'utf8').trim();

            // Remove file first and create directory
            rmSync(storeDir);
            mkdirSync(storeDir, { recursive: true });

            // Backup old file content in new directory
            const backupPath = join(storeDir, '.pzstudio.bak');
            writeFileSync(backupPath, outDirContent);

            // Save to config.json
            const config = readGlobalConfig();
            config.outdir = outDirContent;
            writeGlobalConfig(config);

            log(`- Migrated legacy .pzstudio file to directory structure`);
        } catch (e) {
            warn(`Failed to migrate legacy store: ${e}`);
        }
    }
}

export function getStoreDir() {
    return join(homedir(), '.pzstudio');
}

/**
 * Returns the output directory following the hierarchy:
 * project.json > config.json > .pzstudio.bak > default
 * @param project Optional project config to use
 * @param config Optional global config to use
 * @returns {string} The output directory
 */
export function getOutDir(project?: IProjectConfig, config?: GlobalConfig) {
    // 1. Try project config
    if (project && project.outdir) {
        return resolve(projectDir(), project.outdir);
    }

    // 2. Try workspace settings
    if (vscodeWorkspaceSettings?.outdir) {
        return resolve(vscodeWorkspaceSettings.outdir);
    }

    // 3. Try user settings
    if (vscodeUserSettings?.outdir) {
        return resolve(vscodeUserSettings.outdir);
    }

    // 4. Try global config
    const global = config ?? readGlobalConfig(false);
    if (global.outdir) {
        return resolve(global.outdir);
    }

    // This should technically never be reached because readGlobalConfig has a final fallback
    const defaultPath = join(homedir(), 'Zomboid', 'Workshop');
    verbose(`Defaulting output directory to: ${defaultPath}`);
    return defaultPath;
}

/**
 * Reads workshop/description.txt from the project and returns its lines
 * (CRLF-safe). Returns an empty array when the file does not exist.
 * @param projectPath The project root directory
 * @returns {string[]} The description lines
 */
export function readWorkshopDescriptionLines(projectPath: string): string[] {
    const workshopDescriptionPath = join(
        projectPath,
        'workshop',
        'description.txt',
    );
    if (!existsSync(workshopDescriptionPath)) return [];
    // split(/\r?\n/) so CRLF files (Windows) don't leave trailing \r
    return readFileSync(workshopDescriptionPath, {
        encoding: 'utf-8',
    }).split(/\r?\n/);
}

/**
 * Generate the workshop text
 * @param config The project config
 * @param overrideVisibility Optional visibility override
 * @param excludeId Whether to exclude the id field
 * @param titleSuffix Optional suffix to append to title
 * @returns {string} The workshop text
 */
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

/**
 * Generate the mod.info text
 * @param modId The mod id
 * @param config The project config
 * @param prefixedId Optional prefixed id to use in mod.info instead of modId
 * @returns {string} The mod.info text
 */
export function generateModInfoText(
    modId: string,
    config: IProjectConfig,
    prefixedId?: string,
) {
    return modInfoText(modId, config, prefixedId);
}

/**
 * Parses mod.info text into a partial IModConfig.
 * Re-exported from modInfoParser.ts (single source of truth, shared with migration).
 */
export { parseModInfoText } from './modInfoParser';
import { workshopText, modInfoText } from './core/textgen';

/**
 * Returns the branch folders (direct subdirectories) of a mod.
 * @param modId The mod id
 * @param baseDir The directory containing the mod folder (defaults to projectDir())
 * @returns {string[]} An array of absolute paths to branch folders
 */
export function getModBranchFolders(
    modId: string,
    baseDir: string = projectDir(),
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

/**
 * Resolves the valid branch folders for a mod that should contain a mod.info file.
 * Following Build 42 rules:
 * 1. Only existing nested folders that contain a 'media' directory.
 * 2. Root-level mod.info is NOT a target for Build 42 generation.
 * @param modId The mod id (folder name inside baseDir)
 * @param baseDir The directory containing the mod folder (defaults to projectDir())
 * @returns {string[]} An array of absolute paths to valid branch folders
 */
export function resolveModInfoTargets(
    modId: string,
    baseDir: string = projectDir(),
): string[] {
    const branchFolders = getModBranchFolders(modId, baseDir);
    return branchFolders.filter((folder) => {
        const mediaPath = join(folder, 'media');
        return existsSync(mediaPath) && statSync(mediaPath).isDirectory();
    });
}

/**
 * Update experimental package scripts
 * @param action The action to perform ('addProject', 'addMod', 'removeMod', 'renameMod')
 * @param projectDir The project directory
 * @param modId The mod id (optional)
 * @param newModId The new mod id (required for 'renameMod')
 */
export function updateExperimentalScripts(
    action: 'addProject' | 'addMod' | 'removeMod' | 'renameMod',
    projectDir: string,
    modId?: string,
    newModId?: string,
) {
    try {
        const srcPath = resolve(
            __dirname,
            '../../scripts/experimental-package-scripts.js',
        );
        const distPath = resolve(
            __dirname,
            '../scripts/experimental-package-scripts.js',
        );
        const scriptPath = existsSync(srcPath) ? srcPath : distPath;
        if (!existsSync(scriptPath)) {
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
