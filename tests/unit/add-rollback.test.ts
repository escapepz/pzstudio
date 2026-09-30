import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addCmd } from '../../packages/cli/src/lib/commands/add';
import {
    projectDir,
    resolveProjectConfig,
    updateProjectConfig,
    updateExperimentalScripts,
    removeDirRecursive,
} from '../../packages/cli/src/lib/helper';
import {
    resolveTemplateDir,
    scaffoldProject,
} from '../../packages/cli/src/lib/templateManager';
import { hasFlag } from '../../packages/cli/src/lib/args';

vi.mock('fs');
vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/args');
vi.mock('../../packages/cli/src/lib/templateManager');
vi.mock('../../packages/cli/src/lib/helper', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../packages/cli/src/lib/helper')
    >()),
    projectDir: vi.fn(),
    resolveProjectConfig: vi.fn(),
    updateProjectConfig: vi.fn(),
    updateExperimentalScripts: vi.fn(),
    removeDirRecursive: vi.fn(),
}));

describe('addCmd rollback ownership guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        vi.mocked(hasFlag).mockReturnValue(false);
        vi.mocked(projectDir).mockReturnValue('/project' as any);
        vi.mocked(resolveProjectConfig).mockReturnValue({
            workshop: { title: 'T', visibility: 'public', tags: [] },
            mods: {},
            excludes: [],
        } as any);
        vi.mocked(resolveTemplateDir).mockImplementation(
            (category: any) => `/tpl/${category}` as any,
        );
        vi.mocked(scaffoldProject).mockReturnValue(undefined as any);
        vi.mocked(updateProjectConfig).mockReturnValue(undefined as any);
    });

    it('rolls back exactly what this invocation created, newest first', () => {
        // No local template anywhere: the mod dir AND the seeded
        // .template-mod cache are both created by this invocation.
        vi.mocked(updateProjectConfig).mockImplementation(() => {
            throw new Error('EPERM: operation not permitted');
        });

        expect(() => addCmd('Rollback Mod', 'rb_mod')).toThrow('EPERM');

        expect(
            vi.mocked(removeDirRecursive).mock.calls.map((c) => c[0]),
        ).toEqual([
            path.join('/project', '.template-mod'),
            path.join('/project', 'rb_mod'),
        ]);
        // The post-mutation hooks never ran.
        expect(updateExperimentalScripts).not.toHaveBeenCalled();
    });

    it('never rolls back a pre-existing .template-mod it only seeded into', () => {
        // The local template exists but is EMPTY: tier-0 rejects it, the
        // remote template is scaffolded and seeded into the pre-existing
        // (empty) cache directory — which this invocation did not create.
        vi.mocked(fs.existsSync).mockImplementation(
            (p: any) => String(p) === path.join('/project', '.template-mod'),
        );
        vi.mocked(fs.readdirSync).mockReturnValue([] as any);
        vi.mocked(updateProjectConfig).mockImplementation(() => {
            throw new Error('EPERM: operation not permitted');
        });

        expect(() => addCmd('Rollback Mod', 'rb_mod')).toThrow('EPERM');

        expect(
            vi.mocked(removeDirRecursive).mock.calls.map((c) => c[0]),
        ).toEqual([path.join('/project', 'rb_mod')]);
    });

    it('rethrows the original error after a failed rollback', () => {
        vi.mocked(updateProjectConfig).mockImplementation(() => {
            throw new Error('the original failure');
        });
        vi.mocked(removeDirRecursive).mockImplementation(() => {
            throw new Error('cleanup also failed');
        });

        // The cleanup failure is reported but must not mask the original.
        expect(() => addCmd('Rollback Mod', 'rb_mod')).toThrow(
            'the original failure',
        );
    });
});
