/**
 * Workshop link manager — inspection cascade + attach/detach maintenance.
 *
 * Model B keeps every build output in `dist\<Item>` and exposes it to the
 * game as `Workshop\<Item>` — an NTFS junction on Windows, a symlink
 * elsewhere. `inspectWorkshopLink` classifies the current state of one such
 * link so hosts (the CLI build command, doctor, the extension health view)
 * can decide what to do without doing filesystem probes themselves: all
 * I/O goes through the injectable `LinkFs` seam, every outcome is one of
 * the `LinkState` values, and every failure a caller reacts to carries a
 * stable ERR_* code in `detail`.
 *
 * `attachWorkshopLink` / `detachWorkshopLink` implement the attachment
 * rules on top of the cascade. Their contract principle: never mutate
 * files *through* the workshop path `W`. The mutation seam (`RealFs`) has
 * no rm/recursive operation at all — the only writes it can express are
 * `symlink(D, W, type)` (attach), `unlink(W)` (detach/relink), `rmdir(W)`
 * on a verified-empty real dir (auto-replace) and `rename(W, backup)`
 * (explicit backup). Every failure is surfaced in the result (`detail`
 * carries the errno), never thrown past the caller — a link problem must
 * never flip a build's exit code.
 *
 * The cascade is deliberately reparse-tag blind: Node reports junctions and
 * symlinks alike through `isSymbolicLink()`, and entries backed by other
 * reparse tags cannot be told apart reliably — so the only things ever
 * consulted are the `isSymbolicLink()`/`isDirectory()` predicates, the
 * readlink target, and the dev/ino identity of `W` vs `D`.
 */
import {
    posix as pathPosix,
    resolve as pathResolve,
    win32 as pathWin32,
} from 'path';

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
/** A real non-empty directory occupies the workshop slot (refuse/backup). */
export const ERR_WORKSHOP_DIR_EXISTS_REAL = 'ERR_WORKSHOP_DIR_EXISTS_REAL';

/**
 * The mutation slice of `node:fs/promises` the attach/detach maintenance is
 * allowed. No recursive/rm-like operation exists on this seam, so none can
 * ever be attempted at the workshop path. `readFile` carries the read-only
 * refuse-path diagnosis (`W/workshop.txt`): reads through `W` are allowed,
 * mutations through `W` are not. Node hosts pass `fs.promises` directly
 * (structurally compatible); tests inject the same module over tmpdir
 * fixtures, wrapped with call spies and fault injection for failure rows.
 */
export type RealFs = {
    /** Attach: junction on win32, dir symlink elsewhere. */
    symlink(
        target: string,
        path: string,
        type: 'junction' | 'dir',
    ): Promise<void>;
    /** Auto-replace of a verified-EMPTY real dir at `W` (fails ENOTEMPTY otherwise). */
    rmdir(path: string): Promise<void>;
    /** Explicit backup: atomic sibling rename of a non-empty real dir. */
    rename(src: string, dest: string): Promise<void>;
    /** Detach/relink: O(1) reparse-point removal, never touches the target. */
    unlink(path: string): Promise<void>;
    /** Diagnosis only: `W/workshop.txt` for the unsynced-id check. */
    readFile(path: string, encoding: 'utf8'): Promise<string>;
};

export interface AttachWorkshopLinkOptions extends InspectWorkshopLinkOptions {
    /**
     * Refuse-and-diagnose by default; true renames a non-empty real dir at
     * `W` to a `<W>.backup-<ISO-timestamp>` sibling before attaching.
     */
    backupExisting?: boolean;
    /**
     * Replace a FOREIGN_LINK slot (unlink + re-attach). Never overrides
     * UNOWNED_TARGET or IDENTITY_MISMATCH — a wrong target identity is
     * surfaced, not fixed.
     */
    forceLink?: boolean;
    /**
     * The project's source workshop.txt content (what the host generates
     * from config). Enables the refuse-path `hasUnsyncedWorkshopId`
     * diagnosis; omitted means the diagnostic cannot know (`undefined`).
     */
    sourceWorkshopTxt?: string;
}

