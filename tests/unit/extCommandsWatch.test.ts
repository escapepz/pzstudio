'use strict';

/**
 * UX-06: the Development Sync toggle's startup presentation — the initial
 * full build of both outputs runs inside a native withProgress window that
 * stays up until the start settles, and a startup failure is handled at the
 * command boundary: exactly one user-facing notification, no unhandled
 * rejection, no false-active state.
 *
 * UX-15 Task 3 reshapes the toggle's plumbing and its feedback: the command
 * is a thin GATED dispatch over the shared DevSyncManager (extension.ts owns
 * the single instance — the command never touches DevSyncController
 * directly anymore), and the success popups are GONE — the status-bar item
 * is the run's source of truth (spinner + folder while in flight, muted
 * circle-slash while off). Only the start-fail toast remains. The gate is
 * load-bearing: the manager deliberately has no start-guard, so a start
 * happens only from idle (including idle-with-lastError), a toggle during
 * `syncing` stops, a toggle during `starting` queues the stop through the
 * manager's queued-stop protocol and a toggle during `stopping` is a no-op.
 *
 * The status-bar item pins: state-driven text/icon/tooltip per phase, the
 * muted idle paint, and item.command === 'pzstudio.watch' (a click executes
 * the existing palette command — no manifest entry, no new registration).
 *
 * The controller contract itself (warn + cleanup + rethrow) is pinned
 * in extUtilDevSync.test.ts and is not changed here; the toggle-off stop
 * flow's lifecycle side, picker cancellation (UX-02) and the no-project
 * warning are pinned as preserved behavior.
 *
 * The shared vscode mock's EventEmitter is an inert stub (fire delivers
 * nothing), useless for a subscription whose contract IS event delivery —
 * this file's mock factory swaps in the same functional emitter the
 * devSyncState suites use (test-local swap).
 */

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
 * UX-09 — resolveOutDir. The root sits outside every project used here, so
 * these startup-presentation pins are unaffected by filtering decisions.
 */
function studioStub(session: BuildSession): PzStudio {
    return {
        createDevSync: vi.fn(() => session),
        resolveOutDir: vi.fn(() => '/proj-out'),
    } as unknown as PzStudio;
}

interface ProgressRecord {
    options: { location?: unknown; title?: string; cancellable?: boolean };
    /** Flips once the progress window's promise settles either way. */
    settled: boolean;
}

let progressRecords: ProgressRecord[] = [];

/**
 * Records every withProgress invocation — options plus the exact promise
 * the command awaits — while keeping the default pass-through behavior, so
 * "the progress window stayed up" is observable without any timers.
 */
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

/** Workspace whose roots (and only those) contain a project.json. */
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
    // Picker labels tolerate unreadable project.json files.
    asMock(vscode.workspace.fs.readFile).mockRejectedValue(new Error('ENOENT'));
}

/** The status-bar item created by the wiring, as a plain mutable record. */
interface StatusBarRecord {
    text: string;
    tooltip?: string;
    color?: { id: string };
    command?: string;
    show: import('vitest').Mock;
    dispose: import('vitest').Mock;
}

/** The last status-bar item the mock handed out. */
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

/**
 * Registers the watch command AND the status-bar item on a REAL
 * DevSyncManager (real controller over a studio stub), so gating, state
 * transitions and status-bar rendering are judged by what the command
 * actually does to the shared lifecycle — not by mock bookkeeping alone.
 * `startImpl` gates the initial build inside the session.
 */
