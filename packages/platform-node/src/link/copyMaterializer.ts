/**
 * Copy materializer — the 'copy' mode of the materialize step (2026-11-12
 * amendment §6). While the link manager exposes `dist/<Item>` to the game
 * through a junction, 'copy' mode maintains a REAL, reconciled copy at
 * `<outdir>/<Item>`: overwrite changed files, add new ones, prune stale
 * ones — in-place reconciliation, never `rm -rf` + `cp -r`.
 *
 * Contract principle (the copy counterpart of the link manager's
 * unlink-only invariant): mutations inside the slot exist ONLY behind the
 * 4-step gate —
 *   1. `lstat(W)` is a real directory (a junction is never a copy slot);
 *   2. `W/.pzstudio-copy.json` exists and matches this project's identity
 *      (a plain copy of `dist/<Item>` carries the OUTPUT marker too, so
 *      the copy marker is the only proof of slot ownership);
 *   3. a recursive scan finds zero links inside the slot (a nested link
 *      would redirect a prune outside the deployment root) — the scan IS
 *      the first tree walk, and every later walk refuses links on sight;
 *   4. any real directory lacking a matching marker is hand-made and
 *      refused (an EMPTY real dir is adopted, mirroring the link
 *      attachment table's auto-replace).
 *
 * The owner's hard rule lives here as well: when the slot currently holds
 * a pzstudio junction, `materializeCopySlot` unlinks the link BEFORE any
 * copy begins — copying through the link would write into `dist` from the
 * deployment side, violating Model B's core invariant. The unlink goes
 * through the link manager's `RealFs` seam (unlink-only at `W`).
 *
 * Like the link manager, identity probes are INJECTED (`readMarker` /
 * `readCopyMarker` / `writeCopyMarker`): platform-node carries no
 * `@pzstudio/core` dependency — the host (CLI linkStep) supplies the core
 * marker readers over its own filesystem adapter. Failures are surfaced
 * in results, never thrown past the caller — a deployment problem must
 * never flip a build's exit code.
 */
import {
    posix as pathPosix,
    resolve as pathResolve,
    win32 as pathWin32,
} from 'path';
import {
    inspectWorkshopLink,
    type LinkFs,
    type LinkPlatform,
    type RealFs,
    type StatsLike,
} from './linkManager';

/**
 * The slice of `node:fs/promises` the copy materializer consumes. Node
 * hosts pass `fs.promises` directly (structurally compatible); tests
 * inject the same module over tmpdir fixtures. `utimes` preserves the
 * source mtime on every copied file — without it the slot copy would
 * always look "changed" on the next pass and reconciliation would never
 * converge.
 */
export type CopyFs = {
    lstat(p: string): Promise<CopyStats>;
    stat(p: string): Promise<CopyStats>;
    readdirEntries(p: string): Promise<CopyDirEntry[]>;
    readFile(p: string): Promise<Uint8Array>;
    writeFile(p: string, data: Uint8Array): Promise<void>;
    mkdir(p: string): Promise<void>;
    unlink(p: string): Promise<void>;
    rmdir(p: string): Promise<void>;
    utimes(
        p: string,
        atime: number | Date,
        mtime: number | Date,
    ): Promise<void>;
};

/** Minimal stat shape for change detection and entry classification. */
export type CopyStats = {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mtimeMs: number;
    size: number;
};

/** One `readdir(withFileTypes)` entry. */
export type CopyDirEntry = {
    name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
};

/**
 * The copy-marker filename this module excludes from every sync pass
 * (never copied from dist — dist never carries it — never pruned from the
 * slot; the host's writer owns it). Must stay identical to core's
 * `COPY_MARKER_FILENAME`; tests pin the two constants together.
 */
export const COPY_MARKER_FILENAME = '.pzstudio-copy.json';

/**
 * The content last written into a copy slot: item-relative POSIX path →
 * `[size, mtimeMs]`. Structurally identical to core's `SlotManifest`;
 * duplicated here because platform-node deliberately carries no
 * `@pzstudio/core` dependency (identity probes stay injected).
 */
export type SlotManifest = Record<string, [size: number, mtimeMs: number]>;

