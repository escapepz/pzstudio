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
    resolveDistModel,
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

describe('runDoctor dist-model inputs (core rendering)', () => {
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
                outdir: join(root, 'dist'),
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

    it('legacy mode renders exactly one MIGRATE_TO_DIST_MODEL diagnostic with the concrete edit', async () => {
        const report = await runDoctor(
            new NodeFileSystem(),
            baseInput({
                distModel: {
                    mode: 'legacy',
                    outDir: 'E:/workshop',
                    workshopRoot: 'C:/Users/u/Zomboid/Workshop',
                },
            }),
        );
        const migrates = report.diagnostics.filter(
            (d) => d.code === 'MIGRATE_TO_DIST_MODEL',
        );
        expect(migrates).toHaveLength(1);
        expect(migrates[0].severity).toBe('warning');
        expect(migrates[0].message).toContain('"outdir"');
        expect(migrates[0].message).toContain('C:/Users/u/Zomboid/Workshop');
    });

    it('dist mode renders no MIGRATE diagnostic', async () => {
        const report = await runDoctor(
            new NodeFileSystem(),
            baseInput({
                distModel: {
                    mode: 'dist',
                    outDir: 'E:/proj/dist',
                    workshopRoot: 'C:/Users/u/Zomboid/Workshop',
                },
            }),
        );
        expect(
            report.diagnostics.filter(
                (d) => d.code === 'MIGRATE_TO_DIST_MODEL',
            ),
        ).toHaveLength(0);
    });

    it('non-local workshop root renders the fail-closed NON_LOCAL_TARGET diagnostic', async () => {
        const report = await runDoctor(
            new NodeFileSystem(),
            baseInput({
                distModel: {
                    mode: 'dist',
                    outDir: 'E:/proj/dist',
                    workshopRoot: '\\\\server\\share\\Workshop',
                },
                workshopRootNonLocal: true,
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

    async function seedAttachedMain(): Promise<string> {
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
        await attachBuiltItems({
            projectRoot: root,
            outDir: dist,
            workshopRoot: workshop,
            itemNames: [basename(itemDir)],
            usage: { recordOp: vi.fn() },
            onSurface: () => {},
        });
        return itemDir;
    }

    it('dist mode: computes the real link state per existing item dir', async () => {
        const itemDir = await seedAttachedMain();
        const config = makeConfig(dist);
        const inputs = await resolveDoctorWorkshopInputs(
            root,
            config as never,
            workshop,
        );
        expect(inputs.distModel?.mode).toBe('dist');
        const main = inputs.workshopLinks?.find(
            (w) => w.item === basename(itemDir),
        );
        expect(main?.state).toBe('ATTACHED_OK');
        expect(main?.vdfPath).toBe(
            join(dist, `${basename(itemDir)}.workshop.vdf`),
        );
    });

    it('missing slot reports MISSING_LINK; a real dir reports CONFLICT_REAL_DIR', async () => {
        const config = makeConfig(dist);
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
        // No junction: MISSING_LINK.
        const missing = await resolveDoctorWorkshopInputs(
            root,
            config as never,
            workshop,
        );
        expect(missing.workshopLinks?.[0]?.state).toBe('MISSING_LINK');

        // A real non-empty dir occupies the slot: CONFLICT_REAL_DIR.
        const slot = join(workshop, basename(itemDir));
        await fsp.mkdir(slot, { recursive: true });
        writeFileSync(join(slot, 'handmade.txt'), 'x');
        const conflict = await resolveDoctorWorkshopInputs(
            root,
            config as never,
            workshop,
        );
        expect(conflict.workshopLinks?.[0]?.state).toBe('CONFLICT_REAL_DIR');
    });

    it('legacy mode: no per-item links, one distModel legacy entry', async () => {
        const outside = mkdtempSync(join(tmpdir(), 'pz-doc-out-'));
        try {
            const config = makeConfig(join(outside, 'out'));
            const inputs = await resolveDoctorWorkshopInputs(
                root,
                config as never,
                workshop,
            );
            expect(inputs.distModel?.mode).toBe('legacy');
            expect(inputs.workshopLinks ?? []).toHaveLength(0);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it('non-local workshop root is detected fail-closed', async () => {
        const config = makeConfig(dist);
        const inputs = await resolveDoctorWorkshopInputs(
            root,
            config as never,
            '\\\\server\\share\\Workshop',
        );
        expect(inputs.workshopRootNonLocal).toBe(true);
    });
});
