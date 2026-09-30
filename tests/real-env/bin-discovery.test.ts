import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RealEnvWorkspace, hasLegacyTemplates } from '../helpers/real-env';

/**
 * Real-environment tests for fail-closed project discovery (CLI-5): the
 * spawned binary must locate projects through the -C/--project anchor and
 * walk-up, and must fail closed with the structured discovery error when no
 * project.json exists — never pretend the start directory is a project.
 */
describe('real env: project discovery contract', () => {
    let workspace: RealEnvWorkspace;

    beforeEach(() => {
        workspace = new RealEnvWorkspace();
    });

    afterEach(async () => {
        await workspace.cleanup();
    });

    function writeProject(dir: string, title = 'Anchor Project'): void {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
                workshop: { title, visibility: 'public', tags: [] },
                mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
                excludes: [],
            }),
        );
    }

    it('runs a project command through the -C anchor from a different cwd', async () => {
        const proj = workspace.path('proj');
        writeProject(proj);

        // cwd is the workspace root (no project.json there), the project
        // lives one level down and is pointed at via the anchor.
        const short = await workspace.run(['-C', proj, 'list']);
        expect(short.exitCode).toBe(0);
        expect(short.stdout).toContain('Mods in project');

        const long = await workspace.run(['--project', proj, 'list']);
        expect(long.exitCode).toBe(0);
        expect(long.stdout).toContain('Mods in project');
    });

    it('parses the attached short form -C<dir>', async () => {
        const proj = workspace.path('proj');
        writeProject(proj);

        const result = await workspace.run(['-C' + proj, 'list']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Mods in project');
    });

    it('still finds the project by walking up from a subdirectory', async () => {
        const proj = workspace.path('proj');
        writeProject(proj);
        const sub = path.join(proj, 'sub', 'dir');
        fs.mkdirSync(sub, { recursive: true });

        const result = await workspace.run(['list'], { cwd: sub });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Mods in project');
    });

    it('fails closed with the structured discovery error outside a project', async () => {
        const result = await workspace.run(['list']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No pzstudio project found.');
        expect(result.stderr).toContain('Searched from');
        expect(result.stderr).toContain('pzstudio new');
    });

    it('reports the -C anchor in the discovery error cause', async () => {
        const missing = workspace.path('does-not-exist');

        const result = await workspace.run(['-C', missing, 'list']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No pzstudio project found.');
        expect(result.stderr).toContain('Searched from');
        expect(result.stderr).toContain('does-not-exist');
    });

    it('migrate works outside a project (global config only)', async () => {
        const result = await workspace.run(['migrate']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No project.json found');
    });

    it('help and version stay pure invocations outside a project', async () => {
        const help = await workspace.run(['help']);
        expect(help.exitCode).toBe(0);
        expect(help.stdout).toContain('Available commands:');

        const version = await workspace.run(['--version']);
        expect(version.exitCode).toBe(0);
        // A pure invocation must not create the config store.
        expect(workspace.exists('.pzstudio', 'home')).toBe(false);
    });

    it.skipIf(!hasLegacyTemplates())(
        'new honors the -C anchor as the destination',
        async () => {
            const dest = workspace.path('anchored-dest');
            const neutral = workspace.path('neutral');
            fs.mkdirSync(neutral, { recursive: true });

            const result = await workspace.run(
                ['-C', dest, 'new', '--offline', 'Anchor New', 'anchor_new'],
                { cwd: neutral },
            );
            expect(result.exitCode).toBe(0);
            expect(
                fs.existsSync(path.join(dest, 'anchor_new', 'project.json')),
            ).toBe(true);
            // Nothing leaked into the cwd of the invocation.
            expect(fs.existsSync(path.join(neutral, 'anchor_new'))).toBe(false);
        },
    );
});
