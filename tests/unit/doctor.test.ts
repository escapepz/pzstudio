import { describe, it, expect } from 'vitest';
import { MemoryFileSystem } from '../helpers/memory-file-system';
import { NODE_CAPABILITIES } from '../../packages/platform-node/src/index';
// Import the capabilities module directly: the platform-web barrel pulls in
// the 'vscode' module, which only resolves inside an editor host.
import { WEB_CAPABILITIES } from '../../packages/platform-web/src/web-capabilities';
import {
    DoctorInput,
    DoctorReport,
    matchBuildCompatibility,
    runDoctor,
} from '../../packages/core/src/index';

const enc = new TextEncoder();
const ROOT = 'mem://proj';
const OUT = 'mem://out';
const TEMPLATE_DIR = 'mem://templates/tpl';

async function seed(
    fs: MemoryFileSystem,
    files: Record<string, string>,
): Promise<void> {
    for (const [uri, content] of Object.entries(files)) {
        await fs.write(uri, enc.encode(content));
    }
}

function projectJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        workshop: {
            id: 12345,
            title: 'Test Project',
            visibility: 'public',
            tags: ['Build 42'],
        },
        mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
        excludes: [],
        schemaVersion: 2,
        ...overrides,
    });
}

/** A fully healthy project: every doctor check passes on it. */
async function seedHealthy(fs: MemoryFileSystem): Promise<void> {
    await seed(fs, {
        [`${ROOT}/project.json`]: projectJson(),
        [`${ROOT}/workshop/description.txt`]: 'A description',
        [`${ROOT}/workshop/preview.png`]: 'png-bytes',
        [`${ROOT}/my_mod/42/mod.info`]: 'id=my_mod\nname=My Mod',
        [`${ROOT}/my_mod/42/media/lua/shared.lua`]: '-- lua',
        [`${OUT}/keep.txt`]: 'x',
        [`${TEMPLATE_DIR}/manifest.json`]: '{}',
    });
}

function doctor(
    fs: MemoryFileSystem,
    overrides: Partial<DoctorInput> = {},
): Promise<DoctorReport> {
    return runDoctor(fs, {
        projectDir: ROOT,
        outDir: OUT,
        templateDir: TEMPLATE_DIR,
        templateName: 'workshop-template',
        capabilities: NODE_CAPABILITIES,
        ...overrides,
    });
}

function codes(report: DoctorReport): string[] {
    return report.diagnostics.map((d) => d.code);
}

function ofCode(report: DoctorReport, code: string) {
    return report.diagnostics.filter((d) => d.code === code);
}

describe('matchBuildCompatibility', () => {
    it('matches wildcard major lines and pinned minors', () => {
        expect(matchBuildCompatibility('42.x', '42.20.1')).toBe(true);
        expect(matchBuildCompatibility('42.x', '43.0.0')).toBe(false);
        expect(matchBuildCompatibility('42.2', '42.2.5')).toBe(true);
        expect(matchBuildCompatibility('42.2', '42.3.0')).toBe(false);
        expect(matchBuildCompatibility('*', '41.5.0')).toBe(true);
    });

    it('returns undefined when the pair cannot be judged', () => {
        expect(matchBuildCompatibility('42.x', 'not-a-build')).toBe(undefined);
        expect(matchBuildCompatibility('future.x', '42.2.0')).toBe(undefined);
        expect(matchBuildCompatibility('42.2', '42')).toBe(undefined);
        expect(matchBuildCompatibility('', '42.2.0')).toBe(undefined);
    });
});

