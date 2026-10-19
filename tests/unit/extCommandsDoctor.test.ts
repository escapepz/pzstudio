'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

// The doctor command only renders: the diagnostics runner is injected (the
// instance-bound factory is pinned in extUtilDoctor.test.ts), so the tests
// stub a plain runner.
import * as vscode from 'vscode';
import { registerDoctorCommand } from '../../packages/vscode-extension/src/commands/doctor';
import { createPZLogger } from '../../packages/vscode-extension/src/util/logger';
import type { ProjectDiagnosticsRunner } from '../../packages/vscode-extension/src/util/doctor';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;
const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;

/** Registers the command and returns its handler. */
async function setupHandler(
    runner: ProjectDiagnosticsRunner,
    onError?: (error: unknown) => void,
) {
    registerDoctorCommand(runner, onError);
    const calls = asMock(vscode.commands.registerCommand).mock.calls as Array<
        [string, (node?: unknown) => Promise<void>]
    >;
    const entry = calls.find(([id]) => id === 'pzstudio.doctor');
    expect(entry).toBeDefined();
    return { handler: entry![1] };
}

const projectNode = { projectDir: new UriCtor(['proj']) };

describe('pzstudio.doctor', () => {
    let runProjectDiagnostics: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        runProjectDiagnostics = vi.fn();
    });

    it('lists findings in a quick-pick with severity icons and counts', async () => {
        const { handler } = await setupHandler(
            runProjectDiagnostics as never as ProjectDiagnosticsRunner,
        );
        asMock(runProjectDiagnostics).mockResolvedValue({
            errors: 1,
            warnings: 1,
            infos: 0,
            report: {
                projectDir: '/proj',
                diagnostics: [
                    {
                        severity: 'error',
                        module: 'mods',
                        code: 'mods.missing',
                        message: "Mod folder 'ghost' is missing.",
                        hint: 'Restore the folder.',
                    },
                    {
                        severity: 'warning',
                        module: 'project',
                        code: 'project.noDescription',
                        message: 'workshop/description.txt is missing.',
                    },
                ],
            },
        });

        await handler(projectNode);

        expect(asMock(runProjectDiagnostics)).toHaveBeenCalledWith(
            projectNode.projectDir,
        );
        const pick = asMock(vscode.window.showQuickPick).mock.calls[0];
        const items = pick[0] as Array<{
            label: string;
            description: string;
            detail?: string;
        }>;
        expect(items).toHaveLength(2);
        expect(items[0].label).toBe("$(error) Mod folder 'ghost' is missing.");
        expect(items[0].description).toBe('[mods] mods.missing');
        expect(items[0].detail).toBe('Restore the folder.');
        expect(items[1].label).toBe(
            '$(warning) workshop/description.txt is missing.',
        );
        const options = pick[1] as { title: string; placeHolder: string };
        expect(options.title).toBe("Diagnostics for 'proj'");
        expect(options.placeHolder).toBe(
            '1 error(s), 1 warning(s), 0 info(s) — nothing was changed',
        );
    });

    it('reports a clean project without opening the quick-pick', async () => {
        const { handler } = await setupHandler(
            runProjectDiagnostics as never as ProjectDiagnosticsRunner,
        );
        asMock(runProjectDiagnostics).mockResolvedValue({
            errors: 0,
            warnings: 0,
            infos: 0,
            report: { projectDir: '/proj', diagnostics: [] },
        });

        await handler(projectNode);

        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
        expect(
            asMock(vscode.window.showInformationMessage),
        ).toHaveBeenCalledWith(
            "PZStudio: no problems found in 'proj'. Everything looks good.",
        );
    });

    it('warns instead of running when the workspace has no project', async () => {
        const { handler } = await setupHandler(
            runProjectDiagnostics as never as ProjectDiagnosticsRunner,
        );
        asMock(vscode.workspace.fs.stat).mockRejectedValue(new Error('ENOENT'));

        await handler(undefined);

        expect(asMock(runProjectDiagnostics)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledTimes(
            1,
        );
    });
});

/* ------------------------------------------------------------------ */
/* UX-16: user-invoked doctor failures report through the host logger  */
/* ------------------------------------------------------------------ */

