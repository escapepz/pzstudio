'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    // The shared mock has no diagnostics surface yet (analyzeGameLog is its
    // first consumer): add the minimal classes and a settable collection
    // the command needs, without widening the shared helper.
    const mock = createVscodeMock() as unknown as Record<string, unknown>;
    class MockRange {
        constructor(
            public startLine: number,
            public startCharacter: number,
            public endLine: number,
            public endCharacter: number,
        ) {}
    }
    class MockDiagnostic {
        source?: string;
        constructor(
            public range: MockRange,
            public message: string,
            public severity?: number,
        ) {}
    }
    mock.Range = MockRange;
    mock.Diagnostic = MockDiagnostic;
    mock.DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
    mock.languages = {
        createDiagnosticCollection: vi.fn(() => ({
            set: vi.fn(),
            delete: vi.fn(),
            clear: vi.fn(),
            dispose: vi.fn(),
        })),
    };
    return mock as unknown as typeof import('vscode');
});

// The command only renders: the analyzer is injected (index.ts passes the
// CLI API's analyzeGameLogFile), so the tests stub a plain async function.
import * as vscode from 'vscode';
import { registerAnalyzeGameLogCommand } from '../../packages/vscode-extension/src/commands/analyzeGameLog';
import type { ConsoleLogReport } from '@pzstudio/cli/api';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

const ATTRIBUTED_URI =
    'file:///proj/zul_test_dev/42/media/lua/client/zul_test_client.lua';
// A plain Windows filesystem path, not a file:// URI: a context built
// without the vscode-URI remap carries filesystem paths from the CLI host.
const PLAIN_WINDOWS_PATH =
    'E:\\proj\\zul_test_dev\\42\\media\\lua\\client\\zul_test_client.lua';

function makeReport(
    findings: ConsoleLogReport['findings'],
    logOverrides?: Partial<ConsoleLogReport['log']>,
): ConsoleLogReport {
    return {
        log: {
            path: 'C:/Users/dev/Zomboid/console.txt',
            gameExited: true,
            totalLines: 120,
            ...logOverrides,
        },
        stats: {
            totalLines: 120,
            byLevel: {},
            debugByChannel: {},
            junkCount: 0,
        },
        session: { loadedModIds: ['zul_test_dev'], rejectedModIds: [] },
        findings,
    };
}

/** Registers the command and returns its handler plus the analyzer stub. */
async function setupHandler(
    analyze: ReturnType<typeof vi.fn>,
    onError?: (error: unknown) => void,
) {
    registerAnalyzeGameLogCommand(
        analyze as never as (logPath?: string) => Promise<ConsoleLogReport>,
        onError,
    );
    const calls = asMock(vscode.commands.registerCommand).mock.calls as Array<
        [string, () => Promise<void>]
    >;
    const entry = calls.find(([id]) => id === 'pzstudio.analyzeGameLog');
    expect(entry).toBeDefined();
    return { handler: entry![1] };
}

