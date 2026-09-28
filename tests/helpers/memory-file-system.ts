import type {
    DirectoryEntry,
    FileStat,
    ProjectFileSystem,
} from '../../packages/core/src/index';

/**
 * In-memory ProjectFileSystem: doubles as a fake host for architecture
 * tests — core APIs must run against this without any node filesystem.
 */
export class MemoryFileSystem implements ProjectFileSystem {
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
