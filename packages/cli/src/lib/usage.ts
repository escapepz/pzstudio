/**
 * Offline usage-log recorder: appends one NDJSON event per operation into
 * ~/.pzstudio/usage/events-YYYY-MM-DD.ndjson (UTC date). Everything stays
 * on disk — nothing is ever uploaded. The sink is config-gated through the
 * `usageLog.enabled` flag of the global config: absent means enabled, an
 * explicit `false` is sticky-off. The recorder NEVER writes config.json
 * (that belongs to the `usage` command); it only ever reads it, and with
 * validation off so a corrupted config degrades to the default (enabled)
 * instead of breaking commands. Span helpers (recordUsageSpan /
 * recordApiSpan / recordApiSpanSync) sit on top of the recorder: they time
 * a command body, map host/flags/errors onto exactly one event and rethrow
 * the original error.
 */
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore - necessary because we can't reliably predict if typescript will resolve this outside src without structural errors in some configs
import { version } from '../../package.json';
/* eslint-enable @typescript-eslint/ban-ts-comment */
import { createHash, randomBytes } from 'node:crypto';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import type { UsageLogConfig } from '@pzstudio/core';
import type { InteractionMode, InvocationContext } from './invocation';
import { readGlobalConfig, getConfigDir } from './templateManager';
import { emitInfo, engineIo } from './logger';

export type UsageHost = 'cli' | 'api';

export interface UsageEvent {
    v: 1;
    ts: string; // ISO instant (end of op)
    sid: string; // 32 hex chars, per process
    pid_hash: string | null; // 8 hex chars, or null when no project key/salt
    seq: number; // monotonic per process, starts at 1
    host: UsageHost;
    ver: string; // CLI package version
    os: string; // `${process.platform}-${process.arch}`
    node: string; // process.version without leading 'v'
    type: 'op.end';
    op: string;
    dur_ms: number; // integer ms >= 0
    status: 'ok' | 'error';
    err?: { code: string; where: string };
    meta?: { flags: string[] };
}

export const MAX_SESSION_EVENTS = 5000;
export const RETENTION_DAYS = 30;
export const MAX_DIR_BYTES = 10 * 1024 * 1024;

const USAGE_DIR_NAME = 'usage';
const SALT_FILE = '.salt';
const NOTICE_MARKER = '.notice-shown';
const EVENTS_FILE_PATTERN = /^events-.*\.ndjson$/;
const SALT_PATTERN = /^[0-9a-f]{32}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const NOTICE_TEXT =
    "PZ Studio saves local usage logs (commands, durations, errors) to ~/.pzstudio/usage — nothing is ever uploaded. Inspect them any time; turn off with 'pzstudio usage off', share with 'pzstudio usage export'.";

type UsageOpInput = {
    op: string;
    host: UsageHost;
    durMs: number;
    status: 'ok' | 'error';
    err?: { code: string; where: string };
    flags?: string[];
    projectKey?: string;
};

function utcDateStamp(): string {
    return new Date().toISOString().slice(0, 10);
}

/** sha256(key + salt), truncated to 8 hex chars. */
function pidHashOf(projectKey: string, salt: string): string {
    return createHash('sha256')
        .update(projectKey + salt)
        .digest('hex')
        .slice(0, 8);
}

export class UsageRecorder {
    private readonly maxSessionEvents: number;
    private readonly retentionDays: number;
    private readonly maxDirBytes: number;
    readonly sessionId: string;
    private enabled: boolean | undefined;
    private salt: string | undefined;
    private writes = 0;
    private pruned = false;

    constructor(options?: {
        maxSessionEvents?: number; // default MAX_SESSION_EVENTS (test seam)
        retentionDays?: number; // default RETENTION_DAYS (test seam)
        maxDirBytes?: number; // default MAX_DIR_BYTES (test seam)
    }) {
        this.maxSessionEvents = options?.maxSessionEvents ?? MAX_SESSION_EVENTS;
        this.retentionDays = options?.retentionDays ?? RETENTION_DAYS;
        this.maxDirBytes = options?.maxDirBytes ?? MAX_DIR_BYTES;
        this.sessionId = randomBytes(16).toString('hex');
    }

    isEnabled(): boolean {
        if (this.enabled === undefined) {
            this.enabled = this.resolveEnabled();
        }
        return this.enabled;
    }

    /** 8-hex project hash; the salt is loaded lazily from usage/.salt. */
    projectHash(projectKey: string): string {
        return pidHashOf(projectKey, this.ensureSalt() ?? '');
    }

