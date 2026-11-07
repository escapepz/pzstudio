import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import { join } from 'path';
import * as logger from '../../packages/cli/src/lib/logger';
import {
    UsageRecorder,
    getUsageRecorder,
} from '../../packages/cli/src/lib/usage';
import {
    readGlobalConfig,
    writeGlobalConfig,
} from '../../packages/cli/src/lib/templateManager';

vi.mock('../../packages/cli/src/lib/logger');
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    const mocks = {
        existsSync: vi.fn(actual.existsSync),
        readFileSync: vi.fn(actual.readFileSync),
        appendFileSync: vi.fn(actual.appendFileSync),
        mkdirSync: vi.fn(actual.mkdirSync),
        writeFileSync: vi.fn(actual.writeFileSync),
        readdirSync: vi.fn(actual.readdirSync),
        statSync: vi.fn(actual.statSync),
        unlinkSync: vi.fn(actual.unlinkSync),
        utimesSync: vi.fn(actual.utimesSync),
    };
    return {
        ...actual,
        ...mocks,
        default: {
            ...actual.default,
            ...mocks,
        },
    };
});

// The notice text pinned by the feature spec (emitted via emitInfo before
// the first-ever event write).
const NOTICE =
    "PZ Studio saves local usage logs (commands, durations, errors) to ~/.pzstudio/usage — nothing is ever uploaded. Inspect them any time; turn off with 'pzstudio usage off', share with 'pzstudio usage export'.";

const fakeHome = (): string =>
    (globalThis as any).__PZSTUDIO_FAKE_HOME as string;
const pzDir = (): string => join(fakeHome(), '.pzstudio');
const usageDir = (): string => join(pzDir(), 'usage');
const configPath = (): string => join(pzDir(), 'config.json');
const saltPath = (): string => join(usageDir(), '.salt');
const noticeMarker = (): string => join(usageDir(), '.notice-shown');
const todayUtc = (): string => new Date().toISOString().slice(0, 10);
const eventsFile = (): string =>
    join(usageDir(), `events-${todayUtc()}.ndjson`);

const eventLines = (file: string): string[] =>
    fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter((line) => line.trim().length > 0);

const writeRawConfig = (content: string): void => {
    fs.mkdirSync(pzDir(), { recursive: true });
    fs.writeFileSync(configPath(), content, 'utf-8');
};

const writeJsonConfig = (config: unknown): void =>
    writeRawConfig(JSON.stringify(config));

/** How many times the notice text went out through emitInfo. */
const noticeEmissions = (): number =>
    vi.mocked(logger.emitInfo).mock.calls.filter((call) => call[1] === NOTICE)
        .length;

