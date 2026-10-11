'use strict';

/**
 * DevSyncController (doc 11 §17 commit 9): the controller creates its ONE
 * session through the host PzStudio instance (studio.createDevSync) and
 * routes every batch summary/warning through the instance logger — the
 * published legacy `createDevSync`/`log`/`warn` doors no longer appear in
 * the extension controller. Two layers:
 *
 * - The unit block stubs the studio (controlled sessions, fake timers) and
 *   pins the unchanged lifecycle: active/starting guards, debounce and
 *   batch assembly, summary/error wording, stop/dispose, and the failure
 *   path (warn + rethrow + stop). The real `summarizeApplyResult` and
 *   `WATCH_DEBOUNCE_MS` are used, so the wording/debounce pins cover the
 *   shipped values, not a local copy.
 * - The integration block runs the controller over the REAL v2 instance
 *   (real createPzStudio, real BuildSession, real fs) and pins the two
 *   routing invariants the cutover exists for: per-apply settings
 *   freshness S1→S2 without recreating the session (the provider always
 *   receives the session's explicit projectDir), and plan-input emissions
 *   ([MIGRATION] warn, cold-cache/template acquisition) landing in the
 *   instance logger while conflicting legacy slots receive nothing (the
 *   extension-level mirror of the engine-side pins in cliCores.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { configurationStore } from '../helpers/vscode-mock';
import { DevSyncController } from '../../packages/vscode-extension/src/util/devsync';
import { readPzStudioHostSettings } from '../../packages/vscode-extension/src/util/settings';
import * as api from '@pzstudio/cli/api';
import {
    createPzStudio,
    setLogger,
    setProjectDir,
    setTemplateTransport,
    setVsCodeSettings,
    WATCH_DEBOUNCE_MS,
} from '@pzstudio/cli/api';
import type { BuildSession, FileDelta, PzStudio } from '@pzstudio/cli/api';
import type { TemplateTransport } from '@pzstudio/platform';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';
import { getFakeHome } from '../helpers/fake-home';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

function recordingLogger() {
    const calls: Array<{ method: string; message: any }> = [];
    const logger = {
        log: (m: any) => calls.push({ method: 'log', message: m }),
        info: (m: any) => calls.push({ method: 'info', message: m }),
        warn: (m: any) => calls.push({ method: 'warn', message: m }),
        error: (e: any) => calls.push({ method: 'error', message: e }),
        verbose: (m: any) => calls.push({ method: 'verbose', message: m }),
    };
    return { calls, logger };
}

/** Captures the watcher registrations so tests can fire file events. */
const handlers = {
    create: [] as Array<(uri: { fsPath: string }) => void>,
    change: [] as Array<(uri: { fsPath: string }) => void>,
    delete: [] as Array<(uri: { fsPath: string }) => void>,
};
const disposers = vi.fn();

/** A BuildSession-shaped stub: the controller drives exactly these calls. */
function fakeSession() {
    return {
        start: vi.fn(async () => {}),
        apply: vi.fn(async () => ({
            incremental: 0,
            scoped: [],
            fullRebuild: false,
            ignored: 0,
            errors: [] as string[],
        })),
        stop: vi.fn(async () => {}),
    } as unknown as BuildSession & {
        start: import('vitest').Mock;
        apply: import('vitest').Mock;
        stop: import('vitest').Mock;
    };
}

/**
 * Minimal PzStudio stub: the controller calls createDevSync and — since
 * UX-09 — resolveOutDir (the filtering-root reader). The default root sits
 * OUTSIDE every project directory used below so pre-filtering tests that
 * don't care about the outdir are unaffected by it.
 */
function studioStub(
    session: BuildSession,
    resolveOutDir: (...args: unknown[]) => unknown = () => '/out',
): PzStudio & { resolveOutDir: import('vitest').Mock } {
    return {
        createDevSync: vi.fn(() => session),
        resolveOutDir: vi.fn(resolveOutDir),
    } as unknown as PzStudio & { resolveOutDir: import('vitest').Mock };
}

/** Legacy transport sentinel: consulted → the v2 isolation pin fails. */
function sentinelTransport(): TemplateTransport {
    return {
        name: 'git',
        download: () => {},
        refresh: () => false,
        isCacheValid: () => false,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    handlers.create = [];
    handlers.change = [];
    handlers.delete = [];
    asMock(vscode.workspace.createFileSystemWatcher).mockImplementation(() => {
        // Mirror real watcher semantics: disposing the watcher unsubscribes
        // its handlers, so a stop()/start() cycle does not double-deliver
        // events into the restarted controller.
        const registered: Array<(uri: { fsPath: string }) => void> = [];
        const on =
            (list: Array<(uri: { fsPath: string }) => void>) =>
            (fn: (uri: { fsPath: string }) => void) => {
                list.push(fn);
                registered.push(fn);
                return { dispose: disposers };
            };
        return {
            onDidCreate: on(handlers.create),
            onDidChange: on(handlers.change),
            onDidDelete: on(handlers.delete),
            dispose: () => {
                disposers();
                for (const fn of registered.splice(0)) {
                    for (const list of [
                        handlers.create,
                        handlers.change,
                        handlers.delete,
                    ]) {
                        const idx = list.indexOf(fn);
                        if (idx >= 0) {
                            list.splice(idx, 1);
                        }
                    }
                }
            },
        };
    });
    // The published legacy doors: every pin below assumes the controller
    // never touches them — recorded here, restored in afterEach.
    vi.spyOn(api, 'createDevSync');
    vi.spyOn(api, 'log');
    vi.spyOn(api, 'warn');
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setLogger(undefined);
    setProjectDir(undefined);
    setVsCodeSettings(undefined, undefined);
    setTemplateTransport(undefined);
});

