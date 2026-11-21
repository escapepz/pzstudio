import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addCmd } from '../../packages/cli/src/lib/commands/add';
import {
    projectDir,
    readRawProjectOutdir,
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
import { CliError } from '../../packages/cli/src/lib/errors';

vi.mock('fs');
vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/args');
vi.mock('../../packages/cli/src/lib/templateManager');
vi.mock('../../packages/cli/src/lib/helper', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../packages/cli/src/lib/helper')
    >()),
    projectDir: vi.fn(),
    readRawProjectOutdir: vi.fn(),
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
        vi.mocked(readRawProjectOutdir).mockReturnValue(undefined as any);
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
        expect(updateExperimentalScripts).not.toHaveBeenCalled();
    });

    it('fails closed before scaffolding when the raw outdir snapshot is unreadable (D3-a)', () => {
        vi.mocked(readRawProjectOutdir).mockImplementation(() => {
            throw new Error('snapshot unavailable');
        });

        expect(() => addCmd('Second Mod', 'second_mod')).toThrow(
            'snapshot unavailable',
        );

        expect(scaffoldProject).not.toHaveBeenCalled();
        expect(updateProjectConfig).not.toHaveBeenCalled();
        expect(updateExperimentalScripts).not.toHaveBeenCalled();
        expect(vi.mocked(removeDirRecursive)).not.toHaveBeenCalled();
    });

    it('never rolls back a pre-existing .template-mod it only seeded into', () => {
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

        expect(() => addCmd('Rollback Mod', 'rb_mod')).toThrow(
            'the original failure',
        );
    });
});

describe('addCmd duplicate-id refusal (d20-F2)', () => {
    const configWithMod = (modId: string) =>
        ({
            workshop: { title: 'T', visibility: 'public', tags: [] },
            mods: { [modId]: { name: 'Existing Mod', description: '' } },
            excludes: [],
        }) as any;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(hasFlag).mockReturnValue(false);
        vi.mocked(projectDir).mockReturnValue('/project' as any);
        vi.mocked(readRawProjectOutdir).mockReturnValue(undefined as any);
        vi.mocked(resolveProjectConfig).mockReturnValue(undefined as any);
        vi.mocked(scaffoldProject).mockReturnValue(undefined as any);
        vi.mocked(updateProjectConfig).mockReturnValue(undefined as any);
    });

    it('refuses a duplicate id with the exact message, as a planned CliError', () => {
        vi.mocked(resolveProjectConfig).mockReturnValue(
            configWithMod('case_probe'),
        );

        let thrown: unknown;
        try {
            addCmd('Case Probe', 'case_probe');
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeInstanceOf(CliError);
        expect((thrown as CliError).message).toBe(
            "A mod with id 'case_probe' already exists!",
        );
        expect((thrown as CliError).message).not.toContain('Unexpected error');
        expect(scaffoldProject).not.toHaveBeenCalled();
        expect(vi.mocked(removeDirRecursive)).not.toHaveBeenCalled();
    });

    it('names the typed id and the normalization when the spellings differ (d19-U1)', () => {
        vi.mocked(resolveProjectConfig).mockReturnValue(
            configWithMod('case_probe'),
        );

        expect(() => addCmd('Case Probe', 'Case_Probe')).toThrow(
            "A mod with id 'case_probe' already exists! (you typed 'Case_Probe' — ids are normalized to lowercase with underscores)",
        );
    });

    it('adds no typed-id note when the id derives from the mod name (d19-U1)', () => {
        vi.mocked(resolveProjectConfig).mockReturnValue(
            configWithMod('case_probe'),
        );

        expect(() => addCmd('Case Probe')).toThrow(
            "A mod with id 'case_probe' already exists!",
        );
    });
});
