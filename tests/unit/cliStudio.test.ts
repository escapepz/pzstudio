import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';
import type { TemplateTransport } from '@pzstudio/platform';

const spawnSyncCalls = vi.hoisted(
    () => [] as Array<{ command: string; args?: readonly string[] }>,
);

// Counting spy over the REAL spawnSync: the probe-timing tests below assert
// that v2 invocations which need no template transport never probe git
// availability. Everything delegates to the original — no behavior masked.
vi.mock('child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('child_process')>();
    return {
        ...original,
        spawnSync: (command: string, args?: readonly string[], opts?: any) => {
            spawnSyncCalls.push({ command, args });
            return original.spawnSync(command, args as any, opts);
        },
    };
});

// Importing the legacy dispatcher registers every command into the registry
// (studio.run dispatches through the same registry).
import { runCLI } from '../../packages/cli/src/lib/cli';
import { createPzStudio } from '../../packages/cli/src/lib/studio';
import {
    setLogger,
    setVerbose,
    setQuiet,
    setDebug,
    rawLog,
    rawInfo,
    rawVerbose,
    error as engineError,
} from '../../packages/cli/src/lib/logger';
import {
    CliUsageError,
    setCliIO,
    type CliIO,
} from '../../packages/cli/src/lib/parser';
import { CliError } from '../../packages/cli/src/lib/errors';
import { hasFlag, setInvocationOptions } from '../../packages/cli/src/lib/args';
import {
    setProjectDir,
    setProjectRootAnchor,
    legacyDiscoveryStart,
    getExternalProjectDir,
    setVsCodeSettings,
    getVsCodeSettings,
    discoveryStartDir,
} from '../../packages/cli/src/lib/helper';
import {
    setTemplateTransport,
    legacyTransport,
    getTemplateTransport,
    FetchTransport,
    GitTransport,
} from '../../packages/cli/src/lib/transport';
import {
    setInteractionMode,
    getInteractionMode,
} from '../../packages/cli/src/lib/interaction';
import { getCommand } from '../../packages/cli/src/lib/registry';
import { getActiveInvocationContext } from '../../packages/cli/src/lib/invocation';
import { getConfigPath } from '../../packages/cli/src/lib/templateManager';
import * as helperModule from '../../packages/cli/src/lib/helper';
import * as loggerModule from '../../packages/cli/src/lib/logger';
import * as transportModule from '../../packages/cli/src/lib/transport';

/* ------------------------------------------------------------------ */
/* Fixtures and capture helpers                                        */
/* ------------------------------------------------------------------ */

interface LogCall {
    method: string;
    message: any;
}

function recordingLogger() {
    const calls: LogCall[] = [];
    const logger = {
        log: (m: any) => calls.push({ method: 'log', message: m }),
        info: (m: any) => calls.push({ method: 'info', message: m }),
        warn: (m: any) => calls.push({ method: 'warn', message: m }),
        error: (e: any) => calls.push({ method: 'error', message: e }),
        verbose: (m: any) => calls.push({ method: 'verbose', message: m }),
    };
    return { calls, logger };
}

interface Captured {
    stdout: string[];
    stderr: string[];
}

function captureIO(): Captured {
    const captured: Captured = { stdout: [], stderr: [] };
    const sink: CliIO = {
        stdout: (t) => captured.stdout.push(t),
        stderr: (t) => captured.stderr.push(t),
    };
    setCliIO(sink);
    return captured;
}

let tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = createTempDir();
    tempDirs.push(dir);
    return dir;
}

function makeProjectDir(title: string): string {
    const dir = makeTempDir();
    fs.writeFileSync(
        path.join(dir, 'project.json'),
        JSON.stringify({
            workshop: { title, visibility: 'public', tags: [] },
            mods: {},
            excludes: [],
        }),
    );
    return dir;
}

function sentinelTransport(name: 'git' | 'fetch' = 'git'): TemplateTransport {
    return {
        name,
        download: () => {},
        refresh: () => false,
        isCacheValid: () => false,
    };
}

/** Temporarily replaces a registered command's run (test-only swap). */
function withCommandRun(
    name: string,
    swapped: () => Promise<void>,
): () => void {
    const def = getCommand(name)!;
    const original = def.run;
    def.run = swapped;
    return () => {
        def.run = original;
    };
}

/** Namespace handles for spying on the raw legacy accessors (R0 proofs). */
const helperNs = helperModule as unknown as Record<string, any>;
const loggerNs = loggerModule as unknown as Record<string, any>;
const transportNs = transportModule as unknown as Record<string, any>;

function spyRawAccessors() {
    return {
        externalDir: vi.spyOn(helperNs, 'getExternalProjectDir'),
        legacySettings: vi.spyOn(helperNs, 'legacySettings'),
        legacyDiscoveryStart: vi.spyOn(helperNs, 'legacyDiscoveryStart'),
        legacyLogger: vi.spyOn(loggerNs, 'legacyLogger'),
        legacyTransport: vi.spyOn(transportNs, 'legacyTransport'),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    setLogger(undefined);
    setCliIO(undefined);
    setProjectDir(undefined);
    setProjectRootAnchor(undefined);
    setTemplateTransport(undefined);
    setInvocationOptions(undefined);
    setVsCodeSettings(undefined, undefined);
    setInteractionMode('embedded');
    setVerbose(false);
    setQuiet(false);
    setDebug(false);
    spawnSyncCalls.length = 0;
    for (const dir of tempDirs) deleteDir(dir);
    tempDirs = [];
});

