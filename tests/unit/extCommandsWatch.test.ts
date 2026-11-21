'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    const mock = createVscodeMock() as Record<string, unknown>;
    class FunctionalEventEmitter<T> {
        private listeners: Array<(value: T) => unknown> = [];
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
    return mock;
});

import * as vscode from 'vscode';
import {
    registerWatchCommand,
    registerDevSyncStatusBar,
} from '../../packages/vscode-extension/src/commands/watch';
import { DevSyncController } from '../../packages/vscode-extension/src/util/devsync';
import {
    DevSyncManager,
    DevSyncStateService,
} from '../../packages/vscode-extension/src/util/devSyncState';
import { createPZLogger } from '../../packages/vscode-extension/src/util/logger';
import type { BuildSession, PzStudio } from '@pzstudio/cli/api';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;
const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;
const folder = (parts: string[]) => ({
    uri: new UriCtor(parts),
    name: parts[parts.length - 1] || 'root',
});
const fsPath = (parts: string[]) => new UriCtor(parts).fsPath;

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

function studioStub(session: BuildSession): PzStudio {
    return {
        createDevSync: vi.fn(() => session),
        resolveOutDir: vi.fn(() => '/proj-out'),
    } as unknown as PzStudio;
}

interface ProgressRecord {
    options: { location?: unknown; title?: string; cancellable?: boolean };
    settled: boolean;
}

let progressRecords: ProgressRecord[] = [];

function recordProgress(): void {
    asMock(vscode.window.withProgress).mockImplementation(
        async (options: ProgressRecord['options'], task: () => unknown) => {
            const record: ProgressRecord = { options, settled: false };
            const promise = Promise.resolve()
                .then(task)
                .finally(() => {
                    record.settled = true;
                });
            progressRecords.push(record);
            return promise;
        },
    );
}

function withProjects(...roots: string[]) {
    (
        vscode.workspace as unknown as { workspaceFolders: unknown }
    ).workspaceFolders = roots.map((r) => folder([r]));
    asMock(vscode.workspace.fs.stat).mockImplementation(
        async (uri: { path: string }) => {
            const match = uri.path.match(/^(.+)\/project\.json$/);
            if (match && roots.map((r) => '/' + r).includes(match[1])) {
                return { type: vscode.FileType.File };
            }
            throw new Error('ENOENT');
        },
    );
    asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
    asMock(vscode.workspace.fs.readFile).mockRejectedValue(new Error('ENOENT'));
}

interface StatusBarRecord {
    text: string;
    tooltip?: string;
    color?: { id: string };
    command?: string;
    show: import('vitest').Mock;
    dispose: import('vitest').Mock;
}

function statusBarRecord(): StatusBarRecord {
    const results = asMock(vscode.window.createStatusBarItem).mock
        .results as Array<{ value: StatusBarRecord }>;
    expect(results.length).toBeGreaterThan(0);
    return results[results.length - 1].value;
}

interface Harness {
    session: ReturnType<typeof fakeSession>;
    studio: { createDevSync: import('vitest').Mock };
    handler: () => Promise<void>;
    channel: { appendLine: import('vitest').Mock };
    controller: DevSyncController;
    manager: DevSyncManager;
    item: StatusBarRecord;
}

function setup(startImpl?: () => Promise<void>): Harness {
    const session = fakeSession();
    if (startImpl) {
        asMock(session.start).mockImplementation(startImpl);
    }
    const studio = studioStub(session);
    const channel = vscode.window.createOutputChannel('PZ Studio') as {
        appendLine: import('vitest').Mock;
    };
    const controller = new DevSyncController(
        studio,
        createPZLogger(channel as never),
    );
    const manager = new DevSyncManager(controller, new DevSyncStateService());
    registerWatchCommand(manager);
    registerDevSyncStatusBar(manager);
    const calls = asMock(vscode.commands.registerCommand).mock.calls as Array<
        [string, () => Promise<void>]
    >;
    const entry = calls.find(([id]) => id === 'pzstudio.watch');
    expect(entry).toBeDefined();
    return {
        session,
        studio: studio as unknown as { createDevSync: import('vitest').Mock },
        handler: entry![1],
        channel,
        controller,
        manager,
        item: statusBarRecord(),
    };
}

