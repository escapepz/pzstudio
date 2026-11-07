import * as vscode from 'vscode';
import { t } from '../util/l10n';
import { resolveProjectDirResult, warnNoProject } from '../util/project';
import { DevSyncController } from '../util/devsync';

/**
 * Palette toggle for the Development Sync Engine. Starting resolves the
 * project like every other command (tree context does not exist on a
 * palette run) and hands the folder to the controller; the controller keeps
 * running across command invocations until toggled off.
 */
export function registerWatchCommand(
    controller: DevSyncController,
): vscode.Disposable {
    return vscode.commands.registerCommand('pzstudio.watch', async () => {
        if (controller.active) {
            await controller.stop();
            vscode.window.showInformationMessage(
                t('PZStudio: development sync stopped.'),
            );
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
            // the window stays up until controller.start settles and closes
            // on its own — no invented percentage, no cancellation (startup
            // interruption has no safe protocol).
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: t(
                        "PZStudio: starting development sync for '{0}'…",
                        projectName,
                    ),
                    cancellable: false,
                },
                () => controller.start(dir.fsPath),
            );
        } catch (e) {
            // The controller already logged the reason into the output
            // channel and cleaned up its half-start; one deliberate
            // notification here replaces the generic host error the raw
            // rethrow used to surface. No success signal on this path.
            vscode.window.showErrorMessage(
                t(
                    "PZStudio: development sync failed to start for '{0}': {1} — see the PZ Studio output for details.",
                    projectName,
                    e instanceof Error ? e.message : String(e),
                ),
            );
            return;
        }
        vscode.window.showInformationMessage(
            t(
                "PZStudio: development sync started for '{0}' — run the command again to stop.",
                projectName,
            ),
        );
    });
}