describe('DevSyncController (unit, stubbed studio)', () => {
    it('start() runs the initial full build for both variants and watches the project', async () => {
        const session = fakeSession();
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/proj');

        expect(asMock(studio.createDevSync).mock.calls[0][0]).toBe('/proj');
        expect(session.start).toHaveBeenCalledWith(['main', 'development']);
        expect(
            asMock(vscode.workspace.createFileSystemWatcher),
        ).toHaveBeenCalled();
        expect(controller.active).toBe(true);
        await controller.dispose();
    });

    it('collects file events and flushes them as one apply batch per debounce', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/proj');

        handlers.create.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        handlers.delete.forEach((fn) => fn({ fsPath: '/proj/b.lua' }));
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);

        expect(session.apply).toHaveBeenCalledTimes(1);
        expect(session.apply).toHaveBeenCalledWith([
            { type: 'create', path: '/proj/a.lua' },
            { type: 'change', path: '/proj/a.lua' },
            { type: 'delete', path: '/proj/b.lua' },
        ]);
        await controller.dispose();
    });

    it('logs a one-line summary per successful sync batch through the instance logger', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        asMock(session.apply).mockResolvedValue({
            incremental: 2,
            scoped: [],
            fullRebuild: false,
            ignored: 1,
            errors: [],
        } as never);
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/proj');
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);

        // Real summarizeApplyResult wording, `- ${summary}.` envelope —
        // byte-identical to the pre-migration line.
        expect(logger.calls).toContainEqual({
            method: 'log',
            message: '- 2 file(s) synced.',
        });
        await controller.dispose();
    });

    it('reports sync errors through the instance logger without dying', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        asMock(session.apply).mockResolvedValue({
            incremental: 0,
            scoped: [],
            fullRebuild: false,
            ignored: 0,
            errors: ['boom'],
        } as never);
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/proj');
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);

        expect(logger.calls).toContainEqual({
            method: 'warn',
            message: '- boom',
        });
        // The session stays active after a reported error.
        expect(controller.active).toBe(true);
        await controller.dispose();
    });

    it('stop() disposes the watcher, drains the session and ignores later events', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/proj');
        await controller.stop();

        expect(disposers).toHaveBeenCalled();
        expect(session.stop).toHaveBeenCalled();
        expect(controller.active).toBe(false);

        handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
        expect(session.apply).not.toHaveBeenCalled();
    });

    it('ignores start() while already active', async () => {
        const session = fakeSession();
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/proj');
        await controller.start('/other');
        expect(asMock(studio.createDevSync)).toHaveBeenCalledTimes(1);
        await controller.dispose();
    });

    it('ignores start() while a start is still in flight (starting guard)', async () => {
        const session = fakeSession();
        let releaseStart!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        asMock(session.start).mockImplementation(() => gate);
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        const first = controller.start('/proj');
        // The synchronous prefix of the second call must hit the starting
        // guard, not create a second session.
        await controller.start('/other');
        expect(asMock(studio.createDevSync)).toHaveBeenCalledTimes(1);

        releaseStart();
        await first;
        expect(session.start).toHaveBeenCalledTimes(1);
        await controller.dispose();
    });

    it('start failure warns through the instance logger, stops the half-start and rethrows', async () => {
        const session = fakeSession();
        asMock(session.start).mockRejectedValue(new Error('boom'));
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await expect(controller.start('/proj')).rejects.toThrow('boom');

        // One warning, exact pre-migration wording (no summary, no prefix).
        expect(logger.calls.filter((c) => c.method === 'warn')).toEqual([
            { method: 'warn', message: 'boom' },
        ]);
        // The watcher was never registered. Baseline cleanup preserved
        // exactly: the controller's stop() drains `this.session`, which was
        // never assigned on this path — the half-started session object is
        // dropped without a stop() call.
        expect(
            asMock(vscode.workspace.createFileSystemWatcher),
        ).not.toHaveBeenCalled();
        expect(session.stop).not.toHaveBeenCalled();
        expect(controller.active).toBe(false);
    });

    it('never touches the published legacy doors (createDevSync, log, warn)', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        asMock(session.apply).mockResolvedValue({
            incremental: 1,
            scoped: [{ modId: 'my_mod', variants: ['main'] }],
            fullRebuild: false,
            ignored: 0,
            errors: ['boom'],
        } as never);
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/proj');
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
        await controller.dispose();

        // Summary + error emission ran through the instance logger while the
        // published raw-legacy exports and the legacy session factory saw no
        // call at all (the compile dropped the imports; the spies freeze it).
        // The summary covers the incremental AND scoped branches of the real
        // summarizeApplyResult — the exact pre-migration line.
        expect(api.createDevSync).not.toHaveBeenCalled();
        expect(api.log).not.toHaveBeenCalled();
        expect(api.warn).not.toHaveBeenCalled();
        expect(logger.calls.filter((c) => c.method === 'log')).toEqual([
            {
                method: 'log',
                message: '- 1 file(s) synced; re-synced mod(s): my_mod.',
            },
        ]);
        expect(logger.calls).toContainEqual({
            method: 'warn',
            message: '- boom',
        });
    });
});

/* ------------------------------------------------------------------ */
/* UX-09: watcher events are pre-filtered through the shared           */
/* isWatchPathIgnored decision, driven by the studio.resolveOutDir     */
/* reader (doc 13 §6.3 — refresh-triggered re-resolution). The filter  */
/* root switches on the exact root-level project.json event and after  */
/* every re-baseline the session reports; everything else is pinned    */
/* as fail-open or engine-aligned.                                     */
/* ------------------------------------------------------------------ */

