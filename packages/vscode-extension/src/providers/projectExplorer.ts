import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import { findProjectDirs } from '../util/project';
import { t } from '../util/l10n';
import type { ProjectDiagnosticsSummary } from '../util/doctor';

export const PROJECT_EXPLORER_VIEW_ID = 'pzstudio.projectExplorer';

/** Coalesce rapid refresh sources (watcher, command runs) into one rescan. */
export const REFRESH_DEBOUNCE_MS = 500;

interface ProjectConfig {
    workshop?: { title?: string; id?: string | number };
    mods?: Record<string, { build?: { devOnly?: boolean } } | undefined>;
    excludes?: string[];
}

type ModBuildState = 'included' | 'devonly' | 'excluded';

/**
 * Bundled icon shown for project folders in the explorer tree. Tree rows
 * render file icons as-is (no theme recoloring), so each theme variant
 * carries its own explicit color instead of currentColor.
 */
export const PROJECT_FOLDER_ICON_LIGHT =
    'resources/icons/pzstudio-project-explorer-light.svg';
export const PROJECT_FOLDER_ICON_DARK =
    'resources/icons/pzstudio-project-explorer-dark.svg';

/** When-clause key exposing the show-all-files toggle state to menus. */
export const SHOW_ALL_FILES_CONTEXT_KEY = 'pzstudioExplorer.showAllFiles';

/**
 * A mod folder's icon comes from its first branch subfolder that both
 * looks like a mod branch (contains mod.info) and carries an icon.png.
 */
export const MOD_BRANCH_INFO_FILE = 'mod.info';
export const MOD_BRANCH_ICON_FILE = 'icon.png';

/**
 * Supplies the shared diagnostics for one project. Wired from
 * extension.ts with the same engine `pzstudio doctor` runs; optional so
 * tests and lightweight embeddings can leave diagnostics off.
 */
export type DiagnosticsSource = (
    projectDir: vscode.Uri,
) => Promise<ProjectDiagnosticsSummary | undefined>;

/** A function so the state labels re-translate when the language changes. */
function modStateDescription(state: ModBuildState): string {
    const descriptions: Record<ModBuildState, string> = {
        included: t('included'),
        devonly: t('dev builds only'),
        excluded: t('excluded from build'),
    };
    return descriptions[state];
}

/**
 * Cached doctor summary for one project, valid for exactly one observed
 * project.json state. The fingerprint is captured BEFORE the run starts,
 * so a file changed mid-run never validates the stale result.
 */
interface DiagnosticsCacheEntry {
    summary: ProjectDiagnosticsSummary | undefined;
    fingerprint: string;
}

/**
 * Stable identity for a project across tree renders. Discovery rebuilds
 * its URIs on every scan, so object identity is useless; the canonical
 * path string is the key. Real URIs carry fsPath (Windows-normalized);
 * the unit-test mock builds path-only URIs. Two workspace folders differing
 * only by drive-letter case would produce two entries (a duplicate scan at
 * worst — never a cross-project result leak).
 */
function projectCacheKey(dir: vscode.Uri): string {
    return dir.fsPath || dir.path;
}

/**
 * Cheap project.json fingerprint for the diagnostics cache: one stat per
 * project per render (mtime + size), never a directory traversal. An
 * absent/unreadable file is its own stable state ('missing') so a broken
 * project renders the doctor's validation findings without rescanning
 * until the file reappears.
 */
async function projectJsonFingerprint(dir: vscode.Uri): Promise<string> {
    try {
        const stat = await vscode.workspace.fs.stat(
            vscode.Uri.joinPath(dir, 'project.json'),
        );
        return `${stat.mtime}:${stat.size}`;
    } catch {
        return 'missing';
    }
}

/**
 * Pure summary → badge/tooltip mapping. The UX contract (glyphs, severity
 * counts, tooltip listing) is unchanged by the caching layer — the same
 * doctor input renders the same output, it is just computed less often.
 */
function renderDiagnosticsBadge(
    summary: ProjectDiagnosticsSummary | undefined,
): { badge: string; tooltip: string } | undefined {
    if (!summary || summary.report.diagnostics.length === 0) {
        return undefined;
    }

    const glyphs: Record<string, string> = {
        error: '✗',
        warning: '⚠',
        info: '·',
    };
    const badgeParts: string[] = [];
    if (summary.errors > 0) {
        badgeParts.push(`✗ ${summary.errors}`);
    }
    if (summary.warnings > 0) {
        badgeParts.push(`⚠ ${summary.warnings}`);
    }
    const tooltip = summary.report.diagnostics
        .map((d) => `${glyphs[d.severity] ?? '·'} [${d.module}] ${d.message}`)
        .join('\n');
    return { badge: badgeParts.join(' '), tooltip };
}

