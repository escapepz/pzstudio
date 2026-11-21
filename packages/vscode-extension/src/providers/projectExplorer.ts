import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import { createIgnoreMatcher, readIgnoreRulesForDir } from '@pzstudio/cli/api';
import type { IgnoreRuleSet } from '@pzstudio/cli/api';
import { findProjectDirs } from '../util/project';
import { t } from '../util/l10n';
import type { ProjectDiagnosticsSummary } from '../util/doctor';
import { ruleFileFs } from '../util/ruleFs';

export const PROJECT_EXPLORER_VIEW_ID = 'pzstudio.projectExplorer';

export const REFRESH_DEBOUNCE_MS = 500;

interface ProjectConfig {
    workshop?: { title?: string; id?: string | number };
    mods?: Record<string, { build?: { devOnly?: boolean } } | undefined>;
    excludes?: string[];
}

type ModBuildState = 'included' | 'devonly' | 'excluded';

export const PROJECT_FOLDER_ICON_LIGHT =
    'resources/icons/pzstudio-project-explorer-light.svg';
export const PROJECT_FOLDER_ICON_DARK =
    'resources/icons/pzstudio-project-explorer-dark.svg';

export const SHOW_ALL_FILES_CONTEXT_KEY = 'pzstudioExplorer.showAllFiles';

export const MOD_BRANCH_INFO_FILE = 'mod.info';
export const MOD_BRANCH_ICON_FILE = 'icon.png';

export type DiagnosticsSource = (
    projectDir: vscode.Uri,
) => Promise<ProjectDiagnosticsSummary | undefined>;

function modStateDescription(state: ModBuildState): string {
    const descriptions: Record<ModBuildState, string> = {
        included: t('included'),
        devonly: t('dev builds only'),
        excluded: t('excluded from build'),
    };
    return descriptions[state];
}

interface DiagnosticsCacheEntry {
    summary: ProjectDiagnosticsSummary | undefined;
    fingerprint: string;
}

function projectCacheKey(dir: vscode.Uri): string {
    return dir.fsPath || dir.path;
}

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
        } catch {}
    }
    return undefined;
}

const PROJECT_ROOT_FILES = new Set(['project.json', '.emmyrc.json']);

function relativeSegments(
    base: vscode.Uri,
    uri: vscode.Uri,
): string[] | undefined {
    const basePath = base.path.replace(/\/+$/, '');
    const uriPath = uri.path.replace(/\/+$/, '');
    if (uriPath === basePath) {
        return [];
    }
    if (!uriPath.startsWith(`${basePath}/`)) {
        return undefined;
    }
    return uriPath.slice(basePath.length + 1).split('/');
}

