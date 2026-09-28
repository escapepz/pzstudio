'use strict';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});
vi.mock('pzstudio-cli/api', () => ({
    createDevSync: vi.fn(),
    warn: vi.fn(),
    WATCH_DEBOUNCE_MS: 10,
}));

import * as vscode from 'vscode';
import { DevSyncController } from '../../packages/vscode-extension/src/util/devsync';
import { createDevSync, warn } from 'pzstudio-cli/api';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

/** Captures the watcher registration so tests can fire file events. */
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
    };
}

describe('DevSyncController', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        handlers.create = [];
        handlers.change = [];
        handlers.delete = [];
        asMock(vscode.workspace.createFileSystemWatcher).mockImplementation(
            () => ({
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
            }),
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('start() runs the initial full build for both variants and watches the project', async () => {
        const session = fakeSession();
        asMock(createDevSync).mockReturnValue(session as never);

        const controller = new DevSyncController();
        await controller.start('/proj');

        expect(asMock(createDevSync).mock.calls[0][0]).toBe('/proj');
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
        asMock(createDevSync).mockReturnValue(session as never);

        const controller = new DevSyncController();
        await controller.start('/proj');

        handlers.create.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        handlers.delete.forEach((fn) => fn({ fsPath: '/proj/b.lua' }));
        await vi.advanceTimersByTimeAsync(10);

        expect(session.apply).toHaveBeenCalledTimes(1);
        expect(session.apply).toHaveBeenCalledWith([
            { type: 'create', path: '/proj/a.lua' },
            { type: 'change', path: '/proj/a.lua' },
            { type: 'delete', path: '/proj/b.lua' },
        ]);
        await controller.dispose();
    });

    it('reports sync errors through the CLI logger without dying', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        asMock(session.apply).mockResolvedValue({
            incremental: 0,
            scoped: [],
            fullRebuild: false,
            ignored: 0,
            errors: ['boom'],
        } as never);
        asMock(createDevSync).mockReturnValue(session as never);

        const controller = new DevSyncController();
        await controller.start('/proj');
        handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        await vi.advanceTimersByTimeAsync(10);

        expect(asMock(warn)).toHaveBeenCalledWith('- boom');
        // The session stays active after a reported error.
        expect(controller.active).toBe(true);
        await controller.dispose();
    });

    it('stop() disposes the watcher, drains the session and ignores later events', async () => {
        vi.useFakeTimers();
        const session = fakeSession();
        asMock(createDevSync).mockReturnValue(session as never);

        const controller = new DevSyncController();
        await controller.start('/proj');
        await controller.stop();

        expect(disposers).toHaveBeenCalled();
        expect(session.stop).toHaveBeenCalled();
        expect(controller.active).toBe(false);

        handlers.change.forEach((fn) => fn({ fsPath: '/proj/a.lua' }));
        await vi.advanceTimersByTimeAsync(10);
        expect(session.apply).not.toHaveBeenCalled();
    });

    it('ignores start() while already active', async () => {
        const session = fakeSession();
        asMock(createDevSync).mockReturnValue(session as never);

        const controller = new DevSyncController();
        await controller.start('/proj');
        await controller.start('/other');
        expect(asMock(createDevSync)).toHaveBeenCalledTimes(1);
        await controller.dispose();
    });
});
