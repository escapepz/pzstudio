'use strict';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { registerModinfoCommand } from '../../packages/vscode-extension/src/commands/modinfo';
import type { ExecutePZCommand } from '../../packages/vscode-extension/src/util/execute';
import * as api from '@pzstudio/cli/api';
import type { PzStudio } from '@pzstudio/cli/api';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;
const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;

function studioStub(targets: string[]): PzStudio & {
    resolveModInfoTargets: import('vitest').Mock;
} {
    return {
        resolveModInfoTargets: vi.fn(() => targets),
    } as unknown as PzStudio & { resolveModInfoTargets: import('vitest').Mock };
}

function executeStub(): {
    execute: ExecutePZCommand;
    mock: import('vitest').Mock;
} {
    const mock = vi.fn(async () => {});
    return { execute: mock as unknown as ExecutePZCommand, mock };
}

function realTarget(withModInfo: boolean): string {
    const dir = createTempDir();
    if (withModInfo) {
        fs.writeFileSync(path.join(dir, 'mod.info'), 'existing');
    }
    return dir;
}

const projectUri = () => new UriCtor(['ws', 'proj']);

describe('pzstudio.modinfoGenerate', () => {
    let temps: string[] = [];

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(api, 'setProjectDir');
        vi.spyOn(api, 'resolveModInfoTargets');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        for (const dir of temps) deleteDir(dir);
        temps = [];
    });

    async function setupHandler(studio: PzStudio, execute: ExecutePZCommand) {
        registerModinfoCommand(execute, studio);
        const calls = asMock(vscode.commands.registerCommand).mock
            .calls as Array<[string, (node?: unknown) => Promise<void>]>;
        const entry = calls.find(([id]) => id === 'pzstudio.modinfoGenerate');
        expect(entry).toBeDefined();
        return entry![1];
    }

    it('resolves targets through the instance with the explicit mod + project, without a legacy anchor write', async () => {
        const studio = studioStub([]);
        const { execute, mock } = executeStub();
        const handler = await setupHandler(studio, execute);

        await handler({ modId: 'my_mod', projectDir: projectUri() });

        expect(studio.resolveModInfoTargets).toHaveBeenCalledTimes(1);
        expect(studio.resolveModInfoTargets).toHaveBeenCalledWith(
            'my_mod',
            projectUri().fsPath,
        );
        expect(api.setProjectDir).not.toHaveBeenCalled();
        expect(api.resolveModInfoTargets).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
        expect(mock).toHaveBeenCalledWith(
            'modinfo',
            ['generate', 'my_mod'],
            undefined,
            { projectDir: projectUri().fsPath },
        );
    });

    it('asks before overwriting existing mod.info files and passes --force on confirm', async () => {
        const existing = realTarget(true);
        temps.push(existing);
        const studio = studioStub([existing]);
        const { execute, mock } = executeStub();
        const handler = await setupHandler(studio, execute);
        asMock(vscode.window.showWarningMessage).mockResolvedValue(
            'Overwrite' as never,
        );

        await handler({ modId: 'my_mod', projectDir: projectUri() });

        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            "mod.info already exists in 1 branch folder(s) of 'my_mod'. Overwrite?",
            { modal: true },
            'Overwrite',
        );
        expect(mock).toHaveBeenCalledWith(
            'modinfo',
            ['generate', 'my_mod'],
            ['--force'],
            { projectDir: projectUri().fsPath },
        );
    });

    it('aborts without generating when the overwrite modal is dismissed', async () => {
        const existing = realTarget(true);
        temps.push(existing);
        const studio = studioStub([existing]);
        const { execute, mock } = executeStub();
        const handler = await setupHandler(studio, execute);
        asMock(vscode.window.showWarningMessage).mockResolvedValue(
            undefined as never,
        );

        await handler({ modId: 'my_mod', projectDir: projectUri() });

        expect(mock).not.toHaveBeenCalled();
        expect(api.setProjectDir).not.toHaveBeenCalled();
    });

    it('keeps the picker path on the selected project (no tree node)', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [{ uri: projectUri(), name: 'proj' }];
        asMock(vscode.workspace.fs.stat).mockImplementation(
            async (uri: { path: string }) => {
                if (uri.path.endsWith('project.json')) {
                    return { type: vscode.FileType.File };
                }
                throw new Error('ENOENT');
            },
        );
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
        asMock(vscode.workspace.fs.readFile).mockImplementation(
            async (uri: { path: string }) => {
                if (uri.path.endsWith('project.json')) {
                    return new TextEncoder().encode(
                        JSON.stringify({
                            workshop: {
                                title: 'P',
                                visibility: 'public',
                                tags: [],
                            },
                            mods: {
                                my_mod: { name: 'My Mod', description: 'x' },
                            },
                        }),
                    );
                }
                throw new Error('ENOENT');
            },
        );

        const studio = studioStub([]);
        const { execute, mock } = executeStub();
        const handler = await setupHandler(studio, execute);

        await handler(undefined);

        expect(studio.resolveModInfoTargets).toHaveBeenCalledWith(
            'my_mod',
            projectUri().fsPath,
        );
        expect(mock).toHaveBeenCalledWith(
            'modinfo',
            ['generate', 'my_mod'],
            undefined,
            { projectDir: projectUri().fsPath },
        );
        expect(api.setProjectDir).not.toHaveBeenCalled();
    });
});
