import { describe, expect, it, vi } from 'vitest';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { NodeFileSystem } from '@pzstudio/platform-node';
import {
    runDoctor,
    workshopLinkDiagnostics,
    type DoctorInput,
    type WorkshopLinkCheckInput,
} from '@pzstudio/core';
import { writeOutputMarker, resolveBuildOutputPath } from '@pzstudio/core';
import {
    attachBuiltItems,
    workshopReadMarker,
} from '../../packages/cli/src/lib/linkStep';
import { resolveDoctorWorkshopInputs } from '../../packages/cli/src/lib/doctor';

function entry(
    overrides: Partial<WorkshopLinkCheckInput> = {},
): WorkshopLinkCheckInput {
    return { item: 'Item', state: 'ATTACHED_OK', ...overrides };
}

function makeConfig(distDir: string): unknown {
    return {
        workshop: { title: 'Item' },
        outdir: distDir,
        mods: { my_mod: {} },
    };
}

describe('workshopLinkDiagnostics (core mapping)', () => {
    it('maps every state to its code, severity, and action text', () => {
        const rows: Array<[string, string, string, string?]> = [
            // [state, expected code, expected severity, hint token]
            ['ATTACHED_OK', 'workshop-link.attached', 'info', undefined],
            [
                'MISSING_LINK',
                'workshop-link.missing',
                'warning',
                'pzstudio build',
            ],
            ['COPY_SLOT', 'workshop-link.copy-slot', 'info', undefined],
            [
                'HAND_MADE_DIR',
                'workshop-link.hand-made-dir',
                'warning',
                '--backup-existing-workshop',
            ],
            [
                'CONFLICT_REAL_DIR',
                'workshop-link.conflict-real-dir',
                'warning',
                '--backup-existing-workshop',
            ],
            ['FOREIGN_LINK', 'workshop-link.foreign', 'warning', '--relink'],
            ['DANGLING_LINK', 'workshop-link.dangling', 'warning', 'Rebuild'],
            [
                'UNOWNED_TARGET',
                'workshop-link.unowned',
                'warning',
                'ownership marker',
            ],
            [
                'NOT_DIRECTORY',
                'workshop-link.not-directory',
                'warning',
                undefined,
            ],
            [
                'IDENTITY_MISMATCH',
                'workshop-link.identity-mismatch',
                'warning',
                undefined,
            ],
            [
                'NON_LOCAL_TARGET',
                'workshop-link.non-local',
                'warning',
                'local disk',
            ],
            [
                'UNSUPPORTED_HOST',
                'workshop-link.unsupported-host',
                'info',
                undefined,
            ],
        ];
        const diagnostics = workshopLinkDiagnostics(
            rows.map(([state]) => entry({ state })),
        );
        expect(diagnostics).toHaveLength(rows.length);
        rows.forEach(([state, code, severity, hintToken], i) => {
            const d = diagnostics[i];
            expect(d.code).toBe(code);
            expect(d.severity).toBe(severity);
            expect(d.module).toBe('workshop-link');
            if (hintToken) {
                expect(d.hint).toBeTruthy();
                expect(d.hint!).toContain(hintToken);
            }
            expect(d.message).toContain('Item');
        });
    });

    it('NON_LOCAL_TARGET wording is fail-closed: no fallback/copy offer', () => {
        const [d] = workshopLinkDiagnostics([
            entry({ state: 'NON_LOCAL_TARGET' }),
        ]);
        expect(d.message).not.toMatch(/copy|fallback/i);
    });

    it('HAND_MADE_DIR advice sends the user OUT of the deployment root', () => {
        // A renamed folder INSIDE the deployment root still registers as a
        // duplicate mod (the game scans that folder), and in copy mode the
        // backup flag is inert — so the advice must say "out of the root"
        // and scope the flag to symlink mode.
        const [d] = workshopLinkDiagnostics([
            entry({ state: 'HAND_MADE_DIR' }),
        ]);
        expect(d.hint).toContain('OUT of the deployment root');
        expect(d.hint).toContain('duplicate mod');
        expect(d.hint).toContain('(symlink mode)');
    });

    it('ATTACHED_OK renders the copyable steamcmd command with the ABSOLUTE vdf path', () => {
        const vdfPath = resolve(
            join('E:', 'proj', 'dist', 'Item.workshop.vdf'),
        );
        const [d] = workshopLinkDiagnostics([
            entry({ state: 'ATTACHED_OK', vdfPath }),
        ]);
        expect(d.hint).toContain('steamcmd +login <user> +workshop_build_item');
        expect(d.hint).toContain(`"${vdfPath}"`);
        expect(vdfPath.includes('/')).toBe(false); // absolute Windows path shape
    });
});

