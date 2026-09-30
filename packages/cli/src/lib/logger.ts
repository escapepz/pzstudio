import * as pc from 'picocolors';
import { getCliIO } from './parser';

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
let quietEnabled = false;

/**
 * Stream contract (CLI-2): stdout carries command data (list/doctor/help
 * output, the banner); stderr carries progress, warnings, diagnostics and
 * errors. Timestamps and colors appear only when the TARGET stream is a
 * TTY — piped output is always clean text.
 */
function isTTY(stream: NodeJS.WriteStream): boolean {
    return stream.isTTY;
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

export function setQuiet(enabled: boolean) {
    quietEnabled = enabled;
}

/**
 * Ensures the output ends with exactly one newline, regardless of whether
 * the message already carries trailing newline(s).
 */
function withNewline(msg: string): string {
    return msg.replace(/\n+$/, '') + '\n';
}

function toText(message: any): string {
    return typeof message === 'string' ? message : JSON.stringify(message);
}

/** Writes through the shared CliIO sink so tests and embedders can capture. */
function emit(stream: 'stdout' | 'stderr', text: string): void {
    const io = getCliIO();
    if (stream === 'stdout') {
        io.stdout(text);
    } else {
        io.stderr(text);
    }
}

/**
 * Logs a data message to stdout.
 * @param message
 */
export function log(message: any) {
    const msg = toText(message);
    if (externalLogger) {
        externalLogger.log(msg);
        return;
    }
    emit('stdout', withNewline(msg));
}

/**
 * Logs a progress message to stderr.
 * @param message
 */
export function info(message: any) {
    const msg = toText(message);
    if (externalLogger) {
        externalLogger.info(msg);
        return;
    }
    if (quietEnabled) return;
    const tty = isTTY(process.stderr);
    const output = tty
        ? pc.cyan(`[${getTimestamp()}] [INFO] ${msg}`)
        : `[INFO] ${msg}`;
    emit('stderr', withNewline(output));
}

/**
 * Logs a warning to stderr.
 * @param message
 */
export function warn(message: any) {
    const msg = toText(message);
    if (externalLogger) {
        externalLogger.warn(msg);
        return;
    }
    const tty = isTTY(process.stderr);
    const output = tty
        ? pc.yellow(`[${getTimestamp()}] [WARN] ${msg}`)
        : `[WARN] ${msg}`;
    emit('stderr', withNewline(output));
}

/**
 * Logs an error to stderr.
 * @param error
 */
export function error(error: any) {
    if (externalLogger) {
        externalLogger.error(error);
        return;
    }
    const detail =
        error instanceof Error ? error.stack || error.message : String(error);
    const tty = isTTY(process.stderr);
    const output = tty
        ? pc.red(`[${getTimestamp()}] [ERROR] ${detail}`)
        : `[ERROR] ${detail}`;
    emit('stderr', withNewline(output));
}

/**
 * Logs a diagnostic message if verbose mode is enabled.
 * @param message
 */
export function verbose(message: any) {
    if (!verboseEnabled || quietEnabled) return;
    const msg = toText(message);
    if (externalLogger && externalLogger.verbose) {
        externalLogger.verbose(msg);
        return;
    }
    const tty = isTTY(process.stderr);
    const output = tty
        ? pc.gray(`[${getTimestamp()}] [DEBUG] ${msg}`)
        : `[DEBUG] ${msg}`;
    emit('stderr', withNewline(output));
}