describe('pzstudio.watch — gated manager toggle: startup progress and failure handling (UX-06 + UX-15)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        progressRecords = [];
        recordProgress();
        (
            vscode.window as unknown as { activeTextEditor: unknown }
        ).activeTextEditor = undefined;
    });

    it('successful start runs inside native progress and lands the status bar on the running project — no success popup', async () => {
        withProjects('proj');
        const { handler, studio, session, controller, manager, item } = setup();

        await expect(handler()).resolves.toBeUndefined();

        expect(progressRecords).toHaveLength(1);
        const options = progressRecords[0].options;
        expect(options.location).toBe(vscode.ProgressLocation.Notification);
        expect(options.cancellable).toBe(false);
        expect(options.title).toBe(
            "PZStudio: starting development sync for 'proj'…",
        );
        expect(progressRecords[0].settled).toBe(true);
        expect(asMock(studio.createDevSync)).toHaveBeenCalledWith(
            fsPath(['proj']),
        );
        expect(asMock(session.start)).toHaveBeenCalledWith([
            'main',
            'development',
        ]);

        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();

        expect(controller.active).toBe(true);
        expect(manager.state.phase).toBe('syncing');

        expect(item.text).toBe('$(sync~spin) DevSync: proj');
        expect(item.color).toBeUndefined();
        expect(item.tooltip).toBe(
            "PZStudio: development sync running for 'proj' — click to stop.",
        );
        expect(item.command).toBe('pzstudio.watch');

        await manager.dispose();
    });

    it('progress stays active until the pending initial build resolves; mid-gate the status bar shows the starting phase', async () => {
        withProjects('proj');
        let releaseStart!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        const { handler, controller, manager, item } = setup(() => gate);

        let done = false;
        const running = handler().then(() => {
            done = true;
        });
        await vi.waitFor(() => expect(progressRecords).toHaveLength(1));

        expect(progressRecords[0].settled).toBe(false);
        expect(done).toBe(false);
        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();
        expect(item.text).toBe('$(sync~spin) DevSync: proj');
        expect(item.tooltip).toContain('is starting');

        releaseStart();
        await running;
        expect(progressRecords[0].settled).toBe(true);
        expect(done).toBe(true);
        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();
        expect(controller.active).toBe(true);
        await manager.dispose();
    });

    it('startup failure is handled at the command boundary: one notification, no success, manager idle, status bar back to off', async () => {
        withProjects('proj');
        const { handler, session, controller, manager, channel, item } = setup(
            () => Promise.reject(new Error('boom')),
        );

        await expect(handler()).resolves.toBeUndefined();

        expect(progressRecords).toHaveLength(1);
        expect(progressRecords[0].settled).toBe(true);

        const errors = asMock(vscode.window.showErrorMessage).mock.calls;
        expect(errors).toHaveLength(1);
        expect(errors[0][0]).toContain(
            "development sync failed to start for 'proj'",
        );
        expect(errors[0][0]).toContain('boom');

        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();

        expect(channel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('[WARN]'),
        );
        expect(channel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('boom'),
        );

        expect(
            asMock(vscode.workspace.createFileSystemWatcher),
        ).not.toHaveBeenCalled();
        expect(controller.active).toBe(false);
        expect(manager.state.phase).toBe('idle');
        expect(manager.state.lastError).toBe('boom');
        expect(item.text).toBe('$(circle-slash) DevSync off');
        expect(item.color).toBeDefined();
        await expect(manager.dispose()).resolves.toBeUndefined();
        expect(asMock(session.stop)).not.toHaveBeenCalled();
    });

    it('picker cancellation aborts with no progress, no startup and no warning (UX-02 preserved)', async () => {
        withProjects('one', 'two');
        const { handler, studio, manager, item } = setup();
        asMock(vscode.window.showQuickPick).mockResolvedValue(undefined);

        await expect(handler()).resolves.toBeUndefined();

        expect(asMock(vscode.window.showQuickPick)).toHaveBeenCalledTimes(1);
        expect(progressRecords).toHaveLength(0);
        expect(asMock(studio.createDevSync)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showErrorMessage)).not.toHaveBeenCalled();
        expect(manager.state.phase).toBe('idle');
        expect(item.text).toBe('$(circle-slash) DevSync off');
        await manager.dispose();
    });

    it('no project at all keeps the existing no-project warning with no progress or startup', async () => {
        withProjects();
        const { handler, studio, manager, item } = setup();

        await expect(handler()).resolves.toBeUndefined();

        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            expect.stringContaining('no PZ project (project.json)'),
        );
        expect(progressRecords).toHaveLength(0);
        expect(asMock(studio.createDevSync)).not.toHaveBeenCalled();
        expect(manager.state.phase).toBe('idle');
        expect(item.text).toBe('$(circle-slash) DevSync off');
        await manager.dispose();
    });

    it('toggle-off stops through the manager with no popups at all: the muted off item is the signal', async () => {
        withProjects('proj');
        const { handler, session, controller, manager, item } = setup();

        await handler();
        expect(controller.active).toBe(true);
        expect(item.text).toBe('$(sync~spin) DevSync: proj');

        await expect(handler()).resolves.toBeUndefined();

        expect(asMock(session.stop)).toHaveBeenCalled();
        expect(controller.active).toBe(false);
        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();
        expect(progressRecords).toHaveLength(1);
        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
        expect(item.text).toBe('$(circle-slash) DevSync off');
        expect(item.color).toBeDefined();
        expect(item.tooltip).toBe('PZStudio: development sync is off.');
        await manager.dispose();
    });

    it('a second toggle while a start is in flight queues the stop — no duplicate session, the run drains', async () => {
        withProjects('proj');
        let releaseStart!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        const { handler, studio, session, controller, manager, item } = setup(
            () => gate,
        );

        const first = handler();
        await vi.waitFor(() => expect(progressRecords).toHaveLength(1));
        expect(item.text).toBe('$(sync~spin) DevSync: proj');

        await expect(handler()).resolves.toBeUndefined();
        expect(progressRecords).toHaveLength(1);
        expect(asMock(studio.createDevSync)).toHaveBeenCalledTimes(1);
        expect(asMock(session.start)).toHaveBeenCalledTimes(1);

        releaseStart();
        await first;
        expect(controller.active).toBe(false);
        expect(asMock(session.stop)).toHaveBeenCalled();
        expect(item.text).toBe('$(circle-slash) DevSync off');
        await manager.dispose();
    });

    it('a manager.start() from a non-idle phase throws instead of re-anchoring the in-flight run', async () => {
        withProjects('proj');
        let releaseStart!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        const { studio, session, manager } = setup(() => gate);

        const first = startViaManager(manager);
        await vi.waitFor(() => expect(manager.state.phase).toBe('starting'));

        await expect(manager.start(fsPath(['proj']))).rejects.toThrow(
            /already starting/,
        );
        expect(manager.state.phase).toBe('starting');
        expect(asMock(studio.createDevSync)).toHaveBeenCalledTimes(1);

        releaseStart();
        await first;
        expect(manager.state.phase).toBe('syncing');
        expect(asMock(session.start)).toHaveBeenCalledTimes(1);
        await manager.dispose();
    });

    it('two stacked commands resolving over the same tick start exactly one run — the loser fails honestly', async () => {
        withProjects('proj');
        const { handler, studio, session, manager, item } = setup();

        await expect(Promise.all([handler(), handler()])).resolves.toEqual([
            undefined,
            undefined,
        ]);
        await vi.waitFor(() => expect(manager.state.phase).toBe('syncing'));
        expect(asMock(studio.createDevSync)).toHaveBeenCalledTimes(1);
        expect(asMock(session.start)).toHaveBeenCalledTimes(1);
        expect(item.text).toBe('$(sync~spin) DevSync: proj');
        expect(asMock(vscode.window.showErrorMessage)).toHaveBeenCalledTimes(1);
        expect(
            asMock(vscode.window.showErrorMessage).mock.calls[0][0],
        ).toContain('already starting');
        await manager.dispose();
    });
});

