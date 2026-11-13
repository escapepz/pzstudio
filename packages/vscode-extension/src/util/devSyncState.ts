import * as vscode from 'vscode';

/**
 * DevSyncStateService (UX-15): the pure single-writer state store behind the
 * DevSync indicator. It knows NOTHING about sessions, watchers or the
 * filesystem — DevSyncManager drives it by calling the begin.../resetToIdle
 * setters in lifecycle order, and the indicator UI subscribes to
 * onDidChange (or polls state) to render it.
 *
 * Every setter assigns the complete next state and THEN fires onDidChange
 * with it, so a listener never observes a half-assigned state and the fired
 * object is exactly what `state` now returns. State objects are replaced,
 * never mutated: a snapshot a listener captured stays valid after the next
 * transition (readers must treat them as immutable).
 */

export type DevSyncPhase = 'idle' | 'starting' | 'syncing' | 'stopping';

export interface DevSyncState {
    phase: DevSyncPhase;
    projectDir?: string;
    projectTitle?: string;
    startedAt?: number;
    lastError?: string;
}

export class DevSyncStateService implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<DevSyncState>();
    readonly onDidChange: vscode.Event<DevSyncState> = this.emitter.event;

    private current: DevSyncState = { phase: 'idle' };
    private disposed = false;

    get state(): DevSyncState {
        return this.current;
    }

    /**
     * A run begins: the initial build for the project at projectDir is
     * starting. Anchors the run (directory + start time) and clears any
     * stale lastError from a previous failed run.
     */
    beginStarting(projectDir: string): void {
        this.set({
            phase: 'starting',
            projectDir,
            startedAt: Date.now(),
        });
    }

    /**
     * The initial build finished: live sync is running for projectTitle.
     * The run anchor (projectDir, startedAt) carries over.
     */
    beginSyncing(projectTitle: string): void {
        this.set({ ...this.current, phase: 'syncing', projectTitle });
    }

    /** The run is being torn down; the run meta carries over untouched. */
    beginStopping(): void {
        this.set({ ...this.current, phase: 'stopping' });
    }

    /**
     * Back to idle, dropping the whole run meta. With lastError the failed
     * run's reason is retained on the idle state for the indicator to show.
     */
    resetToIdle(lastError?: string): void {
        const next: DevSyncState = { phase: 'idle' };
        if (lastError !== undefined) {
            next.lastError = lastError;
        }
        this.set(next);
    }

    /** Idempotent: a second call is a no-op, the emitter disposes once. */
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.emitter.dispose();
    }

    /** The single-writer core: assign the next state, then publish it. */
    private set(next: DevSyncState): void {
        this.current = next;
        this.emitter.fire(next);
    }
}
