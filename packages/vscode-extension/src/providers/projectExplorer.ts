import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import { findProjectDirs } from '../util/project';

export const PROJECT_EXPLORER_VIEW_ID = 'pzstudio.projectExplorer';

/** Coalesce rapid refresh sources (watcher, command runs) into one rescan. */
export const REFRESH_DEBOUNCE_MS = 500;

interface ProjectConfig {
    workshop?: { title?: string; id?: string | number };
    mods?: Record<string, unknown>;
    excludes?: string[];
}

/**
 * Files at the project root worth showing by default — everything the
 * tooling reads. Anything else is only listed after toggling "show all
 * files"; subfolders are never filtered.
 */
const PROJECT_ROOT_FILES = new Set(['project.json', '.emmyrc.json']);

/** Maps file names to ThemeIcons, mirroring VS Code's file-type conventions. */
const FILE_TYPE_ICONS: ReadonlyArray<[RegExp, string]> = [
    [/\.lua$/i, 'file-code'],
    [/\.json$/i, 'json'],
    [/\.txt$|\.info$/i, 'file-text'],
    [/\.md$/i, 'markdown'],
    [/\.(png|jpe?g|gif|tga|dds|webp|bmp)$/i, 'file-media'],
];

function fileTypeIcon(label: string): vscode.ThemeIcon {
    for (const [pattern, id] of FILE_TYPE_ICONS) {
        if (pattern.test(label)) {
            return new vscode.ThemeIcon(id);
        }
    }
    return new vscode.ThemeIcon('file');
}

interface TreeElement {
    kind: 'project' | 'directory' | 'file' | 'missing-mod' | 'placeholder';
    /** Directory or file this node mirrors; synthetic nodes reuse the parent. */
    uri: vscode.Uri;
    /** The project this node belongs to (for context-menu commands). */
    projectDir: vscode.Uri;
    label: string;
    collapsible: vscode.TreeItemCollapsibleState;
    description?: string;
    /** Set when this node is a mod folder known to project.json. */
    modId?: string;
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

    /**
     * Whether the project root also shows non-essential files. Subfolders
     * always list everything; the toggle only curates the project root.
     */
    toggleShowAllFiles(): void {
        this.showAllFiles = !this.showAllFiles;
        void vscode.commands.executeCommand(
            'setContext',
            'pzstudioExplorer.showAllFiles',
            this.showAllFiles,
        );
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
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

    getTreeItem(element: TreeElement): vscode.TreeItem {
        const item = new vscode.TreeItem(element.label, element.collapsible);
        if (element.description) {
            item.description = element.description;
        }
        switch (element.kind) {
            case 'project':
                item.iconPath = new vscode.ThemeIcon('folder-library');
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
                item.iconPath = new vscode.ThemeIcon('folder');
                if (element.modId) {
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
                    item.contextValue = 'mod';
                }
                break;
            case 'missing-mod':
                item.iconPath = new vscode.ThemeIcon('warning');
                item.contextValue = 'mod';
                (item as vscode.TreeItem & { modId?: string }).modId =
                    element.modId;
                (
                    item as vscode.TreeItem & { projectDir?: vscode.Uri }
                ).projectDir = element.projectDir;
                break;
            case 'file':
                item.iconPath = fileTypeIcon(element.label);
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
            return [infoNode('No project found in the workspace.')];
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
            nodes.push({
                kind: 'project',
                uri: dir,
                projectDir: dir,
                label,
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
                description: description || undefined,
            });
        }
        if (truncated) {
            nodes.push(infoNode('More projects not shown (scan limit 20).'));
        }
        return nodes;
    }

    private async getProjectChildren(
        element: TreeElement,
    ): Promise<TreeElement[]> {
        const project = await readProjectConfig(element.uri);
        if (!project) {
            return [infoNode('Failed to read project.json — check the file.')];
        }
        const excludes = Array.isArray(project.excludes)
            ? project.excludes
            : [];

        let entries: [string, vscode.FileType][] = [];
        try {
            entries = await vscode.workspace.fs.readDirectory(element.uri);
        } catch {
            return [infoNode('Failed to read the project folder.')];
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
                directories.push({
                    kind: 'directory',
                    uri: childUri,
                    projectDir: element.projectDir,
                    label: name,
                    collapsible: vscode.TreeItemCollapsibleState.Collapsed,
                    modId: isMod ? name : undefined,
                    description: isMod
                        ? excludes.includes(name)
                            ? 'excluded from build'
                            : 'included'
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
                    description: 'missing on disk',
                }),
            );

        directories.sort((a, b) => a.label.localeCompare(b.label));
        files.sort((a, b) => a.label.localeCompare(b.label));
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
        children.sort((a, b) => a.label.localeCompare(b.label));
        return children;
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
