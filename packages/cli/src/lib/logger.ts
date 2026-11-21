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

export function setDebug(enabled: boolean) {
    debugEnabled = enabled;
}

function withNewline(msg: string): string {
    return msg.replace(/\n+$/, '') + '\n';
}

function toText(message: any): string {
    return typeof message === 'string' ? message : JSON.stringify(message);
}

function emit(stream: 'stdout' | 'stderr', text: string): void {
    const io = getCliIO();
    if (stream === 'stdout') {
        io.stdout(text);
    } else {
        io.stderr(text);
    }
}

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

export function legacyLogger(): PzStudioLogger {
    return {
        log: (message) => rawLog(message),
        info: (message) => rawInfo(message),
        warn: (message) => rawWarn(message),
        error: (err) => rawError(err),
        verbose: (message) => rawVerbose(message),
    };
}

export function log(message: any) {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        ctx.logger.log(toText(message));
        return;
    }
    rawLog(message);
}

export function info(message: any) {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        ctx.logger.info(toText(message));
        return;
    }
    rawInfo(message);
}

export function warn(message: any) {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        ctx.logger.warn(toText(message));
        return;
    }
    rawWarn(message);
}

export function error(error: any) {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        ctx.logger.error(error);
        return;
    }
    rawError(error);
}

export function verbose(message: any) {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        if (!ctx.verbose || ctx.quiet) return;
        ctx.logger.verbose?.(toText(message));
        return;
    }
    rawVerbose(message);
}
