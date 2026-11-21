import * as vscode from 'vscode';
import {
    analyzeGameLogFile,
    buildProjectContext,
    createPzStudio,
} from '@pzstudio/cli/api';
import type { ConsoleLogProjectContext } from '@pzstudio/cli/api';
import { createPZLogger, type PZLoggerErrorAction } from './util/logger';
import { initExtensionL10n, t } from './util/l10n';
import { readPzStudioHostSettings } from './util/settings';
import { createCommandRunner } from './util/execute';
import {
    notifyActionSuccess,
    notifyFirstBuildSuccess,
} from './util/firstSuccess';
import { DevSyncController } from './util/devsync';
import {
    DevSyncManager,
    DevSyncStateService,
    type DevSyncState,
} from './util/devSyncState';
import { createProjectDiagnostics } from './util/doctor';
import { registerAllCommands } from './commands';
import { registerAnalyzeGameLogCommand } from './commands/analyzeGameLog';
import { registerExplorerCommands } from './commands/explorer';
import {
    registerWatchCommand,
    registerDevSyncStatusBar,
} from './commands/watch';
import { registerDoctorCommand } from './commands/doctor';
import {
    PROJECT_EXPLORER_VIEW_ID,
    ProjectExplorerProvider,
    SHOW_ALL_FILES_CONTEXT_KEY,
} from './providers/projectExplorer';
import { BuildTaskProvider, PZ_TASK_TYPE } from './providers/buildTaskProvider';

export function devSyncErrorActions(
    getManager: () => DevSyncManager | undefined,
): () => PZLoggerErrorAction[] {
    return () => {
        const manager = getManager();
        if (!manager || manager.state.phase === 'idle') {
            return [];
        }
        return [
            {
                label: t('Stop Sync'),
                run: (): void => {
                    void manager.stop();
                },
            },
        ];
    };
}

export function registerDevSyncTreeBadge<T>(
    manager: DevSyncManager,
    treeView: vscode.TreeView<T>,
): vscode.Disposable {
    const runTitle = (state: DevSyncState): string =>
        state.projectTitle ??
        state.projectDir?.split(/[\\/]/).filter(Boolean).pop() ??
        state.projectDir ??
        '';

    const render = (state: DevSyncState): void => {
        if (state.phase === 'idle') {
            treeView.badge = undefined;
            return;
        }
        const title = runTitle(state);
        let tooltip: string;
        if (state.phase === 'starting') {
            tooltip = t(
                "PZStudio: development sync for '{0}' is starting…",
                title,
            );
        } else if (state.phase === 'stopping') {
            tooltip = t(
                "PZStudio: development sync for '{0}' is stopping…",
                title,
            );
        } else {
            tooltip = t("PZStudio: development sync running for '{0}'.", title);
        }
        treeView.badge = { value: 1, tooltip };
    };

    render(manager.state);
    const subscription = manager.onDidChange(render);
    return {
        dispose(): void {
            subscription.dispose();
        },
    };
}

async function resolveGameLogContext(): Promise<
    ConsoleLogProjectContext | undefined
> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        try {
            await vscode.workspace.fs.stat(
                vscode.Uri.joinPath(folder.uri, 'project.json'),
            );
        } catch {
            continue;
        }
        const context = buildProjectContext(folder.uri.fsPath);
        if (!context) {
            return undefined;
        }
        return {
            mods: (context.mods ?? []).map((mod) => ({
                ...mod,
                sourceRootUri: vscode.Uri.file(mod.sourceRootUri).toString(),
            })),
        };
    }
    return undefined;
}

export async function activate(context: vscode.ExtensionContext) {
    await initExtensionL10n(context);

    const outputChannel = vscode.window.createOutputChannel('PZ Studio');

    const pzLogger = createPZLogger(outputChannel);

    const studio = createPzStudio({
        logger: pzLogger,
        settings: (ctx) => readPzStudioHostSettings(ctx),
    });

    const runProjectDiagnostics = createProjectDiagnostics(studio);

    const projectExplorer = new ProjectExplorerProvider(
        context.extensionUri,
        runProjectDiagnostics,
    );
    projectExplorer.syncShowAllFilesContext();
    const treeView = vscode.window.createTreeView(PROJECT_EXPLORER_VIEW_ID, {
        treeDataProvider: projectExplorer,
    });

    const devSyncService = new DevSyncStateService();
    const devSync: DevSyncController = new DevSyncController(
        studio,
        createPZLogger(
            outputChannel,
            devSyncErrorActions(() => devSyncManager),
        ),
        { useFsWatcher: true },
    );
    const devSyncManager: DevSyncManager = new DevSyncManager(
        devSync,
        devSyncService,
    );

    const devSyncStatusBar = registerDevSyncStatusBar(devSyncManager);

    const devSyncBadge = registerDevSyncTreeBadge(devSyncManager, treeView);

    const projectJsonWatcher =
        vscode.workspace.createFileSystemWatcher('**/project.json');
    projectJsonWatcher.onDidChange(() => projectExplorer.requestRefresh());
    projectJsonWatcher.onDidCreate(() => projectExplorer.requestRefresh());
    projectJsonWatcher.onDidDelete(() => projectExplorer.requestRefresh());

    const executePZCommand = createCommandRunner(
        studio,
        outputChannel,
        () => projectExplorer.requestRefresh(),
        (cmd) => {
            notifyFirstBuildSuccess(context, cmd);
            notifyActionSuccess(cmd);
        },
    );

    const hostErrorSink = (error: unknown): void =>
        pzLogger.error(error instanceof Error ? error : String(error));

    context.subscriptions.push(
        outputChannel,
        devSyncManager,
        projectExplorer,
        ...registerAllCommands(context, executePZCommand, studio),
        registerWatchCommand(devSyncManager),
        devSyncStatusBar,
        devSyncBadge,
        registerDoctorCommand(runProjectDiagnostics, hostErrorSink),
        registerAnalyzeGameLogCommand(
            async (logPath?: string) =>
                analyzeGameLogFile(logPath, await resolveGameLogContext()),
            hostErrorSink,
        ),
        treeView,
        projectJsonWatcher,
        ...registerExplorerCommands(projectExplorer),
        vscode.tasks.registerTaskProvider(
            PZ_TASK_TYPE,
            new BuildTaskProvider(studio, () =>
                notifyFirstBuildSuccess(context, 'build'),
            ),
        ),
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('pzstudio.language')) {
                await initExtensionL10n(context);
                projectExplorer.refresh();
            }
            if (e.affectsConfiguration('pzstudio.gameBuild')) {
                projectExplorer.invalidateDiagnostics();
                projectExplorer.refresh();
            }
        }),
    );
}

export function deactivate() {}
