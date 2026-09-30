import { describe, it, expect, afterEach, vi } from 'vitest';
// Importing the dispatcher registers every command into the registry
// (the parser builds its program from registered commands).
import '../../packages/cli/src/lib/cli';
import { runCLI } from '../../packages/cli/src/lib/cli';
import {
    parseArgv,
    normalizeLegacyInvocation,
    validateInvocation,
    classifyCommanderError,
    CliUsageError,
    CliIO,
    setCliIO,
    CommanderError,
} from '../../packages/cli/src/lib/parser';
import {
    hasFlag,
    extractFlag,
    setInvocationOptions,
} from '../../packages/cli/src/lib/args';

const VERSION_STUB = '9.9.9-test';

interface Captured {
    stdout: string[];
    stderr: string[];
}
function captureIO(): Captured {
    const captured: Captured = { stdout: [], stderr: [] };
    const sink: CliIO = {
        stdout: (t) => captured.stdout.push(t),
        stderr: (t) => captured.stderr.push(t),
    };
    setCliIO(sink);
    return captured;
}

afterEach(() => {
    setCliIO(undefined);
    setInvocationOptions(undefined);
});

describe('Commander parser adapter', () => {
    it('keeps valued option values out of positionals (Q1 fix)', async () => {
        const result = await parseArgv(
            ['add', 'MyMod', '--transport', 'fetch'],
            VERSION_STUB,
        );
        expect(result.kind).toBe('invocation');
        if (result.kind !== 'invocation') return;
        expect(result.invocation.command?.name).toBe('add');
        expect(result.invocation.positionals).toEqual(['MyMod']);
        expect(result.invocation.options['transport']).toBe('fetch');
    });

    it('parses global flags before the command (Q2 fix)', async () => {
        const result = await parseArgv(
            ['--verbose', 'new', 'My Mod'],
            VERSION_STUB,
        );
        expect(result.kind).toBe('invocation');
        if (result.kind !== 'invocation') return;
        expect(result.invocation.command?.name).toBe('new');
        expect(result.invocation.positionals).toEqual(['My Mod']);
        expect(result.invocation.options['verbose']).toBe(true);
    });

    it('parses global flags after the command too', async () => {
        const result = await parseArgv(['build', '--verbose'], VERSION_STUB);
        expect(result.kind).toBe('invocation');
        if (result.kind !== 'invocation') return;
        expect(result.invocation.options['verbose']).toBe(true);
    });

    it('consumes command flag values per the command schema', async () => {
        const result = await parseArgv(
            ['new', 'T', '--path', 'C:\\dev'],
            VERSION_STUB,
        );
        expect(result.kind).toBe('invocation');
        if (result.kind !== 'invocation') return;
        expect(result.invocation.positionals).toEqual(['T']);
        expect(result.invocation.options['path']).toBe('C:\\dev');
    });

    it('rejects unknown flags as usage errors (exit 2 contract)', async () => {
        const captured = captureIO();
        await expect(
            parseArgv(['build', '--wat'], VERSION_STUB),
        ).rejects.toMatchObject({
            name: 'CliUsageError',
            alreadyReported: true,
        });
        expect(captured.stderr.join('')).toContain('--wat');
    });

    it('rejects unknown commands as usage errors', async () => {
        await expect(parseArgv(['watxh'], VERSION_STUB)).rejects.toBeInstanceOf(
            CliUsageError,
        );
    });

    it('rejects invalid --transport choices', async () => {
        await expect(
            parseArgv(['--transport', 'svn', 'build'], VERSION_STUB),
        ).rejects.toBeInstanceOf(CliUsageError);
    });

    it('rejects missing required positionals', async () => {
        // Commander declares positionals optional (the shared validator owns
        // semantics), so the arity check happens in validateInvocation.
        const parsed = await parseArgv(['new'], VERSION_STUB);
        expect(parsed.kind).toBe('invocation');
        if (parsed.kind !== 'invocation') return;
        expect(() => validateInvocation(parsed.invocation)).toThrow(
            "Missing required argument '<title>'",
        );
    });

    it('rejects excess positionals for fixed-arity commands', async () => {
        await expect(
            parseArgv(['new', 'A', 'B', 'C'], VERSION_STUB),
        ).rejects.toBeInstanceOf(CliUsageError);
    });

    it('treats --version as terminal control flow with output on stdout', async () => {
        const captured = captureIO();
        const result = await parseArgv(['--version'], VERSION_STUB);
        expect(result.kind).toBe('terminal');
        expect(captured.stdout.join('')).toContain(`v${VERSION_STUB}`);
        expect(captured.stderr.join('')).toBe('');
    });

    it('captures bare --help as an option (curated help printed later)', async () => {
        const result = await parseArgv(['--help'], VERSION_STUB);
        expect(result.kind).toBe('invocation');
        if (result.kind !== 'invocation') return;
        expect(result.invocation.command).toBeUndefined();
        expect(result.invocation.options['help']).toBe(true);
    });

    it('captures per-command --help as an option', async () => {
        const result = await parseArgv(['build', '--help'], VERSION_STUB);
        expect(result.kind).toBe('invocation');
        if (result.kind !== 'invocation') return;
        expect(result.invocation.command?.name).toBe('build');
        expect(result.invocation.options['help']).toBe(true);
    });
});

