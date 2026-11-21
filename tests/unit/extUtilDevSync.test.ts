'use strict';

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
import {
    DevSyncManager,
    DevSyncStateService,
} from '../../packages/vscode-extension/src/util/devSyncState';
import { createPZLogger } from '../../packages/vscode-extension/src/util/logger';
import { devSyncErrorActions } from '../../packages/vscode-extension/src/extension';
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
        error: (m: any) => calls.push({ method: 'error', message: m }),
        verbose: (m: any) => calls.push({ method: 'verbose', message: m }),
    };
    return { calls, logger };
}

function withoutUsageNotice(
    calls: Array<{ method: string; message: any }>,
): Array<{ method: string; message: any }> {
    return calls.filter(
        (c) =>
            !(
                c.method === 'info' &&
                String(c.message).startsWith('PZ Studio saves local usage logs')
            ),
    );
}

const handlers = {
    create: [] as Array<(uri: { fsPath: string }) => void>,
    change: [] as Array<(uri: { fsPath: string }) => void>,
    delete: [] as Array<(uri: { fsPath: string }) => void>,
};
const disposers = vi.fn();

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

function studioStub(
    session: BuildSession,
    resolveOutDir: (...args: unknown[]) => unknown = () => '/out',
): PzStudio & { resolveOutDir: import('vitest').Mock } {
    return {
        createDevSync: vi.fn(() => session),
        resolveOutDir: vi.fn(resolveOutDir),
    } as unknown as PzStudio & { resolveOutDir: import('vitest').Mock };
}

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
        expect(logger.calls).toContainEqual({
            method: 'error',
            message:
                'Development sync: 1 change(s) failed to apply. Show Details lists every failure.',
        });
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

        expect(logger.calls.filter((c) => c.method === 'warn')).toEqual([
            { method: 'warn', message: 'boom' },
        ]);
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

describe('DevSyncController watcher base + failure surfaces (d09-B2)', () => {
    it('bases the watcher on the containing workspace folder and logs the registration', async () => {
        const session = fakeSession();
        const studio = studioStub(session);
        const logger = recordingLogger();
        const folderUri = vscode.Uri.file('/ws');
        asMock(vscode.workspace.getWorkspaceFolder).mockReturnValue({
            uri: folderUri,
            name: 'ws',
        });

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/ws/dev_loop_mod');

        const pattern = asMock(vscode.workspace.createFileSystemWatcher).mock
            .calls[0]?.[0] as unknown as {
            base: { fsPath: string; toString(): string };
            pattern: string;
        };
        expect(pattern.pattern).toBe('**/*');
        expect(pattern.base.fsPath).toBe(folderUri.fsPath);
        expect(logger.calls).toContainEqual({
            method: 'info',
            message: `Development sync: watching '${pattern.base.toString()}' for changes (**/*).`,
        });
        await controller.dispose();
    });

    it('falls back to the project-dir base when the project resolves outside every workspace folder', async () => {
        const session = fakeSession();
        const studio = studioStub(session);
        const logger = recordingLogger();
        asMock(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined);

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/proj');

        const pattern = asMock(vscode.workspace.createFileSystemWatcher).mock
            .calls[0]?.[0] as unknown as {
            base: { fsPath: string };
            pattern: string;
        };
        expect(pattern.pattern).toBe('**/*');
        expect(pattern.base.fsPath).toBe(vscode.Uri.file('/proj').fsPath);
        await controller.dispose();
    });

    it('surfaces watcher registration failures and never leaves a silently dead session', async () => {
        asMock(vscode.workspace.createFileSystemWatcher).mockImplementation(
            () => {
                throw new Error('watcher service unavailable');
            },
        );
        const session = fakeSession();
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await expect(controller.start('/proj')).rejects.toThrow(
            'watcher service unavailable',
        );

        const errorCall = logger.calls.find((c) => c.method === 'error');
        expect(errorCall).toBeDefined();
        expect(String(errorCall?.message)).toContain(
            'watcher registration failed',
        );
        expect(String(errorCall?.message)).toContain(
            'watcher service unavailable',
        );
        expect(controller.active).toBe(false);
        expect(session.stop).not.toHaveBeenCalled();
    });

    it('surfaces event-processing exceptions through the error channel without dying', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start('/proj');

        (
            controller as unknown as {
                ignoreMatcher: unknown;
            }
        ).ignoreMatcher = () => {
            throw new Error('matcher boom');
        };
        expect(() =>
            handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' })),
        ).not.toThrow();
        const errorCall = logger.calls.find((c) => c.method === 'error');
        expect(errorCall).toBeDefined();
        expect(String(errorCall?.message)).toContain('matcher boom');
        expect(controller.active).toBe(true);
        await controller.dispose();
    });
});

