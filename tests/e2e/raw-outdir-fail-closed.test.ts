import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

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
        mockReadFailure.targetPath = path.join(
            fs.realpathSync(workspace.dir),
            'project.json',
        );

        const result = await workspace.run('delete', [modId, '--yes']);

        expect(mockReadFailure.fired).toBe(true);

        workspace.assertFailure(result);

        expect(workspace.exists(modId)).toBe(true);

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
        mockReadFailure.targetPath = path.join(
            fs.realpathSync(workspace.dir),
            'project.json',
        );

        const result = await workspace.run('add', ['Second Mod', 'second_mod']);

        expect(mockReadFailure.fired).toBe(true);

        workspace.assertFailure(result);

        expect(workspace.exists('second_mod')).toBe(false);
        expect(workspace.exists('.template-mod')).toBe(false);

        expect(workspace.read('project.json')).toBe(projectJson);
    });
});
