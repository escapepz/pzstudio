import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RealEnvWorkspace } from '../helpers/real-env';

/**
 * Real-environment tests for the project-management commands (migrate,
 * modconfig, list, modinfo, rename, outdir): each run mutates the fixture
 * project or the fake home's global config through the spawned binary.
 */
describe('real env: project lifecycle commands', () => {
    let workspace: RealEnvWorkspace;

    beforeEach(() => {
        workspace = new RealEnvWorkspace();
    });

    afterEach(async () => {
        await workspace.cleanup();
    });

    function writeProjectFixture(ws: RealEnvWorkspace): void {
        ws.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    title: 'Lifecycle',
                    visibility: 'public',
                    tags: ['Build 42'],
                },
                mods: {
                    disk_mod: { name: 'Disk Mod', description: 'On disk.' },
                },
                excludes: [],
                schemaVersion: 2,
            }),
        );
        ws.write('disk_mod/42/media/lua/shared.lua', '-- lua');
    }

    describe('migrate', () => {
        it('upgrades a legacy project.json in place', async () => {
            workspace.write(
                'project.json',
                JSON.stringify({
                    id: 'legacy_id',
                    title: 'Legacy Title',
                    authors: ['Author1'],
                    workshop: {
                        visibility: 'public',
                        tags: ['Building'],
                        excludes: ['temp'],
                    },
                    mods: {
                        my_mod: { name: 'My Mod', description: 'Desc' },
                    },
                }),
            );

            const result = await workspace.run(['migrate']);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('Migrating project.json');
            expect(result.stdout).toContain(
                'project.json upgraded and synced successfully',
            );

            const upgraded = workspace.readJson('project.json');
            expect(upgraded.id).toBeUndefined();
            expect(upgraded.title).toBeUndefined();
            expect(upgraded.authors).toBeUndefined();
            expect(upgraded.workshop.id).toBe('legacy_id');
            expect(upgraded.workshop.title).toBe('Legacy Title');
            expect(upgraded.workshop.excludes).toBeUndefined();
            expect(upgraded.excludes).toContain('temp');
        });
    });

    describe('modconfig', () => {
        it('sets a field and reads it back through show', async () => {
            writeProjectFixture(workspace);

            const setResult = await workspace.run([
                'modconfig',
                'disk_mod',
                'set',
                'author',
                'RealEnvAuthor',
            ]);
            expect(setResult.exitCode).toBe(0);
            expect(setResult.stdout).toContain('project.json updated.');
            expect(
                workspace.readJson('project.json').mods.disk_mod.author,
            ).toBe('RealEnvAuthor');

            const showResult = await workspace.run(['modconfig', 'disk_mod']);
            expect(showResult.exitCode).toBe(0);
            expect(showResult.stdout).toContain('author = RealEnvAuthor');
        });

        it('rejects an unknown mod id with a clear error', async () => {
            writeProjectFixture(workspace);

            const result = await workspace.run([
                'modconfig',
                'no_such_mod',
                'show',
            ]);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain(
                "Mod 'no_such_mod' is not in project.json",
            );
        });
    });

    describe('list', () => {
        it('prints every mod with its real build state', async () => {
            workspace.write(
                'project.json',
                JSON.stringify({
                    workshop: {
                        title: 'Lifecycle',
                        visibility: 'public',
                        tags: [],
                    },
                    mods: {
                        disk_mod: { name: 'Disk', description: 'D' },
                        dev_mod: {
                            name: 'Dev',
                            description: 'D',
                            build: { devOnly: true },
                        },
                        ghost_mod: { name: 'Ghost', description: 'D' },
                        excluded_mod: { name: 'Excluded', description: 'D' },
                    },
                    excludes: ['excluded_mod'],
                    schemaVersion: 2,
                }),
            );
            workspace.write('disk_mod/42/media/lua/shared.lua', '-- lua');
            workspace.write('dev_mod/42/media/lua/shared.lua', '-- lua');
            workspace.write('excluded_mod/42/media/lua/shared.lua', '-- lua');

            const result = await workspace.run(['list']);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("Mods in project 'Lifecycle'");
            expect(result.stdout).toContain('on disk, included');
            expect(result.stdout).toContain('on disk, dev builds only');
            expect(result.stdout).toContain('missing on disk');
            expect(result.stdout).toContain(
                'on disk, excluded from workshop build',
            );
        });
    });

    describe('modinfo', () => {
        it('generates mod.info into the Build 42 branch folder', async () => {
            writeProjectFixture(workspace);

            const result = await workspace.run([
                'modinfo',
                'generate',
                'disk_mod',
            ]);
            expect(result.exitCode).toBe(0);

            const modInfoPath = path.join('disk_mod', '42', 'mod.info');
            expect(workspace.exists(modInfoPath)).toBe(true);
            expect(workspace.read(modInfoPath)).toContain('id=disk_mod');
        });
    });

    describe('rename', () => {
        it('renames the folder, the config key, and file contents', async () => {
            writeProjectFixture(workspace);
            workspace.write(
                'disk_mod/42/media/lua/shared/rename_me.lua',
                '-- owned by disk_mod\n',
            );

            const result = await workspace.run([
                'rename',
                'disk_mod',
                'renamed_mod',
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(
                "Mod 'disk_mod' updated to 'renamed_mod' in project.json!",
            );

            const config = workspace.readJson('project.json');
            expect(config.mods.renamed_mod).toBeDefined();
            expect(config.mods.disk_mod).toBeUndefined();

            expect(workspace.exists('disk_mod')).toBe(false);
            const luaPath = path.join(
                'renamed_mod',
                '42',
                'media',
                'lua',
                'shared',
                'rename_me.lua',
            );
            expect(workspace.read(luaPath)).toContain('owned by renamed_mod');
        });
    });

    describe('outdir', () => {
        it('writes the resolved path into the fake home global config', async () => {
            fs.mkdirSync(workspace.path('custom_out'), { recursive: true });

            const result = await workspace.run(['outdir', 'custom_out']);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(
                'The output directory has been changed to',
            );

            const config = workspace.readJson(
                path.join('.pzstudio', 'config.json'),
                'home',
            );
            // The spawned CLI resolves through its real cwd; on macOS the
            // tmp dir sits behind the /var -> /private/var symlink.
            expect(config.outdir).toBe(
                fs.realpathSync(workspace.path('custom_out')),
            );
        });

        it('rejects a path that does not exist', async () => {
            const result = await workspace.run(['outdir', 'no_such_dir']);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('does not exist');
        });
    });
});