/**
 * Terminal states of one `inspectMaterializeSlot` run: the link cascade's
 * states (delegated verbatim for link-shaped entries) plus the copy-slot
 * states. `CONFLICT_REAL_DIR` never appears — a real directory is
 * classified further as `COPY_SLOT` (matching copy marker) or
 * `HAND_MADE_DIR` (no/foreign marker).
 */
export type CopySlotState =
    | 'ABSENT'
    | 'OK_LINK'
    | 'DANGLING_LINK'
    | 'FOREIGN_LINK'
    | 'IDENTITY_MISMATCH'
    | 'UNOWNED_TARGET'
    | 'COPY_SLOT'
    | 'HAND_MADE_DIR'
    /** Race-swap: the cascade re-lstat saw a real dir appear mid-inspection. */
    | 'CONFLICT_REAL_DIR'
    | 'NOT_DIRECTORY';

/** The identity a copy slot must prove to count as engine-managed. */
export interface CopySlotIdentity {
    projectId: string;
    itemId: string;
}

/** `ERR_*`-family code: a real, unowned directory occupies the slot. */
export const ERR_COPY_SLOT_HAND_MADE = 'ERR_COPY_SLOT_HAND_MADE';
/** `ERR_*`-family code: the slot path is neither a directory nor a link. */
export const ERR_COPY_SLOT_NOT_DIRECTORY = 'ERR_COPY_SLOT_NOT_DIRECTORY';
/** `ERR_*`-family code: a link exists inside the slot (gate step 3). */
export const ERR_COPY_SLOT_LINK_INSIDE = 'ERR_COPY_SLOT_LINK_INSIDE';

export interface MaterializeSlotInspection {
    state: CopySlotState;
    /** Human-readable context; carries the ERR_* code where one applies. */
    detail?: string;
}

export interface InspectMaterializeSlotOptions {
    /** Path semantics for delegation and joins; never process.platform. */
    platform: LinkPlatform;
    /**
     * Ownership probe for the dist directory (the link cascade's stage 4),
     * injected exactly as `attachWorkshopLink` takes it. Required for
     * link-state classification to reach OK_LINK.
     */
    readMarker?: (distDir: string) => Promise<unknown>;
    /**
     * Copy-marker probe for the SLOT directory. Returns the parsed marker
     * or undefined when absent/unparseable. Absent reader ⇒ a real
     * directory can never prove ownership (HAND_MADE_DIR — safe default).
     */
    readCopyMarker?: (slotDir: string) => Promise<unknown>;
    /**
     * The identity a copy slot must prove. Required together with
     * `readCopyMarker` for the COPY_SLOT classification.
     */
    copyIdentity?: CopySlotIdentity;
}

/** One-line failure description with the errno code, for `detail`. */
function describeFailure(op: string, subject: string, error: unknown): string {
    const code =
        typeof error === 'object' && error !== null
            ? (error as { code?: unknown }).code
            : undefined;
    const message = error instanceof Error ? error.message : String(error);
    const withCode = typeof code === 'string' ? ` [${code}]` : '';
    return `${op} ${subject} failed${withCode}: ${message}`;
}

function errnoOf(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string') return code;
    }
    return undefined;
}

/**
 * Walks the slot and records every file's `[size, mtimeMs]` under its
 * item-relative POSIX path. Captured at the marker-AFTER write (the
 * content the tool last wrote). Links and the copy marker itself are
 * skipped: links cannot exist behind the gate, and a link appearing
 * mid-walk is ignored rather than followed. Directories are structure,
 * never keys — the toggle's drift walk re-derives them.
 */
export async function buildSlotManifest(
    copyFs: CopyFs,
    platform: LinkPlatform,
    slotDir: string,
): Promise<SlotManifest> {
    const manifest: SlotManifest = {};
    const walk = async (dir: string, prefix: string): Promise<void> => {
        const entries = await copyFs.readdirEntries(dir);
        for (const entry of entries) {
            if (entry.name === COPY_MARKER_FILENAME) continue;
            if (entry.isSymbolicLink()) continue;
            const absolute = joinUnder(platform, dir, entry.name);
            const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                await walk(absolute, rel);
                continue;
            }
            const stats = await copyFs.stat(absolute);
            manifest[rel] = [stats.size, stats.mtimeMs];
        }
    };
    await walk(slotDir, '');
    return manifest;
}

