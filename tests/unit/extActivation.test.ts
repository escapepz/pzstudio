'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import * as fs from 'fs';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});
vi.mock('@pzstudio/cli/api', () => ({
    createPzStudio: vi.fn(() => ({
        run: vi.fn(async () => {}),
        runProjectDoctor: vi.fn(async () => ({ diagnostics: [] })),
        resolveModInfoTargets: vi.fn(() => []),
        createDevSync: vi.fn(),
    })),
    summarizeApplyResult: vi.fn(() => ''),
    WATCH_DEBOUNCE_MS: 300,
}));

import * as vscode from 'vscode';
import { activate } from '../../packages/vscode-extension/src/extension';
import { readPzStudioHostSettings } from '../../packages/vscode-extension/src/util/settings';
import { createPzStudio } from '@pzstudio/cli/api';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

const folder = (parts: string[]) => ({
    uri: new (vscode.Uri as unknown as new (parts: string[]) => vscode.Uri)(
        parts,
    ),
    name: parts[parts.length - 1] || 'root',
});

const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;

function withSingleProject() {
    (
        vscode.workspace as unknown as { workspaceFolders: unknown }
    ).workspaceFolders = [folder(['proj'])];
    asMock(vscode.workspace.fs.stat).mockImplementation(
        async (uri: { path: string }) => {
            if (uri.path.endsWith('project.json')) {
                return { type: vscode.FileType.File };
            }
            throw new Error('ENOENT');
        },
    );
    asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
}

function activationContext() {
    const UriCtor = vscode.Uri as unknown as new (
        parts: string[],
    ) => vscode.Uri;
    return {
        subscriptions: [] as Array<{ dispose(): unknown }>,
        extensionUri: new UriCtor(['ext-root']),
        workspaceState: { get: vi.fn(), update: vi.fn() },
        globalState: { get: vi.fn(), update: vi.fn() },
        asAbsolutePath: (relative: string) => `ext-root/${relative}`,
    };
}

