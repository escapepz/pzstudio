/**
 * F23-WRITE P0 (CLI tier) — alias-route containment for the standalone CLI's
 * synchronous mutation sites (doc 17 §11.4, the contract-only interim
 * containment; §11.8's CLI parity boundary).
 *
 * This module is the synchronous Node-fs mirror of the Core guard
 * (packages/core/src/mutation-guard.ts): the same invariant, the same
 * matching semantics, executed against the real filesystem the CLI's
 * executor touches. Every mutating call site that declares an output root
 * must establish its physical route before it mutates:
 *
 * - the configured output root itself is NEVER inspected (INV-A: a
 *   user-configured junction outdir is intentional alias resolution and must
 *   keep building — the scan starts at the root's entries, never the root);
 * - every path component strictly below the root on the operation's target
 *   must exist as a non-alias entry, or be missing entirely (fresh creation
 *   by this very operation) — a symbolic-link/junction component anywhere on
 *   the route (readdirSync reports NTFS junctions as symbolicLink entries)
 *   is refused explicitly BEFORE the mutation;
 * - the leaf is operation-specific (doc 17 §11.2): a delete may remove a
 *   link itself (leaf-local, target untouched — B1); a write never writes
 *   through one (class 5);
 * - a route directory that cannot be listed (any failure other than
 *   not-there) fails the operation explicitly — an unverifiable route is
 *   never a silent skip, a warning, or a success;
 * - entry matching uses the resolveDestinationChain witness rule: an exact
 *   on-disk name match wins; otherwise a unique case-insensitive match
 *   counts only when a stat of the plan spelling succeeds, so distinct
 *   case-sensitive paths are never merged.
 *
 * Disclosed residuals (doc 17 §11.4, unchanged by this tier): alias
 * insertion or retargeting between inspection and the OS call (TOCTOU);
 * hard-linked file leaves (S9c); 8.3 short names; E1 ownership destruction
 * inside the resolved root (doc 15's boundary stands — this guard
 * authorizes routes, not file ownership).
 *
 * The guard is opt-in: without an output root every function is a no-op and
 * callers keep today's behavior. This module is CLI-internal: it is not
 * re-exported through the api surface and adds no public API.
 */
import fs from 'fs';
import { basename, dirname, join } from 'path';
import type { Dirent } from 'fs';

/** Leaf semantics of the guarded mutation (doc 17 §11.2). */
export type MutationLeafMode = 'write' | 'delete';

/** Route-guard options for the CLI's synchronous executor. */
export interface CliMutationRouteOptions {
    /**
     * The configured build output root (config.outdir) every guarded
     * mutation must stay below. When absent the guard is inactive and
     * callers keep today's behavior (mirrors Core's MutationRouteOptions).
     */
    outputRoot?: string;
}

/**
 * Splits a native path into segments. Backslashes fold to '/', empty
 * segments drop — the same normalization the Core guard applies.
 */
function pathSegments(path: string): string[] {
    return path
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment !== '');
}

/**
 * Locates `candidate` strictly inside `root`, segment-wise (null when not
 * inside). Same comparison semantics as the Core guard: only a Windows
 * drive prefix compares case-insensitively.
 */
function segmentsBelow(root: string, candidate: string): string[] | null {
    const rootSegments = pathSegments(root);
    const candidateSegments = pathSegments(candidate);
    if (candidateSegments.length <= rootSegments.length) {
        return null;
    }
    for (let i = 0; i < rootSegments.length; i += 1) {
        const rootSegment = rootSegments[i];
        const candidateSegment = candidateSegments[i];
        const equal =
            i === 0 && /^[a-zA-Z]:$/.test(rootSegment)
                ? rootSegment.toLowerCase() === candidateSegment.toLowerCase()
                : rootSegment === candidateSegment;
        if (!equal) {
            return null;
        }
    }
    return candidateSegments.slice(rootSegments.length);
}

function isNoSuchEntryError(e: unknown): boolean {
    const err = e as { code?: string; message?: string } | undefined;
    return (
        err?.code === 'ENOENT' ||
        (err?.message ?? '').includes('ENOENT') ||
        (err?.message ?? '').includes('no such file or directory')
    );
}

/**
 * Lists a route directory for authorization: null when the directory is not
 * there (everything below is fresh creation); any other listing failure
 * throws an explicit authorization error — never a swallowed skip.
 */
