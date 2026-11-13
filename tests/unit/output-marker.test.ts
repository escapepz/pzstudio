import { describe, it, expect } from 'vitest';
import { MemoryFileSystem } from '../helpers/memory-file-system';
import type { ProjectFileSystem } from '@pzstudio/platform';
import {
    BuildSession,
    BuildSessionHost,
} from '../../packages/core/src/buildsession';
import type { PlanBuildInput } from '../../packages/core/src/buildplan';
import type { IProjectConfig } from '../../packages/core/src/project';
import {
    OUTPUT_MARKER_FILENAME,
    markerPath,
    computeProjectId,
    buildOutputMarker,
    readOutputMarker,
} from '../../packages/core/src/output-marker';

const TEMPLATE_DIR = '/templates/workshop';
const PROJECT_DIR = '/proj';
const OUT_DIR = '/out';
const MAIN_OUT = `${OUT_DIR}/Sync Project`;
const DEV_OUT = `${OUT_DIR}/Sync Project - dev_branch`;
const MAIN_MARKER = `${MAIN_OUT}/.pzstudio-output.json`;
const DEV_MARKER = `${DEV_OUT}/.pzstudio-output.json`;

function baseConfig(): IProjectConfig {
    return {
        workshop: {
            id: 12345,
            title: 'Sync Project',
            visibility: 'public',
            tags: [],
        },
        mods: {
            my_mod: { name: 'My Mod', description: 'A mod.' },
            dev_mod: {
                name: 'Dev Mod',
                description: 'd',
                build: { devOnly: true },
            } as never,
        },
        excludes: [],
        outdir: OUT_DIR,
    } as unknown as IProjectConfig;
}

/**
 * A fake session host: getPlanInput() reads the same facts the CLI's build
 * command reads (mod.info presence/content, branch folders, workshop
 * metadata) — but through the injected memory filesystem. Mirrors the
 * host factory in buildsession.test.ts, plus the engineVersion seam the
 * output marker consumes.
 */
function createHost(
    fs: MemoryFileSystem,
    config: IProjectConfig,
    engineVersion?: string,
): BuildSessionHost {
    const holder = { config };
    const host: BuildSessionHost = {
        fs,
        getPlanInput: async (): Promise<Omit<PlanBuildInput, 'variant'>> => {
            const modSourceStates: PlanBuildInput['modSourceStates'] = {};
            for (const modId of Object.keys(holder.config.mods)) {
                const state = {
                    branchFolders: [] as string[],
                    modInfoExists: {} as Record<string, boolean>,
                    modInfoContent: {} as Record<string, string | undefined>,
                };
                state.modInfoExists[''] = false;
                state.modInfoContent[''] = undefined;
                try {
                    state.modInfoContent[''] = await fs.readText(
                        `${PROJECT_DIR}/${modId}/mod.info`,
                    );
                    state.modInfoExists[''] = true;
                } catch {
                    // no root mod.info
                }
                modSourceStates[modId] = state;
            }
            return {
                config: holder.config,
                workshopTemplateDir: TEMPLATE_DIR,
                projectDir: PROJECT_DIR,
                modSourceStates,
                descriptionLines: [],
                previewPngExists: false,
            };
        },
    };
    if (engineVersion !== undefined) {
        host.engineVersion = engineVersion;
    }
    return host;
}

async function seedProject(
    fs: MemoryFileSystem,
    config: IProjectConfig,
): Promise<void> {
    await fs.writeText(`${PROJECT_DIR}/project.json`, JSON.stringify(config));
    await fs.writeText(
        `${TEMPLATE_DIR}/Contents/template-file.txt`,
        'template',
    );
    await fs.writeText(
        `${PROJECT_DIR}/my_mod/media/lua/shared/hello.lua`,
        'print("v1")',
    );
    await fs.writeText(
        `${PROJECT_DIR}/dev_mod/media/lua/dev.lua`,
        'print("dev")',
    );
}

/** Wraps a fs so every write's target URI is recorded (order-preserving). */
function recordingFs(fs: ProjectFileSystem): {
    fs: ProjectFileSystem;
    writes: string[];
} {
    const writes: string[] = [];
    return {
        writes,
        fs: {
            read: (uri) => fs.read(uri),
            write: async (uri, data) => {
                writes.push(uri);
                await fs.write(uri, data);
            },
            delete: (uri, options) => fs.delete(uri, options),
            stat: (uri) => fs.stat(uri),
            list: (uri) => fs.list(uri),
        },
    };
}

