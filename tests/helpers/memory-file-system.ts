import type {
    DirectoryEntry,
    FileStat,
    ProjectFileSystem,
} from '@pzstudio/platform';

/**
 * In-memory ProjectFileSystem with real tree semantics: list() derives
 * children from the stored key space and stat() resolves directories. This
 * doubles as a fake host for core tests — the sync engine must run against
 * it without any node filesystem.
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
        if (this.childUris(uri).length > 0) {
            return { type: 'directory', ctime: 0, mtime: 0, size: 0 };
        }
        throw new Error(`ENOENT: ${uri}`);
    }

    async list(uri: string): Promise<DirectoryEntry[]> {
        const prefix = uri.endsWith('/') ? uri : `${uri}/`;
        const names = new Map<string, DirectoryEntry['type']>();
        for (const key of this.files.keys()) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const slash = rest.indexOf('/');
            if (slash === -1) {
                names.set(rest, 'file');
            } else {
                names.set(rest.slice(0, slash), 'directory');
            }
        }
        return [...names.entries()].map(([name, type]) => ({
            name,
            uri: `${prefix}${name}`,
            type,
        }));
    }

    /** URIs of every stored file strictly below the given directory URI. */
    private childUris(uri: string): string[] {
        const prefix = uri.endsWith('/') ? uri : `${uri}/`;
        return [...this.files.keys()].filter((key) => key.startsWith(prefix));
    }

    /** Test convenience: writes a UTF-8 text file. */
    async writeText(uri: string, content: string): Promise<void> {
        await this.write(uri, new TextEncoder().encode(content));
    }

    /** Test convenience: reads a file as UTF-8 text. */
    async readText(uri: string): Promise<string> {
        return new TextDecoder().decode(await this.read(uri));
    }
}
