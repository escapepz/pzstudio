import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
    inspectMaterializeSlot,
    NodeFileSystem,
} from '@pzstudio/platform-node';
import type { LinkFs } from '../../packages/platform-node/src/link/linkManager';
import {
    resolveBuildOutputPath,
    writeOutputMarker,
    type IProjectConfig,
} from '@pzstudio/core';
import { resolveDoctorWorkshopInputs } from '../../packages/cli/src/lib/doctor';

const actualInspect = vi.hoisted(() => ({
    fn: undefined as
        | ((
              linkFs: unknown,
              W: string,
              D: string,
              opts: unknown,
          ) => Promise<unknown>)
        | undefined,
}));

vi.mock('@pzstudio/platform-node', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('@pzstudio/platform-node')>();
    actualInspect.fn = actual.inspectMaterializeSlot as typeof actualInspect.fn;
    return {
        ...actual,
        inspectMaterializeSlot: vi.fn(
            (linkFs: unknown, W: string, D: string, opts: unknown) =>
                actualInspect.fn!(linkFs, W, D, opts),
        ),
    };
});

describe('resolveDoctorWorkshopInputs: slot read failure resilience', () => {
    let root: string;
    let dist: string;
    let workshop: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'pz-doc-inspect-'));
        dist = join(root, 'dist');
        workshop = join(root, 'workshop');
        mkdirSync(dist, { recursive: true });
        mkdirSync(workshop, { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        vi.mocked(inspectMaterializeSlot).mockReset();
    });

    it('a locked slot reports INSPECT_FAILED instead of rejecting the report', async () => {
        const config = {
            workshop: { title: 'Item' },
            outdir: dist,
            mods: { my_mod: {} },
        } as unknown as IProjectConfig;
        const itemDir = resolveBuildOutputPath(config, 'main');
        await fsp.mkdir(join(itemDir, 'Contents', 'mods', 'my_mod'), {
            recursive: true,
        });
        writeFileSync(join(itemDir, 'workshop.txt'), 'title=Item\n');
        await writeOutputMarker(new NodeFileSystem(), {
            config,
            variant: 'main',
            projectDir: root,
            engineVersion: 'test',
            outputRoot: dist,
        });

        const itemName = basename(itemDir);
        const eperm = Object.assign(
            new Error('EPERM: operation not permitted, lstat'),
            { code: 'EPERM' },
        );
        vi.mocked(inspectMaterializeSlot).mockImplementation(
            async (linkFs, W, D, opts) => {
                if (String(W).endsWith(itemName)) {
                    throw eperm;
                }
                return actualInspect.fn!(
                    linkFs as unknown as LinkFs,
                    W,
                    D,
                    opts,
                ) as never;
            },
        );

        const inputs = await resolveDoctorWorkshopInputs(
            root,
            config,
            workshop,
        );
        expect(inputs.materialization.action).toBe('materialize');
        const failed = inputs.workshopLinks?.find((w) => w.item === itemName);
        expect(failed?.state).toBe('INSPECT_FAILED');
        expect(failed?.detail).toContain('EPERM');
        expect(failed?.vdfPath).toBe(join(dist, `${itemName}.workshop.vdf`));
    });
});
