import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import { join, resolve } from 'path';
// fflate is a dependency of packages/cli only (pnpm layout): resolve it
// through the package's own node_modules, like the CLI sources do.
import { unzipSync } from '../../packages/cli/node_modules/fflate';
import type { CommandContext } from '../../packages/cli/src/lib/registry';
import { getCommand } from '../../packages/cli/src/lib/registry';
// Importing the command module runs registerCommand + addHelp at import time.
import '../../packages/cli/src/lib/commands/usage';
import { runCLI } from '../../packages/cli/src/lib/cli';
import {
    readGlobalConfig,
    getConfigPath,
} from '../../packages/cli/src/lib/templateManager';
import {
    getUsageRecorder,
    resetUsageRecorder,
} from '../../packages/cli/src/lib/usage';
import { setLogger } from '../../packages/cli/src/lib/logger';
import { setCliIO } from '../../packages/cli/src/lib/parser';
import { CliError } from '../../packages/cli/src/lib/errors';

// NO module mocks: every case asserts real files/config/zip contents through
// the fake HOME (vitest.setup.ts). Output stays pristine via the recording
// logger + capturing CliIO (cliLifecycle / usageWiring idiom).

const fakeHome = (): string =>
    (globalThis as any).__PZSTUDIO_FAKE_HOME as string;
const pzDir = (): string => join(fakeHome(), '.pzstudio');
const usageDir = (): string => join(pzDir(), 'usage');
const configPath = (): string => getConfigPath();
const todayUtc = (): string => new Date().toISOString().slice(0, 10);
const eventsFile = (): string =>
    join(usageDir(), `events-${todayUtc()}.ndjson`);

const eventLines = (file: string): string[] =>
    fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter((line) => line.trim().length > 0);

const writeJsonConfig = (config: unknown): void => {
    fs.mkdirSync(pzDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config), 'utf-8');
};

/** Minimal valid NDJSON usage event (shape per packages/cli/src/lib/usage.ts). */
const eventLine = (sid: string, ts: string): string =>
    JSON.stringify({
        v: 1,
        ts,
        sid,
        pid_hash: null,
        seq: 1,
        host: 'cli',
        ver: '0.0.0-test',
        os: 'test-os',
        node: '20.0.0',
        type: 'op.end',
        op: 'build',
        dur_ms: 1,
        status: 'ok',
    });

/** Pre-creates the usage store with the given NDJSON lines. */
const seedStore = (lines: string[]): void => {
    fs.mkdirSync(usageDir(), { recursive: true });
    fs.writeFileSync(eventsFile(), lines.join('\n') + '\n', 'utf-8');
};

const runUsage = (
    positionals: string[],
    options: CommandContext['options'] = {},
): void => {
    getCommand('usage')!.run({ positionals, options });
};

interface LogCall {
    method: string;
    message: any;
}

let logCalls: LogCall[] = [];
let ioStderr: string[] = [];
let tmpRealDirs: string[] = [];

beforeEach(() => {
    const logger = {
        log: (m: any) => logCalls.push({ method: 'log', message: m }),
        info: (m: any) => logCalls.push({ method: 'info', message: m }),
        warn: (m: any) => logCalls.push({ method: 'warn', message: m }),
        error: (e: any) => logCalls.push({ method: 'error', message: e }),
        verbose: (m: any) => logCalls.push({ method: 'verbose', message: m }),
    };
    setLogger(logger);
    ioStderr = [];
    setCliIO({
        stdout: () => {},
        stderr: (t: string) => ioStderr.push(t),
    });
});

