import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { version } from '../../packages/cli/package.json';
import { RealEnvWorkspace } from '../helpers/real-env';

/**
 * Pure-invocation contract of the Commander parser (CLI-1), asserted against
 * the real binary: help/version/unknown command/flag must complete BEFORE any
 * lifecycle side effect (config creation, migrations, project discovery,
 * template resolution), and valued options must never leak into positionals.
 *
 * Side-effect probe: a fresh fake home contains no ~/.pzstudio — a pure
 * invocation must not create one (the old CLI ran migrations on every call).
 */
describe('real env: parser pure-invocation contract', () => {
    let workspace: RealEnvWorkspace;

    beforeEach(() => {
        workspace = new RealEnvWorkspace();
    });

    afterEach(async () => {
        await workspace.cleanup();
    });

    function expectNoStoreCreation(): void {
        expect(workspace.exists('.pzstudio', 'home')).toBe(false);
    }

    it('root --help is pure: help on stdout, exit 0, no store created', async () => {
        const result = await workspace.run(['--help']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Available commands:');
        expect(result.stderr).toBe('');
        expectNoStoreCreation();
    });

    it('per-command --help is pure and works outside a project', async () => {
        const result = await workspace.run(['build', '--help']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('pzstudio build');
        expect(result.stderr).toBe('');
        expectNoStoreCreation();
    });

    it('--version is pure: version on stdout, exit 0, no store created', async () => {
        const result = await workspace.run(['--version']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`v${version}`);
        expectNoStoreCreation();
    });

    it('help/version output carries no ANSI control bytes when piped', async () => {
        const help = await workspace.run(['--help']);
        const ver = await workspace.run(['--version']);
        expect(help.stdout).not.toContain('\u001b');
        expect(ver.stdout).not.toContain('\u001b');
    });

    it('unknown command is a usage error (exit 2) with no side effects', async () => {
        const result = await workspace.run(['watxh']);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('Unknown command [watxh]');
        expectNoStoreCreation();
    });

    it('unknown flag is a usage error (exit 2) with no side effects', async () => {
        const result = await workspace.run(['build', '--wat']);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('--wat');
        expectNoStoreCreation();
    });

    it('valued option does not become a positional (Q1)', async () => {
        // `help --transport fetch`: if 'fetch' leaked into positionals, help
        // would render the topic page for "fetch" and fail; consuming it as
        // the option value renders the full help instead.
        const result = await workspace.run(['help', '--transport', 'fetch']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Available commands:');
        expect(result.stderr).toBe('');
        expectNoStoreCreation();
    });

    it('global flag before the command parses cleanly (Q2)', async () => {
        const result = await workspace.run(['--transport', 'fetch', 'help']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Available commands:');
        expect(result.stderr).toBe('');
        expectNoStoreCreation();
    });

    it('a valid command may still create the store (control case)', async () => {
        // Contrast probe: a real command goes through the lifecycle and is
        // allowed to create the global config.
        const result = await workspace.run(['migrate']);
        expect(result.exitCode).toBe(0);
        expect(workspace.exists('.pzstudio', 'home')).toBe(true);
    });
});