/**
 * Resolves the mod's build state: excluded wins over dev-only, which wins
 * over included (same precedence as planBuild).
 */
function modBuildState(
    project: ProjectConfig,
    modId: string,
    excludes: string[],
): ModBuildState {
    if (excludes.includes(modId)) {
        return 'excluded';
    }
    if (project.mods?.[modId]?.build?.devOnly === true) {
        return 'devonly';
    }
    return 'included';
}

/**
 * Numeric-alphabet compare: digit runs compare by value ("9" before
 * "10"), everything else falls back to localeCompare ("42" before
 * "common").
 */
export function naturalCompare(a: string, b: string): number {
    const chunksA = a.match(/\d+|\D+/g) ?? [];
    const chunksB = b.match(/\d+|\D+/g) ?? [];
    const len = Math.min(chunksA.length, chunksB.length);
    for (let i = 0; i < len; i++) {
        const ca = chunksA[i];
        const cb = chunksB[i];
        if (ca !== cb) {
            if (/^\d/.test(ca) && /^\d/.test(cb)) {
                return Number(ca) - Number(cb);
            }
            return ca.localeCompare(cb);
        }
    }
    return chunksA.length - chunksB.length;
}

/**
 * Resolves a mod folder's display icon by scanning its level-1 subfolders
 * in numeric-alphabet order. A subfolder only qualifies when it holds a
 * mod.info (i.e. it is a real mod branch); the first such branch that
 * also carries an icon.png wins and the scan stops there. Folders that
 * never qualify yield undefined so the tree keeps the theme folder icon.
 */
export async function resolveModFolderIcon(
    modDir: vscode.Uri,
    listDir: (dir: vscode.Uri) => PromiseLike<[string, vscode.FileType][]>,
    stat: (uri: vscode.Uri) => PromiseLike<{ type: vscode.FileType }>,
): Promise<vscode.Uri | undefined> {
    let entries: [string, vscode.FileType][];
    try {
        entries = await listDir(modDir);
    } catch {
        return undefined;
    }

    const branches = entries
        .filter(
            ([name, type]) =>
                !name.startsWith('.') && type & vscode.FileType.Directory,
        )
        .map(([name]) => name)
        .sort(naturalCompare);

    for (const branch of branches) {
        const branchDir = vscode.Uri.joinPath(modDir, branch);
        const infoUri = vscode.Uri.joinPath(branchDir, MOD_BRANCH_INFO_FILE);
        try {
            const info = await stat(infoUri);
            if (!(info.type & vscode.FileType.File)) {
                continue;
            }
        } catch {
            continue;
        }
        const iconUri = vscode.Uri.joinPath(branchDir, MOD_BRANCH_ICON_FILE);
        try {
            const icon = await stat(iconUri);
            if (icon.type & vscode.FileType.File) {
                return iconUri;
            }
        } catch {
            // valid branch without an icon — keep scanning
        }
    }
    return undefined;
}

/**
 * Files at the project root worth showing by default — everything the
 * tooling reads. Anything else is only listed after toggling "show all
 * files"; subfolders are never filtered.
 */
const PROJECT_ROOT_FILES = new Set(['project.json', '.emmyrc.json']);

interface TreeElement {
    kind: 'project' | 'directory' | 'file' | 'missing-mod' | 'placeholder';
    /** Directory or file this node mirrors; synthetic nodes reuse the parent. */
    uri: vscode.Uri;
    /** The project this node belongs to (for context-menu commands). */
    projectDir: vscode.Uri;
    label: string;
    collapsible: vscode.TreeItemCollapsibleState;
    description?: string;
    /** Plain-text hover for nodes with diagnostics (project rows). */
    tooltip?: string;
    /** Set when this node is a mod folder known to project.json. */
    modId?: string;
    /** Build state of a mod folder, mirrored into its contextValue. */
    modState?: ModBuildState;
    /** icon.png of the mod's first qualifying branch subfolder. */
    iconUri?: vscode.Uri;
}

