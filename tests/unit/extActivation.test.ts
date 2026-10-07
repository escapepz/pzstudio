'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});
// Every runtime api import across the activation graph (extension.ts plus
// the still-legacy consumers it wires: devsync controller, doctor util,
// modinfo command — the task provider consumes the v2 instance only).
vi.mock('@pzstudio/cli/api', () => ({
    createPzStudio: vi.fn(() => ({ run: vi.fn(async () => {}) })),
    setLogger: vi.fn(),
    setProjectDir: vi.fn(),
    setVsCodeSettings: vi.fn(),
    runCLI: vi.fn(async () => {}),
    runProjectDoctor: vi.fn(async () => ({})),
    resolveModInfoTargets: vi.fn(() => []),
    createDevSync: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    summarizeApplyResult: vi.fn(() => ''),
    WATCH_DEBOUNCE_MS: 300,
}));

import * as vscode from 'vscode';
import { activate } from '../../packages/vscode-extension/src/extension';
import { readPzStudioHostSettings } from '../../packages/vscode-extension/src/util/settings';
import {
    createPzStudio,
    setLogger,
    setProjectDir,
    setVsCodeSettings,
} from '@pzstudio/cli/api';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

const folder = (parts: string[]) => ({
    uri: new (vscode.Uri as unknown as new (parts: string[]) => vscode.Uri)(
        parts,
    ),
    name: parts[parts.length - 1] || 'root',
});

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

        // The logger is the extension channel adapter: log() writes into the
        // 'PZ Studio' output channel createPZLogger was handed.
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

        // The settings provider is the pure host reader: same snapshot the
        // direct reader returns (the context is accepted but ignored —
        // pinned in extUtilSettings.test.ts).
        expect(typeof options.settings).toBe('function');
        expect(options.settings({ projectDir: 'C:/proj' })).toEqual(
            readPzStudioHostSettings({ projectDir: 'C:/proj' }),
        );
    });

    it('routes the generic runner through the created instance', async () => {
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

        expect(studio.run).toHaveBeenCalledWith('update', [], {
            flags: [],
            projectDir: path.sep + path.join('proj'),
        });
    });

    it('keeps the legacy consumers wired beside the v2 instance', async () => {
        const context = activationContext();
        await activate(context as never);

        // The legacy logger slot is still populated at activate (retired in
        // commit 11) for the not-yet-migrated consumers: devsync controller,
        // doctor util, task provider, modinfo command.
        expect(setLogger).toHaveBeenCalledTimes(1);
        expect(asMock(setLogger).mock.calls[0][0]).toMatchObject({
            log: expect.any(Function),
            info: expect.any(Function),
            warn: expect.any(Function),
            error: expect.any(Function),
        });
        // Task provider (v2 via the host instance since commit 8) still
        // registered.
        expect(asMock(vscode.tasks.registerTaskProvider)).toHaveBeenCalledTimes(
            1,
        );
        // deactivate still clears the legacy slots (unchanged until commit 11).
        const extension =
            (await import('../../packages/vscode-extension/src/extension')) as {
                deactivate: () => void;
            };
        extension.deactivate();
        expect(setLogger).toHaveBeenLastCalledWith(undefined);
        expect(setProjectDir).toHaveBeenLastCalledWith(undefined);
        expect(setVsCodeSettings).toHaveBeenLastCalledWith(
            undefined,
            undefined,
        );
    });
});