describe('UsageRecorder', () => {
    let actualFs: any;

    beforeEach(async () => {
        vi.restoreAllMocks();
        // Vitest 4's restoreAllMocks resets the vi.fn(actual.*) wrappers the
        // fs mock factory installed, so re-prime them: every case here
        // verifies real-file behavior through the module under test (fake
        // HOME from vitest.setup.ts), not mocks-of-mocks.
        actualFs = await vi.importActual('fs');
        vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync as any);
        vi.mocked(fs.readFileSync).mockImplementation(
            actualFs.readFileSync as any,
        );
        vi.mocked(fs.writeFileSync).mockImplementation(
            actualFs.writeFileSync as any,
        );
        vi.mocked(fs.appendFileSync).mockImplementation(
            actualFs.appendFileSync as any,
        );
        vi.mocked(fs.mkdirSync).mockImplementation(actualFs.mkdirSync as any);
        vi.mocked(fs.readdirSync).mockImplementation(
            actualFs.readdirSync as any,
        );
        vi.mocked(fs.statSync).mockImplementation(actualFs.statSync as any);
        vi.mocked(fs.unlinkSync).mockImplementation(actualFs.unlinkSync as any);
        vi.mocked(fs.utimesSync).mockImplementation(actualFs.utimesSync as any);
        // restoreAllMocks leaves call records on the factory-created fs fns
        // and the auto-mocked logger fns — clear them for call isolation.
        vi.mocked(fs.existsSync).mockClear();
        vi.mocked(fs.readFileSync).mockClear();
        vi.mocked(fs.writeFileSync).mockClear();
        vi.mocked(fs.appendFileSync).mockClear();
        vi.mocked(fs.mkdirSync).mockClear();
        vi.mocked(fs.readdirSync).mockClear();
        vi.mocked(fs.statSync).mockClear();
        vi.mocked(fs.unlinkSync).mockClear();
        vi.mocked(fs.utimesSync).mockClear();
        vi.mocked(logger.emitInfo).mockClear();
    });

    it('1. disabled → absolute no-op', () => {
        writeJsonConfig({ templates: {}, usageLog: { enabled: false } });
        const recorder = getUsageRecorder();
        expect(recorder.isEnabled()).toBe(false);
        recorder.recordOp({ op: 'build', host: 'cli', durMs: 1, status: 'ok' });
        expect(fs.existsSync(usageDir())).toBe(false);
    });

    it('2. default ON (absent key)', () => {
        expect(new UsageRecorder().isEnabled()).toBe(true);
    });

    it('3. enabled → one JSON line per event with the pinned shape', () => {
        const recorder = new UsageRecorder();
        recorder.recordOp({
            op: 'build',
            host: 'cli',
            durMs: 42,
            status: 'ok',
        });
        expect(fs.existsSync(eventsFile())).toBe(true);
        const lines = eventLines(eventsFile());
        expect(lines).toHaveLength(1);
        const event = JSON.parse(lines[0]);
        expect(event.v).toBe(1);
        expect(event.seq).toBe(1);
        expect(event.sid).toHaveLength(32);
        expect(event.dur_ms).toBe(42);
        expect(event.status).toBe('ok');
        expect(event.type).toBe('op.end');
        expect(typeof event.ver).toBe('string');
        expect(event.ver.length).toBeGreaterThan(0);
        expect(event.os).toBe(`${process.platform}-${process.arch}`);
        expect(event.node).toBe(process.version.slice(1));

        recorder.recordOp({
            op: 'build',
            host: 'cli',
            durMs: 1,
            status: 'ok',
        });
        const linesAfterSecond = eventLines(eventsFile());
        expect(linesAfterSecond).toHaveLength(2);
        expect(JSON.parse(linesAfterSecond[1]).seq).toBe(2);
    });

    it('4. salt created once, hash stable across instances, distinct per key', () => {
        const first = new UsageRecorder();
        first.recordOp({ op: 'build', host: 'cli', durMs: 1, status: 'ok' });
        expect(fs.existsSync(saltPath())).toBe(true);
        expect(fs.readFileSync(saltPath(), 'utf-8').trim()).toMatch(
            /^[0-9a-f]{32}$/,
        );

        const hash = first.projectHash('/same/dir');
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
        const second = new UsageRecorder();
        expect(second.projectHash('/same/dir')).toBe(hash);
        expect(second.projectHash('/other/dir')).not.toBe(hash);
    });

    it('5. notice emitted exactly once per .notice-shown marker lifetime', () => {
        const recorder = new UsageRecorder();
        recorder.recordOp({ op: 'build', host: 'cli', durMs: 1, status: 'ok' });
        expect(noticeEmissions()).toBe(1);
        expect(fs.existsSync(noticeMarker())).toBe(true);

        recorder.recordOp({ op: 'build', host: 'cli', durMs: 1, status: 'ok' });
        expect(noticeEmissions()).toBe(1);

        fs.unlinkSync(noticeMarker());
        recorder.recordOp({ op: 'build', host: 'cli', durMs: 1, status: 'ok' });
        expect(noticeEmissions()).toBe(2);
    });

    it('6. corrupted config never overwritten and never crashes', () => {
        writeRawConfig('{ this is not json');
        const before = fs.readFileSync(configPath(), 'utf-8');
        expect(() =>
            new UsageRecorder().recordOp({
                op: 'build',
                host: 'cli',
                durMs: 5,
                status: 'ok',
            }),
        ).not.toThrow();
        expect(fs.readFileSync(configPath(), 'utf-8')).toBe(before);
        expect(eventLines(eventsFile())).toHaveLength(1);
    });

    it('7. session cap stops writing after maxSessionEvents', () => {
        const recorder = new UsageRecorder({ maxSessionEvents: 3 });
        for (let i = 0; i < 4; i++) {
            recorder.recordOp({
                op: `op${i}`,
                host: 'cli',
                durMs: 1,
                status: 'ok',
            });
        }
        expect(eventLines(eventsFile())).toHaveLength(3);
    });

    it('8a. lazy prune: retention deletes stale events on first write', () => {
        fs.mkdirSync(usageDir(), { recursive: true });
        const stale = join(usageDir(), 'events-2020-01-01.ndjson');
        fs.writeFileSync(stale, 'stale', 'utf-8');
        const backdated = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        fs.utimesSync(stale, backdated, backdated);

        const recorder = new UsageRecorder({
            retentionDays: 0,
            maxDirBytes: 10,
        });
        recorder.recordOp({ op: 'build', host: 'cli', durMs: 1, status: 'ok' });
        expect(fs.existsSync(stale)).toBe(false);
        expect(eventLines(eventsFile())).toHaveLength(1);
    });

    it('8b. lazy prune: size cap drops the oldest file first', () => {
        fs.mkdirSync(usageDir(), { recursive: true });
        const dayName = (daysAgo: number): string =>
            new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
                .toISOString()
                .slice(0, 10);
        const older = join(usageDir(), `events-${dayName(2)}.ndjson`);
        const newer = join(usageDir(), `events-${dayName(1)}.ndjson`);
        fs.writeFileSync(older, 'a'.repeat(50), 'utf-8');
        fs.writeFileSync(newer, 'b'.repeat(50), 'utf-8');
        const olderTime = new Date(Date.now() - 120 * 1000);
        const newerTime = new Date(Date.now() - 60 * 1000);
        fs.utimesSync(older, olderTime, olderTime);
        fs.utimesSync(newer, newerTime, newerTime);

        const recorder = new UsageRecorder({ maxDirBytes: 60 });
        recorder.recordOp({ op: 'build', host: 'cli', durMs: 1, status: 'ok' });
        // 100 bytes total > 60 cap: the oldest file goes first, dropping it
        // is enough (50 <= 60), so the newer file and the new event stay.
        expect(fs.existsSync(older)).toBe(false);
        expect(fs.existsSync(newer)).toBe(true);
        expect(eventLines(eventsFile())).toHaveLength(1);
    });

    it('9. each event is exactly one appendFileSync call with a trailing newline', () => {
        const recorder = new UsageRecorder();
        recorder.recordOp({
            op: 'first',
            host: 'cli',
            durMs: 42,
            status: 'ok',
        });
        recorder.recordOp({
            op: 'second',
            host: 'cli',
            durMs: 7,
            status: 'error',
        });

        const calls = vi
            .mocked(fs.appendFileSync)
            .mock.calls.filter((call) => String(call[0]).includes('events-'));
        expect(calls).toHaveLength(2);
        for (const call of calls) {
            expect(String(call[0])).toContain(`events-${todayUtc()}.ndjson`);
            const payload = String(call[1]);
            expect(payload.endsWith('\n')).toBe(true);
            const singleLine = payload.replace(/\n$/, '');
            expect(singleLine.split('\n')).toHaveLength(1);
            expect(JSON.parse(singleLine).type).toBe('op.end');
        }
        expect(JSON.parse(String(calls[0][1])).op).toBe('first');
        expect(JSON.parse(String(calls[1][1])).op).toBe('second');
    });

    it('10. sticky-off survives validate+merge round-trip', () => {
        writeJsonConfig({
            templates: {},
            outdir: 'C:/x',
            usageLog: { enabled: false },
        });
        const first = readGlobalConfig(true);
        expect(first.usageLog?.enabled).toBe(false);
        expect(first.outdir).toBe('C:/x');

        // Simulate `pzstudio usage off`: read → set enabled:false → write.
        first.usageLog = { enabled: false };
        writeGlobalConfig(first);
        const second = readGlobalConfig(true);
        expect(second.usageLog?.enabled).toBe(false);
        expect(second.outdir).toBe('C:/x');
        expect(second.templates.project).toBeDefined();

        // A config without the key stays default-ON (enabled undefined).
        writeJsonConfig({ templates: {}, outdir: 'C:/x' });
        const third = readGlobalConfig(true);
        expect(third.usageLog?.enabled).toBeUndefined();
    });
});
