/**
 * Web (vscode.dev) implementation of the @pzstudio/platform filesystem
 * contract, backed by vscode.workspace.fs. Works with every URI scheme the
 * editor exposes (file:// on desktop, vscode-vfs:// on github.dev /
 * vscode.dev) — the adapter never assumes local disk access.
 */
import * as vscode from 'vscode';
import type {
    DeleteOptions,
    DirectoryEntry,
    FileStat,
    ProjectFileSystem,
} from '@pzstudio/platform';

function toVscodeUri(uri: string): vscode.Uri {
    return vscode.Uri.parse(uri);
}

function toObjectType(type: vscode.FileType): DirectoryEntry['type'] {
    if (type === vscode.FileType.File) return 'file';
    if (type === vscode.FileType.Directory) return 'directory';
    if (type === vscode.FileType.SymbolicLink) return 'symbolicLink';
    return 'unknown';
}

/**
 * Filesystem adapter backed by vscode.workspace.fs. The web extension host
 * instantiates it once and injects it into core APIs.
 */
export class WorkspaceFileSystem implements ProjectFileSystem {
    async read(uri: string): Promise<Uint8Array> {
        return vscode.workspace.fs.readFile(toVscodeUri(uri));
    }

    async write(uri: string, data: Uint8Array): Promise<void> {
        const target = toVscodeUri(uri);
        await vscode.workspace.fs.createDirectory(
            vscode.Uri.joinPath(target, '..'),
        );
        await vscode.workspace.fs.writeFile(target, data);
    }

    async delete(uri: string, options?: DeleteOptions): Promise<void> {
        await vscode.workspace.fs.delete(toVscodeUri(uri), {
            recursive: options?.recursive ?? false,
            useTrash: false,
        });
    }

    async stat(uri: string): Promise<FileStat> {
        const stats = await vscode.workspace.fs.stat(toVscodeUri(uri));
        return {
            type: toObjectType(stats.type),
            ctime: stats.ctime,
            mtime: stats.mtime,
            size: stats.size,
        };
    }

    async list(uri: string): Promise<DirectoryEntry[]> {
        const base = toVscodeUri(uri);
        const entries = await vscode.workspace.fs.readDirectory(base);
        return entries.map(([name, type]) => ({
            name,
            uri: vscode.Uri.joinPath(base, name).toString(),
            type: toObjectType(type),
        }));
    }
}