afterEach(() => {
    setLogger(undefined);
    setCliIO(undefined);
    logCalls = [];
    ioStderr = [];
    // The default export path is the process cwd (the repo root during
    // tests): always remove the bundle so the working tree stays clean.
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    fs.rmSync(join(process.cwd(), `pzstudio-usage-${stamp}.zip`), {
        force: true,
    });
    for (const dir of tmpRealDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpRealDirs = [];
});

/** All stdout data lines the command printed (method 'log' only). */
const loggedData = (): string =>
    logCalls
        .filter((c) => c.method === 'log')
        .map((c) => String(c.message))
        .join('\n');

const localDateStamp = (): string => {
    const now = new Date();
    return (
        `${now.getFullYear()}` +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0')
    );
};

describe('pzstudio usage command', () => {
    it('1. off: config.usageLog.enabled === false, other fields intact, output confirms off', () => {
        writeJsonConfig({
            templates: {},
            outdir: join(fakeHome(), 'Workshop'),
            useSymlinks: false,
        });

        runUsage(['off']);

        const config = readGlobalConfig();
        expect(config.usageLog?.enabled).toBe(false);
        expect(config.outdir).toBe(join(fakeHome(), 'Workshop'));
        expect(config.useSymlinks).toBe(false);
        expect(loggedData()).toContain('disabled');
    });

    it('2. off --purge: deletes the usage dir entirely (.salt included)', () => {
        seedStore([eventLine('a'.repeat(32), '2026-11-08T10:00:00.000Z')]);
        fs.writeFileSync(join(usageDir(), '.salt'), '0'.repeat(32), 'utf-8');
        fs.writeFileSync(join(usageDir(), '.notice-shown'), '', 'utf-8');
        writeJsonConfig({ templates: {} });

        runUsage(['off'], { purge: true });

        expect(fs.existsSync(usageDir())).toBe(false);
        expect(readGlobalConfig().usageLog?.enabled).toBe(false);
    });

    it('3. on: re-enables logging after off', () => {
        writeJsonConfig({ templates: {}, usageLog: { enabled: false } });

        runUsage(['on']);

        expect(readGlobalConfig().usageLog?.enabled).toBe(true);
        expect(loggedData()).toContain('enabled');
    });

    it('4. status with no usage dir: prints enabled state + 0 files, no throw', () => {
        writeJsonConfig({ templates: {} });
        expect(fs.existsSync(usageDir())).toBe(false);

        expect(() => runUsage(['status'])).not.toThrow();

        const out = loggedData();
        expect(out).toContain('enabled');
        expect(out).toContain('Files: 0');
        expect(out).toContain('Events: 0');
    });

    it('5. status with data: prints file count 1, events 2, sessions 2', () => {
        seedStore([
            eventLine('a'.repeat(32), '2026-11-08T10:00:00.000Z'),
            eventLine('b'.repeat(32), '2026-11-08T12:00:00.000Z'),
        ]);
        writeJsonConfig({ templates: {} });

        runUsage(['status']);

        const out = loggedData();
        expect(out).toContain('Files: 1');
        expect(out).toContain('Events: 2 across 2 session(s)');
        expect(out).toContain(usageDir());
    });

    it('6. export default path: zip in cwd, manifest counts, ndjson in, .salt out', () => {
        seedStore([
            eventLine('a'.repeat(32), '2026-11-08T10:00:00.000Z'),
            eventLine('b'.repeat(32), '2026-11-08T12:00:00.000Z'),
            '{ not json',
        ]);
        fs.writeFileSync(join(usageDir(), '.salt'), '0'.repeat(32), 'utf-8');
        writeJsonConfig({ templates: {} });

        runUsage(['export']);

        const zipPath = resolve(`pzstudio-usage-${localDateStamp()}.zip`);
        expect(fs.existsSync(zipPath)).toBe(true);

        const zipped = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
        const names = Object.keys(zipped);
        expect(names).toContain('manifest.json');
        expect(names).toContain(`events-${todayUtc()}.ndjson`);
        // Dotfiles (.salt, .notice-shown) never enter the bundle.
        expect(names.some((n) => n.startsWith('.'))).toBe(false);

        const manifest = JSON.parse(
            Buffer.from(zipped['manifest.json']).toString('utf-8'),
        );
        expect(manifest.schemaV).toBe(1);
        expect(manifest.eventCount).toBe(2);
        expect(manifest.skippedLines).toBe(1);
        expect(manifest.sessionCount).toBe(2);
        expect(manifest.dateRange).toEqual({
            from: '2026-11-08T10:00:00.000Z',
            to: '2026-11-08T12:00:00.000Z',
        });
        expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false);

        // The events file content round-trips untouched.
        const bundled = Buffer.from(
            zipped[`events-${todayUtc()}.ndjson`],
        ).toString('utf-8');
        expect(bundled.split('\n').filter((l) => l.trim().length > 0)).toEqual(
            eventLines(eventsFile()),
        );

        const out = loggedData();
        expect(out).toContain(zipPath);
        expect(out).toContain('Exported 2 event(s)');
        expect(out).toContain('Skipped 1');
    });

    it('6b. export with only unparseable lines: exports, warns no valid events were found', () => {
        seedStore(['{ not json', 'garbage line']);
        writeJsonConfig({ templates: {} });

        runUsage(['export']);

        const out = loggedData();
        expect(out).toContain('Exported 0 event(s)');
        expect(out).toContain('Skipped 2');
        expect(out).toContain('no valid events');
    });

    it('7. export --out: writes the bundle to the given path', () => {
        seedStore([eventLine('a'.repeat(32), '2026-11-08T10:00:00.000Z')]);
        writeJsonConfig({ templates: {} });
        const tmpReal = fs.mkdtempSync(join(os.tmpdir(), 'pz-usage-export-'));
        tmpRealDirs.push(tmpReal);
        const outPath = join(tmpReal, 'bundle.zip');

        runUsage(['export'], { out: outPath });

        expect(fs.existsSync(outPath)).toBe(true);
        const zipped = unzipSync(new Uint8Array(fs.readFileSync(outPath)));
        expect(Object.keys(zipped)).toContain('manifest.json');
    });

    it('7b. export --out to an unwritable destination: CliError naming the path', () => {
        seedStore([eventLine('a'.repeat(32), '2026-11-08T10:00:00.000Z')]);
        writeJsonConfig({ templates: {} });
        const badOut = join(fakeHome(), 'no-such-dir', 'bundle.zip');

        let caught: unknown;
        try {
            runUsage(['export'], { out: badOut });
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(CliError);
        const cliError = caught as CliError;
        expect(cliError.message).toContain(badOut);
        expect(cliError.tryHint).toBeTruthy();
        expect(fs.existsSync(badOut)).toBe(false);
    });

    it('8. export with empty store: CliError, message says there are no usage logs', () => {
        writeJsonConfig({ templates: {} });
        expect(fs.existsSync(usageDir())).toBe(false);

        expect(() => runUsage(['export'])).toThrow(CliError);
        expect(() => runUsage(['export'])).toThrow(/no usage logs/i);
    });

    it('9. unknown action: CliError with tryHint listing on | off | status | export', () => {
        writeJsonConfig({ templates: {} });

        let caught: unknown;
        try {
            runUsage(['bogus']);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(CliError);
        const cliError = caught as CliError;
        expect(cliError.tryHint).toContain('on | off | status | export');
    });

    it('10. --purge outside off is ignored: on --purge does not throw, keeps store', () => {
        seedStore([eventLine('a'.repeat(32), '2026-11-08T10:00:00.000Z')]);
        writeJsonConfig({ templates: {}, usageLog: { enabled: false } });

        expect(() => runUsage(['on'], { purge: true })).not.toThrow();

        expect(readGlobalConfig().usageLog?.enabled).toBe(true);
        expect(fs.existsSync(eventsFile())).toBe(true);
    });

    it('11. the usage command never records itself: runCLI usage status leaves the store unchanged', async () => {
        writeJsonConfig({ templates: {}, usageLog: { enabled: true } });
        seedStore([
            eventLine('a'.repeat(32), '2026-11-08T10:00:00.000Z'),
            eventLine('b'.repeat(32), '2026-11-08T12:00:00.000Z'),
        ]);
        // Fresh recorder so it reads the enabled config written above.
        resetUsageRecorder();
        const before = eventLines(eventsFile()).length;
        expect(before).toBe(2);

        await runCLI('usage', ['status'], { flags: [] });

        const after = eventLines(eventsFile()).length;
        expect(after).toBe(before);
    });

    it('12. R1: usage off resets the memoized recorder in-process', () => {
        writeJsonConfig({ templates: {}, usageLog: { enabled: true } });
        resetUsageRecorder();
        getUsageRecorder().recordOp({
            op: 'build',
            host: 'cli',
            durMs: 1,
            status: 'ok',
        });
        expect(eventLines(eventsFile())).toHaveLength(1);

        runUsage(['off']);

        // The pre-off recorder instance had enabled memoized; the command's
        // reset forces the next getUsageRecorder() to re-read the config.
        getUsageRecorder().recordOp({
            op: 'build',
            host: 'cli',
            durMs: 1,
            status: 'ok',
        });
        expect(eventLines(eventsFile())).toHaveLength(1);
    });
});
