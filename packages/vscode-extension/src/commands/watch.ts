import * as vscode from 'vscode';
import { t } from '../util/l10n';
import { resolveProjectDirResult, warnNoProject } from '../util/project';
import { DevSyncManager, type DevSyncState } from '../util/devSyncState';

export function registerWatchCommand(
    manager: DevSyncManager,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.watch', async () => {
        const phase = manager.state.phase;
        if (phase !== 'idle') {
            if (phase === 'stopping') {
                return;
            }
            await manager.stop();
            return;
        }

        const action = 'start the development sync in';
        const resolution = await resolveProjectDirResult(action);
        if (resolution.status === 'cancelled') {
            return;
        }
        if (resolution.status === 'no-project') {
            warnNoProject(action);
            return;
        }
        const dir = resolution.dir;
        if (manager.state.phase !== 'idle') {
            return;
        }
        const projectName = dir.path.split('/').pop() ?? dir.fsPath;
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: t(
                        "PZStudio: starting development sync for '{0}'…",
                        projectName,
                    ),
                    cancellable: false,
                },
                () => manager.start(dir.fsPath),
            );
        } catch (e) {
            vscode.window.showErrorMessage(
                t(
                    "PZStudio: development sync failed to start for '{0}': {1} — see the PZ Studio output for details.",
                    projectName,
                    e instanceof Error ? e.message : String(e),
                ),
            );
            return;
        }
    });
}

export function registerDevSyncStatusBar(
    manager: DevSyncManager,
): vscode.Disposable {
    const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
    );
    item.command = 'pzstudio.watch';

    const runTitle = (state: DevSyncState): string =>
        state.projectTitle ??
        state.projectDir?.split(/[\\/]/).filter(Boolean).pop() ??
        state.projectDir ??
        '';

    const render = (state: DevSyncState): void => {
        if (state.phase === 'idle') {
            item.text = `$(circle-slash) ${t('DevSync off')}`;
            item.tooltip = state.lastError
                ? t(
                      'PZStudio: development sync is off. Last start failed: {0}',
                      state.lastError,
                  )
                : t('PZStudio: development sync is off.');
            item.color = new vscode.ThemeColor('descriptionForeground');
            return;
        }
        const title = runTitle(state);
        item.color = undefined;
        item.text = `$(sync~spin) ${t('DevSync: {0}', title)}`;
        if (state.phase === 'syncing') {
            item.tooltip = t(
                "PZStudio: development sync running for '{0}' — click to stop.",
                title,
            );
        } else if (state.phase === 'starting') {
            item.tooltip = t(
                "PZStudio: development sync for '{0}' is starting…",
                title,
            );
        } else {
            item.tooltip = t(
                "PZStudio: development sync for '{0}' is stopping…",
                title,
            );
        }
    };

    render(manager.state);
    const subscription = manager.onDidChange(render);
    item.show();
    return {
        dispose(): void {
            subscription.dispose();
            item.dispose();
        },
    };
}
