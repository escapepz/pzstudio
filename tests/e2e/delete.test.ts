import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

describe('delete command e2e', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should delete an existing mod', async () => {
        const modId = 'target_mod';
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    [modId]: {
                        name: 'Target Mod',
                        description: 'D',
                    },
                    other_mod: {
                        name: 'Other Mod',
                        description: 'O',
                    },
                },
                excludes: [modId],
            }),
        );
        workspace.write(`${modId}/mod.info`, `id=${modId}`);
        workspace.write(`other_mod/mod.info`, `id=other_mod`);

        const result = await workspace.run('delete', [modId, '--yes']);

        try {
            workspace.assertSuccess(result);
            workspace.assertStderr(result, `Deleting mod '${modId}' directory`);
            workspace.assertStderr(
                result,
                `Deleting mod '${modId}' from project.json`,
            );

            expect(workspace.exists(modId)).toBe(false);
            expect(workspace.exists('other_mod')).toBe(true);

            const config = workspace.readJson('project.json');
            expect(config.mods[modId]).toBeUndefined();
            expect(config.mods['other_mod']).toBeDefined();
            expect(config.excludes).not.toContain(modId);
        } catch (e) {
            console.log('STDOUT:', result.stdout.join('\n'));
            console.log('STDERR:', result.stderr.join('\n'));
            throw e;
        }
    });

    it('should fail if not in a project directory', async () => {
        const result = await workspace.run('delete', ['any']);
        workspace.assertFailure(result);
        workspace.assertStderr(result, 'No pzstudio project found.');
    });

    it('should not write a runtime-resolved outdir when deleting a mod', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    target_mod: { name: 'T', description: 'D' },
                },
                excludes: [],
            }),
        );
        workspace.writeGlobalConfig({ outdir: 'C:/fake/workshop' });

        const result = await workspace.run('delete', ['target_mod', '--yes']);

        workspace.assertSuccess(result);
        const config = workspace.readJson('project.json');
        expect(config.outdir).toBeUndefined();
    });

    it('should preserve an explicit outdir and custom fields when deleting a mod', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                customRoot: 'keep-me',
                workshop: { title: 'P', visibility: 'public', tags: [] },
                outdir: './bin',
                mods: {
                    target_mod: { name: 'T', description: 'D' },
                },
                excludes: [],
            }),
        );

        const result = await workspace.run('delete', ['target_mod', '--yes']);

        workspace.assertSuccess(result);
        const config = workspace.readJson('project.json');
        expect(config.outdir).toBe('./bin');
        expect(config.customRoot).toBe('keep-me');
        expect(config.mods.target_mod).toBeUndefined();
    });

    it('should log error if mod directory is missing but still try to delete from config', async () => {
        const modId = 'missing_dir';
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    [modId]: { name: 'M', description: 'D' },
                },
                excludes: [],
            }),
        );

        const result = await workspace.run('delete', [modId, '--yes']);

        workspace.assertSuccess(result);
        workspace.assertStderr(result, `Mod '${modId}' directory not found`);

        const config = workspace.readJson('project.json');
        expect(config.mods[modId]).toBeUndefined();
    });

    it('should fail fast if mod is missing from config and keep the directory', async () => {
        const modId = 'missing_config';
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
            }),
        );
        workspace.write(`${modId}/mod.info`, `id=${modId}`);

        const result = await workspace.run('delete', [modId]);

        workspace.assertFailure(result);
        workspace.assertStderr(
            result,
            `Mod '${modId}' not found in project.json`,
        );

        expect(workspace.exists(modId)).toBe(true);
    });

    it('should fail with an error when no modId argument is provided', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
            }),
        );

        const result = await workspace.run('delete', []);
        workspace.assertFailure(result, 2);
        workspace.assertStderr(
            result,
            "Missing required argument '<modId>' for command [delete]",
        );
    });

    it('should emit verbose diagnostics on delete success path', async () => {
        const modId = 'verbose_mod';
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    [modId]: { name: 'Verbose Mod', description: 'D' },
                },
                excludes: [],
            }),
        );
        workspace.write(`${modId}/mod.info`, `id=${modId}`);

        const result = await workspace.run('delete', [
            modId,
            '--verbose',
            '--yes',
        ]);
        workspace.assertSuccess(result);

        const hasVerbose = result.stderr.some(
            (line) =>
                line.includes('Executing command [delete]') ||
                line.includes('Project Dir:'),
        );
        expect(hasVerbose).toBe(true);

        expect(workspace.exists(modId)).toBe(false);
        const config = workspace.readJson('project.json');
        expect(config.mods[modId]).toBeUndefined();
    });

    it('should refuse embedded deletion without --yes and keep the mod', async () => {
        const modId = 'protected_mod';
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    [modId]: { name: 'P', description: 'D' },
                },
                excludes: [],
            }),
        );
        workspace.write(`${modId}/mod.info`, `id=${modId}`);

        const result = await workspace.run('delete', [modId]);

        workspace.assertFailure(result, 2);
        workspace.assertStderr(
            result,
            `Refusing 'delete' without explicit confirmation (embedded API)`,
        );

        expect(workspace.exists(modId)).toBe(true);
        const config = workspace.readJson('project.json');
        expect(config.mods[modId]).toBeDefined();
    });
});
