import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RealEnvWorkspace } from '../helpers/real-env';

/**
 * Real-environment contract for the CLI-3 error model, exercised through
 * the spawned binary: structured CliErrors render as Problem/Cause/Try,
 * unexpected errors print the wrapped message with a --debug hint, and a
 * full stack trace appears only under --debug. Stack frames are detected
 * by their "  at file:line:col" shape so normal prose cannot false-positive.
 */
const STACK_FRAME = /\n\s+at .+:\d+:\d+/;
const DEBUG_HINT = 'Run with --debug for the full stack trace.';

describe('real env: error model contract', () => {
    let workspace: RealEnvWorkspace;

    beforeEach(() => {
        workspace = new RealEnvWorkspace();
    });

    afterEach(async () => {
        await workspace.cleanup();
    });

    function writeProjectFixture(mods: Record<string, object>): void {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'T', visibility: 'public', tags: [] },
                mods,
                excludes: [],
                schemaVersion: 2,
            }),
        );
    }

    it('renders a structured CliError as Problem/Cause/Try without a stack', async () => {
        writeProjectFixture({
            disk_mod: { name: 'Disk Mod', description: 'On disk.' },
        });

        const result = await workspace.run(['delete', 'missing_mod']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
            "Problem: Mod 'missing_mod' not found in project.json!",
        );
        expect(result.stderr).toContain('Cause: project.json only lists mods');
        expect(result.stderr).toContain(
            "Try: Run 'pzstudio list' to see the mods of this project.",
        );
        // Structured errors are complete guidance: no stack hint, no frames.
        expect(result.stderr).not.toContain(DEBUG_HINT);
        expect(result.stderr).not.toMatch(STACK_FRAME);
    });

    it('prints the full stack of an unexpected error only with --debug', async () => {
        writeProjectFixture({
            mod_a: { name: 'A', description: 'A' },
            mod_b: { name: 'B', description: 'B' },
        });

        const plain = await workspace.run(['rename', 'mod_a', 'mod_b']);
        expect(plain.exitCode).toBe(1);
        expect(plain.stderr).toContain(
            "Unexpected error: A mod with id 'mod_b' already exists!",
        );
        expect(plain.stderr).toContain(DEBUG_HINT);
        expect(plain.stderr).not.toMatch(STACK_FRAME);

        const debugged = await workspace.run([
            'rename',
            'mod_a',
            'mod_b',
            '--debug',
        ]);
        expect(debugged.exitCode).toBe(1);
        expect(debugged.stderr).toContain('Unexpected error:');
        expect(debugged.stderr).toMatch(STACK_FRAME);
        expect(debugged.stderr).not.toContain(DEBUG_HINT);
    });

    it('keeps structured rendering on outdir failures', async () => {
        const result = await workspace.run(['outdir', 'no_such_dir']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Problem: The output directory');
        expect(result.stderr).toContain(
            'Try: Create the directory first, then run pzstudio outdir again.',
        );
        expect(result.stderr).not.toMatch(STACK_FRAME);
    });
});