/** Does a parsed copy marker prove this identity's ownership of the slot? */
function copyMarkerMatches(
    parsed: unknown,
    identity: CopySlotIdentity,
): boolean {
    if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
    ) {
        return false;
    }
    const marker = parsed as Record<string, unknown>;
    return (
        marker.mode === 'copy' &&
        marker.projectId === identity.projectId &&
        marker.itemId === identity.itemId
    );
}

/**
 * Classifies the deployment slot `W` against the expected dist directory
 * `D`: link-shaped entries delegate to the link manager's cascade; a real
 * directory is classified by its copy marker; everything else refuses.
 */
export async function inspectMaterializeSlot(
    fs: LinkFs,
    W: string,
    D: string,
    opts: InspectMaterializeSlotOptions,
): Promise<MaterializeSlotInspection> {
    let entry: StatsLike;
    try {
        entry = await fs.lstat(W);
    } catch (e) {
        if (errnoOf(e) === 'ENOENT') return { state: 'ABSENT' };
        throw e;
    }

    if (entry.isSymbolicLink()) {
        // Delegate the full link cascade — target, identity, ownership.
        // (A cascade re-lstat losing the race with a delete reports
        // ATTACHABLE — from this caller's view the slot is simply absent
        // again.)
        const link = await inspectWorkshopLink(fs, W, pathResolve(D), {
            platform: opts.platform,
            readMarker: opts.readMarker,
        });
        const state: CopySlotState =
            link.state === 'ATTACHABLE' ? 'ABSENT' : link.state;
        return { state, detail: link.detail };
    }

    if (entry.isDirectory()) {
        if (!opts.readCopyMarker || !opts.copyIdentity) {
            return {
                state: 'HAND_MADE_DIR',
                detail: `${ERR_COPY_SLOT_HAND_MADE}: no copy-marker reader injected — a real directory at ${W} cannot prove engine ownership`,
            };
        }
        const parsed = await opts.readCopyMarker(W);
        if (copyMarkerMatches(parsed, opts.copyIdentity)) {
            return { state: 'COPY_SLOT' };
        }
        // An EMPTY real dir is adoptable (the attachment table's
        // auto-replace parity): reconcile re-verifies emptiness behind its
        // own gate before writing anything.
        const contents = await fs.readdir(W);
        if (contents.length === 0) {
            return { state: 'COPY_SLOT' };
        }
        return {
            state: 'HAND_MADE_DIR',
            detail: `${ERR_COPY_SLOT_HAND_MADE}: a real directory without a matching copy marker occupies ${W} — hand-made content is never adopted`,
        };
    }

    return {
        state: 'NOT_DIRECTORY',
        detail: `${ERR_COPY_SLOT_NOT_DIRECTORY}: deployment slot is neither a directory nor a link`,
    };
}

/** Thrown by the tree walks on gate violations; surfaced, never fatal. */
class CopyGateError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

function joinUnder(platform: LinkPlatform, dir: string, name: string): string {
    const pathImpl = platform === 'win32' ? pathWin32 : pathPosix;
    return pathImpl.join(dir, name);
}

/**
 * Gate step 3: every entry in the slot tree must be a real file or
 * directory — one link anywhere inside means a prune could follow it
 * outside the deployment root, so the whole slot refuses.
 */
async function assertNoLinksInside(
    copyFs: CopyFs,
    platform: LinkPlatform,
    root: string,
): Promise<void> {
    const entries = await copyFs.readdirEntries(root);
    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            throw new CopyGateError(
                ERR_COPY_SLOT_LINK_INSIDE,
                `${ERR_COPY_SLOT_LINK_INSIDE}: a link entry '${entry.name}' exists inside ${root} — refusing any slot mutation (a nested link could redirect a prune outside the deployment root)`,
            );
        }
        if (entry.isDirectory()) {
            await assertNoLinksInside(
                copyFs,
                platform,
                joinUnder(platform, root, entry.name),
            );
        }
    }
}

