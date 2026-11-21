import * as vscode from 'vscode';

export interface RuleFsEntry {
    name: string;
    uri: string;
    type: 'file' | 'directory' | 'symbolicLink' | 'unknown';
}

export interface RuleFsStat {
    type: RuleFsEntry['type'];
    ctime: number;
    mtime: number;
    size: number;
}

export interface RuleFs {
    read(uri: string): Promise<Uint8Array>;
    write(uri: string, data: Uint8Array): Promise<void>;
    delete(uri: string): Promise<void>;
    stat(uri: string): Promise<RuleFsStat>;
    list(uri: string): Promise<RuleFsEntry[]>;
}

function toRuleFsObjectType(type: number): RuleFsEntry['type'] {
    if (type === vscode.FileType.File) return 'file';
    if (type === vscode.FileType.Directory) return 'directory';
    if (type === vscode.FileType.SymbolicLink) return 'symbolicLink';
    return 'unknown';
}

export const ruleFileFs: RuleFs = {
    async read(uri: string): Promise<Uint8Array> {
        return vscode.workspace.fs.readFile(vscode.Uri.parse(uri));
    },
    async write(uri: string, data: Uint8Array): Promise<void> {
        return vscode.workspace.fs.writeFile(vscode.Uri.parse(uri), data);
    },
    async delete(uri: string): Promise<void> {
        return vscode.workspace.fs.delete(vscode.Uri.parse(uri));
    },
    async stat(uri: string): Promise<RuleFsStat> {
        const stats = await vscode.workspace.fs.stat(vscode.Uri.parse(uri));
        return {
            type: toRuleFsObjectType(stats.type),
            ctime: stats.ctime,
            mtime: stats.mtime,
            size: stats.size,
        };
    },
    async list(uri: string): Promise<RuleFsEntry[]> {
        const entries = await vscode.workspace.fs.readDirectory(
            vscode.Uri.parse(uri),
        );
        const base = uri.replace(/\/+$/, '');
        return entries.map(([name, type]) => ({
            name,
            uri: `${base}/${name}`,
            type: toRuleFsObjectType(type),
        }));
    },
};
