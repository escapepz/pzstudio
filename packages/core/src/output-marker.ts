/**
 * Per-item output ownership marker (dist model).
 *
 * Every workshop item directory a build produces (`<outDir>/<Item>/`) gets
 * a `.pzstudio-output.json` marker after its plan completes. The workshop
 * link cascade (platform-node) reads this marker via the dist directory
 * only — presence plus a matching `projectId` is what makes a dist
 * directory "ours"; anything else reports UNOWNED_TARGET and is refused.
 *
 * Decisions recorded here (spec §3 + ownership ledger):
 *
 * - `projectId` = the first 16 hex characters of the SHA-256 digest of the
 *   RESOLVED ABSOLUTE project root (canonical spelling: backslashes fold
 *   to '/', trailing separators drop, a Windows drive letter is lowercased
 *   — the one case-insensitive component, the same precedent the executor's
 *   destination-chain comparison uses). Hashing the root rather than the
 *   project name is fail-safe ownership: moving a project invalidates its
 *   own marker (doctor surfaces UNOWNED_TARGET with re-adopt guidance) and
 *   two same-named projects can never adopt each other's output. The digest
 *   comes from `globalThis.crypto.subtle` (browser-safe, no Node builtin);
 *   when the host provides none, marker writing fails and the item stays
 *   unowned (fail-closed) instead of falling back to a weaker identity.
 * - Atomicity: the ProjectFileSystem contract has no rename, so the write
 *   is tmp-write → final-write → tmp-delete. The tmp copy is a write-ahead
 *   artifact of the exact payload (diagnosable if the process dies); a
 *   failed cleanup leaves a harmless orphan that the item's next full
 *   build wipes with the rest of the directory. A torn final write leaves
 *   unparseable JSON, which readOutputMarker reports as absent — the
 *   cascade then refuses the item (UNOWNED_TARGET) rather than trusting a
 *   half-written marker.
 * - Idempotency: every field is deterministic for a given item build
 *   (schemaVersion, engine, engineVersion, projectId, itemTitle, mods)
 *   EXCEPT `createdAt` — kept per the marker schema as the build timestamp,
 *   and the only field allowed to differ between identical rebuilds.
 * - `engineVersion` cannot come from core (the browser-safe package has no
 *   access to the CLI package's version): the host supplies it through the
 *   session's `BuildSessionHost.engineVersion`. Absent hosts record
 *   'unknown' — the field is informational and never matched by the
 *   ownership check.
 */
import type { ProjectFileSystem } from '@pzstudio/platform';
import {
    collectIncludedModIds,
    itemTitleForVariant,
    joinPosix,
    modIdForVariant,
    resolveBuildOutputPath,
} from './buildplan';
import type { IProjectConfig } from './project';
import { decodeUtf8, encodeUtf8 } from './execute';
import { assertNoAliasRoute } from './mutation-guard';

/** The marker file every built item directory carries at its root. */
export const OUTPUT_MARKER_FILENAME = '.pzstudio-output.json';

const OUTPUT_MARKER_SCHEMA_VERSION = 1;
const OUTPUT_MARKER_ENGINE = 'pzstudio';
/** Length, in hex characters, of the projectId digest prefix (8 bytes). */
const PROJECT_ID_HEX_LENGTH = 16;
/** Fallback when the host did not provide an engine version. */
const UNKNOWN_ENGINE_VERSION = 'unknown';

/** Ownership marker written into every built item directory. */
export interface OutputMarker {
    schemaVersion: typeof OUTPUT_MARKER_SCHEMA_VERSION;
    engine: typeof OUTPUT_MARKER_ENGINE;
    engineVersion: string;
    projectId: string;
    itemTitle: string;
    /** Every mod id built into the item (development: suffixed `_dev`). */
    mods: string[];
    createdAt: string;
}

export interface OutputMarkerInput {
    /** Fully-resolved project config (outdir absolute). */
    config: IProjectConfig;
    variant: 'main' | 'development';
    /**
     * The RESOLVED ABSOLUTE project root — hashed into `projectId`. Hosts
     * hand the session an absolute path already; a relative spelling would
     * still hash deterministically but would not identify the project
     * across moves, which is the whole point of the hash.
     */
    projectDir: string;
    /** Host-provided engine version; 'unknown' when absent. */
    engineVersion?: string;
    /**
     * Declared build output root for the alias-route guard (F23-WRITE P0).
     * Optional like the executor's: without it the write is unguarded.
     */
    outputRoot?: string;
}

