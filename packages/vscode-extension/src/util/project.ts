import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import path from 'path';
import { t } from './l10n';

/** A mod as declared in project.json: its id plus optional display name. */
export interface ModSummary {
    id: string;
    name?: string;
}

/**
 * Reads the mods of ONE project from its project.json, tolerantly:
 * an empty list when the file is missing or unreadable.
 */
export async function getModSummaries(
    projectDir: vscode.Uri,
): Promise<ModSummary[]> {
    try {
        const content = new TextDecoder().decode(
            await vscode.workspace.fs.readFile(
                vscode.Uri.joinPath(projectDir, 'project.json'),
            ),
        );
        const config = JSON.parse(content);
        return Object.entries(config?.mods ?? {})
            .filter(([, mod]) => typeof mod === 'object' && mod !== null)
            .map(([id, mod]) => {
                const name = (mod as { name?: unknown }).name;
                return {
                    id,
                    name: typeof name === 'string' ? name : undefined,
                };
            });
    } catch {
        return [];
    }
}

/** A mod pick bound to the project it belongs to. */
export interface PickedMod {
    modId: string;
    projectDir: vscode.Uri;
}

export interface PickModIdOptions {
    /** Project to pick from; resolved like every other command when omitted. */
    projectDir?: vscode.Uri;
    /** Action phrase for the project picker: "Select the project to {0}". */
    action?: string;
}

/**
 * Friendly warning shown instead of running a command when the workspace
 * has no project at all; the caller aborts right after.
 */
export function warnNoProject(action: string): void {
    vscode.window.showWarningMessage(
        t(
            "PZStudio: no PZ project (project.json) found in this workspace — nothing to {0}. Use 'PZStudio: New Project' to create one.",
            action,
        ),
    );
}

/**
 * Asks for a mod id, always bound to one explicit project:
 * - a project passed in (tree node context) is used as-is,
 * - otherwise the project is resolved first (active editor → only project
 *   → quick-pick), so subfolder and multi-root workspaces work,
 * - a single mod is selected without asking, several mods quick-pick
 *   (label = id, description = display name), and a project without mods
 *   falls back to free text (fresh project).
 * Returns undefined when the user cancels or no project exists at all.
 */
export async function pickModId(
    prompt: string,
    options: PickModIdOptions = {},
): Promise<PickedMod | undefined> {
    let projectDir = options.projectDir;
    if (!projectDir) {
        projectDir = await resolveProjectDir(
            options.action ?? 'pick a mod from',
        );
        if (!projectDir) {
            warnNoProject(options.action ?? 'pick a mod from');
            return undefined;
        }
    }

    const mods = await getModSummaries(projectDir);
    if (mods.length === 1) {
        return { modId: mods[0].id, projectDir };
    }
    if (mods.length > 1) {
        const picked = await vscode.window.showQuickPick(
            mods.map((mod) => ({
                label: mod.id,
                description: mod.name,
                mod,
            })),
            { placeHolder: prompt },
        );
        return picked ? { modId: picked.mod.id, projectDir } : undefined;
    }
    const typed = await vscode.window.showInputBox({ prompt });
    return typed ? { modId: typed, projectDir } : undefined;
}

/** Scan limits: keep the discovery cheap even in huge workspaces. */
export const PROJECT_SCAN_LIMITS = {
    /** Max projects found directly in a workspace root. */
    maxRootProjects: 10,
    /** Max projects found in depth-1 subfolders (pzstudio new creates /root/<project_id>). */
    maxSubfolderProjects: 10,
};

const SKIPPED_DIR_NAMES = new Set(['node_modules', 'dist']);

/**
 * Discovers project directories: every workspace root containing
 * project.json plus every direct subfolder containing one. The scan stops
 * early once the limits are reached to stay fast in huge workspaces;
 * `truncated` reports that more projects exist than were scanned.
 */
export async function findProjectDirs(): Promise<{
    dirs: vscode.Uri[];
    truncated: boolean;
}> {
    const dirs: vscode.Uri[] = [];
    let truncated = false;

    let rootBudget = PROJECT_SCAN_LIMITS.maxRootProjects;
    let subfolderBudget = PROJECT_SCAN_LIMITS.maxSubfolderProjects;

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        // Workspace roots themselves
        try {
            await vscode.workspace.fs.stat(
                vscode.Uri.joinPath(folder.uri, 'project.json'),
            );
            if (rootBudget > 0) {
                dirs.push(folder.uri);
                rootBudget--;
            } else {
                truncated = true;
            }
        } catch {
            // no project.json in this root
        }

        // Direct subfolders (pzstudio new creates <root>/<project_id>)
        let entries: [string, vscode.FileType][] = [];
        try {
            entries = await vscode.workspace.fs.readDirectory(folder.uri);
        } catch {
            continue;
        }
        for (const [name, type] of entries) {
            if (
                subfolderBudget <= 0 ||
                name.startsWith('.') ||
                SKIPPED_DIR_NAMES.has(name) ||
                type !== vscode.FileType.Directory
            ) {
                continue;
            }
            const subUri = vscode.Uri.joinPath(folder.uri, name);
            try {
                await vscode.workspace.fs.stat(
                    vscode.Uri.joinPath(subUri, 'project.json'),
                );
                dirs.push(subUri);
                subfolderBudget--;
            } catch {
                // no project.json in this subfolder
            }
        }
    }

    return { dirs, truncated };
}

