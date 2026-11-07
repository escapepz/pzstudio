import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';
import type { TemplateTransport } from '@pzstudio/platform';

/**
 * Commit 12 acceptance (doc 11 §16, §17 commit 12): two-instance isolation
 * and the process-wide FIFO engine lock.
 *
 * The existing suites pin one-instance-at-a-time behavior; this file proves
 * the §16 rows that need TWO independent instances in one process:
 *
 *   - sequential runs in both orders (A→B and B→A): each instance resolves
 *     its own project, logs to its own logger, and its own settings decide
 *     its own outdir;
 *   - overlapping runs: serialized by the engine lock (no interleave), each
 *     run receiving its own project/logger/settings — proven with deferred
 *     promises and explicit ordering events, never sleeps.
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
} from '../../packages/cli/src/lib/logger';
import { setCliIO, type CliIO } from '../../packages/cli/src/lib/parser';
import {
    setProjectDir,
    setProjectRootAnchor,
    setVsCodeSettings,
    getVsCodeSettings,
    discoveryStartDir,
} from '../../packages/cli/src/lib/helper';
import { setTemplateTransport } from '../../packages/cli/src/lib/transport';
import { setInvocationOptions } from '../../packages/cli/src/lib/args';
import { setInteractionMode } from '../../packages/cli/src/lib/interaction';
import { getCommand } from '../../packages/cli/src/lib/registry';
import { getActiveInvocationContext } from '../../packages/cli/src/lib/invocation';
import type { PzStudioHostSettings } from '../../packages/cli/src/lib/invocation';

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
/* 1. Sequential two-instance isolation — both orders                  */
/* ------------------------------------------------------------------ */

describe('two instances: sequential isolation (both orders)', () => {
    let outA: string;
    let outB: string;

    beforeEach(() => {
        outA = makeTempDir();
        outB = makeTempDir();
    });

    /**
     * One fully distinct instance config: own project, own logger, own
     * settings layer, own transport. The `list` output names the resolved
     * project title, so the captured `No mods in project '<title>'.` line
     * proves which project that instance resolved.
     */
    function makeSide(sideName: 'A' | 'B', title: string, outdir: string) {
        const proj = makeProjectDir(title);
        const rec = recordingLogger();
        const transport = sentinelTransport(sideName === 'A' ? 'git' : 'fetch');
        const providerCalls: any[] = [];
        const studio = createPzStudio({
            projectDir: proj,
            logger: rec.logger,
            settings: (ctx) => {
                providerCalls.push(ctx);
                return { workspace: { outdir } };
            },
            templateTransport: transport,
        });
        return { title, proj, rec, providerCalls, studio };
    }

    it('order A → B: each run resolves its own project, logger and settings', async () => {
        const A = makeSide('A', 'AlphaSide', outA);
        const B = makeSide('B', 'BetaSide', outB);

        await A.studio.run('list');
        await B.studio.run('list');

        // Project identity: each logger line names its own project only.
        expect(loggerText(A.rec)).toContain("No mods in project 'AlphaSide'.");
        expect(loggerText(B.rec)).toContain("No mods in project 'BetaSide'.");
        expect(loggerText(A.rec)).not.toContain('BetaSide');
        expect(loggerText(B.rec)).not.toContain('AlphaSide');

        // Settings isolation: each provider was called exactly once, with
        // its own factory project as the effective-project context.
        expect(A.providerCalls).toEqual([{ projectDir: A.proj }]);
        expect(B.providerCalls).toEqual([{ projectDir: B.proj }]);
    });

    it('order B → A: the same isolation holds with the runs swapped', async () => {
        const A = makeSide('A', 'AlphaSide', outA);
        const B = makeSide('B', 'BetaSide', outB);

        await B.studio.run('list');
        await A.studio.run('list');

        expect(loggerText(A.rec)).toContain("No mods in project 'AlphaSide'.");
        expect(loggerText(B.rec)).toContain("No mods in project 'BetaSide'.");
        expect(A.providerCalls).toEqual([{ projectDir: A.proj }]);
        expect(B.providerCalls).toEqual([{ projectDir: B.proj }]);
    });
});

