import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

describe('CLI Command Flow (E2E)', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should exit with code 1 when a command fails', async () => {
        const result = await workspace.run('build');
        workspace.assertFailure(result, 1);
        workspace.assertStderr(result, 'No pzstudio project found.');
    });

    it('should exit with error on project validation failure', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 123 },
                mods: {},
                excludes: [],
            }),
        );

        const result = await workspace.run('build');
        workspace.assertFailure(result, 1);
        workspace.assertStderr(result, 'Validation failed for project.json');
        workspace.assertStderr(result, 'Field "title" must be a string');
    });

    it('should warn on legacy project shape', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                id: 'leg',
                title: 'Leg',
                workshop: { visibility: 'public', tags: [] },
                mods: {
                    m: {
                        name: 'N',
                        description: 'D',
                        build: { modInfo: 'skip' },
                    },
                },
            }),
        );

        const result = await workspace.run('build');
        workspace.write(
            'project.json',
            JSON.stringify({
                id: 'leg',
                title: 'Leg',
                workshop: { visibility: 'public', tags: [] },
                mods: {
                    m: {
                        name: 'N',
                        description: 'D',
                        build: { modInfo: 'skip' },
                    },
                },
                outdir: 'out',
            }),
        );

        const result2 = await workspace.run('build');
        workspace.assertStderr(
            result2,
            '[MIGRATION] project.json needs migration',
        );
    });
});
