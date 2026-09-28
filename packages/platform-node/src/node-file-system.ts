/**
 * Node.js implementation of the @pzstudio/platform filesystem contract.
 *
 * URIs are opaque strings for the core; this adapter accepts both
 * `file://` URIs and plain absolute paths and translates them to Node
 * paths. Errors surface as native fs errors — the core never interprets
 * them beyond "the operation failed".
 */
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import type {
    DeleteOptions,
    DirectoryEntry,
    FileObjectType,
    FileStat,
    ProjectFileSystem,
} from '@pzstudio/platform';

/** Translates a file:// URI (or a plain absolute path) into a Node path. */
function toPath(uri: string): string {
    if (uri.startsWith('file:')) {
        return fileURLToPath(uri);
    }
    return uri;
}

/** Joins a directory URI and a child name into an absolute URI string. */
function joinUri(dirUri: string, name: string): string {
    const base = dirUri.startsWith('file:')
        ? dirUri.replace(/\/+$/, '')
        : pathToFileURL(dirUri.replace(/[\\/]+$/, '')).href;
    return `${base}/${encodeURIComponent(name)}`;
}

function toObjectType(stats: {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}): FileObjectType {
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    if (stats.isSymbolicLink()) return 'symbolicLink';
    return 'unknown';
}

/**
 * Filesystem adapter backed by fs/promises. Instantiate once per host and
 * inject it into core APIs (loadProject, saveProject, ...).
 */
export class NodeFileSystem implements ProjectFileSystem {
    async read(uri: string): Promise<Uint8Array> {
        const buffer = await fs.readFile(toPath(uri));
        return new Uint8Array(buffer);
    }

    async write(uri: string, data: Uint8Array): Promise<void> {
        const path = toPath(uri);
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, data);
    }

    async delete(uri: string, options?: DeleteOptions): Promise<void> {
        await fs.rm(toPath(uri), {
            recursive: options?.recursive ?? false,
            force: true,
            // rm retries only apply to recursive directory removal on
            // Windows; they ride out the transient locks the game/Steam/
            // Explorer hold on workshop output folders.
            maxRetries: 5,
            retryDelay: 200,
        });
    }

    async stat(uri: string): Promise<FileStat> {
        const stats = await fs.stat(toPath(uri));
        return {
            type: toObjectType(stats),
            ctime: stats.ctimeMs,
            mtime: stats.mtimeMs,
            size: stats.size,
        };
    }

    async list(uri: string): Promise<DirectoryEntry[]> {
        const dirPath = toPath(uri);
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        return entries.map((entry) => ({
            name: entry.name,
            uri: joinUri(uri, entry.name),
            type: entry.isSymbolicLink() ? 'symbolicLink' : toObjectType(entry),
        }));
    }
}