describe('DevSyncController pre-filtering (UX-09)', () => {
    const proj = '/proj';
    // The §3.1 case-6 layout: the output root inside a configured mod
    // folder — the exact shape that self-feeds without filtering.
    const outA = '/proj/my_mod/generated-A';
    const outB = '/proj/output-B';
    const sourceFile = '/proj/my_mod/media/lua/hello.lua';
    const outAFile =
        '/proj/my_mod/generated-A/My Title/Contents/mods/my_mod/media/lua/hello.lua';
    const projectJsonEvent = '/proj/project.json';
    const nestedProjectJson = '/proj/my_mod/data/project.json';
    const emptyResult = {
        incremental: 0,
        scoped: [],
        fullRebuild: false,
        ignored: 0,
        errors: [] as string[],
    };

    const flushOnce = () => vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
    const drain = () => vi.advanceTimersByTimeAsync(0);

    /** Every batch the controller delivered to session.apply, in order. */
    function appliedBatches(
        session: ReturnType<typeof fakeSession>,
    ): FileDelta[][] {
        return asMock(session.apply).mock.calls.map(
            (call) => call[0] as FileDelta[],
        );
    }

    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('filters engine output under a stable outdir inside the project', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => '/proj/Output');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) =>
            fn({
                fsPath: '/proj/Output/My Title/Contents/mods/my_mod/media/lua/hello.lua',
            }),
        );
        handlers.create.forEach((fn) =>
            fn({ fsPath: '/proj/Output/My Title/workshop.txt' }),
        );
        // A legitimate source edit in the SAME debounce window: it must be
        // delivered in the very batch the output events would have joined —
        // the deterministic no-sleep proof that filtering happens at
        // schedule time, before the pending batch.
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: sourceFile }],
        ]);
        await controller.dispose();
    });

    it('filters output nested inside a configured mod folder without dropping sibling sources', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => outA);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: sourceFile }],
        ]);
        await controller.dispose();
    });

    it('applies only the valid part of a mixed batch', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => '/proj/Output');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.delete.forEach((fn) =>
            fn({
                fsPath: '/proj/Output/My Title/Contents/mods/my_mod/media/lua/hello.lua',
            }),
        );
        handlers.create.forEach((fn) =>
            fn({ fsPath: '/proj/my_mod/media/lua/new.lua' }),
        );
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/.git/config' }));
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [
                { type: 'create', path: '/proj/my_mod/media/lua/new.lua' },
                { type: 'change', path: sourceFile },
            ],
        ]);
        await controller.dispose();
    });

    it('applies nothing when every event in the window is ignored', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => '/proj/Output');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) =>
            fn({
                fsPath: '/proj/Output/My Title/Contents/mods/my_mod/media/lua/hello.lua',
            }),
        );
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/.git/config' }));
        await flushOnce();

        expect(session.apply).not.toHaveBeenCalled();
        await controller.dispose();
    });

    it('preserves the shared dot-directory decision, keeping .pzstudioignore files', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => '/out');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) => fn({ fsPath: '/proj/.git/config' }));
        handlers.change.forEach((fn) =>
            fn({ fsPath: '/proj/my_mod/media/.DS_Store' }),
        );
        handlers.change.forEach((fn) =>
            fn({ fsPath: '/proj/my_mod/.pzstudioignore' }),
        );
        handlers.change.forEach((fn) =>
            fn({ fsPath: '/proj/my_mod/.template-mod/x.lua' }),
        );
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: '/proj/my_mod/.pzstudioignore' }],
        ]);
        await controller.dispose();
    });

    it('replays the CLI watch case set through the schedule path (parity)', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => '/proj/Output');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        // Same inputs as tests/unit/watch.test.ts isWatchPathIgnored:
        // the watched root itself, outside-project, outdir subtree, dot
        // segments, .pzstudioignore kept, normal source kept, project.json
        // kept (which also exercises the schedule-time switch on a
        // same-root resolution).
        handlers.change.forEach((fn) => fn({ fsPath: proj }));
        handlers.change.forEach((fn) => fn({ fsPath: '/elsewhere/x.lua' }));
        handlers.change.forEach((fn) =>
            fn({ fsPath: '/proj/Output/My Title/workshop.txt' }),
        );
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/.git/config' }));
        handlers.change.forEach((fn) =>
            fn({ fsPath: '/proj/my_mod/.pzstudioignore' }),
        );
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [
                { type: 'change', path: proj },
                { type: 'change', path: '/proj/my_mod/.pzstudioignore' },
                { type: 'change', path: sourceFile },
                { type: 'change', path: projectJsonEvent },
            ],
        ]);
        await controller.dispose();
    });

    it('switches the filter root ONLY on the root-level project.json event (exact Core matching)', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => outA);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        const readsAfterStart = asMock(studio.resolveOutDir).mock.calls.length;

        // A nested project.json is an ordinary mod file to the engine —
        // classifyDelta never full-rebuilds on it, so the filter must not
        // re-resolve and must keep filtering the output subtree. The nested
        // event itself is not under the output root, so it is delivered —
        // its presence in the batch proves the filter held while it fired.
        handlers.change.forEach((fn) => fn({ fsPath: nestedProjectJson }));
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(
            readsAfterStart,
        );
        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: nestedProjectJson }],
        ]);

        // The root-level file is the only event that classifies
        // full-rebuild — the switch fires exactly there, with the session's
        // projectDir.
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(
            readsAfterStart + 1,
        );
        expect(asMock(studio.resolveOutDir).mock.calls.at(-1)).toEqual([proj]);
        await controller.dispose();
    });

    it('A→B full rebuild succeeds: the filter follows the new root and former-output source is delivered', async () => {
        const session = fakeSession();
        let root = outA;
        const studio = studioStub(session, () => root);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        asMock(session.apply).mockResolvedValue({
            ...emptyResult,
            fullRebuild: true,
        } as never);

        // The outdir moved A → B (settings/fixture); the root project.json
        // event is the engine's own re-baseline trigger: the schedule-time
        // switch adopts B, the rebuild re-baselines, the post-apply
        // correction re-confirms B (2 startup reads + switch + correction).
        root = outB;
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        await flushOnce();
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(4);

        // The formerly filtered A subtree reverted to source semantics:
        // its events must be delivered again (the §3.2 loss this closes),
        // while output under the NEW root stays filtered — loop protection
        // moved with the engine.
        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        handlers.change.forEach((fn) =>
            fn({
                fsPath: '/proj/output-B/My Title/Contents/mods/my_mod/media/lua/hello.lua',
            }),
        );
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: projectJsonEvent }],
            [{ type: 'change', path: outAFile }],
        ]);
        await controller.dispose();
    });

    it('an outdir-irrelevant project.json edit keeps the root and the loop protection (no naive invalidation)', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => outA);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        const readsAfterStart = asMock(studio.resolveOutDir).mock.calls.length;

        // Root project.json edit that does NOT move the outdir: re-resolved
        // (compare-and-adopt) and the same root keeps filtering — including
        // an engine-shaped output mod.info event under the root. Unconditional
        // invalidation here would re-open the self-feed loop. The project.json
        // event itself is delivered (not under the output root) — its
        // presence alone in the batch proves both output events were dropped.
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(
            readsAfterStart + 1,
        );
        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        handlers.change.forEach((fn) =>
            fn({
                fsPath: '/proj/my_mod/generated-A/My Title/Contents/mods/my_mod/mod.info',
            }),
        );
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: projectJsonEvent }],
        ]);
        await controller.dispose();
    });

    it('the bare-snapshot shape (reader frozen at A) loses the same event — the harness detects the forbidden loss', async () => {
        const session = fakeSession();
        // A reader that never observes the move: the bare startup snapshot
        // the §6.3 policy exists to correct.
        const studio = studioStub(session, () => outA);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        asMock(session.apply).mockResolvedValue({
            ...emptyResult,
            fullRebuild: true,
        } as never);

        // The engine moves to B and the project.json event re-baselines it —
        // but the reader (by construction here) still reports A.
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        await flushOnce();

        // A source file under the former output subtree A: with the switch
        // points bypassed this event is silently discarded — exactly the
        // §3.2 loss the policy forbids. This pin proves the harness detects
        // that loss through actual delivered batches.
        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: projectJsonEvent }],
        ]);
        await controller.dispose();
    });

    it('a failed rebuild after the schedule-time switch keeps source flowing (no silent loss)', async () => {
        const session = fakeSession();
        let root = outA;
        const studio = studioStub(session, () => root);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        // The rebuild fails (e.g. its plan-input resolution broke): the
        // engine retains its baseline while the filter already adopted B.
        asMock(session.apply).mockResolvedValue({
            ...emptyResult,
            errors: ['rebuild boom'],
        } as never);

        root = outB;
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        await flushOnce();

        // Named residual (doc 13 §6.3): until the next successful
        // re-baseline the engine may still write A and those output events
        // are forwarded — the bounded loop-window direction, NOT a
        // source-loss direction. The loss direction stays closed: source
        // under the formerly filtered A is delivered.
        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: projectJsonEvent }],
            [{ type: 'change', path: outAFile }],
        ]);
        await controller.dispose();
    });

    it('a failing resolution at the switch retains the last good root (engine-aligned loop protection)', async () => {
        const session = fakeSession();
        let healthy = true;
        let root = outA;
        const studio = studioStub(session, () => {
            if (!healthy) {
                throw new Error('provider boom');
            }
            return root;
        });
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        asMock(session.apply).mockResolvedValue(emptyResult as never);

        // The config broke exactly when the project.json event arrived:
        // the last good root is retained. The engine keeps its baseline on
        // the same failure, so filter and engine stay aligned — output
        // under A stays filtered while legitimate source flows.
        healthy = false;
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();
        // The project.json event is delivered (not under the root); the
        // outAFile event was dropped by the retained root.
        expect(appliedBatches(session)).toEqual([
            [
                { type: 'change', path: projectJsonEvent },
                { type: 'change', path: sourceFile },
            ],
        ]);

        // Recovery: the config heals and the next root event adopts B.
        healthy = true;
        root = outB;
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [
                { type: 'change', path: projectJsonEvent },
                { type: 'change', path: sourceFile },
            ],
            [
                { type: 'change', path: projectJsonEvent },
                { type: 'change', path: outAFile },
            ],
        ]);
        await controller.dispose();
    });

    it('a plain mod delta after a settings change triggers no switch (the engine keeps its baseline)', async () => {
        const session = fakeSession();
        let root = outA;
        const studio = studioStub(session, () => root);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        const readsAfterStart = asMock(studio.resolveOutDir).mock.calls.length;

        // Settings moved to B, but ONLY a plain mod-file event arrives —
        // no switch point fires (the engine reuses its baseline and keeps
        // writing A; a re-read here would lead the engine).
        root = outB;
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(
            readsAfterStart,
        );
        await flushOnce();
        // Delivered — and the filter still holds A, so output under A is
        // still filtered (loop protection retained while the engine stays).
        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: sourceFile }],
        ]);
        await controller.dispose();
    });

    it('a scoped-rebuild result triggers the post-apply correction (root move riding a scoped rebuild)', async () => {
        const session = fakeSession();
        let root = outA;
        const studio = studioStub(session, () => root);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        asMock(session.apply).mockResolvedValue({
            ...emptyResult,
            scoped: [{ modId: 'my_mod', variants: ['main'] }],
        } as never);

        // Settings moved A → B; a mod.info edit re-baselines the session
        // (scoped rebuild) — no schedule-time switch fires for it, the
        // post-apply correction adopts B after the flush.
        root = outB;
        handlers.change.forEach((fn) =>
            fn({ fsPath: '/proj/my_mod/mod.info' }),
        );
        await flushOnce();
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(3);

        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        handlers.change.forEach((fn) =>
            fn({ fsPath: '/proj/output-B/My Title/workshop.txt' }),
        );
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: '/proj/my_mod/mod.info' }],
            [{ type: 'change', path: outAFile }],
        ]);
        await controller.dispose();
    });

    it('a plain apply result triggers no post-apply correction', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => outA);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        asMock(session.apply).mockResolvedValue(emptyResult as never);

        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(2);
        await controller.dispose();
    });

    it('an outdir equal to the project root never drops legitimate source (fail-open by construction)', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => proj);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        handlers.delete.forEach((fn) =>
            fn({ fsPath: '/proj/my_mod/media/lua/old.lua' }),
        );
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [
                { type: 'change', path: sourceFile },
                { type: 'change', path: projectJsonEvent },
                { type: 'delete', path: '/proj/my_mod/media/lua/old.lua' },
            ],
        ]);
        await controller.dispose();
    });

    it('an outdir that is an ancestor of the project never drops legitimate source', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => '/parent');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/parent/proj');

        handlers.change.forEach((fn) =>
            fn({ fsPath: '/parent/proj/my_mod/media/lua/hello.lua' }),
        );
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [
                {
                    type: 'change',
                    path: '/parent/proj/my_mod/media/lua/hello.lua',
                },
            ],
        ]);
        await controller.dispose();
    });

    it('a sibling-segment outdir never falsely contains sibling sources', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => '/proj/my_mod2');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/my_mod2/x.lua' }));
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: sourceFile }],
        ]);
        await controller.dispose();
    });

    it('stop/start re-resolves the root: the old root is not reused', async () => {
        const session = fakeSession();
        let root = '/proj/out1';
        const studio = studioStub(session, () => root);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        await controller.stop();

        root = '/proj/out2';
        await controller.start(proj);
        // A fresh start re-consulted the reader (two reads for the new
        // session on top of the two for the old one).
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(4);

        // Events under the NEW root are filtered; the OLD root is inert.
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/out2/x.lua' }));
        handlers.change.forEach((fn) =>
            fn({ fsPath: '/proj/out1/legacy.lua' }),
        );
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [
                { type: 'change', path: '/proj/out1/legacy.lua' },
                { type: 'change', path: sourceFile },
            ],
        ]);
        await controller.dispose();
    });

    it('two different projects never cross-leak filter roots', async () => {
        const session = fakeSession();
        let root = '/projA/out';
        const studio = studioStub(session, () => root);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/projA');
        await controller.stop();

        root = '/projB/out';
        await controller.start('/projB');
        handlers.change.forEach((fn) => fn({ fsPath: '/projB/out/x.lua' }));
        handlers.change.forEach((fn) => fn({ fsPath: '/projB/media/a.lua' }));
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: '/projB/media/a.lua' }],
        ]);
        await controller.dispose();
    });

    it('stop() during an in-flight apply leaves no stale filter state for the next session', async () => {
        const firstSession = fakeSession();
        let root = outA;
        const studio = studioStub(firstSession, () => root);
        const logger = recordingLogger();
        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        const readsAfterStart = asMock(studio.resolveOutDir).mock.calls.length;

        // Gate the apply: the flush is in flight across a stop AND a
        // restart on a different root.
        let release!: (value: unknown) => void;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        asMock(firstSession.apply).mockImplementation(() => gate);

        root = outB;
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(
            readsAfterStart + 1,
        );
        await flushOnce(); // flush awaits the gate

        await controller.stop();
        const secondSession = fakeSession();
        const secondStudio = studioStub(secondSession, () => '/proj/out-new');
        const secondController = new DevSyncController(
            secondStudio,
            logger.logger,
        );
        await secondController.start(proj);

        // The abandoned flush drains now: its post-apply correction must be
        // skipped (the session it belonged to is gone) — no stale write and
        // no clobber of the new session's root.
        release({ ...emptyResult, fullRebuild: true });
        await drain();
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(
            readsAfterStart + 1,
        );

        // The new session filters by ITS OWN root: an event under the new
        // root is filtered (a clobber to outB would forward it).
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/out-new/x.lua' }));
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();
        expect(appliedBatches(secondSession)).toEqual([
            [{ type: 'change', path: sourceFile }],
        ]);
        await secondController.dispose();
    });

    it('a failing startup resolution preserves the UX-06 cleanup: no session, no watcher, one warning', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => {
            throw new Error('No pzstudio project found.');
        });
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await expect(controller.start(proj)).rejects.toThrow(
            'No pzstudio project found.',
        );

        expect(session.start).not.toHaveBeenCalled();
        expect(
            asMock(vscode.workspace.createFileSystemWatcher),
        ).not.toHaveBeenCalled();
        expect(logger.calls.filter((c) => c.method === 'warn')).toEqual([
            { method: 'warn', message: 'No pzstudio project found.' },
        ]);
        expect(controller.active).toBe(false);
        await expect(controller.dispose()).resolves.toBeUndefined();
        expect(session.stop).not.toHaveBeenCalled();
    });

    it('provider divergence between the two startup reads: the post-start correction defines the filter (B.10)', async () => {
        // First read A (pre-start), later reads B (post-start correction) —
        // the filter must end on the session's own baseline root B, in both
        // divergence orders. No atomic equivalence is claimed or asserted.
        let calls = 0;
        const session = fakeSession();
        const studio = studioStub(session, () => (calls++ === 0 ? outA : outB));
        const logger = recordingLogger();
        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        handlers.change.forEach((fn) =>
            fn({ fsPath: '/proj/output-B/My Title/workshop.txt' }),
        );
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [
                { type: 'change', path: outAFile },
                { type: 'change', path: sourceFile },
            ],
        ]);
        await controller.dispose();

        // Reverse divergence: first read B, correction A — the filter ends
        // on A; source events always reach apply either way.
        calls = 0;
        const session2 = fakeSession();
        const studio2 = studioStub(session2, () =>
            calls++ === 0 ? outB : outA,
        );
        const controller2 = new DevSyncController(studio2, logger.logger);
        await controller2.start(proj);

        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        handlers.change.forEach((fn) =>
            fn({ fsPath: '/proj/output-B/My Title/workshop.txt' }),
        );
        await flushOnce();
        expect(appliedBatches(session2)).toEqual([
            [{ type: 'change', path: '/proj/output-B/My Title/workshop.txt' }],
        ]);
        await controller2.dispose();
    });

    it('the filter path stays on the instance: legacy doors untouched, the reader gets the session projectDir', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => outA);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        // The schedule-time switch and the post-apply correction run through
        // the INSTANCE reader — the published raw-legacy exports stay cold.
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();

        expect(api.createDevSync).not.toHaveBeenCalled();
        expect(api.log).not.toHaveBeenCalled();
        expect(api.warn).not.toHaveBeenCalled();
        for (const call of asMock(studio.resolveOutDir).mock.calls) {
            expect(call).toEqual([proj]);
        }
        await controller.dispose();
    });
});

