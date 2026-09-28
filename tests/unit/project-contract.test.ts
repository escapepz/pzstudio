import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NodeFileSystem } from '../../packages/platform-node/src/index';
import {
    PROJECT_SCHEMA_VERSION,
    ProjectParseError,
    ProjectValidationError,
    ProjectVersionError,
    detectVersion,
    loadProject,
    migrateProject,
    saveProject,
    type DirectoryEntry,
    type FileStat,
    type ProjectFileSystem,
} from '../../packages/core/src/index';

/**
 * In-memory ProjectFileSystem: doubles as a fake host for the architecture
 * contract — core APIs must run against this without any node filesystem.
 */
class MemoryFileSystem implements ProjectFileSystem {
    files = new Map<string, Uint8Array>();

    async read(uri: string): Promise<Uint8Array> {
        const data = this.files.get(uri);
        if (data === undefined) throw new Error(`ENOENT: ${uri}`);
        return data;
    }

    async write(uri: string, data: Uint8Array): Promise<void> {
        this.files.set(uri, data);
    }

    async delete(uri: string): Promise<void> {
        this.files.delete(uri);
        for (const key of [...this.files.keys()]) {
            if (key.startsWith(`${uri}/`)) this.files.delete(key);
        }
    }

    async stat(uri: string): Promise<FileStat> {
        if (this.files.has(uri)) {
            return {
                type: 'file',
                ctime: 0,
                mtime: 0,
                size: this.files.get(uri)!.length,
            };
        }
        throw new Error(`ENOENT: ${uri}`);
    }

    async list(): Promise<DirectoryEntry[]> {
        return [];
    }
}

const CONFIG_URI = 'mem://project/project.json';

function validConfig() {
    return {
        workshop: {
            id: 12345,
            title: 'Test Project',
            visibility: 'public',
            tags: ['Build 42'],
        },
        mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
        excludes: [],
        outdir: '/out',
    };
}

async function writeJson(
    fs: MemoryFileSystem,
    uri: string,
    content: unknown,
): Promise<void> {
    await fs.write(uri, new TextEncoder().encode(JSON.stringify(content)));
}

