'use strict';

/**
 * The shared diagnostics runner (doc 11 §17 commit 10): createProjectDiagnostics
 * binds util/doctor's reducer to the host PzStudio instance — the run goes
 * through studio.runProjectDoctor with the explicit project fsPath (no
 * legacy anchor save/restore), and the published legacy `runProjectDoctor`
 * export stays cold from the extension path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { configurationStore } from '../helpers/vscode-mock';
import { createProjectDiagnostics } from '../../packages/vscode-extension/src/util/doctor';
import { readPzStudioHostSettings } from '../../packages/vscode-extension/src/util/settings';
import { createPzStudio } from '@pzstudio/cli/api';
import * as api from '@pzstudio/cli/api';
import type { PzStudio } from '@pzstudio/cli/api';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';

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

/* ------------------------------------------------------------------ */
/* UX-05: the doctor run resolves its explicit project's folder        */
/* settings through the extension settings provider                    */
/* ------------------------------------------------------------------ */

describe('runProjectDoctor resource-scoped settings (UX-05)', () => {
    let temps: string[] = [];
    function makeTemp(): string {
        const dir = createTempDir();
        temps.push(dir);
        return dir;
    }

    afterEach(() => {
        for (const dir of temps) deleteDir(dir);
        temps = [];
        configurationStore.reset();
    });

    /** Minimal valid project (schemaVersion 2, no project-level outdir). */
    function makeProject(title: string): string {
        const dir = makeTemp();
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
                workshop: { title, visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
                schemaVersion: 2,
            }),
        );
        return dir;
    }

    it('resolves each doctor run its own folder-scoped outdir with no cross-leak', async () => {
        const projectA = makeProject('Doctor A');
        const projectB = makeProject('Doctor B');
        const outA = path.join(makeTemp(), 'out-a');
        const outB = path.join(makeTemp(), 'out-b');

        // Folder-scoped pzstudio.outdir per project folder (the projects do
        // not set outdir in project.json, so the host workspace layer wins).
        configurationStore.folders[projectA] = { 'pzstudio.outdir': outA };
        configurationStore.folders[projectB] = { 'pzstudio.outdir': outB };
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [
            { uri: vscode.Uri.file(projectA), name: 'project-a' },
            { uri: vscode.Uri.file(projectB), name: 'project-b' },
        ];

        // The exact provider wiring extension.ts installs.
        const contexts: Array<string | undefined> = [];
        const studio = createPzStudio({
            settings: (ctx) => {
                contexts.push(ctx.projectDir);
                return readPzStudioHostSettings(ctx);
            },
        });
        const runner = createProjectDiagnostics(studio);

        // The runner only reads uri.fsPath; a plain holder keeps the real
        // temp path intact for the real fs engine (a MockUri round-trip
        // would prepend a separator).
        const projectUri = (projectDir: string) =>
            ({ fsPath: projectDir }) as never as vscode.Uri;

        // The outdirs do not exist on disk: the engine's outDirMissing
        // finding names the resolved path — the honest proof of WHICH
        // outdir the doctor consumed.
        const missingDirs = async (projectDir: string) => {
            const summary = await runner(projectUri(projectDir));
            return summary.report.diagnostics.filter(
                (d) => d.code === 'filesystem.outDirMissing',
            );
        };

        const missingA = await missingDirs(projectA);
        expect(missingA).toHaveLength(1);
        expect(missingA[0].message).toContain(outA);

        const summaryA = await runner(projectUri(projectA));
        expect(JSON.stringify(summaryA.report.diagnostics)).not.toContain(outB);

        const missingB = await missingDirs(projectB);
        expect(missingB).toHaveLength(1);
        expect(missingB[0].message).toContain(outB);

        const summaryB = await runner(projectUri(projectB));
        expect(JSON.stringify(summaryB.report.diagnostics)).not.toContain(outA);

        // Every doctor run resolved settings for its OWN project context
        // (two extra runs above double the count, order intact).
        expect(contexts).toEqual([projectA, projectA, projectB, projectB]);
    });
});