function startViaManager(manager: DevSyncManager): Promise<void> {
    return manager.start(fsPath(['proj']));
}

describe('DevSync status-bar item (UX-15)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        progressRecords = [];
        recordProgress();
        (
            vscode.window as unknown as { activeTextEditor: unknown }
        ).activeTextEditor = undefined;
    });

    it('paints muted-off at registration and wires the click to the existing palette command', () => {
        withProjects('proj');
        const { manager, item } = setup();

        expect(item.text).toBe('$(circle-slash) DevSync off');
        expect(item.color?.id).toBe('descriptionForeground');
        expect(item.tooltip).toBe('PZStudio: development sync is off.');
        expect(item.command).toBe('pzstudio.watch');
        expect(item.show).toHaveBeenCalled();
        return manager.dispose();
    });

    it('stopping keeps the syncing visual (spinner + folder) until the stop settles', async () => {
        withProjects('proj');
        let releaseStop!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseStop = resolve;
        });
        const { handler, session, item, manager } = setup();
        await handler();
        asMock(session.stop).mockImplementation(async () => {
            await gate;
        });

        const off = handler();
        await vi.waitFor(() => expect(item.tooltip).toContain('is stopping'));
        expect(item.text).toBe('$(sync~spin) DevSync: proj');
        expect(item.color).toBeUndefined();

        releaseStop();
        await off;
        expect(item.text).toBe('$(circle-slash) DevSync off');
        await manager.dispose();
    });
});
