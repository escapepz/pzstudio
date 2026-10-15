import { homedir } from 'os';
import { basename, dirname, join, relative } from 'path';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
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
} from '@pzstudio/core';
import { DEFAULT_TEMPLATES } from '@pzstudio/core';
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
} from './helper';
import { getTemplateTransport } from './transport';

export type { TemplateCategory, GlobalConfig, ITemplateConfig };

/**
 * Creates a filter for fs.cpSync derived from .pzstudioignore or hardcoded defaults.
 * Supports nested .pzstudioignore files where the closest one to the subtree wins.
 * @param sourceRoot The root directory of the copy operation
 * @param options Filter options
 * @returns A filter function compatible with fs.cpSync
 */
export function createIgnoreFilter(
    sourceRoot: string,
    options: { excludeIgnoreFile?: boolean; ignoreDotFiles?: boolean } = {},
): (src: string, dest: string) => boolean {
    // Cache for compiled filter functions per directory
    const filterCache: Record<string, (relPath: string) => boolean | null> = {};

    /**
     * Resolves and caches ignore rules for a specific directory.
     * Searches for .pzstudioignore in the given directory.
     */
    const getFilterForDir = (
        dir: string,
    ): ((relPath: string) => boolean | null) => {
        if (filterCache[dir]) return filterCache[dir];

        const ignorePath = join(dir, '.pzstudioignore');
        let entries: string[] = [];

        if (existsSync(ignorePath)) {
            try {
                const content = readFileSync(ignorePath, 'utf-8');
                entries = content
                    .split(/\r?\n/)
                    .map((line: string) => line.trim())
                    .filter((line: string) => line && !line.startsWith('#'));
            } catch (_e) {
                warn(`Failed to read .pzstudioignore at ${ignorePath}.`);
            }
        }

        if (entries.length === 0) {
            filterCache[dir] = () => null; // No local rules
            return filterCache[dir];
        }

        filterCache[dir] = (relPath: string) => {
            // RelPath is relative to the directory where .pzstudioignore lives
            for (let entry of entries) {
                // Normalize entry to use forward slashes
                entry = entry.replace(/\\/g, '/');

                // Remove trailing slashes for directory prefix matching
                if (entry.endsWith('/')) {
                    entry = entry.slice(0, -1);
                }

                if (relPath === entry || relPath.startsWith(entry + '/')) {
                    return false; // Ignored
                }
            }
            return true; // Not ignored by this file
        };

        return filterCache[dir];
    };

    return (src: string) => {
        let relToRoot = relative(sourceRoot, src);
        if (!relToRoot) return true; // Include root itself
        relToRoot = relToRoot.replace(/\\/g, '/');

        const name = basename(src);

        // Rule 0: Built-in defaults always apply
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

        // Rule 0.5: Optional dotfile ignore (matching copyFolderSync legacy behavior)
        if (options.ignoreDotFiles) {
            if (name.startsWith('.') && name !== '.pzstudioignore') {
                return false;
            }
        }

        // Rule 1: .pzstudioignore is special
        if (
            relToRoot === '.pzstudioignore' ||
            relToRoot.endsWith('/.pzstudioignore')
        ) {
            return !options.excludeIgnoreFile;
        }

        // Rule 2: Search for the closest .pzstudioignore in the hierarchy up to sourceRoot
        let currentPath = lstatSync(src).isDirectory() ? src : dirname(src);

        while (currentPath.length >= sourceRoot.length) {
            const filter = getFilterForDir(currentPath);
            const relToIgnore = relative(currentPath, src).replace(/\\/g, '/');

            if (relToIgnore) {
                const result = filter(relToIgnore);
                if (result === false) return false;
                if (result === true) return true; // Closest one wins
            }

            if (currentPath === sourceRoot) break;
            currentPath = dirname(currentPath);
        }

        return true;
    };
}

const OFFICIAL_ORG = 'escapepz';