    recordOp(input: {
        op: string;
        host: UsageHost;
        durMs: number;
        status: 'ok' | 'error';
        err?: { code: string; where: string };
        flags?: string[];
        projectKey?: string;
    }): void {
        try {
            if (!this.isEnabled()) return;
            if (this.writes >= this.maxSessionEvents) return;

            const dir = this.usageDir();
            mkdirSync(dir, { recursive: true });
            const salt = this.ensureSalt();
            this.ensureNotice();
            this.pruneOnce();

            const event = this.buildEvent(input, salt);
            appendFileSync(
                join(dir, `events-${utcDateStamp()}.ndjson`),
                JSON.stringify(event) + '\n',
                'utf-8',
            );
            this.writes += 1;
        } catch {
            // Swallow everything: usage logging must never break a command.
        }
    }

    private usageDir(): string {
        return join(getConfigDir(), USAGE_DIR_NAME);
    }

    /**
     * The recorder reads the config without validation and never writes it:
     * a corrupted config.json degrades to the in-memory defaults (enabled)
     * and the sticky-off flag survives because the `usage` command owns all
     * config writes.
     */
    private resolveEnabled(): boolean {
        const usageLog: UsageLogConfig | undefined =
            readGlobalConfig(false).usageLog;
        return usageLog?.enabled !== false;
    }

    /**
     * Loads the persisted salt or creates it on first need. Best-effort:
     * when the filesystem refuses, events are still written (pid_hash null
     * for the failing run) instead of the recorder crashing.
     */
    private ensureSalt(): string | undefined {
        if (this.salt !== undefined) return this.salt;
        try {
            const dir = this.usageDir();
            const saltPath = join(dir, SALT_FILE);
            if (existsSync(saltPath)) {
                const content = readFileSync(saltPath, 'utf-8').trim();
                if (SALT_PATTERN.test(content)) {
                    this.salt = content;
                    return this.salt;
                }
            }
            const fresh = randomBytes(16).toString('hex');
            mkdirSync(dir, { recursive: true });
            writeFileSync(saltPath, fresh, 'utf-8');
            this.salt = fresh;
            return this.salt;
        } catch {
            return undefined;
        }
    }

    /**
     * One-time disclosure notice: emitted before the first-ever event write,
     * then pinned by the .notice-shown marker. Best-effort — if the marker
     * write fails, the notice may repeat next session (accepted).
     */
    private ensureNotice(): void {
        try {
            const markerPath = join(this.usageDir(), NOTICE_MARKER);
            if (existsSync(markerPath)) return;
            emitInfo(engineIo(), NOTICE_TEXT);
            writeFileSync(markerPath, '', 'utf-8');
        } catch {
            // Notice is best-effort; never block the event write.
        }
    }

    /**
     * Lazy retention, once per instance, inside the first write (before the
     * append, so the fresh event is never a prune candidate of its own
     * write): delete events-*.ndjson older than retentionDays (mtime), then
     * unlink oldest-first while the dir total exceeds maxDirBytes. Never
     * touches dotfiles (.salt / .notice-shown).
     */
    private pruneOnce(): void {
        if (this.pruned) return;
        this.pruned = true;
        try {
            const dir = this.usageDir();
            if (!existsSync(dir)) return;
            const cutoff = Date.now() - this.retentionDays * DAY_MS;
            let total = 0;
            const kept: { path: string; mtimeMs: number; size: number }[] = [];
            for (const name of readdirSync(dir)) {
                if (!EVENTS_FILE_PATTERN.test(name)) continue;
                const path = join(dir, name);
                const stats = statSync(path);
                if (stats.mtimeMs < cutoff) {
                    try {
                        unlinkSync(path);
                        continue;
                    } catch {
                        // Unremovable: keep counting it for the size cap.
                    }
                }
                total += stats.size;
                kept.push({ path, mtimeMs: stats.mtimeMs, size: stats.size });
            }
            kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
            for (const entry of kept) {
                if (total <= this.maxDirBytes) break;
                try {
                    unlinkSync(entry.path);
                    total -= entry.size;
                } catch {
                    // Unremovable file: move on to the next-oldest one.
                }
            }
        } catch {
            // Prune is best-effort; never block the event write.
        }
    }

    private buildEvent(
        input: UsageOpInput,
        salt: string | undefined,
    ): UsageEvent {
        return {
            v: 1,
            ts: new Date().toISOString(),
            sid: this.sessionId,
            pid_hash:
                input.projectKey !== undefined && salt !== undefined
                    ? pidHashOf(input.projectKey, salt)
                    : null,
            seq: this.writes + 1,
            host: input.host,
            ver: version,
            os: `${process.platform}-${process.arch}`,
            node: process.version.replace(/^v/, ''),
            type: 'op.end',
            op: input.op,
            dur_ms: Math.max(0, Math.floor(input.durMs)),
            status: input.status,
            err: input.err,
            meta: input.flags ? { flags: input.flags } : undefined,
        };
    }
}

