'use strict';

/**
 * DevSyncStateService (UX-15 Task 1): unit pins for the pure single-writer
 * sync-state store behind the DevSync indicator. Coverage: the full
 * happy-path chain (idle→starting→syncing→stopping→idle) with run-meta
 * evolution and onDidChange payload ordering, the failure exit
 * (starting→idle via resetToIdle(err) with lastError retained), the
 * fresh-run reset (a stale lastError cleared, startedAt re-anchored), and
 * dispose idempotency.
 *
 * The shared vscode mock's EventEmitter is an inert stub (fire delivers
 * nothing), useless for a store whose contract IS event delivery — so this
 * file's mock factory swaps in a functional emitter: event() subscribes and
 * returns a Disposable, fire() delivers synchronously to current listeners,
 * dispose() detaches everyone. Constructed emitters are recorded on the
 * module for the dispose idempotency pin.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    const mock = createVscodeMock() as Record<string, unknown>;
    /** Every emitter constructed under this mock, in creation order. */
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
    type DevSyncState,
} from '../../packages/vscode-extension/src/util/devSyncState';

type EmitterRecord = { dispose: import('vitest').Mock };

/** The extras this file's mock factory adds to the vscode module. */
interface MockVscode {
    createdEmitters: EmitterRecord[];
    resetCreatedEmitters: () => void;
}

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;
const mockVscode = () => vscode as unknown as MockVscode;

const PINNED_NOW = 1731500000000;

/** A service with its onDidChange payloads recorded, in fire order. */
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

        // idle → starting: the run anchors its directory and start time.
        service.beginStarting('/proj');
        expect(service.state).toEqual({
            phase: 'starting',
            projectDir: '/proj',
            startedAt: PINNED_NOW,
        });
        // starting → syncing: the title lands; dir and start time carry over.
        service.beginSyncing('My Mod');
        expect(service.state).toEqual({
            phase: 'syncing',
            projectDir: '/proj',
            projectTitle: 'My Mod',
            startedAt: PINNED_NOW,
        });
        // syncing → stopping: teardown in progress, meta untouched.
        service.beginStopping();
        expect(service.state).toEqual({
            phase: 'stopping',
            projectDir: '/proj',
            projectTitle: 'My Mod',
            startedAt: PINNED_NOW,
        });
        // stopping → idle: the run meta is fully cleared.
        service.resetToIdle();
        expect(service.state).toEqual({ phase: 'idle' });

        // One event per transition, payload = the state `state` now returns,
        // in the exact lifecycle order.
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
