import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    defaultOutRoot,
    RealEnvWorkspace,
    seedWorkshopTemplateCache,
    spawnPz,
    waitForCondition,
} from '../helpers/real-env';

/**
 * Real-environment smoke tests for `pzstudio watch`. Outside a project the
 * command must fail cleanly; inside a project the spawned binary must run
 * the Development Sync Engine's initial full build for real — including the
 * lazily-required native @parcel/watcher binding — before being killed.
 */
describe('real env: watch command', () => {
    const PROJECT_TITLE = 'Real Env Watch';
    const MOD_ID = 'watch_mod';

    let workspace: RealEnvWorkspace;

    beforeEach(() => {
        workspace = new RealEnvWorkspace();
    });

    afterEach(async () => {
        await workspace.cleanup();
    });

    it('fails cleanly outside a project directory', async () => {
        const result = await workspace.run(['watch']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('within a project directory');
    });

    it('runs the initial full build for both outputs from the real binary', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    title: PROJECT_TITLE,
                    visibility: 'public',
                    tags: ['Build 42'],
                },
                mods: {
                    [MOD_ID]: {
                        name: 'Watch Mod',
                        description: 'Watched by the real binary.',
                    },
                },
                excludes: [],
                schemaVersion: 2,
            }),
        );
        workspace.write(
            path.join(MOD_ID, '42', 'media', 'lua', 'shared', 'main.lua'),
            '-- real env watch\n',
        );
        workspace.write(
            path.join('workshop', 'description.txt'),
            'Real env watch description',
        );
        // Hermetic template cache: without it the workshop template
        // resolution inside the watch session's initial build would
        // attempt a real git clone in a fresh home.
        seedWorkshopTemplateCache(workspace.home);

        const spawned = spawnPz(['watch'], {
            cwd: workspace.dir,
            home: workspace.home,
        });
        try {
            await spawned.waitFor(
                ({ stderr }) => stderr.includes('Starting development sync'),
                20000,
                'the development sync banner',
            );

            const mainOutDir = path.join(
                defaultOutRoot(workspace.home),
                PROJECT_TITLE,
                'Contents',
                'mods',
                MOD_ID,
                '42',
                'media',
                'lua',
                'shared',
                'main.lua',
            );
            const devOutDir = path.join(
                defaultOutRoot(workspace.home),
                `${PROJECT_TITLE} - dev_branch`,
                'Contents',
                'mods',
                `${MOD_ID}_dev`,
                '42',
                'mod.info',
            );
            await waitForCondition(
                () => fs.existsSync(mainOutDir) && fs.existsSync(devOutDir),
                30000,
                'both workshop outputs from the initial full build',
            );
            expect(fs.readFileSync(mainOutDir, 'utf8')).toContain(
                'real env watch',
            );
            expect(fs.readFileSync(devOutDir, 'utf8')).toContain(
                `id=${MOD_ID}_dev`,
            );
        } finally {
            const exit = await spawned.stop();
            // Killed on purpose; the point is that it was alive and working.
            expect(exit.code === null || exit.code === 130).toBe(true);
        }
    }, 90000);
});