describe('markerPath', () => {
    it('appends the marker filename to the item directory', () => {
        expect(OUTPUT_MARKER_FILENAME).toBe('.pzstudio-output.json');
        expect(markerPath('/out/Sync Project')).toBe(
            '/out/Sync Project/.pzstudio-output.json',
        );
    });

    it('normalizes trailing separators of the item directory', () => {
        expect(markerPath('/out/Sync Project/')).toBe(
            '/out/Sync Project/.pzstudio-output.json',
        );
    });
});

describe('computeProjectId', () => {
    it('returns 16 lowercase hex characters, deterministically', async () => {
        const id = await computeProjectId(PROJECT_DIR);
        expect(id).toMatch(/^[0-9a-f]{16}$/);
        expect(await computeProjectId(PROJECT_DIR)).toBe(id);
    });

    it('differs for different project roots', async () => {
        const a = await computeProjectId('/proj');
        const b = await computeProjectId('/other');
        expect(a).not.toBe(b);
    });

    it('is stable across path spellings (separators, trailing slash, drive case)', async () => {
        const canonical = await computeProjectId('/proj');
        expect(await computeProjectId('/proj/')).toBe(canonical);
        expect(await computeProjectId('c:\\Proj')).toBe(
            await computeProjectId('C:/Proj'),
        );
    });
});

describe('readOutputMarker', () => {
    it('returns undefined for an absent marker (never throws)', async () => {
        const fs = new MemoryFileSystem();
        expect(
            await readOutputMarker(fs, markerPath('/out/Item')),
        ).toBeUndefined();
    });

    it('returns undefined for unparseable content (never throws)', async () => {
        const fs = new MemoryFileSystem();
        await fs.writeText('/out/Item/.pzstudio-output.json', '{ not json');
        expect(
            await readOutputMarker(fs, '/out/Item/.pzstudio-output.json'),
        ).toBeUndefined();
    });

    it('returns undefined for non-object JSON, and the parsed marker otherwise', async () => {
        const fs = new MemoryFileSystem();
        await fs.writeText('/out/Item/.pzstudio-output.json', 'null');
        expect(
            await readOutputMarker(fs, '/out/Item/.pzstudio-output.json'),
        ).toBeUndefined();

        const marker = await buildOutputMarker({
            config: baseConfig(),
            variant: 'main',
            projectDir: PROJECT_DIR,
            engineVersion: '42.22.0',
        });
        await fs.writeText(
            '/out/Item/.pzstudio-output.json',
            JSON.stringify(marker),
        );
        expect(
            await readOutputMarker(fs, '/out/Item/.pzstudio-output.json'),
        ).toEqual(marker);
    });
});

