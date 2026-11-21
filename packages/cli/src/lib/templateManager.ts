import { homedir } from 'os';
import { basename, dirname, join, relative } from 'path';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
    cpSync,
    symlinkSync,
} from 'fs';
import {
    emitInfo,
    emitWarn,
    emitVerbose,
    engineIo,
    info,
    warn,
} from './logger';
import {
    assertNoAliasDestinationEntry,
    assertNoAliasRouteSync,
} from './mutation-route-guard';
import type {
    TemplateCategory,
    GlobalConfig,
    ITemplateConfig,
    IgnoreRuleSet,
} from '@pzstudio/core';
import { createIgnoreMatcher, DEFAULT_TEMPLATES } from '@pzstudio/core';
import type { TemplateTransport } from '@pzstudio/platform';
import type {
    IoScope,
    PzStudioHostSettings,
    PzStudioLogger,
} from './invocation';
import {
    getVsCodeSettings,
    mergeHostSettingsLayers,
    migrationHostOptions,
    removeDirRecursive,
} from './helper';
import { getTemplateTransport } from './transport';

export type { TemplateCategory, GlobalConfig, ITemplateConfig };

function parseIgnoreEntries(content: string): string[] | null {
    const lines = content
        .split(/\r?\n/)
        .map((line: string) =>
            line.trim().replace(/\\/g, '/').replace(/\/+$/, ''),
        )
        .filter((line: string) => line && !line.startsWith('#'));
    return lines.length > 0 ? lines : null;
}

export function createIgnoreFilter(
    sourceRoot: string,
    options: { excludeIgnoreFile?: boolean; ignoreDotFiles?: boolean } = {},
): (src: string, dest: string) => boolean {
    const rulesCache: Record<string, IgnoreRuleSet> = {};

    const getRulesForDir = (dir: string): IgnoreRuleSet => {
        if (rulesCache[dir]) return rulesCache[dir];

        const ruleSet: IgnoreRuleSet = { pzstudio: null, git: null };

        const pzstudioPath = join(dir, '.pzstudioignore');
        if (existsSync(pzstudioPath)) {
            try {
                ruleSet.pzstudio = parseIgnoreEntries(
                    readFileSync(pzstudioPath, 'utf-8'),
                );
            } catch (_e) {
                warn(`Failed to read .pzstudioignore at ${pzstudioPath}.`);
            }
        }

        const gitPath = join(dir, '.gitignore');
        if (existsSync(gitPath)) {
            try {
                ruleSet.git = parseIgnoreEntries(
                    readFileSync(gitPath, 'utf-8'),
                );
            } catch (_e) {
                warn(`Failed to read .gitignore at ${gitPath}.`);
            }
        }

        rulesCache[dir] = ruleSet;
        return ruleSet;
    };

    return (src: string) => {
        let relToRoot = relative(sourceRoot, src);
        if (!relToRoot) return true;
        relToRoot = relToRoot.replace(/\\/g, '/');

        const name = basename(src);

        if (name === '.gitkeep') return false;

        if (
            relToRoot === '.git' ||
            relToRoot.startsWith('.git/') ||
            relToRoot === '.github' ||
            relToRoot.startsWith('.github/') ||
            relToRoot === '.gitmodules'
        ) {
            return false;
        }

        if (options.ignoreDotFiles) {
            if (name.startsWith('.') && name !== '.pzstudioignore') {
                return false;
            }
        }

        if (
            relToRoot === '.pzstudioignore' ||
            relToRoot.endsWith('/.pzstudioignore')
        ) {
            return !options.excludeIgnoreFile;
        }

        const segments = relToRoot.split('/');
        const rulesByDir: Record<string, IgnoreRuleSet> = {};
        for (let end = segments.length - 1; end >= 0; end -= 1) {
            const key = segments.slice(0, end).join('/');
            const dir =
                end === 0
                    ? sourceRoot
                    : join(sourceRoot, ...segments.slice(0, end));
            const ruleSet = getRulesForDir(dir);
            if (ruleSet.pzstudio !== null || ruleSet.git !== null) {
                rulesByDir[key] = ruleSet;
                break;
            }
        }

        return !createIgnoreMatcher(rulesByDir).isIgnored(relToRoot);
    };
}

