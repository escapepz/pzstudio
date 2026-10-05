import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    defaultOutRoot,
    hasLegacyTemplates,
    RealEnvWorkspace,
    seedWorkshopTemplateCache,
    spawnPz,
    waitForCondition,
} from '../helpers/real-env';

/**
 * Real-environment pin of the CLI-2 stream contract on the built binary:
 * human progress never reaches stdout. stdout carries command data and
 * results only; stderr carries progress, lifecycle messages, warnings and
 * errors. Assertions pin the CHANNEL and semantic text â€” the [INFO] prefix,
 * timestamps and colors are presentation (TTY-gated) and deliberately not
 * asserted. `--json` stays a strict JSON.parse(stdout) with no filtering.
 */

const PROJECT_TITLE = 'Stream Project';
const MOD_ID = 'stream_mod';

let workspace: RealEnvWorkspace;

beforeEach(() => {
    workspace = new RealEnvWorkspace();
});

afterEach(async () => {
    await workspace.cleanup();
});

/** Colors are TTY-gated; spawned pipes must never produce escape codes. */
function hasAnsi(text: string): boolean {
    return text.includes(String.fromCharCode(27, 155));
}

function writeBuildFixture(ws: RealEnvWorkspace): void {
    ws.write(
        'project.json',
        JSON.stringify({
            workshop: {
                title: PROJECT_TITLE,
                visibility: 'public',
                tags: ['Build 42'],
            },
            mods: {
                [MOD_ID]: { name: 'Stream Mod', description: 'Streamed.' },
            },
            excludes: [],
        }),
    );
    ws.write(
        path.join(MOD_ID, '42', 'media', 'lua', 'shared', 'main.lua'),
        '-- stream fixture\n',
    );
    ws.write(path.join('workshop', 'description.txt'), 'Stream description');
    ws.write(path.join('workshop', 'preview.png'), 'fake preview');
}

function writeHealthyProject(): void {
    workspace.write(
        'project.json',
        JSON.stringify({
            workshop: {
                id: 12345,
                title: PROJECT_TITLE,
                visibility: 'public',
                tags: ['Build 42'],
            },
            mods: {
                [MOD_ID]: { name: 'Stream Mod', description: 'A mod.' },
            },
            excludes: [],
            schemaVersion: 2,
        }),
    );
    workspace.write(path.join(MOD_ID, '42', 'mod.info'), `id=${MOD_ID}`);
    workspace.write(
        path.join(MOD_ID, '42', 'media', 'lua', 'shared.lua'),
        '-- lua',
    );
    workspace.write('workshop/description.txt', 'Stream description');
    workspace.write('workshop/preview.png', 'fake preview');
    // The default output dir must exist so the filesystem module stays quiet.
    fs.mkdirSync(defaultOutRoot(workspace.home), { recursive: true });
}

describe('real env: stream contract (CLI-2)', () => {
    it.skipIf(!hasLegacyTemplates())(
        'new: stdout carries only the Next: block, progress stays on stderr',
        async () => {
            const result = await workspace.run([
                'new',
                '--offline',
                PROJECT_TITLE,
                MOD_ID,
            ]);
            expect(result.exitCode).toBe(0);

            // Data/result on stdout: the golden-path Next: block.
            expect(result.stdout).toContain('Next:');
            // No human progress leaked into stdout.
            expect(result.stdout).not.toContain('Creating project');
            expect(result.stdout).not.toContain('Creating mod');
            expect(result.stdout).not.toContain('Creating workshop');
            expect(result.stdout).not.toContain('Scaffolding');
            expect(result.stdout).not.toContain('Updating project config');
            expect(result.stdout).not.toContain('has been created');
            expect(hasAnsi(result.stdout)).toBe(false);

            // The same progress lines are on stderr.
            expect(result.stderr).toContain(
                `The project '${PROJECT_TITLE}' has been created`,
            );
            expect(result.stderr).toContain('Creating project');
            expect(hasAnsi(result.stderr)).toBe(false);
        },
        60000,
    );

    it.skipIf(!hasLegacyTemplates())(
        'build: stdout is whitespace-only, progress on stderr',
        async () => {
            writeBuildFixture(workspace);
            seedWorkshopTemplateCache(workspace.home);

            const result = await workspace.run(['build']);
            expect(result.exitCode).toBe(0);
            expect(result.stdout.trim()).toBe('');
            expect(result.stderr).toContain('Building main workshop');
            expect(result.stderr).toContain('Build complete');
            expect(hasAnsi(result.stdout)).toBe(false);
            expect(hasAnsi(result.stderr)).toBe(false);

            // The build actually produced the output.
            expect(
                fs.existsSync(
                    path.join(defaultOutRoot(workspace.home), PROJECT_TITLE),
                ),
            ).toBe(true);
        },
        60000,
    );

    it.skipIf(!hasLegacyTemplates())(
        'build --quiet: progress is intentionally suppressible',
        async () => {
            writeBuildFixture(workspace);
            seedWorkshopTemplateCache(workspace.home);

            const result = await workspace.run(['build', '--quiet']);
            expect(result.exitCode).toBe(0);
            // stdout stays empty/data-only â€” and normal progress is gone
            // from stderr too: --quiet suppresses info/verbose diagnostics.
            expect(result.stdout.trim()).toBe('');
            expect(result.stderr).not.toContain('Building main workshop');
            expect(result.stderr).not.toContain('Build complete');
        },
        60000,
    );

    it('list/doctor: data on stdout, lifecycle on stderr, no ANSI', async () => {
        writeHealthyProject();

        const list = await workspace.run(['list']);
        expect(list.exitCode).toBe(0);
        expect(list.stdout).toContain('Mods in project');
        expect(list.stderr).toContain('Command [list] completed.');
        expect(hasAnsi(list.stdout)).toBe(false);
        expect(hasAnsi(list.stderr)).toBe(false);

        const doctor = await workspace.run(['doctor']);
        expect(doctor.exitCode).toBe(0);
        expect(doctor.stdout).toContain('PZ Studio doctor');
        expect(hasAnsi(doctor.stdout)).toBe(false);
        expect(hasAnsi(doctor.stderr)).toBe(false);
    }, 60000);

    it('--json stays a strict JSON.parse(stdout), no filtering', async () => {
        writeHealthyProject();

        const result = await workspace.run(['list', '--json']);
        expect(result.exitCode).toBe(0);
        // JSON.parse over the raw stdout: any progress line on stdout would
        // throw here â€” the channel invariant enforced mechanically.
        const envelope = JSON.parse(result.stdout);
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.command).toBe('list');
    }, 60000);
});