/**
 * Finds the nearest enclosing directory with a project.json, walking up
 * from the given path (e.g. the active editor's file) and stopping at
 * workspace roots. Returns undefined when no project.json is found on the
 * way up.
 */
export async function findEnclosingProjectDir(
    startPath: string,
): Promise<vscode.Uri | undefined> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(
        (f) => f.uri.fsPath,
    );
    const isInsideWorkspace = (p: string) =>
        roots.some((root) => p === root || p.startsWith(root + path.sep));

    let dir = path.dirname(startPath);
    while (isInsideWorkspace(dir)) {
        try {
            await vscode.workspace.fs.stat(
                vscode.Uri.joinPath(vscode.Uri.file(dir), 'project.json'),
            );
            return vscode.Uri.file(dir);
        } catch {
            // keep walking up
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return undefined;
}

export interface ModConfigSnapshot {
    /** Simple mod fields (string or string-array values) keyed by name. */
    fields: Record<string, string | string[]>;
    /** build.modInfo value when set. */
    modInfo?: string;
    /** Resolved build state (excluded > dev only > included). */
    state: 'included' | 'dev only' | 'excluded';
}

/**
 * Reads one mod's configuration from project.json tolerantly: returns
 * undefined when the project file or the mod entry is missing/unreadable.
 */
export async function readModConfig(
    projectDir: vscode.Uri,
    modId: string,
): Promise<ModConfigSnapshot | undefined> {
    try {
        const content = new TextDecoder().decode(
            await vscode.workspace.fs.readFile(
                vscode.Uri.joinPath(projectDir, 'project.json'),
            ),
        );
        const config = JSON.parse(content);
        const mod = config?.mods?.[modId];
        if (!mod || typeof mod !== 'object') {
            return undefined;
        }

        const excludes: string[] = Array.isArray(config.excludes)
            ? config.excludes
            : [];
        const state: ModConfigSnapshot['state'] = excludes.includes(modId)
            ? 'excluded'
            : mod.build?.devOnly === true
              ? 'dev only'
              : 'included';

        const fields: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(mod)) {
            if (key === 'build') {
                continue;
            }
            if (typeof value === 'string') {
                fields[key] = value;
            } else if (
                Array.isArray(value) &&
                value.every((item) => typeof item === 'string')
            ) {
                fields[key] = value as string[];
            }
        }

        const modInfo =
            typeof mod.build?.modInfo === 'string'
                ? mod.build.modInfo
                : undefined;
        return { fields, modInfo, state };
    } catch {
        return undefined;
    }
}

/** Workshop identity of a project, for labels. */
export interface ProjectSummary {
    title?: string;
    id?: string;
}

/**
 * Reads workshop title/id from a project's project.json for labels,
 * tolerantly (both fields undefined when missing or unreadable).
 */
export async function readProjectSummary(
    projectDir: vscode.Uri,
): Promise<ProjectSummary> {
    try {
        const content = new TextDecoder().decode(
            await vscode.workspace.fs.readFile(
                vscode.Uri.joinPath(projectDir, 'project.json'),
            ),
        );
        const config = JSON.parse(content);
        const title = config?.workshop?.title;
        const id = config?.workshop?.id;
        return {
            title: typeof title === 'string' ? title : undefined,
            id: id != null ? String(id) : undefined,
        };
    } catch {
        return {};
    }
}

/**
 * Resolves the project a command should run against, without the caller
 * having to know the workspace layout:
 * 1. the project containing the active editor's file (most intent, no UI),
 * 2. the only discovered project, auto-selected,
 * 3. a quick-pick of every discovered project (workspace roots and
 *    depth-1 subfolders — the same discovery the tree view uses), each
 *    labeled with its folder name and workshop title.
 * Returns undefined when the workspace has no project at all; callers
 * show a friendly warning instead of running the CLI.
 */
export async function resolveProjectDir(
    action: string,
): Promise<vscode.Uri | undefined> {
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeFile) {
        const enclosing = await findEnclosingProjectDir(activeFile);
        if (enclosing) {
            return enclosing;
        }
    }

    const { dirs } = await findProjectDirs();
    if (dirs.length === 1) {
        return dirs[0];
    }
    if (dirs.length > 1) {
        const picks = await Promise.all(
            dirs.map(async (dir) => {
                const summary = await readProjectSummary(dir);
                return {
                    label: dir.path.split('/').pop() ?? dir.path,
                    description:
                        summary.title ??
                        (summary.id !== undefined
                            ? `id ${summary.id}`
                            : undefined),
                    detail: dir.fsPath,
                    dir,
                };
            }),
        );
        const picked = await vscode.window.showQuickPick(picks, {
            placeHolder: t('Select the project to {0}', action),
        });
        return picked?.dir;
    }
    return undefined;
}