function setup(startImpl?: () => Promise<void>): Harness {
    const session = fakeSession();
    if (startImpl) {
        asMock(session.start).mockImplementation(startImpl);
    }
    const studio = studioStub(session);
    const channel = vscode.window.createOutputChannel('PZ Studio') as {
        appendLine: import('vitest').Mock;
    };
    // The REAL extension logger: its warn() only writes the channel line —
    // proving one-notification-on-failure needs the actual warn path, not a
    // mock that could hide a second toast.
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
        // The progress window closed only after the startup settled.
        expect(progressRecords[0].settled).toBe(true);
        expect(asMock(studio.createDevSync)).toHaveBeenCalledWith(
            fsPath(['proj']),
        );
        expect(asMock(session.start)).toHaveBeenCalledWith([
            'main',
            'development',
        ]);

        // UX-15 behavior change: the success popups are gone — the status
        // bar is the source of truth. Not ONE information toast on the
        // whole flow (the load-bearing regression guard).
        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();

        // The toggle dispatched through the manager: the controller runs
        // AND the manager published `syncing`.
        expect(controller.active).toBe(true);
        expect(manager.state.phase).toBe('syncing');

        // The status bar shows the spinner + the project folder, default
        // color, a tooltip naming the project, and the click runs the
        // existing palette command.
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

        // The startup is still gated: the progress window is up, the command
        // has not completed, nothing announced success and the status bar
        // already shows the starting run (folder derived from the anchor).
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

        // The command handles the rejection — nothing escapes the handler.
        await expect(handler()).resolves.toBeUndefined();

        // Progress closed despite the failure.
        expect(progressRecords).toHaveLength(1);
        expect(progressRecords[0].settled).toBe(true);

        // Exactly ONE user-facing notification, naming the operation, the
        // project and the reason — not a generic host error (the start-fail
        // toast UX-15 deliberately kept).
        const errors = asMock(vscode.window.showErrorMessage).mock.calls;
        expect(errors).toHaveLength(1);
        expect(errors[0][0]).toContain(
            "development sync failed to start for 'proj'",
        );
        expect(errors[0][0]).toContain('boom');

        // No success signal, no stray warnings.
        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();

        // The controller's diagnostic warning still landed in the output
        // channel (the real logger.warn never toasts — the notification
        // above is the only user surface for this failure).
        expect(channel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('[WARN]'),
        );
        expect(channel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('boom'),
        );

        // No false-active state, no half-registered watcher, disposal stays
        // clean (the half-started session is dropped without a stop call —
        // the exact cleanup contract pinned in extUtilDevSync.test.ts).
        expect(
            asMock(vscode.workspace.createFileSystemWatcher),
        ).not.toHaveBeenCalled();
        expect(controller.active).toBe(false);
        expect(manager.state.phase).toBe('idle');
        expect(manager.state.lastError).toBe('boom');
        // The status bar shows the settled outcome, not a stuck spinner.
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
        // The status bar stayed on its initial idle paint.
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
        // UX-15 behavior change: no stop toast either — not ONE information
        // toast across start and stop.
        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();
        // Only the start opened a progress window; the stop path never does.
        expect(progressRecords).toHaveLength(1);
        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
        // The status bar settled back to muted off.
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

        // The gated toggle sees `starting` and queues the stop through the
        // manager: the second invocation resolves immediately, opens no
        // second progress window and creates no duplicate session.
        await expect(handler()).resolves.toBeUndefined();
        expect(progressRecords).toHaveLength(1);
        expect(asMock(studio.createDevSync)).toHaveBeenCalledTimes(1);
        expect(asMock(session.start)).toHaveBeenCalledTimes(1);

        releaseStart();
        await first;
        // The queued stop drained the freshly settled run — the session the
        // start was about to publish never outlives the request.
        expect(controller.active).toBe(false);
        expect(asMock(session.stop)).toHaveBeenCalled();
        expect(item.text).toBe('$(circle-slash) DevSync off');
        await manager.dispose();
    });
});

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

        // Initial paint: muted off item, click wired to the EXISTING
        // `pzstudio.watch` command — no manifest entry, no second
        // registration, so the click runs the identical gated toggle.
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

        // The gated toggle entered `stopping` (beginStopping fired before
        // the teardown awaits): the item stays on the syncing visual.
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