describe('runDoctor materialization inputs (core rendering)', () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'pz-doc-core-'));
        // A loadable project: without it runDoctor early-returns the
        // "you are not in a project" fact and renders nothing else.
        writeFileSync(
            join(root, 'project.json'),
            JSON.stringify({
                schemaVersion: 2,
                title: 'Item',
                outdir: join(root, 'deploy'),
                workshop: { title: 'Item' },
                mods: { my_mod: {} },
            }),
        );
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const baseInput = (extra: Partial<DoctorInput>): DoctorInput => ({
        projectDir: root,
        capabilities: {} as DoctorInput['capabilities'],
        ...extra,
    });

    it('a skipped deployment renders exactly one OUTDIR_UNSET info (CI-legitimate)', async () => {
        const report = await runDoctor(
            new NodeFileSystem(),
            baseInput({
                materialization: { action: 'skip', mode: 'symlink' },
            }),
        );
        const unset = report.diagnostics.filter(
            (d) => d.code === 'OUTDIR_UNSET',
        );
        expect(unset).toHaveLength(1);
        expect(unset[0].severity).toBe('info');
        expect(unset[0].message).toContain('dist/ only');
    });

    it('an active materialization renders no OUTDIR_UNSET diagnostic', async () => {
        const report = await runDoctor(
            new NodeFileSystem(),
            baseInput({
                materialization: {
                    action: 'materialize',
                    mode: 'symlink',
                    outDir: 'C:/Users/u/Zomboid/Workshop',
                },
            }),
        );
        expect(
            report.diagnostics.filter((d) => d.code === 'OUTDIR_UNSET'),
        ).toHaveLength(0);
        expect(
            report.diagnostics.filter(
                (d) => d.code === 'MIGRATE_TO_DIST_MODEL',
            ),
        ).toHaveLength(0);
    });

    it('a non-local symlink target renders the fail-closed NON_LOCAL_TARGET diagnostic', async () => {
        const report = await runDoctor(
            new NodeFileSystem(),
            baseInput({
                materialization: {
                    action: 'materialize',
                    mode: 'symlink',
                    outDir: '\\\\server\\share\\Workshop',
                    targetNonLocal: true,
                },
            }),
        );
        const nonLocal = report.diagnostics.filter(
            (d) => d.code === 'workshop-link.non-local',
        );
        expect(nonLocal).toHaveLength(1);
        expect(nonLocal[0].message).not.toMatch(/copy|fallback/i);
    });
});

