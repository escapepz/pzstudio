import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RealEnvWorkspace } from '../helpers/real-env';

/**
 * Real-environment tests for the machine JSON contract v1 (CLI-8): the
 * spawned binary's --json output must be parseable by a plain JSON.parse
 * of stdout and carry semantic fields only. Failure semantics: a domain
 * error still prints the envelope (result.status 'error') and exits 1;
 * a runtime failure prints NOTHING on stdout.
 */
describe('real env: --json contract (CLI-8)', () => {
    let workspace: RealEnvWorkspace;

    beforeEach(() => {
        workspace = new RealEnvWorkspace();
    });

    afterEach(async () => {
        await workspace.cleanup();
    });

    function writeHealthyProject(): void {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    title: 'Json Project',
                    visibility: 'public',
                    tags: [],
                },
                mods: {
                    my_mod: { name: 'My Mod', description: 'A mod.' },
                },
                excludes: [],
                schemaVersion: 2,
            }),
        );
        workspace.write('my_mod/42/mod.info', 'id=my_mod\nname=My Mod');
    }

    it('list --json prints an envelope JSON.parse understands', async () => {
        writeHealthyProject();

        const result = await workspace.run(['list', '--json']);
        expect(result.exitCode).toBe(0);

        const envelope = JSON.parse(result.stdout);
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.command).toBe('list');
        expect(envelope.result.title).toBe('Json Project');
        expect(envelope.result.mods).toEqual([
            {
                id: 'my_mod',
                name: 'My Mod',
                onDisk: true,
                excluded: false,
                devOnly: false,
            },
        ]);
        // No human report leaks into the machine stream.
        expect(result.stdout).not.toContain('Mods in project');
    });

    it('doctor --json exits 1 with status error while stdout stays parseable', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: { ghost: { name: 'Ghost', description: 'gone' } },
                excludes: [],
            }),
        );

        const result = await workspace.run(['doctor', '--json']);
        expect(result.exitCode).toBe(1);

        const envelope = JSON.parse(result.stdout);
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.command).toBe('doctor');
        expect(envelope.result.status).toBe('error');
        expect(envelope.result.counts.errors).toBeGreaterThan(0);
    });

    it('a runtime failure before a result exists leaves stdout empty (exit 1)', async () => {
        // No project at all: list --json fails closed before any envelope.
        // stdout carries no DATA — at most the blank separator line the
        // lifecycle prints before dispatch, so trim before judging.
        const result = await workspace.run(['list', '--json']);
        expect(result.exitCode).toBe(1);
        expect(result.stdout.trim()).toBe('');
        expect(result.stderr).toContain('No pzstudio project found.');
    });
});