export function listRouteDirectorySync(
    operation: string,
    targetPath: string,
    dir: string,
): Dirent[] | null {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        if (isNoSuchEntryError(e)) {
            return null;
        }
        throw new Error(
            `Cannot authorize ${operation} '${targetPath}': listing '${dir}' failed (${
                e instanceof Error ? e.message : String(e)
            }) — the route below the build output root could not be verified.`,
            { cause: e },
        );
    }
}

/**
 * Looks a plan-spelled name up in a directory listing: an exact on-disk
 * match wins; otherwise a unique case-insensitive match counts only when a
 * stat of the plan spelling succeeds — the resolveDestinationChain witness
 * rule (a case-variant stored entry is the same directory on a
 * case-insensitive host; on a case-sensitive host the twin is a distinct
 * path and stays untouched).
 */
export function lookupRouteEntrySync(
    parentDir: string,
    entries: Dirent[],
    name: string,
): Dirent | null {
    const exact = entries.find((entry) => entry.name === name);
    if (exact) {
        return exact;
    }
    const lower = name.toLowerCase();
    const variants = entries.filter(
        (entry) => entry.name.toLowerCase() === lower,
    );
    if (variants.length !== 1) {
        return null;
    }
    try {
        fs.statSync(join(parentDir, name));
    } catch {
        return null;
    }
    return variants[0];
}

/** The actionable refusal for an alias component on a mutation route. */
export function aliasRouteError(
    operation: string,
    targetPath: string,
    outputRoot: string,
    componentName: string,
): Error {
    return new Error(
        `Refusing ${operation} '${targetPath}': '${componentName}' on the route below the build output root '${outputRoot}' is a symbolic link, so the mutation would apply to content outside the generated output. Remove the link or correct the build's output configuration.`,
    );
}

/**
 * Authorizes a mutating operation's route before the filesystem is touched.
 *
 * Walks the components of `targetPath` strictly below `outputRoot` (a
 * delete's leaf excluded — removing a link is leaf-local) and refuses when
 * any existing component is a symbolicLink listing entry: the OS would
 * resolve the mutation through it into content the plan never spelled.
 * Missing components authorize everything below them as fresh creation; a
 * route directory that cannot be listed (any failure other than
 * not-there) fails the operation. A target outside the declared root is
 * refused outright.
 */
export function assertNoAliasRouteSync(
    outputRoot: string | undefined,
    targetPath: string,
    leafMode: MutationLeafMode,
    operation: string,
): void {
    if (!outputRoot) {
        return;
    }
    const below = segmentsBelow(outputRoot, targetPath);
    if (!below) {
        throw new Error(
            `Refusing ${operation} '${targetPath}': the target is not inside the configured build output root '${outputRoot}'.`,
        );
    }
    let current = outputRoot;
    for (let i = 0; i < below.length; i += 1) {
        const name = below[i];
        const isLeaf = i === below.length - 1;
        if (isLeaf && leafMode === 'delete') {
            return;
        }
        const entries = listRouteDirectorySync(operation, targetPath, current);
        if (entries === null) {
            return;
        }
        const entry = lookupRouteEntrySync(current, entries, name);
        if (!entry) {
            return;
        }
        if (entry.isSymbolicLink()) {
            throw aliasRouteError(
                operation,
                targetPath,
                outputRoot,
                entry.name,
            );
        }
        if (isLeaf || !entry.isDirectory()) {
            // A write onto an existing non-alias leaf (class 4 — ownership
            // is E1's decision, not this guard's), or a non-directory
            // component the OS itself will reject: no alias route either
            // way.
            return;
        }
        current = join(current, entry.name);
    }
}

/**
 * Destination-entry clash check for recursive copies (doc 17 §11.4 rule 2):
 * refuses when the name a copy is about to write onto or descend through is
 * a symbolic-link entry of the corresponding destination directory.
 * Unrelated links the copy never touches cause no refusal.
 *
 * The destination directory is listed FRESH on every check. The copy itself
 * can create destination links — every included source symlink is re-created
 * as a destination link (cpSync's onLink; dereference stays false) — so a
 * listing captured earlier in the same copy can omit an alias that exists by
 * the time a later entry is authorized, and no authorization may rely on
 * such a snapshot. The cost is one readdirSync per guarded entry.
 */
export function assertNoAliasDestinationEntry(
    destPath: string,
    outputRoot: string,
    operation: string,
): void {
    const parentDir = dirname(destPath);
    const name = basename(destPath);
    const entries = listRouteDirectorySync(operation, destPath, parentDir);
    if (entries === null) {
        return;
    }
    const entry = lookupRouteEntrySync(parentDir, entries, name);
    if (entry?.isSymbolicLink()) {
        throw aliasRouteError(operation, destPath, outputRoot, entry.name);
    }
}
