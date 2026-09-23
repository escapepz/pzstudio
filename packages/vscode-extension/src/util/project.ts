import * as vscode from 'vscode';
import { TextDecoder } from 'util';

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
 * Picks the project folder: the first workspace folder containing
 * project.json; when several (or none) match, ask the user.
 */
export async function pickProjectFolder(): Promise<
    vscode.WorkspaceFolder | undefined
> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        return undefined;
    }
    const withProject: vscode.WorkspaceFolder[] = [];
    for (const folder of folders) {
        try {
            await vscode.workspace.fs.stat(
                vscode.Uri.joinPath(folder.uri, 'project.json'),
            );
            withProject.push(folder);
        } catch {
            // no project.json in this folder
        }
    }
    if (withProject.length === 1) {
        return withProject[0];
    }
    const choices = (withProject.length > 0 ? withProject : folders).map(
        (f) => f.name,
    );
    const picked = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select the project folder',
    });
    return folders.find((f) => f.name === picked);
}
