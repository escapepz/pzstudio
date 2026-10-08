'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import * as fs from 'fs';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});
// Every runtime api import across the activation graph (extension.ts plus
// the consumers it wires). After commit 10 every engine/operation consumer
// — runner, task provider, DevSync, doctor, modinfo — goes through the
// created instance. Commit 11 retires the legacy facade setters:
// setLogger / setProjectDir / setVsCodeSettings are no longer called by the
// extension runtime (doc 11 §17 commit 11). `runCLI`, `runProjectDoctor`,
// `resolveModInfoTargets`, `createDevSync`, `log` and `warn` are
// deliberately ABSENT from the mock: any runtime import of a published
// legacy door would surface as an undefined call inside activate.
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

    it('routes doctor and modinfo through the created instance', async () => {
        withSingleProject();
        const context = activationContext();
        await activate(context as never);

        const studio = asMock(createPzStudio).mock.results[0].value as {
            run: import('vitest').Mock;
            runProjectDoctor: import('vitest').Mock;
            resolveModInfoTargets: import('vitest').Mock;
        };

        // Doctor: a tree-node run goes through the bound diagnostics
        // runner → studio.runProjectDoctor with the explicit fsPath. The
        // empty report exercises the clean-project message path.
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

        // ModInfo: a tree-node run resolves the overwrite targets through
        // the instance with the explicit mod + project, then generates via
        // the runner's studio.run.
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
        // No existing target in the stub → no overwrite modal.
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
    });

    it('extension source imports no legacy facade setter (commit 11 grep-guard)', () => {
        // doc 11 §17 commit 11: setLogger / setProjectDir / setVsCodeSettings are
        // retired from the extension runtime. The grep guard prevents any future
        // import of these from re-entering the extension source.
        //
        // The test/ directory is excluded: integration.test.ts runs inside a
        // real VS Code extension host (uses real runCLI + real command
        // registration) and intentionally exercises the legacy facade on that
        // host. Its imports of setProjectDir and runCLI are the test itself,
        // not production code.
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
