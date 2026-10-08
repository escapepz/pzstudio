import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';

/**
 * Commit 12 acceptance (doc 11 §16 "Published logger raw routing",
 * §8.0 R1, §12): the published `log/info/warn/verbose` wrappers are
 * RAW-legacy — they route by the legacy slots (externalLogger + the
 * persisted verbose/quiet/debug flags) and NEVER consult the active v2
 * invocation context, in either direction:
 *
 *   - while a v2 run is active, published calls land in the legacy slot
 *     (or the raw stdout/stderr sink) only — the instance logger A of the
 *     active run receives none of them;
 *   - the wrappers' quiet/verbose gating follows the PERSISTED legacy
 *     flags — an active v2 invocation's own --quiet/--verbose must not
 *     replace them, in both directions.
 */

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
    rawWarn,
    rawVerbose,
} from '../../packages/cli/src/lib/logger';
import { setCliIO, type CliIO } from '../../packages/cli/src/lib/parser';
import {
    setProjectDir,
    setProjectRootAnchor,
    setVsCodeSettings,
} from '../../packages/cli/src/lib/helper';
import { setTemplateTransport } from '../../packages/cli/src/lib/transport';
import { setInvocationOptions } from '../../packages/cli/src/lib/args';
import { setInteractionMode } from '../../packages/cli/src/lib/interaction';
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

function loggerText(rec: { calls: LogCall[] }): string {
    return rec.calls.map((c) => String(c.message)).join('\n');
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

/**
 * Parks a v2 `list` run inside its command body (engine lock held, ambient
 * installed) and returns the release handle. Always release in a finally.
 */
async function parkV2Run(
    studio: ReturnType<typeof createPzStudio>,
    proj: string,
    flags: string[] = [],
): Promise<{
    release: () => void;
    restore: () => void;
    parked: Promise<void>;
}> {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
        release = r;
    });
    const parked = studio.run('list', [], {
        flags: ['--project', proj, ...flags],
    });
    const restore = withCommandRun('list', async () => {
        await gate;
    });
    await vi.waitFor(() => expect(getActiveInvocationContext()).toBeDefined());
    return { release, restore, parked };
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
    for (const dir of tempDirs) deleteDir(dir);
    tempDirs = [];
});

/* ------------------------------------------------------------------ */
/* 1. Published wrappers route to the legacy slot while a v2 run is    */
/*    active — the active instance logger receives none of them.       */
/* ------------------------------------------------------------------ */

describe('published logger raw routing beside an active v2 run', () => {
    it('log/info/warn/verbose route to the legacy slot only; the v2 instance logger A receives none', async () => {
        captureIO();
        const projV2 = makeProjectDir('PubV2');
        const A = recordingLogger();
        const B = recordingLogger();
        setLogger(B.logger);
        // Persisted legacy flag so the published verbose passes its gate.
        setVerbose(true);

        const studio = createPzStudio({ projectDir: projV2, logger: A.logger });
        const frame = await parkV2Run(studio, projV2);
        try {
            // The ambient context IS installed — the raw wrappers ignore it.
            expect(getActiveInvocationContext()).toBeDefined();

            const bBefore = B.calls.length;
            const aBefore = A.calls.length;

            rawLog('raw-log-line');
            rawInfo('raw-info-line');
            rawWarn('raw-warn-line');
            rawVerbose('raw-verbose-line');

            // Every published call landed in the legacy slot, in order,
            // exactly once — and nothing else.
            expect(B.calls.slice(bBefore)).toEqual([
                { method: 'log', message: 'raw-log-line' },
                { method: 'info', message: 'raw-info-line' },
                { method: 'warn', message: 'raw-warn-line' },
                { method: 'verbose', message: 'raw-verbose-line' },
            ]);

            // The active v2 run's logger received NONE of them.
            expect(A.calls.length).toBe(aBefore);
        } finally {
            frame.release();
            frame.restore();
            await frame.parked.catch(() => {});
        }
        expect(getActiveInvocationContext()).toBeUndefined();

        // After release the direction still holds: A carries only its own
        // run's engine-tier emissions (the swapped body skips the list
        // output; the completion info is the positive A-side proof), never
        // the raw lines; B never saw anything from the v2 run.
        expect(loggerText(A)).toContain('Command [list] completed.');
        expect(loggerText(A)).not.toContain('raw-log-line');
        expect(loggerText(A)).not.toContain('raw-info-line');
        expect(loggerText(B)).not.toContain('Command [list] completed.');
    });

    it('without an external logger the published calls take the raw stdout/stderr sink beside an active v2 run', async () => {
        const captured = captureIO();
        const projV2 = makeProjectDir('PubV2Raw');
        const A = recordingLogger();

        setVerbose(true); // persisted legacy flag: published verbose emits

        const studio = createPzStudio({ projectDir: projV2, logger: A.logger });
        const frame = await parkV2Run(studio, projV2);
        const aBefore = A.calls.length; // pre-command blank line already landed
        try {
            expect(getActiveInvocationContext()).toBeDefined();

            rawLog('raw-sink-log');
            rawInfo('raw-sink-info');
            rawWarn('raw-sink-warn');
            rawVerbose('raw-sink-verbose');

            // Raw tier presentation: log → stdout, info/warn/verbose →
            // stderr, with the historical prefixes (NOT the instance logger,
            // NOT silenced by the v2 context).
            expect(captured.stdout.join('')).toContain('raw-sink-log');
            expect(captured.stderr.join('')).toContain('[INFO] raw-sink-info');
            expect(captured.stderr.join('')).toContain('[WARN] raw-sink-warn');
            expect(captured.stderr.join('')).toContain(
                '[DEBUG] raw-sink-verbose',
            );
            expect(A.calls.length).toBe(aBefore);
        } finally {
            frame.release();
            frame.restore();
            await frame.parked.catch(() => {});
        }
    });
});

