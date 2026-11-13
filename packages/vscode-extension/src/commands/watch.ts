import * as vscode from 'vscode';
import { t } from '../util/l10n';
import { resolveProjectDirResult, warnNoProject } from '../util/project';
import { DevSyncManager, type DevSyncState } from '../util/devSyncState';

/**
 * Palette toggle + status-bar surface for the Development Sync Engine
 * (UX-06 + UX-15). Both consume the ONE DevSyncManager extension.ts created
 * — the command never touches DevSyncController directly anymore. The
 * command is a thin GATED dispatch (start only from idle, stop while
 * syncing, queued stop while starting, no-op while stopping) whose startup
 * UI is still the native withProgress window, and the status-bar item is
 * the run's source of truth: the success popups the handler used to show
 * are gone (UX-15 behavior change), only the start-fail toast remains.
 */
export function registerWatchCommand(
    manager: DevSyncManager,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.watch', async () => {
        // The one start-guard — the manager deliberately has none (hand-off
        // ruling): a start while syncing/stopping would re-anchor the
        // indicator over a live run, so start happens only from idle
        // (including the idle-with-lastError state a failed run lands in),
        // a stop while syncing tears down, while starting it queues through
        // the manager's queued-stop protocol and while stopping it is a
        // no-op.
        const phase = manager.state.phase;
        if (phase !== 'idle') {
            if (phase === 'stopping') {
                return;
            }
            await manager.stop();
            return;
        }

        const action = 'start the development sync in';
        // A dismissed picker aborts silently while a project-less workspace
        // gets the no-project warning — resolveProjectDir's undefined
        // conflates the two (spec §9, UX-02).
        const resolution = await resolveProjectDirResult(action);
        if (resolution.status === 'cancelled') {
            return;
        }
        if (resolution.status === 'no-project') {
            warnNoProject(action);
            return;
        }
        const dir = resolution.dir;
        const projectName = dir.path.split('/').pop() ?? dir.fsPath;
        try {
            // The initial full build of both outputs runs in here (UX-06):
            // the window stays up until manager.start settles and closes
            // on its own — no invented percentage, no cancellation (startup
            // interruption has no safe protocol; a stop request during the
            // build queues through the manager instead).
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
            // The controller already logged the reason into the output
            // channel and the manager reset the state to idle with it; one
            // deliberate notification here replaces the generic host error
            // the raw rethrow used to surface. This is the only toast the
            // toggle has left — the status bar carries the started/stopped
            // feedback (UX-15).
            vscode.window.showErrorMessage(
                t(
                    "PZStudio: development sync failed to start for '{0}': {1} — see the PZ Studio output for details.",
                    projectName,
                    e instanceof Error ? e.message : String(e),
                ),
            );
            return;
        }
        // No success signal here: the status bar flipping to its spinner is
        // the started feedback (UX-15 behavior change).
    });
}

/**
 * UX-15: the status-bar indicator — with the success popups gone, this item
 * is the run's user surface. It renders the manager's state on every
 * onDidChange (plus once at registration): spinner + project folder while a
 * run is in flight (starting notes itself in the tooltip; stopping keeps
 * the syncing visual — both are mid-flight) and a muted circle-slash while
 * off, lastError included on the idle tooltip when a run just failed. The
 * item executes the existing `pzstudio.watch` palette command, so a click
 * runs the identical gated toggle — no manifest entry, no second
 * registration.
 */
export function registerDevSyncStatusBar(
    manager: DevSyncManager,
): vscode.Disposable {
    const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
    );
    item.command = 'pzstudio.watch';

    // The folder-name convention the manager titles runs with: the
    // projectTitle once beginSyncing published it, the projectDir's last
    // segment while starting/stopping (both separators fold).
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
