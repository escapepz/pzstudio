/**
 * F23-WRITE P0 — alias-route containment at the Core mutation boundaries
 * (doc 17 §11.4, the contract-only interim containment).
 *
 * Every mutating operation must establish its physical route relative to the
 * configured output root before it touches the filesystem, using only the
 * existing ProjectFileSystem contract: the link type a host's list() already
 * reports (DirectoryEntry.type === 'symbolicLink').
 *
 * The invariant implemented (INV-B, permissive bound + route refusal):
 * - the configured output root itself is NEVER inspected (INV-A: a
 *   user-configured junction outdir is intentional alias resolution and must
 *   keep building);
 * - every path component strictly below the root on the operation's target
 *   must exist as a non-alias entry, or be missing entirely (fresh creation
 *   by this very operation) — an alias component anywhere on the route is
 *   refused explicitly BEFORE the mutation;
 * - the leaf is operation-specific (doc 17 §11.2): a delete may remove a
 *   link itself (leaf-local, target untouched — B1); a write never writes
 *   through one (class 5);
 * - a route component that cannot be verified (listing fails with anything
 *   other than "not there") fails the operation explicitly — an
 *   unverifiable route is never a silent skip, a warning, or a success.
 *
 * Disclosed residuals (doc 17 §11.4 "what the P0 does not stop"): alias
 * insertion or retargeting between this inspection and the OS call (TOCTOU —
 * narrowed by scan placement, not closed); hard-linked file leaves
 * (invisible to every listing); 8.3 short names; hosts whose list() cannot
 * report link types faithfully; E1 ownership destruction inside the resolved
 * root. Containment decides where a mutation lands — it is not an ownership
 * authorization (doc 15's boundary stands).
 *
 * This module is Core-internal: it is not re-exported through the package
 * index and adds no public API surface.
 */
import type { DirectoryEntry, ProjectFileSystem } from '@pzstudio/platform';

/** Leaf semantics of the guarded mutation (doc 17 §11.2). */
export type MutationLeafMode = 'write' | 'delete';

/** Route-guard options shared by the executor and the session mutations. */
export interface MutationRouteOptions {
    /**
     * The configured build output root (config.outdir) every guarded
     * mutation must stay below. When absent the guard is inactive and
     * callers keep today's behavior — every Core production path names its
     * root (BuildSession always does).
     */
    outputRoot?: string;
}

/**
 * Splits a plan-space path into '/'-separated segments. Backslashes fold to
 * '/' and empty segments drop — the same normalization execute.ts applies
 * (joinPath/pathSegments), kept local so this module never cycles into it.
 */
function pathSegments(path: string): string[] {
    return path
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment !== '');
}

/** Folds a plan-space path to '/' separators (the scan's working space). */
function normalizeRoute(path: string): string {
    const segments = pathSegments(path);
    const absolute = path.replace(/\\/g, '/').startsWith('/');
    return segments.length
        ? `${absolute ? '/' : ''}${segments.join('/')}`
        : '/';
}

/** Joins scan-space segments, preserving any absolute prefix. */
function joinRoute(...parts: string[]): string {
    const joined = parts
        .map((part) => part.replace(/\\/g, '/'))
        .filter((part) => part !== '')
        .join('/');
    return joined.replace(/\/{2,}/g, '/');
}

/**
 * Locates `candidate` strictly inside `root`, segment-wise (null when not
 * inside). Same comparison semantics as execute.ts's segmentsBelow: only a
 * Windows drive prefix compares case-insensitively.
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
export async function listRouteDirectory(
    fs: ProjectFileSystem,
    operation: string,
    targetPath: string,
    dirUri: string,
): Promise<DirectoryEntry[] | null> {
    try {
        return await fs.list(dirUri);
    } catch (e) {
        if (isNoSuchEntryError(e)) {
            return null;
        }
        throw new Error(
            `Cannot authorize ${operation} '${targetPath}': listing '${dirUri}' failed (${
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
export async function lookupRouteEntry(
    fs: ProjectFileSystem,
    parentUri: string,
    entries: DirectoryEntry[],
    name: string,
): Promise<DirectoryEntry | null> {
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
        await fs.stat(joinRoute(parentUri, name));
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
 * any existing component is a `symbolicLink` listing entry: the OS would
 * resolve the mutation through it into content the plan never spelled.
 * Missing components authorize everything below them as fresh creation; an
 * unverifiable route component (listing failure other than not-there) fails
 * the operation. A target outside the declared root is refused outright.
 */
export async function assertNoAliasRoute(
    fs: ProjectFileSystem,
    outputRoot: string | undefined,
    targetPath: string,
    leafMode: MutationLeafMode,
    operation: string,
): Promise<void> {
    if (!outputRoot) {
        return;
    }
    const below = segmentsBelow(outputRoot, targetPath);
    if (!below) {
        throw new Error(
            `Refusing ${operation} '${targetPath}': the target is not inside the configured build output root '${outputRoot}'.`,
        );
    }
    let current = normalizeRoute(outputRoot);
    for (let i = 0; i < below.length; i += 1) {
        const name = below[i];
        const isLeaf = i === below.length - 1;
        if (isLeaf && leafMode === 'delete') {
            return;
        }
        const entries = await listRouteDirectory(
            fs,
            operation,
            targetPath,
            current,
        );
        if (entries === null) {
            return;
        }
        const entry = await lookupRouteEntry(fs, current, entries, name);
        if (!entry) {
            return;
        }
        if (entry.type === 'symbolicLink') {
            throw aliasRouteError(
                operation,
                targetPath,
                outputRoot,
                entry.name,
            );
        }
        if (isLeaf || entry.type !== 'directory') {
            // A write onto an existing non-alias leaf (class 4 — ownership
            // is E1's decision, not this guard's), or a non-directory
            // component the OS itself will reject: no alias route either way.
            return;
        }
        current = joinRoute(current, entry.name);
    }
}
