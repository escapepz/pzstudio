import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    isWatchPathIgnored,
    resolveWatchVariants,
    WATCH_DEBOUNCE_MS,
} from '../../packages/cli/src/lib/watch-shared';
import { createDevSync } from '../../packages/cli/src/lib/devsync';
import { setProjectDir } from '../../packages/cli/src/lib/helper';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';

describe('resolveWatchVariants (pure)', () => {
    it('defaults to syncing both outputs', () => {
        expect(resolveWatchVariants({})).toEqual(['main', 'development']);
        expect(WATCH_DEBOUNCE_MS).toBeGreaterThan(0);
    });

    it('maps each target flag to its variant', () => {
        expect(resolveWatchVariants({ both: true })).toEqual([
            'main',
            'development',
        ]);
        expect(resolveWatchVariants({ production: true })).toEqual(['main']);
        expect(resolveWatchVariants({ development: true })).toEqual([
            'development',
        ]);
    });
});

describe('isWatchPathIgnored (pure)', () => {
    // Virtual absolute paths built with the current platform's separator —
    // hardcoded Windows-style strings would collapse into single segments
    // on POSIX and make every target look "outside the project".
    const projectPath = path.join(os.tmpdir(), 'pzstudio-watch-proj');
    const outDir = path.join(projectPath, 'Output');

    it('watches the project root itself', () => {
        expect(isWatchPathIgnored(projectPath, outDir, projectPath)).toBe(
            false,
        );
    });

    it('skips paths outside the project', () => {
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, '..', 'elsewhere'),
            ),
        ).toBe(true);
    });

    it('skips the output directory and everything below it', () => {
        expect(isWatchPathIgnored(projectPath, outDir, outDir)).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(outDir, 'Contents', 'mods', 'my_mod'),
            ),
        ).toBe(true);
    });

    it('skips dot segments but keeps .pzstudioignore files', () => {
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, '.git'),
            ),
        ).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', '.template-mod', 'x.lua'),
            ),
        ).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', 'media', '.DS_Store'),
            ),
        ).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', '.pzstudioignore'),
            ),
        ).toBe(false);
    });

    it('keeps normal project files', () => {
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', 'media', 'lua', 'a.lua'),
            ),
        ).toBe(false);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'project.json'),
            ),
        ).toBe(false);
    });
});

/**
 * Containment invariants of the shared filter (doc 13 §3.1/§10-C): the
 * outdir rule fails OPEN for every configuration where the output root
 * contains or adjoins the project — the fail-open property is emergent
 * (the '..' guard and the empty-outRel no-op), so these gates pin it
 * against silent regressions of watch-shared.ts.
 */
describe('isWatchPathIgnored — containment invariants (doc 13 §10-C)', () => {
    const parent = path.join(os.tmpdir(), 'pzstudio-watch-containment');
    const projectPath = path.join(parent, 'proj');

    it('outDir equals the project root: source paths are not ignored (case 1, rule is a no-op)', () => {
        expect(
            isWatchPathIgnored(
                projectPath,
                projectPath,
                path.join(projectPath, 'my_mod', 'media', 'lua', 'a.lua'),
            ),
        ).toBe(false);
        expect(
            isWatchPathIgnored(
                projectPath,
                projectPath,
                path.join(projectPath, 'project.json'),
            ),
        ).toBe(false);
    });

    it('outDir is a project ancestor: source paths are not ignored (case 2, the ".." guard)', () => {
        expect(
            isWatchPathIgnored(
                projectPath,
                parent,
                path.join(projectPath, 'my_mod', 'media', 'a.lua'),
            ),
        ).toBe(false);
        expect(
            isWatchPathIgnored(
                projectPath,
                parent,
                path.join(projectPath, 'project.json'),
            ),
        ).toBe(false);
    });

    it('similar path prefixes never falsely contain (case 5)', () => {
        // A sibling of the project root whose name extends it.
        const siblingOut = path.join(parent, 'proj-out');
        expect(
            isWatchPathIgnored(
                projectPath,
                siblingOut,
                path.join(projectPath, 'my_mod', 'a.lua'),
            ),
        ).toBe(false);
        // A sibling segment inside the project.
        const innerSiblingOut = path.join(projectPath, 'my_mod2');
        expect(
            isWatchPathIgnored(
                projectPath,
                innerSiblingOut,
                path.join(projectPath, 'my_mod', 'a.lua'),
            ),
        ).toBe(false);
        // The sibling subtree itself stays filtered (case 3 for that root).
        expect(
            isWatchPathIgnored(
                projectPath,
                innerSiblingOut,
                path.join(innerSiblingOut, 'x.lua'),
            ),
        ).toBe(true);
    });

    it('outDir nested in a configured mod folder: the output subtree is ignored, sibling mod sources are not (case 6)', () => {
        const outDir = path.join(projectPath, 'my_mod', 'generated-A');
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(
                    outDir,
                    'My Title',
                    'Contents',
                    'mods',
                    'my_mod',
                    'media',
                    'lua',
                    'x.lua',
                ),
            ),
        ).toBe(true);
        expect(
            isWatchPathIgnored(
                projectPath,
                outDir,
                path.join(projectPath, 'my_mod', 'media', 'lua', 'x.lua'),
            ),
        ).toBe(false);
    });
});