/**
 * Extracts the project context attached to a project tree item by
 * getTreeItem, so per-project buttons (build/clean) run against exactly the
 * row they sit on — no quick-pick, no ambiguity.
 */
export function asProjectNode(
    node: unknown,
): { projectDir: vscode.Uri } | undefined {
    if (!node || typeof node !== 'object') {
        return undefined;
    }
    const item = node as { projectDir?: unknown };
    if (item.projectDir instanceof vscode.Uri) {
        return { projectDir: item.projectDir };
    }
    return undefined;
}

/**
 * Extracts the mod context attached to a tree item by getTreeItem, so
 * context-menu commands can run against the exact project folder + mod id
 * without any quick-pick.
 */
export function asModNode(
    node: unknown,
): { modId: string; projectDir: vscode.Uri } | undefined {
    if (!node || typeof node !== 'object') {
        return undefined;
    }
    const item = node as { modId?: unknown; projectDir?: unknown };
    if (
        typeof item.modId === 'string' &&
        item.projectDir instanceof vscode.Uri
    ) {
        return { modId: item.modId, projectDir: item.projectDir };
    }
    return undefined;
}

/**
 * Tree view mirroring the on-disk project layout (mods, Build 42 branch
 * folders, media/lua trees) and annotating mod folders with their workshop
 * build status from project.json.
 *
 * project.json is read tolerantly: unreadable or invalid files render a
 * placeholder row instead of throwing (unlike readProjectConfig).
 */