export interface ReconcileCopySlotOptions extends InspectMaterializeSlotOptions {
    /**
     * Writes/refreshes the copy marker at the slot (the host's core-backed
     * writer). Called once BEFORE the pass and once AFTER it — an
     * interrupted copy leaves an owned slot the next run self-heals.
     * Only the AFTER call carries the slot manifest.
     */
    writeCopyMarker?: (
        slotDir: string,
        files?: SlotManifest,
    ) => Promise<unknown>;
}

export type ReconcileResult = {
    ok: boolean;
    /**
     * Inspection states, plus the reconcile-only failure states. A failed
     * pass must never reuse `COPY_SLOT` (the healthy slot label) — callers
     * surface the state verbatim, and a failure reading as a healthy slot
     * is indistinguishable in a log. `UNLINK_FAILED` is the pre-copy lock
     * (the game holding the junction open), distinct from a mid-walk
     * `RECONCILE_FAILED` so telemetry can tell the two apart.
     */
    state: CopySlotState | 'RECONCILE_FAILED' | 'UNLINK_FAILED';
    filesCopied?: number;
    filesPruned?: number;
    detail?: string;
};

/** Recursively removes one slot entry bottom-up; refuses links on sight.
 * Returns the number of leaf files deleted (directories are structure). */
async function removeSlotEntry(
    copyFs: CopyFs,
    platform: LinkPlatform,
    dir: string,
    entry: CopyDirEntry,
): Promise<number> {
    const path = joinUnder(platform, dir, entry.name);
    if (entry.isSymbolicLink()) {
        throw new CopyGateError(
            ERR_COPY_SLOT_LINK_INSIDE,
            `${ERR_COPY_SLOT_LINK_INSIDE}: refusing to prune link entry ${path}`,
        );
    }
    if (entry.isDirectory()) {
        let pruned = 0;
        const children = await copyFs.readdirEntries(path);
        for (const child of children) {
            pruned += await removeSlotEntry(copyFs, platform, path, child);
        }
        await copyFs.rmdir(path);
        return pruned;
    }
    await copyFs.unlink(path);
    return 1;
}

/** Copies one dist entry (file or tree) into the slot, preserving mtimes.
 * Returns the number of leaf files written. */
async function copyEntry(
    copyFs: CopyFs,
    platform: LinkPlatform,
    distDir: string,
    slotDir: string,
    entry: CopyDirEntry,
): Promise<number> {
    const from = joinUnder(platform, distDir, entry.name);
    const to = joinUnder(platform, slotDir, entry.name);
    if (entry.isSymbolicLink()) {
        // Model B keeps dist link-free (alias-route guard); a link here is
        // a build-side violation — fail closed rather than deref it.
        throw new CopyGateError(
            ERR_COPY_SLOT_LINK_INSIDE,
            `${ERR_COPY_SLOT_LINK_INSIDE}: refusing to copy link entry ${from} (dist must be link-free)`,
        );
    }
    if (entry.isDirectory()) {
        await copyFs.mkdir(to);
        let copied = 0;
        const children = await copyFs.readdirEntries(from);
        for (const child of children) {
            copied += await copyEntry(copyFs, platform, from, to, child);
        }
        return copied;
    }
    const data = await copyFs.readFile(from);
    await copyFs.writeFile(to, data);
    // Preserve the source mtime (as a Date — fs.utimes interprets bare
    // numbers as SECONDS) so the next pass's mtime+size comparison sees
    // the slot copy as unchanged and reconciliation converges. The Date
    // projection drops sub-ms precision; the change comparison below
    // carries a matching 1 ms tolerance.
    const stats = await copyFs.stat(from);
    const stamp = new Date(stats.mtimeMs);
    await copyFs.utimes(to, stamp, stamp);
    return 1;
}

