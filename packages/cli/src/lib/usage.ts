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

export const USAGE_OP_LINK_ATTACH = 'link.attach';
export const USAGE_OP_LINK_BACKUP = 'link.backup';
export const USAGE_OP_MATERIALIZE_COPY = 'materialize.copy';
export const USAGE_OP_MATERIALIZE_TOGGLE = 'materialize.toggle';

export interface UsageEvent {
    v: 1;
    ts: string;
    sid: string; // 32 hex chars, per process
    pid_hash: string | null; // 8 hex chars, or null when no project key/salt
    seq: number; // monotonic per process, starts at 1
    host: UsageHost;
    ver: string;
    os: string; // `${process.platform}-${process.arch}`
    node: string; // process.version without leading 'v'
    type: 'op.end';
    op: string;
    dur_ms: number;
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
        maxSessionEvents?: number;
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

    projectHash(projectKey: string): string {
        const salt = this.ensureSalt();
        return salt === undefined ? '' : pidHashOf(projectKey, salt);
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
            this.pruneOnce();

            const event = this.buildEvent(input, salt);
            appendFileSync(
                join(dir, `events-${utcDateStamp()}.ndjson`),
                JSON.stringify(event) + '\n',
                'utf-8',
            );
            this.writes += 1;
            this.ensureNotice();
        } catch {}
    }

    private usageDir(): string {
        return join(getConfigDir(), USAGE_DIR_NAME);
    }

    private resolveEnabled(): boolean {
        const usageLog: UsageLogConfig | undefined =
            readGlobalConfig(false).usageLog;
        return usageLog?.enabled !== false;
    }

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
            try {
                writeFileSync(saltPath, fresh, {
                    encoding: 'utf-8',
                    flag: 'wx',
                });
                this.salt = fresh;
            } catch {
                const winner = readFileSync(saltPath, 'utf-8').trim();
                if (SALT_PATTERN.test(winner)) {
                    this.salt = winner;
                } else {
                    writeFileSync(saltPath, fresh, 'utf-8');
                    this.salt = fresh;
                }
            }
            return this.salt;
        } catch {
            return undefined;
        }
    }

    private ensureNotice(): void {
        try {
            const markerPath = join(this.usageDir(), NOTICE_MARKER);
            if (existsSync(markerPath)) return;
            emitInfo(engineIo(), NOTICE_TEXT);
            writeFileSync(markerPath, '', 'utf-8');
        } catch {}
    }

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
                    } catch {}
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
                } catch {}
            }
        } catch {}
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
            meta:
                input.flags && input.flags.length > 0
                    ? { flags: input.flags }
                    : undefined,
        };
    }
}

let singleton: UsageRecorder | undefined;

export function getUsageRecorder(): UsageRecorder {
    if (!singleton) {
        singleton = new UsageRecorder();
    }
    return singleton;
}

export function resetUsageRecorder(): void {
    singleton = undefined;
}

function spanHost(interactionMode: InteractionMode): UsageHost {
    return interactionMode === 'embedded' ? 'api' : 'cli';
}

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

function spanEnabled(): boolean {
    try {
        return getUsageRecorder().isEnabled();
    } catch {
        return false;
    }
}

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
    } catch {}
}

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