/** The channel object the command actually holds, via the call's result. */
function createdChannel(name: string) {
    const mocked = asMock(vscode.window.createOutputChannel);
    const index = mocked.mock.calls.findIndex(
        ([channelName]) => channelName === name,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    return mocked.mock.results[index].value as unknown as {
        appendLine: ReturnType<typeof vi.fn>;
        show: ReturnType<typeof vi.fn>;
    };
}

/** The collection object the command actually holds, via the call's result. */
function createdCollection(name: string) {
    const mocked = asMock(vscode.languages.createDiagnosticCollection);
    const index = mocked.mock.calls.findIndex(
        ([collectionName]) => collectionName === name,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    return mocked.mock.results[index].value as unknown as {
        set: ReturnType<typeof vi.fn>;
        clear: ReturnType<typeof vi.fn>;
    };
}

describe('pzstudio.analyzeGameLog', () => {
    let analyze: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        analyze = vi.fn();
    });

    it('renders the severity summary and both findings in the game log channel', async () => {
        asMock(analyze).mockResolvedValue(
            makeReport([
                {
                    category: 'lua-syntax-error',
                    severity: 'error',
                    message: 'unexpected symbol near <eof>',
                    modId: 'zul_test_dev',
                    sourceFile: ATTRIBUTED_URI,
                    line: 43,
                    count: 1,
                    firstLine: 40,
                    lastLine: 43,
                },
                {
                    category: 'mod-rejected',
                    severity: 'warning',
                    message: "Mod folder 'ghost_mod' was rejected by the game.",
                    count: 2,
                    firstLine: 5,
                    lastLine: 9,
                },
            ]),
        );
        const { handler } = await setupHandler(analyze);

        await handler();

        expect(asMock(analyze)).toHaveBeenCalledWith(undefined);
        const channel = createdChannel('PZ Studio Game Log');
        const lines = asMock(channel.appendLine).mock.calls.map((c) =>
            String(c[0]),
        );
        expect(lines).toContain('1 error(s), 1 warning(s), 0 info(s)');
        expect(lines).toContain(
            '[lua-syntax-error] unexpected symbol near <eof>',
        );
        expect(lines).toContain('→ zul_test_dev ' + ATTRIBUTED_URI + ':43');
        expect(lines).toContain(
            "[mod-rejected] Mod folder 'ghost_mod' was rejected by the game.",
        );
        expect(asMock(channel.show)).toHaveBeenCalledTimes(1);
    });

    it('maps the attributed finding into a diagnostic at its source line', async () => {
        asMock(analyze).mockResolvedValue(
            makeReport([
                {
                    category: 'lua-syntax-error',
                    severity: 'error',
                    message: 'unexpected symbol near <eof>',
                    modId: 'zul_test_dev',
                    sourceFile: ATTRIBUTED_URI,
                    line: 43,
                    count: 1,
                    firstLine: 40,
                    lastLine: 43,
                },
                {
                    category: 'mod-rejected',
                    severity: 'warning',
                    message: "Mod folder 'ghost_mod' was rejected by the game.",
                    count: 2,
                    firstLine: 5,
                    lastLine: 9,
                },
            ]),
        );
        const { handler } = await setupHandler(analyze);

        await handler();

        const collection = createdCollection('pzstudio-game-log');
        const setCalls = asMock(collection.set).mock.calls as Array<
            [vscode.Uri, Array<Record<string, unknown>>]
        >;
        expect(setCalls).toHaveLength(1);
        const [uri, diagnostics] = setCalls[0];
        expect(
            String((uri as unknown as { toString(): string }).toString()),
        ).toBe(ATTRIBUTED_URI);
        expect(diagnostics).toHaveLength(1);
        const diagnostic = diagnostics[0];
        expect(diagnostic.message).toBe(
            'lua-syntax-error: unexpected symbol near <eof>',
        );
        expect(diagnostic.severity).toBe(vscode.DiagnosticSeverity.Error);
        expect(diagnostic.source).toBe('pzstudio');
        const range = diagnostic.range as {
            startLine: number;
            endLine: number;
            startCharacter: number;
            endCharacter: number;
        };
        expect(range.startLine).toBe(42);
        expect(range.endLine).toBe(42);
        expect(range.startCharacter).toBe(0);
        expect(range.endCharacter).toBe(500);
    });

    it('maps a plain filesystem-path sourceFile into a file-Uri diagnostic', async () => {
        asMock(analyze).mockResolvedValue(
            makeReport([
                {
                    category: 'lua-syntax-error',
                    severity: 'error',
                    message: "unexpected symbol near 'end'",
                    modId: 'zul_test_dev',
                    sourceFile: PLAIN_WINDOWS_PATH,
                    line: 43,
                    count: 1,
                    firstLine: 40,
                    lastLine: 43,
                },
            ]),
        );
        const { handler } = await setupHandler(analyze);

        await handler();

        const collection = createdCollection('pzstudio-game-log');
        const setCalls = asMock(collection.set).mock.calls as Array<
            [vscode.Uri, Array<Record<string, unknown>>]
        >;
        expect(setCalls).toHaveLength(1);
        const [uri, diagnostics] = setCalls[0];
        // Uri.file materialization (not Uri.parse's verbatim pass-through):
        // a real vscode host cannot parse a bare Windows path as a URI.
        expect(uri).toBeInstanceOf(vscode.Uri);
        expect(String(uri.path)).toContain('zul_test_client.lua');
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toBe(
            "lua-syntax-error: unexpected symbol near 'end'",
        );
        expect(diagnostics[0].severity).toBe(vscode.DiagnosticSeverity.Error);
        expect(diagnostics[0].source).toBe('pzstudio');
    });

    it('the unattributed finding produces no diagnostic', async () => {
        asMock(analyze).mockResolvedValue(
            makeReport([
                {
                    category: 'mod-rejected',
                    severity: 'warning',
                    message: "Mod folder 'ghost_mod' was rejected by the game.",
                    count: 2,
                    firstLine: 5,
                    lastLine: 9,
                },
            ]),
        );
        const { handler } = await setupHandler(analyze);

        await handler();

        const collection = createdCollection('pzstudio-game-log');
        const setCalls = asMock(collection.set).mock.calls;
        expect(setCalls).toHaveLength(0);
    });

    it('clears the collection each run and creates the surfaces once per registration', async () => {
        asMock(analyze).mockResolvedValue(makeReport([]));
        const { handler } = await setupHandler(analyze);

        // Both surfaces are materialized on the first run, not at
        // registration: the bundle activation smoke test registers every
        // command against a vscode stub without the diagnostics/output APIs.
        expect(
            asMock(vscode.window.createOutputChannel),
        ).not.toHaveBeenCalled();
        expect(
            asMock(vscode.languages.createDiagnosticCollection),
        ).not.toHaveBeenCalled();

        await handler();
        await handler();

        expect(asMock(vscode.window.createOutputChannel)).toHaveBeenCalledTimes(
            1,
        );
        expect(
            asMock(vscode.languages.createDiagnosticCollection),
        ).toHaveBeenCalledTimes(1);
        const collection = createdCollection('pzstudio-game-log');
        expect(asMock(collection.clear)).toHaveBeenCalledTimes(2);
        expect(asMock(collection.set).mock.calls).toHaveLength(0);
    });

    it('flags a partial log and surfaces the read error', async () => {
        asMock(analyze).mockResolvedValue(
            makeReport([], {
                gameExited: false,
                readError: 'file is locked by the game',
            }),
        );
        const { handler } = await setupHandler(analyze);

        await handler();

        const channel = createdChannel('PZ Studio Game Log');
        const lines = asMock(channel.appendLine).mock.calls.map((c) =>
            String(c[0]),
        );
        expect(lines.some((l) => l.startsWith('⚠ log may be partial'))).toBe(
            true,
        );
        expect(lines).toContain('Read error: file is locked by the game');
    });

    it('falls back to the (0,0,0,500) range when the finding has no line', async () => {
        asMock(analyze).mockResolvedValue(
            makeReport([
                {
                    category: 'translation',
                    severity: 'info',
                    message: 'missing translation key',
                    modId: 'zul_test_dev',
                    sourceFile: ATTRIBUTED_URI,
                    count: 3,
                    firstLine: 10,
                    lastLine: 12,
                },
            ]),
        );
        const { handler } = await setupHandler(analyze);

        await handler();

        const collection = createdCollection('pzstudio-game-log');
        const setCalls = asMock(collection.set).mock.calls as Array<
            [vscode.Uri, Array<Record<string, unknown>>]
        >;
        expect(setCalls).toHaveLength(1);
        const range = setCalls[0][1][0].range as {
            startLine: number;
            endLine: number;
        };
        expect(range.startLine).toBe(0);
        expect(range.endLine).toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/* Errors never throw past the handler: they route to onError          */
/* ------------------------------------------------------------------ */

describe('pzstudio.analyzeGameLog error handling', () => {
    let analyze: ReturnType<typeof vi.fn>;
    let onError: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        analyze = vi.fn();
        onError = vi.fn();
    });

    it('a rejected analysis notifies onError once and resolves without throwing', async () => {
        const boom = new Error('engine boom');
        asMock(analyze).mockRejectedValue(boom);
        const { handler } = await setupHandler(analyze, onError);

        await expect(handler()).resolves.toBeUndefined();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0]).toBe(boom);
        // Nothing was rendered: no channel open on a failed run.
        const channel = createdChannel('PZ Studio Game Log');
        expect(asMock(channel.show)).not.toHaveBeenCalled();
    });

    it('without onError the handler still swallows the rejection', async () => {
        asMock(analyze).mockRejectedValue(new Error('engine boom'));
        const { handler } = await setupHandler(analyze);

        await expect(handler()).resolves.toBeUndefined();
    });
});