const OFFICIAL_ORG = 'escapepz';

function getCachePathFromUrl(url: string): string {
    const parts = url
        .replace('https://github.com/', '')
        .replace('.git', '')
        .split('/');

    if (parts.length >= 2) {
        const user = parts[parts.length - 2];
        const repo = parts[parts.length - 1];
        return join(getConfigDir(), 'templates', user, repo);
    }

    return join(
        getConfigDir(),
        'templates',
        'unknown',
        basename(url).replace('.git', ''),
    );
}

function isOfficialTemplate(url: string): boolean {
    return url.includes(`github.com/${OFFICIAL_ORG}/`) || !url.includes('/');
}

export function parseTemplateUrl(input: string): { url: string; ref?: string } {
    let url = input;
    let ref: string | undefined;

    if (url.includes('@')) {
        const parts = url.split('@');
        url = parts[0];
        ref = parts[1];
    } else if (url.includes('#')) {
        const parts = url.split('#');
        url = parts[0];
        ref = parts[1];
    }

    return { url, ref };
}

export function getConfigDir(): string {
    return join(homedir(), '.pzstudio');
}

export function getConfigPath(): string {
    return join(getConfigDir(), 'config.json');
}

export function findBundledLegacyDir(): string | undefined {
    const installRootPaths = [
        join(__dirname, '.template-legacy'),
        join(__dirname, '..', '..', '..', '.template-legacy'),
        join(__dirname, '..', '..', '.template-legacy'),
        join(__dirname, '..', '.template-legacy'),
        join(process.cwd(), '.template-legacy'),
    ];

    for (const p of installRootPaths) {
        if (existsSync(p) && isDirNonEmpty(p)) {
            return p;
        }
    }
    return undefined;
}

function bootstrapLegacyTemplates(io?: IoScope | undefined): void {
    const globalLegacyDir = join(getConfigDir(), '.template-legacy');
    if (existsSync(globalLegacyDir) && isDirNonEmpty(globalLegacyDir)) {
        return;
    }

    const bundledLegacyDir = findBundledLegacyDir();

    if (bundledLegacyDir) {
        emitInfo(
            io,
            `- Bootstrapping legacy templates to ${globalLegacyDir}...`,
        );
        try {
            mkdirSync(dirname(globalLegacyDir), { recursive: true });
            cpSync(bundledLegacyDir, globalLegacyDir, {
                recursive: true,
                filter: (src) => basename(src) !== LEGACY_STAMP_FILE,
            });
            const bundledStamp = readLegacyTemplateStamp(bundledLegacyDir);
            if (bundledStamp) {
                writeFileSync(
                    join(globalLegacyDir, LEGACY_STAMP_FILE),
                    JSON.stringify(bundledStamp, null, 4) + '\n',
                    'utf8',
                );
            }
        } catch (e) {
            emitWarn(io, `Failed to bootstrap legacy templates: ${e}`);
        }
    }
}

export type LegacyRefreshStatus = 'refreshed' | 'up-to-date' | 'skipped';

interface LegacyTemplateStamp {
    version: string;
    buildDate: string;
}

const LEGACY_STAMP_FILE = '.pzstudio-templates.json';

function readLegacyTemplateStamp(dir: string): LegacyTemplateStamp | undefined {
    const stampPath = join(dir, LEGACY_STAMP_FILE);
    if (!existsSync(stampPath)) return undefined;
    try {
        const parsed: unknown = JSON.parse(readFileSync(stampPath, 'utf-8'));
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof (parsed as Record<string, unknown>).version !== 'string' ||
            typeof (parsed as Record<string, unknown>).buildDate !== 'string'
        ) {
            return undefined;
        }
        return parsed as LegacyTemplateStamp;
    } catch {
        return undefined;
    }
}

function legacyStampsEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (
        typeof a !== 'object' ||
        a === null ||
        typeof b !== 'object' ||
        b === null
    ) {
        return false;
    }
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
        (key, i) =>
            key === bKeys[i] &&
            legacyStampsEqual(
                (a as Record<string, unknown>)[key],
                (b as Record<string, unknown>)[key],
            ),
    );
}

export function refreshLegacyTemplates(
    io?: IoScope | undefined,
    bundledDirOverride?: string | undefined,
): LegacyRefreshStatus {
    const bundledLegacyDir = bundledDirOverride ?? findBundledLegacyDir();
    if (!bundledLegacyDir || !isDirNonEmpty(bundledLegacyDir)) {
        emitVerbose(
            io,
            'No bundled legacy template directory found; skipping refresh.',
        );
        return 'skipped';
    }

    const bundledStamp = readLegacyTemplateStamp(bundledLegacyDir);
    if (!bundledStamp) {
        emitVerbose(
            io,
            'Bundled legacy templates carry no readable stamp; skipping refresh.',
        );
        return 'skipped';
    }

    const globalLegacyDir = join(getConfigDir(), '.template-legacy');
    const globalStamp = readLegacyTemplateStamp(globalLegacyDir);
    if (legacyStampsEqual(bundledStamp, globalStamp)) {
        emitInfo(io, 'Legacy templates up to date.');
        return 'up-to-date';
    }

    const stagingDir = `${globalLegacyDir}.replacing`;
    rmSync(stagingDir, { recursive: true, force: true });
    let secured = false;
    try {
        mkdirSync(dirname(stagingDir), { recursive: true });
        cpSync(bundledLegacyDir, stagingDir, {
            recursive: true,
            filter: (src) => basename(src) !== LEGACY_STAMP_FILE,
        });
        writeFileSync(
            join(stagingDir, LEGACY_STAMP_FILE),
            JSON.stringify(bundledStamp, null, 4) + '\n',
            'utf8',
        );
        secured = true;
    } finally {
        if (!secured) {
            rmSync(stagingDir, { recursive: true, force: true });
        }
    }
    if (existsSync(globalLegacyDir)) {
        removeDirRecursive(globalLegacyDir);
    }
    renameSync(stagingDir, globalLegacyDir);
    emitInfo(
        io,
        `Legacy templates refreshed (${bundledStamp.version}, ${bundledStamp.buildDate}).`,
    );
    return 'refreshed';
}

function getEmbeddedTemplateDir(
    category: TemplateCategory,
    io?: IoScope | undefined,
): string {
    bootstrapLegacyTemplates(io);
    const globalLegacyDir = join(getConfigDir(), '.template-legacy');
    return join(globalLegacyDir, `.template-${category}`);
}

function isCacheValid(dir: string, transport?: TemplateTransport): boolean {
    return (transport ?? getTemplateTransport()).isCacheValid(dir);
}

function isDirNonEmpty(dir: string): boolean {
    if (!existsSync(dir)) return false;
    try {
        if (!lstatSync(dir).isDirectory()) return false;
    } catch {
        return false;
    }
    return readdirSync(dir).length > 0;
}

export function cloneRemoteTemplate(
    url: string,
    dest: string,
    ref?: string,
    transport?: TemplateTransport,
): boolean {
    return cloneRemoteTemplateWithIo(url, dest, ref, transport, undefined);
}

export function cloneRemoteTemplateWithIo(
    url: string,
    dest: string,
    ref?: string,
    transport?: TemplateTransport,
    io?: IoScope | undefined,
): boolean {
    try {
        (transport ?? getTemplateTransport()).download(url, ref, dest);
        return true;
    } catch (err) {
        emitWarn(io, `- ${(err as Error).message}`);
        return false;
    }
}

export function refreshCachedTemplate(
    dir: string,
    ref?: string,
    transport?: TemplateTransport,
): boolean {
    return (transport ?? getTemplateTransport()).refresh(dir, ref);
}