/** One reconciliation pass over one directory pair (mutual recursion). */
async function syncTree(
    copyFs: CopyFs,
    platform: LinkPlatform,
    distDir: string,
    slotDir: string,
    tally: { filesCopied: number; filesPruned: number },
): Promise<void> {
    const distEntries = await copyFs.readdirEntries(distDir);
    const slotEntries = await copyFs.readdirEntries(slotDir);
    const slotByName = new Map(
        slotEntries.map((entry) => [entry.name, entry] as const),
    );

    for (const distEntry of distEntries) {
        // The copy marker is the slot's own ownership trace — the host's
        // writer places it before/after the pass; a sync pass neither
        // copies nor prunes it.
        if (distEntry.name === COPY_MARKER_FILENAME) {
            continue;
        }
        const from = joinUnder(platform, distDir, distEntry.name);
        const to = joinUnder(platform, slotDir, distEntry.name);
        const slotEntry = slotByName.get(distEntry.name);
        const slotIsRealDir =
            slotEntry !== undefined &&
            slotEntry.isDirectory() &&
            !slotEntry.isSymbolicLink();
        if (distEntry.isDirectory()) {
            if (!slotIsRealDir) {
                // Missing at the slot, or a file/link occupies the name —
                // remove whatever is there and copy the tree fresh.
                if (slotEntry) {
                    tally.filesPruned += await removeSlotEntry(
                        copyFs,
                        platform,
                        slotDir,
                        slotEntry,
                    );
                }
                tally.filesCopied += await copyEntry(
                    copyFs,
                    platform,
                    distDir,
                    slotDir,
                    distEntry,
                );
                continue;
            }
            await syncTree(copyFs, platform, from, to, tally);
            continue;
        }
        // dist file: copy when missing, mistyped, or changed (size, or
        // mtime beyond the 1 ms Date-projection tolerance).
        if (!slotEntry || slotIsRealDir || slotEntry.isSymbolicLink()) {
            if (slotEntry) {
                tally.filesPruned += await removeSlotEntry(
                    copyFs,
                    platform,
                    slotDir,
                    slotEntry,
                );
            }
            tally.filesCopied += await copyEntry(
                copyFs,
                platform,
                distDir,
                slotDir,
                distEntry,
            );
            continue;
        }
        const distStats = await copyFs.stat(from);
        const slotStats = await copyFs.stat(to);
        if (
            distStats.size !== slotStats.size ||
            Math.abs(distStats.mtimeMs - slotStats.mtimeMs) >= 1
        ) {
            tally.filesCopied += await copyEntry(
                copyFs,
                platform,
                distDir,
                slotDir,
                distEntry,
            );
        }
    }

    const distNames = new Set(distEntries.map((entry) => entry.name));
    for (const slotEntry of slotEntries) {
        if (
            !distNames.has(slotEntry.name) &&
            slotEntry.name !== COPY_MARKER_FILENAME
        ) {
            tally.filesPruned += await removeSlotEntry(
                copyFs,
                platform,
                slotDir,
                slotEntry,
            );
        }
    }
}

/**
 * The §6.3 reconciliation pass behind the 4-step gate: gate (real dir +
 * matching marker + no links inside — an empty real dir is adopted), then
 * marker BEFORE the pass, the sync tree walk, then the marker refresh.
 * The slot must already be link-free at the top: a symlink at `W` refuses
 * (the caller unlinks owned junctions first via `materializeCopySlot`).
 */
