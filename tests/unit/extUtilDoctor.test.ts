'use strict';

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
        expect(summary.errors).toBe(2);
        expect(summary.warnings).toBe(1);
        expect(summary.infos).toBe(3);
        expect(summary.report).toBe(report);
    });

    it('never touches the published legacy runProjectDoctor export', async () => {
        const studio = studioStub({ diagnostics: [] });
        const runner = createProjectDiagnostics(studio);

        await runner(new UriCtor(['ws', 'proj']) as never);

        expect(api.runProjectDoctor).not.toHaveBeenCalled();
        expect(asMock(studio.runProjectDoctor)).toHaveBeenCalledTimes(1);
    });
});

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

        configurationStore.folders[projectA] = { 'pzstudio.outdir': outA };
        configurationStore.folders[projectB] = { 'pzstudio.outdir': outB };
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [
            { uri: vscode.Uri.file(projectA), name: 'project-a' },
            { uri: vscode.Uri.file(projectB), name: 'project-b' },
        ];

        const contexts: Array<string | undefined> = [];
        const studio = createPzStudio({
            settings: (ctx) => {
                contexts.push(ctx.projectDir);
                return readPzStudioHostSettings(ctx);
            },
        });
        const runner = createProjectDiagnostics(studio);

        const projectUri = (projectDir: string) =>
            ({ fsPath: projectDir }) as never as vscode.Uri;

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

        expect(contexts).toEqual([projectA, projectA, projectB, projectB]);
    });
});

describe('runProjectDoctor gameBuild forwarding (UX-11)', () => {
    afterEach(() => {
        configurationStore.reset();
    });

    it("the default '' keeps the single-argument call (check skipped)", async () => {
        const studio = studioStub({ diagnostics: [] });
        const runner = createProjectDiagnostics(studio);
        const uri = new UriCtor(['ws', 'proj']);

        await runner(uri as never);

        const calls = asMock(studio.runProjectDoctor).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe(uri.fsPath);
        expect(calls[0]).toHaveLength(1);
    });

    it("an explicitly cleared '' also keeps the single-argument call", async () => {
        configurationStore.global['pzstudio.gameBuild'] = '';
        const studio = studioStub({ diagnostics: [] });
        const runner = createProjectDiagnostics(studio);

        await runner(new UriCtor(['ws', 'proj']) as never);

        const calls = asMock(studio.runProjectDoctor).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0]).toHaveLength(1);
    });

    it('a nonempty configured build is forwarded as the options argument', async () => {
        configurationStore.global['pzstudio.gameBuild'] = '42.20.1';
        const studio = studioStub({ diagnostics: [] });
        const runner = createProjectDiagnostics(studio);
        const uri = new UriCtor(['ws', 'proj']);

        await runner(uri as never);

        const calls = asMock(studio.runProjectDoctor).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual([uri.fsPath, { gameBuild: '42.20.1' }]);
    });
});

describe('gameBuild compatibility reporting (real engine, UX-11)', () => {
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
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [];
    });

    function makeProject(title: string, pzBuildCompatibility?: string): string {
        const dir = makeTemp();
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
                workshop: { title, visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
                schemaVersion: 2,
                ...(pzBuildCompatibility !== undefined
                    ? { pzBuildCompatibility }
                    : {}),
            }),
        );
        return dir;
    }

    function makeRunnerWithSettingsProvider() {
        return createProjectDiagnostics(
            createPzStudio({
                settings: (ctx) => readPzStudioHostSettings(ctx),
            }),
        );
    }

    const projectUri = (projectDir: string) =>
        ({ fsPath: projectDir }) as never as vscode.Uri;

    const compatFindings = async (projectDir: string) =>
        (
            await makeRunnerWithSettingsProvider()(projectUri(projectDir))
        ).report.diagnostics.filter(
            (d) => d.code === 'buildTarget.compatibility',
        );

    it("the default '' skips the compatibility check even when a range is declared", async () => {
        makeProject('No default build');
        const findings = await compatFindings(temps[0]);
        expect(findings).toHaveLength(0);
    });

    it('a compatible configured build produces no compatibility warning', async () => {
        makeProject('Compatible build', '42.x');
        configurationStore.global['pzstudio.gameBuild'] = '42.20.1';
        const findings = await compatFindings(temps[0]);
        expect(findings).toHaveLength(0);
    });

    it('a mismatched configured build produces the existing advisory warning', async () => {
        makeProject('Mismatched build', '42.x');
        configurationStore.global['pzstudio.gameBuild'] = '41.50.0';
        const findings = await compatFindings(temps[0]);
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe('warning');
        expect(findings[0].module).toBe('buildTarget');
        expect(findings[0].message).toContain("'42.x'");
        expect(findings[0].message).toContain("'41.50.0'");
        expect(findings[0].hint).toContain('never blocks a build');
    });

    it('multi-root folders resolve their own gameBuild values with no leakage', async () => {
        const projectA = makeProject('Build A', '42.x');
        const projectB = makeProject('Build B', '42.x');
        configurationStore.folders[projectA] = {
            'pzstudio.gameBuild': '42.20.1',
        };
        configurationStore.folders[projectB] = {
            'pzstudio.gameBuild': '41.9.0',
        };
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [
            { uri: vscode.Uri.file(projectA), name: 'project-a' },
            { uri: vscode.Uri.file(projectB), name: 'project-b' },
        ];

        const compat = async (dir: string) =>
            (
                await makeRunnerWithSettingsProvider()(projectUri(dir))
            ).report.diagnostics.filter(
                (d) => d.code === 'buildTarget.compatibility',
            );

        const findingsA = await compat(projectA);
        const findingsB = await compat(projectB);
        expect(findingsA).toHaveLength(0);
        expect(findingsB).toHaveLength(1);
        expect(findingsB[0].message).toContain("'41.9.0'");
        expect(findingsB[0].message).not.toContain('42.20.1');
    });
});
