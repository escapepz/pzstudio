import * as pc from 'picocolors';

export interface ILogger {
    log(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string | Error): void;
    verbose?(message: string): void;
    clear?(): void;
}

let externalLogger: ILogger | undefined;
let verboseEnabled = false;

/**
 * Checks if the output destination is a TTY.
 */
function isTTY(): boolean {
    return process.stdout.isTTY;
}

function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function setLogger(logger: ILogger | undefined) {
    externalLogger = logger;
}

export function setVerbose(enabled: boolean) {
    verboseEnabled = enabled;
}

export function isVerbose(): boolean {
    return verboseEnabled;
}

/**
 * Clears the console.
 */
export function clear() {
    if (externalLogger && externalLogger.clear) {
        externalLogger.clear();
        return;
    }
    process.stdout.write('\u001b[2J\u001b[H');
}

/**
 * Ensures the output ends with exactly one newline, regardless of whether
 * the message already carries trailing newline(s).
 */
function withNewline(msg: string): string {
    return msg.replace(/\n+$/, '') + '\n';
}

/**
 * Logs a message to the console.
 * @param message
 */
export function log(message: any) {
    const msg = typeof message === 'string' ? message : JSON.stringify(message);
    if (externalLogger) {
        externalLogger.log(msg);
        return;
    }
    process.stdout.write(
        isTTY() ? pc.white(withNewline(msg)) : withNewline(msg),
    );
}

/**
 * Logs a message to the console as an information.
 * @param message
 */
export function info(message: any) {
    const msg = typeof message === 'string' ? message : JSON.stringify(message);
    if (externalLogger) {
        externalLogger.info(msg);
        return;
    }
    const output = `[${getTimestamp()}] [INFO] ${msg}`;
    process.stdout.write(
        isTTY() ? pc.cyan(withNewline(output)) : withNewline(output),
    );
}

/**
 * Logs a message to the console as a warning.
 * @param message
 */
export function warn(message: any) {
    const msg = typeof message === 'string' ? message : JSON.stringify(message);
    if (externalLogger) {
        externalLogger.warn(msg);
        return;
    }
    const output = `[${getTimestamp()}] [WARN] ${msg}`;
    process.stdout.write(
        isTTY() ? pc.yellow(withNewline(output)) : withNewline(output),
    );
}

/**
 * Logs a message to the console as an error.
 * @param error
 */
export function error(error: any) {
    const msg =
        error instanceof Error ? error.stack || error.message : String(error);
    if (externalLogger) {
        externalLogger.error(error);
        return;
    }
    const output = `[${getTimestamp()}] [ERROR] ${msg}`;
    process.stderr.write(
        isTTY() ? pc.red(withNewline(output)) : withNewline(output),
    );
}

/**
 * Logs a diagnostic message if verbose mode is enabled.
 * @param message
 */
export function verbose(message: any) {
    if (!verboseEnabled) return;
    const msg = typeof message === 'string' ? message : JSON.stringify(message);
    if (externalLogger && externalLogger.verbose) {
        externalLogger.verbose(msg);
        return;
    }
    const output = `[${getTimestamp()}] [DEBUG] ${msg}`;
    process.stdout.write(
        isTTY() ? pc.gray(withNewline(output)) : withNewline(output),
    );
}
