import * as vscode from 'vscode';
import { t } from './l10n';

export const FIRST_SUCCESS_KEY = 'pzstudio.firstBuildSuccessShown';

export const LANDING_URL_EXT =
    'https://escapepz.github.io/pzstudio/landing/?utm_source=ext-popup';

export function notifyFirstBuildSuccess(
    context: vscode.ExtensionContext,
    command: string,
): void {
    if (command !== 'build') {
        return;
    }
    if (context.globalState.get<boolean>(FIRST_SUCCESS_KEY)) {
        return;
    }
    void context.globalState.update(FIRST_SUCCESS_KEY, true);
    const open = t('See tips & updates');
    void Promise.resolve(
        vscode.window.showInformationMessage(
            t('First successful build with PZ Studio!'),
            open,
        ),
    ).then(async (choice) => {
        if (choice !== open) {
            return;
        }
        const uri = vscode.Uri.parse(LANDING_URL_EXT);
        try {
            await vscode.commands.executeCommand('simpleBrowser.api.open', uri);
        } catch {
            await vscode.env.openExternal(uri);
        }
    });
}

export function notifyActionSuccess(command: string): void {
    const message =
        command === 'new'
            ? t('PZStudio: project created.')
            : command === 'add'
              ? t('PZStudio: mod added.')
              : command === 'clean'
                ? t('PZStudio: output cleaned.')
                : undefined;
    if (message === undefined) {
        return;
    }
    vscode.window.showInformationMessage(message);
}
