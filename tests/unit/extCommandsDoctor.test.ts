'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

// The doctor util is the api surface to the CLI bundle; the command test
// only covers rendering, so the engine call is stubbed here.
vi.mock('../../packages/vscode-extension/src/util/doctor', () => ({
    runProjectDiagnostics: vi.fn(),
}));

import * as vscode from 'vscode';
import { registerDoctorCommand } from '../../packages/vscode-extension/src/commands/doctor';
import { runProjectDiagnostics } from '../../packages/vscode-extension/src/util/doctor';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;
const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;

/** Registers the command and returns its handler. */
async function setupHandler() {
    registerDoctorCommand();
    const calls = asMock(vscode.commands.registerCommand).mock.calls as Array<
        [string, (node?: unknown) => Promise<void>]
    >;
    const entry = calls.find(([id]) => id === 'pzstudio.doctor');
    expect(entry).toBeDefined();
    return { handler: entry![1] };
}

const projectNode = { projectDir: new UriCtor(['proj']) };

describe('pzstudio.doctor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('lists findings in a quick-pick with severity icons and counts', async () => {
        const { handler } = await setupHandler();
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
        const { handler } = await setupHandler();
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
        const { handler } = await setupHandler();
        asMock(vscode.workspace.fs.stat).mockRejectedValue(new Error('ENOENT'));

        await handler(undefined);

        expect(asMock(runProjectDiagnostics)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledTimes(
            1,
        );
    });
});