/* ------------------------------------------------------------------ */
/* 2. Persisted legacy flags gate the published wrappers; active v2    */
/*    invocation flags never replace them (both directions).           */
/* ------------------------------------------------------------------ */

describe('published wrapper gating follows the persisted legacy flags, never the v2 invocation flags', () => {
    it('after a legacy --quiet run, published info stays suppressed during a v2 --verbose run (and verbose stays gated)', async () => {
        const captured = captureIO();

        // Legacy run persists quietEnabled=true.
        await runCLI('help', [], { flags: ['--quiet'] });
        // Legacy gate check with the default sink.
        rawInfo('pre-v2-gated-info');
        expect(captured.stderr.join('')).not.toContain('pre-v2-gated-info');

        // A v2 run WITH --verbose: its own ctx.verbose/quiet must not touch
        // the persisted legacy gate.
        const projV2 = makeProjectDir('GateV2');
        const studio = createPzStudio({ projectDir: projV2 });
        const frame = await parkV2Run(studio, projV2, ['--verbose']);
        try {
            rawInfo('during-v2-quiet-info');
            rawVerbose('during-v2-verbose-gate');
        } finally {
            frame.release();
            frame.restore();
            await frame.parked.catch(() => {});
        }

        expect(captured.stderr.join('')).not.toContain('during-v2-quiet-info');
        expect(captured.stderr.join('')).not.toContain(
            'during-v2-verbose-gate',
        );
        // The v2 run itself was NOT silenced by the legacy quiet flag — its
        // completion info printed through the engine tier.
        expect(captured.stderr.join('')).toContain(
            '[INFO] Command [list] completed.',
        );
    });

    it('after a legacy --verbose run, published verbose still emits during a v2 --quiet run', async () => {
        const captured = captureIO();

        // Legacy run persists verboseEnabled=true.
        await runCLI('help', [], { flags: ['--verbose'] });
        rawVerbose('pre-v2-verbose-emits');
        expect(captured.stderr.join('')).toContain(
            '[DEBUG] pre-v2-verbose-emits',
        );

        // A v2 run WITH --quiet: the published wrapper does not inherit the
        // v2 context quiet gate.
        const projV2 = makeProjectDir('GateV2B');
        const studio = createPzStudio({ projectDir: projV2 });
        const frame = await parkV2Run(studio, projV2, ['--quiet']);
        try {
            rawVerbose('during-v2-quiet-verbose');
            rawWarn('during-v2-quiet-warn');
        } finally {
            frame.release();
            frame.restore();
            await frame.parked.catch(() => {});
        }

        expect(captured.stderr.join('')).toContain(
            '[DEBUG] during-v2-quiet-verbose',
        );
        expect(captured.stderr.join('')).toContain(
            '[WARN] during-v2-quiet-warn',
        );
    });

    it('the last legacy run decides the post-run published gating (v2 runs left it untouched)', async () => {
        const captured = captureIO();
        const projV2 = makeProjectDir('GateV2C');

        // Legacy --quiet persists, then TWO v2 runs with --verbose in
        // between: the persisted gate must survive them.
        await runCLI('help', [], { flags: ['--quiet'] });
        const studio = createPzStudio({ projectDir: projV2 });
        const frame = await parkV2Run(studio, projV2, ['--verbose']);
        frame.release();
        frame.restore();
        await frame.parked.catch(() => {});
        await studio.run('help', [], { flags: ['--verbose'] });

        rawInfo('post-v2-still-quiet');
        expect(captured.stderr.join('')).not.toContain('post-v2-still-quiet');

        // A fresh legacy --verbose run flips the persisted gate (write-through).
        await runCLI('help', [], { flags: ['--verbose'] });
        rawInfo('after-legacy-verbose-info');
        expect(captured.stderr.join('')).toContain(
            '[INFO] after-legacy-verbose-info',
        );
    });
});
