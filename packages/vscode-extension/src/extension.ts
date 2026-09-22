import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import {
    setLogger,
    setProjectDir,
    setVsCodeSettings,
    runCLI,
    ILogger,
} from 'pzstudio-cli/api';

function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel(
        'Project Zomboid Studio',
    );

    setLogger({
        log: (msg: string) => outputChannel.appendLine(msg),
        info: (msg: string) =>
            outputChannel.appendLine(`[${getTimestamp()}] [INFO] ${msg}`),
        warn: (msg: string) =>
            outputChannel.appendLine(`[${getTimestamp()}] [WARN] ${msg}`),
        error: (err: string | Error) => {
            const timestamp = getTimestamp();
            if (err instanceof Error) {
                outputChannel.appendLine(
                    `[${timestamp}] [ERROR] ${err.message}\n${err.stack}`,
                );
            } else {
                outputChannel.appendLine(`[${timestamp}] [ERROR] ${err}`);
            }
            vscode.window.showErrorMessage(
                `PZStudio Error: ${err instanceof Error ? err.message : err}`,
            );
        },
        clear: () => outputChannel.clear(),
    });

    function updateVsCodeSettings() {
        const config = vscode.workspace.getConfiguration('pzstudio');
        const outdirInspect = config.inspect<string>('outdir');
        const useSymlinksInspect = config.inspect<boolean>('useSymlinks');

        const extractTemplates = (
            valueKey: 'workspaceValue' | 'globalValue',
        ) => {
            const result: any = {};
            for (const cat of ['project', 'mod', 'workshop', 'language']) {
                const catConfig = vscode.workspace.getConfiguration(
                    `pzstudio.templates.${cat}`,
                );
                const url = catConfig.inspect<string>('url')?.[valueKey];
                const ref = catConfig.inspect<string>('ref')?.[valueKey];
                if (url) {
                    result[cat] = { url, ...(ref ? { ref } : {}) };
                }
            }
            return Object.keys(result).length > 0 ? result : undefined;
        };

        setVsCodeSettings(
            {
                templates: extractTemplates('workspaceValue'),
                outdir: outdirInspect?.workspaceValue,
                useSymlinks: useSymlinksInspect?.workspaceValue,
            },
            {
                templates: extractTemplates('globalValue'),
                outdir: outdirInspect?.globalValue,
                useSymlinks: useSymlinksInspect?.globalValue,
            },
        );
    }

    updateVsCodeSettings();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('pzstudio')) {
                updateVsCodeSettings();
            }
        }),
    );

    function resolveFlags(command: string): string[] {
        const config = vscode.workspace.getConfiguration('pzstudio');
        const flags: string[] = [];

        if (config.get<boolean>('verbose')) {
            flags.push('--verbose');
        }

        if (command === 'new' || command === 'add') {
            if (config.get<boolean>('offline')) {
                flags.push('--offline');
            }
            if (config.get<boolean>('forceUpdate')) {
                flags.push('--force-update');
            }
            if (config.get<boolean>('useSymlinks')) {
                flags.push('--symlinks');
            }
        }

        if (command === 'build') {
            const target = config.get<string>('build.target');
            if (target === 'production') {
                flags.push('--production');
            } else if (target === 'development') {
                flags.push('--development');
            }
        }

        return flags;
    }

    /**
     * Reads the mod ids from project.json in the workspace folder.
     * Returns an empty list when there is no project or the file is unreadable.
     */
    async function getModIds(): Promise<string[]> {
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
    async function pickModId(prompt: string): Promise<string | undefined> {
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
    async function pickProjectFolder(): Promise<
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

    // One command at a time: runCLI is not reentrant (shared global state
    // for project dir/settings), so overlap would mis-parse flags.
    const busyCommands = new Set<string>();

    const executePZCommand = async (
        command: string,
        args: string[] = [],
        extraFlags: string[] = [],
    ) => {
        if (busyCommands.has(command)) {
            vscode.window.showWarningMessage(
                `PZStudio: command '${command}' is already running.`,
            );
            return;
        }
        busyCommands.add(command);

        try {
            const folder = await pickProjectFolder();
            setProjectDir(folder?.uri.fsPath);

            // Flags are passed explicitly to runCLI — no process.argv mutation.
            const flags = [...resolveFlags(command), ...extraFlags];
            const verboseMode = flags.includes('--verbose');

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `PZStudio: ${command}`,
                    cancellable: false,
                },
                async () => {
                    try {
                        await runCLI(command, args, { flags });
                    } catch (e) {
                        // Already surfaced by logger.error
                    }
                },
            );

            if (verboseMode) {
                outputChannel.show(true);
            }
        } finally {
            busyCommands.delete(command);
        }
    };

    const commands = [
        vscode.commands.registerCommand('pzstudio.build', () =>
            executePZCommand('build'),
        ),
        vscode.commands.registerCommand('pzstudio.clean', () =>
            executePZCommand('clean'),
        ),
        vscode.commands.registerCommand('pzstudio.update', () =>
            executePZCommand('update'),
        ),

        vscode.commands.registerCommand('pzstudio.new', async () => {
            const projectTitle = await vscode.window.showInputBox({
                prompt: 'Enter Project Title',
                placeHolder: 'My Awesome Mod',
            });
            if (!projectTitle) return;

            const modId = await vscode.window.showInputBox({
                prompt: 'Enter Mod ID (Optional, leave blank for auto-generated)',
                placeHolder: 'my_awesome_mod',
            });

            // Issue #43: let the user pick where the project is created,
            // instead of always using the current workspace folder.
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
            const lastUsed = context.workspaceState.get<string>(
                'pzstudio.lastNewProjectDestination',
            );
            const defaultUri =
                workspaceFolder ??
                (lastUsed ? vscode.Uri.file(lastUsed) : undefined);

            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Destination Folder',
                title: `Create project '${projectTitle}' in...`,
                defaultUri,
            });

            // A selection wins; cancelling falls back to the default
            // (workspace folder or last used destination)
            let destination: string | undefined;
            if (picked && picked.length > 0) {
                destination = picked[0].fsPath;
                context.workspaceState.update(
                    'pzstudio.lastNewProjectDestination',
                    destination,
                );
            } else if (defaultUri) {
                destination = defaultUri.fsPath;
            }

            if (!destination) {
                vscode.window.showWarningMessage(
                    'PZStudio: No destination folder selected, project creation cancelled.',
                );
                return;
            }

            await executePZCommand(
                'new',
                [projectTitle, modId || ''],
                ['--path', destination],
            );
        }),

        vscode.commands.registerCommand('pzstudio.add', async () => {
            const modName = await vscode.window.showInputBox({
                prompt: 'Enter Mod Name',
                placeHolder: 'My New Mod',
            });
            if (!modName) return;

            const modId = await vscode.window.showInputBox({
                prompt: 'Enter Mod ID (Optional, leave blank for auto-generated)',
                placeHolder: 'my_new_mod',
            });

            await executePZCommand('add', [modName, modId || '']);
        }),

        vscode.commands.registerCommand('pzstudio.delete', async () => {
            const modId = await pickModId('Select mod to delete');
            if (!modId) return;

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to delete mod '${modId}'? This cannot be undone.`,
                { modal: true },
                'Yes',
            );
            if (confirm !== 'Yes') return;

            await executePZCommand('delete', [modId]);
        }),

        vscode.commands.registerCommand('pzstudio.rename', async () => {
            const modId = await pickModId('Select mod to rename');
            if (!modId) return;

            const newName = await vscode.window.showInputBox({
                prompt: 'Enter new Mod Name',
            });
            if (!newName) return;

            await executePZCommand('rename', [modId, newName]);
        }),

        vscode.commands.registerCommand('pzstudio.lang', async () => {
            const modId = await pickModId('Select mod');
            if (!modId) return;

            const language = await vscode.window.showInputBox({
                prompt: 'Enter language code (e.g. EN, FR, PTBR)',
            });
            if (!language) return;

            await executePZCommand('lang', [modId, language]);
        }),

        vscode.commands.registerCommand(
            'pzstudio.modinfoGenerate',
            async () => {
                const modId = await pickModId(
                    'Select mod to generate mod.info for',
                );

                await executePZCommand('modinfo', [
                    'generate',
                    ...(modId ? [modId] : []),
                ]);
            },
        ),
    ];

    context.subscriptions.push(outputChannel, ...commands);
}

export function deactivate() {
    setLogger(undefined);
    setProjectDir(undefined);
    setVsCodeSettings(undefined, undefined);
}