/* ------------------------------------------------------------------ */
/* Integration: the controller over the REAL v2 instance               */
/* ------------------------------------------------------------------ */

describe('DevSyncController over the real v2 instance (commit 9 routing pins)', () => {
    let temps: string[] = [];
    function makeTemp(): string {
        const dir = createTempDir();
        temps.push(dir);
        return dir;
    }

    afterEach(() => {
        for (const dir of temps) deleteDir(dir);
        temps = [];
    });

    /** A minimal valid project fixture with one syncable mod source. */
    function makeProject(
        title: string,
        options: { legacyRootTitle?: boolean } = {},
    ): string {
        const dir = makeTemp();
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
                // Root-level `title` → the legacy-shape [MIGRATION] warn.
                ...(options.legacyRootTitle ? { title } : {}),
                workshop: { title, visibility: 'public', tags: [] },
                mods: {
                    my_mod: { name: 'My Mod', description: 'A mod.' },
                },
                excludes: [],
            }),
        );
        fs.mkdirSync(path.join(dir, 'my_mod', 'media', 'lua'), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(dir, 'my_mod', 'media', 'lua', 'hello.lua'),
            'print("v1")',
        );
        return dir;
    }

    /** Seeds a valid workshop template cache so no clone is attempted. */
    function seedWorkshopTemplateCache(): void {
        const cacheDir = path.join(
            getFakeHome()!,
            '.pzstudio',
            'templates',
            'fixture',
            'local',
        );
        fs.mkdirSync(path.join(cacheDir, '.git'), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, 'template-file.txt'), 'template');
    }

    it('resolves settings per plan input: S1 → S2 without recreating the session, provider always gets the session projectDir', async () => {
        seedWorkshopTemplateCache();
        const projectDir = makeProject('Fresh Sync');
        const out1 = path.join(makeTemp(), 'out-one');
        const out2 = path.join(makeTemp(), 'out-two');

        // Conflicting legacy state: slots, anchor, logger and transport all
        // populated — the v2 session must consume none of them (R0/R1).
        const legacyOut = makeTemp();
        setVsCodeSettings({ outdir: legacyOut }, undefined);
        setProjectDir(makeTemp());
        const L1 = recordingLogger();
        setLogger(L1.logger);
        const sentinel = sentinelTransport();
        vi.spyOn(sentinel, 'isCacheValid');
        setTemplateTransport(sentinel);

        const templateLayer = {
            workshop: { url: 'fixture/local' },
        };
        let layers: api.PzStudioHostSettings = {
            workspace: {
                outdir: out1,
                useSymlinks: false,
                templates: templateLayer,
            },
        };
        const provider = vi.fn(() => layers);
        const V2 = recordingLogger();
        const studio = createPzStudio({
            logger: V2.logger,
            settings: provider,
        });
        const createDevSyncSpy = vi.spyOn(studio, 'createDevSync');

        const controller = new DevSyncController(studio, V2.logger);
        await controller.start(projectDir);

        // First plan input observed S1: the initial build landed in out1,
        // not in the pushed legacy slot.
        expect(fs.existsSync(path.join(out1, 'Fresh Sync'))).toBe(true);
        expect(fs.existsSync(path.join(out2, 'Fresh Sync'))).toBe(false);
        expect(fs.readdirSync(legacyOut)).toEqual([]);
        expect(provider.mock.calls.length).toBeGreaterThan(0);
        for (const call of provider.mock.calls) {
            expect(call).toEqual([{ projectDir }]);
        }

        // S2 becomes provider-visible; a later plan input (structural
        // change → full rebuild) must observe it WITHOUT a new session.
        layers = {
            workspace: {
                outdir: out2,
                useSymlinks: false,
                templates: templateLayer,
            },
        };
        handlers.change.forEach((fn) =>
            fn({ fsPath: path.join(projectDir, 'project.json') }),
        );
        await vi.waitFor(
            () =>
                expect(fs.existsSync(path.join(out2, 'Fresh Sync'))).toBe(true),
            { timeout: 5000 },
        );

        // Same session (no recreate), fresh settings: the rebuild landed in
        // out2; the provider saw the explicit session projectDir every time.
        expect(createDevSyncSpy).toHaveBeenCalledTimes(1);
        expect(provider.mock.calls.length).toBeGreaterThanOrEqual(2);
        for (const call of provider.mock.calls) {
            expect(call).toEqual([{ projectDir }]);
        }
        // The conflicting legacy sinks never received anything.
        expect(fs.readdirSync(legacyOut)).toEqual([]);
        expect(L1.calls).toEqual([]);
        expect(sentinel.isCacheValid).not.toHaveBeenCalled();

        await controller.dispose();
    });

    it('routes plan-input emissions ([MIGRATION], cold template acquisition) to the instance logger', async () => {
        // Legacy facade state populated aggressively: logger + settings slot
        // + anchor — every raw-legacy emission would land in L1.
        const legacyOut = makeTemp();
        const L1 = recordingLogger();
        setLogger(L1.logger);
        setVsCodeSettings(
            {
                outdir: legacyOut,
                templates: {
                    workshop: {
                        url: 'https://github.com/legacy/should-not-win.git',
                    },
                },
            },
            undefined,
        );
        setProjectDir(makeTemp());

        const v2Out = path.join(makeTemp(), 'v2-out');
        const V2 = recordingLogger();
        // No template layer on the instance: the template path exercises the
        // official default cold (bootstrap → clone attempt → legacy
        // fallback) — the same inventory the engine-side pin asserts.
        const studio = createPzStudio({
            logger: V2.logger,
            settings: () => ({ workspace: { outdir: v2Out } }),
        });

        const projectDir = makeProject('Routed Sync', {
            legacyRootTitle: true,
        });
        const controller = new DevSyncController(studio, V2.logger);
        await controller.start(projectDir);
        await controller.dispose();

        const has = (method: string, fragment: string) =>
            V2.calls.some(
                (c) =>
                    c.method === method && String(c.message).includes(fragment),
            );
        // Plan-input config read: the [MIGRATION] warning.
        expect(has('warn', '[MIGRATION]')).toBe(true);
        // Cold-cache/template acquisition: bootstrap info, clone info,
        // clone-fail warn, offline-legacy fallback warn.
        expect(has('info', 'Bootstrapping legacy templates')).toBe(true);
        expect(
            has(
                'info',
                '- Cloning template from https://github.com/escapepz/pzstudio-template-workshop.git',
            ),
        ).toBe(true);
        expect(has('warn', 'Failed to clone template from')).toBe(true);
        expect(has('warn', 'Falling back to offline legacy template')).toBe(
            true,
        );

        // The legacy logger slot (the target of the published raw log/warn
        // exports) received NOTHING — the v2 path never touches it.
        expect(L1.calls).toEqual([]);
        // Settings fingerprint: the instance's workspace layer decided; the
        // legacy outdir slot is untouched.
        expect(fs.existsSync(path.join(v2Out, 'Routed Sync'))).toBe(true);
        expect(fs.readdirSync(legacyOut)).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* UX-09 integration: the pre-filter over the REAL engine (real        */
/* BuildSession, real classifyDelta, real fs). Delivery is proven      */
/* through actual apply batches and the written output trees — never   */
/* only the helper's boolean return.                                   */
/* ------------------------------------------------------------------ */

describe('DevSyncController pre-filtering over the real engine (UX-09)', () => {
    let temps: string[] = [];
    function makeTemp(): string {
        const dir = createTempDir();
        temps.push(dir);
        return dir;
    }

    afterEach(() => {
        for (const dir of temps) deleteDir(dir);
        temps = [];
    });

    /** A minimal valid project fixture with one syncable mod source. */
    function makeProject(title: string): string {
        const dir = makeTemp();
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
                workshop: { title, visibility: 'public', tags: [] },
                mods: {
                    my_mod: { name: 'My Mod', description: 'A mod.' },
                },
                excludes: [],
            }),
        );
        fs.mkdirSync(path.join(dir, 'my_mod', 'media', 'lua'), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(dir, 'my_mod', 'media', 'lua', 'hello.lua'),
            'print("v1")',
        );
        return dir;
    }

    /** Seeds a valid workshop template cache so no clone is attempted. */
    function seedWorkshopTemplateCache(): void {
        const cacheDir = path.join(
            getFakeHome()!,
            '.pzstudio',
            'templates',
            'fixture',
            'local',
        );
        fs.mkdirSync(path.join(cacheDir, '.git'), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, 'template-file.txt'), 'template');
    }

    /** The main-variant output file for the fixture's single mod source. */
    function mainOut(
        outputRoot: string,
        title: string,
        ...rest: string[]
    ): string {
        return path.join(
            outputRoot,
            title,
            'Contents',
            'mods',
            'my_mod',
            ...rest,
        );
    }

    function makeLayers(outdir: string): api.PzStudioHostSettings {
        return {
            workspace: {
                outdir,
                useSymlinks: false,
                templates: { workshop: { url: 'fixture/local' } },
            },
        };
    }

    it('stable inside-mod outdir: the initial build lands there, output events never reach apply, and conflicting legacy slots stay cold', async () => {
        seedWorkshopTemplateCache();
        const projectDir = makeProject('Filtered Sync');
        const outA = path.join(projectDir, 'my_mod', 'generated-A');

        // Conflicting legacy state (R0/R1): slots, anchor, logger and
        // transport populated — the v2 session AND its filtering root must
        // consume none of them.
        const legacyOut = makeTemp();
        setVsCodeSettings({ outdir: legacyOut }, undefined);
        setProjectDir(makeTemp());
        const L1 = recordingLogger();
        setLogger(L1.logger);
        const sentinel = sentinelTransport();
        vi.spyOn(sentinel, 'isCacheValid');
        setTemplateTransport(sentinel);

        const layers = makeLayers(outA);
        const V2 = recordingLogger();
        const studio = createPzStudio({
            logger: V2.logger,
            settings: () => layers,
        });
        const createDevSyncSpy = vi.spyOn(studio, 'createDevSync');
        const controller = new DevSyncController(studio, V2.logger);
        await controller.start(projectDir);

        // The initial build wrote into the inside-mod output root.
        const builtOut = mainOut(
            outA,
            'Filtered Sync',
            'media',
            'lua',
            'hello.lua',
        );
        expect(fs.readFileSync(builtOut, 'utf8')).toBe('print("v1")');

        const session = createDevSyncSpy.mock.results[0]!.value as BuildSession;
        const applySpy = vi.spyOn(session, 'apply');

        // An engine-written output file surfaces as a watcher event: the
        // pre-filter must drop it before the pending batch (UX-09's loop
        // case). A legitimate source edit in the same debounce window proves
        // the negative deterministically — it lands in the very batch the
        // output event would have joined.
        handlers.change.forEach((fn) => fn({ fsPath: builtOut }));
        const source = path.join(
            projectDir,
            'my_mod',
            'media',
            'lua',
            'hello.lua',
        );
        fs.writeFileSync(source, 'print("v2")');
        handlers.change.forEach((fn) => fn({ fsPath: source }));
        await vi.waitFor(() => expect(applySpy).toHaveBeenCalled(), {
            timeout: 5000,
        });

        const delivered = applySpy.mock.calls.flatMap((call) => call[0]);
        expect(delivered).toEqual([{ type: 'change', path: source }]);

        // The engine applied the real delta into the SAME inside-mod root.
        await vi.waitFor(
            () => expect(fs.readFileSync(builtOut, 'utf8')).toBe('print("v2")'),
            { timeout: 5000 },
        );

        // The filtering root came from the instance provider, not the
        // legacy slots: the legacy logger and legacy outdir stayed cold.
        expect(L1.calls).toEqual([]);
        expect(fs.readdirSync(legacyOut)).toEqual([]);
        expect(sentinel.isCacheValid).not.toHaveBeenCalled();

        await controller.dispose();
    });

    it('A→B transition: source under the former output root reaches apply and lands in the new output (the §3.2 temporal gate)', async () => {
        seedWorkshopTemplateCache();
        const projectDir = makeProject('Transition Gate');
        const outA = path.join(projectDir, 'my_mod', 'generated-A');
        const outB = path.join(makeTemp(), 'external', 'output-B');

        let layers = makeLayers(outA);
        const V2 = recordingLogger();
        const studio = createPzStudio({
            logger: V2.logger,
            settings: () => layers,
        });
        const createDevSyncSpy = vi.spyOn(studio, 'createDevSync');
        const resolveSpy = vi.spyOn(studio, 'resolveOutDir');
        const controller = new DevSyncController(studio, V2.logger);
        await controller.start(projectDir);
        expect(
            fs.readFileSync(
                mainOut(outA, 'Transition Gate', 'media', 'lua', 'hello.lua'),
                'utf8',
            ),
        ).toBe('print("v1")');

        const session = createDevSyncSpy.mock.results[0]!.value as BuildSession;
        const applySpy = vi.spyOn(session, 'apply');
        const startupReads = resolveSpy.mock.calls.length;

        // Settings move A → B, then the root project.json event triggers the
        // full rebuild that re-baselines the engine. The schedule-time
        // switch resolves synchronously at event time; the rebuild lands in
        // B; the post-apply correction follows the reported re-baseline.
        layers = makeLayers(outB);
        handlers.change.forEach((fn) =>
            fn({ fsPath: path.join(projectDir, 'project.json') }),
        );
        expect(resolveSpy.mock.calls.length).toBe(startupReads + 1);
        await vi.waitFor(
            () =>
                expect(
                    fs.existsSync(
                        mainOut(
                            outB,
                            'Transition Gate',
                            'media',
                            'lua',
                            'hello.lua',
                        ),
                    ),
                ).toBe(true),
            { timeout: 5000 },
        );
        await vi.waitFor(
            () => expect(resolveSpy.mock.calls.length).toBe(startupReads + 2),
            { timeout: 5000 },
        );
        expect(applySpy).toHaveBeenCalledTimes(1);
        expect(applySpy.mock.calls[0]![0]).toEqual([
            { type: 'change', path: path.join(projectDir, 'project.json') },
        ]);

        // A file under the previously filtered A is legitimate source now:
        // the stale filter must NOT discard it (the §3.2 loss this policy
        // closes), and the engine must deliver it into the NEW output root.
        const revived = path.join(
            projectDir,
            'my_mod',
            'generated-A',
            'media',
            'lua',
            'revived.lua',
        );
        fs.mkdirSync(path.dirname(revived), { recursive: true });
        fs.writeFileSync(revived, 'print("revived")');
        handlers.create.forEach((fn) => fn({ fsPath: revived }));
        await vi.waitFor(() => expect(applySpy).toHaveBeenCalledTimes(2), {
            timeout: 5000,
        });
        expect(applySpy.mock.calls[1]![0]).toEqual([
            { type: 'create', path: revived },
        ]);
        const revivedOut = mainOut(
            outB,
            'Transition Gate',
            'generated-A',
            'media',
            'lua',
            'revived.lua',
        );
        await vi.waitFor(
            () =>
                expect(fs.readFileSync(revivedOut, 'utf8')).toBe(
                    'print("revived")',
                ),
            { timeout: 5000 },
        );

        await controller.dispose();
    });

    it('settings A→B with only a plain delta: the engine keeps writing A and no switch point fires (B.5a)', async () => {
        seedWorkshopTemplateCache();
        const projectDir = makeProject('Plain Delta Sync');
        const outA = path.join(projectDir, 'my_mod', 'generated-A');
        const outB = path.join(makeTemp(), 'external', 'output-B');

        let layers = makeLayers(outA);
        const V2 = recordingLogger();
        const studio = createPzStudio({
            logger: V2.logger,
            settings: () => layers,
        });
        const resolveSpy = vi.spyOn(studio, 'resolveOutDir');
        const controller = new DevSyncController(studio, V2.logger);
        await controller.start(projectDir);
        const startupReads = resolveSpy.mock.calls.length;

        // Settings move to B, but ONLY a plain mod-file event arrives: the
        // engine reuses its baseline and keeps writing A. The test documents
        // that the filter did not re-resolve BY POLICY (no switch point on a
        // plain delta), not that the roots happened to agree.
        layers = makeLayers(outB);
        const source = path.join(
            projectDir,
            'my_mod',
            'media',
            'lua',
            'hello.lua',
        );
        fs.writeFileSync(source, 'print("v2")');
        handlers.change.forEach((fn) => fn({ fsPath: source }));
        await vi.waitFor(
            () =>
                expect(
                    fs.readFileSync(
                        mainOut(
                            outA,
                            'Plain Delta Sync',
                            'media',
                            'lua',
                            'hello.lua',
                        ),
                        'utf8',
                    ),
                ).toBe('print("v2")'),
            { timeout: 5000 },
        );
        expect(resolveSpy.mock.calls.length).toBe(startupReads);
        expect(fs.existsSync(mainOut(outB, 'Plain Delta Sync'))).toBe(false);

        await controller.dispose();
    });

    it('scoped rebuild moves the root: the post-apply correction adopts B and old-root source is delivered (B.13)', async () => {
        seedWorkshopTemplateCache();
        const projectDir = makeProject('Scoped Move');
        const outA = path.join(projectDir, 'my_mod', 'generated-A');
        const outB = path.join(makeTemp(), 'external', 'output-B');

        let layers = makeLayers(outA);
        const V2 = recordingLogger();
        const studio = createPzStudio({
            logger: V2.logger,
            settings: () => layers,
        });
        const createDevSyncSpy = vi.spyOn(studio, 'createDevSync');
        const resolveSpy = vi.spyOn(studio, 'resolveOutDir');
        const controller = new DevSyncController(studio, V2.logger);
        await controller.start(projectDir);

        const session = createDevSyncSpy.mock.results[0]!.value as BuildSession;
        const applySpy = vi.spyOn(session, 'apply');
        const startupReads = resolveSpy.mock.calls.length;

        // Settings move A → B; a mod.info edit re-baselines the session via
        // a SCOPED rebuild (no schedule-time switch fires for it — its
        // re-baseline is conditional). The post-apply correction adopts B.
        layers = makeLayers(outB);
        handlers.change.forEach((fn) =>
            fn({ fsPath: path.join(projectDir, 'my_mod', 'mod.info') }),
        );
        await vi.waitFor(
            () =>
                expect(
                    fs.existsSync(
                        mainOut(
                            outB,
                            'Scoped Move',
                            'media',
                            'lua',
                            'hello.lua',
                        ),
                    ),
                ).toBe(true),
            { timeout: 5000 },
        );
        await vi.waitFor(
            () => expect(resolveSpy.mock.calls.length).toBe(startupReads + 1),
            { timeout: 5000 },
        );
        expect(applySpy).toHaveBeenCalledTimes(1);
        const firstResult = await applySpy.mock.results[0]!.value;
        expect(firstResult.scoped).toEqual([
            { modId: 'my_mod', variants: ['main', 'development'] },
        ]);

        // Post-flush: source under the old root A is delivered (the
        // correction adopted B; the during-apply window residual named in
        // doc 13 §6.3 is not exercised here — only post-flush delivery).
        const revived = path.join(
            projectDir,
            'my_mod',
            'generated-A',
            'media',
            'lua',
            'revived.lua',
        );
        fs.mkdirSync(path.dirname(revived), { recursive: true });
        fs.writeFileSync(revived, 'print("revived")');
        handlers.create.forEach((fn) => fn({ fsPath: revived }));
        await vi.waitFor(() => expect(applySpy).toHaveBeenCalledTimes(2), {
            timeout: 5000,
        });
        expect(applySpy.mock.calls[1]![0]).toEqual([
            { type: 'create', path: revived },
        ]);
        const revivedOut = mainOut(
            outB,
            'Scoped Move',
            'generated-A',
            'media',
            'lua',
            'revived.lua',
        );
        await vi.waitFor(
            () =>
                expect(fs.readFileSync(revivedOut, 'utf8')).toBe(
                    'print("revived")',
                ),
            { timeout: 5000 },
        );

        await controller.dispose();
    });
});