export class ProjectExplorerProvider implements vscode.TreeDataProvider<TreeElement> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<
        TreeElement | undefined | void
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private showAllFiles = false;
    private readonly projectIcon: {
        light: vscode.Uri;
        dark: vscode.Uri;
    };
    /** Shared diagnostics provider; unset until extension.ts wires it. */
    private readonly diagnostics?: DiagnosticsSource;
    /**
     * Doctor summaries per project, bounded by discovery: entries exist
     * only for projects a render actually queried, are evicted when the
     * project disappears, and die with the provider (dispose). No disk
     * persistence, no module-global state.
     */
    private readonly diagnosticsCache = new Map<
        string,
        DiagnosticsCacheEntry
    >();
    /** One in-flight doctor run per project — concurrent renders coalesce. */
    private readonly inFlightDiagnostics = new Map<
        string,
        Promise<ProjectDiagnosticsSummary | undefined>
    >();
    /**
     * Cache generation (UX-11): every full invalidation bumps it. An
     * in-flight doctor run captured the generation it started under — a
     * run a newer generation already abandoned must never repopulate the
     * cache, so previously started findings cannot resurface as
     * newly validated results after a configuration change.
     */
    private diagnosticsGeneration = 0;
    private disposed = false;

    constructor(extensionUri: vscode.Uri, diagnostics?: DiagnosticsSource) {
        this.projectIcon = {
            light: vscode.Uri.joinPath(extensionUri, PROJECT_FOLDER_ICON_LIGHT),
            dark: vscode.Uri.joinPath(extensionUri, PROJECT_FOLDER_ICON_DARK),
        };
        this.diagnostics = diagnostics;
    }

    /**
     * Whether the project root also shows non-essential files. Subfolders
     * always list everything; the toggle only curates the project root.
     */
    toggleShowAllFiles(): void {
        this.showAllFiles = !this.showAllFiles;
        this.syncShowAllFilesContext();
        this.refresh();
    }

    /** Publishes the toggle state for the eye/eye-closed title button. */
    syncShowAllFilesContext(): void {
        void vscode.commands.executeCommand(
            'setContext',
            SHOW_ALL_FILES_CONTEXT_KEY,
            this.showAllFiles,
        );
    }

    /**
     * Rebuilds the tree. Presentation refreshes (expansion, watcher
     * debounce, command runs) reuse cached diagnostics — a doctor run
     * happens only when a project.json fingerprint changed (UX-07). The
     * explicit user refresh (title-bar command) passes
     * invalidateDiagnostics to drop the cache and recompute every badge.
     */
    refresh(options?: { invalidateDiagnostics?: boolean }): void {
        if (options?.invalidateDiagnostics) {
            this.invalidateDiagnostics();
        }
        this._onDidChangeTreeData.fire();
    }

    /**
     * Full diagnostics invalidation (UX-11): called when configuration the
     * doctor consumed changes (pzstudio.gameBuild) — a change the
     * project.json fingerprint cannot observe. Drops every cached
     * summary and severs all in-flight runs (nothing may join them as
     * current results, and their resolutions cannot repopulate the
     * cache), so the next render recomputes against the fresh
     * configuration. Bounded: no new state, just the two existing maps
     * plus a generation counter.
     */
    invalidateDiagnostics(): void {
        this.diagnosticsGeneration++;
        this.diagnosticsCache.clear();
        this.inFlightDiagnostics.clear();
    }

    /** Drops the diagnostics cache with the provider (extension teardown). */
    dispose(): void {
        this.disposed = true;
        this.diagnosticsCache.clear();
        this.inFlightDiagnostics.clear();
    }

    /**
     * Debounced refresh: bursts of change events (watcher, command runs)
     * collapse into a single rescan instead of reloading continuously.
     */
    requestRefresh(): void {
        if (this.refreshTimer) {
            return;
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.refresh();
        }, REFRESH_DEBOUNCE_MS);
    }

    /**
     * Renders the project's diagnostics badge from the cache while the
     * project.json fingerprint still matches, recomputing through the
     * shared source only on a mismatch (first discovery, meaningful
     * change, explicit invalidation). A failing source never breaks the
     * tree — and is never cached, so a later render retries it.
     */
    private async projectDiagnostics(
        dir: vscode.Uri,
    ): Promise<{ badge: string; tooltip: string } | undefined> {
        if (!this.diagnostics) {
            return undefined;
        }
        const key = projectCacheKey(dir);
        const fingerprint = await projectJsonFingerprint(dir);
        const cached = this.diagnosticsCache.get(key);
        if (cached && cached.fingerprint === fingerprint) {
            return renderDiagnosticsBadge(cached.summary);
        }
        try {
            const summary = await this.computeDiagnostics(
                key,
                dir,
                fingerprint,
            );
            return renderDiagnosticsBadge(summary);
        } catch {
            return undefined;
        }
    }

    /**
     * Runs the diagnostics source once per project state: concurrent
     * renders for the same project join the in-flight promise (one actual
     * execution), the result is cached under the fingerprint observed
     * BEFORE the run started, and a stale in-flight result (the project
     * changed mid-run, or the joining render observed a newer state) is
     * dropped instead of kept.
     */
    private computeDiagnostics(
        key: string,
        dir: vscode.Uri,
        fingerprint: string,
    ): Promise<ProjectDiagnosticsSummary | undefined> {
        const inFlight = this.inFlightDiagnostics.get(key);
        if (inFlight) {
            return inFlight.then((summary) => {
                const entry = this.diagnosticsCache.get(key);
                if (entry && entry.fingerprint !== fingerprint) {
                    // The run we joined started from an older project
                    // state than this render observed: drop its result so
                    // the next render recomputes instead of keeping it.
                    this.diagnosticsCache.delete(key);
                }
                return summary;
            });
        }
        const runGeneration = this.diagnosticsGeneration;
        const promise = this.diagnostics!(dir);
        // Keep a handled tail on the stored promise so a rejection can
        // never surface as an unhandled rejection between renders.
        promise.catch(() => undefined);
        this.inFlightDiagnostics.set(key, promise);
        return promise.then(
            (summary) => {
                if (this.inFlightDiagnostics.get(key) === promise) {
                    this.inFlightDiagnostics.delete(key);
                }
                // Only a still-current run may populate the cache: a run
                // invalidated mid-flight (UX-11 configuration change,
                // dispose) must not repopulate a cache that was already
                // abandoned — its result stays decoration only.
                if (
                    !this.disposed &&
                    runGeneration === this.diagnosticsGeneration
                ) {
                    this.diagnosticsCache.set(key, { summary, fingerprint });
                }
                return summary;
            },
            (error) => {
                if (this.inFlightDiagnostics.get(key) === promise) {
                    this.inFlightDiagnostics.delete(key);
                }
                // Failures are never cached: a later render retries.
                throw error;
            },
        );
    }

    getTreeItem(element: TreeElement): vscode.TreeItem {
        const item = new vscode.TreeItem(element.label, element.collapsible);
        if (element.description) {
            item.description = element.description;
        }
        if (element.tooltip) {
            item.tooltip = element.tooltip;
        }
        switch (element.kind) {
            case 'project':
                item.iconPath = this.projectIcon;
                // Inline build/clean buttons on the row target exactly this
                // project; the attached context is read via asProjectNode().
                (
                    item as vscode.TreeItem & {
                        projectDir?: vscode.Uri;
                    }
                ).projectDir = element.projectDir;
                item.contextValue = 'project';
                break;
            case 'directory':
                if (element.modId) {
                    // Mod folders show their first qualifying branch's
                    // icon.png when one exists; other folders stay themed.
                    item.iconPath =
                        element.iconUri ?? new vscode.ThemeIcon('folder');
                    // Context-menu commands receive this item back; the
                    // attached mod context is read via asModNode().
                    (
                        item as vscode.TreeItem & {
                            modId?: string;
                            projectDir?: vscode.Uri;
                        }
                    ).modId = element.modId;
                    (
                        item as vscode.TreeItem & {
                            projectDir?: vscode.Uri;
                        }
                    ).projectDir = element.projectDir;
                    // State-suffixed contextValue drives the per-state inline
                    // buttons (include/dev-only/exclude toggles).
                    item.contextValue = element.modState
                        ? `mod-${element.modState}`
                        : 'mod';
                } else {
                    item.iconPath = new vscode.ThemeIcon('folder');
                }
                break;
            case 'missing-mod':
                item.iconPath = new vscode.ThemeIcon('warning');
                item.contextValue = 'mod-missing';
                (item as vscode.TreeItem & { modId?: string }).modId =
                    element.modId;
                (
                    item as vscode.TreeItem & { projectDir?: vscode.Uri }
                ).projectDir = element.projectDir;
                break;
            case 'file':
                // No iconPath: with resourceUri set, the user's file icon
                // theme renders the icon, matching the Explorer.
                item.resourceUri = element.uri;
                item.command = {
                    command: 'vscode.open',
                    title: 'Open File',
                    arguments: [element.uri],
                };
                break;
            case 'placeholder':
                item.iconPath = new vscode.ThemeIcon('info');
                break;
        }
        return item;
    }

    async getChildren(element?: TreeElement): Promise<TreeElement[]> {
        if (!element) {
            return this.getProjectNodes();
        }
        if (element.kind === 'project') {
            return this.getProjectChildren(element);
        }
        if (element.kind === 'directory') {
            return this.getDirectoryChildren(element);
        }
        return [];
    }

    private async getProjectNodes(): Promise<TreeElement[]> {
        const { dirs, truncated } = await findProjectDirs();
        if (dirs.length === 0) {
            this.diagnosticsCache.clear();
            return [infoNode(t('No project found in the workspace.'))];
        }

        // Evict cached diagnostics for projects that are no longer
        // discovered — removed projects must not linger, and a rediscovered
        // one recomputes fresh instead of resurrecting an old result.
        const discovered = new Set(dirs.map(projectCacheKey));
        for (const key of [...this.diagnosticsCache.keys()]) {
            if (!discovered.has(key)) {
                this.diagnosticsCache.delete(key);
            }
        }

        const nodes: TreeElement[] = [];
        for (const dir of dirs) {
            const project = await readProjectConfig(dir);
            const label = dir.path.split('/').pop() ?? dir.path;
            const description = [
                project?.workshop?.id != null
                    ? `id ${project.workshop.id}`
                    : '',
                project?.workshop?.title,
            ]
                .filter(Boolean)
                .join(' · ');
            const diagnostics = await this.projectDiagnostics(dir);
            nodes.push({
                kind: 'project',
                uri: dir,
                projectDir: dir,
                label,
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
                description:
                    [description, diagnostics?.badge]
                        .filter(Boolean)
                        .join(' · ') || undefined,
                tooltip: diagnostics?.tooltip,
            });
        }
        if (truncated) {
            nodes.push(infoNode(t('More projects not shown (scan limit 20).')));
        }
        return nodes;
    }

    private async getProjectChildren(
        element: TreeElement,
    ): Promise<TreeElement[]> {
        const project = await readProjectConfig(element.uri);
        if (!project) {
            return [
                infoNode(t('Failed to read project.json — check the file.')),
            ];
        }
        const excludes = Array.isArray(project.excludes)
            ? project.excludes
            : [];

        let entries: [string, vscode.FileType][] = [];
        try {
            entries = await vscode.workspace.fs.readDirectory(element.uri);
        } catch {
            return [infoNode(t('Failed to read the project folder.'))];
        }

        const directories: TreeElement[] = [];
        const files: TreeElement[] = [];
        const seenModDirs = new Set<string>();

        for (const [name, type] of entries) {
            if (name.startsWith('.')) {
                continue;
            }
            const childUri = vscode.Uri.joinPath(element.uri, name);
            if (type === vscode.FileType.Directory) {
                const isMod = project.mods?.[name] != null;
                if (isMod) {
                    seenModDirs.add(name);
                }
                const state = isMod
                    ? modBuildState(project, name, excludes)
                    : undefined;
                directories.push({
                    kind: 'directory',
                    uri: childUri,
                    projectDir: element.projectDir,
                    label: name,
                    collapsible: vscode.TreeItemCollapsibleState.Collapsed,
                    modId: isMod ? name : undefined,
                    modState: state,
                    // Mod rows carry the icon.png of their first qualifying
                    // branch subfolder (mod.info + icon.png, natural order,
                    // first hit wins); the tree item falls back to the theme.
                    iconUri: isMod
                        ? await resolveModFolderIcon(
                              childUri,
                              (dir) => vscode.workspace.fs.readDirectory(dir),
                              (fileUri) => vscode.workspace.fs.stat(fileUri),
                          )
                        : undefined,
                    // 'included' is the unremarkable default — only annotate
                    // the special states to keep rows clean.
                    description:
                        isMod && state && state !== 'included'
                            ? modStateDescription(state)
                            : undefined,
                });
            } else if (this.showAllFiles || PROJECT_ROOT_FILES.has(name)) {
                files.push({
                    kind: 'file',
                    uri: childUri,
                    projectDir: element.projectDir,
                    label: name,
                    collapsible: vscode.TreeItemCollapsibleState.None,
                });
            }
        }

        // Mods declared in project.json but missing on disk
        const missingNodes = Object.keys(project.mods ?? {})
            .filter((modId) => !seenModDirs.has(modId))
            .map(
                (modId): TreeElement => ({
                    kind: 'missing-mod',
                    uri: vscode.Uri.joinPath(element.projectDir, modId),
                    projectDir: element.projectDir,
                    label: modId,
                    collapsible: vscode.TreeItemCollapsibleState.None,
                    modId,
                    description: t('missing on disk'),
                }),
            );

        directories.sort((a, b) => naturalCompare(a.label, b.label));
        files.sort((a, b) => naturalCompare(a.label, b.label));
        return [...directories, ...missingNodes, ...files];
    }

    private async getDirectoryChildren(
        element: TreeElement,
    ): Promise<TreeElement[]> {
        let entries: [string, vscode.FileType][] = [];
        try {
            entries = await vscode.workspace.fs.readDirectory(element.uri);
        } catch {
            return [];
        }

        const children: TreeElement[] = [];
        for (const [name, type] of entries) {
            if (name.startsWith('.')) {
                continue;
            }
            const childUri = vscode.Uri.joinPath(element.uri, name);
            children.push({
                kind: type === vscode.FileType.Directory ? 'directory' : 'file',
                uri: childUri,
                projectDir: element.projectDir,
                label: name,
                collapsible:
                    type === vscode.FileType.Directory
                        ? vscode.TreeItemCollapsibleState.Collapsed
                        : vscode.TreeItemCollapsibleState.None,
            });
        }
        // VS Code Explorer convention: folders first, then files, each
        // alphabetically (natural order so "9" precedes "10").
        const directories: TreeElement[] = [];
        const files: TreeElement[] = [];
        for (const child of children) {
            if (child.kind === 'directory') {
                directories.push(child);
            } else {
                files.push(child);
            }
        }
        directories.sort((a, b) => naturalCompare(a.label, b.label));
        files.sort((a, b) => naturalCompare(a.label, b.label));
        return [...directories, ...files];
    }
}

/**
 * Tolerant project.json read: returns undefined instead of throwing when
 * the file is missing or invalid.
 */
async function readProjectConfig(
    projectDir: vscode.Uri,
): Promise<ProjectConfig | undefined> {
    try {
        const content = new TextDecoder().decode(
            await vscode.workspace.fs.readFile(
                vscode.Uri.joinPath(projectDir, 'project.json'),
            ),
        );
        return JSON.parse(content);
    } catch {
        return undefined;
    }
}

function infoNode(label: string): TreeElement {
    return {
        kind: 'placeholder',
        uri: vscode.Uri.file(''),
        projectDir: vscode.Uri.file(''),
        label,
        collapsible: vscode.TreeItemCollapsibleState.None,
    };
}