/* ------------------------------------------------------------------ */
/* 1. Golden equivalence: legacy runCLI ≡ v2 studio.run                */
/*    (same captured output, same thrown error kinds)                  */
/* ------------------------------------------------------------------ */

describe('golden equivalence: runCLI ≡ studio.run (captured output)', () => {
    it('normal success: identical stdout/stderr sequences', async () => {
        const proj = makeProjectDir('Golden');
        const studio = createPzStudio();

        const legacy = captureIO();
        await runCLI('list', [], { flags: ['--project', proj] });
        const legacyOut = {
            stdout: [...legacy.stdout],
            stderr: [...legacy.stderr],
        };

        setCliIO(undefined);
        const v2 = captureIO();
        await studio.run('list', [], { flags: ['--project', proj] });

        expect(v2.stdout).toEqual(legacyOut.stdout);
        expect(v2.stderr).toEqual(legacyOut.stderr);
        // Sanity: the golden actually captured the full command rhythm
        // (pre-command blank line, list output, completion info, blank line).
        expect(legacyOut.stdout).toEqual([
            '\n',
            "No mods in project 'Golden'.\n",
            '\n',
        ]);
        expect(legacyOut.stderr).toEqual([
            '[INFO] Command [list] completed.\n',
        ]);
    });

    it('help: identical stdout/stderr sequences', async () => {
        const studio = createPzStudio();

        const legacy = captureIO();
        await runCLI('help');
        const legacyOut = [...legacy.stdout];

        setCliIO(undefined);
        const v2 = captureIO();
        await studio.run('help');

        expect(v2.stdout).toEqual(legacyOut);
        expect(legacyOut[0]).toContain('Available commands:');
        expect(legacyOut[1]).toBe('\n');
    });

    it('usage error: identical error report and same rejection kind', async () => {
        const studio = createPzStudio();

        const legacy = captureIO();
        await expect(
            runCLI('build', [], { flags: ['--wat'] }),
        ).rejects.toBeInstanceOf(CliUsageError);
        const legacyErr = [...legacy.stderr];

        setCliIO(undefined);
        const v2 = captureIO();
        await expect(
            studio.run('build', [], { flags: ['--wat'] }),
        ).rejects.toBeInstanceOf(CliUsageError);

        expect(v2.stderr).toEqual(legacyErr);
        expect(legacyErr.join('')).toContain("Unknown option '--wat'");
    });

    it('throwing command: identical error report and same rejection kind', async () => {
        const emptyDir = makeTempDir();
        const studio = createPzStudio();

        const legacy = captureIO();
        await expect(
            runCLI('list', [], { flags: ['--project', emptyDir] }),
        ).rejects.toBeInstanceOf(CliError);
        const legacyOut = [...legacy.stdout];
        const legacyErr = [...legacy.stderr];

        setCliIO(undefined);
        const v2 = captureIO();
        await expect(
            studio.run('list', [], { flags: ['--project', emptyDir] }),
        ).rejects.toBeInstanceOf(CliError);

        expect(v2.stdout).toEqual(legacyOut);
        expect(v2.stderr).toEqual(legacyErr);
        expect(legacyOut).toEqual(['\n']);
        expect(legacyErr.join('')).toContain('No pzstudio project found.');
    });
});

/* ------------------------------------------------------------------ */
/* 2. R0 acceptance: an omitted v2 field never consumes the            */
/*    corresponding legacy facade value                                */
/* ------------------------------------------------------------------ */

