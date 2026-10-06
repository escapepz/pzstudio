import * as pc from 'picocolors';
import { getCliIO } from './parser';
import { formatError } from './errors';
import { getActiveInvocationContext, type PzStudioLogger } from './invocation';

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
let debugEnabled = false;

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

/** Controls whether unexpected errors print their full stack trace. */
export function setDebug(enabled: boolean) {
    debugEnabled = enabled;
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

/* --------------------------------------------------------------------------
 * Raw tier — today's implementation verbatim: routes by the legacy slots
 * ONLY (externalLogger + the persisted verbose/quiet/debug flags). The
 * published @pzstudio/cli/api exports under the historical names and the
 * legacyLogger() accessor route here (R1, doc 11 §8.0/§12) — they never
 * consult the active invocation context.
 * ----------------------------------------------------------------------- */

export function rawLog(message: any) {
    const msg = toText(message);
    if (externalLogger) {
        externalLogger.log(msg);
        return;
    }
    emit('stdout', withNewline(msg));
}

export function rawInfo(message: any) {
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

export function rawWarn(message: any) {
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

function rawError(error: any) {
    if (externalLogger) {
        externalLogger.error(error);
        return;
    }
    const detail = formatError(error, { debug: debugEnabled });
    const tty = isTTY(process.stderr);
    const output = tty
        ? pc.red(`[${getTimestamp()}] [ERROR] ${detail}`)
        : `[ERROR] ${detail}`;
    emit('stderr', withNewline(output));
}

export function rawVerbose(message: any) {
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

/**
 * Rule R1 (doc 11 §8.0): the raw legacy logger as a PzStudioLogger — every
 * method routes exactly like the raw tier above (externalLogger ?? the raw
 * stdout/stderr sink, with the same gating) and never consults the active
 * invocation context. Legacy non-engine wrappers (DevSync, doctor, template
 * ops) compose their logger dependency from this.
 */
export function legacyLogger(): PzStudioLogger {
    return {
        log: (message) => rawLog(message),
        info: (message) => rawInfo(message),
        warn: (message) => rawWarn(message),
        error: (err) => rawError(err),
        verbose: (message) => rawVerbose(message),
    };
}

/* --------------------------------------------------------------------------
 * Engine tier — the internal context-aware logging layer (doc 11 §12):
 * the active InvocationContext logger while a run is installed, else the
 * raw tier. Command handlers, helpers and the engine lifecycle call these.
 * This is NOT the published surface: api.ts re-exports the raw tier under
 * these historical names instead (R1).
 * ----------------------------------------------------------------------- */

/**
 * Logs a data message to stdout.
 * @param message
 */
export function log(message: any) {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        ctx.logger.log(toText(message));
        return;
    }
    rawLog(message);
}

/**
 * Logs a progress message to stderr.
 * @param message
 */
export function info(message: any) {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        ctx.logger.info(toText(message));
        return;
    }
    rawInfo(message);
}

/**
 * Logs a warning to stderr.
 * @param message
 */
export function warn(message: any) {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        ctx.logger.warn(toText(message));
        return;
    }
    rawWarn(message);
}

/**
 * Logs an error to stderr. The rendering is owned by formatError (CLI-3):
 * usage errors print their message, structured CliErrors print the
 * Problem/Cause/Try block, and anything unexpected prints the wrapped
 * message — with the full stack only when --debug is enabled.
 * @param error
 */
export function error(error: any) {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        ctx.logger.error(error);
        return;
    }
    rawError(error);
}

/**
 * Logs a diagnostic message if verbose mode is enabled.
 * @param message
 */
export function verbose(message: any) {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        if (!ctx.verbose || ctx.quiet) return;
        ctx.logger.verbose?.(toText(message));
        return;
    }
    rawVerbose(message);
}
