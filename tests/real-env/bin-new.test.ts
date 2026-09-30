import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RealEnvWorkspace, hasLegacyTemplates } from '../helpers/real-env';

/**
 * Real-environment tests for `pzstudio new`: the spawned binary bootstraps
 * the bundled legacy templates into the fake home and scaffolds a complete
 * project on the real filesystem. Skipped when the build was made without
 * the .template-legacy submodules (CI checks them out recursively).
 */
describe.skipIf(!hasLegacyTemplates())(
    'real env: new command with bundled templates',
    () => {
        let workspace: RealEnvWorkspace;

        beforeEach(() => {
            workspace = new RealEnvWorkspace();
        });

        afterEach(async () => {
            await workspace.cleanup();
        });

        it('creates a complete project offline from the bundled templates', async () => {
            const result = await workspace.run([
                'new',
                '--offline',
                'Real Env Project',
                'real_mod',
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stderr).toContain(
                "The project 'Real Env Project' has been created",
            );
            // Golden path (CLI-7): next steps on stdout.
            expect(result.stdout).toContain('Next:');

            const config = workspace.readJson(
                path.join('real_mod', 'project.json'),
            );
            expect(config.workshop.title).toBe('Real Env Project');
            expect(config.mods.real_mod).toBeDefined();
            expect(config.excludes).toEqual([]);

            // The scaffolded structure landed for real.
            expect(workspace.exists(path.join('real_mod', 'workshop'))).toBe(
                true,
            );
            expect(
                workspace.exists(path.join('real_mod', 'real_mod', '42')),
            ).toBe(true);
            expect(
                workspace.exists(path.join('real_mod', '.template-mod')),
            ).toBe(true);
            expect(
                workspace.exists(path.join('real_mod', '.template-language')),
            ).toBe(true);
        });

        it('refuses to create a project over an existing directory', async () => {
            workspace.write(path.join('real_mod', 'occupied.txt'), 'taken');
            const result = await workspace.run([
                'new',
                '--offline',
                'Real Env Project',
                'real_mod',
            ]);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('already exists');
            // The occupant survived untouched.
            expect(workspace.read(path.join('real_mod', 'occupied.txt'))).toBe(
                'taken',
            );
        });

        it('refuses to create a project inside an existing project', async () => {
            const created = await workspace.run([
                'new',
                '--offline',
                'Real Env Project',
                'real_mod',
            ]);
            expect(created.exitCode).toBe(0);

            const inner = await workspace.run(
                ['new', '--offline', 'Inner Project', 'inner_mod'],
                { cwd: workspace.path('real_mod') },
            );
            expect(inner.exitCode).toBe(1);
            expect(inner.stderr).toContain('within a project directory');
        });

        it('leaves nothing behind when the pre-commit phase fails', async () => {
            // --path pointing at an existing FILE: creating the staging
            // directory fails (ENOTDIR) inside the transaction, before any
            // commit happens.
            workspace.write('occupied.txt', 'taken');

            const result = await workspace.run([
                'new',
                '--offline',
                '--path',
                'occupied.txt',
                'Real Env Project',
                'real_mod',
            ]);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('No project was created.');
            expect(result.stderr).toContain('Cause: ');
            // The occupant survived and no staging leftovers exist.
            expect(workspace.read('occupied.txt')).toBe('taken');
            expect(fs.readdirSync(workspace.dir)).toEqual(['occupied.txt']);
        });
    },
);
