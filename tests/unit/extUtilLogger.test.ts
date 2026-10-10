'use strict';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { TemplateTransport } from '@pzstudio/platform';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { createPZLogger } from '../../packages/vscode-extension/src/util/logger';

// Importing the legacy dispatcher registers every command into the registry
// (studio.run dispatches through the same registry) — the same pattern as
// cliStudioInstances.test.ts, so the routing tests below run the REAL engine
// lifecycle, not a mocked studio.
import '../../packages/cli/src/lib/cli';
import { createPzStudio } from '../../packages/cli/src/lib/studio';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

/** Timestamp shape produced by getTimestamp() — never a wall-clock value. */
const TIMESTAMP = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/;

/** The mock factory hands out a fresh channel object per call — capture it. */
function makeChannel() {
    const channel = vscode.window.createOutputChannel('PZ Studio');
    return { channel, appendLine: asMock(channel.appendLine) };
}

function channelLines(appendLine: import('vitest').Mock): string[] {
    return appendLine.mock.calls.map((call) => String(call[0]));
}

let tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = createTempDir();
    tempDirs.push(dir);
    return dir;
}

beforeEach(() => {
    // Mock call counts must not leak between tests (the no-duplicate-channel
    // assertion counts createOutputChannel calls).
    vi.clearAllMocks();
});

afterEach(() => {
    for (const dir of tempDirs) deleteDir(dir);
    tempDirs = [];
});

describe('createPZLogger (host OutputChannel bridge)', () => {
    it('log writes an undecorated data line', () => {
        const { channel, appendLine } = makeChannel();
        const logger = createPZLogger(channel);

        logger.log('plain data');

        expect(appendLine).toHaveBeenCalledTimes(1);
        expect(appendLine).toHaveBeenCalledWith('plain data');
    });

    it('info decorates with the timestamp and INFO tag', () => {
        const { channel, appendLine } = makeChannel();
        const logger = createPZLogger(channel);

        logger.info('progressing');

        expect(appendLine).toHaveBeenCalledTimes(1);
        expect(String(appendLine.mock.calls[0][0])).toMatch(
            new RegExp(`^${TIMESTAMP.source} \\[INFO\\] progressing$`),
        );
    });

    it('warn decorates with the timestamp and WARN tag', () => {
        const { channel, appendLine } = makeChannel();
        const logger = createPZLogger(channel);

        logger.warn('careful');

        expect(String(appendLine.mock.calls[0][0])).toMatch(
            new RegExp(`^${TIMESTAMP.source} \\[WARN\\] careful$`),
        );
    });

    it('error decorates, prints the stack for Error values and notifies', () => {
        const { channel, appendLine } = makeChannel();
        const logger = createPZLogger(channel);

        logger.error('plain failure');
        logger.error(new Error('boom'));

        expect(String(appendLine.mock.calls[0][0])).toMatch(
            new RegExp(`^${TIMESTAMP.source} \\[ERROR\\] plain failure$`),
        );
        expect(String(appendLine.mock.calls[1][0])).toMatch(
            new RegExp(`^${TIMESTAMP.source} \\[ERROR\\] boom\\n`),
        );
        expect(asMock(vscode.window.showErrorMessage)).toHaveBeenCalledWith(
            'PZStudio Error: plain failure',
        );
        expect(asMock(vscode.window.showErrorMessage)).toHaveBeenCalledWith(
            'PZStudio Error: boom',
        );
    });

    // UX-04: verbose diagnostics must reach the SAME channel, decorated like
    // the other semantic channels (timestamp + DEBUG tag), with the message
    // preserved verbatim — the engine owns the --verbose gating, the host
    // logger only renders.
    it('verbose writes DEBUG lines into the same OutputChannel', () => {
        const { channel, appendLine } = makeChannel();
        const logger = createPZLogger(channel);

        logger.verbose!('Project Dir:  C:/somewhere/proj');

        expect(appendLine).toHaveBeenCalledTimes(1);
        expect(String(appendLine.mock.calls[0][0])).toMatch(
            new RegExp(
                `^${TIMESTAMP.source} \\[DEBUG\\] Project Dir:  C:/somewhere/proj$`,
            ),
        );
    });

    it('verbose passes the message through verbatim (multiline and empty)', () => {
        const { channel, appendLine } = makeChannel();
        const logger = createPZLogger(channel);

        logger.verbose!('line one\nline two');
        logger.verbose!('');

        const lines = channelLines(appendLine);
        expect(lines[0]).toMatch(
            new RegExp(`^${TIMESTAMP.source} \\[DEBUG\\] line one\\nline two$`),
        );
        // Empty diagnostics follow the plain appendLine convention of the
        // other channels: one decoration prefix, no invented content.
        expect(lines[1]).toMatch(
            new RegExp(`^${TIMESTAMP.source} \\[DEBUG\\] $`),
        );
    });

    it('keeps emission order across channels on one channel, no duplicates', () => {
        const { channel, appendLine } = makeChannel();
        const logger = createPZLogger(channel);

        logger.info('first');
        logger.verbose!('second');
        logger.warn('third');

        const lines = channelLines(appendLine);
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatch(/\[INFO\] first$/);
        expect(lines[1]).toMatch(/\[DEBUG\] second$/);
        expect(lines[2]).toMatch(/\[WARN\] third$/);
        // The bridge itself never creates a channel — it renders into the one
        // it was handed.
        expect(asMock(vscode.window.createOutputChannel)).toHaveBeenCalledTimes(
            1,
        );
    });

    it('clear clears the handed channel', () => {
        const { channel } = makeChannel();
        const logger = createPZLogger(channel);

        logger.clear!();

        expect(asMock(channel.clear)).toHaveBeenCalledTimes(1);
    });
});

