import path from 'path';
import fs from 'fs';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';
import * as cp from 'child_process';

vi.mock('child_process');

describe('build command e2e', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
        vi.spyOn(cp, 'spawnSync').mockReturnValue({
            status: 0,
            stdout: Buffer.from(''),
            stderr: Buffer.from(''),
        } as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        workspace.cleanup();
    });

    it('should build a project created with new', async () => {
        // 1. Create a new project
        const projectTitle = 'Build Project';
        const modId = 'build_mod';

        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    title: projectTitle,
                    visibility: 'public',
                    tags: ['Building'],
                },
                mods: {
                    [modId]: {
                        name: 'Build Mod',
                        description: 'Description',
                        build: {
                            modInfo: 'auto',
                        },
                    },
                },
                excludes: [],
            }),
        );
        workspace.write(path.join(modId, 'poster.png'), 'fake image');
        workspace.write(path.join('workshop', 'preview.png'), 'fake preview');

        const buildResult = await workspace.run('build');
        workspace.assertSuccess(buildResult);

        try {
            // Dist-always: no outdir configured anywhere → pure build mode.
            // The artifacts land in the project's canonical dist root and
            // nothing is deployed.
            const expectedOutDir = path.join(
                workspace.dir,
                'dist',
                projectTitle,
            );
            expect(fs.existsSync(expectedOutDir)).toBe(true);
            expect(
                fs.existsSync(path.join(expectedOutDir, 'workshop.txt')),
            ).toBe(true);
            expect(
                fs.existsSync(path.join(expectedOutDir, 'preview.png')),
            ).toBe(true);
            expect(
                fs.existsSync(
                    path.join(
                        expectedOutDir,
                        'Contents',
                        'mods',
                        modId,
                        'mod.info',
                    ),
                ),
            ).toBe(true);
            expect(
                fs.existsSync(
                    path.join(
                        workspace.fakeHome,
                        'Zomboid',
                        'Workshop',
                        projectTitle,
                    ),
                ),
            ).toBe(false);
        } catch (e) {
            console.log('STDOUT:', buildResult.stdout.join('\n'));
            console.log('STDERR:', buildResult.stderr.join('\n'));
            throw e;
        }
    }, 60000);

    it('should build with custom outdir (dist + junction deployment)', async () => {
        const projectTitle = 'Custom OutDir';
        const modId = 'custom_mod';
        const customOutDirName = 'custom_output';
        const customOutDirPath = path.join(workspace.dir, customOutDirName);

        workspace.write(
            'project.json',
            JSON.stringify({
                outdir: './' + customOutDirName,
                workshop: {
                    title: projectTitle,
                    visibility: 'public',
                    tags: ['Building'],
                },
                mods: {
                    [modId]: {
                        name: 'Custom Mod',
                        description: 'Description',
                        build: {
                            modInfo: 'auto',
                        },
                    },
                },
                excludes: [],
            }),
        );
        workspace.write(path.join(modId, 'poster.png'), 'fake image');

        const buildResult = await workspace.run('build');
        workspace.assertSuccess(buildResult);

        // Dist-always: artifacts land in dist; the configured outdir
        // receives the per-item junction (mode 'symlink', the default).
        const distItem = path.join(workspace.dir, 'dist', projectTitle);
        expect(fs.existsSync(distItem)).toBe(true);
        expect(fs.existsSync(path.join(distItem, 'workshop.txt'))).toBe(true);
        // The ownership marker must live in DIST, not the deployment root:
        // it is what proves ownership to the junction cascade on every
        // later build.
        expect(
            fs.existsSync(path.join(distItem, '.pzstudio-output.json')),
        ).toBe(true);
        expect(
            fs
                .lstatSync(path.join(customOutDirPath, projectTitle))
                .isSymbolicLink(),
        ).toBe(true);

        // A second build re-inspects the existing junction: with the marker
        // in place it must stay OK_LINK, never degrade to UNOWNED_TARGET.
        const secondBuild = await workspace.run('build');
        workspace.assertSuccess(secondBuild);
        expect(secondBuild.stderr.join('\n')).not.toMatch(
            /UNOWNED_TARGET|no ownership marker/i,
        );
        expect(
            fs
                .lstatSync(path.join(customOutDirPath, projectTitle))
                .isSymbolicLink(),
        ).toBe(true);
    });

    it('toggles symlink -> copy -> symlink (§6.5 both directions)', async () => {
        const projectTitle = 'Toggle Item';
        const modId = 'toggle_mod';
        const customOutDirName = 'toggle_output';
        const customOutDirPath = path.join(workspace.dir, customOutDirName);
        const projectJsonPath = path.join(workspace.dir, 'project.json');
        const distItem = path.join(workspace.dir, 'dist', projectTitle);
        const slot = path.join(customOutDirPath, projectTitle);

        workspace.write(
            'project.json',
            JSON.stringify({
                outdir: './' + customOutDirName,
                workshop: {
                    title: projectTitle,
                    visibility: 'public',
                    tags: [],
                },
                mods: { [modId]: { name: 'Toggle', description: 'D' } },
            }),
        );
        workspace.write(path.join(modId, 'poster.png'), 'fake image');

        const setMaterialize = (mode: 'copy' | 'symlink'): void => {
            const cfg = JSON.parse(
                fs.readFileSync(projectJsonPath, 'utf8'),
            ) as Record<string, unknown>;
            cfg.build = {
                ...(cfg.build as Record<string, unknown> | undefined),
                materialize: mode,
            };
            fs.writeFileSync(projectJsonPath, JSON.stringify(cfg, null, 2));
        };

        // Build 1 — default symlink: a junction at the deployment root.
        const first = await workspace.run('build');
        workspace.assertSuccess(first);
        expect(fs.lstatSync(slot).isSymbolicLink()).toBe(true);
        expect(
            fs.existsSync(path.join(distItem, '.pzstudio-output.json')),
        ).toBe(true);

        // Build 2 — copy: the junction is unlinked, a real reconciled copy
        // carrying the copy marker replaces it.
        setMaterialize('copy');
        const second = await workspace.run('build');
        workspace.assertSuccess(second);
        expect(fs.lstatSync(slot).isDirectory()).toBe(true);
        expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
        expect(fs.existsSync(path.join(slot, 'workshop.txt'))).toBe(true);
        expect(fs.existsSync(path.join(slot, '.pzstudio-copy.json'))).toBe(
            true,
        );
        expect(
            fs.existsSync(path.join(distItem, '.pzstudio-output.json')),
        ).toBe(true);

        // Build 3 — back to symlink: the proven-clean copy slot is removed
        // and the junction restored; dist is untouched throughout.
        setMaterialize('symlink');
        const third = await workspace.run('build');
        workspace.assertSuccess(third);
        expect(fs.lstatSync(slot).isSymbolicLink()).toBe(true);
        expect(
            fs.readFileSync(path.join(slot, 'workshop.txt'), 'utf8'),
        ).toContain(projectTitle);
        expect(
            fs.existsSync(path.join(distItem, '.pzstudio-output.json')),
        ).toBe(true);
    });

    it('should build dist cleanly and surface the deployment failure when outdir is invalid', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                // A path that passes through an existing FILE: creating a
                // directory under it fails on every platform (ENOTDIR),
                // unlike Windows-reserved characters such as '?'.
                outdir: './project.json',
                workshop: {
                    title: 'Invalid OutDir',
                    visibility: 'public',
                    tags: [],
                },
                mods: { mod: { name: 'M', description: 'D' } },
            }),
        );
        workspace.write(path.join('mod', 'poster.png'), 'fake image');

        const buildResult = await workspace.run('build');
        // Dist-always: the artifacts are complete in dist; the outdir is a
        // deployment target — an unusable one is a surfaced, non-fatal
        // materialize failure, never a build failure.
        workspace.assertSuccess(buildResult);
        expect(
            fs.existsSync(path.join(workspace.dir, 'dist', 'Invalid OutDir')),
        ).toBe(true);
        expect(buildResult.stderr.join('\n')).toMatch(
            /workshop link failed|enoent|refused/i,
        );
    });

    it('should clean up stale output files before building', async () => {
        const projectTitle = 'Stale Output';
        const modId = 'stale_mod';
        const customOutDirName = 'stale_output';

        workspace.write(
            'project.json',
            JSON.stringify({
                outdir: './' + customOutDirName,
                workshop: {
                    title: projectTitle,
                    visibility: 'public',
                    tags: [],
                },
                mods: { [modId]: { name: 'M', description: 'D' } },
            }),
        );
        workspace.write(path.join(modId, 'poster.png'), 'fake image');

        // Create a stale file in the canonical dist output directory
        const outModPath = path.join(
            workspace.dir,
            'dist',
            projectTitle,
            'Contents',
            'mods',
            modId,
        );
        fs.mkdirSync(outModPath, { recursive: true });
        fs.writeFileSync(
            path.join(outModPath, 'stale_file.txt'),
            'this should be removed',
        );

        const buildResult = await workspace.run('build');
        workspace.assertSuccess(buildResult);

        expect(fs.existsSync(path.join(outModPath, 'stale_file.txt'))).toBe(
            false,
        );
        expect(fs.existsSync(path.join(outModPath, 'poster.png'))).toBe(true);
    });

    it('should not generate mod.info when build.modInfo is skip', async () => {
        const projectTitle = 'Skip ModInfo';
        const modId = 'skip_mod';

        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    title: projectTitle,
                    visibility: 'public',
                    tags: [],
                },
                mods: {
                    [modId]: {
                        name: 'Skip',
                        description: 'Skip',
                        build: { modInfo: 'skip' },
                    },
                },
            }),
        );
        workspace.write(path.join(modId, 'poster.png'), 'fake');

        const buildResult = await workspace.run('build');
        workspace.assertSuccess(buildResult);

        const outModPath = path.join(
            workspace.dir,
            'dist',
            projectTitle,
            'Contents',
            'mods',
            modId,
        );
        expect(fs.existsSync(path.join(outModPath, 'mod.info'))).toBe(false);
    });
});
