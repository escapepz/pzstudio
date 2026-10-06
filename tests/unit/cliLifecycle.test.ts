import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';
import cliPackage from '../../packages/cli/package.json';

const spawnSyncCalls = vi.hoisted(
    () => [] as Array<{ command: string; args?: readonly string[] }>,
);

// Counting spy over the REAL spawnSync: the probe-timing regression tests
// below assert that invocations which need no template transport never
// probe git availability (pre-migration side-effect surface). Everything
// delegates to the original — no behavior is masked here.
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

// Importing the dispatcher registers every command into the registry.
import { runCLI } from '../../packages/cli/src/lib/cli';
import {
    setLogger,
    setVerbose,
    setQuiet,
    setDebug,
    rawInfo,
    rawWarn,
    rawVerbose,
} from '../../packages/cli/src/lib/logger';
import {
    CliUsageError,
    setCliIO,
    type CliIO,
} from '../../packages/cli/src/lib/parser';
import { CliError } from '../../packages/cli/src/lib/errors';
import {
    hasFlag,
    extractFlag,
    setInvocationOptions,
} from '../../packages/cli/src/lib/args';
import {
    setProjectDir,
    getExternalProjectDir,
    setProjectRootAnchor,
    legacyDiscoveryStart,
    findProjectDir,
    resolveModInfoTargets,
    setVsCodeSettings,
    getVsCodeSettings,
} from '../../packages/cli/src/lib/helper';
import {
    setTemplateTransport,
    legacyTransport,
    getTemplateTransport,
    FetchTransport,
    GitTransport,
} from '../../packages/cli/src/lib/transport';
import { getInteractionMode } from '../../packages/cli/src/lib/interaction';
import { getCommand } from '../../packages/cli/src/lib/registry';
import { getActiveInvocationContext } from '../../packages/cli/src/lib/invocation';

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