/**
 * Watch (CLI-2 + CLI-6): stdout stays whitespace-only through the initial
 * build, an incremental edit sync and the stop. The full SIGINT flow (edit â†’
 * sync â†’ 130 + one stop line) is POSIX-only â€” Windows cannot deliver SIGINT
 * to a spawned child reliably.
 */
describe('real env: watch keeps stdout clean (CLI-2)', () => {
    it('initial full build writes no human progress to stdout', async () => {
        writeBuildFixture(workspace);
        seedWorkshopTemplateCache(workspace.home);

        const spawned = spawnPz(['watch'], {
            cwd: workspace.dir,
            home: workspace.home,
        });
        try {
            await spawned.waitFor(
                ({ stderr }) => stderr.includes('Syncing '),
                20000,
                'the development sync banner on stderr',
            );
            await waitForCondition(
                () =>
                    fs.existsSync(
                        path.join(
                            defaultOutRoot(workspace.home),
                            PROJECT_TITLE,
                            'Contents',
                            'mods',
                        ),
                    ),
                30000,
                'the initial full build to settle',
            );
            expect(spawned.getStdout().trim()).toBe('');
            expect(hasAnsi(spawned.getStderr())).toBe(false);
        } finally {
            const exit = await spawned.stop();
            // Killed on purpose; the point is that it was alive and working.
            expect(exit.code === null || exit.code === 130).toBe(true);
        }
    }, 90000);

    describe.skipIf(process.platform === 'win32')(
        'watch SIGINT stream flow (POSIX)',
        () => {
            it('syncs an edit on stderr, stdout stays empty, stops with 130 and one stop line', async () => {
                writeBuildFixture(workspace);
                seedWorkshopTemplateCache(workspace.home);

                const spawned = spawnPz(['watch'], {
                    cwd: workspace.dir,
                    home: workspace.home,
                });
                try {
                    await spawned.waitFor(
                        ({ stderr }) => stderr.includes('Syncing '),
                        20000,
                        'the development sync banner on stderr',
                    );
                    await waitForCondition(
                        () =>
                            fs.existsSync(
                                path.join(
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
                                ),
                            ),
                        30000,
                        'the initial full build to settle',
                    );
                    expect(spawned.getStdout().trim()).toBe('');

                    // Edit a watched .lua source file â†’ incremental sync.
                    const sourceLua = path.join(
                        workspace.dir,
                        MOD_ID,
                        '42',
                        'media',
                        'lua',
                        'shared',
                        'main.lua',
                    );
                    fs.writeFileSync(
                        sourceLua,
                        '-- stream fixture edited\n',
                        'utf8',
                    );
                    await spawned.waitFor(
                        ({ stderr }) => stderr.includes('file(s) synced'),
                        20000,
                        'the incremental sync summary on stderr',
                    );
                    // The edited content reached the output for real.
                    expect(
                        fs.readFileSync(
                            path.join(
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
                            ),
                            'utf8',
                        ),
                    ).toContain('stream fixture edited');
                    // stdout is still untouched by any of it.
                    expect(spawned.getStdout().trim()).toBe('');

                    spawned.child.kill('SIGINT');
                    const exit = await spawned.exit;
                    expect(exit.code).toBe(130);
                    const stopLines =
                        spawned.getStderr().split('Development sync stopped.')
                            .length - 1;
                    expect(stopLines).toBe(1);
                } finally {
                    await spawned.stop();
                }
            }, 90000);
        },
    );
});
