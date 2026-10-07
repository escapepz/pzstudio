import * as pc from 'picocolors';
import { getCliIO } from './parser';
import { formatError } from './errors';
import {
    getActiveInvocationContext,
    type IoScope,
    type PzStudioLogger,
} from './invocation';

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
 * Sink tier — the pure stdout/stderr formatting + CliIO emit this module
 * owns: no legacy slot, no persisted flag, no gating of its own (callers
 * gate). Shared verbatim by the raw tier (externalLogger unset) and the
 * real default engine logger (below).
 * ----------------------------------------------------------------------- */

function sinkLog(msg: string): void {
    emit('stdout', withNewline(msg));
}

function sinkInfo(msg: string): void {
    const tty = isTTY(process.stderr);
    const output = tty
        ? pc.cyan(`[${getTimestamp()}] [INFO] ${msg}`)
        : `[INFO] ${msg}`;
    emit('stderr', withNewline(output));
}

function sinkWarn(msg: string): void {
    const tty = isTTY(process.stderr);
    const output = tty
        ? pc.yellow(`[${getTimestamp()}] [WARN] ${msg}`)
        : `[WARN] ${msg}`;
    emit('stderr', withNewline(output));
}

function sinkError(err: any, debug: boolean): void {
    const detail = formatError(err, { debug });
    const tty = isTTY(process.stderr);
    const output = tty
        ? pc.red(`[${getTimestamp()}] [ERROR] ${detail}`)
        : `[ERROR] ${detail}`;
    emit('stderr', withNewline(output));
}

function sinkVerbose(msg: string): void {
    const tty = isTTY(process.stderr);
    const output = tty
        ? pc.gray(`[${getTimestamp()}] [DEBUG] ${msg}`)
        : `[DEBUG] ${msg}`;
    emit('stderr', withNewline(output));
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
    sinkLog(msg);
}

export function rawInfo(message: any) {
    const msg = toText(message);
    if (externalLogger) {
        externalLogger.info(msg);
        return;
    }
    if (quietEnabled) return;
    sinkInfo(msg);
}

export function rawWarn(message: any) {
    const msg = toText(message);
    if (externalLogger) {
        externalLogger.warn(msg);
        return;
    }
    sinkWarn(msg);
}

function rawError(error: any) {
    if (externalLogger) {
        externalLogger.error(error);
        return;
    }
    sinkError(error, debugEnabled);
}

export function rawVerbose(message: any) {
    if (!verboseEnabled || quietEnabled) return;
    const msg = toText(message);
    if (externalLogger && externalLogger.verbose) {
        externalLogger.verbose(msg);
        return;
    }
    sinkVerbose(msg);
}

/* --------------------------------------------------------------------------
 * Explicit-io emission adapters (doc 11 §17 commit 6, Appendix C): route
 * one emission to the supplied io scope's logger, else — R1 default
 * routing — to the RAW legacy tier, ambient-blind and legacy bit-identical
 * (never the engine tier, which would inherit an active v2 ambient). The
 * threaded non-engine paths call these instead of the engine-tier log()
 * family; the adapters never consult the active invocation context.
 * ----------------------------------------------------------------------- */

export function emitInfo(io: IoScope | undefined, message: string): void {
    if (io) {
        io.logger.info(message);
        return;
    }
    rawInfo(message);
}

export function emitWarn(io: IoScope | undefined, message: string): void {
    if (io) {
        io.logger.warn(message);
        return;
    }
    rawWarn(message);
}

export function emitVerbose(io: IoScope | undefined, message: string): void {
    if (io) {
        io.logger.verbose?.(message);
        return;
    }
    rawVerbose(message);
}

/**
 * The io scope ENGINE call sites hand the io-threaded helpers (doc 11 §12
 * vs §17 commit 6 / Appendix C): its logger is the context-aware engine
 * tier — the active InvocationContext logger while a run is installed,
 * else the raw legacy tier. Command handlers and internal engine wrappers
 * pass this so engine-reachable helper emissions keep their §12 ambient
 * routing on both doors (v2 instance logger / legacy raw sink). The
 * threaded helpers' own omitted-io default stays RAW legacy (R1):
 * ambient awareness enters only where an engine caller explicitly passes
 * this scope.
 */
export function engineIo(): IoScope {
    return {
        logger: {
            log: (message) => log(message),
            info: (message) => info(message),
            warn: (message) => warn(message),
            error: (err) => error(err),
            verbose: (message) => verbose(message),
        },
    };
}

/**
 * The REAL default engine logger (doc 11 §8.0/§8.1, Appendix B — owned by
 * this module): the pure sink tier with the invocation's own verbosity read
 * from the installed InvocationContext at emit time. It NEVER consults
 * `externalLogger` nor the persisted verbose/quiet/debug flags (R0: a v2
 * instance whose logger was omitted must not consume facade values) — it is
 * the mirror of the raw tier, sourced from the context instead of the slots:
 * quiet gates info, verbose+quiet gate verbose, debug adds the stack to
 * unexpected-error reports. The v2 front door (studio.ts) resolves an
 * omitted instance logger against this.
 */
export function defaultEngineLogger(): PzStudioLogger {
    return {
        log: (message) => sinkLog(message),
        info: (message) => {
            if (getActiveInvocationContext()?.quiet) return;
            sinkInfo(message);
        },
        warn: (message) => sinkWarn(message),
        error: (err) =>
            sinkError(err, getActiveInvocationContext()?.debug ?? false),
        verbose: (message) => {
            const ctx = getActiveInvocationContext();
            if (!ctx || !ctx.verbose || ctx.quiet) return;
            sinkVerbose(message);
        },
    };
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
