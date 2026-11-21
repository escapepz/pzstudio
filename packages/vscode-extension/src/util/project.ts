import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import path from 'path';
import { t } from './l10n';

export interface ModSummary {
    id: string;
    name?: string;
}

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

export interface PickedMod {
    modId: string;
    projectDir: vscode.Uri;
}

export interface PickModIdOptions {
    projectDir?: vscode.Uri;
    action?: string;
}

export function warnNoProject(action: string): void {
    vscode.window.showWarningMessage(
        t(
            "PZStudio: no PZ project (project.json) found in this workspace — nothing to {0}. Use 'PZStudio: New Project' to create one.",
            action,
        ),
    );
}

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

export const PROJECT_SCAN_LIMITS = {
    maxRootProjects: 10,
    maxSubfolderProjects: 10,
};

const SKIPPED_DIR_NAMES = new Set(['node_modules', 'dist']);

export async function findProjectDirs(): Promise<{
    dirs: vscode.Uri[];
    truncated: boolean;
}> {
    const dirs: vscode.Uri[] = [];
    let truncated = false;

    let rootBudget = PROJECT_SCAN_LIMITS.maxRootProjects;
    let subfolderBudget = PROJECT_SCAN_LIMITS.maxSubfolderProjects;

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
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
        } catch {}

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
            } catch {}
        }
    }

    return { dirs, truncated };
}

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
        } catch {}
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return undefined;
}

export interface ModConfigSnapshot {
    fields: Record<string, string | string[]>;
    modInfo?: string;
    state: 'included' | 'dev only' | 'excluded';
}

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

export interface ProjectSummary {
    title?: string;
    id?: string;
}

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

export type ProjectResolution =
    | { status: 'resolved'; dir: vscode.Uri }
    | { status: 'cancelled' }
    | { status: 'no-project' };

export async function resolveProjectDirResult(
    action: string,
): Promise<ProjectResolution> {
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeFile) {
        const enclosing = await findEnclosingProjectDir(activeFile);
        if (enclosing) {
            return { status: 'resolved', dir: enclosing };
        }
    }

    const { dirs } = await findProjectDirs();
    if (dirs.length === 1) {
        return { status: 'resolved', dir: dirs[0] };
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
        if (!picked) {
            return { status: 'cancelled' };
        }
        return { status: 'resolved', dir: picked.dir };
    }
    return { status: 'no-project' };
}

export async function resolveProjectDir(
    action: string,
): Promise<vscode.Uri | undefined> {
    const result = await resolveProjectDirResult(action);
    return result.status === 'resolved' ? result.dir : undefined;
}