import { ValidationContext, validateConfig } from '@pzstudio/core';
import { migration } from '@pzstudio/core';

export function readGlobalConfig(
    validate: boolean = true,
    io?: IoScope | undefined,
): GlobalConfig {
    const configPath = getConfigPath();
    const configDir = getConfigDir();
    emitVerbose(io, `Reading global config from: ${configPath}`);

    const defaultConfig: GlobalConfig = {
        templates: { ...DEFAULT_TEMPLATES },
        useSymlinks: true,
        outdir: undefined,
    };

    const backupPath = join(configDir, '.pzstudio.bak');
    if (existsSync(backupPath)) {
        try {
            defaultConfig.outdir = readFileSync(backupPath, 'utf-8').trim();
        } catch {}
    }

    if (!existsSync(configPath)) {
        return defaultConfig;
    }
    try {
        const content = readFileSync(configPath, 'utf-8');
        let config = content.trim() ? JSON.parse(content) : {};

        if (validate) {
            const migrationCheck = migration.checkConfig(config);
            if (migrationCheck.needsMigration) {
                emitVerbose(
                    io,
                    `[MIGRATION] Global config ${basename(configPath)} needs migration: ${migrationCheck.reason}`,
                );
                config = migration.upgradeConfig(
                    config,
                    migrationHostOptions(),
                );
            }

            const context = new ValidationContext(basename(configPath));
            validateConfig(config, context);
            if (context.hasErrors()) {
                emitWarn(
                    io,
                    `Validation failed for global config ${basename(configPath)}:\n${context.formatErrors()}`,
                );
                emitWarn(io, 'Continuing with in-memory defaults.');
                return defaultConfig;
            }
        }

        const mergedConfig = {
            ...defaultConfig,
            ...config,
            templates:
                !config.templates || Object.keys(config.templates).length === 0
                    ? { ...defaultConfig.templates }
                    : {
                          ...defaultConfig.templates,
                          ...config.templates,
                      },
        };

        return mergedConfig;
    } catch {
        return defaultConfig;
    }
}

export function migrateGlobalConfigIfNeeded(): void {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
        try {
            const config = readGlobalConfig(false, engineIo());
            writeGlobalConfig(config);
        } catch (_e) {
            warn(
                'Failed to create initial config.json, continuing with in-memory defaults',
            );
        }
        return;
    }

    try {
        const content = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);

        const migrationCheck = migration.checkConfig(config);
        if (migrationCheck.needsMigration) {
            info(`- Migrating config.json: ${migrationCheck.reason}`);
            const upgraded = migration.upgradeConfig(
                config,
                migrationHostOptions(),
            );
            try {
                writeGlobalConfig(upgraded);
            } catch (_e) {
                warn(
                    'Failed to persist config migration, continuing with in-memory defaults',
                );
            }
        }
    } catch (_e) {}
}

export function writeGlobalConfig(config: GlobalConfig): void {
    const configDir = getConfigDir();
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(getConfigPath(), JSON.stringify(config, null, 4), 'utf-8');
}

export function validateTemplateManifest(
    dir: string,
    _expectedCategory: TemplateCategory,
): boolean {
    return isCacheValid(dir);
}

export interface TemplateScope {
    isOffline?: boolean;
    forceUpdate?: boolean;
    settings?: PzStudioHostSettings | undefined;
    templateTransport?: TemplateTransport | undefined;
    logger?: PzStudioLogger | undefined;
}

function scopeIo(scope: TemplateScope | undefined): IoScope | undefined {
    return scope?.logger ? { logger: scope.logger } : undefined;
}

