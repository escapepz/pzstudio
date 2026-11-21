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

import '../../packages/cli/src/lib/cli';
import { createPzStudio } from '../../packages/cli/src/lib/studio';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

const TIMESTAMP = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/;

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

    it('error decorates, prints the stack for Error values and notifies with a Show Details action', async () => {
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
        expect(asMock(vscode.window.showErrorMessage)).toHaveBeenCalledTimes(2);
        expect(asMock(vscode.window.showErrorMessage)).toHaveBeenNthCalledWith(
            1,
            'PZStudio Error: plain failure',
            'Show Details',
        );
        expect(asMock(vscode.window.showErrorMessage)).toHaveBeenNthCalledWith(
            2,
            'PZStudio Error: boom',
            'Show Details',
        );
        await Promise.resolve();
        expect(asMock(channel.show)).not.toHaveBeenCalled();
    });

    it('opens the channel with preserveFocus when Show Details is chosen', async () => {
        const { channel } = makeChannel();
        asMock(vscode.window.showErrorMessage).mockResolvedValue(
            'Show Details',
        );
        const logger = createPZLogger(channel);

        logger.error('boom');
        await Promise.resolve();
        await Promise.resolve();

        expect(asMock(channel.show)).toHaveBeenCalledTimes(1);
        expect(asMock(channel.show)).toHaveBeenCalledWith(true);
    });

    it('ignoring the notification never opens the Output panel', async () => {
        const { channel } = makeChannel();
        asMock(vscode.window.showErrorMessage).mockResolvedValue(undefined);
        const logger = createPZLogger(channel);

        logger.error('boom');
        await Promise.resolve();
        await Promise.resolve();

        expect(asMock(channel.show)).not.toHaveBeenCalled();
    });

    it('records a cancellation error in the channel without the notification', () => {
        const { channel, appendLine } = makeChannel();
        const logger = createPZLogger(channel);

        const cancelled = new Error('user cancelled') as Error & {
            name: string;
        };
        cancelled.name = 'CancellationError';
        logger.error(cancelled);

        expect(String(appendLine.mock.calls[0][0])).toMatch(
            new RegExp(`^${TIMESTAMP.source} \\[ERROR\\] user cancelled`),
        );
        expect(asMock(vscode.window.showErrorMessage)).not.toHaveBeenCalled();
    });

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
        expect(debugLines.some((l) => /Project Dir:/.test(l))).toBe(true);
        expect(
            debugLines.some((l) => /Executing command \[list\]/.test(l)),
        ).toBe(true);
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
        expect(
            lines.some((l) => l.includes('[INFO] Command [list] completed.')),
        ).toBe(true);
        expect(
            lines.some((l) => l.includes("No mods in project 'QuietProject'.")),
        ).toBe(true);
    });
});