describe('extension activation (host instance wiring)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates exactly one PzStudio with the extension logger and the settings provider', async () => {
        const context = activationContext();
        await activate(context as never);

        expect(createPzStudio).toHaveBeenCalledTimes(1);
        const options = asMock(createPzStudio).mock.calls[0][0] as {
            logger: Record<string, unknown>;
            settings: (ctx: unknown) => unknown;
        };

        expect(typeof options.logger.log).toBe('function');
        expect(typeof options.logger.info).toBe('function');
        expect(typeof options.logger.warn).toBe('function');
        expect(typeof options.logger.error).toBe('function');
        const channelCalls = asMock(vscode.window.createOutputChannel).mock
            .calls as Array<[string]>;
        const channelIndex = channelCalls.findIndex(
            ([name]) => name === 'PZ Studio',
        );
        expect(channelIndex).toBeGreaterThanOrEqual(0);
        const channel = asMock(vscode.window.createOutputChannel).mock.results[
            channelIndex
        ].value as { appendLine: import('vitest').Mock };
        options.logger.log('routed');
        expect(asMock(channel.appendLine)).toHaveBeenCalledWith('routed');

        expect(typeof options.settings).toBe('function');
        expect(options.settings({ projectDir: 'C:/proj' })).toEqual(
            readPzStudioHostSettings({ projectDir: 'C:/proj' }),
        );
    });

    it('runs the update command globally through the created instance (UX-03)', async () => {
        withSingleProject();
        const context = activationContext();
        await activate(context as never);

        const studio = asMock(createPzStudio).mock.results[0].value as {
            run: import('vitest').Mock;
        };
        asMock(vscode.commands.executeCommand).mockClear();

        const handler = asMock(vscode.commands.registerCommand).mock.calls.find(
            ([id]) => id === 'pzstudio.update',
        )?.[1] as () => Promise<void>;
        expect(handler).toBeDefined();
        await handler();

        expect(studio.run).toHaveBeenCalledTimes(1);
        expect(studio.run).toHaveBeenCalledWith('update', [], { flags: [] });
        expect('projectDir' in asMock(studio.run).mock.calls[0][2]).toBe(false);
        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
    });

    it('activates and updates in a project-less workspace (UX-03 case A/B)', async () => {
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [];
        asMock(vscode.workspace.fs.stat).mockRejectedValue(new Error('ENOENT'));
        asMock(vscode.workspace.fs.readDirectory).mockResolvedValue([]);
        const context = activationContext();
        await activate(context as never);

        const studio = asMock(createPzStudio).mock.results[0].value as {
            run: import('vitest').Mock;
        };

        const handler = asMock(vscode.commands.registerCommand).mock.calls.find(
            ([id]) => id === 'pzstudio.update',
        )?.[1] as () => Promise<void>;
        expect(handler).toBeDefined();
        await handler();

        expect(studio.run).toHaveBeenCalledWith('update', [], { flags: [] });
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
    });

    it('routes doctor and modinfo through the created instance', async () => {
        withSingleProject();
        const context = activationContext();
        await activate(context as never);

        const studio = asMock(createPzStudio).mock.results[0].value as {
            run: import('vitest').Mock;
            runProjectDoctor: import('vitest').Mock;
            resolveModInfoTargets: import('vitest').Mock;
        };

        const doctorHandler = asMock(
            vscode.commands.registerCommand,
        ).mock.calls.find(([id]) => id === 'pzstudio.doctor')?.[1] as (
            node?: unknown,
        ) => Promise<void>;
        expect(doctorHandler).toBeDefined();
        await doctorHandler({ projectDir: new UriCtor(['proj']) });
        expect(studio.runProjectDoctor).toHaveBeenCalledTimes(1);
        expect(studio.runProjectDoctor).toHaveBeenCalledWith(
            path.sep + path.join('proj'),
        );
        expect(
            asMock(vscode.window.showInformationMessage),
        ).toHaveBeenLastCalledWith(
            "PZStudio: no problems found in 'proj'. Everything looks good.",
        );

        const modinfoHandler = asMock(
            vscode.commands.registerCommand,
        ).mock.calls.find(([id]) => id === 'pzstudio.modinfoGenerate')?.[1] as (
            node?: unknown,
        ) => Promise<void>;
        expect(modinfoHandler).toBeDefined();
        await modinfoHandler({
            modId: 'my_mod',
            projectDir: new UriCtor(['proj']),
        });
        expect(studio.resolveModInfoTargets).toHaveBeenCalledWith(
            'my_mod',
            path.sep + path.join('proj'),
        );
        expect(studio.run).toHaveBeenCalledWith(
            'modinfo',
            ['generate', 'my_mod'],
            { flags: [], projectDir: path.sep + path.join('proj') },
        );
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
    });

    it('extension source imports no legacy facade setter (commit 11 grep-guard)', () => {
        const extSrc = path.resolve(
            __dirname,
            '../../packages/vscode-extension/src',
        );

        function collectTsFiles(dir: string): string[] {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const files: string[] = [];
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === 'test')
                        continue;
                    files.push(...collectTsFiles(full));
                } else if (
                    /\.(ts|js)$/.test(entry.name) &&
                    !entry.name.endsWith('.d.ts')
                ) {
                    files.push(full);
                }
            }
            return files;
        }

        const hits: Array<{ file: string; line: string }> = [];
        for (const file of collectTsFiles(extSrc)) {
            const content = fs.readFileSync(file, 'utf-8');
            for (const line of content.split('\n')) {
                if (
                    /setLogger|setProjectDir|setVsCodeSettings/.test(line) &&
                    /from\s+['"]@pzstudio\/cli\/api['"]/.test(line)
                ) {
                    hits.push({
                        file: path.relative(extSrc, file),
                        line: line.trim(),
                    });
                }
            }
        }
        expect(hits).toHaveLength(0);
    });
});

