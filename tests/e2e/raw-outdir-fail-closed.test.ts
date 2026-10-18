import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

// D3-a fail-closed regression: the RAW outdir snapshot re-reads
// project.json mid-command. To make the FIRST read (resolveProjectConfig)
// succeed while the SECOND (the snapshot) fails, the fs module is replaced
// by a pass-through dispatcher that arms on the first project.json read
// and fails exactly one further read of that same file. Every other read
// (and every other fs function) is the untouched real implementation.
//
// A module-level vi.mock is required here: vi.spyOn(fs, ...) does not
// reach the CLI source graph's 'fs' binding.
const mockReadFailure = {
    armed: false,
    targetPath: '',
    fired: false,
};

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    const patched = Object.assign({}, actual) as typeof actual;
    patched.readFileSync = ((p: any, opts: any) => {
        if (mockReadFailure.armed && String(p) === mockReadFailure.targetPath) {
            mockReadFailure.armed = false;
            mockReadFailure.fired = true;
            throw new Error('EIO: simulated mid-command read failure');
        }
        if (String(p) === mockReadFailure.targetPath) {
            mockReadFailure.armed = true;
        }
        return actual.readFileSync(p, opts);
    }) as typeof fs.readFileSync;
    return patched;
});

describe('raw outdir snapshot fail-closed (D3-a)', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
    });

    afterEach(() => {
        workspace.cleanup();
        mockReadFailure.armed = false;
        mockReadFailure.targetPath = '';
        mockReadFailure.fired = false;
    });

    it('delete fails closed and keeps the mod directory when the raw outdir snapshot becomes unreadable', async () => {
        const modId = 'protected_target';
        const projectJson = JSON.stringify({
            workshop: { title: 'P', visibility: 'public', tags: [] },
            outdir: './bin',
            mods: {
                [modId]: { name: 'P', description: 'D' },
            },
            excludes: [],
        });
        workspace.write('project.json', projectJson);
        workspace.write(`${modId}/mod.info`, `id=${modId}`);
        // macOS canonical-path fix: chdir'ing into the tmpdir resolves the
        // /var → /private/var symlink, so the CLI reads project.json via
        // process.cwd()'s canonical form. Compare against that form.
        mockReadFailure.targetPath = path.join(
            fs.realpathSync(workspace.dir),
            'project.json',
        );

        const result = await workspace.run('delete', [modId, '--yes']);

        // The dispatcher must have actually fired, or the test proves
        // nothing.
        expect(mockReadFailure.fired).toBe(true);

        // Fail closed: the command aborts instead of proceeding with a
        // write-back that would discard the configured outdir.
        workspace.assertFailure(result);

        // Nothing on disk was touched: the mod directory survives.
        expect(workspace.exists(modId)).toBe(true);

        // project.json is byte-for-byte unchanged (outdir intact).
        expect(workspace.read('project.json')).toBe(projectJson);
    });

    it('add fails closed and scaffolds nothing when the raw outdir snapshot is unreadable', async () => {
        const projectJson = JSON.stringify({
            workshop: { title: 'P', visibility: 'public', tags: [] },
            outdir: './bin',
            mods: {},
            excludes: [],
        });
        workspace.write('project.json', projectJson);
        // macOS canonical-path fix: chdir'ing into the tmpdir resolves the
        // /var → /private/var symlink, so the CLI reads project.json via
        // process.cwd()'s canonical form. Compare against that form.
        mockReadFailure.targetPath = path.join(
            fs.realpathSync(workspace.dir),
            'project.json',
        );

        const result = await workspace.run('add', ['Second Mod', 'second_mod']);

        expect(mockReadFailure.fired).toBe(true);

        // Fail closed: the command aborts instead of writing a config with
        // the configured outdir discarded.
        workspace.assertFailure(result);

        // No mod directory was scaffolded and no template cache was
        // seeded into the project.
        expect(workspace.exists('second_mod')).toBe(false);
        expect(workspace.exists('.template-mod')).toBe(false);

        // project.json is byte-for-byte unchanged (outdir intact).
        expect(workspace.read('project.json')).toBe(projectJson);
    });
});
