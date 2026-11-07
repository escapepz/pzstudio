import * as vscode from 'vscode';
import { ILogger } from '@pzstudio/cli/api';
import { t } from './l10n';

export function getTimestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function createPZLogger(outputChannel: vscode.OutputChannel): ILogger {
    return {
        log: (msg: string) => outputChannel.appendLine(msg),
        info: (msg: string) =>
            outputChannel.appendLine(`[${getTimestamp()}] [INFO] ${msg}`),
        warn: (msg: string) =>
            outputChannel.appendLine(`[${getTimestamp()}] [WARN] ${msg}`),
        error: (err: string | Error) => {
            const timestamp = getTimestamp();
            // UX-16: the full detail (Problem/Cause/Try, stack) always lands
            // in the PZ Studio channel — but the panel itself is only opened
            // on explicit request via the notification's action button
            // (show(true) preserves focus; no auto-focus merely for
            // reporting).
            let message: string;
            if (err instanceof Error) {
                message = err.message;
                outputChannel.appendLine(
                    `[${timestamp}] [ERROR] ${err.message}\n${err.stack}`,
                );
            } else {
                message = err;
                outputChannel.appendLine(`[${timestamp}] [ERROR] ${err}`);
            }
            // Cancellation is a normal user flow, not an error: keep the
            // channel record, skip the error notification.
            if (err instanceof Error && err.name === 'CancellationError') {
                return;
            }
            // Actionable notification: the details live in this channel, so
            // offer them one click away instead of auto-opening the panel
            // (and instead of telling the user to hunt the Output dropdown).
            const showDetails = t('Show Details');
            void Promise.resolve(
                vscode.window.showErrorMessage(
                    t('PZStudio Error: {0}', message),
                    showDetails,
                ),
            ).then((choice) => {
                if (choice === showDetails) {
                    outputChannel.show(true);
                }
            });
        },
        // Debug diagnostics (UX-04): the engine gates verbose emission on the
        // invocation's --verbose/--quiet flags before calling this sink, so
        // the host only renders — no second filter here.
        verbose: (msg: string) =>
            outputChannel.appendLine(`[${getTimestamp()}] [DEBUG] ${msg}`),
        clear: () => outputChannel.clear(),
    };
}