describe('R0 legacy-blindness (v2 never falls through to the facade)', () => {
    it('with every legacy setter populated, a v2 instance with all fields omitted consumes none of them', async () => {
        const projA = makeProjectDir('ProjA');
        const L1 = recordingLogger();
        const T1 = sentinelTransport('fetch');

        setProjectDir(projA);
        setLogger(L1.logger);
        setVsCodeSettings({ outdir: 'C:/legacy-ws-out' });
        setTemplateTransport(T1);

        const spies = spyRawAccessors();
        const captured = captureIO();

        // Control: the same spies DO fire on the legacy path (spy validity).
        await runCLI('help');
        expect(spies.legacyLogger).toHaveBeenCalled();
        expect(spies.legacyTransport).toHaveBeenCalled();
        expect(spies.externalDir).toHaveBeenCalled();
        expect(spies.legacySettings).toHaveBeenCalled();
        for (const spy of Object.values(spies)) spy.mockClear();
        L1.calls.length = 0;

        // v2 instance with every field omitted.
        const studio = createPzStudio();

        // (a) during-run reads: no legacy logger/settings/transport/discovery.
        let during:
            | {
                  settings: ReturnType<typeof getVsCodeSettings>;
                  transport: unknown;
                  start: string;
              }
            | undefined;
        const restore = withCommandRun('list', async () => {
            during = {
                settings: getVsCodeSettings(),
                transport: getTemplateTransport(),
                start: discoveryStartDir(),
            };
        });
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        expect(during!.settings).toEqual({
            templates: undefined,
            outdir: undefined,
            useSymlinks: undefined,
        });
        expect(during!.transport).not.toBe(T1);
        expect(during!.start).toBe(process.cwd());
        expect(during!.start).not.toBe(projA);

        // (b) end-to-end discovery: the error cause names the cwd start.
        const err = await studio.run('list').catch((e) => e);
        expect(err).toBeInstanceOf(CliError);
        expect(String(err.cause)).toContain(process.cwd());
        expect(String(err.cause)).not.toContain(projA);

        // The legacy logger received NOTHING — the default engine logger
        // emitted through the CliIO sink instead.
        expect(L1.calls).toEqual([]);
        expect(captured.stderr.join('')).toContain('[ERROR]');

        // Zero reads of the raw legacy accessors across both v2 runs.
        expect(spies.legacyLogger).not.toHaveBeenCalled();
        expect(spies.legacySettings).not.toHaveBeenCalled();
        expect(spies.legacyTransport).not.toHaveBeenCalled();
        expect(spies.externalDir).not.toHaveBeenCalled();
        expect(spies.legacyDiscoveryStart).not.toHaveBeenCalled();
    });

    it('mirror: a fully-populated instance also never reads the legacy slots', async () => {
        const projB = makeProjectDir('ProjB');
        const L1 = recordingLogger();
        const L2 = recordingLogger();
        const T1 = sentinelTransport('fetch');
        const T2 = sentinelTransport('git');
        const provider = vi.fn(() => ({ user: { outdir: 'C:/v2-out' } }));

        setProjectDir(projB);
        setLogger(L1.logger);
        setVsCodeSettings({ outdir: 'C:/legacy-ws-out' });
        setTemplateTransport(T1);

        const spies = spyRawAccessors();
        captureIO();

        const studio = createPzStudio({
            projectDir: projB,
            logger: L2.logger,
            settings: provider,
            templateTransport: T2,
        });

        const restore = withCommandRun('list', async () => {});
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        // Outputs and dependencies come exclusively from the instance.
        // (The swapped command body is empty: pre-command blank line,
        // completion info, trailing blank line.)
        expect(L1.calls).toEqual([]);
        expect(L2.calls.map((c) => c.method)).toEqual(['log', 'info', 'log']);
        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider).toHaveBeenCalledWith({ projectDir: projB });
        expect(spies.legacyLogger).not.toHaveBeenCalled();
        expect(spies.legacySettings).not.toHaveBeenCalled();
        expect(spies.legacyTransport).not.toHaveBeenCalled();
        expect(spies.externalDir).not.toHaveBeenCalled();
        expect(spies.legacyDiscoveryStart).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/* 3. v2 writes nothing to the legacy state (§13.1 mirror)             */
/* ------------------------------------------------------------------ */

describe('v2 writes nothing to the legacy slots (§13.1 mirror)', () => {
    it('after an aggressive v2 run, the persisted legacy fields keep their pre-run values', async () => {
        const captured = captureIO();
        const projAnchor = makeTempDir();
        const projExternal = makeTempDir();
        const projFlag = makeTempDir();
        const T1 = sentinelTransport('git');

        setProjectRootAnchor(projAnchor);
        setProjectDir(projExternal);
        setVsCodeSettings({ outdir: 'C:/legacy-ws-out' });
        setTemplateTransport(T1);
        setInteractionMode('non-interactive');
        setInvocationOptions({ marker: 'keep' });
        setVerbose(true);
        setQuiet(false);
        setDebug(true);

        const studio = createPzStudio();
        await studio.run('help', [], {
            flags: [
                '--project',
                projFlag,
                '--verbose',
                '--quiet',
                '--debug',
                '--transport',
                'fetch',
            ],
        });

        // anchor: not overwritten with --project, not cleared.
        expect(legacyDiscoveryStart()).toBe(projAnchor);
        // external project dir: never written.
        expect(getExternalProjectDir()).toBe(projExternal);
        // sticky transport: the v2 --transport did not persist.
        expect(legacyTransport()).toBe(T1);
        expect(getTemplateTransport()).toBe(T1);
        // interaction mode: untouched.
        expect(getInteractionMode()).toBe('non-interactive');
        // invocation options: pre-existing marker survives; nothing leaked.
        expect(hasFlag('marker')).toBe(true);
        expect(hasFlag('verbose')).toBe(false);
        expect(hasFlag('project')).toBe(false);
        expect(hasFlag('transport')).toBe(false);
        // verbosity flags: verbose still enabled (published verbose emits),
        // quiet still disabled (the run's own --quiet does not gate
        // published info), debug still enabled (the unexpected-error report
        // keeps its stack instead of the hint line).
        rawVerbose('post-v2-verbose');
        expect(captured.stderr.join('')).toContain('[DEBUG] post-v2-verbose');
        rawInfo('post-v2-info');
        expect(captured.stderr.join('')).toContain('[INFO] post-v2-info');
        engineError(new Error('boom'));
        expect(captured.stderr.join('')).toContain('Unexpected error: boom');
        expect(captured.stderr.join('')).not.toContain('Run with --debug');
        // settings slots: untouched.
        expect(getVsCodeSettings()).toEqual({
            templates: undefined,
            outdir: 'C:/legacy-ws-out',
            useSymlinks: undefined,
        });
    });

    it('the logger slot is neither consumed nor cleared: published calls still route to it, and it receives nothing from the v2 run', async () => {
        const captured = captureIO();
        const projAnchor = makeTempDir();
        const projExternal = makeTempDir();
        const projFlag = makeTempDir();
        const L1 = recordingLogger();
        const T1 = sentinelTransport('git');

        setProjectRootAnchor(projAnchor);
        setProjectDir(projExternal);
        setLogger(L1.logger);
        setVsCodeSettings({ outdir: 'C:/legacy-ws-out' });
        setTemplateTransport(T1);

        const studio = createPzStudio();
        await studio.run('help', [], {
            flags: ['--project', projFlag, '--verbose', '--transport', 'fetch'],
        });

        // The v2 run emitted through its default engine logger (the CliIO
        // sink), never through the legacy slot.
        expect(L1.calls).toEqual([]);
        expect(captured.stdout.join('')).toContain('Available commands:');

        // ...and the slot still routes for published calls afterwards —
        // it was not cleared by the v2 run.
        rawLog('still-legacy');
        expect(L1.calls).toEqual([{ method: 'log', message: 'still-legacy' }]);

        // The v2 run's --verbose did not persist into the legacy gate:
        // the published verbose stays disabled (verboseEnabled untouched
        // false) and emits nowhere.
        rawVerbose('still-gated');
        expect(L1.calls).toEqual([{ method: 'log', message: 'still-legacy' }]);
        expect(captured.stderr.join('')).not.toContain('still-gated');

        // Remaining slots: unchanged by the run.
        expect(legacyDiscoveryStart()).toBe(projAnchor);
        expect(getExternalProjectDir()).toBe(projExternal);
        expect(legacyTransport()).toBe(T1);
        expect(getVsCodeSettings()).toEqual({
            templates: undefined,
            outdir: 'C:/legacy-ws-out',
            useSymlinks: undefined,
        });
    });

    it('a v2 run without --project does not clear the legacy anchor either', async () => {
        captureIO();
        const projAnchor = makeTempDir();
        setProjectRootAnchor(projAnchor);

        const studio = createPzStudio();
        await studio.run('help');

        expect(legacyDiscoveryStart()).toBe(projAnchor);
    });
});

/* ------------------------------------------------------------------ */
/* 4. Settings provider: once per operation, post-parse, effective     */
/*    project                                                          */
/* ------------------------------------------------------------------ */

describe('v2 settings provider', () => {
    it('is called exactly once per operation — success, help and usage-error runs alike', async () => {
        captureIO();
        const proj = makeProjectDir('ProjSettings');
        const provider = vi.fn(() => ({ user: { outdir: 'C:/p-out' } }));
        const studio = createPzStudio({ projectDir: proj, settings: provider });

        await studio.run('list');
        expect(provider).toHaveBeenCalledTimes(1);

        await studio.run('help');
        expect(provider).toHaveBeenCalledTimes(2);

        await expect(
            studio.run('build', [], { flags: ['--wat'] }),
        ).rejects.toBeInstanceOf(CliUsageError);
        expect(provider).toHaveBeenCalledTimes(3);
    });

    it('receives the parsed --project value — proof of post-parse resolution', async () => {
        captureIO();
        const projA = makeProjectDir('ProjA');
        const projC = makeProjectDir('ProjC');
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({
            projectDir: projC,
            settings: provider,
        });

        await studio.run('list', [], { flags: ['--project', projA] });

        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider).toHaveBeenCalledWith({
            projectDir: path.resolve(projA),
        });
    });

    it('a plain PzStudioHostSettings snapshot is accepted as a context-ignoring layer', async () => {
        captureIO();
        const proj = makeProjectDir('ProjObj');
        const studio = createPzStudio({
            projectDir: proj,
            settings: { workspace: { outdir: 'C:/obj-out' } },
        });

        let during: ReturnType<typeof getVsCodeSettings> | undefined;
        const restore = withCommandRun('list', async () => {
            during = getVsCodeSettings();
        });
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        expect(during).toEqual({
            templates: undefined,
            outdir: 'C:/obj-out',
            useSymlinks: undefined,
        });
    });

    it('no settings at all → the invocation has no host layer', async () => {
        captureIO();
        const proj = makeProjectDir('ProjNone');
        const studio = createPzStudio({ projectDir: proj });

        let during: ReturnType<typeof getVsCodeSettings> | undefined;
        const restore = withCommandRun('list', async () => {
            during = getVsCodeSettings();
        });
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        expect(during).toEqual({
            templates: undefined,
            outdir: undefined,
            useSymlinks: undefined,
        });
    });
});

/* ------------------------------------------------------------------ */
/* 5. Project precedence matrix: --project > per-call > factory > cwd  */
/* ------------------------------------------------------------------ */

describe('project precedence matrix (§11)', () => {
    it('--project A > per-call C > factory B: the run targets A and the provider receives A', async () => {
        const captured = captureIO();
        const projA = makeProjectDir('ProjA');
        const projC = makeProjectDir('ProjC');
        const projB = makeProjectDir('ProjB');
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({
            projectDir: projB,
            settings: provider,
        });

        await studio.run('list', [], {
            flags: ['--project', projA],
            projectDir: projC,
        });

        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider).toHaveBeenCalledWith({
            projectDir: path.resolve(projA),
        });
        expect(captured.stdout.join('')).toContain(
            "No mods in project 'ProjA'.",
        );
    });

    it('per-call C beats factory B', async () => {
        const captured = captureIO();
        const projC = makeProjectDir('ProjC');
        const projB = makeProjectDir('ProjB');
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({
            projectDir: projB,
            settings: provider,
        });

        await studio.run('list', [], { projectDir: projC });

        expect(provider).toHaveBeenCalledWith({ projectDir: projC });
        expect(captured.stdout.join('')).toContain(
            "No mods in project 'ProjC'.",
        );
    });

    it('factory B alone is used as given', async () => {
        const captured = captureIO();
        const projB = makeProjectDir('ProjB');
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({
            projectDir: projB,
            settings: provider,
        });

        await studio.run('list');

        expect(provider).toHaveBeenCalledWith({ projectDir: projB });
        expect(captured.stdout.join('')).toContain(
            "No mods in project 'ProjB'.",
        );
    });

    it('no layer at all: discovery from process.cwd() (and the provider is told so)', async () => {
        captureIO();
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({ settings: provider });

        const err = await studio.run('list').catch((e) => e);
        expect(err).toBeInstanceOf(CliError);
        expect(String(err.cause)).toContain(process.cwd());

        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider).toHaveBeenCalledWith({ projectDir: process.cwd() });
    });
});

