import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { join } from 'path';
import type { InvocationContext } from '../../packages/cli/src/lib/invocation';
import { BuildSession } from '@pzstudio/core';
import { runCLI } from '../../packages/cli/src/lib/cli';
import { createPzStudio } from '../../packages/cli/src/lib/studio';
import { recordUsageSpan } from '../../packages/cli/src/lib/usage';
import { setLogger } from '../../packages/cli/src/lib/logger';
import { setCliIO } from '../../packages/cli/src/lib/parser';
import { CliError } from '../../packages/cli/src/lib/errors';

// NO module mocks here: the wiring tests spy the real recorder's file writes
// through the fake HOME (vitest.setup.ts) so the production chokepoint and
// facade wraps run against the real sink. Output stays pristine because the
// suite installs a recording logger + capturing CliIO (cliLifecycle idiom) —
// the one-time disclosure notice routes through the same captured sinks.
//
// The usage-recorder singleton memoizes its enabled state, so the disabled
// case (2) is declared LAST with a fresh module registry — same idiom as
// usageSpan.test.ts test 6.

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
    fs.existsSync(eventsFile())
        ? eventLines(eventsFile()).map((line) => JSON.parse(line))
        : [];

const singleEvent = (): any => {
    const all = parsedEvents();
    expect(all).toHaveLength(1);
    return all[0];
};

const writeJsonConfig = (config: unknown): void => {
    fs.mkdirSync(pzDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config), 'utf-8');
};

/** Minimal lifecycle-shaped context; per-test overrides on top. */
const ctx = (overrides: Partial<SpanCtx> = {}): SpanCtx => ({
    interactionMode: 'embedded',
    invocationOptions: {},
    projectDir: undefined,
    anchor: undefined,
    ...overrides,
});

interface LogCall {
    method: string;
    message: any;
}

let logCalls: LogCall[] = [];
let ioStderr: string[] = [];

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
    const sink = {
        stdout: () => {},
        stderr: (t: string) => ioStderr.push(t),
    };
    setCliIO(sink);
});

afterEach(() => {
    setLogger(undefined);
    setCliIO(undefined);
    logCalls = [];
    ioStderr = [];
});

