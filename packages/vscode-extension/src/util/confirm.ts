import * as vscode from 'vscode';

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

    const verb = action === 'build' ? 'Build' : 'Clean';
    const message =
        action === 'build'
            ? `Run build for project '${projectName}'?\n\nBuilding while the game is running can leave the output in a broken state.`
            : `Clean build output of project '${projectName}'?\n\nThis deletes the generated workshop output folder.`;

    const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        verb,
        "Don't Ask Again",
    );
    if (choice === undefined) {
        return 'cancel';
    }
    if (choice === "Don't Ask Again") {
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