describe('DevSyncController pre-filtering (UX-09)', () => {
    const proj = '/proj';
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
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: sourceFile }],
        ]);
        await controller.dispose();
    });

    it('reports filtered events once per batch at verbose level, never per-event (DEC-9)', async () => {
        const session = fakeSession();
        const studio = studioStub(session, () => outA);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        handlers.create.forEach((fn) =>
            fn({ fsPath: `${outA}/My Title/workshop.txt` }),
        );
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/.git/config' }));
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: sourceFile }],
        ]);
        expect(logger.calls).toContainEqual({
            method: 'verbose',
            message:
                'Filtered 3 watcher event(s) below the output root or outside the project — not synced.',
        });
        expect(logger.calls.filter((c) => c.method === 'warn')).toEqual([]);
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();
        expect(logger.calls.filter((c) => c.method === 'verbose')).toHaveLength(
            1,
        );
        await controller.dispose();
    });

    it('reports a rejected flush through the error surface and stays alive (DEC-6)', async () => {
        const session = fakeSession();
        asMock(session.apply).mockRejectedValue(new Error('apply exploded'));
        const studio = studioStub(session);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();
        await drain();

        expect(
            logger.calls.some(
                (c) =>
                    c.method === 'error' &&
                    c.message instanceof Error &&
                    c.message.message === 'apply exploded',
            ),
        ).toBe(true);
        expect(controller.active).toBe(true);
        asMock(session.apply).mockResolvedValue({ ...emptyResult } as never);
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();
        expect(appliedBatches(session)).toHaveLength(2);
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

        handlers.change.forEach((fn) => fn({ fsPath: nestedProjectJson }));
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(
            readsAfterStart,
        );
        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: nestedProjectJson }],
        ]);

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

        root = outB;
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        await flushOnce();
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(4);

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
        const studio = studioStub(session, () => outA);
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);
        asMock(session.apply).mockResolvedValue({
            ...emptyResult,
            fullRebuild: true,
        } as never);

        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        await flushOnce();

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
        asMock(session.apply).mockResolvedValue({
            ...emptyResult,
            errors: ['rebuild boom'],
        } as never);

        root = outB;
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        await flushOnce();

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

        healthy = false;
        handlers.change.forEach((fn) => fn({ fsPath: projectJsonEvent }));
        handlers.change.forEach((fn) => fn({ fsPath: outAFile }));
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();
        expect(appliedBatches(session)).toEqual([
            [
                { type: 'change', path: projectJsonEvent },
                { type: 'change', path: sourceFile },
            ],
        ]);

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

        root = outB;
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(
            readsAfterStart,
        );
        await flushOnce();
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
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(4);

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
        await flushOnce();

        await controller.stop();
        const secondSession = fakeSession();
        const secondStudio = studioStub(secondSession, () => '/proj/out-new');
        const secondController = new DevSyncController(
            secondStudio,
            logger.logger,
        );
        await secondController.start(proj);

        release({ ...emptyResult, fullRebuild: true });
        await drain();
        expect(asMock(studio.resolveOutDir).mock.calls.length).toBe(
            readsAfterStart + 1,
        );

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

