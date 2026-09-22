import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

describe('list command (E2E)', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should fail when run outside a project directory', async () => {
        const result = await workspace.run('list');
        workspace.assertFailure(result);
        workspace.assertStderr(
            result,
            'You must execute this command within a project directory!',
        );
    });

    it('should report an empty project', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
            }),
        );

        const result = await workspace.run('list');
        workspace.assertSuccess(result);
        workspace.assertStdout(result, 'No mods in project');
    });

    it('should list mods with on-disk and excluded status', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    included_mod: { name: 'A', description: '' },
                    excluded_mod: { name: 'B', description: '' },
                    ghost_mod: { name: 'C', description: '' },
                },
                excludes: ['excluded_mod'],
            }),
        );
        workspace.write('included_mod/.gitkeep', '');
        workspace.write('excluded_mod/.gitkeep', '');
        // ghost_mod is intentionally absent from disk

        const result = await workspace.run('list');
        workspace.assertSuccess(result);
        workspace.assertStdout(result, 'included_mod');
        workspace.assertStdout(result, 'on disk, included');
        workspace.assertStdout(result, 'excluded_mod');
        workspace.assertStdout(result, 'excluded from workshop build');
        workspace.assertStdout(result, 'ghost_mod');
        workspace.assertStdout(result, 'missing on disk');
    });
});
