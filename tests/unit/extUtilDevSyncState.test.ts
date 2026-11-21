'use strict';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    const mock = createVscodeMock() as Record<string, unknown>;
    const createdEmitters: EmitterRecord[] = [];
    class FunctionalEventEmitter<T> {
        private listeners: Array<(value: T) => unknown> = [];
        constructor() {
            createdEmitters.push(this);
        }
        readonly event = (listener: (value: T) => unknown) => {
            this.listeners.push(listener);
            return {
                dispose: () => {
                    const index = this.listeners.indexOf(listener);
                    if (index >= 0) {
                        this.listeners.splice(index, 1);
                    }
                },
            };
        };
        readonly fire = (value: T): void => {
            for (const listener of [...this.listeners]) {
                listener(value);
            }
        };
        readonly dispose = vi.fn(() => {
            this.listeners = [];
        });
    }
    mock.EventEmitter = FunctionalEventEmitter;
    mock.createdEmitters = createdEmitters;
    mock.resetCreatedEmitters = () => {
        createdEmitters.splice(0);
    };
    return mock;
});

import * as vscode from 'vscode';
import {
    DevSyncStateService,
    DevSyncManager,
    type DevSyncState,
} from '../../packages/vscode-extension/src/util/devSyncState';
import { DevSyncController } from '../../packages/vscode-extension/src/util/devsync';
import { WATCH_DEBOUNCE_MS } from '@pzstudio/cli/api';
import type { BuildSession, PzStudio } from '@pzstudio/cli/api';

type EmitterRecord = { dispose: import('vitest').Mock };

interface MockVscode {
    createdEmitters: EmitterRecord[];
    resetCreatedEmitters: () => void;
}

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;
const mockVscode = () => vscode as unknown as MockVscode;

const PINNED_NOW = 1731500000000;

function recordingService() {
    const service = new DevSyncStateService();
    const events: DevSyncState[] = [];
    service.onDidChange((state) => events.push(state));
    return { service, events };
}