describe('createDevSync (Node host integration)', () => {
    const dirs: string[] = [];

    afterEach(() => {
        setProjectDir(undefined);
        for (const dir of dirs.splice(0)) {
            deleteDir(dir);
        }
    });

    function makeProject(): {
        root: string;
        templateDir: string;
        projectDir: string;
    } {
        const root = createTempDir();
        dirs.push(root);

        const projectDir = path.join(root, 'proj');
        const templateDir = path.join(root, 'templates', 'workshop');
        fs.mkdirSync(path.join(projectDir, 'my_mod', 'media', 'lua'), {
            recursive: true,
        });
        fs.mkdirSync(templateDir, { recursive: true });
        fs.writeFileSync(
            path.join(projectDir, 'project.json'),
            JSON.stringify({
                workshop: {
                    title: 'Watch Project',
                    visibility: 'public',
                    tags: [],
                },
                mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
                excludes: [],
                outdir: path.join(root, 'out'),
            }),
        );
        fs.writeFileSync(
            path.join(projectDir, 'my_mod', 'media', 'lua', 'hello.lua'),
            'print("v1")',
        );
        fs.writeFileSync(
            path.join(templateDir, 'template-file.txt'),
            'template',
        );
        return { root, templateDir, projectDir };
    }

    it('runs the initial build through the real Node host helpers', async () => {
        const { templateDir, projectDir } = makeProject();
        const session = createDevSync(projectDir, {
            workshopTemplateDir: templateDir,
            quiet: true,
        });
        await session.start(['main']);

        const outFile = path.join(
            projectDir,
            '..',
            'out',
            'Watch Project',
            'Contents',
            'mods',
            'my_mod',
            'media',
            'lua',
            'hello.lua',
        );
        expect(fs.readFileSync(outFile, 'utf8')).toBe('print("v1")');
        await session.stop();
    });

    it('applies a source delta through the real Node filesystem', async () => {
        const { templateDir, projectDir } = makeProject();
        const session = createDevSync(projectDir, {
            workshopTemplateDir: templateDir,
            quiet: true,
        });
        await session.start(['main', 'development']);

        const source = path.join(
            projectDir,
            'my_mod',
            'media',
            'lua',
            'hello.lua',
        );
        fs.writeFileSync(source, 'print("v2")');
        const result = await session.apply([{ type: 'change', path: source }]);
        expect(result.errors).toEqual([]);
        expect(result.incremental).toBe(2);

        const mainOut = path.join(
            projectDir,
            '..',
            'out',
            'Watch Project',
            'Contents',
            'mods',
            'my_mod',
            'media',
            'lua',
            'hello.lua',
        );
        const devOut = path.join(
            projectDir,
            '..',
            'out',
            'Watch Project - dev_branch',
            'Contents',
            'mods',
            'my_mod_dev',
            'media',
            'lua',
            'hello.lua',
        );
        expect(fs.readFileSync(mainOut, 'utf8')).toBe('print("v2")');
        expect(fs.readFileSync(devOut, 'utf8')).toBe('print("v2")');
        await session.stop();
    });
});