/* ------------------------------------------------------------------ */
/* 6. Transport: instance value, host default, invocation-scoped flag  */
/* ------------------------------------------------------------------ */

describe('v2 transport model (§12)', () => {
    it('instance transport is used when supplied', async () => {
        captureIO();
        const proj = makeProjectDir('ProjT');
        const T2 = sentinelTransport('fetch');
        const studio = createPzStudio({
            projectDir: proj,
            templateTransport: T2,
        });

        let during: unknown;
        const restore = withCommandRun('list', async () => {
            during = getTemplateTransport();
        });
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        expect(during).toBe(T2);
    });

    it('host default used otherwise — never the sticky legacy slot, no probe on acquisition or non-template runs', async () => {
        captureIO();
        const proj = makeProjectDir('ProjT');
        const T1 = sentinelTransport('fetch');
        setTemplateTransport(T1);
        spawnSyncCalls.length = 0;

        const studio = createPzStudio({ projectDir: proj });

        let during: unknown;
        let restore = withCommandRun('list', async () => {
            during = getTemplateTransport();
        });
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        expect(during).not.toBe(T1);
        // No template use happened: the lazy host default must not have
        // probed git (the probe belongs to actual template acquisition).
        expect(spawnSyncCalls).toEqual([]);

        // Help and usage-error runs are transport-free as well.
        restore = withCommandRun('help', async () => {});
        try {
            await studio.run('help');
            await expect(
                studio.run('build', [], { flags: ['--wat'] }),
            ).rejects.toBeInstanceOf(CliUsageError);
        } finally {
            restore();
        }
        expect(spawnSyncCalls).toEqual([]);
    });

    it('--transport overrides only that invocation; nothing sticky, legacy slot untouched', async () => {
        captureIO();
        const proj = makeProjectDir('ProjT');
        const T1 = sentinelTransport('git');
        const T2 = sentinelTransport('fetch');
        setTemplateTransport(T1);

        const studio = createPzStudio({
            projectDir: proj,
            templateTransport: T2,
        });

        const duringRuns: unknown[] = [];
        const restore = withCommandRun('list', async () => {
            duringRuns.push(getTemplateTransport());
        });
        try {
            await studio.run('list', [], {
                flags: ['--transport', 'fetch'],
            });
            await studio.run('list');
        } finally {
            restore();
        }

        // Run 1: the flag won for that invocation; run 2: the instance
        // transport again.
        expect(duringRuns[0]).toBeInstanceOf(FetchTransport);
        expect(duringRuns[1]).toBe(T2);
        // The legacy sticky slot was never written.
        expect(legacyTransport()).toBe(T1);
        expect(getTemplateTransport()).toBe(T1);
    });

    it('--transport git selects the git transport for the invocation', async () => {
        captureIO();
        const proj = makeProjectDir('ProjT');
        const studio = createPzStudio({ projectDir: proj });

        let during: unknown;
        const restore = withCommandRun('list', async () => {
            during = getTemplateTransport();
        });
        try {
            await studio.run('list', [], { flags: ['--transport', 'git'] });
        } finally {
            restore();
        }

        expect(during).toBeInstanceOf(GitTransport);
    });
});

