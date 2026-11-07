import { describe, it, expect, afterEach } from 'vitest';
import { formatError, CliError } from '../../packages/cli/src/lib/errors';
import {
    CliUsageError,
    CliIO,
    setCliIO,
} from '../../packages/cli/src/lib/parser';
import { error, setDebug, setLogger } from '../../packages/cli/src/lib/logger';

describe('formatError (CLI-3 error model)', () => {
    it('renders CliUsageError as its message only — no stack, no hint', () => {
        const text = formatError(new CliUsageError("Unknown option '--wat'"));
        expect(text).toBe("Unknown option '--wat'");
    });

    it('renders a fully populated CliError as Problem/Cause/Try in order', () => {
        const text = formatError(
            new CliError("Mod 'x' not found in project.json!", {
                cause: 'project.json only lists registered mods.',
                tryHint: "Run 'pzstudio list'.",
            }),
        );
        const lines = text.split('\n');
        expect(lines).toHaveLength(3);
        expect(lines[0]).toBe("Problem: Mod 'x' not found in project.json!");
        expect(lines[1]).toBe(
            '        Cause: project.json only lists registered mods.',
        );
        expect(lines[2]).toBe("        Try: Run 'pzstudio list'.");
    });

    it('omits missing Cause/Try lines from a partial CliError', () => {
        const text = formatError(
            new CliError('Path is not a directory.', {
                tryHint: 'Pass a directory, not a file.',
            }),
        );
        const lines = text.split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe('Problem: Path is not a directory.');
        expect(lines[1]).toBe('        Try: Pass a directory, not a file.');
        expect(text).not.toContain('Cause:');
    });

    it('returns the bare problem text when a CliError has no extra fields', () => {
        const text = formatError(new CliError('Bare problem.'));
        expect(text).toBe('Bare problem.');
        expect(text).not.toContain('Problem:');
    });

    it('wraps unexpected errors and points at --debug by default', () => {
        const text = formatError(new Error('boom'));
        const lines = text.split('\n');
        expect(lines[0]).toBe('Unexpected error: boom');
        expect(lines[1]).toBe('Run with --debug for the full stack trace.');
        expect(text).not.toMatch(/\n\s+at .+:\d+:\d+/);
    });

    it('includes the full stack for unexpected errors under --debug', () => {
        const e = new Error('boom');
        const text = formatError(e, { debug: true });
        expect(text).toContain('Unexpected error: boom');
        expect(text).toMatch(/\n\s+at .+:\d+:\d+/);
        expect(text).not.toContain('Run with --debug');
    });

    it('wraps non-Error thrown values without a stack', () => {
        const text = formatError('a string was thrown');
        expect(text.split('\n')[0]).toBe(
            'Unexpected error: a string was thrown',
        );
        expect(text).toContain('Run with --debug for the full stack trace.');
        expect(text).not.toMatch(/\n\s+at .+:\d+:\d+/);
    });
});

describe('logger.error via the CliIO sink (CLI-3)', () => {
    const captured = { stdout: [] as string[], stderr: [] as string[] };
    const sink: CliIO = {
        stdout: (t) => captured.stdout.push(t),
        stderr: (t) => captured.stderr.push(t),
    };

    afterEach(() => {
        setLogger(undefined);
        setCliIO(undefined);
        setDebug(false);
        captured.stdout = [];
        captured.stderr = [];
    });

    it('routes formatted errors to stderr with the [ERROR] prefix', () => {
        setLogger(undefined);
        setCliIO(sink);
        error(
            new CliError("Mod 'x' not found in project.json!", {
                tryHint: "Run 'pzstudio list'.",
            }),
        );
        expect(captured.stderr.join('')).toContain(
            "[ERROR] Problem: Mod 'x' not found in project.json!",
        );
        expect(captured.stderr.join('')).toContain("Try: Run 'pzstudio list'.");
        expect(captured.stdout).toHaveLength(0);
    });

    it('suppresses the stack of unexpected errors unless debug is on', () => {
        setLogger(undefined);
        setCliIO(sink);
        error(new Error('boom'));
        expect(captured.stderr.join('')).toContain('Unexpected error: boom');
        expect(captured.stderr.join('')).toContain(
            'Run with --debug for the full stack trace.',
        );

        setDebug(true);
        error(new Error('boom'));
        expect(captured.stderr.join('')).toMatch(/\n\s+at .+:\d+:\d+/);
    });

    it('keeps delegating to the external logger when one is installed', () => {
        const calls: unknown[] = [];
        setLogger({
            log: () => {},
            info: () => {},
            warn: () => {},
            verbose: () => {},
            error: (e) => calls.push(e),
        });
        setCliIO(sink);
        error(new Error('embedded'));
        expect(calls).toHaveLength(1);
        expect(captured.stderr).toHaveLength(0);
    });
});