export async function reconcileCopySlot(
    copyFs: CopyFs,
    D: string,
    W: string,
    opts: ReconcileCopySlotOptions,
): Promise<ReconcileResult> {
    try {
        let entry: CopyStats;
        try {
            entry = await copyFs.lstat(W);
        } catch (e) {
            if (errnoOf(e) === 'ENOENT') {
                await copyFs.mkdir(W);
                entry = await copyFs.lstat(W);
            } else {
                throw e;
            }
        }
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
            return {
                ok: false,
                state: 'NOT_DIRECTORY',
                detail: `${ERR_COPY_SLOT_NOT_DIRECTORY}: reconcile requires a real directory at ${W} (an owned junction must be unlinked first)`,
            };
        }

        // Gate steps 2-4 on a non-empty slot; an empty slot is adopted.
        const existing = await copyFs.readdirEntries(W);
        if (existing.length > 0) {
            if (!opts.readCopyMarker || !opts.copyIdentity) {
                return {
                    ok: false,
                    state: 'HAND_MADE_DIR',
                    detail: `${ERR_COPY_SLOT_HAND_MADE}: no copy-marker reader injected — refusing to reconcile a non-empty slot`,
                };
            }
            const parsed = await opts.readCopyMarker(W);
            if (!copyMarkerMatches(parsed, opts.copyIdentity)) {
                return {
                    ok: false,
                    state: 'HAND_MADE_DIR',
                    detail: `${ERR_COPY_SLOT_HAND_MADE}: a real directory without a matching copy marker occupies ${W} — hand-made content is never adopted`,
                };
            }
            await assertNoLinksInside(copyFs, opts.platform, W);
        }

        if (opts.writeCopyMarker) {
            await opts.writeCopyMarker(W);
        }
        const tally = { filesCopied: 0, filesPruned: 0 };
        await syncTree(copyFs, opts.platform, D, W, tally);
        if (opts.writeCopyMarker) {
            await opts.writeCopyMarker(
                W,
                await buildSlotManifest(copyFs, opts.platform, W),
            );
        }
        return { ok: true, state: 'COPY_SLOT', ...tally };
    } catch (e) {
        if (e instanceof CopyGateError) {
            return { ok: false, state: 'RECONCILE_FAILED', detail: e.message };
        }
        return {
            ok: false,
            state: 'COPY_SLOT',
            detail: describeFailure('reconcile', `${D} -> ${W}`, e),
        };
    }
}

export interface MaterializeCopySlotOptions
    extends InspectMaterializeSlotOptions, ReconcileCopySlotOptions {}

/**
 * The copy column of the §6.5 transition table, in one call: inspect the
 * slot, unlink an owned junction BEFORE any copy (owner hard rule), then
 * reconcile behind the gate. HAND_MADE_DIR / FOREIGN_LINK /
 * IDENTITY_MISMATCH / NOT_DIRECTORY refuse with their `ERR_*` detail —
 * recovery is the caller's flag surface (`--backup-existing-workshop`,
 * `--relink`), never an automatic delete. The copy caller does not wire a
 * backup path today, so its refusal text must not promise one.
 */
export async function materializeCopySlot(
    copyFs: CopyFs,
    linkFs: LinkFs,
    realFs: RealFs,
    W: string,
    D: string,
    opts: MaterializeCopySlotOptions,
): Promise<ReconcileResult> {
    const inspection = await inspectMaterializeSlot(linkFs, W, D, opts);
    switch (inspection.state) {
        case 'ABSENT':
        case 'COPY_SLOT':
            return reconcileCopySlot(copyFs, D, W, opts);
        case 'OK_LINK':
        case 'DANGLING_LINK':
        case 'UNOWNED_TARGET': {
            // Owner hard rule: unlink the junction FIRST — link-only
            // removal (O(1) reparse-point deletion, dist untouched) —
            // then reconcile into the vacated slot. Copying through the
            // link is forbidden: it would write into dist from the
            // deployment side. UNOWNED_TARGET joins the unlinkable rows:
            // the link already resolves to D (cascade stages 2-3 proved
            // it), unlinking a link destroys no data, and refusing here
            // would strand the deployment on a missing dist marker.
            // FOREIGN_LINK (points elsewhere) and IDENTITY_MISMATCH stay
            // refused — recovery is the caller's flag surface
            // (`--backup-existing-workshop`, `--relink`).
            try {
                await realFs.unlink(W);
            } catch (e) {
                return {
                    ok: false,
                    state: 'UNLINK_FAILED',
                    detail: describeFailure('unlink', W, e),
                };
            }
            return reconcileCopySlot(copyFs, D, W, opts);
        }
        case 'HAND_MADE_DIR':
            return {
                ok: false,
                state: inspection.state,
                detail: inspection.detail,
            };
        case 'NOT_DIRECTORY':
            return {
                ok: false,
                state: inspection.state,
                detail: inspection.detail,
            };
        default:
            // FOREIGN_LINK / IDENTITY_MISMATCH / UNOWNED_TARGET: the link
            // cascade's refusals carry their own codes — surface, don't fix.
            return {
                ok: false,
                state: inspection.state,
                detail: inspection.detail,
            };
    }
}

// ---------------------------------------------------------------------------
// COPY_SLOT -> junction toggle (Batch B): drift-gated auto-replace
// ---------------------------------------------------------------------------

