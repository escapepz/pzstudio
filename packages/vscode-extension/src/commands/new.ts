import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { t } from '../util/l10n';

const LAST_DESTINATION_KEY = 'pzstudio.lastNewProjectDestination';

/**
 * Preferred default for the New Project destination: the
 * pzstudio.newProject.defaultLocation setting wins, then the last picked
 * destination, then the first workspace folder.
 */
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

/**
 * Destination for "New Project": always a folder picker (issue #43).
 * Cancelling falls back to the default destination instead of aborting.
 */
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
        const destination = picked[0].fsPath;
        context.workspaceState.update(LAST_DESTINATION_KEY, destination);
        return destination;
    }
    return defaultUri?.fsPath;
}

/**
 * Destination for "New Project Here": the opened workspace folder, with a
 * quick-pick when several folders are open.
 */
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

/** Prompts for the project details and scaffolds it under destination. */
async function createProject(
    execute: ExecutePZCommand,
    destination: string,
): Promise<void> {
    const projectTitle = await vscode.window.showInputBox({
        prompt: t('Enter Project Title'),
        placeHolder: t('My Awesome Mod'),
    });
    if (!projectTitle) return;

    const modId = await vscode.window.showInputBox({
        prompt: t('Enter Mod ID (Optional, leave blank for auto-generated)'),
        placeHolder: 'my_awesome_mod',
    });

    await execute(
        'new',
        [projectTitle, modId || ''],
        ['--path', destination],
        // Seed the project dir with the destination: no project exists yet,
        // so the generic resolveProjectDir flow must be skipped.
        { projectDir: destination },
    );
}

export function registerNewCommands(
    context: vscode.ExtensionContext,
    execute: ExecutePZCommand,
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('pzstudio.new', async () => {
            const destination = await pickNewProjectDestination(context);
            if (!destination) {
                vscode.window.showWarningMessage(
                    t(
                        'PZStudio: No destination folder selected, project creation cancelled.',
                    ),
                );
                return;
            }
            await createProject(execute, destination);
        }),
        vscode.commands.registerCommand('pzstudio.newHere', async () => {
            const destination = await getWorkspaceProjectDestination();
            if (!destination) return;
            await createProject(execute, destination);
        }),
    ];
}
