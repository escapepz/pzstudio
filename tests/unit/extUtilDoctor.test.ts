'use strict';

/**
 * The shared diagnostics runner (doc 11 §17 commit 10): createProjectDiagnostics
 * binds util/doctor's reducer to the host PzStudio instance — the run goes
 * through studio.runProjectDoctor with the explicit project fsPath (no
 * legacy anchor save/restore), and the published legacy `runProjectDoctor`
 * export stays cold from the extension path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { createProjectDiagnostics } from '../../packages/vscode-extension/src/util/doctor';
import * as api from '@pzstudio/cli/api';
import type { PzStudio } from '@pzstudio/cli/api';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;
const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;

function studioStub(report: {
    diagnostics: Array<{ severity: string }>;
}): PzStudio {
    return {
        runProjectDoctor: vi.fn(async () => report),
    } as unknown as PzStudio;
}

describe('createProjectDiagnostics (instance-bound doctor run)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(api, 'runProjectDoctor');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('runs the diagnostics through the instance with the explicit project fsPath', async () => {
        const report = {
            diagnostics: [
                { severity: 'error' },
                { severity: 'error' },
                { severity: 'warning' },
                { severity: 'info' },
                { severity: 'info' },
                { severity: 'info' },
            ],
        };
        const studio = studioStub(report);
        const runner = createProjectDiagnostics(studio);
        const projectDir = new UriCtor(['ws', 'proj']);

        const summary = await runner(projectDir as never);

        expect(asMock(studio.runProjectDoctor)).toHaveBeenCalledTimes(1);
        expect(asMock(studio.runProjectDoctor)).toHaveBeenCalledWith(
            projectDir.fsPath,
        );
        // Same reducer output the pre-migration util produced.
        expect(summary.errors).toBe(2);
        expect(summary.warnings).toBe(1);
        expect(summary.infos).toBe(3);
        expect(summary.report).toBe(report);
    });

    it('never touches the published legacy runProjectDoctor export', async () => {
        const studio = studioStub({ diagnostics: [] });
        const runner = createProjectDiagnostics(studio);

        await runner(new UriCtor(['ws', 'proj']) as never);

        // The legacy door is spied and stays cold — the extension doctor
        // path has no runtime import of it left (compile-dropped), and the
        // instance method is the only engine entry.
        expect(api.runProjectDoctor).not.toHaveBeenCalled();
        expect(asMock(studio.runProjectDoctor)).toHaveBeenCalledTimes(1);
    });
});
