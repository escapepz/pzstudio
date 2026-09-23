import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import path from 'path';

/**
 * Reads the mod ids from project.json in the workspace folder.
 * Returns an empty list when there is no project or the file is unreadable.
 */
export async function getModIds(): Promise<string[]> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return [];
    }
    try {
        const fileUri = vscode.Uri.joinPath(folder.uri, 'project.json');
        const content = new TextDecoder().decode(
            await vscode.workspace.fs.readFile(fileUri),
        );
        const config = JSON.parse(content);
        return Object.keys(config?.mods ?? {});
    } catch {
        return [];
    }
}

/**
 * Asks for a mod id via a quick-pick of the project's mods, falling back
 * to a free-text input when the project has no mods or project.json is
 * missing.
 */
export async function pickModId(prompt: string): Promise<string | undefined> {
    const modIds = await getModIds();
    if (modIds.length > 0) {
        const picked = await vscode.window.showQuickPick(modIds, {
            placeHolder: prompt,
        });
        return picked;
    }
    return vscode.window.showInputBox({ prompt });
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

/**
 * Resolves the project a command should run against, without the caller
 * having to know the workspace layout:
 * 1. the project containing the active editor's file (most intent, no UI),
 * 2. the only discovered project, auto-selected,
 * 3. a quick-pick of every discovered project (workspace roots and
 *    depth-1 subfolders — the same discovery the tree view uses).
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
        const picked = await vscode.window.showQuickPick(
            dirs.map((dir) => ({
                label: dir.path.split('/').pop() ?? dir.path,
                detail: dir.fsPath,
                dir,
            })),
            { placeHolder: `Select the project to ${action}` },
        );
        return picked?.dir;
    }
    return undefined;
}
