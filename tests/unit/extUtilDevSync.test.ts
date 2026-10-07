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
import { DevSyncController } from '../../packages/vscode-extension/src/util/devsync';
import * as api from '@pzstudio/cli/api';
import {
    createPzStudio,
    setLogger,
    setProjectDir,
    setTemplateTransport,
    setVsCodeSettings,
    WATCH_DEBOUNCE_MS,
} from '@pzstudio/cli/api';
import type { BuildSession, PzStudio } from '@pzstudio/cli/api';
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

/** Minimal PzStudio stub: the controller only ever calls createDevSync. */
function studioStub(session: BuildSession): PzStudio {
    return {
        createDevSync: vi.fn(() => session),
    } as unknown as PzStudio;
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
    asMock(vscode.workspace.createFileSystemWatcher).mockImplementation(() => ({
        onDidCreate: (fn: (uri: never) => void) => {
            handlers.create.push(fn);
            return { dispose: disposers };
        },
        onDidChange: (fn: (uri: never) => void) => {
            handlers.change.push(fn);
            return { dispose: disposers };
        },
        onDidDelete: (fn: (uri: never) => void) => {
            handlers.delete.push(fn);
            return { dispose: disposers };
        },
        dispose: disposers,
    }));
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