let singleton: UsageRecorder | undefined;

/** Config-driven singleton: enabled unless usageLog.enabled === false. */
export function getUsageRecorder(): UsageRecorder {
    if (!singleton) {
        singleton = new UsageRecorder();
    }
    return singleton;
}

/* --------------------------------------------------------------------------
 * Spans: timing + host/flag/error mapping around a command body
 * ----------------------------------------------------------------------- */

/** The embedded mode IS the api host; every CLI-facing mode is cli. */
function spanHost(interactionMode: InteractionMode): UsageHost {
    return interactionMode === 'embedded' ? 'api' : 'cli';
}

/** Flag NAMES only (never values — paths stay out of the log), sorted. */
function spanFlags(
    invocationOptions: InvocationContext['invocationOptions'],
): string[] {
    return Object.keys(invocationOptions ?? {})
        .filter((name) => {
            const value = invocationOptions[name];
            return value !== undefined && value !== false;
        })
        .sort();
}

/**
 * True when the config-gated singleton is on. The probe itself is guarded:
 * an environment broken enough to throw here records nothing instead of
 * turning telemetry into a host-facing crash.
 */
function spanEnabled(): boolean {
    try {
        return getUsageRecorder().isEnabled();
    } catch {
        return false;
    }
}

/**
 * Swallow-safe settle write: exactly one recordOp per span, never a throw.
 * The error code is the thrown value's Error name ('Unknown' otherwise) and
 * the where is always the op — message text never reaches the log.
 */
function recordSpanSettled(input: {
    op: string;
    host: UsageHost;
    durMs: number;
    status: 'ok' | 'error';
    thrown?: unknown;
    flags?: string[];
    projectKey?: string;
}): void {
    try {
        getUsageRecorder().recordOp({
            op: input.op,
            host: input.host,
            durMs: input.durMs,
            status: input.status,
            err:
                input.status === 'error'
                    ? {
                          code:
                              input.thrown instanceof Error
                                  ? input.thrown.name
                                  : 'Unknown',
                          where: input.op,
                      }
                    : undefined,
            flags: input.flags,
            projectKey: input.projectKey,
        });
    } catch {
        // Swallow everything: usage logging must never break a command.
    }
}

/**
 * Lifecycle chokepoint: times body, records one event, rethrows. The
 * `usage` command manages the recorder's own config, so its runs never
 * land in the log they configure — enabled or not.
 */
export async function recordUsageSpan(
    op: string,
    ctx: Pick<
        InvocationContext,
        'interactionMode' | 'invocationOptions' | 'projectDir' | 'anchor'
    >,
    body: () => Promise<void>,
): Promise<void> {
    if (op === 'usage') return body();
    if (!spanEnabled()) return body();
    const t0 = performance.now();
    const settle = (status: 'ok' | 'error', thrown?: unknown): void =>
        recordSpanSettled({
            op,
            host: spanHost(ctx.interactionMode),
            durMs: Math.round(performance.now() - t0),
            status,
            thrown,
            flags: spanFlags(ctx.invocationOptions),
            projectKey: ctx.projectDir ?? ctx.anchor,
        });
    try {
        await body();
        settle('ok');
    } catch (thrown) {
        settle('error', thrown);
        throw thrown;
    }
}

/** Facade spans for operations outside the lifecycle. host is always 'api'. */
export async function recordApiSpan<T>(
    op: string,
    projectKey: string,
    body: () => Promise<T>,
): Promise<T> {
    if (!spanEnabled()) return body();
    const t0 = performance.now();
    const settle = (status: 'ok' | 'error', thrown?: unknown): void =>
        recordSpanSettled({
            op,
            host: 'api',
            durMs: Math.round(performance.now() - t0),
            status,
            thrown,
            projectKey,
        });
    try {
        const value = await body();
        settle('ok');
        return value;
    } catch (thrown) {
        settle('error', thrown);
        throw thrown;
    }
}

export function recordApiSpanSync<T>(
    op: string,
    projectKey: string,
    body: () => T,
): T {
    if (!spanEnabled()) return body();
    const t0 = performance.now();
    const settle = (status: 'ok' | 'error', thrown?: unknown): void =>
        recordSpanSettled({
            op,
            host: 'api',
            durMs: Math.round(performance.now() - t0),
            status,
            thrown,
            projectKey,
        });
    try {
        const value = body();
        settle('ok');
        return value;
    } catch (thrown) {
        settle('error', thrown);
        throw thrown;
    }
}