describe('DevSyncController root-level ignore rules (gitignore integration)', () => {
    const proj = '/proj';
    const sourceFile = '/proj/my_mod/media/lua/hello.lua';
    const emptyResult = {
        incremental: 0,
        scoped: [],
        fullRebuild: false,
        ignored: 0,
        errors: [] as string[],
    };

    const flushOnce = () => vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
    const drain = () => vi.advanceTimersByTimeAsync(0);

    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function serveRules(content: string): void {
        const encoder = new TextEncoder();
        const list = [
            ['.gitignore', vscode.FileType.File],
            ['my_mod', vscode.FileType.Directory],
        ];
        asMock(vscode.workspace.fs.readDirectory).mockImplementation(
            async (uri: unknown) => {
                if ((uri as { toString(): string }).toString() !== proj) {
                    return [];
                }
                return list;
            },
        );
        asMock(vscode.workspace.fs.readFile).mockImplementation(
            async (uri: unknown) => {
                const target = (uri as { toString(): string }).toString();
                if (target === `${proj}/.gitignore`) {
                    return encoder.encode(content);
                }
                throw new Error(`not found: ${target}`);
            },
        );
    }

    function appliedBatches(
        session: ReturnType<typeof fakeSession>,
    ): FileDelta[][] {
        return asMock(session.apply).mock.calls.map(
            (call) => call[0] as FileDelta[],
        );
    }

    it('drops source events matching the root .gitignore through the predicate', async () => {
        serveRules('scratch/**\n*.log\n');
        const session = fakeSession();
        const studio = studioStub(session, () => '/proj/dist');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) =>
            fn({ fsPath: `${proj}/scratch/out.lua` }),
        );
        handlers.change.forEach((fn) => fn({ fsPath: `${proj}/notes.log` }));
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: sourceFile }],
        ]);
        await controller.dispose();
    });

    it('the output-root rail wins over a dist/** rule: the dist event drops by the rail and a nested dist stays source', async () => {
        serveRules('dist/**\n');
        const session = fakeSession();
        const studio = studioStub(session, () => '/proj/dist');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) =>
            fn({ fsPath: '/proj/dist/My Title/x.lua' }),
        );
        handlers.change.forEach((fn) =>
            fn({ fsPath: `${proj}/my_mod/dist/x.lua` }),
        );
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [
                { type: 'change', path: `${proj}/my_mod/dist/x.lua` },
                { type: 'change', path: sourceFile },
            ],
        ]);
        await controller.dispose();
    });

    it('delivers the root rule-file event (dot-entry exemption) and still re-steers the predicate', async () => {
        serveRules('scratch/**\n');
        const session = fakeSession();
        const studio = studioStub(session, () => '/proj/dist');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) => fn({ fsPath: `${proj}/.gitignore` }));
        serveRules('*.log\n');
        await drain();

        handlers.change.forEach((fn) =>
            fn({ fsPath: `${proj}/scratch/out.lua` }),
        );
        handlers.change.forEach((fn) => fn({ fsPath: `${proj}/notes.log` }));
        handlers.change.forEach((fn) => fn({ fsPath: sourceFile }));
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [
                { type: 'change', path: `${proj}/.gitignore` },
                { type: 'change', path: `${proj}/scratch/out.lua` },
                { type: 'change', path: sourceFile },
            ],
        ]);
        await controller.dispose();
    });

    it('delivers a mod-scoped .gitignore event — the engine re-baselines the owning mod (watch parity)', async () => {
        serveRules('');
        const session = fakeSession();
        const studio = studioStub(session, () => '/proj/dist');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        handlers.change.forEach((fn) =>
            fn({ fsPath: `${proj}/my_mod/.gitignore` }),
        );
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: `${proj}/my_mod/.gitignore` }],
        ]);
        await controller.dispose();
    });

    it('a re-baseline reloads the rules alongside the filter-root correction', async () => {
        serveRules('');
        const session = fakeSession();
        const studio = studioStub(session, () => '/proj/dist');
        const logger = recordingLogger();

        const controller = new DevSyncController(studio, logger.logger);
        await controller.start(proj);

        serveRules('scratch/**\n');
        asMock(session.apply).mockResolvedValue({
            ...emptyResult,
            scoped: [{ modId: 'my_mod', variants: ['main'] }],
        } as never);
        handlers.change.forEach((fn) =>
            fn({ fsPath: `${proj}/my_mod/mod.info` }),
        );
        await flushOnce();
        await drain();

        handlers.change.forEach((fn) =>
            fn({ fsPath: `${proj}/scratch/out.lua` }),
        );
        await flushOnce();

        expect(appliedBatches(session)).toEqual([
            [{ type: 'change', path: `${proj}/my_mod/mod.info` }],
        ]);
        await controller.dispose();
    });
});

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

    function makeProject(
        title: string,
        options: { legacyRootTitle?: boolean } = {},
    ): string {
        const dir = makeTemp();
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
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

        expect(fs.existsSync(path.join(projectDir, 'dist', 'Fresh Sync'))).toBe(
            true,
        );
        expect(fs.existsSync(path.join(out1, 'Fresh Sync'))).toBe(false);
        expect(fs.existsSync(path.join(out2, 'Fresh Sync'))).toBe(false);
        expect(fs.readdirSync(legacyOut)).toEqual([]);
        expect(provider.mock.calls.length).toBeGreaterThan(0);
        for (const call of provider.mock.calls) {
            expect(call).toEqual([{ projectDir }]);
        }

        const providerReadsAfterStart = provider.mock.calls.length;
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
                expect(provider.mock.calls.length).toBeGreaterThan(
                    providerReadsAfterStart,
                ),
            { timeout: 5000 },
        );

        expect(createDevSyncSpy).toHaveBeenCalledTimes(1);
        expect(provider.mock.calls.length).toBeGreaterThanOrEqual(2);
        for (const call of provider.mock.calls) {
            expect(call).toEqual([{ projectDir }]);
        }
        expect(fs.readdirSync(legacyOut)).toEqual([]);
        expect(withoutUsageNotice(L1.calls)).toEqual([]);
        expect(sentinel.isCacheValid).not.toHaveBeenCalled();

        await controller.dispose();
    });

    it('routes plan-input emissions ([MIGRATION], cold template acquisition) to the instance logger', async () => {
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
        expect(has('warn', '[MIGRATION]')).toBe(true);
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

        expect(withoutUsageNotice(L1.calls)).toEqual([]);
        expect(
            fs.existsSync(path.join(projectDir, 'dist', 'Routed Sync')),
        ).toBe(true);
        expect(fs.readdirSync(legacyOut)).toEqual([]);
    });
});

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

        const builtOut = mainOut(
            path.join(projectDir, 'dist'),
            'Filtered Sync',
            'media',
            'lua',
            'hello.lua',
        );
        expect(fs.readFileSync(builtOut, 'utf8')).toBe('print("v1")');

        const session = createDevSyncSpy.mock.results[0]!.value as BuildSession;
        const applySpy = vi.spyOn(session, 'apply');

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

        await vi.waitFor(
            () => expect(fs.readFileSync(builtOut, 'utf8')).toBe('print("v2")'),
            { timeout: 5000 },
        );

        expect(withoutUsageNotice(L1.calls)).toEqual([]);
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
        const distRoot = path.join(projectDir, 'dist');
        expect(
            fs.readFileSync(
                mainOut(
                    distRoot,
                    'Transition Gate',
                    'media',
                    'lua',
                    'hello.lua',
                ),
                'utf8',
            ),
        ).toBe('print("v1")');

        const session = createDevSyncSpy.mock.results[0]!.value as BuildSession;
        const applySpy = vi.spyOn(session, 'apply');
        const startupReads = resolveSpy.mock.calls.length;

        layers = makeLayers(outB);
        handlers.change.forEach((fn) =>
            fn({ fsPath: path.join(projectDir, 'project.json') }),
        );
        expect(resolveSpy.mock.calls.length).toBe(startupReads + 1);
        await vi.waitFor(
            () => expect(resolveSpy.mock.calls.length).toBe(startupReads + 2),
            { timeout: 5000 },
        );
        expect(applySpy).toHaveBeenCalledTimes(1);
        expect(applySpy.mock.calls[0]![0]).toEqual([
            { type: 'change', path: path.join(projectDir, 'project.json') },
        ]);
        expect(
            fs.existsSync(
                mainOut(
                    distRoot,
                    'Transition Gate',
                    'media',
                    'lua',
                    'hello.lua',
                ),
            ),
        ).toBe(true);
        expect(fs.existsSync(mainOut(outB, 'Transition Gate'))).toBe(false);

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
            distRoot,
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
                            path.join(projectDir, 'dist'),
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

        layers = makeLayers(outB);
        handlers.change.forEach((fn) =>
            fn({ fsPath: path.join(projectDir, 'my_mod', 'mod.info') }),
        );
        await vi.waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1), {
            timeout: 5000,
        });
        await vi.waitFor(
            () => expect(resolveSpy.mock.calls.length).toBe(startupReads + 1),
            { timeout: 5000 },
        );
        expect(applySpy).toHaveBeenCalledTimes(1);
        const firstResult = await applySpy.mock.results[0]!.value;
        expect(firstResult.scoped).toEqual([
            { modId: 'my_mod', variants: ['main', 'development'] },
        ]);
        expect(
            fs.existsSync(
                mainOut(
                    path.join(projectDir, 'dist'),
                    'Scoped Move',
                    'media',
                    'lua',
                    'hello.lua',
                ),
            ),
        ).toBe(true);
        expect(fs.existsSync(mainOut(outB, 'Scoped Move'))).toBe(false);

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
            path.join(projectDir, 'dist'),
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

    it('a mod-scoped .gitignore change re-baselines the owning mod (end-to-end watch parity)', async () => {
        seedWorkshopTemplateCache();
        const projectDir = makeProject('Gitignore Rebaseline');
        const out = path.join(makeTemp(), 'out');
        const V2 = recordingLogger();
        const studio = createPzStudio({
            logger: V2.logger,
            settings: () => makeLayers(out),
        });
        const createDevSyncSpy = vi.spyOn(studio, 'createDevSync');
        const controller = new DevSyncController(studio, V2.logger);
        await controller.start(projectDir);
        const session = createDevSyncSpy.mock.results[0]!.value as BuildSession;
        const applySpy = vi.spyOn(session, 'apply');

        fs.writeFileSync(
            path.join(projectDir, 'my_mod', '.gitignore'),
            'scratch/\n',
        );
        handlers.change.forEach((fn) =>
            fn({ fsPath: path.join(projectDir, 'my_mod', '.gitignore') }),
        );
        await vi.waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1), {
            timeout: 5000,
        });
        const result = await applySpy.mock.results[0]!.value;
        expect(result.errors).toEqual([]);
        expect(result.scoped).toEqual([
            { modId: 'my_mod', variants: ['main', 'development'] },
        ]);

        await controller.dispose();
    });
});

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

        await controller.start(projectA);
        expect(
            fs.existsSync(path.join(projectA, 'dist', 'Folder A Sync')),
        ).toBe(true);
        expect(fs.existsSync(path.join(outA, 'Folder A Sync'))).toBe(false);
        expect(fs.existsSync(path.join(outB, 'Folder A Sync'))).toBe(false);
        await controller.dispose();

        const callsForA = contexts.length;
        for (const dir of contexts) {
            expect(dir).toBe(projectA);
        }

        contexts.length = 0;
        await controller.start(projectB);
        expect(
            fs.existsSync(path.join(projectB, 'dist', 'Folder B Sync')),
        ).toBe(true);
        expect(fs.existsSync(path.join(outB, 'Folder B Sync'))).toBe(false);
        expect(fs.existsSync(path.join(outA, 'Folder B Sync'))).toBe(false);
        await controller.dispose();

        expect(contexts.length).toBeGreaterThan(0);
        for (const dir of contexts) {
            expect(dir).toBe(projectB);
        }
        expect(callsForA).toBeGreaterThan(0);
    });
});

