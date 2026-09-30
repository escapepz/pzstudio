import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCLI, setProjectDir } from 'pzstudio-cli/api';
import {
    defaultOutRoot,
    RealEnvWorkspace,
    seedWorkshopTemplateCache,
    spawnPz,
    waitForCondition,
} from '../helpers/real-env';

/**
 * CLI-GATE — the MVP contract suite. Every case is a black-box pin of the
 * user- and machine-facing contract (exit matrix, streams, discovery,
 * safety) run against the real built binary. This file is verification
 * ONLY: a regression here belongs to the CLI-N commit that introduced it
 * (amend, or a separate fix(cli) commit) — never to this suite.
 */
describe('CLI-GATE: real binary contract suite', () => {
    let workspace: RealEnvWorkspace;

    const PROJECT_TITLE = 'Gate Project';
    const MOD_ID = 'gate_mod';

    function writeProjectFixture(): void {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    title: PROJECT_TITLE,
                    visibility: 'public',
                    tags: ['Build 42'],
                },
                mods: {
                    [MOD_ID]: { name: 'Gate Mod', description: 'Gated.' },
                },
                excludes: [],
                schemaVersion: 2,
            }),
        );
        workspace.write(
            path.join(MOD_ID, '42', 'media', 'lua', 'shared', 'main.lua'),
            '-- gate fixture\n',
        );
        workspace.write(
            path.join('workshop', 'description.txt'),
            'Gate fixture description',
        );
    }

    beforeEach(() => {
        workspace = new RealEnvWorkspace();
    });

    afterEach(async () => {
        await workspace.cleanup();
    });

    describe('pure invocations mutate nothing', () => {
        it('--version prints the version and creates no config', async () => {
            const result = await workspace.run(['--version']);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toMatch(/v\d+\.\d+\.\d+/);
            expect(workspace.exists('.pzstudio', 'home')).toBe(false);
        });

        it('--help lists commands and creates no config', async () => {
            const result = await workspace.run(['--help']);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('Available commands:');
            expect(result.stdout).toContain('new');
            expect(workspace.exists('.pzstudio', 'home')).toBe(false);
        });

        it('no command prints the banner and creates no config', async () => {
            const result = await workspace.run([]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('Project Zomboid Studio v');
            expect(workspace.exists('.pzstudio', 'home')).toBe(false);
        });
    });

    describe('argument structure', () => {
        beforeEach(() => {
            writeProjectFixture();
        });

        it('accepts a global flag before the command', async () => {
            const result = await workspace.run(['--verbose', 'list']);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(MOD_ID);
        });

        it('accepts a global flag after the command', async () => {
            const result = await workspace.run(['list', '--verbose']);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(MOD_ID);
        });

        it('does not swallow a valued option as a positional', async () => {
            // 'fetch' is the value of --transport, never a command candidate.
            const result = await workspace.run([
                '--transport',
                'fetch',
                'list',
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(MOD_ID);
        });

        it('rejects an unknown command with exit 2', async () => {
            const result = await workspace.run(['notacommand']);
            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('notacommand');
        });

        it('rejects an unknown flag with exit 2', async () => {
            const result = await workspace.run(['list', '--nope']);
            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('--nope');
        });
    });

    describe('exit matrix and streams', () => {
        it('reports runtime failures with exit 1 and structured Problem text', async () => {
            writeProjectFixture();
            const result = await workspace.run(['delete', 'missing_mod']);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain(
                "Problem: Mod 'missing_mod' not found in project.json!",
            );
        });

        it('keeps stdout clean of ANSI codes and progress when piped', async () => {
            writeProjectFixture();
            const result = await workspace.run(['list']);
            expect(result.exitCode).toBe(0);
            // Data on stdout, no ANSI styling on a non-TTY stream.
            expect(result.stdout).toContain(MOD_ID);
            expect(result.stdout).not.toContain('\x1b[');
            // Progress on stderr.
            expect(result.stderr).toContain('Command [list] completed.');
            expect(result.stderr).not.toContain('\x1b[');
        });

        it('emits machine-readable JSON for --json', async () => {
            writeProjectFixture();
            const result = await workspace.run(['list', '--json']);
            expect(result.exitCode).toBe(0);
            const envelope = JSON.parse(result.stdout);
            expect(envelope.schemaVersion).toBe(1);
            expect(envelope.command).toBe('list');
            expect(envelope.result.title).toBe(PROJECT_TITLE);
            expect(envelope.result.mods[0].id).toBe(MOD_ID);
            expect(typeof envelope.result.mods[0].onDisk).toBe('boolean');
        });

        it(
            'stops watch with exit code 130 on SIGINT',
            { skip: process.platform === 'win32' },
            async () => {
                writeProjectFixture();
                seedWorkshopTemplateCache(workspace.home);

                const spawned = spawnPz(['watch'], {
                    cwd: workspace.dir,
                    home: workspace.home,
                });
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
                    'the production workshop output before sending SIGINT',
                );

                spawned.child.kill('SIGINT');
                const exit = await spawned.exit;
                expect(exit.code).toBe(130);
                expect(spawned.getStderr()).toContain(
                    'Development sync stopped.',
                );
            },
            60000,
        );
    });

    describe('project discovery (-C/--project)', () => {
        it('anchors a valid project directory from outside it', async () => {
            workspace.write(
                path.join('proj', 'project.json'),
                JSON.stringify({
                    workshop: {
                        title: PROJECT_TITLE,
                        visibility: 'public',
                        tags: [],
                    },
                    mods: {
                        [MOD_ID]: { name: 'Gate Mod', description: '' },
                    },
                    excludes: [],
                }),
            );
            workspace.write(path.join('proj', MOD_ID, '.gitkeep'), '');

            const result = await workspace.run([
                '-C',
                workspace.path('proj'),
                'list',
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(MOD_ID);
        });

        it('fails closed when the anchor holds no project', async () => {
            workspace.write('empty-dir/.keep', '');

            const result = await workspace.run([
                '-C',
                workspace.path('empty-dir'),
                'list',
            ]);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('No pzstudio project found');
        });
    });

    describe('destructive and transactional safety', () => {
        it('refuses delete without --yes in a non-interactive session', async () => {
            writeProjectFixture();
            const result = await workspace.run(['delete', MOD_ID]);
            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('Try: pzstudio delete');
            expect(workspace.exists(MOD_ID)).toBe(true);
        });

        it('previews delete with --dry-run without changing anything', async () => {
            writeProjectFixture();
            const result = await workspace.run(['delete', MOD_ID, '--dry-run']);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('No files were changed.');
            expect(workspace.exists(MOD_ID)).toBe(true);
            expect(
                workspace.readJson('project.json').mods[MOD_ID],
            ).toBeDefined();
        });

        it('leaves no destination or staging debris when new fails', async () => {
            workspace.write(path.join(MOD_ID, 'occupied.txt'), 'taken');

            const result = await workspace.run([
                'new',
                '--offline',
                PROJECT_TITLE,
                MOD_ID,
            ]);
            expect(result.exitCode).toBe(1);
            expect(workspace.read(path.join(MOD_ID, 'occupied.txt'))).toBe(
                'taken',
            );
            // No staging directory may survive a failed transaction.
            const leftovers = fs
                .readdirSync(workspace.dir)
                .filter((name) => name.includes('.staging-'));
            expect(leftovers).toEqual([]);
        });
    });

    describe('aggregate failure semantics', () => {
        it('fails update with a nonzero exit when every cache refresh fails', async () => {
            // A non-official community URL gets no legacy fallback, and the
            // reserved .invalid TLD fails DNS resolution everywhere — so all
            // four categories fail deterministically, network or not.
            workspace.writeHome(
                path.join('.pzstudio', 'config.json'),
                JSON.stringify({
                    templates: {
                        project: { url: 'https://invalid.invalid/nope.git' },
                        mod: { url: 'https://invalid.invalid/nope.git' },
                        workshop: { url: 'https://invalid.invalid/nope.git' },
                        language: { url: 'https://invalid.invalid/nope.git' },
                    },
                }),
            );

            const result = await workspace.run(['update'], {
                timeout: 120000,
            });
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain('Refreshed 0/4 template caches');
            expect(result.stderr).toContain("run 'pzstudio update' again");
        });
    });
});

describe('CLI-GATE: embedded runCLI never exits the host process', () => {
    it('surfaces runtime errors as rejections and keeps serving invocations', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-gate-embedded-'));
        try {
            fs.writeFileSync(
                path.join(dir, 'project.json'),
                JSON.stringify({
                    workshop: { title: 'T', visibility: 'public', tags: [] },
                    mods: {},
                    excludes: [],
                }),
            );
            setProjectDir(dir);

            // Runtime error: rejected promise, host process still alive.
            await expect(
                runCLI('delete', ['missing_mod'], { flags: [] }),
            ).rejects.toThrow('not found in project.json');

            // The same process still completes a fresh invocation.
            await expect(
                runCLI('list', [], { flags: [] }),
            ).resolves.toBeUndefined();
        } finally {
            setProjectDir(undefined);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