/* ------------------------------------------------------------------ */
/* UX-05: the DevSync session consumes its OWN project's folder        */
/* settings through the extension settings provider                    */
/* ------------------------------------------------------------------ */

describe('DevSyncController resource-scoped settings (UX-05)', () => {
    let temps: string[] = [];
    function makeTemp(): string {
        const dir = createTempDir();
        temps.push(dir);
        return dir;
    }

    afterEach(() => {
        for (const dir of temps) deleteDir(dir);
        temps = [];
        configurationStore.reset();
    });

    function makeProject(title: string): string {
        const dir = makeTemp();
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
                workshop: { title, visibility: 'public', tags: [] },
                mods: {
                    my_mod: { name: 'My Mod', description: 'A mod.' },
                },
                excludes: [],
            }),
        );
        fs.mkdirSync(path.join(dir, 'my_mod', 'media', 'lua'), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(dir, 'my_mod', 'media', 'lua', 'hello.lua'),
            'print("v1")',
        );
        return dir;
    }

    /** Seeds a valid workshop template cache so no clone is attempted. */
    function seedWorkshopTemplateCache(): void {
        const cacheDir = path.join(
            getFakeHome()!,
            '.pzstudio',
            'templates',
            'fixture',
            'local',
        );
        fs.mkdirSync(path.join(cacheDir, '.git'), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, 'template-file.txt'), 'template');
    }

    it('builds each project into its own folder-scoped outdir with no cross-leak', async () => {
        seedWorkshopTemplateCache();
        const projectA = makeProject('Folder A Sync');
        const projectB = makeProject('Folder B Sync');
        const outA = path.join(makeTemp(), 'out-a');
        const outB = path.join(makeTemp(), 'out-b');

        // Each project IS its own workspace folder root, carrying its own
        // folder-scoped pzstudio settings.
        const store = vscode.workspace
            .configurationStore as typeof configurationStore;
        store.folders[projectA] = {
            'pzstudio.outdir': outA,
            'pzstudio.templates.workshop.url': 'fixture/local',
        };
        store.folders[projectB] = {
            'pzstudio.outdir': outB,
            'pzstudio.templates.workshop.url': 'fixture/local',
        };
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [
            { uri: vscode.Uri.file(projectA), name: 'project-a' },
            { uri: vscode.Uri.file(projectB), name: 'project-b' },
        ];

        // The exact provider wiring extension.ts installs.
        const contexts: Array<string | undefined> = [];
        const V2 = recordingLogger();
        const studio = createPzStudio({
            logger: V2.logger,
            settings: (ctx) => {
                contexts.push(ctx.projectDir);
                return readPzStudioHostSettings(ctx);
            },
        });

        const controller = new DevSyncController(studio, V2.logger);

        // Session A: every plan input resolves settings FOR project A.
        await controller.start(projectA);
        expect(fs.existsSync(path.join(outA, 'Folder A Sync'))).toBe(true);
        expect(fs.existsSync(path.join(outB, 'Folder A Sync'))).toBe(false);
        await controller.dispose();

        const callsForA = contexts.length;
        for (const dir of contexts) {
            expect(dir).toBe(projectA);
        }

        // Session B: same controller, B's folder settings — no leakage of
        // A's outdir or templates, provider freshness preserved.
        contexts.length = 0;
        await controller.start(projectB);
        expect(fs.existsSync(path.join(outB, 'Folder B Sync'))).toBe(true);
        expect(fs.existsSync(path.join(outA, 'Folder B Sync'))).toBe(false);
        await controller.dispose();

        expect(contexts.length).toBeGreaterThan(0);
        for (const dir of contexts) {
            expect(dir).toBe(projectB);
        }
        expect(callsForA).toBeGreaterThan(0);
    });
});
