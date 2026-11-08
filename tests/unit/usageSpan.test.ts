import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import { join } from 'path';
import type { InvocationContext } from '../../packages/cli/src/lib/invocation';
import { CliError } from '../../packages/cli/src/lib/errors';
import {
    getUsageRecorder,
    recordApiSpan,
    recordApiSpanSync,
    recordUsageSpan,
} from '../../packages/cli/src/lib/usage';

// The one-time disclosure notice goes out through emitInfo right after the
// first successful event write; auto-mocking the logger keeps it out of the
// test output (same idiom as usageRecorder.test.ts).
vi.mock('../../packages/cli/src/lib/logger');

type SpanCtx = Pick<
    InvocationContext,
    'interactionMode' | 'invocationOptions' | 'projectDir' | 'anchor'
>;

const fakeHome = (): string =>
    (globalThis as any).__PZSTUDIO_FAKE_HOME as string;
const pzDir = (): string => join(fakeHome(), '.pzstudio');
const usageDir = (): string => join(pzDir(), 'usage');
const configPath = (): string => join(pzDir(), 'config.json');
const todayUtc = (): string => new Date().toISOString().slice(0, 10);
const eventsFile = (): string =>
    join(usageDir(), `events-${todayUtc()}.ndjson`);

const eventLines = (file: string): string[] =>
    fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter((line) => line.trim().length > 0);

const parsedEvents = (): any[] =>
    eventLines(eventsFile()).map((line) => JSON.parse(line));

const singleEvent = (): any => {
    const all = parsedEvents();
    expect(all).toHaveLength(1);
    return all[0];
};

const lastEvent = (): any => {
    const all = parsedEvents();
    expect(all.length).toBeGreaterThan(0);
    return all[all.length - 1];
};

const writeJsonConfig = (config: unknown): void => {
    fs.mkdirSync(pzDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config), 'utf-8');
};

/** Minimal lifecycle-shaped context; per-test overrides on top. */
const ctx = (overrides: Partial<SpanCtx> = {}): SpanCtx => ({
    interactionMode: 'interactive',
    invocationOptions: {},
    projectDir: undefined,
    anchor: undefined,
    ...overrides,
});

const ok = (): Promise<void> => Promise.resolve();