describe('usage wiring (lifecycle chokepoint + facade wraps)', () => {
    it('1. embedded runCLI records one event: op help, host api, status ok', async () => {
        await runCLI('help', [], { flags: [] });

        const event = singleEvent();
        expect(event.op).toBe('help');
        expect(event.host).toBe('api');
        expect(event.status).toBe('ok');
        expect(Number.isInteger(event.dur_ms)).toBe(true);
    });

    it('1b. banner path (no command) records nothing — pure invocations stay side-effect-free', async () => {
        // valid.command is undefined on the banner path (validateInvocation
        // returns early); the chokepoint records only executed COMMANDS, so
        // a help lookup never scaffolds ~/.pzstudio (pack-smoke contract:
        // pure invocation leaves no ~/.pzstudio).
        await runCLI(undefined, undefined, { flags: [] });

        expect(parsedEvents()).toHaveLength(0);
    });

    it('3. facade devsync.create spans the call: api event + outcome propagated', () => {
        // A directory without project.json: createDevSyncCore resolves the
        // project lazily (per plan input), so creation RETURNS a session.
        const projectless = join(fakeHome(), 'devsync-no-project');
        fs.mkdirSync(projectless, { recursive: true });

        const studio = createPzStudio();
        const session = studio.createDevSync(projectless);

        // The call's outcome propagated unchanged: a real BuildSession.
        expect(session).toBeInstanceOf(BuildSession);

        const event = singleEvent();
        expect(event.op).toBe('devsync.create');
        expect(event.host).toBe('api');
        expect(event.status).toBe('ok');
    });

    it('4. facade doctor.api error: event status error with err.code CliError, original error rethrown', async () => {
        // The doctor core reports a missing project as a diagnostic, not a
        // throw — the facade span's error path needs a body that actually
        // rejects, so the host settings provider (invoked inside the span
        // body) throws the structured CliError.
        const boom = new CliError('No pzstudio project found.');
        const studio = createPzStudio({
            settings: () => {
                throw boom;
            },
        });
        const projectless = join(fakeHome(), 'doctor-error-project');
        fs.mkdirSync(projectless, { recursive: true });

        await expect(studio.runProjectDoctor(projectless)).rejects.toBe(boom);

        const event = singleEvent();
        expect(event.op).toBe('doctor.api');
        expect(event.host).toBe('api');
        expect(event.status).toBe('error');
        expect(event.err).toEqual({ code: 'CliError', where: 'doctor.api' });
    });

    it('4b. facade doctor.api on a missing project resolves with the report and records ok', async () => {
        // Pinned current behavior (deviation note: the brief expected this
        // input to reject): runProjectDoctorCore turns a missing project
        // into a DoctorReport finding, so the span settles ok — one event.
        const missing = join(fakeHome(), 'definitely-missing');

        const report = await createPzStudio().runProjectDoctor(missing);

        expect(report.project).toBeUndefined();
        expect(
            report.diagnostics.some((d) => d.code === 'project.missing'),
        ).toBe(true);

        const event = singleEvent();
        expect(event.op).toBe('doctor.api');
        expect(event.host).toBe('api');
        expect(event.status).toBe('ok');
    });

    it('5. studio.run records through the shared lifecycle exactly once', async () => {
        const studio = createPzStudio();

        await studio.run('help', [], {});

        // Exactly ONE event for the run: the lifecycle chokepoint records
        // it; run itself is deliberately not facade-wrapped (no duplicate).
        const all = parsedEvents();
        expect(all).toHaveLength(1);
        expect(all[0].op).toBe('help');
        expect(all[0].host).toBe('api');
        expect(all[0].status).toBe('ok');
    });

    it('6. facade pure readers (resolveModInfoTargets / resolveOutDir) record nothing', () => {
        const studio = createPzStudio();
        const projectless = join(fakeHome(), 'readers-no-project');
        fs.mkdirSync(projectless, { recursive: true });

        expect(studio.resolveModInfoTargets('m', projectless)).toEqual([]);
        expect(() => studio.resolveOutDir(projectless)).toThrow(CliError);

        expect(parsedEvents()).toEqual([]);
    });

    it('7. op usage is never recorded, enabled or not', async () => {
        let ran = false;
        await recordUsageSpan('usage', ctx(), async () => {
            ran = true;
        });

        expect(ran).toBe(true);
        expect(parsedEvents()).toEqual([]);
    });

    it('8. nullish invocationOptions do not crash the ok path', async () => {
        let ran = false;
        await expect(
            recordUsageSpan(
                'help',
                ctx({ invocationOptions: undefined as any }),
                async () => {
                    ran = true;
                },
            ),
        ).resolves.toBeUndefined();

        expect(ran).toBe(true);
        const event = singleEvent();
        expect(event.op).toBe('help');
        expect(event.status).toBe('ok');
    });

    // Declared last on purpose: the disabled case needs a fresh module
    // registry (resetModules) so a fresh recorder singleton reads the off
    // config it just wrote — running it earlier would poison the enabled
    // cases above (the singleton memoizes its enabled state).
    it('2. disabled → runCLI records nothing (usage dir stays absent)', async () => {
        writeJsonConfig({ templates: {}, usageLog: { enabled: false } });
        vi.resetModules();
        const freshLogger = await import('../../packages/cli/src/lib/logger');
        const freshParser = await import('../../packages/cli/src/lib/parser');
        const freshCli = await import('../../packages/cli/src/lib/cli');

        freshLogger.setLogger({
            log: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
            verbose: () => {},
        });
        freshParser.setCliIO({ stdout: () => {}, stderr: () => {} });

        await freshCli.runCLI('help', [], { flags: [] });

        expect(fs.existsSync(usageDir())).toBe(false);
        expect(fs.existsSync(eventsFile())).toBe(false);
    });
});