export type AttachResult = {
    ok: boolean;
    state: LinkState;
    /** Set when a sibling backup dir was created (`backupExisting`). */
    backupPath?: string;
    /** Entries at `W` — refuse diagnostic for CONFLICT_REAL_DIR. */
    itemCount?: number;
    /**
     * Refuse diagnostic: an `id=` line in `W/workshop.txt` missing from the
     * source (`true`), everything in sync (`false`), or unknown (`undefined`
     * — a file is missing or no source text was provided).
     */
    hasUnsyncedWorkshopId?: boolean;
    /** ERR_* code + context; set for every refusal and surfaced failure. */
    detail?: string;
};

export interface DetachWorkshopLinkOptions {
    /**
     * Path semantics parity with attach/inspect. The stage-1 detach gate
     * itself is platform-free; the platform only names the expected entry
     * kind in refusal details.
     */
    platform: LinkPlatform;
}

export type DetachResult = {
    ok: boolean;
    state: LinkState;
    /** ERR_* code + context; set for every refusal and surfaced failure. */
    detail?: string;
};

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
 * Stage 3 for one side of the identity check: bigint-stat `p`; ENOENT maps
 * to the DANGLING_LINK detail, any other error rethrows. Shared by the
 * cascade and the post-attach verification.
 */
async function statIdentityOrDangling(
    fs: LinkFs,
    p: string,
): Promise<{ identity: StatsLike } | { dangling: string }> {
    try {
        return { identity: await fs.stat(p, { bigint: true }) };
    } catch (e) {
        if (errnoOf(e) === 'ENOENT') {
            return {
                dangling: `workshop link is dangling: stat(${p}) failed with ENOENT`,
            };
        }
        throw e;
    }
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
    const statsW = await statIdentityOrDangling(fs, W);
    if ('dangling' in statsW) {
        return { state: 'DANGLING_LINK', rawTarget, detail: statsW.dangling };
    }
    const statsD = await statIdentityOrDangling(fs, D);
    if ('dangling' in statsD) {
        return { state: 'DANGLING_LINK', rawTarget, detail: statsD.dangling };
    }
    if (!sameIdentity(statsW.identity, statsD.identity)) {
        return {
            state: 'IDENTITY_MISMATCH',
            rawTarget,
            detail: `${ERR_LINK_IDENTITY_MISMATCH}: link resolves to the dist path but dev/ino differ (W: ${statsW.identity.dev}/${statsW.identity.ino}, D: ${statsD.identity.dev}/${statsD.identity.ino})`,
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

// ---------------------------------------------------------------------------
// Attach / detach — the attachment rules on top of the cascade.
// ---------------------------------------------------------------------------

const WORKSHOP_TXT = 'workshop.txt';

/** One-line failure description with the errno code, for `detail`. */
function describeFailure(op: string, subject: string, error: unknown): string {
    const code = errnoOf(error);
    const message = error instanceof Error ? error.message : String(error);
    const withCode = code ? ` [${code}]` : '';
    return `${op} ${subject} failed${withCode}: ${message}`;
}

/**
 * Backup sibling name: `<W>.backup-<ISO-timestamp>` with `:`/`.` flattened
 * to `-` so the stamp is a legal single path segment on Windows too.
 */
function backupPathFor(W: string, now: Date): string {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    return `${W}.backup-${stamp}`;
}

/** Every uncommented `id=` line's value in workshop.txt-style text. */
function extractWorkshopIds(text: string): string[] {
    const ids: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
        const match = /^id\s*=\s*(.*)$/.exec(trimmed);
        if (match && match[1].trim() !== '') ids.push(match[1].trim());
    }
    return ids;
}

/**
 * Refuse-path diagnosis: does `W/workshop.txt` carry an `id=` value the
 * source text does not know? (A lost `id=` would make the next
 * workshop_build_item publish a duplicate item instead of updating.)
 * Reading `W/workshop.txt` is allowed — mutation is not. `undefined` when
 * the diagnosis cannot know: no source text provided, or the built copy is
 * unreadable.
 */
async function diagnoseUnsyncedWorkshopId(
    realFs: RealFs,
    W: string,
    platform: LinkPlatform,
    sourceWorkshopTxt: string | undefined,
): Promise<boolean | undefined> {
    if (sourceWorkshopTxt === undefined) return undefined;
    const pathImpl = platform === 'win32' ? pathWin32 : pathPosix;
    let built: string;
    try {
        built = await realFs.readFile(pathImpl.join(W, WORKSHOP_TXT), 'utf8');
    } catch {
        return undefined;
    }
    const sourceIds = new Set(extractWorkshopIds(sourceWorkshopTxt));
    return extractWorkshopIds(built).some((id) => !sourceIds.has(id));
}

/**
 * Post-mutation verification for attach: the identity + ownership stages of
 * the cascade, without the target-normalization stage. The link was just
 * created pointing at the resolved `D` directly, and re-normalizing its raw
 * target through `opts.platform` semantics could disagree with the host
 * filesystem on cross-flavor rows (a 'dir'-symlink attach on a win32 host);
 * identity subsumes the target check — a re-pointed or broken link cannot
 * produce D's dev/ino.
 */
async function verifyAttachedLink(
    fs: LinkFs,
    W: string,
    D: string,
    opts: AttachWorkshopLinkOptions,
): Promise<WorkshopLinkInspection> {
    let entry: StatsLike;
    try {
        entry = await fs.lstat(W);
    } catch (e) {
        if (errnoOf(e) === 'ENOENT') {
            return {
                state: 'DANGLING_LINK',
                detail: 'post-attach verification: workshop entry vanished',
            };
        }
        throw e;
    }
    if (!entry.isSymbolicLink()) {
        return entry.isDirectory()
            ? {
                  state: 'CONFLICT_REAL_DIR',
                  detail: `${ERR_WORKSHOP_DIR_EXISTS_REAL}: post-attach verification found a real directory at the workshop slot`,
              }
            : {
                  state: 'NOT_DIRECTORY',
                  detail: `${ERR_WORKSHOP_PATH_NOT_DIRECTORY}: post-attach verification: workshop entry is neither a directory nor a link`,
              };
    }
    const statsW = await statIdentityOrDangling(fs, W);
    if ('dangling' in statsW) {
        return { state: 'DANGLING_LINK', detail: statsW.dangling };
    }
    const statsD = await statIdentityOrDangling(fs, D);
    if ('dangling' in statsD) {
        return { state: 'DANGLING_LINK', detail: statsD.dangling };
    }
    if (!sameIdentity(statsW.identity, statsD.identity)) {
        return {
            state: 'IDENTITY_MISMATCH',
            detail: `${ERR_LINK_IDENTITY_MISMATCH}: post-attach identity check failed (W: ${statsW.identity.dev}/${statsW.identity.ino}, D: ${statsD.identity.dev}/${statsD.identity.ino})`,
        };
    }
    const marker = opts.readMarker ? await opts.readMarker(D) : undefined;
    if (marker === undefined || marker === null) {
        return {
            state: 'UNOWNED_TARGET',
            detail: `${ERR_UNOWNED_DIST_TARGET}: dist directory has no ownership marker for this project`,
        };
    }
    return { state: 'OK_LINK' };
}

/**
 * Creates the link in an empty slot and verifies it through the seam. Only
 * ever called with the slot already empty: nothing at `W` (ATTACHABLE), a
 * slot emptied by rmdir (auto-replace), a slot vacated by the backup rename,
 * or a foreign link just unlinked by forceLink.
 */
async function attachIntoEmptySlot(
    fs: LinkFs,
    realFs: RealFs,
    W: string,
    D: string,
    opts: AttachWorkshopLinkOptions,
    extra: { backupPath?: string },
): Promise<AttachResult> {
    const type: 'junction' | 'dir' =
        opts.platform === 'win32' ? 'junction' : 'dir';
    try {
        await realFs.symlink(D, W, type);
    } catch (e) {
        // The slot is still empty; a retry after the host resolves the
        // cause (EBUSY open handles, missing 'dir'-symlink privilege)
        // works. Surface, never throw past the caller.
        return {
            ok: false,
            state: 'ATTACHABLE',
            ...extra,
            detail: describeFailure(`symlink '${type}'`, `${D} -> ${W}`, e),
        };
    }
    const post = await verifyAttachedLink(fs, W, D, opts);
    if (post.state === 'OK_LINK' || post.state === 'UNOWNED_TARGET') {
        // UNOWNED_TARGET post-attach is a link this call itself created and
        // identity-verified against D — unlike the PRE-state refusal, the
        // slot was not filled by someone else; only the ownership-marker
        // stage could not confirm (no reader injected, or the build has not
        // written the marker yet). Doctor owns that signal; the detail
        // carries the ERR_UNOWNED_DIST_TARGET code for the host surface.
        return {
            ok: true,
            state: post.state,
            detail: post.state === 'UNOWNED_TARGET' ? post.detail : undefined,
            ...extra,
        };
    }
    return {
        ok: false,
        state: post.state,
        ...extra,
        detail: post.detail ?? `post-attach verification failed: ${post.state}`,
    };
}

/** Attachment table for `lstat(W)` = real directory (spec §4). */
async function attachOverRealDir(
    fs: LinkFs,
    realFs: RealFs,
    W: string,
    D: string,
    opts: AttachWorkshopLinkOptions,
): Promise<AttachResult> {
    // Diagnosis-only reads at W: readdir for the item count, readFile for
    // the unsynced-id flag. Reading for diagnosis is allowed at W; mutation
    // is not (except the two table actions below).
    const entries = await fs.readdir(W);
    if (entries.length === 0) {
        // Auto-replace: rmdir is the kernel-level TOCTOU guard — a dir that
        // became non-empty between readdir and rmdir fails ENOTEMPTY, and
        // nothing is ever deleted recursively.
        try {
            await realFs.rmdir(W);
        } catch (e) {
            return {
                ok: false,
                state: 'CONFLICT_REAL_DIR',
                detail: describeFailure('rmdir', W, e),
            };
        }
        return attachIntoEmptySlot(fs, realFs, W, D, opts, {});
    }
    if (!opts.backupExisting) {
        const hasUnsyncedWorkshopId = await diagnoseUnsyncedWorkshopId(
            realFs,
            W,
            opts.platform,
            opts.sourceWorkshopTxt,
        );
        return {
            ok: false,
            state: 'CONFLICT_REAL_DIR',
            itemCount: entries.length,
            hasUnsyncedWorkshopId,
            detail: `${ERR_WORKSHOP_DIR_EXISTS_REAL}: a real non-empty directory (${entries.length} entries) occupies ${W}; refusing to attach — pass backupExisting to rename it aside`,
        };
    }
    const backupPath = backupPathFor(W, new Date());
    try {
        await realFs.rename(W, backupPath);
    } catch (e) {
        // EBUSY/EPERM (open handles: PZ, Steam, Explorer) abort cleanly:
        // nothing deleted, no symlink, W intact.
        return {
            ok: false,
            state: 'CONFLICT_REAL_DIR',
            detail: describeFailure('rename', `${W} -> ${backupPath}`, e),
        };
    }
    return attachIntoEmptySlot(fs, realFs, W, D, opts, { backupPath });
}

/**
 * Makes `W` a correct, owned junction to the dist directory `D`, per the
 * attachment table. Refuse-or-backup, never recursive: a non-empty real dir
 * is refused (with `itemCount` + `hasUnsyncedWorkshopId` diagnosis) or, with
 * `backupExisting`, renamed to a `<W>.backup-<ISO-timestamp>` sibling; an
 * empty real dir is auto-replaced via `rmdir`; a FOREIGN_LINK slot is
 * unlinked only with `forceLink`. Failures are surfaced in the result, not
 * thrown — link problems must never flip a build's exit code.
 */
export async function attachWorkshopLink(
    fs: LinkFs,
    realFs: RealFs,
    W: string,
    D: string,
    opts: AttachWorkshopLinkOptions,
): Promise<AttachResult> {
    // The junction target must be absolute before symlink (the host's own
    // path semantics — `D` arrives in host form regardless of the flavor).
    const absoluteD = pathResolve(D);
    const pre = await inspectWorkshopLink(fs, W, absoluteD, {
        platform: opts.platform,
        readMarker: opts.readMarker,
    });

    switch (pre.state) {
        case 'OK_LINK':
            // The correct, owned link is already in place — idempotent.
            return { ok: true, state: 'OK_LINK' };
        case 'ATTACHABLE':
            return attachIntoEmptySlot(fs, realFs, W, absoluteD, opts, {});
        case 'CONFLICT_REAL_DIR':
            return attachOverRealDir(fs, realFs, W, absoluteD, opts);
        case 'FOREIGN_LINK':
            if (!opts.forceLink) {
                return { ok: false, state: 'FOREIGN_LINK', detail: pre.detail };
            }
            // Explicit relink: cascade first (rawTarget recorded in `pre`),
            // then the only two mutations ever allowed at `W` in sequence:
            // unlink(W) + symlink(D, W, type).
            try {
                await realFs.unlink(W);
            } catch (e) {
                // The foreign link is still in place — slot unchanged.
                return {
                    ok: false,
                    state: 'FOREIGN_LINK',
                    detail: describeFailure('unlink', W, e),
                };
            }
            return attachIntoEmptySlot(fs, realFs, W, absoluteD, opts, {});
        default:
            // DANGLING_LINK: the slot already holds a link to D — re-creating
            // it cannot fix a missing D (the build recreates D first).
            // NOT_DIRECTORY / UNOWNED_TARGET / IDENTITY_MISMATCH: fail-closed,
            // never even with forceLink — identity mismatch means the target
            // itself is wrong; surface, don't fix.
            return { ok: false, state: pre.state, detail: pre.detail };
    }
}

/**
 * Removes the link at the workshop slot `W`. Cascade-gated by the cascade's
 * stage 1: only a link-shaped entry may ever be unlinked (a junction or dir
 * symlink unlinks as an O(1) reparse point and never touches its target).
 * A real directory is refused outright — detach has no rmdir/rm privilege
 * at `W`, so a non-empty dir swapped in during the race can only fail at
 * the kernel (ENOTEMPTY/EPERM) with zero deletions. Absent `W` is an
 * idempotent no-op. Failures are surfaced in the result, not thrown.
 */
export async function detachWorkshopLink(
    fs: LinkFs,
    realFs: RealFs,
    W: string,
    opts: DetachWorkshopLinkOptions,
): Promise<DetachResult> {
    let entry: StatsLike;
    try {
        entry = await fs.lstat(W);
    } catch (e) {
        if (errnoOf(e) === 'ENOENT') {
            return {
                ok: true,
                state: 'ATTACHABLE',
                detail: `nothing to detach: ${W} is absent`,
            };
        }
        throw e;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
        return {
            ok: false,
            state: 'CONFLICT_REAL_DIR',
            detail: `refusing to detach: a real directory occupies ${W}; detach is unlink-only and never removes directories`,
        };
    }
    if (!entry.isSymbolicLink()) {
        return {
            ok: false,
            state: 'NOT_DIRECTORY',
            detail: `${ERR_WORKSHOP_PATH_NOT_DIRECTORY}: workshop path is neither a directory nor a link`,
        };
    }
    try {
        await realFs.unlink(W);
    } catch (e) {
        const code = errnoOf(e);
        if (code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EISDIR') {
            // Kernel refusal — TOCTOU swap or OS protection. Surface
            // cleanly; zero deletions; never fall back to rm/rmdir.
            const expected =
                opts.platform === 'win32' ? 'junction' : 'dir symlink';
            return {
                ok: false,
                state: 'CONFLICT_REAL_DIR',
                detail: `unlink(${W}) failed with ${code}: nothing was deleted (expected a ${expected} at the workshop slot; detach is unlink-only)`,
            };
        }
        throw e;
    }
    try {
        await fs.lstat(W);
    } catch (e) {
        if (errnoOf(e) === 'ENOENT') return { ok: true, state: 'ATTACHABLE' };
        throw e;
    }
    return {
        ok: false,
        state: 'NOT_DIRECTORY',
        detail: `${ERR_WORKSHOP_PATH_NOT_DIRECTORY}: unlink(${W}) reported success but the workshop entry is still present`,
    };
}