beforeEach(() => {
    mockVscode().resetCreatedEmitters();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('DevSyncStateService (UX-15 Task 1)', () => {
    it('starts idle with no run meta', () => {
        const service = new DevSyncStateService();

        expect(service.state).toEqual({ phase: 'idle' });
    });

    it('drives the full happy-path chain, firing each next state in order', () => {
        vi.spyOn(Date, 'now').mockReturnValue(PINNED_NOW);
        const { service, events } = recordingService();

        service.beginStarting('/proj');
        expect(service.state).toEqual({
            phase: 'starting',
            projectDir: '/proj',
            startedAt: PINNED_NOW,
        });
        service.beginSyncing('My Mod');
        expect(service.state).toEqual({
            phase: 'syncing',
            projectDir: '/proj',
            projectTitle: 'My Mod',
            startedAt: PINNED_NOW,
        });
        service.beginStopping();
        expect(service.state).toEqual({
            phase: 'stopping',
            projectDir: '/proj',
            projectTitle: 'My Mod',
            startedAt: PINNED_NOW,
        });
        service.resetToIdle();
        expect(service.state).toEqual({ phase: 'idle' });

        expect(events).toEqual([
            {
                phase: 'starting',
                projectDir: '/proj',
                startedAt: PINNED_NOW,
            },
            {
                phase: 'syncing',
                projectDir: '/proj',
                projectTitle: 'My Mod',
                startedAt: PINNED_NOW,
            },
            {
                phase: 'stopping',
                projectDir: '/proj',
                projectTitle: 'My Mod',
                startedAt: PINNED_NOW,
            },
            { phase: 'idle' },
        ]);
        expect(events.map((state) => state.phase)).toEqual([
            'starting',
            'syncing',
            'stopping',
            'idle',
        ]);
    });

    it('resetToIdle(error) exits a failed start: idle with lastError retained, run meta cleared', () => {
        vi.spyOn(Date, 'now').mockReturnValue(PINNED_NOW);
        const { service, events } = recordingService();

        service.beginStarting('/proj');
        service.resetToIdle('No pzstudio project found.');

        expect(service.state).toEqual({
            phase: 'idle',
            lastError: 'No pzstudio project found.',
        });
        expect(service.state.projectDir).toBeUndefined();
        expect(service.state.projectTitle).toBeUndefined();
        expect(service.state.startedAt).toBeUndefined();
        expect(events.map((state) => state.phase)).toEqual([
            'starting',
            'idle',
        ]);
        expect(events[1]).toEqual({
            phase: 'idle',
            lastError: 'No pzstudio project found.',
        });
    });

    it('a fresh beginStarting after a failed run clears the stale lastError and re-anchors startedAt', () => {
        vi.spyOn(Date, 'now')
            .mockReturnValueOnce(PINNED_NOW)
            .mockReturnValueOnce(PINNED_NOW + 5000);
        const { service, events } = recordingService();

        service.beginStarting('/proj');
        service.resetToIdle('boom');
        service.beginStarting('/proj2');

        expect(service.state).toEqual({
            phase: 'starting',
            projectDir: '/proj2',
            startedAt: PINNED_NOW + 5000,
        });
        expect(events.map((state) => state.phase)).toEqual([
            'starting',
            'idle',
            'starting',
        ]);
    });

    it('dispose() is idempotent: the emitter is disposed exactly once', () => {
        const service = new DevSyncStateService();
        expect(mockVscode().createdEmitters).toHaveLength(1);

        expect(() => {
            service.dispose();
            service.dispose();
        }).not.toThrow();

        expect(
            asMock(mockVscode().createdEmitters[0].dispose),
        ).toHaveBeenCalledTimes(1);
    });
});

describe('DevSyncManager (UX-15 Task 2)', () => {
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

    const handlers = {
        create: [] as Array<(uri: { fsPath: string }) => void>,
        change: [] as Array<(uri: { fsPath: string }) => void>,
        delete: [] as Array<(uri: { fsPath: string }) => void>,
    };
    const disposers = vi.fn();

    beforeEach(() => {
        handlers.create = [];
        handlers.change = [];
        handlers.delete = [];
        asMock(vscode.workspace.createFileSystemWatcher).mockImplementation(
            () => {
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
            },
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('start success: beginStarting then beginSyncing, title derived from the folder name', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        const studio = studioStub(session);
        const controller = new DevSyncController(
            studio,
            recordingLogger().logger,
        );
        const { service, events } = recordingService();
        const manager = new DevSyncManager(controller, service);

        await manager.start('/projects/my_mod');

        expect(service.state).toEqual({
            phase: 'syncing',
            projectDir: '/projects/my_mod',
            projectTitle: 'my_mod',
            startedAt: expect.any(Number),
        });
        expect(events.map((state) => state.phase)).toEqual([
            'starting',
            'syncing',
        ]);
        expect(asMock(studio.createDevSync).mock.calls[0][0]).toBe(
            '/projects/my_mod',
        );
        expect(controller.active).toBe(true);
        await manager.dispose();
    });

    it('start failure: resetToIdle(message) keeps lastError, no syncing phase ever fires', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        asMock(session.start).mockRejectedValue(new Error('boom'));
        const studio = studioStub(session);
        const controller = new DevSyncController(
            studio,
            recordingLogger().logger,
        );
        const { service, events } = recordingService();
        const manager = new DevSyncManager(controller, service);

        await expect(manager.start('/proj')).rejects.toThrow('boom');

        expect(service.state).toEqual({
            phase: 'idle',
            lastError: 'boom',
        });
        expect(events.map((state) => state.phase)).toEqual([
            'starting',
            'idle',
        ]);
        expect(controller.active).toBe(false);
    });

    it('stop during syncing: beginStopping, the controller drains, back to idle with no orphan watcher', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        const studio = studioStub(session);
        const controller = new DevSyncController(
            studio,
            recordingLogger().logger,
        );
        const { service, events } = recordingService();
        const manager = new DevSyncManager(controller, service);

        await manager.start('/proj');
        await manager.stop();

        expect(asMock(session.stop)).toHaveBeenCalledTimes(1);
        expect(disposers).toHaveBeenCalled();
        expect(controller.active).toBe(false);
        expect(service.state).toEqual({ phase: 'idle' });
        expect(events.map((state) => state.phase)).toEqual([
            'starting',
            'syncing',
            'stopping',
            'idle',
        ]);

        handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
        expect(asMock(session.apply)).not.toHaveBeenCalled();
    });

    it('stop during starting queues: the settled start stops the controller IMMEDIATELY and lands idle', async () => {
        const session = fakeSession();
        let releaseStart!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        asMock(session.start).mockImplementation(() => gate);
        const studio = studioStub(session);
        const controller = new DevSyncController(
            studio,
            recordingLogger().logger,
        );
        const { service, events } = recordingService();
        const manager = new DevSyncManager(controller, service);

        const startPromise = manager.start('/proj');
        expect(service.state.phase).toBe('starting');
        expect(controller.active).toBe(false);

        await manager.stop();
        expect(asMock(session.stop)).not.toHaveBeenCalled();
        expect(service.state.phase).toBe('starting');
        expect(events.map((state) => state.phase)).toEqual(['starting']);

        releaseStart();
        await startPromise;

        expect(asMock(session.stop)).toHaveBeenCalledTimes(1);
        expect(controller.active).toBe(false);
        expect(service.state).toEqual({ phase: 'idle' });
        expect(events.map((state) => state.phase)).toEqual([
            'starting',
            'stopping',
            'idle',
        ]);
    });

    it('stop is idempotent: idle no-op, one drain for overlapping stops, idle again after', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        const studio = studioStub(session);
        const controller = new DevSyncController(
            studio,
            recordingLogger().logger,
        );
        const { service } = recordingService();
        const manager = new DevSyncManager(controller, service);

        await manager.stop();
        expect(service.state).toEqual({ phase: 'idle' });
        expect(asMock(session.stop)).not.toHaveBeenCalled();

        await manager.start('/proj');
        const first = manager.stop();
        const second = manager.stop();
        await first;
        await second;
        expect(asMock(session.stop)).toHaveBeenCalledTimes(1);
        expect(service.state).toEqual({ phase: 'idle' });

        await manager.stop();
        expect(asMock(session.stop)).toHaveBeenCalledTimes(1);
        expect(service.state).toEqual({ phase: 'idle' });
    });

    it('dispose during syncing: stop semantics then dispose, no orphan watcher, service emitter down', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        const studio = studioStub(session);
        const controller = new DevSyncController(
            studio,
            recordingLogger().logger,
        );
        const { service, events } = recordingService();
        const manager = new DevSyncManager(controller, service);

        await manager.start('/proj');
        await manager.dispose();

        expect(asMock(session.stop)).toHaveBeenCalledTimes(1);
        expect(disposers).toHaveBeenCalled();
        expect(controller.active).toBe(false);
        expect(service.state).toEqual({ phase: 'idle' });
        expect(events.map((state) => state.phase)).toEqual([
            'starting',
            'syncing',
            'stopping',
            'idle',
        ]);

        handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
        expect(asMock(session.apply)).not.toHaveBeenCalled();

        expect(
            asMock(mockVscode().createdEmitters[0].dispose),
        ).toHaveBeenCalledTimes(1);
    });

    it('dispose during starting: the in-flight run settles through the queued stop, nothing survives', async () => {
        const session = fakeSession();
        let releaseStart!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        asMock(session.start).mockImplementation(() => gate);
        const studio = studioStub(session);
        const controller = new DevSyncController(
            studio,
            recordingLogger().logger,
        );
        const { service, events } = recordingService();
        const manager = new DevSyncManager(controller, service);

        const startPromise = manager.start('/proj');
        expect(service.state.phase).toBe('starting');

        releaseStart();
        await manager.dispose();

        expect(asMock(session.stop)).toHaveBeenCalledTimes(1);
        expect(controller.active).toBe(false);
        expect(service.state).toEqual({ phase: 'idle' });
        expect(events.map((state) => state.phase)).toEqual([
            'starting',
            'stopping',
            'idle',
        ]);

        await startPromise;
        expect(asMock(session.stop)).toHaveBeenCalledTimes(1);
    });
});
