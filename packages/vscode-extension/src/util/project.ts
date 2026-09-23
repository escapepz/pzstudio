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
