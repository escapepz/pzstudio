import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addCmd } from '../../packages/cli/src/lib/commands/add';
import { getHelp } from '../../packages/cli/src/lib/help';
import { setInvocationOptions } from '../../packages/cli/src/lib/args';
import { CliUsageError } from '../../packages/cli/src/lib/parser';
import { CliError } from '../../packages/cli/src/lib/errors';
import { resolveProjectConfig } from '../../packages/cli/src/lib/helper';

vi.mock('../../packages/cli/src/lib/helper', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../packages/cli/src/lib/helper')
    >()),
    resolveProjectConfig: vi.fn(),
}));

describe('add and the global --yes flag (d14-F1)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        setInvocationOptions(undefined);
    });

    it('refuses --yes with a usage error instead of silently ignoring it', () => {
        setInvocationOptions({ yes: true });

        expect(() => addCmd('Some Mod', 'some_mod')).toThrow(CliUsageError);
        expect(() => addCmd('Some Mod', 'some_mod')).toThrow(
            'The --yes flag is not applicable to command [add]: add is not destructive, so there is nothing to confirm (only delete and rename use it).',
        );
        expect(resolveProjectConfig).not.toHaveBeenCalled();
    });

    it('runs without --yes (the guard does not false-positive on other flags)', () => {
        vi.mocked(resolveProjectConfig).mockReturnValue(undefined as any);
        setInvocationOptions({ offline: true, 'force-update': true });

        expect(() => addCmd('Some Mod', 'some_mod')).toThrow(CliError);
        expect(() => addCmd('Some Mod', 'some_mod')).toThrow(
            'No pzstudio project found.',
        );
    });

    it('states plainly in the help text that --yes does not apply', () => {
        const help = getHelp('add') ?? '';
        expect(help).toContain('--yes is not applicable to add');
        expect(help).toContain('delete and rename');
    });
});
