import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { version } from '../../packages/cli/package.json';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';
import { setVerbose } from '../../packages/cli/src/lib/logger';

describe('CLI Global Behavior (E2E)', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should show version with --version flag', async () => {
        const result = await workspace.run(undefined, ['--version']);
        workspace.assertSuccess(result);
        workspace.assertStdout(result, `v${version}`);
    });

    it('should show help by default when no command is provided', async () => {
        const result = await workspace.run();
        workspace.assertSuccess(result);
        workspace.assertStdout(result, 'add');
    });

    it('should show help with --help flag', async () => {
        const result = await workspace.run(undefined, ['--help']);
        workspace.assertSuccess(result);
        workspace.assertStdout(result, 'add');
    });

    it('should handle unknown commands with exit code 2', async () => {
        const result = await workspace.run('unknown-command');
        workspace.assertFailure(result, 2);
        workspace.assertStderr(result, 'Unknown command [unknown-command]');
    });

    it('should emit verbose/diagnostic output when --verbose flag is given', async () => {
        const result = await workspace.run('build', ['--verbose']);

        const hasVerbose = result.stderr.some(
            (line) =>
                line.includes('Project Dir:') ||
                line.includes('Executing command') ||
                line.includes('production=') ||
                line.includes('Targets:'),
        );
        expect(hasVerbose).toBe(true);

        setVerbose(false);
    });
});
