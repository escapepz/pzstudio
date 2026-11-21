import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { t } from '../util/l10n';

const LAST_DESTINATION_KEY = 'pzstudio.lastNewProjectDestination';

function resolveDefaultDestination(
    context: vscode.ExtensionContext,
): vscode.Uri | undefined {
    const configured = vscode.workspace
        .getConfiguration('pzstudio')
        .inspect<string>('newProject.defaultLocation')?.globalValue;
    if (configured) {
        return vscode.Uri.file(configured);
    }
    const lastUsed = context.workspaceState.get<string>(LAST_DESTINATION_KEY);
    if (lastUsed) {
        return vscode.Uri.file(lastUsed);
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri;
}

async function pickNewProjectDestination(
    context: vscode.ExtensionContext,
): Promise<string | undefined> {
    const defaultUri = resolveDefaultDestination(context);
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: t('Select Destination Folder'),
        title: t('Create project in...'),
        defaultUri,
    });

    if (picked && picked.length > 0) {
        return picked[0].fsPath;
    }
    return undefined;
}

async function getWorkspaceProjectDestination(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage(
            t(
                'PZStudio: Open a workspace folder before creating a project here.',
            ),
        );
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0].uri.fsPath;
    }

    const selected = await vscode.window.showQuickPick(
        folders.map((folder) => ({
            label: folder.name,
            description: folder.uri.fsPath,
            folder,
        })),
        { placeHolder: t('Select the workspace folder for the new project') },
    );
    return selected?.folder.uri.fsPath;
}

async function scanChildProjectJson(
    destination: vscode.Uri,
): Promise<Set<string> | undefined> {
    let entries: Array<[string, vscode.FileType]>;
    try {
        entries = await vscode.workspace.fs.readDirectory(destination);
    } catch {
        return undefined;
    }
    const found = new Set<string>();
    for (const [name, type] of entries) {
        if (!(type & vscode.FileType.Directory)) continue;
        const projectJson = vscode.Uri.joinPath(
            destination,
            name,
            'project.json',
        );
        try {
            await vscode.workspace.fs.stat(projectJson);
            found.add(projectJson.fsPath);
        } catch (e) {
            if ((e as { code?: string })?.code === 'FileNotFound') continue;
            return undefined;
        }
    }
    return found;
}

async function createProject(
    execute: ExecutePZCommand,
    destination: string,
): Promise<boolean> {
    const projectTitle = await vscode.window.showInputBox({
        prompt: t('Enter Project Title'),
        placeHolder: t('My Awesome Mod'),
    });
    if (!projectTitle) return false;

    const modId = await vscode.window.showInputBox({
        prompt: t('Enter Mod ID (Optional, leave blank for auto-generated)'),
        placeHolder: 'my_awesome_mod',
    });
    if (modId === undefined) return false;

    const destinationUri = vscode.Uri.file(destination);
    const before = await scanChildProjectJson(destinationUri);

    await execute('new', [projectTitle, modId], ['--path', destination], {
        projectDir: destination,
    });

    const after = await scanChildProjectJson(destinationUri);
    return (
        before !== undefined &&
        after !== undefined &&
        [...after].some((projectJson) => !before.has(projectJson))
    );
}

export function registerNewCommands(
    context: vscode.ExtensionContext,
    execute: ExecutePZCommand,
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('pzstudio.new', async () => {
            const destination = await pickNewProjectDestination(context);
            if (!destination) return;
            const created = await createProject(execute, destination);
            if (created) {
                context.workspaceState.update(
                    LAST_DESTINATION_KEY,
                    destination,
                );
            }
        }),
        vscode.commands.registerCommand('pzstudio.newHere', async () => {
            const destination = await getWorkspaceProjectDestination();
            if (!destination) return;
            await createProject(execute, destination);
        }),
    ];
}
