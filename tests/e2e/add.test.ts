import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';
import * as cp from 'child_process';

vi.mock('child_process');

describe('add command e2e', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
        vi.spyOn(cp, 'spawnSync').mockImplementation((command, args) => {
            if (command === 'git') {
                const argsList = args as string[];
                if (argsList[0] === 'clone') {
                    const dest = argsList[argsList.length - 1];
                    fs.mkdirSync(dest, { recursive: true });
                    fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
                    // Create a dummy template structure if needed, or just leave it empty
                    // so it falls back to legacy if it wants to find something specific.
                    return {
                        status: 0,
                        stdout: Buffer.from(''),
                        stderr: Buffer.from(''),
                    } as any;
                }
            }
            return {
                status: 0,
                stdout: Buffer.from(''),
                stderr: Buffer.from(''),
            } as any;
        });
    });

    afterEach(() => {
        workspace.cleanup();
        vi.clearAllMocks();
    });

    it('should add a new mod to an existing project', async () => {
        // 1. Setup existing project
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    title: 'Main Project',
                    visibility: 'public',
                    tags: ['Building'],
                },
                mods: {
                    main_mod: {
                        name: 'Main Mod',
                        description: 'Main Desc',
                    },
                },
                excludes: [],
            }),
        );

        // 2. Run add command
        const newModTitle = 'Second Mod';
        const newModId = 'second_mod';
        const result = await workspace.run('add', [newModTitle, newModId]);

        try {
            workspace.assertSuccess(result);
            workspace.assertStderr(result, 'Command [add] completed');

            // 3. Verify filesystem
            expect(workspace.exists(newModId)).toBe(true);
            // The template might have media/lua or other structure, let's just check if it's a directory

            // 4. Verify project.json update
            const config = workspace.readJson('project.json');
            expect(config.mods[newModId]).toBeDefined();
            expect(config.mods[newModId].name).toBe(newModTitle);
            // Verify build.modInfo is NOT added (omission is the new default)
            expect(config.mods[newModId].build?.modInfo).toBeUndefined();
        } catch (e) {
            console.log('STDOUT:', result.stdout.join('\n'));
            console.log('STDERR:', result.stderr.join('\n'));
            throw e;
        }
    });

    it('should fail if not in a project directory', async () => {
        const result = await workspace.run('add', ['New Mod', 'new_mod']);
        workspace.assertFailure(result);
        workspace.assertStderr(result, 'No pzstudio project found.');
    });

    it('should fail if mod already exists', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    existing: {
                        name: 'E',
                        description: 'D',
                        build: { modInfo: 'skip' },
                    },
                },
                excludes: [],
            }),
        );
        workspace.write('existing/poster.png', 'fake');

        const result = await workspace.run('add', ['Existing', 'existing']);
        workspace.assertFailure(result);
        workspace.assertStderr(result, 'already exists');
    });

    it('should derive the mod id from the mod name when the id is omitted', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    title: 'Main Project',
                    visibility: 'public',
                    tags: ['Building'],
                },
                mods: {
                    main_mod: { name: 'Main Mod', description: 'Main Desc' },
                },
                excludes: [],
            }),
        );

        const result = await workspace.run('add', ['Second Mod']);

        workspace.assertSuccess(result);
        expect(workspace.exists('second_mod')).toBe(true);
        const config = workspace.readJson('project.json');
        expect(config.mods.second_mod.name).toBe('Second Mod');
    });

    it('should derive the mod id from the mod name when an explicit empty id is given', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    title: 'Main Project',
                    visibility: 'public',
                    tags: ['Building'],
                },
                mods: {
                    main_mod: { name: 'Main Mod', description: 'Main Desc' },
                },
                excludes: [],
            }),
        );

        const result = await workspace.run('add', ['Second Mod', '']);

        workspace.assertSuccess(result);
        expect(workspace.exists('second_mod')).toBe(true);
        const config = workspace.readJson('project.json');
        expect(config.mods.second_mod.name).toBe('Second Mod');
        expect(config.mods['']).toBeUndefined();
    });

    it('should fail with a clear error when the name normalizes to an empty id', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
            }),
        );

        const result = await workspace.run('add', ['???']);

        workspace.assertFailure(result);
        workspace.assertStderr(result, 'Cannot derive a valid mod id');
        expect(workspace.exists('???')).toBe(false);
        const config = workspace.readJson('project.json');
        expect(config.mods).toEqual({});
    });

    it('should retain normalization of an explicit valid id', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
            }),
        );

        const result = await workspace.run('add', [
            'Second Mod',
            'My Custom-ID!',
        ]);

        workspace.assertSuccess(result);
        expect(workspace.exists('my_customid')).toBe(true);
        const config = workspace.readJson('project.json');
        expect(config.mods.my_customid.name).toBe('Second Mod');
    });

    it('should reject a derived id that collides with an existing mod', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: { main_mod: { name: 'Main Mod', description: 'D' } },
                excludes: [],
            }),
        );

        const result = await workspace.run('add', ['Main Mod']);

        workspace.assertFailure(result);
        workspace.assertStderr(result, 'already exists');
        expect(workspace.exists('main_mod/poster.png')).toBe(false);
    });

    it('should not write a runtime-resolved outdir into a project.json that has none', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
            }),
        );
        workspace.writeGlobalConfig({ outdir: 'C:/fake/workshop' });

        const result = await workspace.run('add', ['Second Mod', 'second_mod']);

        workspace.assertSuccess(result);
        const config = workspace.readJson('project.json');
        expect(config.outdir).toBeUndefined();
    });

    it('should preserve an explicitly configured outdir exactly', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                outdir: './bin',
                mods: {},
                excludes: [],
            }),
        );

        const result = await workspace.run('add', ['Second Mod', 'second_mod']);

        workspace.assertSuccess(result);
        const config = workspace.readJson('project.json');
        expect(config.outdir).toBe('./bin');
    });

    it('should keep existing-mod defaults enrichment and custom fields', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                customRoot: 'keep-me',
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    existing: { name: 'E', description: 'D', customField: 'v' },
                },
                excludes: [],
            }),
        );

        const result = await workspace.run('add', ['Second Mod', 'second_mod']);

        workspace.assertSuccess(result);
        const config = workspace.readJson('project.json');
        expect(config.customRoot).toBe('keep-me');
        expect(config.mods.existing.poster).toBe('poster.png');
        expect(config.mods.existing.icon).toBe('icon.png');
        expect(config.mods.existing.build.modInfo).toBe('auto-if-missing');
        expect(config.mods.existing.customField).toBe('v');
        expect(config.mods.second_mod.build?.modInfo).toBeUndefined();
    });
});
