import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

/**
 * Module-level state that controls the mocked spawnSync behavior.
 * Tests set `mockFailSubstrings` before calling workspace.run() to
 * control which git clone operations should fail.
 */
let mockFailSubstrings: string[] = [];

vi.mock('child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('child_process')>();
    return {
        ...original,
        spawnSync: (command: string, args?: readonly string[], opts?: any) => {
            if (command === 'git') {
                const argsList = (args ?? []) as string[];
                if (argsList[0] === 'clone') {
                    const url = argsList[argsList.length - 2];
                    const dest = argsList[argsList.length - 1];

                    if (mockFailSubstrings.some((s) => url.includes(s))) {
                        return { status: 1 } as any;
                    }

                    // Mock success: create a .git dir and a dummy file
                    fs.mkdirSync(dest, { recursive: true });
                    fs.mkdirSync(path.join(dest, '.git'), {
                        recursive: true,
                    });
                    fs.writeFileSync(path.join(dest, 'project.json'), '{}');
                    return { status: 0 } as any;
                } else {
                    // Refresh operations: fetch, reset, submodule, clean
                    const cwd = opts?.cwd as string;
                    if (
                        cwd &&
                        mockFailSubstrings.some((s) => cwd.includes(s))
                    ) {
                        return { status: 1 } as any;
                    }
                    return { status: 0 } as any;
                }
            }
            return original.spawnSync(command, args as any, opts);
        },
    };
});

/**
 * True when stderr reports a clone FAILURE for the given template category.
 * The URL alone is not enough since the stream contract (CLI-2) puts the
 * "Cloning template from <url>" progress line on stderr for every category.
 */
const stderrHasCloneFailure = (result: E2EResult, category: string) =>
    result.stderr.some(
        (l) =>
            l.includes('Failed to clone template from') &&
            l.includes(`pzstudio-template-${category}`),
    );

describe('update command (E2E) - Mocked', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
        mockFailSubstrings = [];
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should successfully refresh all template caches', async () => {
        const result = await workspace.run('update');
        workspace.assertSuccess(result);
        workspace.assertStderr(result, 'Refreshing global template caches');
        workspace.assertStderr(result, "Updating 'project' templates");
        workspace.assertStderr(
            result,
            'All template caches refreshed successfully!',
        );
    });

    it('should succeed with legacy fallback when some clones fail', async () => {
        mockFailSubstrings = ['template-mod'];

        const result = await workspace.run('update');
        workspace.assertSuccess(result);

        // Clone failure is logged as a warning
        workspace.assertStderr(
            result,
            "Failed to clone template from 'https://github.com/escapepz/pzstudio-template-mod.git'",
        );
        // Falls back to legacy template, so updateCmd still counts it as success
        workspace.assertStderr(
            result,
            'All template caches refreshed successfully!',
        );
    });

    it('should succeed with legacy fallback when all clones fail', async () => {
        mockFailSubstrings = ['template'];

        const result = await workspace.run('update');
        workspace.assertSuccess(result);

        // All clones fail, all fall back to legacy
        workspace.assertStderr(
            result,
            "Failed to clone template from 'https://github.com/escapepz/pzstudio-template-project.git'",
        );
        workspace.assertStderr(result, 'Falling back to offline legacy');

        // updateCmd still considers all successful because resolveTemplateDir
        // returned a valid path (the legacy fallback)
        workspace.assertStderr(
            result,
            'All template caches refreshed successfully!',
        );
    });
});