export function probeTemplateCacheDir(
    category: TemplateCategory,
    scope?: TemplateScope,
): { dir: string; name: string } | undefined {
    const globalConfig = readGlobalConfig(false, scopeIo(scope));
    const vscodeSettings = scope
        ? mergeHostSettingsLayers(scope.settings)
        : getVsCodeSettings();
    const templates = vscodeSettings?.templates ?? globalConfig.templates;
    const templateConfig = templates?.[category];
    if (!templateConfig) return undefined;

    const parts = templateConfig.url
        .replace('https://github.com/', '')
        .replace('.git', '')
        .split('/');
    const name =
        parts.length >= 2
            ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
            : parts[parts.length - 1] || templateConfig.url;
    return { dir: getCachePathFromUrl(templateConfig.url), name };
}

export function resolveTemplateDir(
    category: TemplateCategory,
    isOfflineOrScope?: boolean | TemplateScope,
    forceUpdate?: boolean,
): string {
    return resolveTemplateDirWithIo(
        category,
        isOfflineOrScope,
        forceUpdate,
        undefined,
    );
}

export function resolveTemplateDirForEngine(
    category: TemplateCategory,
    isOffline?: boolean,
    forceUpdate?: boolean,
): string {
    return resolveTemplateDirWithIo(
        category,
        isOffline,
        forceUpdate,
        engineIo(),
    );
}

function resolveTemplateDirWithIo(
    category: TemplateCategory,
    isOfflineOrScope?: boolean | TemplateScope,
    forceUpdate?: boolean,
    ioArg?: IoScope | undefined,
): string {
    const scope =
        isOfflineOrScope && typeof isOfflineOrScope === 'object'
            ? isOfflineOrScope
            : undefined;
    const io = scope ? scopeIo(scope) : ioArg;
    const isOffline = scope
        ? scope.isOffline === true
        : isOfflineOrScope === true;
    const force = scope ? scope.forceUpdate === true : forceUpdate === true;
    const transport = scope
        ? (scope.templateTransport ?? getTemplateTransport())
        : getTemplateTransport();

    const globalConfig = readGlobalConfig(false, io);
    const vscodeSettings = scope
        ? mergeHostSettingsLayers(scope.settings)
        : getVsCodeSettings();
    const templates = vscodeSettings?.templates ?? globalConfig.templates;
    const templateConfig = templates?.[category];

    if (!templateConfig) {
        throw new Error(
            `No default template defined for category '${category}'.`,
        );
    }

    const cacheDir = getCachePathFromUrl(templateConfig.url);
    const legacyDir = getEmbeddedTemplateDir(category, io);
    emitVerbose(io, `Resolved cacheDir: ${cacheDir}`);
    emitVerbose(io, `Resolved legacyDir: ${legacyDir}`);

    if (isOffline) {
        if (isCacheValid(cacheDir, transport)) {
            return cacheDir;
        }
        if (isDirNonEmpty(legacyDir)) {
            emitWarn(
                io,
                `Template not found in cache. Falling back to offline legacy template.`,
            );
            return legacyDir;
        }
        throw new Error(
            `No valid cached or legacy template found for '${category}'.`,
        );
    }

    let replacingExistingCache = false;
    if (isCacheValid(cacheDir, transport)) {
        if (force) {
            if (
                refreshCachedTemplate(cacheDir, templateConfig.ref, transport)
            ) {
                return cacheDir;
            }
            emitWarn(io, `Failed to refresh template cache. Re-cloning...`);
            replacingExistingCache = true;
        } else {
            return cacheDir;
        }
    } else if (existsSync(cacheDir)) {
        emitWarn(io, `Template cache at ${cacheDir} is invalid. Re-cloning...`);
        replacingExistingCache = true;
    }

    if (!isOfficialTemplate(templateConfig.url)) {
        emitWarn(
            io,
            `⚠ Cloning from community template '${templateConfig.url}'. Not verified by PZStudio.`,
        );
    }

    mkdirSync(dirname(cacheDir), { recursive: true });

    if (replacingExistingCache) {
        const stagingDir = `${cacheDir}.replacing`;
        rmSync(stagingDir, { recursive: true, force: true });
        let secured = false;
        try {
            secured =
                cloneRemoteTemplateWithIo(
                    templateConfig.url,
                    stagingDir,
                    templateConfig.ref,
                    transport,
                    io,
                ) && validateTemplateManifest(stagingDir, category);
        } finally {
            if (!secured) {
                rmSync(stagingDir, { recursive: true, force: true });
            }
        }
        if (secured) {
            rmSync(cacheDir, { recursive: true, force: true });
            renameSync(stagingDir, cacheDir);
            return cacheDir;
        }
        emitWarn(
            io,
            `Failed to clone template from '${templateConfig.url}'. The previous template cache at ${cacheDir} was left untouched.`,
        );
    } else {
        if (
            cloneRemoteTemplateWithIo(
                templateConfig.url,
                cacheDir,
                templateConfig.ref,
                transport,
                io,
            )
        ) {
            if (validateTemplateManifest(cacheDir, category)) {
                return cacheDir;
            }
        } else {
            emitWarn(
                io,
                `Failed to clone template from '${templateConfig.url}'.`,
            );
        }
    }

    if (isOfficialTemplate(templateConfig.url) && isDirNonEmpty(legacyDir)) {
        emitWarn(
            io,
            `Falling back to offline legacy template for '${category}'.`,
        );
        return legacyDir;
    }

    throw new Error(
        `Failed to resolve template for category '${category}'. ` +
            `Clone failed and no legacy fallback found.`,
    );
}

