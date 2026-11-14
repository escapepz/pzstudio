import * as vscode from 'vscode';
import { DevSyncController } from './devsync';

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

/**
 * DevSyncManager (UX-15): the lifecycle wrapper UI and commands consume —
 * the single compositor that drives DevSyncController and publishes every
 * transition through DevSyncStateService. It adds two pieces of logic of
 * its own: the queued-stop protocol and the atomic start gate (the
 * amendment of the earlier hand-off ruling that gave the manager none —
 * two commands stacked over the async project picker both read `idle` and
 * both started; the controller's own re-entrancy guard is a silent no-op,
 * so the second run re-anchored the state and clobbered a queued stop).
 *
 * The queued-stop protocol exists because the controller alone cannot
 * survive a stop during its initial build: controller.start() assigns
 * session and watcher only AFTER its await settles, so a controller.stop()
 * fired in that window is silently overwritten and the session survives.
 * The manager therefore treats stop() while `starting` as a request only —
 * when the start settles it runs controller.stop() IMMEDIATELY and lands
 * `idle`, so the state path is starting → (start settles) → stopping →
 * idle and the just-published session never outlives the request.
 *
 * The start gate is the counterpart: a start() from any non-idle phase
 * throws instead of re-anchoring the run. The UI toggle still gates on
 * `state.phase` (UX wording) and re-checks after its async project
 * resolution; the manager gate is the authoritative backstop — the check
 * and the `beginStarting` anchor land on the same synchronous tick, so JS
 * cannot interleave a second start() between them.
 */
export class DevSyncManager implements vscode.Disposable {
    private readonly controller: DevSyncController;
    private readonly service: DevSyncStateService;
    readonly onDidChange: vscode.Event<DevSyncState>;
    /** Set by stop() while the initial build is still in flight. */
    private stopRequested = false;
    /** The in-flight start() settlement — dispose awaits it. */
    private startPromise: Promise<void> | undefined;

    constructor(controller: DevSyncController, service: DevSyncStateService) {
        this.controller = controller;
        this.service = service;
        this.onDidChange = service.onDidChange;
    }

    get state(): DevSyncState {
        return this.service.state;
    }

    /**
     * Starts the full build plus live sync for the project at projectDir.
     * The failure of the underlying start is rethrown after the state lands
     * `idle` with the reason, so a command can still notify while the
     * indicator already shows the settled outcome.
     */
    async start(projectDir: string): Promise<void> {
        // Atomic re-entrancy gate — see the class doc. Placed BEFORE any
        // state mutation: a refused second start must not reset
        // stopRequested or re-anchor the in-flight run it raced against.
        if (this.service.state.phase !== 'idle') {
            throw new Error(
                'Development sync is already starting or running for this workspace.',
            );
        }
        // Folder-name title — the commands/watch.ts convention (uri.path's
        // last segment); both separators fold so a Windows fsPath still
        // titles by folder. Never workshop.title (unreadable mid-start).
        const projectTitle =
            projectDir.split(/[\\/]/).filter(Boolean).pop() ?? projectDir;
        this.stopRequested = false;
        this.service.beginStarting(projectDir);
        const run = this.settleStart(projectDir, projectTitle);
        this.startPromise = run;
        try {
            await run;
        } finally {
            if (this.startPromise === run) {
                this.startPromise = undefined;
            }
        }
    }

    /**
     * Stops the run. While syncing this tears down immediately
     * (beginStopping → controller.stop → idle); while starting it only
     * queues — see the queued-stop protocol above; while idle or already
     * stopping it is a no-op, making repeated calls harmless.
     */
    async stop(): Promise<void> {
        if (this.service.state.phase === 'starting') {
            this.stopRequested = true;
            return;
        }
        if (this.service.state.phase !== 'syncing') {
            return;
        }
        this.service.beginStopping();
        await this.controller.stop();
        this.service.resetToIdle();
    }

    /**
     * Full teardown, safe mid-run: a syncing run goes through the same
     * stop semantics as stop(); a starting run settles through the queued
     * stop so the session the start is about to publish cannot outlive the
     * manager. Then the controller and the service are disposed.
     */
    async dispose(): Promise<void> {
        if (this.service.state.phase === 'starting') {
            this.stopRequested = true;
            await this.startPromise?.catch(() => undefined);
        }
        await this.stop();
        await this.controller.dispose();
        this.service.dispose();
    }

    /**
     * The start settlement: success publishes `syncing` — unless a stop was
     * requested while the build was in flight, which is executed RIGHT HERE
     * before anything else observes the session. A failure lands `idle`
     * with the reason and rethrows.
     */
    private async settleStart(
        projectDir: string,
        projectTitle: string,
    ): Promise<void> {
        try {
            await this.controller.start(projectDir);
        } catch (e) {
            this.stopRequested = false;
            this.service.resetToIdle(
                e instanceof Error ? e.message : String(e),
            );
            throw e;
        }
        if (this.stopRequested) {
            this.stopRequested = false;
            this.service.beginStopping();
            await this.controller.stop();
            this.service.resetToIdle();
            return;
        }
        this.service.beginSyncing(projectTitle);
    }
}
