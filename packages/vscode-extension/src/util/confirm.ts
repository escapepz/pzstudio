import * as vscode from 'vscode';
import { t } from './l10n';

export type ConfirmDecision = 'yes' | 'never' | 'cancel';

/**
 * Modal confirmation before running a destructive or disruptive command
 * (build/clean can clobber the output the game is currently loading when
 * debugging). Honors the pzstudio.confirmBeforeRun setting; "Don't Ask
 * Again" is applied by the caller writing that setting for the project.
 */
export async function confirmBeforeRun(
    action: 'build' | 'clean',
    projectName: string,
): Promise<ConfirmDecision> {
    const enabled = vscode.workspace
        .getConfiguration('pzstudio')
        .get<boolean>('confirmBeforeRun', true);
    if (!enabled) {
        return 'yes';
    }

    const verb = action === 'build' ? t('Build') : t('Clean');
    const message =
        action === 'build'
            ? t(
                  "Run build for project '{0}'?\n\nBuilding while the game is running can leave the output in a broken state.",
                  projectName,
              )
            : t(
                  "Clean build output of project '{0}'?\n\nThis deletes the generated workshop output folder.",
                  projectName,
              );

    const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        verb,
        t("Don't Ask Again"),
    );
    if (choice === undefined) {
        return 'cancel';
    }
    if (choice === t("Don't Ask Again")) {
        return 'never';
    }
    return 'yes';
}

/** Persists "Don't Ask Again" for the workspace folder containing projectDir. */
export async function disableConfirmBeforeRun(
    projectDir?: string,
): Promise<void> {
    const scope = projectDir ? vscode.Uri.file(projectDir) : undefined;
    await vscode.workspace
        .getConfiguration('pzstudio', scope)
        .update(
            'confirmBeforeRun',
            false,
            vscode.ConfigurationTarget.WorkspaceFolder,
        );
}