export function scaffoldProject(
    templateDir: string,
    destDir: string,
    useSymlinks: boolean = false,
    asJunction: boolean = false,
    options: {
        excludeIgnoreFile?: boolean;
        ignoreDotFiles?: boolean;
        ignoreItems?: string[];
        outputRoot?: string;
    } = {},
): void {
    if (useSymlinks && asJunction) {
        try {
            if (existsSync(destDir)) {
                rmSync(destDir, { recursive: true, force: true });
            }
            mkdirSync(dirname(destDir), { recursive: true });
            symlinkSync(templateDir, destDir, 'junction');
            info(`  - Created template junction: ${basename(destDir)}`);
            return;
        } catch (_e) {
            warn(
                `  - Failed to create template junction for ${basename(
                    destDir,
                )}, falling back to copy.`,
            );
        }
    }

    const copyOperation = `copyTree destination '${destDir}'`;
    if (options.outputRoot) {
        assertNoAliasRouteSync(
            options.outputRoot,
            destDir,
            'write',
            copyOperation,
        );
    }

    if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
    }

    info(`- Scaffolding into ${destDir}...`);

    const filter = createIgnoreFilter(templateDir, options);
    const guardedFilter = (srcPath: string, destPath: string): boolean => {
        if (!filter(srcPath, destPath)) {
            return false;
        }
        if (options.outputRoot) {
            assertNoAliasDestinationEntry(
                destPath,
                options.outputRoot,
                copyOperation,
            );
        }
        return true;
    };

    readdirSync(templateDir).forEach((file: string) => {
        if (options.ignoreItems?.includes(file)) {
            return;
        }

        const srcPath = join(templateDir, file);
        const destPath = join(destDir, file);

        if (!guardedFilter(srcPath, destPath)) {
            return;
        }

        cpSync(srcPath, destPath, {
            recursive: true,
            filter: (src: string, _dest: string) => guardedFilter(src, _dest),
        });
    });
}

export function scaffoldTemplateFolder(
    templateDir: string,
    destDir: string,
    useSymlinks: boolean,
): void {
    if (useSymlinks) {
        try {
            if (existsSync(destDir)) {
                rmSync(destDir, { recursive: true, force: true });
            }
            mkdirSync(dirname(destDir), { recursive: true });
            symlinkSync(templateDir, destDir, 'junction');
            info(`  - Linked shared folder: ${basename(destDir)}`);
            return;
        } catch (_e) {
            warn(
                `  - Failed to link shared folder ${basename(
                    destDir,
                )}, falling back to copy.`,
            );
        }
    }

    scaffoldProject(templateDir, destDir, false, false);
}