describe('CommanderError classification (code-based)', () => {
    it('classifies help/version codes as control flow, not usage errors', () => {
        expect(
            classifyCommanderError(
                new CommanderError(0, 'commander.version', 'v'),
            ).kind,
        ).toBe('version');
        expect(
            classifyCommanderError(new CommanderError(0, 'commander.help', 'h'))
                .kind,
        ).toBe('help');
    });

    it('classifies all other commander codes as usage errors', () => {
        const usage = classifyCommanderError(
            new CommanderError(1, 'commander.unknownCommand', 'boom'),
        );
        expect(usage.kind).toBe('usage');
        expect(usage.message).toBe('boom');

        expect(
            classifyCommanderError(
                new CommanderError(1, 'commander.unknownOption', 'boom'),
            ).kind,
        ).toBe('usage');
    });

    it('rethrows non-commander errors untouched', () => {
        expect(() => classifyCommanderError(new Error('runtime'))).toThrow(
            'runtime',
        );
    });
});

describe('Embedded API never exits the host process', () => {
    it('runCLI rejects invalid argv with CliUsageError and keeps the host alive', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
            code?: number,
        ) => {
            throw new Error(`HOST DIED with exit ${code}`);
        }) as never);
        try {
            await expect(
                runCLI('build', [], { flags: ['--wat'] }),
            ).rejects.toBeInstanceOf(CliUsageError);
            await expect(runCLI('not-a-command')).rejects.toBeInstanceOf(
                CliUsageError,
            );
        } finally {
            exitSpy.mockRestore();
        }
    });
});

describe('Legacy embedded invocation normalization', () => {
    it('maps runCLI(cmd, args, {flags}) onto the shared invocation shape', () => {
        const invocation = normalizeLegacyInvocation(
            'build',
            [],
            ['--production'],
        );
        expect(invocation.command?.name).toBe('build');
        expect(invocation.positionals).toEqual([]);
        expect(invocation.options['production']).toBe(true);
    });

    it('consumes valued flags from mixed legacy tokens (Q1 fix)', () => {
        const invocation = normalizeLegacyInvocation(
            'new',
            ['T', '--path', 'C:\\d'],
            ['--verbose'],
        );
        expect(invocation.positionals).toEqual(['T']);
        expect(invocation.options['path']).toBe('C:\\d');
        expect(invocation.options['verbose']).toBe(true);
    });

    it('flags unknown legacy tokens for the shared validator', () => {
        const invocation = normalizeLegacyInvocation('build', [], ['--wat']);
        expect(invocation.unknownOptions).toEqual(['--wat']);
    });
});

describe('Shared semantic validation', () => {
    it('rejects unknown commands from the embedded path with a suggestion', () => {
        const invocation = normalizeLegacyInvocation('watxh', [], []);
        expect(() => validateInvocation(invocation)).toThrow(
            /Unknown command \[watxh\]/,
        );
    });

    it('rejects unknown options from the embedded path', () => {
        const invocation = normalizeLegacyInvocation('build', [], ['--wat']);
        expect(() => validateInvocation(invocation)).toThrow(
            /Unknown option '--wat'/,
        );
    });

    it('rejects invalid transport choices from the embedded path', () => {
        const invocation = normalizeLegacyInvocation(
            'build',
            [],
            ['--transport', 'svn'],
        );
        expect(() => validateInvocation(invocation)).toThrow(
            /Invalid --transport value 'svn'/,
        );
    });

    it('rejects missing required positionals from the embedded path', () => {
        const invocation = normalizeLegacyInvocation('delete', [], []);
        expect(() => validateInvocation(invocation)).toThrow(
            /Missing required argument '<modId>'/,
        );
    });

    it('rejects excess positionals from the embedded path', () => {
        const invocation = normalizeLegacyInvocation('delete', ['a', 'b'], []);
        expect(() => validateInvocation(invocation)).toThrow(
            /Too many arguments for command \[delete\]/,
        );
    });

    it('accepts variadic positionals (modconfig)', () => {
        const invocation = normalizeLegacyInvocation(
            'modconfig',
            ['MyMod', 'set', 'name', 'value'],
            [],
        );
        const valid = validateInvocation(invocation);
        expect(valid.positionals).toHaveLength(4);
    });

    it('accepts a valid legacy invocation unchanged', () => {
        const invocation = normalizeLegacyInvocation('build', [], ['--both']);
        const valid = validateInvocation(invocation);
        expect(valid.command.name).toBe('build');
    });
});

describe('Flag readers over the current invocation', () => {
    it('hasFlag/extractFlag read the published invocation options', () => {
        expect(hasFlag('force')).toBe(false);
        expect(extractFlag('game-build')).toBeUndefined();

        setInvocationOptions({ force: true, 'game-build': '42.20' });
        expect(hasFlag('force')).toBe(true);
        expect(extractFlag('game-build')).toBe('42.20');
        expect(extractFlag('force')).toBeUndefined();
    });

    it('cleared options make every reader false', () => {
        setInvocationOptions({ verbose: true });
        setInvocationOptions(undefined);
        expect(hasFlag('verbose')).toBe(false);
    });
});
