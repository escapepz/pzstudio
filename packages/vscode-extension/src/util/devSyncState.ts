import * as vscode from 'vscode';
import { DevSyncController } from './devsync';

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

    beginStarting(projectDir: string): void {
        this.set({
            phase: 'starting',
            projectDir,
            startedAt: Date.now(),
        });
    }

    beginSyncing(projectTitle: string): void {
        this.set({ ...this.current, phase: 'syncing', projectTitle });
    }

    beginStopping(): void {
        this.set({ ...this.current, phase: 'stopping' });
    }

    resetToIdle(lastError?: string): void {
        const next: DevSyncState = { phase: 'idle' };
        if (lastError !== undefined) {
            next.lastError = lastError;
        }
        this.set(next);
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.emitter.dispose();
    }

    private set(next: DevSyncState): void {
        this.current = next;
        this.emitter.fire(next);
    }
}

export class DevSyncManager implements vscode.Disposable {
    private readonly controller: DevSyncController;
    private readonly service: DevSyncStateService;
    readonly onDidChange: vscode.Event<DevSyncState>;
    private stopRequested = false;
    private startPromise: Promise<void> | undefined;

    constructor(controller: DevSyncController, service: DevSyncStateService) {
        this.controller = controller;
        this.service = service;
        this.onDidChange = service.onDidChange;
    }

    get state(): DevSyncState {
        return this.service.state;
    }

    async start(projectDir: string): Promise<void> {
        if (this.service.state.phase !== 'idle') {
            throw new Error(
                'Development sync is already starting or running for this workspace.',
            );
        }
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

    async dispose(): Promise<void> {
        if (this.service.state.phase === 'starting') {
            this.stopRequested = true;
            await this.startPromise?.catch(() => undefined);
        }
        await this.stop();
        await this.controller.dispose();
        this.service.dispose();
    }

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
