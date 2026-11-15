/**
 * Workspace-side attribution source for console.txt findings: walks one
 * context mod's project sources and indexes every Lua file by basename, so
 * findings can click-to-file even without a SEVERE full path (design
 * §Attribution ladder, tier 3).
 *
 * Browser-safe: the walk runs entirely through the injected
 * `ProjectFileSystem` contract — no Node builtins, no `process`.
 */

import type { DirectoryEntry, ProjectFileSystem } from '@pzstudio/platform';
import type { ConsoleLogModContext } from './consoleLog';

/**
 * Collects the Lua basenames of one context mod's workspace sources.
 *
 * Returns `basename.toLowerCase() -> workspace URIs`, ordered 42-first: URIs
 * under a B42 version folder (`42`, `42.1`, ...) precede the shared `common`
 * tree, matching the game's B42 version-over-common precedence.
 */
export async function collectLuaBasenames(
    fs: ProjectFileSystem,
    mod: ConsoleLogModContext,
): Promise<Map<string, string[]>> {
    const byBasename = new Map<string, string[]>();
    await walkLuaFiles(fs, mod.sourceRootUri, byBasename);
    for (const uris of byBasename.values()) {
        // Array#sort is stable, so walk order survives within a rank.
        uris.sort((a, b) => luaUriRank(a) - luaUriRank(b));
    }
    return byBasename;
}

// Recursive walk from the mod source root. An unreadable or absent subtree
// simply contributes nothing — external or partially synced mods must not
// break the whole analysis.
async function walkLuaFiles(
    fs: ProjectFileSystem,
    uri: string,
    byBasename: Map<string, string[]>,
): Promise<void> {
    let entries: DirectoryEntry[];
    try {
        entries = await fs.list(uri);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.type === 'directory') {
            await walkLuaFiles(fs, entry.uri, byBasename);
            continue;
        }
        if (!entry.uri.includes('/media/lua/') || !entry.uri.endsWith('.lua')) {
            continue;
        }
        const basename = entry.name.toLowerCase();
        const uris = byBasename.get(basename);
        if (uris) {
            uris.push(entry.uri);
        } else {
            byBasename.set(basename, [entry.uri]);
        }
    }
}

// B42 version folders (42, 42.1, ...) rank before the shared `common` tree;
// anything else trails.
const LUA_VERSION_42 = /\/42(?:\.\d+)?\/media\/lua\//;

function luaUriRank(uri: string): number {
    if (LUA_VERSION_42.test(uri)) {
        return 0;
    }
    if (uri.includes('/common/media/lua/')) {
        return 1;
    }
    return 2;
}