describe('UX-11 wiring (activation graph)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        asMock(vscode.window.showErrorMessage).mockResolvedValue(undefined);
    });

    function activatedProvider() {
        const calls = asMock(vscode.window.createTreeView).mock.calls as Array<
            [string, { treeDataProvider: unknown }]
        >;
        const entry = calls.find(([id]) => id === 'pzstudio.projectExplorer');
        expect(entry).toBeDefined();
        return entry![1].treeDataProvider as {
            getChildren: (element?: unknown) => Promise<
                Array<{
                    kind: string;
                    description?: string;
                    tooltip?: string;
                }>
            >;
        };
    }

    function configListener() {
        const calls = asMock(vscode.workspace.onDidChangeConfiguration).mock
            .calls as Array<[unknown]>;
        expect(calls.length).toBeGreaterThanOrEqual(1);
        return calls[0][0] as (event: {
            affectsConfiguration: (section: string) => boolean;
        }) => Promise<void>;
    }

    function activatedDoctorHandler() {
        const calls = asMock(vscode.commands.registerCommand).mock
            .calls as Array<[string, (node?: unknown) => Promise<void>]>;
        const entry = calls.find(([id]) => id === 'pzstudio.doctor');
        expect(entry).toBeDefined();
        return entry![1];
    }

    function activatedStudio() {
        return asMock(createPzStudio).mock.results[0].value as {
            runProjectDoctor: import('vitest').Mock;
        };
    }

    it('forwards the default empty gameBuild as the unchanged single-argument call', async () => {
        withSingleProject();
        const context = activationContext();
        await activate(context as never);

        await activatedDoctorHandler()({ projectDir: new UriCtor(['proj']) });

        const calls = asMock(activatedStudio().runProjectDoctor).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe(path.sep + path.join('proj'));
        expect(calls[0]).toHaveLength(1);
    });

    it('a pzstudio.gameBuild configuration change invalidates diagnostics and repaints (UX-11)', async () => {
        withSingleProject();
        const context = activationContext();
        await activate(context as never);
        const provider = activatedProvider();
        const onConfig = configListener();
        const doctorCalls = () =>
            asMock(activatedStudio().runProjectDoctor).mock.calls.length;

        await provider.getChildren();
        expect(doctorCalls()).toBe(1);
        await provider.getChildren();
        expect(doctorCalls()).toBe(1);

        await onConfig({
            affectsConfiguration: (section) => section === 'pzstudio.gameBuild',
        });
        await provider.getChildren();
        expect(doctorCalls()).toBe(2);

        await onConfig({
            affectsConfiguration: (section) => section === 'pzstudio.language',
        });
        await provider.getChildren();
        expect(doctorCalls()).toBe(2);
    });

    it('a user-invoked doctor failure surfaces exactly one UX-16 notification with full channel detail', async () => {
        withSingleProject();
        const context = activationContext();
        await activate(context as never);
        asMock(activatedStudio().runProjectDoctor).mockRejectedValue(
            new Error('engine boom'),
        );

        await activatedDoctorHandler()({ projectDir: new UriCtor(['proj']) });
        await Promise.resolve();
        await Promise.resolve();

        expect(asMock(vscode.window.showErrorMessage)).toHaveBeenCalledTimes(1);
        expect(asMock(vscode.window.showErrorMessage)).toHaveBeenCalledWith(
            'PZStudio Error: engine boom',
            'Show Details',
        );
        expect(asMock(vscode.window.createOutputChannel)).toHaveBeenCalledTimes(
            1,
        );
        const channel = asMock(vscode.window.createOutputChannel).mock
            .results[0].value as {
            appendLine: import('vitest').Mock;
            show: import('vitest').Mock;
        };
        const lines = channel.appendLine.mock.calls.map((c) => String(c[0]));
        expect(lines.some((l) => /\[ERROR\] engine boom\n/.test(l))).toBe(true);
        expect(channel.show).not.toHaveBeenCalled();
    });

    it('automatic explorer diagnostics failures stay decoration-only (no popups, no loops, no rejections)', async () => {
        withSingleProject();
        const context = activationContext();
        await activate(context as never);
        asMock(activatedStudio().runProjectDoctor).mockRejectedValue(
            new Error('engine boom'),
        );
        const provider = activatedProvider();

        const first = await provider.getChildren();
        const second = await provider.getChildren();

        expect(asMock(vscode.window.showErrorMessage)).not.toHaveBeenCalled();
        expect(first.every((node) => !node.description?.includes('✗'))).toBe(
            true,
        );
        expect(second.every((node) => !node.description?.includes('✗'))).toBe(
            true,
        );
    });

    it('command IDs and instances stay untouched by the UX-11 additions', async () => {
        withSingleProject();
        const context = activationContext();
        await activate(context as never);

        const ids = asMock(vscode.commands.registerCommand).mock.calls.map(
            ([id]) => id,
        );
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain('pzstudio.doctor');
        expect(ids.filter((id) => id === 'pzstudio.doctor')).toHaveLength(1);
    });
});
