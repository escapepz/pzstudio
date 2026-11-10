/**
 * Workshop link manager — inspection cascade.
 *
 * Model B keeps every build output in `dist\<Item>` and exposes it to the
 * game as `Workshop\<Item>` — an NTFS junction on Windows, a symlink
 * elsewhere. `inspectWorkshopLink` classifies the current state of one such
 * link so hosts (the CLI build command, Task 2's attach/detach maintenance)
 * can decide what to do without doing filesystem probes themselves: all
 * I/O goes through the injectable `LinkFs` seam, every outcome is one of
 * the `LinkState` values, and every failure a caller reacts to carries a
 * stable ERR_* code in `detail`.
 *
 * The cascade is deliberately reparse-tag blind: Node reports junctions and
 * symlinks alike through `isSymbolicLink()`, and entries backed by other
 * reparse tags cannot be told apart reliably — so the only things ever
 * consulted are the `isSymbolicLink()`/`isDirectory()` predicates, the
 * readlink target, and the dev/ino identity of `W` vs `D`.
 */
import { posix as pathPosix, win32 as pathWin32 } from 'path';

export type LinkPlatform = 'win32' | 'posix';

/** Minimal stat shape the cascade needs (Node `Stats`/`BigIntStats` fit). */
export type StatsLike = {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    dev: bigint | number;
    ino: bigint | number;
};

/**
 * The slice of `node:fs/promises` the link manager consumes. Node hosts
 * pass `fs.promises` directly; tests inject fakes. `realpath`/`readdir`
 * are not used by the inspection cascade — they exist for Task 2's attach
 * and detach maintenance, which shares this seam.
 */
export type LinkFs = {
    lstat(p: string): Promise<StatsLike>;
    readlink(p: string): Promise<string>;
    stat(p: string, opts?: { bigint?: boolean }): Promise<StatsLike>;
    realpath(p: string): Promise<string>;
    readdir(p: string): Promise<string[]>;
};

/** Terminal states of one `inspectWorkshopLink` run. */
export type LinkState =
    | 'ATTACHABLE'
    | 'OK_LINK'
    | 'CONFLICT_REAL_DIR'
    | 'DANGLING_LINK'
    | 'FOREIGN_LINK'
    | 'NOT_DIRECTORY'
    | 'UNOWNED_TARGET'
    | 'IDENTITY_MISMATCH';

export interface WorkshopLinkInspection {
    state: LinkState;
    /** Human-readable context; carries the ERR_* code where one applies. */
    detail?: string;
    /** The raw readlink() target — present whenever a link was read. */
    rawTarget?: string;
}

export interface InspectWorkshopLinkOptions {
    /** Path semantics for normalization and dirname; never process.platform. */
    platform: LinkPlatform;
    /**
     * Ownership probe for the dist directory. Returns the parsed marker
     * (e.g. `{ projectId }`) when `D` belongs to this project, undefined
     * when the marker is missing or names another project. Defaults to
     * "marker absent", which makes every target-matching link report
     * UNOWNED_TARGET — safe until Task 3/4 wire the real reader. Called
     * with `D` only, never with `W`.
     */
    readMarker?: (distDir: string) => Promise<unknown>;
}

/** `W` exists but is neither a directory nor a manageable link. */
export const ERR_WORKSHOP_PATH_NOT_DIRECTORY =
    'ERR_WORKSHOP_PATH_NOT_DIRECTORY';
/** The workshop link points somewhere other than the dist directory. */
export const ERR_FOREIGN_WORKSHOP_LINK = 'ERR_FOREIGN_WORKSHOP_LINK';
/** The link resolves to D's path but dev/ino do not match D's. */
export const ERR_LINK_IDENTITY_MISMATCH = 'ERR_LINK_IDENTITY_MISMATCH';
/** The dist directory carries no ownership marker for this project. */
export const ERR_UNOWNED_DIST_TARGET = 'ERR_UNOWNED_DIST_TARGET';

const LONG_PATH_PREFIX = '\\\\?\\';

/** Extracts the errno `code` from a thrown value, when present. */
function errnoOf(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string') return code;
    }
    return undefined;
}

/**
 * Canonical form of a link target: strips the `\\?\` long-path prefix,
 * resolves relative targets against `linkDir` (the directory holding the
 * link) with the given platform's path rules, and lowercases on win32 so
 * callers compare results with `===` case-insensitively. Posix keeps case.
 */