describe('runDoctor', () => {
    it('reports nothing on a healthy project', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        const report = await doctor(fs);
        expect(report.diagnostics).toEqual([]);
        expect(report.project?.version).toBe(2);
    });

    it('errors when there is no project.json', async () => {
        const fs = new MemoryFileSystem();
        const report = await doctor(fs);
        expect(codes(report)).toEqual(['project.missing']);
        expect(report.diagnostics[0].severity).toBe('error');
        expect(report.project).toBeUndefined();
    });

    it('maps a broken JSON file to project.parse', async () => {
        const fs = new MemoryFileSystem();
        await seed(fs, { [`${ROOT}/project.json`]: '{ not json' });
        const report = await doctor(fs, {
            outDir: undefined,
            templateDir: undefined,
        });
        expect(codes(report)).toEqual(['project.parse']);
        expect(report.diagnostics[0].severity).toBe('error');
    });

    it('maps validation failures to project.validation', async () => {
        const fs = new MemoryFileSystem();
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson({
                workshop: {
                    id: 1,
                    title: 'T',
                    visibility: 'bananas',
                    tags: [],
                },
            }),
        });
        const report = await doctor(fs, {
            outDir: undefined,
            templateDir: undefined,
        });
        expect(codes(report)).toEqual(['project.validation']);
        expect(report.diagnostics[0].message).toContain('visibility');
    });

    it('maps an unsupported future schemaVersion to project.version', async () => {
        const fs = new MemoryFileSystem();
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson({ schemaVersion: 99 }),
        });
        const report = await doctor(fs, {
            outDir: undefined,
            templateDir: undefined,
        });
        expect(codes(report)).toEqual(['project.version']);
        expect(report.diagnostics[0].hint).toContain('Upgrade');
    });

    it('reports an in-memory legacy migration as info', async () => {
        const fs = new MemoryFileSystem();
        await seed(fs, {
            [`${ROOT}/project.json`]: JSON.stringify({
                id: 999,
                workshop: {
                    title: 'Legacy',
                    visibility: 'public',
                    tags: [],
                },
                mods: { m: { name: 'M', description: 'd' } },
            }),
        });
        const report = await doctor(fs);
        expect(codes(report)).toContain('project.migrated');
        expect(report.project?.version).toBe(2);
    });

    it('flags missing workshop description (warning) and preview (info)', async () => {
        const fs = new MemoryFileSystem();
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson(),
            [`${ROOT}/my_mod/42/media/lua/shared.lua`]: '-- lua',
        });
        const report = await doctor(fs);
        expect(ofCode(report, 'project.noDescription')[0].severity).toBe(
            'warning',
        );
        expect(ofCode(report, 'project.noPreview')[0].severity).toBe('info');
    });

    it('reports web capabilities as environment infos', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        const report = await doctor(fs, { capabilities: WEB_CAPABILITIES });
        expect(ofCode(report, 'environment.noShell')).toHaveLength(1);
        expect(ofCode(report, 'environment.noWorkshopOutput')).toHaveLength(1);
    });

    it('treats a missing output directory as informational', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        const report = await doctor(fs, { outDir: 'mem://not-built-yet' });
        const d = ofCode(report, 'filesystem.outDirMissing')[0];
        expect(d.severity).toBe('info');
        expect(d.message).toContain('not-built-yet');
    });

    it('errors when the output path is a file', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        const report = await doctor(fs, { outDir: `${OUT}/keep.txt` });
        expect(ofCode(report, 'filesystem.outDirNotDirectory')).toHaveLength(1);
    });

    it('warns when the output directory sits inside the project', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        await seed(fs, { [`${ROOT}/nested-out/keep.txt`]: 'x' });
        const report = await doctor(fs, { outDir: `${ROOT}/nested-out` });
        expect(ofCode(report, 'filesystem.outDirInsideProject')).toHaveLength(
            1,
        );
    });

    it('informs when the configured template cache is missing', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        const report = await doctor(fs, {
            templateDir: 'mem://templates/gone',
        });
        const d = ofCode(report, 'templates.notCached')[0];
        expect(d.severity).toBe('info');
        expect(d.message).toContain('workshop-template');
    });

    it('errors for included mods missing on disk, warns for excluded ones', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson({
                mods: {
                    my_mod: { name: 'My Mod', description: 'A mod.' },
                    vanished: { name: 'Vanished', description: 'gone' },
                    ghosted: {
                        name: 'Ghosted',
                        description: 'gone too',
                    },
                },
                excludes: ['ghosted'],
            }),
        });
        const report = await doctor(fs);
        const missing = ofCode(report, 'mods.missing');
        expect(missing).toHaveLength(2);
        expect(
            missing.find((d) => d.message.includes('vanished'))?.severity,
        ).toBe('error');
        expect(
            missing.find((d) => d.message.includes('ghosted'))?.severity,
        ).toBe('warning');
    });

    it('errors for a mod without a Build 42 branch folder', async () => {
        const fs = new MemoryFileSystem();
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson({
                mods: { bare: { name: 'Bare', description: 'd' } },
            }),
            [`${ROOT}/bare/notes.txt`]: 'no media here',
        });
        const report = await doctor(fs);
        const d = ofCode(report, 'mods.noBranch')[0];
        expect(d.severity).toBe('error');
        expect(d.message).toContain('bare');
    });

    it('warns when build.modInfo is skip and no branch has mod.info', async () => {
        const fs = new MemoryFileSystem();
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson({
                mods: {
                    skipmod: {
                        name: 'Skipmod',
                        description: 'd',
                        build: { modInfo: 'skip' },
                    },
                },
            }),
            [`${ROOT}/skipmod/42/media/lua/a.lua`]: '-- lua',
        });
        const report = await doctor(fs);
        expect(ofCode(report, 'mods.noModInfo')).toHaveLength(1);
    });

    it('does not flag missing mod.info when builds may generate it', async () => {
        const fs = new MemoryFileSystem();
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson(),
            [`${ROOT}/my_mod/42/media/lua/shared.lua`]: '-- lua',
        });
        const report = await doctor(fs);
        expect(codes(report)).not.toContain('mods.noModInfo');
    });

    it('warns about mods that are both dev-only and excluded', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson({
                mods: {
                    my_mod: { name: 'My Mod', description: 'A mod.' },
                    dual: {
                        name: 'Dual',
                        description: 'd',
                        build: { devOnly: true },
                    },
                },
                excludes: ['dual'],
            }),
        });
        const report = await doctor(fs);
        expect(ofCode(report, 'mods.devOnlyAndExcluded')).toHaveLength(1);
    });

    it('warns about excludes entries without a matching mod', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson({ excludes: ['ghost'] }),
        });
        const report = await doctor(fs);
        expect(ofCode(report, 'mods.unknownExclude')).toHaveLength(1);
    });

    it('warns when the project declares no mods at all', async () => {
        const fs = new MemoryFileSystem();
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson({ mods: {} }),
            [`${ROOT}/workshop/description.txt`]: 'A description',
            [`${ROOT}/workshop/preview.png`]: 'png-bytes',
        });
        const report = await doctor(fs);
        expect(ofCode(report, 'mods.none')).toHaveLength(1);
    });

    it('warns when no mod qualifies for the production output', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson({
                mods: {
                    my_mod: {
                        name: 'My Mod',
                        description: 'A mod.',
                        build: { devOnly: true },
                    },
                },
            }),
        });
        const report = await doctor(fs);
        expect(ofCode(report, 'buildTarget.noProduction')).toHaveLength(1);
        expect(codes(report)).not.toContain('buildTarget.noDevelopment');
    });

    it('warns when the game build falls outside pzBuildCompatibility', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson({
                pzBuildCompatibility: '42.x',
            }),
        });
        const mismatch = await doctor(fs, { gameBuild: '43.1.0' });
        expect(ofCode(mismatch, 'buildTarget.compatibility')).toHaveLength(1);

        const match = await doctor(fs, { gameBuild: '42.20.1' });
        expect(codes(match)).not.toContain('buildTarget.compatibility');

        // No game build passed: nothing to compare against.
        const silent = await doctor(fs);
        expect(codes(silent)).not.toContain('buildTarget.compatibility');
    });

    it('informs about development-only default targets', async () => {
        const fs = new MemoryFileSystem();
        await seedHealthy(fs);
        await seed(fs, {
            [`${ROOT}/project.json`]: projectJson({
                build: { target: 'development' },
            }),
        });
        const report = await doctor(fs);
        const d = ofCode(report, 'buildTarget.developmentOnly')[0];
        expect(d.severity).toBe('info');
    });

    it('groups diagnostics in the fixed module order', async () => {
        const fs = new MemoryFileSystem();
        // Invalid project + web capabilities + missing template: three
        // modules report, and the report must still be deterministic.
        await seed(fs, { [`${ROOT}/project.json`]: '{ broken' });
        const report = await doctor(fs, {
            capabilities: WEB_CAPABILITIES,
            templateDir: 'mem://templates/gone',
            outDir: undefined,
        });
        expect(codes(report)).toEqual([
            'project.parse',
            'environment.noWorkshopOutput',
            'environment.noShell',
            'templates.notCached',
        ]);
    });
});
