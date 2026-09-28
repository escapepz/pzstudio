import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { version } from '../../packages/cli/package.json';
import { RealEnvWorkspace } from '../helpers/real-env';

/**
 * Real-environment tests for the global CLI behavior: the built binary is
 * spawned as a child process and its genuine stdout/stderr/exit code are
 * asserted (the in-process e2e suite never sees a real terminal).
 */
describe('real env: CLI binary global behavior', () => {
    let workspace: RealEnvWorkspace;

    beforeEach(() => {
        workspace = new RealEnvWorkspace();
    });

    afterEach(async () => {
        await workspace.cleanup();
    });

    it('prints the package version for --version', async () => {
        const result = await workspace.run(['--version']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`v${version}`);
    });

    it('lists every registered command for --help', async () => {
        const result = await workspace.run(['--help']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Available commands:');
        for (const name of [
            'new',
            'add',
            'build',
            'clean',
            'delete',
            'doctor',
            'list',
            'migrate',
            'modconfig',
            'modinfo',
            'outdir',
            'rename',
            'update',
            'watch',
            'help',
        ]) {
            expect(result.stdout).toContain(name);
        }
    });

    it('prints the banner and help when no command is given', async () => {
        const result = await workspace.run([]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`Project Zomboid Studio v${version}`);
        expect(result.stdout).toContain('Available commands:');
    });

    it('fails with a friendly message for an unknown command', async () => {
        const result = await workspace.run(['definitely-not-a-command']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
            'Unknown command [definitely-not-a-command]',
        );
    });

    it('shows per-command help without entering a project', async () => {
        const result = await workspace.run(['help', 'build']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('pzstudio build');
    });
});