describe('UX-04: engine verbose diagnostics reach the OutputChannel', () => {
    function sentinelTransport(): TemplateTransport {
        return {
            name: 'git',
            download: () => {},
            refresh: () => false,
            isCacheValid: () => false,
        };
    }

    function makeProjectDir(title: string): string {
        const dir = makeTempDir();
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
                workshop: { title, visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
            }),
        );
        return dir;
    }

    // The real engine lifecycle emits verbose diagnostics before every real
    // command (cli.ts "Project Dir:" / "Executing command [...]" lines), so a
    // hermetic `list` run against a temp project exercises the full chain:
    // studio.run → InvocationContext logger → createPZLogger → channel.
    function makeStudio(channel: vscode.OutputChannel) {
        return createPzStudio({
            logger: createPZLogger(channel),
            templateTransport: sentinelTransport(),
        });
    }

    it('a --verbose run lands [DEBUG] lines in the channel, order preserved', async () => {
        const { channel, appendLine } = makeChannel();
        const studio = makeStudio(channel);
        const proj = makeProjectDir('VerboseProject');

        await studio.run('list', [], {
            flags: ['--verbose'],
            projectDir: proj,
        });

        const lines = channelLines(appendLine);
        const debugLines = lines.filter((l) => l.includes('[DEBUG]'));
        // The engine's own pre-command diagnostics, complete (message not
        // truncated, no re-prefixing).
        expect(debugLines.some((l) => /Project Dir:/.test(l))).toBe(true);
        expect(
            debugLines.some((l) => /Executing command \[list\]/.test(l)),
        ).toBe(true);
        // Ordering: diagnostics precede the completion progress line and the
        // data output stays undecorated.
        const firstDebug = lines.findIndex((l) => l.includes('[DEBUG]'));
        const completed = lines.findIndex((l) =>
            l.includes('[INFO] Command [list] completed.'),
        );
        expect(completed).toBeGreaterThan(firstDebug);
        expect(debugLines.every((l) => TIMESTAMP.test(l))).toBe(true);
    });

    it('without --verbose the engine gate suppresses [DEBUG]; other channels unchanged', async () => {
        const { channel, appendLine } = makeChannel();
        const studio = makeStudio(channel);
        const proj = makeProjectDir('QuietProject');

        await studio.run('list', [], { projectDir: proj });

        const lines = channelLines(appendLine);
        expect(lines.some((l) => l.includes('[DEBUG]'))).toBe(false);
        // Normal channels keep working exactly as before.
        expect(
            lines.some((l) => l.includes('[INFO] Command [list] completed.')),
        ).toBe(true);
        expect(
            lines.some((l) => l.includes("No mods in project 'QuietProject'.")),
        ).toBe(true);
    });
});