/** Minimal structural slice of the Web Crypto SubtleCrypto interface. */
interface SubtleCryptoLike {
    digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

/**
 * Canonical spelling of a project root for identity hashing: backslashes
 * fold to '/', trailing separators drop, and a Windows drive letter is
 * lowercased (the one case-insensitive path component — the same precedent
 * the executor's destination-chain comparison uses). Everything else
 * compares case-sensitively.
 */
function canonicalProjectRoot(projectRoot: string): string {
    const unified = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const driveMatch = /^([a-zA-Z]):/.exec(unified);
    if (!driveMatch) {
        return unified;
    }
    return `${driveMatch[1].toLowerCase()}${unified.slice(1)}`;
}

/**
 * The stable project identity hashed into the marker: the first 16 hex
 * characters of the SHA-256 digest of the canonical project root. Throws
 * when the host has no Web Crypto — marker writing fails (the item stays
 * unowned, fail-closed) instead of silently degrading the identity.
 */
export async function computeProjectId(projectRoot: string): Promise<string> {
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCryptoLike } })
        .crypto?.subtle;
    if (!subtle) {
        throw new Error(
            'SHA-256 is unavailable in this host (globalThis.crypto.subtle is missing): the output ownership marker cannot identify the project.',
        );
    }
    const digest = new Uint8Array(
        await subtle.digest(
            'SHA-256',
            encodeUtf8(canonicalProjectRoot(projectRoot)),
        ),
    );
    let hex = '';
    const bytes = Math.min(PROJECT_ID_HEX_LENGTH / 2, digest.length);
    for (let i = 0; i < bytes; i += 1) {
        hex += digest[i].toString(16).padStart(2, '0');
    }
    return hex;
}

/** The marker path inside one item directory: `<itemDir>/.pzstudio-output.json`. */
export function markerPath(itemDir: string): string {
    return joinPosix(itemDir, OUTPUT_MARKER_FILENAME);
}

/**
 * Assembles the marker for one built item (no I/O): item title and mod ids
 * come from the planner (development variant carries the ` - dev_branch`
 * title suffix and the `_dev` mod ids), projectId from the hashed project
 * root, createdAt from the clock. The only non-deterministic field is
 * `createdAt` — see the idempotency note in the module header.
 */
export async function buildOutputMarker(
    input: Omit<OutputMarkerInput, 'outputRoot'>,
): Promise<OutputMarker> {
    return {
        schemaVersion: OUTPUT_MARKER_SCHEMA_VERSION,
        engine: OUTPUT_MARKER_ENGINE,
        engineVersion: input.engineVersion ?? UNKNOWN_ENGINE_VERSION,
        projectId: await computeProjectId(input.projectDir),
        itemTitle: itemTitleForVariant(input.config, input.variant),
        mods: collectIncludedModIds(input.config, input.variant).map((modId) =>
            modIdForVariant(modId, input.variant),
        ),
        createdAt: new Date().toISOString(),
    };
}

/**
 * Writes the ownership marker for one built item's directory (the variant's
 * output root, e.g. `<outDir>/<Item>`), through the injected filesystem.
 * Both the tmp and the final leaf are guarded against alias routes when an
 * output root is declared (F23-WRITE P0 — the same guard every plan
 * mutation runs). Returns the written marker.
 */
export async function writeOutputMarker(
    fs: ProjectFileSystem,
    input: OutputMarkerInput,
): Promise<OutputMarker> {
    const marker = await buildOutputMarker(input);
    const target = markerPath(
        resolveBuildOutputPath(input.config, input.variant),
    );
    const tmpTarget = `${target}.tmp`;
    const content = encodeUtf8(`${JSON.stringify(marker, null, 2)}\n`);
    await assertNoAliasRoute(
        fs,
        input.outputRoot,
        target,
        'write',
        `output marker write '${target}'`,
    );
    await assertNoAliasRoute(
        fs,
        input.outputRoot,
        tmpTarget,
        'write',
        `output marker tmp write '${tmpTarget}'`,
    );
    // tmp first (write-ahead copy of the exact payload), then the final
    // path, then the tmp cleanup — see the atomicity note in the header.
    await fs.write(tmpTarget, content);
    await fs.write(target, content);
    await fs.delete(tmpTarget);
    return marker;
}

/**
 * Reads and parses an ownership marker. Absent, unreadable or unparseable
 * content — and non-object JSON — yields undefined; this function never
 * throws. The cascade treats undefined as "unowned" and refuses the item,
 * so a torn or foreign marker can never grant ownership.
 */