/* ------------------------------------------------------------------ */
/* 7. Lifecycle cleanup / isolation                                    */
/* ------------------------------------------------------------------ */

describe('v2 lifecycle isolation', () => {
    it('context restored and lock released on success, help, usage error and throwing command', async () => {
        captureIO();
        const emptyDir = makeTempDir();
        const proj = makeProjectDir('ProjLifecycle');
        const studio = createPzStudio();

        await studio.run('list', [], { flags: ['--project', proj] });
        expect(getActiveInvocationContext()).toBeUndefined();

        await studio.run('help');
        expect(getActiveInvocationContext()).toBeUndefined();

        await expect(
            studio.run('build', [], { flags: ['--wat'] }),
        ).rejects.toBeInstanceOf(CliUsageError);
        expect(getActiveInvocationContext()).toBeUndefined();

        await expect(
            studio.run('list', [], { flags: ['--project', emptyDir] }),
        ).rejects.toBeInstanceOf(CliError);
        expect(getActiveInvocationContext()).toBeUndefined();

        // The lock is released on every path: a later invocation still runs.
        await expect(studio.run('help')).resolves.toBeUndefined();
        expect(getActiveInvocationContext()).toBeUndefined();
    });

    it('every emission path routes through the instance logger', async () => {
        captureIO();
        const emptyDir = makeTempDir();
        const proj = makeProjectDir('ProjRouting');

        const success = recordingLogger();
        await createPzStudio({ logger: success.logger }).run('list', [], {
            flags: ['--project', proj],
        });
        expect(success.calls.map((c) => c.method)).toEqual([
            'log',
            'log',
            'info',
            'log',
        ]);
        expect(String(success.calls[1].message)).toContain(
            "No mods in project 'ProjRouting'.",
        );

        const help = recordingLogger();
        await createPzStudio({ logger: help.logger }).run('help');
        expect(help.calls.map((c) => c.method)).toEqual(['log', 'log']);
        expect(String(help.calls[0].message)).toContain('Available commands:');

        const usage = recordingLogger();
        await expect(
            createPzStudio({ logger: usage.logger }).run('build', [], {
                flags: ['--wat'],
            }),
        ).rejects.toBeInstanceOf(CliUsageError);
        expect(usage.calls.map((c) => c.method)).toEqual(['error']);
        expect(usage.calls[0].message).toBeInstanceOf(CliUsageError);

        const thrown = recordingLogger();
        await expect(
            createPzStudio({ logger: thrown.logger }).run('list', [], {
                flags: ['--project', emptyDir],
            }),
        ).rejects.toBeInstanceOf(CliError);
        expect(thrown.calls.map((c) => c.method)).toEqual(['log', 'error']);
        expect(thrown.calls[0].message).toBe('\n');
        expect(String(thrown.calls[1].message)).toContain(
            'No pzstudio project found.',
        );
    });

    it('a legacy runCLI queues behind an active v2 run (shared engine lock, FIFO)', async () => {
        captureIO();
        const proj = makeProjectDir('ProjLock');
        const studio = createPzStudio();
        const events: string[] = [];
        let releaseA: () => void = () => {};
        const gateA = new Promise<void>((r) => {
            releaseA = r;
        });
        let pA: Promise<void> = Promise.resolve();
        let pB: Promise<void> = Promise.resolve();
        let restore: () => void = () => {};

        try {
            pA = studio.run('list', [], { flags: ['--project', proj] });

            // A dispatches first (FIFO) and parks inside its command run.
            restore = withCommandRun('list', async () => {
                events.push('a:start');
                await gateA;
                events.push('a:end');
            });
            await vi.waitFor(() => expect(events).toContain('a:start'));

            // B (legacy door) is queued behind the same lock: swapping the
            // command run now can only be observed by B, which has not
            // started.
            restore();
            restore = withCommandRun('list', async () => {
                events.push('b:start');
                events.push('b:end');
            });
            pB = runCLI('list', [], { flags: ['--project', proj] });

            releaseA();
            await Promise.all([pA, pB]);
        } finally {
            // Never leave a parked invocation holding the lock.
            releaseA();
            restore();
            await Promise.allSettled([pA, pB]);
        }

        // No interleave: A's whole execution precedes B's.
        expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
        expect(getActiveInvocationContext()).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* 8. studio.resolveOutDir (doc 13 §10-A): the five-tier outdir reader */
/* ------------------------------------------------------------------ */

describe('studio.resolveOutDir (doc 13 §10-A): the five-tier outdir reader', () => {
    const fakeHome = () => (globalThis as any).__PZSTUDIO_FAKE_HOME as string;

    /** A valid project.json fixture, optionally carrying an outdir. */
    function makeProject(title: string, outdir?: string): string {
        const dir = makeTempDir();
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
                workshop: { title, visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
                ...(outdir === undefined ? {} : { outdir }),
            }),
        );
        return dir;
    }

    /** Writes the tier-4 global CLI config into the fake home. */
    function writeGlobalConfig(outdir: string): void {
        fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
        fs.writeFileSync(getConfigPath(), JSON.stringify({ outdir }));
    }

    /** Captures the thrown value of a sync call (undefined when none). */
    function caught(fn: () => unknown): unknown {
        try {
            fn();
        } catch (e) {
            return e;
        }
        return undefined;
    }

    it('tier 1: a configured project outdir wins over every other tier', () => {
        const proj = makeProject('Tier1', 'project-out');
        writeGlobalConfig('C:/global-out');
        const studio = createPzStudio({
            settings: () => ({
                workspace: { outdir: 'C:/ws-out' },
                user: { outdir: 'C:/user-out' },
            }),
        });

        expect(studio.resolveOutDir(proj)).toBe(path.join(proj, 'project-out'));
    });

    it('tier 1: a relative project outdir resolves against the discovered project root, even from a subdirectory', () => {
        const proj = makeProject('Tier1Relative', 'out');
        const nested = path.join(proj, 'src', 'content');
        fs.mkdirSync(nested, { recursive: true });
        const studio = createPzStudio();

        expect(studio.resolveOutDir(nested)).toBe(path.join(proj, 'out'));
    });

    it('tier 2: the workspace layer — the folder-scoped composition target (UX-05) — beats the user layer', () => {
        const proj = makeProject('Tier2Workspace');
        const studio = createPzStudio({
            settings: () => ({
                workspace: { outdir: 'C:/ws-out' },
                user: { outdir: 'C:/user-out' },
            }),
        });

        expect(studio.resolveOutDir(proj)).toBe(path.resolve('C:/ws-out'));
    });

    it('tier 2: the workspace layer beats the global config when the user layer is absent', () => {
        const proj = makeProject('Tier2OverGlobal');
        writeGlobalConfig('C:/global-out');
        const studio = createPzStudio({
            settings: () => ({ workspace: { outdir: 'C:/ws-out' } }),
        });

        expect(studio.resolveOutDir(proj)).toBe(path.resolve('C:/ws-out'));
    });

    it('tier 3: the user layer beats the global CLI config', () => {
        const proj = makeProject('Tier3User');
        writeGlobalConfig('C:/global-out');
        const studio = createPzStudio({
            settings: () => ({ user: { outdir: 'C:/user-out' } }),
        });

        expect(studio.resolveOutDir(proj)).toBe(path.resolve('C:/user-out'));
    });

    it('tier 4: the global CLI config outdir is used when the host layers are absent', () => {
        const proj = makeProject('Tier4Global');
        writeGlobalConfig('C:/global-out');
        const studio = createPzStudio({ settings: () => undefined });

        expect(studio.resolveOutDir(proj)).toBe(path.resolve('C:/global-out'));
    });

    it('tier 5: with no outdir in any tier, the default Workshop path is returned', () => {
        const proj = makeProject('Tier5Default');
        const studio = createPzStudio({
            settings: () => ({ workspace: {}, user: {} }),
        });

        expect(studio.resolveOutDir(proj)).toBe(
            path.join(fakeHome(), 'Zomboid', 'Workshop'),
        );
    });

    it('every tier resolves to an absolute, platform-native path', () => {
        const projRel = makeProject('AbsRelative', 'rel-out');
        const projPlain = makeProject('AbsPlain');
        const noLayer = createPzStudio({ settings: () => undefined });
        const wsLayer = createPzStudio({
            settings: () => ({ workspace: { outdir: 'C:/ws-abs' } }),
        });

        expect(path.isAbsolute(noLayer.resolveOutDir(projRel))).toBe(true);
        expect(path.isAbsolute(wsLayer.resolveOutDir(projPlain))).toBe(true);
        writeGlobalConfig('C:/global-abs');
        expect(path.isAbsolute(noLayer.resolveOutDir(projPlain))).toBe(true);
        expect(path.isAbsolute(noLayer.resolveOutDir(projRel))).toBe(true);
    });

    it('two project directories resolve independently — no cross-leak, and the provider receives exactly the requested projectDir', () => {
        const projA = makeProject('CrossA', 'out-a');
        const projB = makeProject('CrossB');
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({ settings: provider });

        expect(studio.resolveOutDir(projA)).toBe(path.join(projA, 'out-a'));
        expect(studio.resolveOutDir(projB)).toBe(
            path.join(fakeHome(), 'Zomboid', 'Workshop'),
        );

        expect(provider).toHaveBeenCalledTimes(2);
        expect(provider).toHaveBeenNthCalledWith(1, { projectDir: projA });
        expect(provider).toHaveBeenNthCalledWith(2, { projectDir: projB });
    });

    it('throws the structured no-project CliError when no project.json exists at or above the directory', () => {
        const emptyDir = makeTempDir();
        const studio = createPzStudio();

        const err = caught(() => studio.resolveOutDir(emptyDir));
        expect(err).toBeInstanceOf(CliError);
        const cliErr = err as CliError;
        expect(cliErr.message).toBe('No pzstudio project found.');
        expect(String(cliErr.cause)).toContain(emptyDir);
        expect(String(cliErr.tryHint)).toContain('pzstudio new');
    });

    it('throws the parse error for a corrupt project.json', () => {
        const proj = makeTempDir();
        fs.writeFileSync(path.join(proj, 'project.json'), '{ not json');
        const studio = createPzStudio();

        expect(String(caught(() => studio.resolveOutDir(proj)))).toContain(
            "Failed to parse 'project.json'",
        );
    });

    it('throws the validation error for an invalid project.json', () => {
        const proj = makeTempDir();
        fs.writeFileSync(
            path.join(proj, 'project.json'),
            JSON.stringify({ not: 'a project' }),
        );
        const studio = createPzStudio();

        expect(String(caught(() => studio.resolveOutDir(proj)))).toContain(
            'Validation failed for project.json',
        );
    });

    it('propagates a throwing settings provider', () => {
        const proj = makeProject('ProviderThrows');
        const studio = createPzStudio({
            settings: () => {
                throw new Error('provider boom');
            },
        });

        expect(String(caught(() => studio.resolveOutDir(proj)))).toContain(
            'provider boom',
        );
    });

    it('never consumes the legacy facade slots, even when every legacy setter is populated', () => {
        const proj = makeProject('LegacyBlind');
        const legacyProj = makeProject('LegacyAnchor', 'legacy-project-out');
        setProjectDir(legacyProj);
        setProjectRootAnchor(legacyProj);
        setVsCodeSettings({ outdir: 'C:/legacy-ws-out' });

        const spies = spyRawAccessors();
        const studio = createPzStudio({
            settings: () => ({ user: { outdir: 'C:/instance-out' } }),
        });

        // The instance provider's tier decides — not the anchored project's
        // own outdir tier, not the legacy settings slot.
        expect(studio.resolveOutDir(proj)).toBe(
            path.resolve('C:/instance-out'),
        );
        expect(spies.legacyLogger).not.toHaveBeenCalled();
        expect(spies.legacySettings).not.toHaveBeenCalled();
        expect(spies.legacyTransport).not.toHaveBeenCalled();
        expect(spies.externalDir).not.toHaveBeenCalled();
        expect(spies.legacyDiscoveryStart).not.toHaveBeenCalled();
    });

    it('repeated calls with unchanged settings return the same result (stateless, no hidden drift)', () => {
        const proj = makeProject('RepeatStable');
        const studio = createPzStudio({
            settings: () => ({ workspace: { outdir: 'C:/stable-out' } }),
        });

        expect(studio.resolveOutDir(proj)).toBe(path.resolve('C:/stable-out'));
        expect(studio.resolveOutDir(proj)).toBe(path.resolve('C:/stable-out'));
    });

    it('repeated calls observe changed settings immediately (no caching)', () => {
        const proj = makeProject('RepeatChanged');
        let userOut = 'C:/before-out';
        const studio = createPzStudio({
            settings: () => ({ user: { outdir: userOut } }),
        });

        expect(studio.resolveOutDir(proj)).toBe(path.resolve('C:/before-out'));
        userOut = 'C:/after-out';
        expect(studio.resolveOutDir(proj)).toBe(path.resolve('C:/after-out'));
    });

    it('re-reads the fixture: a project.json outdir edit between calls is picked up', () => {
        const proj = makeProject('EditBetweenCalls');
        const studio = createPzStudio({ settings: () => undefined });

        expect(studio.resolveOutDir(proj)).toBe(
            path.join(fakeHome(), 'Zomboid', 'Workshop'),
        );

        const raw = JSON.parse(
            fs.readFileSync(path.join(proj, 'project.json'), 'utf8'),
        ) as any;
        raw.outdir = 'edited-out';
        fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify(raw));

        expect(studio.resolveOutDir(proj)).toBe(path.join(proj, 'edited-out'));
    });

    it('resolves while an engine run parks inside the FIFO lock — never queues behind it', async () => {
        captureIO();
        const proj = makeProject('LockFreeReader');
        const studio = createPzStudio({
            settings: () => ({ user: { outdir: 'C:/reader-out' } }),
        });

        const events: string[] = [];
        let releaseA: () => void = () => {};
        const gateA = new Promise<void>((r) => {
            releaseA = r;
        });
        let pA: Promise<void> = Promise.resolve();
        let restore: () => void = () => {};

        try {
            pA = studio.run('list', [], { flags: ['--project', proj] });
            restore = withCommandRun('list', async () => {
                events.push('a:start');
                await gateA;
                events.push('a:end');
            });
            await vi.waitFor(() => expect(events).toContain('a:start'));

            // The engine lock is HELD by the parked run here: the reader is
            // synchronous and lock-free, so this call cannot queue behind it.
            expect(studio.resolveOutDir(proj)).toBe(
                path.resolve('C:/reader-out'),
            );

            // The reader neither released nor advanced the engine.
            expect(events).not.toContain('a:end');
        } finally {
            releaseA();
            restore();
            await pA.catch(() => {});
        }

        expect(events).toEqual(['a:start', 'a:end']);
    });
});