function makeProjectDir(): string {
    const dir = makeTempDir();
    fs.writeFileSync(
        path.join(dir, 'project.json'),
        JSON.stringify({
            workshop: { title: 'Test', visibility: 'public', tags: [] },
            mods: {},
            excludes: [],
        }),
    );
    return dir;
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

afterEach(() => {
    setLogger(undefined);
    setCliIO(undefined);
    setProjectDir(undefined);
    setProjectRootAnchor(undefined);
    setTemplateTransport(undefined);
    setInvocationOptions(undefined);
    setVsCodeSettings(undefined, undefined);
    setVerbose(false);
    setQuiet(false);
    setDebug(false);
    spawnSyncCalls.length = 0;
    for (const dir of tempDirs) deleteDir(dir);
    tempDirs = [];
});

/* ------------------------------------------------------------------ */
/* Logger/output capture across the banner/help/command/usage-error    */
/* paths (§17 commit 3: legacy logger-capture suite)                   */
/* ------------------------------------------------------------------ */

describe('legacy runCLI output capture (installed context routes to the same sinks)', () => {
    it('banner path: banner log, then help text, then exactly one trailing blank line', async () => {
        const { calls, logger } = recordingLogger();
        setLogger(logger);

        await runCLI(undefined, undefined, { flags: [] });

        const methods = calls.map((c) => c.method);
        expect(methods).toEqual(['log', 'log', 'log']);
        expect(String(calls[0].message)).toContain('Project Zomboid Studio v');
        expect(String(calls[1].message)).toContain('Available commands:');
        expect(calls[2].message).toBe('\n');
    });

    it('help command path: help text then exactly one trailing blank line', async () => {
        const { calls, logger } = recordingLogger();
        setLogger(logger);

        await runCLI('help');

        const methods = calls.map((c) => c.method);
        expect(methods).toEqual(['log', 'log']);
        expect(String(calls[0].message)).toContain('Available commands:');
        expect(calls[1].message).toBe('\n');
    });

    it('--help flag path: per-command help text then trailing blank line', async () => {
        const { calls, logger } = recordingLogger();
        setLogger(logger);

        await runCLI('list', [], { flags: ['--help'] });

        const methods = calls.map((c) => c.method);
        expect(methods).toEqual(['log', 'log']);
        expect(String(calls[0].message)).toContain('pzstudio list');
        expect(calls[1].message).toBe('\n');
    });

    it('normal command path: pre-command blank line, command output, completion info, trailing blank line', async () => {
        const projA = makeProjectDir();
        const { calls, logger } = recordingLogger();
        setLogger(logger);

        await runCLI('list', [], { flags: ['--project', projA] });

        const methods = calls.map((c) => c.method);
        expect(methods).toEqual(['log', 'log', 'info', 'log']);
        expect(calls[0].message).toBe('\n');
        expect(String(calls[1].message)).toContain(
            "No mods in project 'Test'.",
        );
        expect(String(calls[2].message)).toContain('Command [list] completed.');
        expect(calls[3].message).toBe('\n');
    });

    it('usage-error path: one error report, rethrown, no trailing blank line', async () => {
        const { calls, logger } = recordingLogger();
        setLogger(logger);

        await expect(
            runCLI('build', [], { flags: ['--wat'] }),
        ).rejects.toBeInstanceOf(CliUsageError);

        expect(calls.map((c) => c.method)).toEqual(['error']);
        expect(calls[0].message).toBeInstanceOf(CliUsageError);
        expect(String(calls[0].message.message)).toContain(
            "Unknown option '--wat'",
        );
    });

    it('throwing-command path: pre-command blank line emitted, error report, no trailing blank line', async () => {
        const emptyDir = makeTempDir();
        const { calls, logger } = recordingLogger();
        setLogger(logger);

        await expect(
            runCLI('list', [], { flags: ['--project', emptyDir] }),
        ).rejects.toBeInstanceOf(CliError);

        const methods = calls.map((c) => c.method);
        expect(methods).toEqual(['log', 'error']);
        expect(calls[0].message).toBe('\n');
        expect(String(calls[1].message)).toContain(
            'No pzstudio project found.',
        );
    });
});

/* ------------------------------------------------------------------ */
/* Legacy post-run state suite (§13.1 write-through rows)              */
/* ------------------------------------------------------------------ */

describe('legacy runCLI post-run state (§13.1 write-through)', () => {
    it('projectRootAnchor: set from --project and persists; cleared by a run without --project', async () => {
        captureIO();
        const projA = makeProjectDir();

        await runCLI('help', [], { flags: ['--project', projA] });

        expect(legacyDiscoveryStart()).toBe(path.resolve(projA));
        // Observable §13.1: a subsequent default-arg discovery walks from
        // the persisted anchor...
        expect(findProjectDir()).toBe(path.resolve(projA));
        // ...and resolveModInfoTargets' implicit default resolves from A.
        fs.mkdirSync(path.join(projA, 'modA', 'branch', 'media'), {
            recursive: true,
        });
        expect(resolveModInfoTargets('modA')).toEqual([
            path.join(projA, 'modA', 'branch'),
        ]);

        await runCLI('help');

        expect(legacyDiscoveryStart()).toBeUndefined();
    });

    it('verbosity: --verbose persists (published verbose emits post-run), --debug implies verbose', async () => {
        const captured = captureIO();

        await runCLI('help', [], { flags: ['--verbose'] });

        rawVerbose('post-run-verbose');
        expect(captured.stderr.join('')).toContain('[DEBUG] post-run-verbose');

        await runCLI('help', [], { flags: ['--debug'] });

        rawVerbose('post-run-debug-verbose');
        expect(captured.stderr.join('')).toContain(
            '[DEBUG] post-run-debug-verbose',
        );
    });

    it('quiet: --quiet persists (published info suppressed post-run, warnings still print)', async () => {
        const captured = captureIO();

        await runCLI('help', [], { flags: ['--quiet'] });

        rawInfo('post-run-info');
        rawWarn('post-run-warn');
        const stderr = captured.stderr.join('');
        expect(stderr).not.toContain('post-run-info');
        expect(stderr).toContain('post-run-warn');
    });

    it('--transport is sticky: applies in-run, persists post-run, survives a later run without the flag', async () => {
        captureIO();
        let duringRun: unknown;
        const restore = withCommandRun('list', async () => {
            duringRun = getTemplateTransport();
        });

        try {
            await runCLI('list', [], { flags: ['--transport', 'fetch'] });
        } finally {
            restore();
        }

        expect(duringRun).toBeInstanceOf(FetchTransport);
        expect(legacyTransport()).toBeInstanceOf(FetchTransport);

        await runCLI('help');

        expect(legacyTransport()).toBeInstanceOf(FetchTransport);
        expect(getTemplateTransport()).toBeInstanceOf(FetchTransport);
    });

    it('--transport git selects the git transport for the invocation', async () => {
        captureIO();
        let duringRun: unknown;
        const restore = withCommandRun('list', async () => {
            duringRun = getTemplateTransport();
        });

        try {
            await runCLI('list', [], { flags: ['--transport', 'git'] });
        } finally {
            restore();
        }

        expect(duringRun).toBeInstanceOf(GitTransport);
    });

    it('currentInvocationOptions: net-zero post-run, cleared even when the command throws', async () => {
        captureIO();
        const projA = makeProjectDir();

        await runCLI('list', [], { flags: ['--project', projA, '--verbose'] });

        expect(hasFlag('verbose')).toBe(false);
        expect(hasFlag('project')).toBe(false);
        expect(extractFlag('project')).toBeUndefined();

        const emptyDir = makeTempDir();
        await expect(
            runCLI('list', [], { flags: ['--project', emptyDir, '--verbose'] }),
        ).rejects.toBeInstanceOf(CliError);

        expect(hasFlag('verbose')).toBe(false);
        expect(hasFlag('project')).toBe(false);
    });

    it('interactionMode: written through per run and persists post-run', async () => {
        captureIO();
        await runCLI('help');

        expect(getInteractionMode()).toBe('embedded');
    });

    it('externalProjectDir: never written by runCLI, but discovery composes from it', async () => {
        captureIO();
        const projA = makeProjectDir();
        setProjectDir(projA);

        // No --project flag: discovery must start from the externally
        // anchored dir (the §8 legacy tier between the parsed flag and cwd).
        await runCLI('list');

        expect(getExternalProjectDir()).toBe(projA);

        await runCLI('help', [], { flags: ['--project', projA] });

        // --project writes the anchor slot (§13.1) but never the external dir.
        expect(getExternalProjectDir()).toBe(projA);
        expect(legacyDiscoveryStart()).toBe(path.resolve(projA));
    });

    it('externalProjectDir: runCLI does not newly write it on anchor/verbosity paths', async () => {
        captureIO();
        await runCLI('help', [], { flags: ['--verbose'] });

        expect(getExternalProjectDir()).toBeUndefined();
    });

    it('host settings: the legacy facade slots are snapshotted into the context (readers see the same merge)', async () => {
        captureIO();
        let duringRun: ReturnType<typeof getVsCodeSettings>;
        const restore = withCommandRun('list', async () => {
            duringRun = getVsCodeSettings();
        });
        setVsCodeSettings(
            { outdir: 'C:/workspace-out' },
            { outdir: 'C:/user-out', useSymlinks: true },
        );

        try {
            const projA = makeProjectDir();
            await runCLI('list', [], { flags: ['--project', projA] });
        } finally {
            restore();
        }

        expect(duringRun!).toEqual({
            templates: undefined,
            outdir: 'C:/workspace-out',
            useSymlinks: true,
        });
    });

    it('host settings: empty legacy slots leave the invocation without a host layer', async () => {
        captureIO();
        let duringRun: ReturnType<typeof getVsCodeSettings>;
        const restore = withCommandRun('list', async () => {
            duringRun = getVsCodeSettings();
        });

        try {
            const projA = makeProjectDir();
            await runCLI('list', [], { flags: ['--project', projA] });
        } finally {
            restore();
        }

        expect(duringRun).toEqual({
            templates: undefined,
            outdir: undefined,
            useSymlinks: undefined,
        });
    });
});

/* ------------------------------------------------------------------ */
/* Engine lock: overlapping legacy runCLI calls serialize FIFO         */
/* (§9 classified intentional change) — and no deadlock / no leaked    */
/* context on any failure path.                                        */
/* ------------------------------------------------------------------ */

describe('legacy runCLI engine lock', () => {
    it('two overlapping runCLI calls serialize FIFO instead of racing', async () => {
        captureIO();
        const events: string[] = [];
        let releaseA: () => void = () => {};
        const gateA = new Promise<void>((r) => {
            releaseA = r;
        });
        let pA: Promise<void> = Promise.resolve();
        let pB: Promise<void> = Promise.resolve();
        let restore: () => void = () => {};

        try {
            pA = runCLI('list', [], { flags: [] });
            pB = runCLI('list', [], { flags: [] });

            // A dispatches first (FIFO) and parks inside its command run.
            restore = withCommandRun('list', async () => {
                events.push('a:start');
                await gateA;
                events.push('a:end');
            });
            await vi.waitFor(() => expect(events).toContain('a:start'));

            // B is queued behind the lock: swapping the command run now can
            // only be observed by B, which has not started.
            restore();
            restore = withCommandRun('list', async () => {
                events.push('b:start');
                events.push('b:end');
            });

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

        // The lock is released and no ambient context remains.
        expect(getActiveInvocationContext()).toBeUndefined();
        // A later invocation still runs — the FIFO chain is not stalled.
        await expect(runCLI('help')).resolves.toBeUndefined();
    });

    it('failure paths release the lock and leave no context installed', async () => {
        captureIO();
        const emptyDir = makeTempDir();

        await expect(
            runCLI('list', [], { flags: ['--project', emptyDir] }),
        ).rejects.toBeInstanceOf(CliError);
        expect(getActiveInvocationContext()).toBeUndefined();

        await expect(
            runCLI('build', [], { flags: ['--wat'] }),
        ).rejects.toBeInstanceOf(CliUsageError);
        expect(getActiveInvocationContext()).toBeUndefined();

        // Sequential invocations still work after both failures.
        await expect(runCLI('help')).resolves.toBeUndefined();
        expect(getActiveInvocationContext()).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* Host-default transport probe timing: the composition must not       */
/* acquire a new eager git-availability probe (spawnSync) and no new   */
/* pre-lifecycle failure path — the probe belongs to first template    */
/* use, exactly as before the engine migration.                        */
/* ------------------------------------------------------------------ */

describe('host-default transport probe timing', () => {
    it('does not probe git on invocations that need no template transport', async () => {
        captureIO();
        const projA = makeProjectDir();
        spawnSyncCalls.length = 0;

        await runCLI(undefined, undefined, { flags: [] }); // banner + help
        await runCLI('help'); // help command
        await expect(
            runCLI('build', [], { flags: ['--wat'] }),
        ).rejects.toBeInstanceOf(CliUsageError); // usage error
        await runCLI('list', [], {
            flags: ['--project', projA],
        }); // non-template command

        expect(spawnSyncCalls).toEqual([]);
    });

    it('does not probe git on the --version terminal path', async () => {
        const captured = captureIO();
        const originalArgv = process.argv;
        process.argv = ['node', 'pzstudio', '--version'];
        spawnSyncCalls.length = 0;
        try {
            await runCLI();
        } finally {
            process.argv = originalArgv;
        }

        expect(spawnSyncCalls).toEqual([]);
        // Terminal control flow: version line only — no banner, no help,
        // no trailing blank line.
        expect(captured.stdout.join('')).toContain(`v${cliPackage.version}`);
        expect(captured.stdout.join('')).not.toContain(
            'Project Zomboid Studio',
        );
        expect(captured.stderr.join('')).toBe('');
    });

    it('host-default transport defers the probe from acquisition to actual use', async () => {
        setTemplateTransport(undefined);
        spawnSyncCalls.length = 0;

        const transport = getTemplateTransport();
        expect(spawnSyncCalls).toEqual([]);

        const name = transport.name;
        expect(spawnSyncCalls).toHaveLength(1);
        expect(spawnSyncCalls[0].command).toBe('git');
        expect(spawnSyncCalls[0].args).toEqual(['--version']);
        expect(['git', 'fetch']).toContain(name);
    });

    it('repeated host-default acquisitions and uses resolve freshly (no cached selection)', async () => {
        setTemplateTransport(undefined);
        spawnSyncCalls.length = 0;

        const first = getTemplateTransport();
        const second = getTemplateTransport();
        expect(spawnSyncCalls).toEqual([]); // two acquisitions, zero probes

        expect(['git', 'fetch']).toContain(first.name); // use → fresh probe
        expect(['git', 'fetch']).toContain(second.name); // use → fresh probe
        expect(spawnSyncCalls).toHaveLength(2);

        // Both transport kinds report an empty cache dir as invalid, so the
        // assertion is host-capability independent — the point is the probe.
        expect(first.isCacheValid(path.join('does', 'not', 'exist'))).toBe(
            false,
        );
        expect(spawnSyncCalls).toHaveLength(3); // every use re-resolves
    });

    it('in-run host-default uses resolve freshly per use through the shared context wrapper', async () => {
        captureIO();
        const names: string[] = [];
        const restore = withCommandRun('list', async () => {
            names.push(getTemplateTransport().name);
            names.push(getTemplateTransport().name);
        });
        spawnSyncCalls.length = 0;
        try {
            await runCLI('list', [], { flags: [] });
        } finally {
            restore();
        }

        expect(names).toHaveLength(2);
        expect(names.every((n) => n === 'git' || n === 'fetch')).toBe(true);
        // One wrapper shared on the invocation context, but two uses resolve
        // twice — pre-migration, two getTemplateTransport() requests probed
        // twice; nothing may cache the host-capability decision in Stage A.
        expect(spawnSyncCalls).toHaveLength(2);
    });
});