describe('BuildSession writes the per-item output marker', () => {
    it('writes a marker for each built item (main + dev_branch) after the plan completes', async () => {
        const fs = new MemoryFileSystem();
        const config = baseConfig();
        await seedProject(fs, config);
        const session = new BuildSession(createHost(fs, config, '42.22.0'));
        await session.start(['main', 'development']);

        const main = await readOutputMarker(fs, MAIN_MARKER);
        const dev = await readOutputMarker(fs, DEV_MARKER);
        expect(main).toBeDefined();
        expect(dev).toBeDefined();

        // Exact schema shape (Task 3 interface): 7 fields, fixed values.
        expect(Object.keys(main!).sort()).toEqual(
            [
                'createdAt',
                'engine',
                'engineVersion',
                'itemTitle',
                'mods',
                'projectId',
                'schemaVersion',
            ].sort(),
        );
        expect(main!.schemaVersion).toBe(1);
        expect(main!.engine).toBe('pzstudio');
        expect(main!.engineVersion).toBe('42.22.0');
        expect(main!.itemTitle).toBe('Sync Project');
        expect(main!.mods).toEqual(['my_mod']);
        expect(main!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(Number.isNaN(Date.parse(main!.createdAt))).toBe(false);

        // The development item carries the suffixed title and the suffixed
        // mod ids (dev-only mod included, main-only mod excluded).
        expect(dev!.itemTitle).toBe('Sync Project - dev_branch');
        expect(dev!.mods).toEqual(['my_mod_dev', 'dev_mod_dev']);
        expect(dev!.schemaVersion).toBe(1);
        expect(dev!.engine).toBe('pzstudio');
        expect(dev!.engineVersion).toBe('42.22.0');
    });

    it('records the hashed project root as projectId', async () => {
        const fs = new MemoryFileSystem();
        const config = baseConfig();
        await seedProject(fs, config);
        const session = new BuildSession(createHost(fs, config, '42.22.0'));
        await session.start(['main', 'development']);

        const main = await readOutputMarker(fs, MAIN_MARKER);
        expect(main!.projectId).toBe(await computeProjectId(PROJECT_DIR));
        const dev = await readOutputMarker(fs, DEV_MARKER);
        expect(dev!.projectId).toBe(await computeProjectId(PROJECT_DIR));
    });

    it('records engineVersion as unknown when the host provides none', async () => {
        const fs = new MemoryFileSystem();
        const config = baseConfig();
        await seedProject(fs, config);
        const session = new BuildSession(createHost(fs, config));
        await session.start(['main']);
        const main = await readOutputMarker(fs, MAIN_MARKER);
        expect(main!.engineVersion).toBe('unknown');
    });

    it('writes via a tmp name that is cleaned up (atomic-write shape)', async () => {
        const fs = new MemoryFileSystem();
        const config = baseConfig();
        await seedProject(fs, config);
        const host = createHost(fs, config, '42.22.0');
        const { fs: wrapped, writes } = recordingFs(host.fs);
        const session = new BuildSession({ ...host, fs: wrapped });
        await session.start(['main']);

        const finalPath = markerPath(MAIN_OUT);
        const tmpPath = `${finalPath}.tmp`;
        expect(writes).toContain(tmpPath);
        expect(writes).toContain(finalPath);
        // The tmp copy never survives the completed write.
        await expect(fs.read(tmpPath)).rejects.toThrow();
    });

    it('is idempotent on rebuild: byte-identical content except createdAt', async () => {
        const fs = new MemoryFileSystem();
        const config = baseConfig();
        await seedProject(fs, config);
        const host = createHost(fs, config, '42.22.0');
        const { fs: wrapped, writes } = recordingFs(host.fs);
        const session = new BuildSession({ ...host, fs: wrapped });
        await session.start(['main', 'development']);
        const first = await readOutputMarker(fs, MAIN_MARKER);
        const firstDev = await readOutputMarker(fs, DEV_MARKER);
        expect(first).toBeDefined();
        expect(firstDev).toBeDefined();

        await session.rebuild();

        // The marker was rewritten for each item (one write per item build).
        const finalPath = markerPath(MAIN_OUT);
        expect(writes.filter((uri) => uri === finalPath).length).toBe(2);

        const second = await readOutputMarker(fs, MAIN_MARKER);
        const secondDev = await readOutputMarker(fs, DEV_MARKER);
        const { createdAt: _a, ...firstRest } = first!;
        const { createdAt: _b, ...secondRest } = second!;
        expect(secondRest).toEqual(firstRest);
        const { createdAt: _c, ...firstDevRest } = firstDev!;
        const { createdAt: _d, ...secondDevRest } = secondDev!;
        expect(secondDevRest).toEqual(firstDevRest);
    });

    it('is written once per item build: incremental sync never clobbers it', async () => {
        const fs = new MemoryFileSystem();
        const config = baseConfig();
        await seedProject(fs, config);
        const session = new BuildSession(createHost(fs, config, '42.22.0'));
        await session.start(['main', 'development']);
        const before = await readOutputMarker(fs, MAIN_MARKER);

        const result = await session.apply([
            {
                type: 'change',
                path: `${PROJECT_DIR}\\my_mod\\media\\lua\\shared\\hello.lua`,
            },
        ]);
        expect(result.errors).toEqual([]);

        const after = await readOutputMarker(fs, MAIN_MARKER);
        // Byte-identical INCLUDING createdAt: the incremental path does not
        // rewrite the marker ("once per item build").
        expect(after).toEqual(before);
    });
});