describe('project.json contract (core)', () => {
    describe('detectVersion (pure)', () => {
        it('treats a missing or non-numeric schemaVersion as version 1', () => {
            expect(detectVersion({})).toBe(1);
            expect(detectVersion({ schemaVersion: '2' })).toBe(1);
            expect(detectVersion(null)).toBe(1);
        });

        it('reads the version when it is a number', () => {
            expect(detectVersion({ schemaVersion: 2 })).toBe(2);
        });
    });

    describe('migrateProject (pure)', () => {
        it('stamps the current version onto a versionless config', () => {
            const result = migrateProject(validConfig());

            expect(result.fromVersion).toBe(1);
            expect(result.toVersion).toBe(PROJECT_SCHEMA_VERSION);
            expect(result.migrations).toEqual([]);
            expect(result.config.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
        });

        it('applies the legacy shape migration before stamping', () => {
            const legacy = {
                ...validConfig(),
                title: 'Old Root Title', // deprecated root field
            };

            const result = migrateProject(legacy);

            expect(result.fromVersion).toBe(1);
            expect(result.migrations).toHaveLength(1);
            // workshop.title was already set, so it wins over the root relic
            expect(result.config.workshop.title).toBe('Test Project');
            expect('title' in result.config).toBe(false);
            expect(result.config.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
        });

        it('keeps an explicit schemaVersion 2 untouched', () => {
            const current = { ...validConfig(), schemaVersion: 2 };

            const result = migrateProject(current);

            expect(result.fromVersion).toBe(2);
            expect(result.migrations).toEqual([]);
            expect(result.config).toEqual(current);
        });

        it('throws ProjectVersionError for a newer schema version', () => {
            expect(() => migrateProject({ schemaVersion: 99 })).toThrow(
                ProjectVersionError,
            );
        });
    });

    describe('loadProject (injected filesystem)', () => {
        it('loads, validates and normalizes a valid config', async () => {
            const fs = new MemoryFileSystem();
            await writeJson(fs, CONFIG_URI, validConfig());

            const project = await loadProject(fs, CONFIG_URI);

            expect(project.uri).toBe(CONFIG_URI);
            expect(project.version).toBe(PROJECT_SCHEMA_VERSION);
            expect(project.migrations).toBeUndefined();
            // normalize: poster/icon defaults materialized
            expect(project.config.mods.my_mod.poster).toBe('poster.png');
            expect(project.config.mods.my_mod.icon).toBe('icon.png');
        });

        it('reports applied migrations on a legacy file', async () => {
            const fs = new MemoryFileSystem();
            await writeJson(fs, CONFIG_URI, {
                ...validConfig(),
                authors: ['legacy'],
            });

            const project = await loadProject(fs, CONFIG_URI);

            expect(project.migrations).toHaveLength(1);
        });

        it('throws ProjectParseError for invalid JSON', async () => {
            const fs = new MemoryFileSystem();
            await fs.write(CONFIG_URI, new TextEncoder().encode('{ not json'));

            await expect(loadProject(fs, CONFIG_URI)).rejects.toThrow(
                ProjectParseError,
            );
        });

        it('throws ProjectParseError when the file cannot be read', async () => {
            const fs = new MemoryFileSystem();

            await expect(loadProject(fs, CONFIG_URI)).rejects.toThrow(
                ProjectParseError,
            );
        });

        it('throws ProjectVersionError for a future schema version', async () => {
            const fs = new MemoryFileSystem();
            await writeJson(fs, CONFIG_URI, {
                ...validConfig(),
                schemaVersion: 99,
            });

            await expect(loadProject(fs, CONFIG_URI)).rejects.toThrow(
                ProjectVersionError,
            );
        });

        it('throws ProjectValidationError with formatted errors on invalid content', async () => {
            const fs = new MemoryFileSystem();
            await writeJson(fs, CONFIG_URI, { mods: {} });

            await expect(loadProject(fs, CONFIG_URI)).rejects.toThrow(
                ProjectValidationError,
            );
        });
    });

    describe('saveProject (injected filesystem)', () => {
        it('stamps the current schemaVersion and round-trips through loadProject', async () => {
            const fs = new MemoryFileSystem();
            const config = validConfig() as never;

            await saveProject(fs, CONFIG_URI, config);
            const written = JSON.parse(
                new TextDecoder('utf-8').decode(await fs.read(CONFIG_URI)),
            );
            expect(written.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);

            const reloaded = await loadProject(fs, CONFIG_URI);
            expect(reloaded.config.workshop.title).toBe('Test Project');
        });

        it('preserves unknown fields on save', async () => {
            const fs = new MemoryFileSystem();
            await saveProject(fs, CONFIG_URI, {
                ...validConfig(),
                customFutureField: 'kept',
            } as never);

            const written = JSON.parse(
                new TextDecoder('utf-8').decode(await fs.read(CONFIG_URI)),
            );
            expect(written.customFutureField).toBe('kept');
        });
    });

    describe('NodeFileSystem integration (real files)', () => {
        let tempDir: string;

        beforeEach(() => {
            tempDir = mkdtempSync(join(tmpdir(), 'pzstudio-contract-'));
        });

        afterEach(() => {
            rmSync(tempDir, { recursive: true, force: true });
        });

        it('loads and saves a project.json on disk via file:// URIs', async () => {
            const fs = new NodeFileSystem();
            const uri = `file:///${join(tempDir, 'project.json').replace(/\\/g, '/')}`;
            await saveProject(fs, uri, validConfig() as never);

            const reloaded = await loadProject(fs, uri);
            expect(reloaded.config.workshop.id).toBe(12345);
            expect(reloaded.version).toBe(PROJECT_SCHEMA_VERSION);
        });
    });
});