interface TreeElement {
    kind: 'project' | 'directory' | 'file' | 'missing-mod' | 'placeholder';
    uri: vscode.Uri;
    projectDir: vscode.Uri;
    label: string;
    collapsible: vscode.TreeItemCollapsibleState;
    description?: string;
    tooltip?: string;
    modId?: string;
    modState?: ModBuildState;
    iconUri?: vscode.Uri;
}

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
    private readonly diagnostics?: DiagnosticsSource;
    private readonly diagnosticsCache = new Map<
        string,
        DiagnosticsCacheEntry
    >();
    private readonly inFlightDiagnostics = new Map<
        string,
        Promise<ProjectDiagnosticsSummary | undefined>
    >();
    private diagnosticsGeneration = 0;
    private disposed = false;

    constructor(extensionUri: vscode.Uri, diagnostics?: DiagnosticsSource) {
        this.projectIcon = {
            light: vscode.Uri.joinPath(extensionUri, PROJECT_FOLDER_ICON_LIGHT),
            dark: vscode.Uri.joinPath(extensionUri, PROJECT_FOLDER_ICON_DARK),
        };
        this.diagnostics = diagnostics;
    }

    toggleShowAllFiles(): void {
        this.showAllFiles = !this.showAllFiles;
        this.syncShowAllFilesContext();
        this.refresh();
    }

    syncShowAllFilesContext(): void {
        void vscode.commands.executeCommand(
            'setContext',
            SHOW_ALL_FILES_CONTEXT_KEY,
            this.showAllFiles,
        );
    }

    refresh(options?: { invalidateDiagnostics?: boolean }): void {
        if (options?.invalidateDiagnostics) {
            this.invalidateDiagnostics();
        }
        this._onDidChangeTreeData.fire();
    }

    invalidateDiagnostics(): void {
        this.diagnosticsGeneration++;
        this.diagnosticsCache.clear();
        this.inFlightDiagnostics.clear();
    }

    dispose(): void {
        this.disposed = true;
        this.diagnosticsCache.clear();
        this.inFlightDiagnostics.clear();
    }

    requestRefresh(): void {
        if (this.refreshTimer) {
            return;
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.refresh();
        }, REFRESH_DEBOUNCE_MS);
    }

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
                    this.diagnosticsCache.delete(key);
                }
                return summary;
            });
        }
        const runGeneration = this.diagnosticsGeneration;
        const promise = this.diagnostics!(dir);
        promise.catch(() => undefined);
        this.inFlightDiagnostics.set(key, promise);
        return promise.then(
            (summary) => {
                if (this.inFlightDiagnostics.get(key) === promise) {
                    this.inFlightDiagnostics.delete(key);
                }
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
                (
                    item as vscode.TreeItem & {
                        projectDir?: vscode.Uri;
                    }
                ).projectDir = element.projectDir;
                item.contextValue = 'project';
                break;
            case 'directory':
                if (element.modId) {
                    item.iconPath =
                        element.iconUri ?? new vscode.ThemeIcon('folder');
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

    private async childrenIgnoreFilter(
        element: TreeElement,
    ): Promise<((name: string) => boolean) | undefined> {
        const relSegments = relativeSegments(element.projectDir, element.uri);
        if (!relSegments) {
            return undefined;
        }
        try {
            const rulesByDir: Record<string, IgnoreRuleSet> = {};
            for (let end = relSegments.length; end >= 0; end -= 1) {
                const dirUri =
                    end === 0
                        ? element.projectDir
                        : vscode.Uri.joinPath(
                              element.projectDir,
                              ...relSegments.slice(0, end),
                          );
                const key = relSegments.slice(0, end).join('/');
                rulesByDir[key] = await readIgnoreRulesForDir(
                    ruleFileFs,
                    dirUri.toString(),
                );
            }
            const matcher = createIgnoreMatcher(rulesByDir);
            return (name: string) =>
                matcher.isIgnored([...relSegments, name].join('/'));
        } catch {
            return undefined;
        }
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

        const isRuleIgnored = await this.childrenIgnoreFilter(element);

        const directories: TreeElement[] = [];
        const files: TreeElement[] = [];
        const seenModDirs = new Set<string>();

        for (const [name, type] of entries) {
            if (name.startsWith('.')) {
                continue;
            }
            const isMod =
                type === vscode.FileType.Directory &&
                project.mods?.[name] != null;
            if (isMod) {
                seenModDirs.add(name);
            }
            if (isRuleIgnored?.(name)) {
                continue;
            }
            const childUri = vscode.Uri.joinPath(element.uri, name);
            if (type === vscode.FileType.Directory) {
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
                    iconUri: isMod
                        ? await resolveModFolderIcon(
                              childUri,
                              (dir) => vscode.workspace.fs.readDirectory(dir),
                              (fileUri) => vscode.workspace.fs.stat(fileUri),
                          )
                        : undefined,
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
        const isRuleIgnored = await this.childrenIgnoreFilter(element);
        for (const [name, type] of entries) {
            if (name.startsWith('.')) {
                continue;
            }
            if (isRuleIgnored?.(name)) {
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