describe('update — per-category failure isolation (E2E)', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
        mockFailSubstrings = [];
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should warn only about project clone failure when project is the only failing category', async () => {
        mockFailSubstrings = ['template-project'];

        const result = await workspace.run('update');
        workspace.assertSuccess(result);

        // Project clone failure should be warned
        workspace.assertStderr(
            result,
            "Failed to clone template from 'https://github.com/escapepz/pzstudio-template-project.git'",
        );

        // Other categories should NOT have clone failures in stderr
        expect(stderrHasCloneFailure(result, 'mod')).toBe(false);
        expect(stderrHasCloneFailure(result, 'workshop')).toBe(false);
        expect(stderrHasCloneFailure(result, 'language')).toBe(false);
    });

    it('should warn only about mod clone failure when mod is the only failing category', async () => {
        mockFailSubstrings = ['template-mod'];

        const result = await workspace.run('update');
        workspace.assertSuccess(result);

        workspace.assertStderr(
            result,
            "Failed to clone template from 'https://github.com/escapepz/pzstudio-template-mod.git'",
        );

        expect(stderrHasCloneFailure(result, 'project')).toBe(false);
        expect(stderrHasCloneFailure(result, 'workshop')).toBe(false);
        expect(stderrHasCloneFailure(result, 'language')).toBe(false);
    });

    it('should warn only about workshop clone failure when workshop is the only failing category', async () => {
        mockFailSubstrings = ['template-workshop'];

        const result = await workspace.run('update');
        workspace.assertSuccess(result);

        workspace.assertStderr(
            result,
            "Failed to clone template from 'https://github.com/escapepz/pzstudio-template-workshop.git'",
        );

        expect(stderrHasCloneFailure(result, 'project')).toBe(false);
        expect(stderrHasCloneFailure(result, 'mod')).toBe(false);
        expect(stderrHasCloneFailure(result, 'language')).toBe(false);
    });

    it('should warn only about language clone failure when language is the only failing category', async () => {
        mockFailSubstrings = ['template-language'];

        const result = await workspace.run('update');
        workspace.assertSuccess(result);

        workspace.assertStderr(
            result,
            "Failed to clone template from 'https://github.com/escapepz/pzstudio-template-language.git'",
        );

        expect(stderrHasCloneFailure(result, 'project')).toBe(false);
        expect(stderrHasCloneFailure(result, 'mod')).toBe(false);
        expect(stderrHasCloneFailure(result, 'workshop')).toBe(false);
    });

    it('should warn about exactly two categories when project and language fail together', async () => {
        mockFailSubstrings = ['template-project', 'template-language'];

        const result = await workspace.run('update');
        workspace.assertSuccess(result);

        workspace.assertStderr(
            result,
            "Failed to clone template from 'https://github.com/escapepz/pzstudio-template-project.git'",
        );
        workspace.assertStderr(
            result,
            "Failed to clone template from 'https://github.com/escapepz/pzstudio-template-language.git'",
        );

        expect(stderrHasCloneFailure(result, 'mod')).toBe(false);
        expect(stderrHasCloneFailure(result, 'workshop')).toBe(false);
    });
});

describe('update — legacy template cache refresh (E2E)', () => {
    let workspace: E2ETestWorkspace;

    // The stamped bundled copy Task 1's build step produces
    // (packages/cli/dist/.template-legacy/.pzstudio-templates.json). In the
    // in-process suite the bundled-dir probe reaches only
    // <cwd>/.template-legacy, and workspace.run() chdirs to the workspace,
    // so planting it there pins the bundled side of the stamp comparison.
    const stampedBundledDir = path.resolve(
        __dirname,
        '..',
        '..',
        'packages',
        'cli',
        'dist',
        '.template-legacy',
    );

    /** Plants the stamped bundled copy where the cwd probe will find it. */
    const plantBundledLegacyCopy = () => {
        if (
            !fs.existsSync(
                path.join(stampedBundledDir, '.pzstudio-templates.json'),
            )
        ) {
            throw new Error(
                'Missing stamped dist copy of .template-legacy — run `pnpm build` before this suite.',
            );
        }
        fs.cpSync(
            stampedBundledDir,
            path.join(workspace.dir, '.template-legacy'),
            { recursive: true },
        );
    };

    const globalLegacyDir = () =>
        path.join(workspace.fakeHome, '.pzstudio', '.template-legacy');

    beforeEach(() => {
        workspace = createE2EWorkspace();
        mockFailSubstrings = [];
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('reports the legacy cache as up to date on a fresh home', async () => {
        plantBundledLegacyCopy();
        // A fresh home: drop the pre-seeded junction (rmSync unlinks the
        // link, never the shared store) so the category loop's bootstrap
        // fills the cache from the bundled copy — the stamps then already
        // match when the refresh step compares them.
        fs.rmSync(globalLegacyDir(), { recursive: true, force: true });

        const result = await workspace.run('update');
        workspace.assertSuccess(result);
        workspace.assertStderr(result, 'Legacy templates up to date.');
    });

    it('refreshes a stale legacy cache and washes out stale content', async () => {
        plantBundledLegacyCopy();
        // Seed the installed cache with content the bundled copy does not
        // carry (and no stamp): the refresh must replace it wholesale.
        fs.rmSync(globalLegacyDir(), { recursive: true, force: true });
        fs.mkdirSync(globalLegacyDir(), { recursive: true });
        fs.writeFileSync(
            path.join(globalLegacyDir(), 'stale-marker.txt'),
            'stale',
        );

        const result = await workspace.run('update');
        workspace.assertSuccess(result);
        workspace.assertStderr(result, 'Legacy templates refreshed');
        expect(
            fs.existsSync(path.join(globalLegacyDir(), 'stale-marker.txt')),
        ).toBe(false);
    });
});
