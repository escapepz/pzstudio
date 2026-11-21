import * as vscode from 'vscode';
import { ILogger } from '@pzstudio/cli/api';
import { t } from './l10n';

export interface PZLoggerErrorAction {
    label: string;
    run: () => void;
}

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

export function createPZLogger(
    outputChannel: vscode.OutputChannel,
    extraErrorActions?: () => PZLoggerErrorAction[],
): ILogger {
    return {
        log: (msg: string) => outputChannel.appendLine(msg),
        info: (msg: string) =>
            outputChannel.appendLine(`[${getTimestamp()}] [INFO] ${msg}`),
        warn: (msg: string) =>
            outputChannel.appendLine(`[${getTimestamp()}] [WARN] ${msg}`),
        error: (err: string | Error) => {
            const timestamp = getTimestamp();
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
            if (err instanceof Error && err.name === 'CancellationError') {
                return;
            }
            const showDetails = t('Show Details');
            const extras = extraErrorActions?.() ?? [];
            void Promise.resolve(
                vscode.window.showErrorMessage(
                    t('PZStudio Error: {0}', message),
                    showDetails,
                    ...extras.map((action) => action.label),
                ),
            ).then((choice) => {
                if (choice === showDetails) {
                    outputChannel.show(true);
                }
                const chosen = extras.find((action) => action.label === choice);
                if (chosen) {
                    chosen.run();
                }
            });
        },
        verbose: (msg: string) =>
            outputChannel.appendLine(`[${getTimestamp()}] [DEBUG] ${msg}`),
        clear: () => outputChannel.clear(),
    };
}