describe('resolveDoctorWorkshopInputs (CLI host computation)', () => {
    let root: string;
    let dist: string;
    let workshop: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'pz-doc-'));
        dist = join(root, 'dist');
        workshop = join(root, 'workshop');
        mkdirSync(dist, { recursive: true });
        mkdirSync(workshop, { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    async function seedBuiltMain(): Promise<string> {
        const config = makeConfig(dist) as Parameters<
            typeof resolveBuildOutputPath
        >[0];
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
        return itemDir;
    }

    it('symlink mode: computes the real slot state per existing item dir', async () => {
        const itemDir = await seedBuiltMain();
        await attachBuiltItems({
            projectRoot: root,
            outDir: dist,
            workshopRoot: workshop,
            itemNames: [basename(itemDir)],
            usage: { recordOp: vi.fn() },
            onSurface: () => {},
        });
        const config = makeConfig(dist);
        const inputs = await resolveDoctorWorkshopInputs(
            root,
            config as never,
            workshop,
        );
        expect(inputs.materialization.action).toBe('materialize');
        expect(inputs.materialization.mode).toBe('symlink');
        const main = inputs.workshopLinks?.find(
            (w) => w.item === basename(itemDir),
        );
        expect(main?.state).toBe('ATTACHED_OK');
        expect(main?.vdfPath).toBe(
            join(dist, `${basename(itemDir)}.workshop.vdf`),
        );
    });

    it('missing slot reports MISSING_LINK; a hand-made real dir reports HAND_MADE_DIR', async () => {
        const config = makeConfig(dist);
        const itemDir = await seedBuiltMain();
        // No slot at all: MISSING_LINK.
        const missing = await resolveDoctorWorkshopInputs(
            root,
            config as never,
            workshop,
        );
        expect(missing.workshopLinks?.[0]?.state).toBe('MISSING_LINK');

        // A real non-empty dir without a copy marker: HAND_MADE_DIR.
        const slot = join(workshop, basename(itemDir));
        await fsp.mkdir(slot, { recursive: true });
        writeFileSync(join(slot, 'handmade.txt'), 'x');
        const handmade = await resolveDoctorWorkshopInputs(
            root,
            config as never,
            workshop,
        );
        expect(handmade.workshopLinks?.[0]?.state).toBe('HAND_MADE_DIR');
    });

    it('a marker-owned copy slot reports COPY_SLOT', async () => {
        const config = makeConfig(dist) as Parameters<
            typeof resolveBuildOutputPath
        >[0];
        const itemDir = await seedBuiltMain();
        // A real directory with a matching copy marker: the copy
        // materializer's healthy state.
        const slot = join(workshop, basename(itemDir));
        await fsp.mkdir(slot, { recursive: true });
        writeFileSync(join(slot, 'workshop.txt'), 'title=Item\n');
        const { writeCopySlotMarker } = await import('@pzstudio/core');
        await writeCopySlotMarker(new NodeFileSystem(), {
            projectDir: root,
            itemId: basename(itemDir),
            slotDir: slot,
        });
        const inputs = await resolveDoctorWorkshopInputs(
            root,
            config as never,
            workshop,
        );
        expect(inputs.workshopLinks?.[0]?.state).toBe('COPY_SLOT');
    });

    it('no target configured: the decision is skip and no slot checks run', async () => {
        const config = makeConfig(dist);
        const inputs = await resolveDoctorWorkshopInputs(
            root,
            config as never,
            undefined,
        );
        expect(inputs.materialization.action).toBe('skip');
        expect(inputs.workshopLinks).toBeUndefined();
    });

    it('a non-local symlink target is detected fail-closed', async () => {
        const config = makeConfig(dist);
        const inputs = await resolveDoctorWorkshopInputs(
            root,
            config as never,
            '\\\\server\\share\\Workshop',
        );
        expect(inputs.materialization.targetNonLocal).toBe(true);
    });

    it('the machine-level flat materialize key wins over the symlink default (copy mode)', async () => {
        // The doctor reads the global config SILENTLY (R1) — this only
        // proves the value flows; the hard 'symlink' default applies when
        // the key is absent.
        const config = makeConfig(dist) as never as Parameters<
            typeof resolveBuildOutputPath
        >[0];
        const itemDir = await seedBuiltMain();
        const { writeCopySlotMarker } = await import('@pzstudio/core');
        // A copy-mode doctor sees a marker-owned slot where symlink mode
        // would see nothing: seed the slot as a copy slot.
        const slot = join(workshop, basename(itemDir));
        await fsp.mkdir(slot, { recursive: true });
        writeFileSync(join(slot, 'workshop.txt'), 'title=Item\n');
        await writeCopySlotMarker(new NodeFileSystem(), {
            projectDir: root,
            itemId: basename(itemDir),
            slotDir: slot,
        });
        const inputs = await resolveDoctorWorkshopInputs(
            root,
            { ...(config as never), build: { materialize: 'copy' } } as never,
            workshop,
        );
        expect(inputs.materialization.mode).toBe('copy');
        expect(inputs.workshopLinks?.[0]?.state).toBe('COPY_SLOT');
        // Sanity: the read marker helper stays shared with the build path.
        expect(workshopReadMarker).toBeTypeOf('function');
    });
});