/* ------------------------------------------------------------------ */
/* 2. Two instances, overlapping runs: FIFO serialization + full       */
/*    per-instance isolation under overlap                             */
/* ------------------------------------------------------------------ */

describe('two instances: overlapping runs under the process-wide engine lock', () => {
    it('A parks inside its run; B queues FIFO, then runs with its own project/logger/settings', async () => {
        captureIO();
        const projA = makeProjectDir('InstA');
        const projB = makeProjectDir('InstB');
        const outA = makeTempDir();
        const outB = makeTempDir();
        const loggerA = recordingLogger();
        const loggerB = recordingLogger();
        const transportA = sentinelTransport('fetch');
        const transportB = sentinelTransport('git');

        // Distinct settings fingerprints: A's workspace outdir layer must
        // never reach B's run and vice versa.
        const providerA = vi.fn(() => ({ workspace: { outdir: outA } }));
        const providerB = vi.fn(() => ({ workspace: { outdir: outB } }));

        const studioA = createPzStudio({
            projectDir: projA,
            logger: loggerA.logger,
            settings: providerA,
            templateTransport: transportA,
        });
        const studioB = createPzStudio({
            projectDir: projB,
            logger: loggerB.logger,
            settings: providerB,
            templateTransport: transportB,
        });

        const events: string[] = [];
        let releaseA: () => void = () => {};
        const gateA = new Promise<void>((r) => {
            releaseA = r;
        });
        let pA: Promise<void> = Promise.resolve();
        let pB: Promise<void> = Promise.resolve();
        let restore: () => void = () => {};
        let duringA: ReturnType<typeof getVsCodeSettings> | undefined;
        let duringB: ReturnType<typeof getVsCodeSettings> | undefined;
        const startDirs: { a?: string; b?: string } = {};

        try {
            pA = studioA.run('list');

            // A dispatches first (FIFO) and parks inside its command run;
            // its effective settings snapshot and discovery start are
            // captured while parked.
            restore = withCommandRun('list', async () => {
                events.push('a:start');
                duringA = getVsCodeSettings();
                startDirs.a = discoveryStartDir();
                await gateA;
                events.push('a:end');
            });
            await vi.waitFor(() => expect(events).toContain('a:start'));

            // B is requested while A still holds the lock. Swapping the
            // command body now can only be observed by B: A is already past
            // dispatch (it is parked), B has not started.
            restore();
            restore = withCommandRun('list', async () => {
                events.push('b:start');
                duringB = getVsCodeSettings();
                startDirs.b = discoveryStartDir();
                events.push('b:end');
            });
            pB = studioB.run('list');

            releaseA();
            await Promise.all([pA, pB]);

            // FIFO: A's whole execution precedes B's — no interleave.
            expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
        } finally {
            releaseA();
            restore();
            await Promise.allSettled([pA, pB]);
        }

        // Per-instance settings: A's run saw A's workspace layer (its
        // provider), B's run saw B's — never swapped.
        expect(providerA).toHaveBeenCalledTimes(1);
        expect(providerA).toHaveBeenCalledWith({ projectDir: projA });
        expect(providerB).toHaveBeenCalledWith({ projectDir: projB });
        expect(duringA).toEqual({
            templates: undefined,
            outdir: outA,
            useSymlinks: undefined,
        });
        expect(duringB).toEqual({
            templates: undefined,
            outdir: outB,
            useSymlinks: undefined,
        });

        // Project identity under overlap: each run's discovery start was
        // its own instance's factory project — never the other's project.
        expect(startDirs.a).toBe(projA);
        expect(startDirs.b).toBe(projB);

        // Logger isolation in both directions: each instance's logger
        expect(loggerText(loggerA)).not.toContain('InstB');
        expect(loggerText(loggerB)).not.toContain('InstA');
        expect(loggerA.calls.some((c) => c.method === 'info')).toBe(true);
        expect(loggerB.calls.some((c) => c.method === 'info')).toBe(true);

        // Both runs completed through the shared lock; no ambient left.
        expect(getActiveInvocationContext()).toBeUndefined();
    });

    it('B → A order: the second-queued instance equally parks until the first releases', async () => {
        captureIO();
        const projA = makeProjectDir('OrderA');
        const projB = makeProjectDir('OrderB');
        const loggerA = recordingLogger();
        const loggerB = recordingLogger();
        const studioA = createPzStudio({
            projectDir: projA,
            logger: loggerA.logger,
        });
        const studioB = createPzStudio({
            projectDir: projB,
            logger: loggerB.logger,
        });

        const events: string[] = [];
        let releaseB: () => void = () => {};
        const gateB = new Promise<void>((r) => {
            releaseB = r;
        });
        let pA: Promise<void> = Promise.resolve();
        let pB: Promise<void> = Promise.resolve();
        let restore: () => void = () => {};
        const startDirs: { a?: string; b?: string } = {};

        try {
            pB = studioB.run('list');

            // B dispatches first (FIFO) and parks.
            restore = withCommandRun('list', async () => {
                events.push('b:start');
                startDirs.b = discoveryStartDir();
                await gateB;
                events.push('b:end');
            });
            await vi.waitFor(() => expect(events).toContain('b:start'));

            // A is queued behind B: swapping the command body now can only
            // be observed by A, which has not started.
            restore();
            restore = withCommandRun('list', async () => {
                events.push('a:start');
                events.push('a:end');
            });
            pA = studioA.run('list');

            releaseB();
            await Promise.all([pA, pB]);

            expect(events).toEqual(['b:start', 'b:end', 'a:start', 'a:end']);
        } finally {
            releaseB();
            restore();
            await Promise.allSettled([pA, pB]);
        }

        // Each logger saw exactly its own run's emissions.
        expect(loggerText(loggerA)).not.toContain('OrderB');
        expect(loggerText(loggerB)).not.toContain('OrderA');
        expect(loggerA.calls.some((c) => c.method === 'info')).toBe(true);
        expect(loggerB.calls.some((c) => c.method === 'info')).toBe(true);
        expect(getActiveInvocationContext()).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* 3. Settings freshness across instances: a changed provider return    */
/*    applies to the NEXT run (§16 parity row) — pinned per instance.   */
/* ------------------------------------------------------------------ */

describe('two instances: a changed provider return affects only its own next run', () => {
    it('A flips its outdir layer between runs; B is unaffected throughout', async () => {
        captureIO();
        const projA = makeProjectDir('FreshA');
        const projB = makeProjectDir('FreshB');
        const outA1 = makeTempDir();
        const outA2 = makeTempDir();
        const outB = makeTempDir();
        const loggerA = recordingLogger();
        const loggerB = recordingLogger();

        let restore: () => void = () => {};
        let layersA: any = { workspace: { outdir: outA1 } };
        const studioA = createPzStudio({
            projectDir: projA,
            logger: loggerA.logger,
            settings: () => layersA,
        });
        const studioB = createPzStudio({
            projectDir: projB,
            logger: loggerB.logger,
            settings: () => ({ workspace: { outdir: outB } }),
        });

        try {
            await studioA.run('list');
            // A's first run resolved outA1's layer...
            expect(loggerText(loggerA)).toContain(
                "No mods in project 'FreshA'.",
            );

            // ...the provider return changes → the next A run observes it.
            layersA = { workspace: { outdir: outA2 } };
            let saw: ReturnType<typeof getVsCodeSettings> | undefined;
            restore = withCommandRun('list', async () => {
                saw = getVsCodeSettings();
            });
            try {
                await studioA.run('list');
            } finally {
                restore();
            }
            expect(saw).toEqual({
                templates: undefined,
                outdir: outA2,
                useSymlinks: undefined,
            });

            // B is untouched by A's change: its own layer still decides.
            await studioB.run('list');
            expect(loggerText(loggerB)).toContain(
                "No mods in project 'FreshB'.",
            );
        } finally {
            restore();
        }
    });
});

/* ------------------------------------------------------------------ */
/* 4. resolveOutDir instance isolation (doc 13 §10-A row 5): Studio A  */
/*    → settings A → outdir A, Studio B → settings B → outdir B,      */
/*    resolved interleaved — each only ever through its own provider  */
/*    and logger.                                                     */
/* ------------------------------------------------------------------ */

describe('two instances: resolveOutDir isolation (doc 13 §10-A row 5)', () => {
    it('interleaved resolves: each instance resolves only through its own provider, logs only through its own logger, and stays fresh', () => {
        const projA = makeProjectDir('IsolateA');
        const projB = makeProjectDir('IsolateB');
        const outA = makeTempDir();
        const outB = makeTempDir();
        const loggerA = recordingLogger();
        const loggerB = recordingLogger();

        let layersB: PzStudioHostSettings | undefined = {
            workspace: { outdir: outB },
        };
        const providerA = vi.fn(() => ({ workspace: { outdir: outA } }));
        const providerB = vi.fn(() => layersB);

        const studioA = createPzStudio({
            logger: loggerA.logger,
            settings: providerA,
        });
        const studioB = createPzStudio({
            logger: loggerB.logger,
            settings: providerB,
        });

        // Interleaved resolves across both instances and both projects.
        expect(studioA.resolveOutDir(projA)).toBe(path.resolve(outA));
        expect(studioB.resolveOutDir(projB)).toBe(path.resolve(outB));
        // Resolving the OTHER instance's project still goes through the
        // calling instance's own provider: A never receives B's settings
        // and B never receives A's.
        expect(studioA.resolveOutDir(projB)).toBe(path.resolve(outA));
        expect(studioB.resolveOutDir(projA)).toBe(path.resolve(outB));
        expect(studioA.resolveOutDir(projA)).toBe(path.resolve(outA));

        // Each provider received exactly the requested explicit projectDir,
        // once per resolve, never the other instance's context.
        expect(providerA).toHaveBeenCalledTimes(3);
        expect(providerA).toHaveBeenNthCalledWith(1, { projectDir: projA });
        expect(providerA).toHaveBeenNthCalledWith(2, { projectDir: projB });
        expect(providerA).toHaveBeenNthCalledWith(3, { projectDir: projA });
        expect(providerB).toHaveBeenCalledTimes(2);
        expect(providerB).toHaveBeenNthCalledWith(1, { projectDir: projB });
        expect(providerB).toHaveBeenNthCalledWith(2, { projectDir: projA });

        // Logger isolation with asymmetric counts: every resolve emits the
        // global-config verbose through the calling instance's logger — a
        // cross-wired or shared sink cannot produce 3 vs 2.
        const configReads = (rec: { calls: LogCall[] }) =>
            rec.calls.filter(
                (c) =>
                    c.method === 'verbose' &&
                    String(c.message).includes('Reading global config from:'),
            );
        expect(configReads(loggerA)).toHaveLength(3);
        expect(configReads(loggerB)).toHaveLength(2);

        // Freshness under interleave: B's provider return changes → B's
        // next resolve observes it (same project, new root) while A's
        // result is untouched.
        layersB = undefined;
        expect(studioB.resolveOutDir(projB)).toBe(
            path.join(
                (globalThis as any).__PZSTUDIO_FAKE_HOME,
                'Zomboid',
                'Workshop',
            ),
        );
        expect(studioA.resolveOutDir(projA)).toBe(path.resolve(outA));
    });
});
