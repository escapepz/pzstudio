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
        expect(result.stderr).toContain('No pzstudio project found.');
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
                ({ stderr }) => stderr.includes('Syncing '),
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

/**
 * Ctrl+C handling (CLI-6): watch owns its interruption — one handler, one
 * message ('Development sync stopped.'), exit 130. POSIX only: Windows
 * cannot deliver SIGINT to a spawned child reliably (the main suite kills
 * with SIGKILL there).
 */
describe.skipIf(process.platform === 'win32')(
    'real env: watch SIGINT (CLI-6)',
    () => {
        const PROJECT_TITLE = 'Real Env Watch';
        const MOD_ID = 'watch_mod';

        let workspace: RealEnvWorkspace;

        beforeEach(() => {
            workspace = new RealEnvWorkspace();
        });

        afterEach(async () => {
            await workspace.cleanup();
        });

        it('stops gracefully with one message and exit code 130', async () => {
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
                            description: 'Watched.',
                        },
                    },
                    excludes: [],
                    schemaVersion: 2,
                }),
            );
            workspace.write(
                path.join(MOD_ID, '42', 'media', 'lua', 'shared', 'main.lua'),
                '-- real env watch sigint\n',
            );
            workspace.write(
                path.join('workshop', 'description.txt'),
                'Real env watch sigint description',
            );
            seedWorkshopTemplateCache(workspace.home);

            const spawned = spawnPz(['watch'], {
                cwd: workspace.dir,
                home: workspace.home,
            });
            // Interrupt only after the session is ready: the SIGINT handler
            // is installed after the initial build AND the watcher
            // subscription attach, so a signal sent while filesystem
            // artifacts still appear would kill the child with Node's
            // default SIGINT death (exit code null) instead of the
            // graceful 130 path. The ready line prints after the full
            // build; a short beat covers the subscribe() hop.
            await spawned.waitFor(
                ({ stderr }) => stderr.includes('Watching for changes'),
                30000,
                'the watcher-ready line before sending SIGINT',
            );
            await new Promise((resolve) => setTimeout(resolve, 750));

            spawned.child.kill('SIGINT');
            const exit = await spawned.exit;
            expect(exit.code).toBe(130);
            expect(spawned.getStderr()).toContain('Development sync stopped.');
            expect(spawned.getStderr()).not.toContain(
                'Process interrupted by user (SIGINT).',
            );
        }, 60000);
    },
);
