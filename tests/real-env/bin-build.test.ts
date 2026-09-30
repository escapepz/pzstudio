import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    defaultOutRoot,
    RealEnvWorkspace,
    seedWorkshopTemplateCache,
} from '../helpers/real-env';

/**
 * Real-environment tests for `pzstudio build`/`clean`: hand-written fixture
 * projects (no templates, no git) built by the spawned binary into the fake
 * home's workshop output, verified on the real filesystem.
 */
describe('real env: build and clean commands', () => {
    const PROJECT_TITLE = 'Real Env Build';
    const MOD_ID = 'real_build_mod';

    let workspace: RealEnvWorkspace;

    beforeEach(() => {
        workspace = new RealEnvWorkspace();
        writeBuildFixture(workspace);
        // Hermetic template cache: without it the workshop template
        // resolution would attempt a real git clone in a fresh home.
        seedWorkshopTemplateCache(workspace.home);
    });

    afterEach(async () => {
        await workspace.cleanup();
    });

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
                    [MOD_ID]: {
                        name: 'Real Build Mod',
                        description: 'Built by the real binary.',
                    },
                },
                excludes: [],
            }),
        );
        ws.write(
            path.join(MOD_ID, '42', 'media', 'lua', 'shared', 'main.lua'),
            '-- real env build\n',
        );
        ws.write(path.join(MOD_ID, 'poster.png'), 'fake poster');
        ws.write(
            path.join('workshop', 'description.txt'),
            'Real env description',
        );
        ws.write(path.join('workshop', 'preview.png'), 'fake preview');
    }

    it('packages the main workshop output into the default outdir', async () => {
        const result = await workspace.run(['build']);
        expect(result.exitCode).toBe(0);

        const outDir = path.join(defaultOutRoot(workspace.home), PROJECT_TITLE);
        const sharedLuaDir = path.join(
            outDir,
            'Contents',
            'mods',
            MOD_ID,
            '42',
            'media',
            'lua',
            'shared',
        );
        expect(fs.existsSync(sharedLuaDir)).toBe(true);
        expect(fs.existsSync(path.join(outDir, 'workshop.txt'))).toBe(true);
        expect(
            fs.readFileSync(path.join(outDir, 'workshop.txt'), 'utf8'),
        ).toContain(PROJECT_TITLE);
        expect(fs.existsSync(path.join(outDir, 'preview.png'))).toBe(true);
    });

    it('packages the dev_branch output with patched mod ids', async () => {
        const result = await workspace.run(['build', '--development']);
        expect(result.exitCode).toBe(0);

        const outDir = path.join(
            defaultOutRoot(workspace.home),
            `${PROJECT_TITLE} - dev_branch`,
        );
        const modInfoPath = path.join(
            outDir,
            'Contents',
            'mods',
            `${MOD_ID}_dev`,
            '42',
            'mod.info',
        );
        expect(fs.existsSync(modInfoPath)).toBe(true);
        expect(fs.readFileSync(modInfoPath, 'utf8')).toContain(
            `id=${MOD_ID}_dev`,
        );
        expect(
            fs.existsSync(
                path.join(
                    outDir,
                    'Contents',
                    'mods',
                    `${MOD_ID}_dev`,
                    '42',
                    'media',
                    'lua',
                    'shared',
                    'main.lua',
                ),
            ),
        ).toBe(true);
    });

    it('builds both outputs with --both and removes both with clean', async () => {
        const buildResult = await workspace.run(['build', '--both']);
        expect(buildResult.exitCode).toBe(0);

        const mainOutDir = path.join(
            defaultOutRoot(workspace.home),
            PROJECT_TITLE,
        );
        const devOutDir = path.join(
            defaultOutRoot(workspace.home),
            `${PROJECT_TITLE} - dev_branch`,
        );
        expect(fs.existsSync(mainOutDir)).toBe(true);
        expect(fs.existsSync(devOutDir)).toBe(true);

        const cleanResult = await workspace.run(['clean']);
        expect(cleanResult.exitCode).toBe(0);
        expect(fs.existsSync(mainOutDir)).toBe(false);
        expect(fs.existsSync(devOutDir)).toBe(false);
    });

    it('skips the main build for a dev-only project without destroying the previous output', async () => {
        // Replace the fixture with a dev-only project and seed a stale marker
        // into the expected main output so we can prove it is preserved.
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    title: PROJECT_TITLE,
                    visibility: 'public',
                    tags: [],
                },
                mods: {
                    [MOD_ID]: {
                        name: 'Real Build Mod',
                        description: 'Dev-only.',
                        build: { devOnly: true },
                    },
                },
                excludes: [],
            }),
        );
        const markerPath = path.join(
            defaultOutRoot(workspace.home),
            PROJECT_TITLE,
            'marker.txt',
        );
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        fs.writeFileSync(markerPath, 'previous output');

        const result = await workspace.run(['build', '--production']);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('All mods are dev-only or excluded');
        expect(fs.readFileSync(markerPath, 'utf8')).toBe('previous output');
    });

    it('honors a project-level outdir over the global default', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                outdir: './dist_out',
                workshop: {
                    title: PROJECT_TITLE,
                    visibility: 'public',
                    tags: [],
                },
                mods: {
                    [MOD_ID]: {
                        name: 'Real Build Mod',
                        description: 'Custom outdir.',
                    },
                },
                excludes: [],
            }),
        );

        const result = await workspace.run(['build']);
        expect(result.exitCode).toBe(0);

        const outDir = workspace.path('dist_out');
        expect(
            fs.existsSync(path.join(outDir, PROJECT_TITLE, 'workshop.txt')),
        ).toBe(true);
        // Nothing landed in the default workshop output.
        expect(
            fs.existsSync(
                path.join(defaultOutRoot(workspace.home), PROJECT_TITLE),
            ),
        ).toBe(false);
    });
});