describe('usage spans', () => {
    it('1. embedded lifecycle span → host api, ok event, await resolves', async () => {
        let ran = false;
        await recordUsageSpan(
            'help',
            ctx({ interactionMode: 'embedded' }),
            async () => {
                ran = true;
            },
        );
        expect(ran).toBe(true);
        const event = singleEvent();
        expect(event.op).toBe('help');
        expect(event.host).toBe('api');
        expect(event.status).toBe('ok');
        expect(Number.isInteger(event.dur_ms)).toBe(true);
        expect(event.dur_ms).toBeGreaterThanOrEqual(0);
    });

    it('2. interactive / non-interactive lifecycle spans → host cli', async () => {
        await recordUsageSpan(
            'build',
            ctx({ interactionMode: 'interactive' }),
            ok,
        );
        await recordUsageSpan(
            'build',
            ctx({ interactionMode: 'non-interactive' }),
            ok,
        );
        const all = parsedEvents();
        expect(all).toHaveLength(2);
        expect(all[0].host).toBe('cli');
        expect(all[1].host).toBe('cli');
    });

    it('3. meta.flags are sorted option NAMES only — values never reach the log', async () => {
        await recordUsageSpan(
            'build',
            ctx({
                interactionMode: 'interactive',
                invocationOptions: {
                    verbose: true,
                    project: 'D:\\mods\\x',
                    quiet: false,
                    transport: 'git',
                    outdir: undefined,
                },
            }),
            ok,
        );
        expect(singleEvent().meta).toEqual({
            flags: ['project', 'transport', 'verbose'],
        });
        // The project VALUE appears nowhere in the raw log file.
        const raw = fs.readFileSync(eventsFile(), 'utf-8');
        expect(raw).not.toContain('D:\\mods\\x');
    });

    it('4. error path: one error event (code/where mapped), original error rethrown', async () => {
        const boom = new CliError('boom');
        await expect(
            recordUsageSpan('op4', ctx(), async () => {
                throw boom;
            }),
        ).rejects.toBe(boom);
        // Exactly one event on settle: still only the error event above.
        const event = singleEvent();
        expect(event.status).toBe('error');
        expect(event.err).toEqual({ code: 'CliError', where: 'op4' });

        // A plain Error maps to its own name ('Error')...
        const plain = new Error('x');
        await expect(
            recordUsageSpan('op4plain', ctx(), async () => {
                throw plain;
            }),
        ).rejects.toBe(plain);
        expect(lastEvent().err?.code).toBe('Error');
        // ...and built-in Error subclasses keep theirs (pinned rule:
        // err.code = thrown instanceof Error ? thrown.name : 'Unknown').
        const typeErr = new TypeError('x');
        await expect(
            recordUsageSpan('op4type', ctx(), async () => {
                throw typeErr;
            }),
        ).rejects.toBe(typeErr);
        expect(lastEvent().err?.code).toBe('TypeError');
        // Non-Error throws degrade to 'Unknown'.
        await expect(
            recordUsageSpan('op4str', ctx(), async () => {
                throw 'str';
            }),
        ).rejects.toBe('str');
        expect(lastEvent().err).toEqual({ code: 'Unknown', where: 'op4str' });
    });

    it('5. projectKey: projectDir wins, anchor is the fallback, neither → null', async () => {
        const recorder = getUsageRecorder();
        await recordUsageSpan('op5', ctx({ projectDir: 'D:\\p' }), ok);
        await recordUsageSpan('op5anchor', ctx({ anchor: 'D:\\anchor' }), ok);
        await recordUsageSpan('op5none', ctx(), ok);
        const all = parsedEvents();
        expect(all).toHaveLength(3);
        expect(all[0].pid_hash).toMatch(/^[0-9a-f]{8}$/);
        expect(all[0].pid_hash).toBe(recorder.projectHash('D:\\p'));
        expect(all[1].pid_hash).toBe(recorder.projectHash('D:\\anchor'));
        expect(all[2].pid_hash).toBeNull();
    });

    it('7. api spans: value flows, host api; throwing body → error event + rethrow', async () => {
        const recorder = getUsageRecorder();
        await expect(
            recordApiSpan('api.op', 'D:\\proj', async () => 42),
        ).resolves.toBe(42);
        expect(recordApiSpanSync('api.sync', 'D:\\proj', () => 'ret')).toBe(
            'ret',
        );

        const first = parsedEvents();
        expect(first).toHaveLength(2);
        expect(first[0].host).toBe('api');
        expect(first[0].status).toBe('ok');
        expect(first[0].pid_hash).toBe(recorder.projectHash('D:\\proj'));
        expect(first[1].host).toBe('api');
        expect(first[1].status).toBe('ok');

        const boom = new Error('api boom');
        await expect(
            recordApiSpan('api.err', 'D:\\proj', async () => {
                throw boom;
            }),
        ).rejects.toBe(boom);
        let caught: unknown;
        try {
            recordApiSpanSync('api.syncErr', 'D:\\proj', () => {
                throw boom;
            });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBe(boom);

        const tail = parsedEvents().slice(2);
        expect(tail).toHaveLength(2);
        expect(tail[0].status).toBe('error');
        expect(tail[0].err).toEqual({ code: 'Error', where: 'api.err' });
        expect(tail[1].status).toBe('error');
        expect(tail[1].err).toEqual({ code: 'Error', where: 'api.syncErr' });
    });

    // Declared last on purpose: the singleton memoizes its enabled state, so
    // the disabled case needs a fresh module registry (resetModules) to read
    // the off config it just wrote — running it early would poison the
    // enabled cases above.
    it('6. disabled recorder: body runs directly with identical result/rethrow, nothing written', async () => {
        writeJsonConfig({ templates: {}, usageLog: { enabled: false } });
        vi.resetModules();
        const usage = await import('../../packages/cli/src/lib/usage');

        let ran = false;
        await usage.recordUsageSpan('help', ctx(), async () => {
            ran = true;
        });
        expect(ran).toBe(true);
        await expect(
            usage.recordUsageSpan('help', ctx(), async () => {
                throw new Error('still propagates');
            }),
        ).rejects.toThrow('still propagates');
        expect(usage.recordApiSpanSync('api.sync', 'D:\\p', () => 'v')).toBe(
            'v',
        );

        expect(fs.existsSync(usageDir())).toBe(false);
        expect(fs.existsSync(eventsFile())).toBe(false);
    });
});
