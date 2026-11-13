import * as vscode from 'vscode';

/**
 * The filesystem contract readIgnoreRulesForDir consumes, restated
 * structurally: the extension consumes the CLI bundle (`@pzstudio/cli/api`)
 * and cannot import @pzstudio/platform to name the interface, so the types
 * below satisfy it by structure.
 */
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

/**
 * A filesystem view over vscode.workspace.fs for reading the ignore rule
 * files (readIgnoreRulesForDir only lists and reads). URIs travel in this
 * adapter's own space — `vscode.Uri.file(dir).toString()` with plain
 * '/'-joined children — which vscode.Uri.parse round-trips on every scheme
 * the editor exposes, exactly like the rest of the workspace.fs consumers.
 * Shared by the extension's ignore-rule consumers: the dev-sync watcher
 * filter (root-level rules) and the project explorer (rules of every
 * listed directory).
 */
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
