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
import { info, warn, verbose } from './logger';
import { CliError } from './errors';
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

/**
 * Host-provided fallbacks for config.json migration: the legacy backup file
 * under ~/.pzstudio and the platform default workshop outdir. The migration
 * logic in @pzstudio/core is pure; only the adapter knows the filesystem.
 */
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
 * Deletes a directory tree with retries. ENOTEMPTY/EBUSY/EPERM happen on
 * Windows when another program (the game, Steam, an editor or an antivirus)
 * briefly holds handles inside the folder — a bare rmSync gets exactly one
 * shot, so give transient locks time to clear before giving up.
 */
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
let projectRootAnchor: string | undefined;

/**
 * Sets the project working directory externally (e.g. from VS Code)
 * @param dir The directory path
 */
export function setProjectDir(dir: string | undefined) {
    externalProjectDir = dir;
}

/**
 * Returns the externally anchored project directory, if any. Callers that
 * anchor temporarily (e.g. the doctor gatherer) restore the previous value.
 */
export function getExternalProjectDir(): string | undefined {
    return externalProjectDir;
}

/**
 * Anchors project discovery to `-C/--project <dir>` (CLI-5): the anchor
 * replaces the working directory as the discovery start without ever
 * mutating process.cwd(). Cleared by passing undefined.
 */
export function setProjectRootAnchor(dir: string | undefined) {
    projectRootAnchor = dir;
}

/**
 * The directory project discovery starts from: the `-C/--project` anchor,
 * then the externally anchored project dir (embedded hosts), then the
 * process working directory.
 */
export function discoveryStartDir(): string {
    return projectRootAnchor ?? externalProjectDir ?? process.cwd();
}

/**
 * Searches for project.json in the given directory and its parents.
 * Fail-closed (CLI-5): returns undefined when no project is found instead
 * of pretending the start dir is one.
 * @param startDir The directory to start searching from
 * @returns The directory containing project.json, or undefined
 */
function findProjectRoot(startDir: string): string | undefined {
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
    return undefined;
}

/**
 * Non-throwing project discovery from the current discovery start
 * (anchor > external anchor > cwd). Commands that legitimately work
 * outside a project (`new`, `migrate`) use this; commands that require
 * a project go through projectDir().
 * @returns The directory containing project.json, or undefined
 */
export function findProjectDir(): string | undefined {
    return findProjectRoot(discoveryStartDir());
}

/**
 * Returns the current project working directory. Fail-closed: throws a
 * structured CliError when no project.json exists at or above the
 * discovery start, instead of silently pretending the start dir is one.
 * @returns {string} The project working directory
 */
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
 * Applies safe defaults to a project config, reporting each defaulting
 * decision to the CLI logger. The pure logic lives in @pzstudio/core.
 * @param config The original project config
 * @returns The config with defaults applied
 */
export function applyProjectDefaults(config: any): IProjectConfig {
    return applyProjectDefaultsPure(config, verbose);
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
 * Format a title to a valid id (Unix-compatible for Windows and Linux).
 * Re-exported from @pzstudio/core.
 */
export { formatTitleToId } from '@pzstudio/core';

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

            // Progress to stderr (CLI-2): keeps stdout pure for --json runs.
            info(`- Migrated legacy .pzstudio file to directory structure`);
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
 * Snapshots the source tree of a mod so the planner can decide mod.info
 * targeting without touching the filesystem. Existing mod.info content is
 * snapshotted too so the planner can rewrite its id for the development
 * output. Shared by build and the Development Sync Engine (watch).
 */
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
        } catch {
            // Unreadable mod.info: no content snapshot, so the planner falls
            // back to copying the file verbatim.
        }
    };

    snapshotTarget('', join(projectPath, modId));
    for (const branchPath of resolveModInfoTargets(modId, projectPath)) {
        const branchName = basename(branchPath);
        state.branchFolders.push(branchName);
        snapshotTarget(branchName, branchPath);
    }
    return state;
}

/**
 * Assembles the full plan input for the pure planner: resolved template,
 * per-mod source snapshots and the workshop metadata. This is the shared
 * host-side pre-planning work of `pzstudio build` and the sync engine.
 * @param projectPath The project root directory
 * @param config The fully-resolved project config (outdir absolute)
 */
export function gatherPlanInput(
    projectPath: string,
    config: IProjectConfig,
    workshopTemplateDir: string,
): Omit<PlanBuildInput, 'variant'> {
    // Snapshot the source tree once; every fs decision below is derived from
    // it by the pure planner.
    const modSourceStates: Record<string, ModSourceState> = {};
    for (const modId of Object.keys(config.mods)) {
        modSourceStates[modId] = gatherModSourceState(projectPath, modId);
    }

    return {
        config,
        workshopTemplateDir,
        projectDir: projectPath,
        modSourceStates,
        descriptionLines: readWorkshopDescriptionLines(projectPath),
        previewPngExists: existsSync(
            join(projectPath, 'workshop', 'preview.png'),
        ),
    };
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
export { parseModInfoText } from '@pzstudio/core';
import { workshopText, modInfoText } from '@pzstudio/core';

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
 * Resolves the experimental integration opt-in (CLI-10, BREAKING: default
 * off). An explicit project.json setting wins over the global config's
 * explicit setting; absent in both layers means disabled — the CLI never
 * auto-enables experimental behaviour.
 */
export function isExperimentalIntegrationEnabled(projectPath: string): boolean {
    const project = readProjectConfig(join(projectPath, 'project.json'), false);
    const projectValue = project?.experimental?.integration;
    if (projectValue !== undefined) return projectValue === true;

    const globalValue = readGlobalConfig(false).experimental?.integration;
    if (globalValue !== undefined) return globalValue === true;

    return false;
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
        // Experimental integration is opt-in only (CLI-10, BREAKING):
        // without an explicit project.json or global config setting this
        // is a silent no-op — no more unrequested script/junction setup.
        if (!isExperimentalIntegrationEnabled(projectDir)) {
            verbose(
                'Experimental integration is disabled (default). Set experimental.integration = true in project.json (or the global config) to enable it.',
            );
            return;
        }

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