function getCachePathFromUrl(url: string): string {
    // Expected: https://github.com/user/repo.git OR user/repo
    const parts = url
        .replace('https://github.com/', '')
        .replace('.git', '')
        .split('/');

    if (parts.length >= 2) {
        const user = parts[parts.length - 2];
        const repo = parts[parts.length - 1];
        return join(getConfigDir(), 'templates', user, repo);
    }

    // Fallback if URL is weird
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

/**
 * Parses a template URL/string into url and ref.
 * Supports:
 * - user/repo
 * - user/repo@tag
 * - user/repo#branch
 * - https://github.com/user/repo.git
 * - https://github.com/user/repo.git@tag
 */
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

/**
 * Bootstraps the bundled legacy templates into ~/.pzstudio (one-time, cold
 * caches only). `io` (doc 11 §17 commit 6, Appendix C) is the emission
 * target of the bootstrap info/warn: the v2 non-engine paths thread the
 * instance logger, every omitted scope routes raw legacy (R1) — the
 * bootstrap emission can never inherit an active v2 ambient.
 */
function bootstrapLegacyTemplates(io?: IoScope | undefined): void {
    const globalLegacyDir = join(getConfigDir(), '.template-legacy');
    if (existsSync(globalLegacyDir) && isDirNonEmpty(globalLegacyDir)) {
        return;
    }

    // Find the bundled .template-legacy directory. Probes cover, in order:
    // the esbuild bundle (co-located dist/.template-legacy next to dist/
    // index.js), the repo root during development on the tsc layout
    // (packages/cli/dist/lib -> repo root), the package root when published
    // on the tsc layout (dist/lib -> package root), the dist folder on the
    // tsc layout (dist/lib -> dist/.template-legacy), and the working
    // directory.
    const installRootPaths = [
        join(__dirname, '.template-legacy'),
        join(__dirname, '..', '..', '..', '.template-legacy'),
        join(__dirname, '..', '..', '.template-legacy'),
        join(__dirname, '..', '.template-legacy'),
        join(process.cwd(), '.template-legacy'),
    ];

    let bundledLegacyDir: string | undefined;
    for (const p of installRootPaths) {
        if (existsSync(p) && isDirNonEmpty(p)) {
            bundledLegacyDir = p;
            break;
        }
    }

    if (bundledLegacyDir) {
        emitInfo(
            io,
            `- Bootstrapping legacy templates to ${globalLegacyDir}...`,
        );
        try {
            mkdirSync(dirname(globalLegacyDir), { recursive: true });
            cpSync(bundledLegacyDir, globalLegacyDir, { recursive: true });
        } catch (e) {
            emitWarn(io, `Failed to bootstrap legacy templates: ${e}`);
        }
    }
}

function getEmbeddedTemplateDir(
    category: TemplateCategory,
    io?: IoScope | undefined,
): string {
    bootstrapLegacyTemplates(io);
    const globalLegacyDir = join(getConfigDir(), '.template-legacy');
    return join(globalLegacyDir, `.template-${category}`);
}

/**
 * Checks if a cache directory is usable for the active template transport
 * (git caches require .git; fetch caches only need content). An explicitly
 * supplied transport (the explicit-scope cores, doc 11 commit 5) is used
 * as-is; the default stays the engine-scope reader — correct inside an
 * invocation, and the legacy behavior for the exported helpers.
 */
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

/**
 * Clones a remote template from a GitHub repository.
 * Kept as an exported API; the actual download is delegated to the active
 * template transport (git by default). An explicitly supplied transport
 * (doc 11 commit 5 — the explicit-scope cores) is used as-is so a legacy
 * non-engine operation stays ambient-blind (R1); the default remains the
 * engine-scope reader. The published signature is frozen (§13: unchanged
 * signatures); the clone-failure warning routes raw legacy here (omitted
 * io → R1 default) — the internal WithIo variant below carries the io
 * scope for the io-threaded callers.
 * @param url The repository URL or user/repo shorthand
 * @param dest The destination directory
 * @param ref Optional branch or tag
 * @param transport Optional explicit transport override
 * @returns True if the clone was successful
 */
export function cloneRemoteTemplate(
    url: string,
    dest: string,
    ref?: string,
    transport?: TemplateTransport,
): boolean {
    return cloneRemoteTemplateWithIo(url, dest, ref, transport, undefined);
}

/**
 * INTERNAL io-threaded clone (doc 11 §17 commit 6, Appendix C — not
 * re-exported from `@pzstudio/cli/api`): the §13 clone with an explicit io
 * scope as the emission target of the clone-failure warning. The v2
 * non-engine paths thread the instance logger; an omitted scope routes
 * raw legacy (R1); the transport's own emissions belong to the
 * transport's constructor sink, not to this scope.
 */
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

/**
 * Refreshes a cached template repository using the active transport (or an
 * explicitly supplied one — doc 11 commit 5, R1). Emits nothing here:
 * every refresh emission belongs to the transport, whose routing is its
 * own constructor sink. Signature unchanged (§13).
 * @param dir The cache directory
 * @param ref Optional branch or tag
 * @param transport Optional explicit transport override
 * @returns True if the refresh was successful
 */
export function refreshCachedTemplate(
    dir: string,
    ref?: string,
    transport?: TemplateTransport,
): boolean {
    return (transport ?? getTemplateTransport()).refresh(dir, ref);
}

import { ValidationContext, validateConfig } from '@pzstudio/core';
import { migration } from '@pzstudio/core';

/**
 * Reads the global pzstudio config from ~/.pzstudio/config.json
 * @param validate Whether to validate (and migrate) the config
 *   (default: true)
 * @param io Optional explicit io scope (doc 11 §17 commit 6, Appendix C):
 *   the config-read verbose and the migration/validation warnings route to
 *   its logger; an omitted scope means raw legacy routing (R1).
 */
export function readGlobalConfig(
    validate: boolean = true,
    io?: IoScope | undefined,
): GlobalConfig {
    const configPath = getConfigPath();
    const configDir = getConfigDir();
    emitVerbose(io, `Reading global config from: ${configPath}`);

    // Default values for global config
    const defaultConfig: GlobalConfig = {
        templates: { ...DEFAULT_TEMPLATES },
        useSymlinks: true,
        outdir: undefined,
    };

    // Fallback for outdir: .pzstudio.bak > default
    const backupPath = join(configDir, '.pzstudio.bak');
    if (existsSync(backupPath)) {
        try {
            defaultConfig.outdir = readFileSync(backupPath, 'utf-8').trim();
        } catch {
            // Fall through
        }
    }
    if (!defaultConfig.outdir) {
        defaultConfig.outdir = join(homedir(), 'Zomboid', 'Workshop');
    }

    if (!existsSync(configPath)) {
        return defaultConfig;
    }
    try {
        const content = readFileSync(configPath, 'utf-8');
        let config = content.trim() ? JSON.parse(content) : {};

        if (validate) {
            // Apply migration FIRST so we validate the modern shape
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

        // Merge defaults with file content
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

/**
 * Migrates the global config to the latest version if needed.
 */
export function migrateGlobalConfigIfNeeded(): void {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
        try {
            // Write initial config with all defaults materialized
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
            // Progress to stderr (CLI-2): --json runs must keep stdout to
            // exactly one JSON document.
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
    } catch (_e) {
        // Silently fail if config is corrupt, readGlobalConfig will handle it
    }
}

/**
 * Writes the global pzstudio config to ~/.pzstudio/config.json
 */
export function writeGlobalConfig(config: GlobalConfig): void {
    const configDir = getConfigDir();
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(getConfigPath(), JSON.stringify(config, null, 4), 'utf-8');
}

/**
 * Validates that a template directory exists and has content.
 */
export function validateTemplateManifest(
    dir: string,
    _expectedCategory: TemplateCategory,
): boolean {
    return isCacheValid(dir);
}

/**
 * Explicit scope for the template readers (doc 11 §17 commit 5, R1): the
 * host settings layers for the template-config override tier and, for
 * resolveTemplateDir, the transport to acquire/refresh with. Supplied by
 * the explicit-scope cores; an omitted scope keeps the engine-scope
 * readers, and an omitted transport inside a scope falls back to the
 * engine-scope reader (the DevSync core always supplies it). `logger`
 * (doc 11 §17 commit 6, Appendix C) is the emission target of every
 * threaded emission on the scope path — the instance logger for the v2
 * non-engine paths; an omitted logger means raw legacy routing (R1).
 */
export interface TemplateScope {
    isOffline?: boolean;
    forceUpdate?: boolean;
    settings?: PzStudioHostSettings | undefined;
    templateTransport?: TemplateTransport | undefined;
    logger?: PzStudioLogger | undefined;
}

/**
 * Normalizes a TemplateScope into an io scope (commit 6, Appendix C): the
 * scope's logger when supplied, else undefined — the R1 raw legacy default
 * the emit* adapters apply. An omitted scope resolves to undefined too.
 */
function scopeIo(scope: TemplateScope | undefined): IoScope | undefined {
    return scope?.logger ? { logger: scope.logger } : undefined;
}

/**
 * Resolves the template cache directory a category would use — WITHOUT any
 * side effect (no clone, no refresh, no cache cleanup). Returns undefined
 * when nothing would resolve for the category. Doctor uses this to report
 * the template state without triggering a download. With an explicit scope
 * the settings come from the caller-supplied snapshot (ambient-blind, R1);
 * without one the engine-scope reader applies.
 */
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

    // Same shorthand getCachePathFromUrl derives, kept as a display name.
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

/**
 * Resolves the template directory for a given category.
 *
 * Resolution chain:
 * 1. Resolved project config (which merges workspace + global)
 * 2. Global config directly (~/.pzstudio/config.json)
 * 3. Cache missing or invalid: clone from config or hardcoded default → cache
 * 4. Clone fails → fall back to local .template-legacy
 * 5. Nothing found → throw actionable error
 *
 * Two call shapes: the legacy positional form
 * `resolveTemplateDir(category, isOffline?, forceUpdate?)` keeps the
 * engine-scope readers (context-aware settings/transport — correct inside
 * an invocation, byte-identical legacy behavior otherwise), and the
 * explicit-scope form `resolveTemplateDir(category, { isOffline?,
 * forceUpdate?, settings?, templateTransport?, logger? })` resolves
 * everything from caller-supplied dependencies (doc 11 §17 commit 5, R1):
 * no ambient context, no legacy anchor. The DevSync plan input uses the
 * scope form with its per-apply raw/instance deps. Emissions on both
 * shapes route through the explicit io scope's logger, else raw legacy
 * (commit 6, Appendix C) — never the engine tier, so no template emission
 * can inherit an active v2 ambient. The published positional signature is
 * frozen: the engine's own commands supply the invocation logger through
 * the internal engine path below, never by widening this export; the
 * scope form carries its logger in the scope.
 */
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

/**
 * INTERNAL engine-command path (doc 11 §12 — not re-exported from
 * `@pzstudio/cli/api`): the positional form's engine-scope settings/
 * transport readers with ONLY the emission target set to the
 * context-aware engineIo() logger, so command template emissions follow
 * the active invocation logger. Ambient awareness enters only through
 * this explicit engine caller.
 */
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

    // If offline, try cache first, then legacy for defaults
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

    // Online mode: use cache if valid and not forcing update
    if (isCacheValid(cacheDir, transport)) {
        if (force) {
            if (
                refreshCachedTemplate(cacheDir, templateConfig.ref, transport)
            ) {
                return cacheDir;
            }
            emitWarn(io, `Failed to refresh template cache. Re-cloning...`);
            rmSync(cacheDir, { recursive: true, force: true });
        } else {
            return cacheDir;
        }
    } else if (existsSync(cacheDir)) {
        // Invalid cache: clean up before re-clone
        emitWarn(io, `Template cache at ${cacheDir} is invalid. Re-cloning...`);
        rmSync(cacheDir, { recursive: true, force: true });
    }

    // Re-clone or initial clone
    if (!isOfficialTemplate(templateConfig.url)) {
        emitWarn(
            io,
            `⚠ Cloning from community template '${templateConfig.url}'. Not verified by PZStudio.`,
        );
    }

    mkdirSync(dirname(cacheDir), { recursive: true });

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
        emitWarn(io, `Failed to clone template from '${templateConfig.url}'.`);
    }

    // Fallback to legacy for official templates only if clone/cache failed
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

/**
 * Scaffolds a project by copying files from a template with filtering.
 * Supports directory junctions for specific folders if useSymlinks is enabled.
 *
 * When `options.outputRoot` declares the configured build output root, the
 * copy is guarded against alias routes (F23-WRITE P0, doc 17 §11.4 rule 2 —
 * opt-in; every other consumer of this helper keeps today's behavior): the
 * destination chain is authorized once before the copy, and each destination
 * entry the copy writes onto or descends through must not be a symbolic
 * link. Unrelated links in the destination that the copy never touches
 * cause no refusal.
 */
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
    // The guard wraps the ignore filter so it runs at exactly the entries
    // the copy is about to write onto or descend through — both for the
    // top-level entries below and inside cpSync's recursive traversal
    // (fs.cpSync invokes the filter for the root and for every entry before
    // that entry is inspected or written, and propagates a throwing filter
    // as a copy error). Inclusion comes first: an excluded source entry is
    // never written onto or descended into, so its destination name must
    // not trigger an alias refusal (F1 — Core parity: execute.ts evaluates
    // the inclusion policy before the destination-entry clash). Each
    // authorization lists the destination directory fresh: the copy itself
    // can create destination links (an included source symlink is
    // re-created as a destination link), so a listing captured earlier in
    // this same copy may already be stale.
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

/**
 * Specialized helper to scaffold a specific template folder as a link or copy.
 * Used for .template-mod, .template-language, and .libraries.
 */
export function scaffoldTemplateFolder(
    templateDir: string,
    destDir: string,
    useSymlinks: boolean,
): void {
    if (useSymlinks) {
        try {
            if (existsSync(destDir)) {
                // If it's already a link or dir, we might want to skip or recreate
                // For safety in 'new', we assume destDir shouldn't exist or we can overwrite
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

    // Fallback or explicit copy
    scaffoldProject(templateDir, destDir, false, false);
}
