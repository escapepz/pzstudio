import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
    planBuild,
    PlanBuildInput,
    executeFileOperations,
} from '../../packages/core/src/index';
import { NodeFileSystem } from '../../packages/platform-node/src/index';
import { executeBuildPlan } from '../../packages/cli/src/lib/commands/build';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';
import type { IProjectConfig } from '../../packages/core/src/project';

let root: string;

beforeEach(() => {
    root = createTempDir();
});

afterEach(() => {
    deleteDir(root);
});

const toNative = (...segments: string[]) => path.join(root, ...segments);

/**
 * Builds a fixture source tree with the cases the ignore rules must agree
 * on: dot files, .gitkeep, git folders, a root .pzstudioignore, a nested
 * .pzstudioignore overriding it (closest file wins), binary content and a
 * top-level excluded item.
 */
function seedFixture(): { projectDir: string; templateDir: string } {
    const projectDir = toNative('proj');
    const templateDir = toNative('templates', 'workshop');
    const modDir = path.join(projectDir, 'my_mod');

    fs.mkdirSync(templateDir, { recursive: true });
    fs.mkdirSync(path.join(templateDir, 'Contents', 'mods'), {
        recursive: true,
    });
    fs.writeFileSync(
        path.join(templateDir, 'Contents', 'mods', 'readme.txt'),
        'workshop template',
    );

    fs.mkdirSync(path.join(modDir, 'media', 'lua'), { recursive: true });
    fs.mkdirSync(path.join(modDir, 'dev'), { recursive: true });
    fs.mkdirSync(path.join(modDir, 'vendor'), { recursive: true });
    fs.writeFileSync(
        path.join(modDir, '.pzstudioignore'),
        'dev/\nmedia/other.lua\n',
    );
    fs.writeFileSync(
        path.join(modDir, 'media', '.pzstudioignore'),
        'old.lua\n',
    );
    fs.writeFileSync(
        path.join(modDir, 'media', 'lua', 'a.lua'),
        'print("a")\r\n',
    );
    fs.writeFileSync(path.join(modDir, 'media', 'other.lua'), 'print("other")');
    fs.writeFileSync(path.join(modDir, 'media', 'old.lua'), 'print("old")');
    fs.writeFileSync(
        path.join(modDir, 'media', 'poster.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]),
    );
    fs.writeFileSync(path.join(modDir, 'dev', 'scratch.lua'), 'scratch');
    fs.writeFileSync(path.join(modDir, 'vendor', 'lib.lua'), 'vendored');
    fs.writeFileSync(path.join(modDir, '.gitkeep'), '');
    fs.mkdirSync(path.join(modDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(modDir, '.git', 'config'), 'git');

    fs.mkdirSync(path.join(projectDir, 'workshop'), { recursive: true });
    fs.writeFileSync(
        path.join(projectDir, 'workshop', 'description.txt'),
        'line one\r\nline two\r\n',
    );
    fs.writeFileSync(
        path.join(projectDir, 'workshop', 'preview.png'),
        Buffer.from([0x00, 0x01, 0x02]),
    );
    return { projectDir, templateDir };
}

function fixtureConfig(): IProjectConfig {
    return {
        workshop: {
            id: 999,
            title: 'Parity Project',
            visibility: 'public',
            tags: ['Build 42'],
        },
        mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
        excludes: ['vendor'],
        outdir: '/placeholder',
    } as unknown as IProjectConfig;
}

function planInputFor(
    projectDir: string,
    templateDir: string,
    outdir: string,
    variant: 'main' | 'development',
): PlanBuildInput {
    const config = { ...fixtureConfig(), outdir } as IProjectConfig;
    return {
        config,
        variant,
        workshopTemplateDir: templateDir,
        projectDir,
        modSourceStates: {
            my_mod: { branchFolders: [], modInfoExists: {} },
        },
        descriptionLines: ['line one', 'line two'],
        previewPngExists: true,
    };
}

/** Collects every file under dir as relativePosixPath -> content string. */
function snapshot(dir: string): Map<string, string> {
    const files = new Map<string, string>();
    const walk = (current: string, rel: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const childPath = path.join(current, entry.name);
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(childPath, childRel);
            } else {
                files.set(
                    childRel,
                    fs.readFileSync(childPath).toString('latin1'),
                );
            }
        }
    };
    walk(dir, '');
    return files;
}

/**
 * Parity gate for the sync engine's executor: for the same plan, the
 * filesystem-based executor (executeFileOperations on NodeFileSystem) and
 * the CLI's synchronous executor (executeBuildPlan, backed by
 * scaffoldProject) must produce byte-identical output trees.
 */
describe('executeFileOperations is in parity with the CLI build executor', () => {
    for (const variant of ['main', 'development'] as const) {
        it(`produces the same output tree as the synchronous executor (${variant})`, async () => {
            const { projectDir, templateDir } = seedFixture();

            const syncOut = toNative('out-sync');
            const fsOut = toNative('out-fs');

            const syncOps = planBuild(
                planInputFor(projectDir, templateDir, syncOut, variant),
            );
            const fsOps = planBuild(
                planInputFor(projectDir, templateDir, fsOut, variant),
            );

            executeBuildPlan(syncOps);
            await executeFileOperations(new NodeFileSystem(), fsOps);

            const titleDir =
                variant === 'main'
                    ? 'Parity Project'
                    : 'Parity Project - dev_branch';
            const modDirName = variant === 'main' ? 'my_mod' : 'my_mod_dev';
            expect(snapshot(fsOut)).toEqual(snapshot(syncOut));
            // Sanity: the fixture really exercised the interesting rules.
            const files = [...snapshot(path.join(syncOut, titleDir)).keys()];
            expect(files).toContain(
                `Contents/mods/${modDirName}/media/lua/a.lua`,
            );
            expect(files).toContain(
                `Contents/mods/${modDirName}/media/other.lua`,
            );
            expect(files.some((f) => f.includes('dev/scratch.lua'))).toBe(
                false,
            );
            expect(files.some((f) => f.includes('old.lua'))).toBe(false);
            expect(files.some((f) => f.includes('vendor'))).toBe(false);
        });
    }
});