export type RemoveCleanResult = {
    ok: boolean;
    state:
        | 'COPY_SLOT_REPLACED' // proven clean, slot deleted (W now absent)
        | 'COPY_SLOT_DRIFT' // hand-edit / extra file / no manifest — refuse
        | 'RECONCILE_FAILED' // fs error, race, planted link — refuse
        | 'HAND_MADE_DIR' // marker absent/mismatched at toggle time
        | 'NOT_DIRECTORY'; // W is neither a real dir nor anything usable
    detail?: string;
};

const NO_SLOT_MANIFEST_DETAIL =
    'no slot manifest — pre-manifest marker; run a copy-mode build to upgrade it';

/**
 * Strictly validates the marker's optional `files` field: a non-array
 * object whose every value is a `[number, number]` tuple. Anything else
 * (absent, arrays, strings, partial tuples) yields undefined — the toggle
 * then refuses rather than trusting an unproven cleanliness claim.
 */
function readSlotManifest(parsed: unknown): SlotManifest | undefined {
    if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
    ) {
        return undefined;
    }
    const files = (parsed as Record<string, unknown>).files;
    if (files === null || typeof files !== 'object' || Array.isArray(files)) {
        return undefined;
    }
    const manifest: SlotManifest = {};
    for (const [key, value] of Object.entries(
        files as Record<string, unknown>,
    )) {
        if (!Array.isArray(value) || value.length !== 2) return undefined;
        const [size, mtimeMs] = value;
        if (typeof size !== 'number' || typeof mtimeMs !== 'number') {
            return undefined;
        }
        manifest[key] = [size, mtimeMs];
    }
    return manifest;
}

/** Joins an item-relative POSIX key under a root with the host separator. */
function joinRelative(
    platform: LinkPlatform,
    root: string,
    rel: string,
): string {
    const pathImpl = platform === 'win32' ? pathWin32 : pathPosix;
    return pathImpl.join(root, ...rel.split('/'));
}

/**
 * One current slot file against the manifest: the fast path is the same
 * size + mtime (1 ms Date tolerance) check `syncTree` uses. A manifest
 * mismatch falls to tier (iii) — dist's counterpart, size-matched and
 * byte-compared. dist is consulted ONLY here (materialize runs after the
 * build rewrote dist, so comparing against it wholesale would false-drift).
 * Any read error means unproven ⇒ not clean.
 */
async function slotFileIsProvenClean(
    copyFs: CopyFs,
    platform: LinkPlatform,
    W: string,
    D: string,
    rel: string,
    current: [size: number, mtimeMs: number],
    recorded: [size: number, mtimeMs: number] | undefined,
): Promise<boolean> {
    if (
        recorded !== undefined &&
        recorded[0] === current[0] &&
        Math.abs(recorded[1] - current[1]) < 1
    ) {
        return true;
    }
    try {
        const distPath = joinRelative(platform, D, rel);
        const distStats = await copyFs.stat(distPath);
        if (distStats.size !== current[0]) return false;
        const [distBytes, slotBytes] = await Promise.all([
            copyFs.readFile(distPath),
            copyFs.readFile(joinRelative(platform, W, rel)),
        ]);
        return (
            Buffer.compare(Buffer.from(distBytes), Buffer.from(slotBytes)) === 0
        );
    } catch {
        return false;
    }
}

/**
 * Tier (i): every CURRENT file must either match the manifest (ii) or,
 * byte-identical to dist (iii). A manifest file MISSING from the slot is
 * clean by decision — a deletion adds no unique content (its source is
 * dist). Returns the first unproven relative path.
 */
async function firstDriftingPath(
    copyFs: CopyFs,
    platform: LinkPlatform,
    W: string,
    D: string,
    manifest: SlotManifest,
): Promise<string | undefined> {
    const current = await buildSlotManifest(copyFs, platform, W);
    for (const [rel, stats] of Object.entries(current)) {
        const clean = await slotFileIsProvenClean(
            copyFs,
            platform,
            W,
            D,
            rel,
            stats,
            manifest[rel],
        );
        if (!clean) return rel;
    }
    return undefined;
}

