import * as vscode from 'vscode';
import { t } from './l10n';

export type ConfirmDecision = 'yes' | 'never' | 'cancel';

/**
 * Modal confirmation before running a destructive or disruptive command
 * (build/clean can clobber the output the game is currently loading when
 * debugging; delete removes a mod for good; rename rewrites the mod's
 * folder name and its project.json key). Honors the
 * pzstudio.confirmBeforeRun setting; "Don't Ask Again" is applied by the
 * caller writing that setting for the project.
 */
export async function confirmBeforeRun(
    action: 'build' | 'clean' | 'delete' | 'rename',
    subject: string,
    target?: string,
): Promise<ConfirmDecision> {
    const enabled = vscode.workspace
        .getConfiguration('pzstudio')
        .get<boolean>('confirmBeforeRun', true);
    if (!enabled) {
        return 'yes';
    }

    const verb =
        action === 'build'
            ? t('Build')
            : action === 'clean'
              ? t('Clean')
              : action === 'rename'
                ? t('Rename')
                : t('Delete');
    const message =
        action === 'build'
            ? t(
                  "Run build for project '{0}'?\n\nBuilding while the game is running can leave the output in a broken state.",
                  subject,
              )
            : action === 'clean'
              ? t(
                    "Clean build output of project '{0}'?\n\nThis deletes the generated workshop output folder.",
                    subject,
                )
              : action === 'rename'
                ? t("Rename mod '{0}' to '{1}'?", subject, target ?? '')
                : t(
                      "Are you sure you want to delete mod '{0}'? This cannot be undone.",
                      subject,
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
