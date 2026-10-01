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
            if (err instanceof Error) {
                outputChannel.appendLine(
                    `[${timestamp}] [ERROR] ${err.message}\n${err.stack}`,
                );
            } else {
                outputChannel.appendLine(`[${timestamp}] [ERROR] ${err}`);
            }
            vscode.window.showErrorMessage(
                t(
                    'PZStudio Error: {0}',
                    err instanceof Error ? err.message : err,
                ),
            );
        },
        clear: () => outputChannel.clear(),
    };
}
