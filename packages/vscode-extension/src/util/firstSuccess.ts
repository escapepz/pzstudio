import * as vscode from 'vscode';
import { t } from './l10n';

/** globalState flag: the one-time first-build success popup was shown. */
export const FIRST_SUCCESS_KEY = 'pzstudio.firstBuildSuccessShown';

/** Landing page the popup's button opens (UTM-tagged extension popup hit). */
export const LANDING_URL_EXT =
    'https://escapepz.github.io/pzstudio/?utm_source=ext-popup';

/**
 * One-time celebration for the first successful `build`: an informational
 * popup whose button opens the landing page. Nothing is transmitted — the
 * URL opens only on the user's explicit click. Fires once per profile
 * (globalState flag), never for non-build commands, and stays silent on
 * every later build.
 */
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
    // Same shape as the logger's actionable notification: resolve the choice
    // asynchronously and open the URL only for the explicit button click.
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
            // Inside VS Code when the built-in Simple Browser is available;
            // the system browser otherwise (command absent or disabled).
            await vscode.commands.executeCommand('simpleBrowser.api.open', uri);
        } catch {
            await vscode.env.openExternal(uri);
        }
    });
}
