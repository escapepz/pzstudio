'use strict';

/**
 * UX-06: the Development Sync toggle's startup presentation. The palette
 * command owns the startup UI: the initial full build of both outputs runs
 * inside a native withProgress window that stays up until controller.start()
 * settles, and a startup failure is handled at the command boundary —
 * exactly one user-facing notification (the controller's [WARN] output
 * channel line is the diagnostic, and the real logger's warn path never
 * toasts), no unhandled rejection, no success signal, controller back to
 * idle. The controller contract itself (warn + cleanup + rethrow) is pinned
 * in extUtilDevSync.test.ts and is not changed here; the toggle-off stop
 * flow, picker cancellation (UX-02) and the no-project warning are pinned
 * as preserved behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { registerWatchCommand } from '../../packages/vscode-extension/src/commands/watch';
import { DevSyncController } from '../../packages/vscode-extension/src/util/devsync';
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

/** Minimal PzStudio stub: the controller only ever calls createDevSync. */
function studioStub(session: BuildSession): PzStudio {
    return {
        createDevSync: vi.fn(() => session),
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

interface Harness {
    session: ReturnType<typeof fakeSession>;
    studio: { createDevSync: import('vitest').Mock };
    handler: () => Promise<void>;
    channel: { appendLine: import('vitest').Mock };
    controller: DevSyncController;
}

/**
 * Registers the watch command on a REAL DevSyncController wired to a studio
 * stub, so progress/error handling is judged by what the command actually
 * does to the controller lifecycle — not by mock bookkeeping alone.
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
    registerWatchCommand(controller);
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
    };
}

describe('pzstudio.watch — startup progress and failure handling (UX-06)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        progressRecords = [];
        recordProgress();
        (
            vscode.window as unknown as { activeTextEditor: unknown }
        ).activeTextEditor = undefined;
    });

    it('successful start runs inside native progress and keeps the existing success message', async () => {
        withProjects('proj');
        const { handler, studio, session, controller } = setup();

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
        expect(
            asMock(vscode.window.showInformationMessage),
        ).toHaveBeenCalledWith(
            "PZStudio: development sync started for 'proj' — run the command again to stop.",
        );
        expect(controller.active).toBe(true);
        await controller.dispose();
    });

    it('progress stays active until the pending initial build resolves', async () => {
        withProjects('proj');
        let releaseStart!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        const { handler, controller } = setup(() => gate);

        let done = false;
        const running = handler().then(() => {
            done = true;
        });
        await vi.waitFor(() => expect(progressRecords).toHaveLength(1));

        // The startup is still gated: the progress window is up, the command
        // has not completed and nothing announced success yet.
        expect(progressRecords[0].settled).toBe(false);
        expect(done).toBe(false);
        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();

        releaseStart();
        await running;
        expect(progressRecords[0].settled).toBe(true);
        expect(done).toBe(true);
        expect(
            asMock(vscode.window.showInformationMessage),
        ).toHaveBeenCalledTimes(1);
        expect(controller.active).toBe(true);
        await controller.dispose();
    });

    it('startup failure is handled at the command boundary: one notification, no success, controller idle', async () => {
        withProjects('proj');
        const { handler, session, controller, channel } = setup(() =>
            Promise.reject(new Error('boom')),
        );

        // The command handles the rejection — nothing escapes the handler.
        await expect(handler()).resolves.toBeUndefined();

        // Progress closed despite the failure.
        expect(progressRecords).toHaveLength(1);
        expect(progressRecords[0].settled).toBe(true);

        // Exactly ONE user-facing notification, naming the operation, the
        // project and the reason — not a generic host error.
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
        await expect(controller.dispose()).resolves.toBeUndefined();
        expect(asMock(session.stop)).not.toHaveBeenCalled();
    });

    it('picker cancellation aborts with no progress, no startup and no warning (UX-02 preserved)', async () => {
        withProjects('one', 'two');
        const { handler, studio } = setup();
        asMock(vscode.window.showQuickPick).mockResolvedValue(undefined);

        await expect(handler()).resolves.toBeUndefined();

        expect(asMock(vscode.window.showQuickPick)).toHaveBeenCalledTimes(1);
        expect(progressRecords).toHaveLength(0);
        expect(asMock(studio.createDevSync)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showErrorMessage)).not.toHaveBeenCalled();
    });

    it('no project at all keeps the existing no-project warning with no progress or startup', async () => {
        withProjects();
        const { handler, studio } = setup();

        await expect(handler()).resolves.toBeUndefined();

        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            expect.stringContaining('no PZ project (project.json)'),
        );
        expect(progressRecords).toHaveLength(0);
        expect(asMock(studio.createDevSync)).not.toHaveBeenCalled();
    });

    it('toggle-off keeps the existing stop flow: no progress, no picker, stop message', async () => {
        withProjects('proj');
        const { handler, session, controller } = setup();

        await handler();
        expect(controller.active).toBe(true);

        await expect(handler()).resolves.toBeUndefined();

        expect(asMock(session.stop)).toHaveBeenCalled();
        expect(controller.active).toBe(false);
        expect(
            asMock(vscode.window.showInformationMessage),
        ).toHaveBeenNthCalledWith(2, 'PZStudio: development sync stopped.');
        // Only the start opened a progress window; the stop path never does.
        expect(progressRecords).toHaveLength(1);
        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
    });

    it('a second toggle while a start is in flight creates no duplicate session', async () => {
        withProjects('proj');
        let releaseStart!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        const { handler, studio, session, controller } = setup(() => gate);

        const first = handler();
        await vi.waitFor(() => expect(progressRecords).toHaveLength(1));

        // The controller's starting guard ignores the second toggle; the
        // command flow itself still resolves (existing supported semantics).
        await expect(handler()).resolves.toBeUndefined();
        expect(asMock(studio.createDevSync)).toHaveBeenCalledTimes(1);
        expect(asMock(session.start)).toHaveBeenCalledTimes(1);

        releaseStart();
        await first;
        expect(controller.active).toBe(true);
        await controller.dispose();
    });
});