/**
 * Recursive delete inside the gated slot. Every entry is re-`lstat`ed
 * immediately before acting (TOCTOU guard): links and files are unlinked —
 * never followed — and only a real directory recurses. The caller rmdirs
 * the slot root after this returns.
 */
async function removeSlotTree(
    copyFs: CopyFs,
    platform: LinkPlatform,
    dir: string,
): Promise<void> {
    const entries = await copyFs.readdirEntries(dir);
    for (const entry of entries) {
        const path = joinUnder(platform, dir, entry.name);
        const current = await copyFs.lstat(path);
        if (current.isSymbolicLink()) {
            await copyFs.unlink(path);
            continue;
        }
        if (current.isDirectory()) {
            await removeSlotTree(copyFs, platform, path);
            await copyFs.rmdir(path);
            continue;
        }
        await copyFs.unlink(path);
    }
}

/**
 * Spec §6.5 row: COPY_SLOT × mode 'symlink' — re-gate the slot, prove the
 * MANIFEST's content is what still sits there (three drift tiers), then
 * delete it so the caller can attach a junction. Refusals are never fatal
 * to a build and NEVER delete unproven content: a hand-edit, an extra
 * entry, a legacy marker (interrupted pass), a planted link, or any fs
 * doubt refuses with its state and detail. Races re-`lstat` and refuse
 * `NOT_DIRECTORY`/`RECONCILE_FAILED` instead of improvising a delete.
 */
export async function removeCleanCopySlot(
    copyFs: CopyFs,
    W: string,
    D: string,
    opts: ReconcileCopySlotOptions,
): Promise<RemoveCleanResult> {
    try {
        let entry: CopyStats;
        try {
            entry = await copyFs.lstat(W);
        } catch (e) {
            if (errnoOf(e) === 'ENOENT') {
                return {
                    ok: false,
                    state: 'NOT_DIRECTORY',
                    detail: `${ERR_COPY_SLOT_NOT_DIRECTORY}: the copy slot at ${W} vanished before the toggle`,
                };
            }
            throw e;
        }
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
            return {
                ok: false,
                state: 'NOT_DIRECTORY',
                detail: `${ERR_COPY_SLOT_NOT_DIRECTORY}: ${W} is no longer a real directory (the toggle only replaces a copy slot)`,
            };
        }
        if (!opts.readCopyMarker || !opts.copyIdentity) {
            return {
                ok: false,
                state: 'HAND_MADE_DIR',
                detail: `${ERR_COPY_SLOT_HAND_MADE}: no copy-marker reader injected — the slot at ${W} cannot prove engine ownership`,
            };
        }
        const parsed = await opts.readCopyMarker(W);
        if (!copyMarkerMatches(parsed, opts.copyIdentity)) {
            return {
                ok: false,
                state: 'HAND_MADE_DIR',
                detail: `${ERR_COPY_SLOT_HAND_MADE}: a real directory without a matching copy marker occupies ${W} — hand-made content is never adopted`,
            };
        }
        const manifest = readSlotManifest(parsed);
        if (manifest === undefined) {
            return {
                ok: false,
                state: 'COPY_SLOT_DRIFT',
                detail: NO_SLOT_MANIFEST_DETAIL,
            };
        }
        // Gate step 3 — the same link scan the reconcile pass runs.
        await assertNoLinksInside(copyFs, opts.platform, W);
        const drift = await firstDriftingPath(
            copyFs,
            opts.platform,
            W,
            D,
            manifest,
        );
        if (drift !== undefined) {
            return {
                ok: false,
                state: 'COPY_SLOT_DRIFT',
                detail: `the slot no longer matches its manifest (first difference: '${drift}') — hand-edited content is never deleted; run a copy-mode build to reconcile it, or move the folder OUT of the deployment root by hand`,
            };
        }
        await removeSlotTree(copyFs, opts.platform, W);
        await copyFs.rmdir(W);
        return { ok: true, state: 'COPY_SLOT_REPLACED' };
    } catch (e) {
        if (e instanceof CopyGateError) {
            return { ok: false, state: 'RECONCILE_FAILED', detail: e.message };
        }
        return {
            ok: false,
            state: 'RECONCILE_FAILED',
            detail: describeFailure('toggle', W, e),
        };
    }
}