describe('DevSync apply-error notification actions (UX-15 Task 4)', () => {
    function wiredManager(
        channel: unknown,
        applyImpl: () => Promise<unknown>,
    ): {
        session: ReturnType<typeof fakeSession>;
        controller: DevSyncController;
        manager: DevSyncManager;
    } {
        const session = fakeSession();
        asMock(session.apply).mockImplementation(applyImpl as never);
        const studio = studioStub(session);
        const controller = new DevSyncController(
            studio,
            createPZLogger(
                channel as never,
                devSyncErrorActions(() => manager),
            ),
        );
        const manager = new DevSyncManager(
            controller,
            new DevSyncStateService(),
        );
        return { session, controller, manager };
    }

    const drain = async (): Promise<void> => {
        for (let i = 0; i < 20; i++) {
            await Promise.resolve();
        }
    };

    async function runFailingBatch(
        channel: unknown,
        applyImpl: () => Promise<unknown>,
    ): Promise<ReturnType<typeof wiredManager>> {
        vi.useFakeTimers();
        const wired = wiredManager(channel, applyImpl);
        await wired.manager.start('/proj');
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
        await drain();
        return wired;
    }

    const failedApply = async () => ({
        incremental: 0,
        scoped: [],
        fullRebuild: false,
        ignored: 0,
        errors: ['boom'],
    });

    it('offers Show Details and Stop Sync; choosing Stop Sync stops the manager', async () => {
        const channel = vscode.window.createOutputChannel('PZ Studio');
        asMock(vscode.window.showErrorMessage).mockResolvedValue('Stop Sync');
        const { session, controller, manager } = await runFailingBatch(
            channel,
            failedApply,
        );

        const errors = asMock(vscode.window.showErrorMessage).mock.calls;
        expect(errors).toHaveLength(1);
        expect(String(errors[0][0])).toContain(
            'Development sync: 1 change(s) failed to apply',
        );
        expect(errors[0].slice(1)).toEqual(['Show Details', 'Stop Sync']);

        expect(asMock(session.stop)).toHaveBeenCalled();
        expect(controller.active).toBe(false);
        expect(manager.state.phase).toBe('idle');

        await manager.dispose();
    });

    it('Show Details still opens the channel and never stops the run (DEC-6 preserved)', async () => {
        const channel = vscode.window.createOutputChannel('PZ Studio');
        asMock(vscode.window.showErrorMessage).mockResolvedValue(
            'Show Details',
        );
        const { session, controller, manager } = await runFailingBatch(
            channel,
            failedApply,
        );

        expect(
            asMock((channel as { show: unknown }).show),
        ).toHaveBeenCalledWith(true);
        expect(asMock(session.stop)).not.toHaveBeenCalled();
        expect(controller.active).toBe(true);
        expect(manager.state.phase).toBe('syncing');

        await manager.dispose();
    });

    it('the action factory offers Stop Sync only while a run is in flight', async () => {
        const controller = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
            dispose: vi.fn(async () => {}),
        } as unknown as DevSyncController;
        const manager = new DevSyncManager(
            controller,
            new DevSyncStateService(),
        );
        const actions = devSyncErrorActions(() => manager);

        expect(actions()).toEqual([]);

        await manager.start('/proj');
        const offered = actions();
        expect(offered).toHaveLength(1);
        expect(offered[0].label).toBe('Stop Sync');

        offered[0].run();
        for (let i = 0; i < 20; i++) {
            await Promise.resolve();
        }
        expect(manager.state.phase).toBe('idle');
        expect(actions()).toEqual([]);

        await manager.dispose();
    });
});