export function normalizeLinkTarget(
    raw: string,
    linkDir: string,
    platform: LinkPlatform,
): string {
    const pathImpl = platform === 'win32' ? pathWin32 : pathPosix;
    const unprefixed = raw.startsWith(LONG_PATH_PREFIX)
        ? raw.slice(LONG_PATH_PREFIX.length)
        : raw;
    const resolved = pathImpl.resolve(linkDir, unprefixed);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** dev/ino equality across bigint and plain stats, via BigInt coercion. */
function sameIdentity(a: StatsLike, b: StatsLike): boolean {
    return BigInt(a.dev) === BigInt(b.dev) && BigInt(a.ino) === BigInt(b.ino);
}

/**
 * Classifies the workshop entry `W` against the expected dist directory
 * `D` (cascade order: entry type -> normalized target -> identity ->
 * ownership). FS errors outside the cascade's vocabulary (anything but
 * ENOENT/EINVAL at the documented call sites) propagate to the caller.
 */
export async function inspectWorkshopLink(
    fs: LinkFs,
    W: string,
    D: string,
    opts: InspectWorkshopLinkOptions,
): Promise<WorkshopLinkInspection> {
    const pathImpl = opts.platform === 'win32' ? pathWin32 : pathPosix;
    const linkDir = pathImpl.dirname(W);
    const normalizedD = normalizeLinkTarget(D, linkDir, opts.platform);

    // Stage 1: entry type. ENOENT means nothing occupies the slot.
    let entry: StatsLike;
    try {
        entry = await fs.lstat(W);
    } catch (e) {
        if (errnoOf(e) === 'ENOENT') return { state: 'ATTACHABLE' };
        throw e;
    }

    if (entry.isSymbolicLink()) {
        // Junction and symlink arrive here identically (reparse-tag blind).
        // A link-shaped entry whose readlink fails EINVAL is backed by an
        // unsupported reparse tag (OneDrive cloud placeholder, AppExecLink)
        // — nothing the manager can read or rewrite.
        let rawTarget: string;
        try {
            rawTarget = await fs.readlink(W);
        } catch (e) {
            if (errnoOf(e) === 'EINVAL') {
                return {
                    state: 'NOT_DIRECTORY',
                    detail: `${ERR_WORKSHOP_PATH_NOT_DIRECTORY}: entry reports link metadata but readlink failed with EINVAL (unsupported reparse tag)`,
                };
            }
            throw e;
        }
        return classifyLinkTarget(
            fs,
            W,
            D,
            linkDir,
            normalizedD,
            rawTarget,
            opts,
        );
    }

    if (entry.isDirectory()) {
        // A real directory occupies the slot; Task 2 classifies further.
        return { state: 'CONFLICT_REAL_DIR' };
    }

    return {
        state: 'NOT_DIRECTORY',
        detail: `${ERR_WORKSHOP_PATH_NOT_DIRECTORY}: workshop path is neither a directory nor a link`,
    };
}

/** Stages 2-4 for an entry that is a link: target, identity, ownership. */
async function classifyLinkTarget(
    fs: LinkFs,
    W: string,
    D: string,
    linkDir: string,
    normalizedD: string,
    rawTarget: string,
    opts: InspectWorkshopLinkOptions,
): Promise<WorkshopLinkInspection> {
    // Stage 2: the target must resolve to the dist directory.
    const normalizedTarget = normalizeLinkTarget(
        rawTarget,
        linkDir,
        opts.platform,
    );
    if (normalizedTarget !== normalizedD) {
        return {
            state: 'FOREIGN_LINK',
            rawTarget,
            detail: `${ERR_FOREIGN_WORKSHOP_LINK}: link target ${normalizedTarget} does not match dist ${normalizedD} (raw: ${rawTarget})`,
        };
    }

    // Stage 3: identity — following the link must land on D itself.
    let statsW: StatsLike;
    try {
        statsW = await fs.stat(W, { bigint: true });
    } catch (e) {
        if (errnoOf(e) === 'ENOENT') {
            return {
                state: 'DANGLING_LINK',
                rawTarget,
                detail: `workshop link is dangling: stat(${W}) failed with ENOENT`,
            };
        }
        throw e;
    }
    let statsD: StatsLike;
    try {
        statsD = await fs.stat(D, { bigint: true });
    } catch (e) {
        if (errnoOf(e) === 'ENOENT') {
            return {
                state: 'DANGLING_LINK',
                rawTarget,
                detail: `workshop link is dangling: stat(${D}) failed with ENOENT`,
            };
        }
        throw e;
    }
    if (!sameIdentity(statsW, statsD)) {
        return {
            state: 'IDENTITY_MISMATCH',
            rawTarget,
            detail: `${ERR_LINK_IDENTITY_MISMATCH}: link resolves to the dist path but dev/ino differ (W: ${statsW.dev}/${statsW.ino}, D: ${statsD.dev}/${statsD.ino})`,
        };
    }

    // Stage 4: ownership — only manage a dist directory carrying our
    // marker. The default (no reader injected) is "marker absent".
    const marker = opts.readMarker ? await opts.readMarker(D) : undefined;
    if (marker === undefined || marker === null) {
        return {
            state: 'UNOWNED_TARGET',
            rawTarget,
            detail: `${ERR_UNOWNED_DIST_TARGET}: dist directory has no ownership marker for this project`,
        };
    }

    return { state: 'OK_LINK', rawTarget };
}
