import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOutRoot, RealEnvWorkspace } from '../helpers/real-env';

/**
 * Real-environment tests for `pzstudio doctor`: the spawned binary must
 * produce the same module findings and exit codes the engine guarantees,
 * through a real terminal run.
 */
describe('real env: doctor command', () => {
    let workspace: RealEnvWorkspace;

    beforeEach(() => {
        workspace = new RealEnvWorkspace();
    });

    afterEach(async () => {
        await workspace.cleanup();
    });

    it('fails closed with the structured discovery error outside a project directory', async () => {
        const result = await workspace.run(['doctor']);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain('Summary:');
        expect(result.stderr).toContain('No pzstudio project found.');
        expect(result.stderr).toContain('Searched from');
        expect(result.stderr).toContain('pzstudio new');
    });

    it('passes a fully healthy project with exit code 0', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    id: 12345,
                    title: 'Real Healthy',
                    visibility: 'public',
                    tags: ['Build 42'],
                },
                mods: {
                    my_mod: { name: 'My Mod', description: 'A mod.' },
                },
                excludes: [],
                schemaVersion: 2,
            }),
        );
        workspace.write('workshop/description.txt', 'A description');
        workspace.write('workshop/preview.png', 'png-bytes');
        workspace.write('my_mod/42/mod.info', 'id=my_mod\nname=My Mod');
        workspace.write('my_mod/42/media/lua/shared.lua', '-- lua');
        // The default output dir must exist so the filesystem module stays quiet.
        fs.mkdirSync(defaultOutRoot(workspace.home), { recursive: true });

        const result = await workspace.run(['doctor']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("'Real Healthy'");
        expect(result.stdout).toContain('No errors or warnings');
    });

    it('fails with a typed finding when project.json is malformed', async () => {
        workspace.write('project.json', '{ broken json ]]]');

        const result = await workspace.run(['doctor']);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain('project.json');
        expect(result.stderr).toContain('Doctor found 1 error(s)');
    });

    it('reports a mod declared but missing on disk as an error', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    ghost: { name: 'Ghost', description: 'not on disk' },
                },
                excludes: [],
            }),
        );

        const result = await workspace.run(['doctor']);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("Mod folder 'ghost' is declared");
        expect(result.stderr).toContain('Doctor found 1 error(s)');
    });
});
