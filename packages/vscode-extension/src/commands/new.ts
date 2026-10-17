import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { t } from '../util/l10n';

const LAST_DESTINATION_KEY = 'pzstudio.lastNewProjectDestination';

/**
 * Preferred default for the New Project destination: the
 * pzstudio.newProject.defaultLocation setting wins, then the destination
 * of the last successfully created project, then the first workspace
 * folder.
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
 * Cancelling aborts the whole flow (UX-14 / Interaction Spec §13): no
 * fallback selection, the caller returns before any prompt or mutation.
 * The resolved default is only the picker's initial location.
 *
 * Pure: no state is written here. The destination is remembered only
 * after the whole flow completes (A13) — a destination picked but then
 * abandoned at a later prompt is not a completed project location and
 * must not seed the next picker default.
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
        return picked[0].fsPath;
    }
    return undefined;
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

/**
 * The fsPaths of `<destination>/<child>/project.json` for every direct
 * child directory of `destination` that currently holds a project.json, or
 * `undefined` when the scan cannot be completed (the destination is gone or
 * an unexpected fs error occurs).
 *
 * The engine creates the project in a CHILD directory of the destination —
 * join(destination, formatTitleToId(modId || projectTitle), 'project.json')
 * — and never writes project.json at the destination root. Deriving that
 * directory name here would duplicate the CLI's id normalization, so the
 * created location is identified by diffing the child scans instead: this
 * never inspects <destination>/project.json and stays correct wherever the
 * CLI puts the project under the picked destination.
 */
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

/**
 * Prompts for the project details and scaffolds it under destination.
 * Resolves `true` only when the flow completed AND the engine produced a
 * project (a `<destination>/<child>/project.json` appeared that was provably
 * absent before) — the runner swallows engine failures ("already surfaced by
 * logger.error"), so the outcome is verified on disk. Resolves `false` when
 * the user cancelled at a prompt, the scan could not be completed, or the
 * run produced no new project (A13: none of these ever records the
 * destination). A rejection from `execute` propagates.
 */
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
    // undefined = cancelled (Esc): abort the whole flow without invoking
    // the engine. '' = confirmed blank: passed through so the engine
    // derives the id from the title. Distinct semantics — never collapse
    // them with a truthiness check.
    if (modId === undefined) return false;

    const destinationUri = vscode.Uri.file(destination);
    const before = await scanChildProjectJson(destinationUri);

    await execute(
        'new',
        [projectTitle, modId],
        ['--path', destination],
        // Seed the project dir with the destination: no project exists yet,
        // so the generic resolveProjectDir flow must be skipped.
        { projectDir: destination },
    );

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
            // Cancelled or nothing picked: silent abort (A13/UX-14) — no
            // fallback destination, no further prompts, no warning, no
            // mutation.
            if (!destination) return;
            const created = await createProject(execute, destination);
            // A13: only a completed flow records the destination — a
            // cancellation at a prompt (created === false) or a failed run
            // (rejection above) never poisons the next picker default.
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