describe('pzstudio.doctor error reporting (UX-16)', () => {
    let runProjectDiagnostics: ReturnType<typeof vi.fn>;
    let onError: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        runProjectDiagnostics = vi.fn();
        onError = vi.fn();
    });

    function failingRunner() {
        return runProjectDiagnostics as never as ProjectDiagnosticsRunner;
    }

    it('a failed run never rejects raw, notifies once through the handed sink and renders nothing', async () => {
        const boom = new Error('engine boom');
        asMock(runProjectDiagnostics).mockRejectedValue(boom);
        const { handler } = await setupHandler(failingRunner(), onError);

        // No unhandled command rejection: the handler resolves normally.
        await expect(handler(projectNode)).resolves.toBeUndefined();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0]).toBe(boom);
        // The command itself stays silent: the logger's notification is the
        // single popup, no quick-pick rendering on top of it.
        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showErrorMessage)).not.toHaveBeenCalled();
    });

    it('counts project resolution first: no runner failure when there is no project', async () => {
        asMock(vscode.workspace.fs.stat).mockRejectedValue(new Error('ENOENT'));
        const { handler } = await setupHandler(failingRunner(), onError);

        await handler(undefined);

        expect(asMock(runProjectDiagnostics)).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledTimes(
            1,
        );
    });

    it('through the real UX-16 logger: one notification, full detail in the channel, no auto-open', async () => {
        const channel = vscode.window.createOutputChannel('PZ Studio');
        const logger = createPZLogger(channel);
        asMock(runProjectDiagnostics).mockRejectedValue(
            new Error('engine boom'),
        );
        const { handler } = await setupHandler(failingRunner(), (error) =>
            logger.error(error as Error),
        );

        await handler(projectNode);

        // Exactly one error notification, with the localized action item.
        expect(asMock(vscode.window.showErrorMessage)).toHaveBeenCalledTimes(1);
        expect(asMock(vscode.window.showErrorMessage)).toHaveBeenCalledWith(
            'PZStudio Error: engine boom',
            'Show Details',
        );
        // The full detail (message + stack) landed in the channel record.
        const lines = asMock(channel.appendLine).mock.calls.map((c) =>
            String(c[0]),
        );
        expect(lines.some((l) => /\[ERROR\] engine boom\n/.test(l))).toBe(true);
        // Merely reporting never opens the panel.
        await Promise.resolve();
        expect(asMock(channel.show)).not.toHaveBeenCalled();
    });

    it('dismissing the notification never opens the Output panel (real logger wiring)', async () => {
        const channel = vscode.window.createOutputChannel('PZ Studio');
        const logger = createPZLogger(channel);
        asMock(vscode.window.showErrorMessage).mockResolvedValue(undefined);
        asMock(runProjectDiagnostics).mockRejectedValue(
            new Error('engine boom'),
        );
        const { handler } = await setupHandler(failingRunner(), (error) =>
            logger.error(error as Error),
        );

        await handler(projectNode);
        await Promise.resolve();
        await Promise.resolve();

        expect(asMock(channel.show)).not.toHaveBeenCalled();
    });

    it('choosing the localized Show Details action opens the PZ Studio channel with preserveFocus', async () => {
        const channel = vscode.window.createOutputChannel('PZ Studio');
        const logger = createPZLogger(channel);
        asMock(vscode.window.showErrorMessage).mockResolvedValue(
            'Show Details',
        );
        asMock(runProjectDiagnostics).mockRejectedValue(
            new Error('engine boom'),
        );
        const { handler } = await setupHandler(failingRunner(), (error) =>
            logger.error(error as Error),
        );

        await handler(projectNode);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(asMock(channel.show)).toHaveBeenCalledTimes(1);
        expect(asMock(channel.show)).toHaveBeenCalledWith(true);
    });

    it('cancellation is recorded but never presented as an unexpected error', async () => {
        const channel = vscode.window.createOutputChannel('PZ Studio');
        const logger = createPZLogger(channel);
        const cancelled = new Error('user cancelled');
        cancelled.name = 'CancellationError';
        asMock(runProjectDiagnostics).mockRejectedValue(cancelled);
        const { handler } = await setupHandler(failingRunner(), (error) =>
            logger.error(error as Error),
        );

        await handler(projectNode);

        expect(asMock(vscode.window.showErrorMessage)).not.toHaveBeenCalled();
        // Detail stays in the channel record; the sink drops the popup.
        const lines = asMock(channel.appendLine).mock.calls.map((c) =>
            String(c[0]),
        );
        expect(lines.some((l) => /\[ERROR\] user cancelled/.test(l))).toBe(
            true,
        );
    });

    it('a successful run with the same wiring keeps the normal rendering', async () => {
        asMock(runProjectDiagnostics).mockResolvedValue({
            errors: 0,
            warnings: 0,
            infos: 0,
            report: { projectDir: '/proj', diagnostics: [] },
        });
        const { handler } = await setupHandler(
            failingRunner(), // the mock is the runner; it resolves here
            onError,
        );

        await handler(projectNode);

        expect(onError).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showErrorMessage)).not.toHaveBeenCalled();
        expect(
            asMock(vscode.window.showInformationMessage),
        ).toHaveBeenCalledWith(
            "PZStudio: no problems found in 'proj'. Everything looks good.",
        );
    });
});