export async function readOutputMarker(
    fs: ProjectFileSystem,
    path: string,
): Promise<OutputMarker | undefined> {
    let raw: Uint8Array;
    try {
        raw = await fs.read(path);
    } catch {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(decodeUtf8(raw));
        if (parsed === null || typeof parsed !== 'object') {
            return undefined;
        }
        return parsed as OutputMarker;
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Copy-slot marker — the deployment root's ownership trace (2026-11-12
// amendment §6.1). DISTINCT from the output marker on purpose: a plain copy
// of `dist/<Item>` already carries `.pzstudio-output.json`, so checking only
// that file would misclassify a hand-copied, hand-edited folder as an
// engine-managed slot. `projectId` reuses `computeProjectId` — one identity
// implementation, two markers.
// ---------------------------------------------------------------------------

/** The copy-ownership marker every engine-managed copy slot carries. */
export const COPY_MARKER_FILENAME = '.pzstudio-copy.json';

const COPY_MARKER_SCHEMA_VERSION = 1;
const COPY_MARKER_MODE = 'copy';

/**
 * The content the tool last wrote into one copy slot: item-relative POSIX
 * path → `[size, mtimeMs]`. The copy marker itself is never a key. Keys are
 * always '/'-joined, whatever the host separator.
 */
export type SlotManifest = Record<string, [size: number, mtimeMs: number]>;

/** Ownership marker written into every engine-managed copy slot. */
export interface CopySlotMarker {
    schemaVersion: typeof COPY_MARKER_SCHEMA_VERSION;
    mode: typeof COPY_MARKER_MODE;
    /** Same hash as the output marker's projectId. */
    projectId: string;
    /** The item directory name the slot mirrors. */
    itemId: string;
    createdAt: string;
    /**
     * Optional since the toggle landed (Batch B): markers written by an
     * interrupted pass (marker-before only) carry no manifest, and a
     * copy→symlink toggle refuses those rather than guessing cleanliness.
     */
    files?: SlotManifest;
}

export interface CopySlotMarkerInput {
    /** The RESOLVED ABSOLUTE project root — hashed into `projectId`. */
    projectDir: string;
    /** The item directory name the slot mirrors. */
    itemId: string;
    /** The slot's content as of this write; omitted by the marker-before write. */
    files?: SlotManifest;
}

/** The copy-marker path inside one deployment slot: `<slotDir>/.pzstudio-copy.json`. */
export function copyMarkerPath(slotDir: string): string {
    return joinPosix(slotDir, COPY_MARKER_FILENAME);
}

/**
 * Assembles the copy-slot marker (no I/O): projectId from the hashed
 * project root (the same identity the output marker carries), itemId from
 * the mirrored item, createdAt from the clock.
 */
export async function buildCopySlotMarker(
    input: CopySlotMarkerInput,
): Promise<CopySlotMarker> {
    return {
        schemaVersion: COPY_MARKER_SCHEMA_VERSION,
        mode: COPY_MARKER_MODE,
        projectId: await computeProjectId(input.projectDir),
        itemId: input.itemId,
        createdAt: new Date().toISOString(),
        ...(input.files !== undefined ? { files: input.files } : {}),
    };
}

/**
 * Writes the copy-slot marker for one deployment slot through the injected
 * filesystem (tmp → final → tmp-delete, the output marker's atomic shape —
 * no rename on the ProjectFileSystem contract). NOT alias-route guarded:
 * the write happens inside the copy materializer's 4-step gate (platform-node),
 * which has already proven the slot is a real link-free directory — the gate
 * is the protection here, the way the F23 guard is for the output marker.
 */
export async function writeCopySlotMarker(
    fs: ProjectFileSystem,
    input: CopySlotMarkerInput & { slotDir: string },
): Promise<CopySlotMarker> {
    const marker = await buildCopySlotMarker(input);
    const target = copyMarkerPath(input.slotDir);
    const tmpTarget = `${target}.tmp`;
    const content = encodeUtf8(`${JSON.stringify(marker, null, 2)}\n`);
    await fs.write(tmpTarget, content);
    await fs.write(target, content);
    await fs.delete(tmpTarget);
    return marker;
}

/**
 * Reads and parses a copy-slot marker. Absent, unreadable or unparseable
 * content, non-object JSON, and JSON ARRAYS all yield undefined (never
 * throws; unlike the output marker reader, the array admission is not
 * repeated — a copy slot whose marker is anything but the exact object
 * shape is unowned).
 */
export async function readCopySlotMarker(
    fs: ProjectFileSystem,
    path: string,
): Promise<CopySlotMarker | undefined> {
    let raw: Uint8Array;
    try {
        raw = await fs.read(path);
    } catch {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(decodeUtf8(raw));
        if (parsed === null || typeof parsed !== 'object') {
            return undefined;
        }
        if (Array.isArray(parsed)) {
            return undefined;
        }
        return parsed as CopySlotMarker;
    } catch {
        return undefined;
    }
}
