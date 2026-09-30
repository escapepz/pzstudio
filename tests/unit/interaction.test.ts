import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    confirmDestructive,
    getInteractionMode,
    setInteractionMode,
    setStdinReader,
} from '../../packages/cli/src/lib/interaction';
import { setInvocationOptions } from '../../packages/cli/src/lib/args';
import { CliUsageError, setCliIO } from '../../packages/cli/src/lib/parser';
import { CliError } from '../../packages/cli/src/lib/errors';

describe('interaction policy (CLI-9)', () => {
    beforeEach(() => {
        setInvocationOptions(undefined);
        setInteractionMode('embedded');
        setStdinReader(undefined);
        setCliIO(undefined);
    });

    it('defaults to embedded mode', () => {
        expect(getInteractionMode()).toBe('embedded');
    });

    it('embedded mode never prompts and always proceeds', () => {
        const reader = vi.fn(() => 'y');
        setStdinReader(reader);
        expect(() =>
            confirmDestructive('delete', ['some_mod'], 'Delete?'),
        ).not.toThrow();
        expect(reader).not.toHaveBeenCalled();
    });

    it('non-interactive mode refuses without --yes and suggests the exact command', () => {
        setInteractionMode('non-interactive');
        expect(() =>
            confirmDestructive('delete', ['some_mod'], 'Delete?'),
        ).toThrow(CliUsageError);
        expect(() =>
            confirmDestructive('delete', ['some_mod'], 'Delete?'),
        ).toThrow(
            "Refusing 'delete' without confirmation in a non-interactive session. " +
                'Try: pzstudio delete some_mod --yes',
        );
        expect(() =>
            confirmDestructive('rename', ['a', 'b'], 'Rename?'),
        ).toThrow('Try: pzstudio rename a b --yes');
    });

    it('non-interactive mode proceeds with --yes without prompting', () => {
        setInvocationOptions({ yes: true });
        setInteractionMode('non-interactive');
        const reader = vi.fn(() => 'n');
        setStdinReader(reader);
        expect(() =>
            confirmDestructive('delete', ['some_mod'], 'Delete?'),
        ).not.toThrow();
        expect(reader).not.toHaveBeenCalled();
    });

    it('interactive mode asks through CliIO and proceeds when the user answers y', () => {
        setInteractionMode('interactive');
        const written: string[] = [];
        setCliIO({ stdout: (t) => written.push(t), stderr: () => {} });
        setStdinReader(() => 'y');
        expect(() =>
            confirmDestructive('delete', ['some_mod'], 'Delete?'),
        ).not.toThrow();
        expect(written.join('')).toBe('Delete? [y/N] ');
    });

    it('interactive mode proceeds for a capitalized YES answer', () => {
        setInteractionMode('interactive');
        setStdinReader(() => '  YES  ');
        expect(() =>
            confirmDestructive('delete', ['some_mod'], 'Delete?'),
        ).not.toThrow();
    });

    it('interactive mode aborts with no changes on any other answer', () => {
        setInteractionMode('interactive');
        setStdinReader(() => 'n');
        expect(() =>
            confirmDestructive('delete', ['some_mod'], 'Delete?'),
        ).toThrow(CliError);
        expect(() =>
            confirmDestructive('delete', ['some_mod'], 'Delete?'),
        ).toThrow('Aborted. Nothing was changed.');
    });

    it('interactive mode aborts on an empty answer (default No)', () => {
        setInteractionMode('interactive');
        setStdinReader(() => '');
        expect(() =>
            confirmDestructive('delete', ['some_mod'], 'Delete?'),
        ).toThrow('Aborted. Nothing was changed.');
    });

    it('interactive mode with --yes proceeds without prompting', () => {
        setInvocationOptions({ yes: true });
        setInteractionMode('interactive');
        const reader = vi.fn(() => 'n');
        setStdinReader(reader);
        expect(() =>
            confirmDestructive('delete', ['some_mod'], 'Delete?'),
        ).not.toThrow();
        expect(reader).not.toHaveBeenCalled();
    });
});
