import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

describe('rename command e2e', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should rename an existing mod', async () => {
        // 1. Setup existing project with a mod
        const oldModId = 'old_mod';
        const newModId = 'new_mod';
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    [oldModId]: {
                        name: 'Old Mod',
                        description: 'Old Description',
                    },
                },
                excludes: [],
            }),
        );

        // Create mod directory and some files containing the old ID
        workspace.write(`${oldModId}/mod.info`, `id=${oldModId}\nname=Old Mod`);
        workspace.write(
            `${oldModId}/media/lua/shared/test.lua`,
            `print("${oldModId}")`,
        );

        // 2. Run rename command (embedded API: --yes IS the confirmation)
        const result = await workspace.run('rename', [
            oldModId,
            newModId,
            '--yes',
        ]);

        try {
            workspace.assertSuccess(result);
            workspace.assertStderr(
                result,
                `Renaming mod '${oldModId}' to '${newModId}'`,
            );

            // 3. Verify filesystem
            expect(workspace.exists(oldModId)).toBe(false);
            expect(workspace.exists(newModId)).toBe(true);

            // Verify file content update
            const modInfo = workspace.read(`${newModId}/mod.info`);
            expect(modInfo).toContain(`id=${newModId}`);

            const luaFile = workspace.read(
                `${newModId}/media/lua/shared/test.lua`,
            );
            expect(luaFile).toContain(`print("${newModId}")`);

            // 4. Verify project.json update
            const config = workspace.readJson('project.json');
            expect(config.mods[oldModId]).toBeUndefined();
            expect(config.mods[newModId]).toBeDefined();
        } catch (e) {
            console.log('STDOUT:', result.stdout.join('\n'));
            console.log('STDERR:', result.stderr.join('\n'));
            throw e;
        }
    });

    it('should fail if not in a project directory', async () => {
        const result = await workspace.run('rename', ['old', 'new']);
        workspace.assertFailure(result);
        workspace.assertStderr(result, 'No pzstudio project found.');
    });

    it('should fail if old mod does not exist', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
            }),
        );

        const result = await workspace.run('rename', ['nonexistent', 'new']);
        workspace.assertFailure(result);
        workspace.assertStderr(result, "Mod 'nonexistent' does not exist");
    });

    it('should fail if new mod id already exists in config', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    old: { name: 'O', description: 'D' },
                    existing: { name: 'E', description: 'D' },
                },
                excludes: [],
            }),
        );

        const result = await workspace.run('rename', ['old', 'existing']);
        workspace.assertFailure(result);
        workspace.assertStderr(result, 'already exists');
    });

    it('should fail if new mod id directory already exists', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    old: { name: 'O', description: 'D' },
                },
                excludes: [],
            }),
        );
        workspace.write('existing/poster.png', 'fake');

        const result = await workspace.run('rename', ['old', 'existing']);
        workspace.assertFailure(result);
        workspace.assertStderr(result, 'already exists');
    });

    it('should fail when oldModId argument is missing', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
            }),
        );

        // rename called with no positional args → usage error (exit 2)
        const result = await workspace.run('rename', []);
        workspace.assertFailure(result, 2);
        workspace.assertStderr(
            result,
            "Missing required argument '<oldModId>' for command [rename]",
        );
    });

    it('should rename experimental mod scripts in package.json', async () => {
        const oldModId = 'old_mod';
        const newModId = 'new_mod';
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    [oldModId]: {
                        name: 'Old Mod',
                        description: 'Old Description',
                    },
                },
                excludes: [],
                // Opt in (CLI-10): the script rewrite only runs when the
                // project explicitly enables experimental integration.
                experimental: { integration: true },
            }),
        );
        workspace.write(`${oldModId}/mod.info`, `id=${oldModId}\nname=Old Mod`);

        // Pre-populate package.json with an experimental mod script
        workspace.write(
            'package.json',
            JSON.stringify({
                name: 'test',
                scripts: {
                    [`experimental:setup:nonsteam:${oldModId}`]: `mklink /J "C:\\ZomboidClient1\\mods\\${oldModId}" "%CD%\\${oldModId}"`,
                },
            }),
        );

        const result = await workspace.run('rename', [
            oldModId,
            newModId,
            '--yes',
        ]);

        try {
            workspace.assertSuccess(result);

            const pkg = workspace.readJson('package.json');
            // Old script key should be removed
            expect(
                pkg.scripts[`experimental:setup:nonsteam:${oldModId}`],
            ).toBeUndefined();
            // New script key should exist with updated mod id
            expect(
                pkg.scripts[`experimental:setup:nonsteam:${newModId}`],
            ).toBeDefined();
            expect(
                pkg.scripts[`experimental:setup:nonsteam:${newModId}`],
            ).toContain(newModId);
            expect(
                pkg.scripts[`experimental:setup:nonsteam:${newModId}`],
            ).not.toContain(oldModId);
        } catch (e) {
            console.log('STDOUT:', result.stdout.join('\n'));
            console.log('STDERR:', result.stderr.join('\n'));
            throw e;
        }
    });

    it('should fail when newModId argument is missing', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    existing_mod: { name: 'E', description: 'D' },
                },
                excludes: [],
            }),
        );
        workspace.write('existing_mod/mod.info', 'id=existing_mod');

        // rename called with only one positional arg → usage error (exit 2)
        const result = await workspace.run('rename', ['existing_mod']);
        workspace.assertFailure(result, 2);
        workspace.assertStderr(
            result,
            "Missing required argument '<newModId>' for command [rename]",
        );
    });

    it('should keep an excluded mod excluded under its new id and leave name untouched', async () => {
        const oldModId = 'excluded_mod';
        const newModId = 'renamed_mod';
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    [oldModId]: { name: 'Display Name', description: 'D' },
                },
                excludes: [oldModId],
            }),
        );
        workspace.write(
            `${oldModId}/mod.info`,
            `id=${oldModId}\nname=Display Name`,
        );

        const result = await workspace.run('rename', [
            oldModId,
            newModId,
            '--yes',
        ]);
        workspace.assertSuccess(result);

        const config = workspace.readJson('project.json');
        expect(config.excludes).toEqual([newModId]);
        expect(config.excludes).not.toContain(oldModId);
        // The display name is a separate field and must not be renamed
        expect(config.mods[newModId].name).toBe('Display Name');

        const modInfo = workspace.read(`${newModId}/mod.info`);
        expect(modInfo).toContain(`id=${newModId}`);
        expect(modInfo).toContain('name=Display Name');
    });

    it('should refuse embedded rename without --yes and change nothing', async () => {
        // CLI-9: embedded never prompts, but an embedded call without --yes
        // is a refusal (usage error, exit 2), never a proceed.
        const oldModId = 'guarded_mod';
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    [oldModId]: { name: 'G', description: 'D' },
                },
                excludes: [],
            }),
        );
        workspace.write(`${oldModId}/mod.info`, `id=${oldModId}`);

        const result = await workspace.run('rename', [oldModId, 'new_mod']);

        workspace.assertFailure(result, 2);
        workspace.assertStderr(
            result,
            `Refusing 'rename' without explicit confirmation (embedded API)`,
        );

        // Nothing was mutated
        expect(workspace.exists(oldModId)).toBe(true);
        expect(workspace.exists('new_mod')).toBe(false);
        const config = workspace.readJson('project.json');
        expect(config.mods[oldModId]).toBeDefined();
        expect(config.mods['new_mod']).toBeUndefined();
    });
});
