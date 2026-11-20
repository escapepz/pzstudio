import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

describe('modconfig command (E2E)', () => {
    let workspace: E2ETestWorkspace;

    const baseProject = {
        workshop: { title: 'P', visibility: 'public', tags: [] },
        mods: {
            mod_a: { name: 'A', description: 'First mod.' },
            mod_b: { name: 'B', description: 'Second mod.' },
        },
        excludes: [],
    };

    beforeEach(() => {
        workspace = createE2EWorkspace();
        workspace.write('project.json', JSON.stringify(baseProject));
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should fail for an unknown mod id', async () => {
        const result = await workspace.run('modconfig', ['nope']);
        workspace.assertFailure(result);
        workspace.assertStderr(result, "Mod 'nope' is not in project.json");
    });

    it('should show the current configuration and build state', async () => {
        const result = await workspace.run('modconfig', ['mod_a']);
        workspace.assertSuccess(result);
        workspace.assertStdout(result, "Mod 'mod_a' (included)");
        workspace.assertStdout(result, 'name = A');
        workspace.assertStdout(result, 'description = First mod.');
    });

    it('should show dev-only and excluded states', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                ...baseProject,
                mods: {
                    ...baseProject.mods,
                    mod_a: {
                        name: 'A',
                        description: 'First mod.',
                        build: { devOnly: true },
                    },
                },
                excludes: ['mod_b'],
            }),
        );

        const resultA = await workspace.run('modconfig', ['mod_a']);
        workspace.assertSuccess(resultA);
        workspace.assertStdout(resultA, "Mod 'mod_a' (dev only)");
        workspace.assertStdout(resultA, 'build.devOnly = true');

        const resultB = await workspace.run('modconfig', ['mod_b']);
        workspace.assertSuccess(resultB);
        workspace.assertStdout(resultB, "Mod 'mod_b' (excluded)");
    });

    it('should set build.devOnly with the devonly action and clear it with include', async () => {
        const mark = await workspace.run('modconfig', ['mod_a', 'devonly']);
        workspace.assertSuccess(mark);
        expect(
            workspace.readJson('project.json').mods.mod_a.build.devOnly,
        ).toBe(true);
        expect(workspace.readJson('project.json').excludes).toEqual([]);

        const include = await workspace.run('modconfig', ['mod_a', 'include']);
        workspace.assertSuccess(include);
        expect(
            workspace.readJson('project.json').mods.mod_a.build.devOnly,
        ).toBeUndefined();
    });

    it('should exclude a mod and keep the state invariant with devonly', async () => {
        const exclude = await workspace.run('modconfig', ['mod_a', 'exclude']);
        workspace.assertSuccess(exclude);
        expect(workspace.readJson('project.json').excludes).toEqual(['mod_a']);

        // Excluding again is a silent no-op
        const again = await workspace.run('modconfig', ['mod_a', 'exclude']);
        workspace.assertSuccess(again);
        expect(workspace.readJson('project.json').excludes).toEqual(['mod_a']);

        // devonly removes the exclusion
        const devonly = await workspace.run('modconfig', ['mod_a', 'devonly']);
        workspace.assertSuccess(devonly);
        const config = workspace.readJson('project.json');
        expect(config.excludes).toEqual([]);
        expect(config.mods.mod_a.build.devOnly).toBe(true);
    });

    it('should set a string field with set', async () => {
        const result = await workspace.run('modconfig', [
            'mod_a',
            'set',
            'author',
            'Some Author',
        ]);
        workspace.assertSuccess(result);
        expect(workspace.readJson('project.json').mods.mod_a.author).toBe(
            'Some Author',
        );
    });

    it('should split comma-separated values for array fields', async () => {
        const result = await workspace.run('modconfig', [
            'mod_a',
            'set',
            'require',
            'mod_b, other_mod ,',
        ]);
        workspace.assertSuccess(result);
        expect(workspace.readJson('project.json').mods.mod_a.require).toEqual([
            'mod_b',
            'other_mod',
        ]);
    });

    it('should validate the modInfo value', async () => {
        const bad = await workspace.run('modconfig', [
            'mod_a',
            'set',
            'modInfo',
            'sometimes',
        ]);
        // d11-F8: invalid enum values exit 2 on the handler path too.
        workspace.assertFailure(bad, 2);
        workspace.assertStderr(
            bad,
            "Invalid modInfo value 'sometimes' (expected one of: auto, skip, auto-if-missing)",
        );

        const good = await workspace.run('modconfig', [
            'mod_a',
            'set',
            'modInfo',
            'auto',
        ]);
        workspace.assertSuccess(good);
        expect(
            workspace.readJson('project.json').mods.mod_a.build.modInfo,
        ).toBe('auto');
    });

    it('should reject unknown keys and refuse to unset required fields', async () => {
        const unknown = await workspace.run('modconfig', [
            'mod_a',
            'set',
            'naem',
            'Typo',
        ]);
        // d11-F8: invalid enum values exit 2 on the handler path too.
        workspace.assertFailure(unknown, 2);
        workspace.assertStderr(
            unknown,
            "Unknown mod config key 'naem' (expected one of:",
        );

        const required = await workspace.run('modconfig', [
            'mod_a',
            'unset',
            'description',
        ]);
        workspace.assertFailure(required);
        workspace.assertStderr(
            required,
            "Key 'description' is required by project.json",
        );
    });

    it('should reject an unknown action, naming show with the rest (bf4-n08)', async () => {
        const unknown = await workspace.run('modconfig', ['mod_a', 'bogus']);
        // d11-F8: invalid enum values exit 2 on the handler path too.
        workspace.assertFailure(unknown, 2);
        workspace.assertStderr(
            unknown,
            "Unknown modconfig action 'bogus' (expected one of: show, include, devonly, exclude, set, unset).",
        );
    });

    it('should unset an optional field', async () => {
        const project = workspace.readJson('project.json');
        project.mods.mod_a.author = 'To Remove';
        workspace.write('project.json', JSON.stringify(project));

        const result = await workspace.run('modconfig', [
            'mod_a',
            'unset',
            'author',
        ]);
        workspace.assertSuccess(result);
        expect(
            workspace.readJson('project.json').mods.mod_a.author,
        ).toBeUndefined();
    });
});
