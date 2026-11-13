/**
 * Dist-model build surface (CLI): the per-item ownership-marker write for
 * the standalone build path and the post-build workshop link step.
 *
 * Model B in one paragraph: canonical artifacts build into a project-local
 * output root (`dist/`); each built item gets a `.pzstudio-output.json`
 * ownership marker (core, Task 3); after the build, every built item is
 * exposed to the game through a pzstudio-managed junction
 * `<workshopRoot>/<Item>` -> `<outDir>/<Item>` maintained by the
 * platform-node link manager (Tasks 1-2). The engine never mutates through
 * the link — the junction is outward-facing only.
 *
 * Mode gate: the link step (and the build-path marker write) run ONLY when
 * the resolved `outdir` sits inside the project root — the dist model. An
 * outdir outside the project root is legacy mode: today's in-place behavior
 * unchanged, zero link activity (doctor surfaces the migration diagnostic).
 *
 * Why a private ProjectFileSystem slice: the standalone build path writes
 * the marker through `writeOutputMarker` (core), which needs
 * `read/write/delete`. `NodeFileSystem` imports from `'fs'`, which
 * build.test.ts auto-mocks wholesale; this adapter rides `'node:fs/promises'`
 * (a different module id) so the build command stays testable under that
 * mock. `readOutputMarker`/`writeOutputMarker` consume exactly these three
 * operations.
 */
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore - necessary because we can't reliably predict if typescript will resolve this outside src without structural errors in some configs
import { version } from '../../package.json';
/* eslint-enable @typescript-eslint/ban-ts-comment */
import fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join as pathJoin, relative, resolve } from 'node:path';
import {
    attachWorkshopLink,
    inspectMaterializeSlot,
    materializeCopySlot,
    removeCleanCopySlot,
    type AttachResult,
    type CopyFs,
    type LinkFs,
    type RealFs,
} from '@pzstudio/platform-node';
import type {
    DirectoryEntry,
    FileObjectType,
    FileStat,
    ProjectFileSystem,
} from '@pzstudio/platform';
import {
    computeProjectId,
    copyMarkerPath,
    markerPath,
    readCopySlotMarker,
    readOutputMarker,
    writeCopySlotMarker,
    writeOutputMarker,
    type IProjectConfig,
    type MaterializeMode,
} from '@pzstudio/core';
import { expandOutdirToken, distRootOf } from './helper';
import { getUsageRecorder } from './usage';
import {
    USAGE_OP_LINK_ATTACH,
    USAGE_OP_LINK_BACKUP,
    USAGE_OP_MATERIALIZE_COPY,
    USAGE_OP_MATERIALIZE_TOGGLE,
} from './usage';
import type { UsageRecorder } from './usage';

/** Machine-level workshop root when neither config nor env provides one.
 * Computed at CALL time, not import time — the vitest setup re-points
 * homedir() at a temp home, and a module-load constant would freeze the
 * real user profile before that happens. */
function defaultWorkshopRoot(): string {
    return pathJoin(homedir(), 'Zomboid', 'Workshop');
}

/** Config values the dist-model decision consumes (project + global merge). */
export interface DistModelConfig {
    outdir?: string;
    workshopRoot?: string;
}

export interface DistModel {
    mode: 'dist' | 'legacy';
    outDir: string;
    workshopRoot: string;
}

/**
 * Resolves the dist-model decision for one build: dist mode iff the
 * resolved `outdir` sits inside the resolved project root (unset defaults
 * to `<projectRoot>/dist`). The boundary is a `path.relative` check, so a
 * shared string prefix never confuses a sibling directory, and an outdir
 * equal to the project root itself is legacy — the dist model requires a
 * dedicated artifact directory.
 *
 * `outDir` is returned in the CONFIG'S OWN SPELLING (verbatim, not
 * resolved): `planBuild`, the executor and the F23-WRITE guard all consume
 * `config.outdir` verbatim, and the guard's inside-output-root comparison
 * breaks when the caller hands it a differently-spelled root (a POSIX-style
 * `/out` config would resolve to `E:\out` and every mutation would be
 * refused). Resolution is only for the boundary check and the junction
 * paths the link step joins itself.
 *
 * `workshopRoot` precedence: `PZSTUDIO_WORKSHOP_ROOT` env > explicit
 * config > the factory default (`%USERPROFILE%\Zomboid\Workshop`) —
 * the documented order (docs/cli/07-config-files.md).
 */
export function resolveDistModel(
    projectRoot: string,
    config: DistModelConfig,
): DistModel {
    const root = resolve(projectRoot);
    const outDir = config.outdir ?? pathJoin(root, 'dist');
    const rel = relative(root, resolve(outDir));
    const mode: DistModel['mode'] =
        rel === '' || rel.startsWith('..') ? 'legacy' : 'dist';
    const workshopRoot = resolve(
        process.env.PZSTUDIO_WORKSHOP_ROOT ??
            config.workshopRoot ??
            defaultWorkshopRoot(),
    );
    return { mode, outDir, workshopRoot };
}

// ---------------------------------------------------------------------------
// Dist-always + materialization (2026-11-12 amendment): the canonical build
// root is ALWAYS `<projectRoot>/dist` (anchored in gatherPlanInput); the
// user's `outdir` is the DEPLOYMENT target and the materialize step bridges
// the two — mode 'symlink' junctions each item into the target, mode 'copy'
// maintains a verified, reconciled real copy there.
// ---------------------------------------------------------------------------

/** The materialize decision for one build/sync invocation. */
export interface MaterializationResolution {
    /**
     * 'skip' — no deployment this invocation: no target configured
     * (pure build mode, the amendment's esbuild story) or the caller
     * passed --no-materialize. There is deliberately no 'none'/'skip'
     * config value — this state is only ever RESOLVED, never stored.
     */
    action: 'skip' | 'materialize';
    /** The resolved mode (meaningful even when skipping, for doctor UX). */
    mode: MaterializeMode;
    /**
     * The expanded absolute deployment root; set iff
     * action === 'materialize'.
     */
    outDir?: string;
    /** The canonical build output root `<projectRoot>/dist`. */
    distRoot: string;
    /**
     * Symlink mode only: the deployment root is a UNC/network volume —
     * junctions fail-closed there (doctor renders NON_LOCAL_TARGET). Set
     * by the doctor's host computation; the build path never consults it.
     */
    targetNonLocal?: boolean;
}

export interface ResolveMaterializationInput {
    /** The RESOLVED absolute project root. */
    projectRoot: string;
    /**
     * The EFFECTIVE outdir — the getOutDir cascade result (project.json >
     * host settings > global config, tilde-expanded, absolute) or
     * undefined when no tier configures one.
     */
    effectiveOutdir?: string;
    /** `project.json` `build.materialize`. */
    projectMaterialize?: MaterializeMode;
    /** Machine-level flat `materialize` from `~/.pzstudio/config.json`. */
    globalMaterialize?: MaterializeMode;
    /** `--materialize=<symlink|copy>` — wins over both config layers. */
    flagMaterialize?: MaterializeMode;
    /** `--no-materialize` — skip deployment for this invocation. */
    noMaterialize?: boolean;
}

/**
 * Resolves the materialize decision (amendment §3 cascade): CLI flag >
 * project.json `build.materialize` > global flat `materialize` > hard
 * default 'symlink'; the action is 'skip' when no target exists or
 * --no-materialize was passed. Mode without a target is inert (the mode
 * still resolves for doctor's UX).
 */
export function resolveMaterialization(
    input: ResolveMaterializationInput,
): MaterializationResolution {
    const mode =
        input.flagMaterialize ??
        input.projectMaterialize ??
        input.globalMaterialize ??
        'symlink';
    if (input.noMaterialize || !input.effectiveOutdir) {
        return {
            action: 'skip',
            mode,
            distRoot: distRootOf(input.projectRoot),
        };
    }
    return {
        action: 'materialize',
        mode,
        outDir: expandOutdirToken(input.effectiveOutdir),
        distRoot: distRootOf(input.projectRoot),
    };
}

/**
 * A node:fs/promises-backed ProjectFileSystem that mirrors NodeFileSystem's
 * URI scheme and stat/list semantics verbatim (plain absolute paths and
 * file:// URIs both accepted; list reports symbolicLink entries; stat
 * follows links like fs.stat). Deliberately NOT an import of
 * `NodeFileSystem` — that class sources from `'fs'`, which build.test.ts
 * auto-mocks wholesale; this mirror rides `'node:fs/promises'`, a different
 * module id, so the standalone build command stays testable under that mock.
 * `writeOutputMarker` consumes read/write/delete/stat/list (its
 * assertNoAliasRoute walk needs the directory listing).
 */
function toFsPath(uri: string): string {
    return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
}

function joinUri(dirUri: string, name: string): string {
    const base = dirUri.startsWith('file:')
        ? dirUri.replace(/\/+$/, '')
        : pathToFileURL(dirUri.replace(/[\\/]+$/, '')).href;
    return `${base}/${encodeURIComponent(name)}`;
}

function toObjectType(stats: {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}): FileObjectType {
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    if (stats.isSymbolicLink()) return 'symbolicLink';
    return 'unknown';
}

export const promisesFileSystem: ProjectFileSystem = {
    async read(uri: string): Promise<Uint8Array> {
        const buffer = await fsp.readFile(toFsPath(uri));
        return new Uint8Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength,
        );
    },
    async write(uri: string, data: Uint8Array): Promise<void> {
        await fsp.writeFile(toFsPath(uri), data);
    },
    async delete(uri: string): Promise<void> {
        await fsp.unlink(toFsPath(uri));
    },
    async stat(uri: string): Promise<FileStat> {
        const stats = await fsp.stat(toFsPath(uri));
        return {
            type: toObjectType(stats),
            ctime: stats.ctimeMs,
            mtime: stats.mtimeMs,
            size: stats.size,
        };
    },
    async list(uri: string): Promise<DirectoryEntry[]> {
        const entries = await fsp.readdir(toFsPath(uri), {
            withFileTypes: true,
        });
        return entries.map((entry) => ({
            name: entry.name,
            uri: joinUri(uri, entry.name),
            type: entry.isSymbolicLink() ? 'symbolicLink' : toObjectType(entry),
        }));
    },
};

/** The cascade's read seam over the same real fs (structurally exact). */
export const nodeLinkFs: LinkFs = {
    lstat: (p) => fsp.lstat(p),
    readlink: (p) => fsp.readlink(p),
    stat: (p, opts) => fsp.stat(p, opts),
    realpath: (p) => fsp.realpath(p),
    readdir: (p) => fsp.readdir(p),
};

/**
 * The copy materializer's seam over the same real fs (structurally exact):
 * the reconcile pass walks, copies (mtime-preserving), prunes and gates —
 * its full fs surface rides `node:fs/promises`, the same module id as
 * `nodeLinkFs`, so tests mock one module to cover both.
 */
export const nodeCopyFs: CopyFs = {
    lstat: (p) => fsp.lstat(p),
    stat: (p) => fsp.stat(p),
    readdirEntries: (p) => fsp.readdir(p, { withFileTypes: true }),
    readFile: (p) => fsp.readFile(p),
    writeFile: (p, data) => fsp.writeFile(p, data),
    mkdir: async (p) => {
        // fsp.mkdir (recursive) resolves to the first created path — the
        // seam's contract is void.
        await fsp.mkdir(p, { recursive: true });
    },
    unlink: (p) => fsp.unlink(p),
    rmdir: (p) => fsp.rmdir(p),
    utimes: (p, atime, mtime) => fsp.utimes(p, atime, mtime),
};

/** The mutation seam is fs.promises itself (RealFs is its exact slice). */
const nodeRealFs = fsp as unknown as RealFs;

/**
 * Writes the per-item ownership marker for one successfully built variant
 * on the standalone build path. The session path (watch/devsync) writes
 * its own markers through `BuildSession`; the assembly is shared
 * (`buildOutputMarker`), so marker content is identical on both paths.
 * Dist mode only — legacy outdirs have no junction cascade to prove
 * ownership to.
 */
export async function writeBuiltItemMarker(
    config: IProjectConfig,
    variant: 'main' | 'development',
    projectPath: string,
    outputRoot: string,
): Promise<void> {
    await writeOutputMarker(promisesFileSystem, {
        config,
        variant,
        projectDir: resolve(projectPath),
        engineVersion: version,
        outputRoot,
    });
}

export interface AttachBuiltItemsInput {
    /** The RESOLVED absolute project root (hashed into the identity check). */
    projectRoot: string;
    /** The resolved dist output root (items live directly under it). */
    outDir: string;
    /** The resolved workshop root (junction slots live directly under it). */
    workshopRoot: string;
    /** Item directory names to link (one per successfully built variant). */
    itemNames: string[];
    backupExisting?: boolean;
    forceLink?: boolean;
    /**
     * The GENERATED workshop.txt content per item name (what the build just
     * wrote into dist). Feeds the refuse-path duplicate-publish diagnosis:
     * a workshop.txt id in the real slot that the source does not carry
     * means the next upload would publish a NEW item instead of updating.
     */
    sourceWorkshopTxtByItem?: Record<string, string>;
    /** Defaults to the host platform (caller's privilege, never the module's). */
    platform?: 'win32' | 'posix';
    /** Test seams; default to the real fs. */
    linkFs?: LinkFs;
    realFs?: RealFs;
    markerFs?: ProjectFileSystem;
    /** Usage recorder slice; defaults to the process recorder. */
    usage?: Pick<UsageRecorder, 'recordOp'>;
    /** Console surface (info for attaches, warn for refusals/failures). */
    onSurface?: (line: string, level: 'info' | 'warn') => void;
}

export type AttachOutcome = {
    itemName: string;
    error?: string;
} & Partial<AttachResult> & {
        ok: boolean;
    };

/**
 * The ownership readMarker the cascade consumes: parses the item marker via
 * the dist directory and matches it against THIS project's identity hash
 * (strict compare — the reader does not validate fields). Shared by the
 * build's link step and the doctor's host-side link checks.
 */
export function workshopReadMarker(
    projectRoot: string,
    markerFs: ProjectFileSystem = promisesFileSystem,
): (distDir: string) => Promise<unknown> {
    return async (distDir) => {
        const expected = await computeProjectId(resolve(projectRoot));
        const marker = await readOutputMarker(markerFs, markerPath(distDir));
        return marker && marker.projectId === expected ? marker : undefined;
    };
}

/**
 * Attaches one workshop junction per built item. NON-FATAL by contract:
 * a refusal, a thrown fs error, or a foreign slot never propagates — every
 * outcome is recorded, surfaced with its error code, and the remaining
 * items still attach. Usage events carry no paths or item names.
 */
export async function attachBuiltItems(
    input: AttachBuiltItemsInput,
): Promise<AttachOutcome[]> {
    const platform =
        input.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
    const linkFs = input.linkFs ?? nodeLinkFs;
    const realFs = input.realFs ?? nodeRealFs;
    const markerFs = input.markerFs ?? promisesFileSystem;
    const usage = input.usage ?? getUsageRecorder();
    const flags: string[] = [];
    if (input.backupExisting) flags.push('backup-existing-workshop');
    if (input.forceLink) flags.push('relink');

    const results: AttachOutcome[] = [];
    for (const itemName of input.itemNames) {
        const W = pathJoin(input.workshopRoot, itemName);
        const D = pathJoin(input.outDir, itemName);
        let outcome: AttachOutcome;
        try {
            const result = await attachWorkshopLink(linkFs, realFs, W, D, {
                platform,
                backupExisting: input.backupExisting,
                forceLink: input.forceLink,
                sourceWorkshopTxt: input.sourceWorkshopTxtByItem?.[itemName],
                readMarker: workshopReadMarker(input.projectRoot, markerFs),
            });
            outcome = { ...result, itemName };
        } catch (e) {
            outcome = {
                itemName,
                ok: false,
                error: e instanceof Error ? e.message : String(e),
            };
        }
        results.push(outcome);

        usage.recordOp({
            op: USAGE_OP_LINK_ATTACH,
            host: 'cli',
            durMs: 0,
            status: outcome.ok ? 'ok' : 'error',
            err: outcome.ok
                ? undefined
                : {
                      code: outcome.state ?? 'ATTACH_FAILED',
                      where: USAGE_OP_LINK_ATTACH,
                  },
            flags,
        });
        if (outcome.backupPath) {
            usage.recordOp({
                op: USAGE_OP_LINK_BACKUP,
                host: 'cli',
                durMs: 0,
                status: 'ok',
                flags,
            });
        }

        const surface = input.onSurface ?? defaultSurface;
        if (outcome.ok) {
            surface(
                `Workshop link attached: '${itemName}' -> ${input.workshopRoot}`,
                'info',
            );
        } else if (outcome.state === 'CONFLICT_REAL_DIR') {
            surface(
                `Workshop link refused for '${itemName}' [${outcome.state}]: ${outcome.detail ?? outcome.error ?? ''}` +
                    (outcome.hasUnsyncedWorkshopId
                        ? ` The existing folder's workshop.txt carries a Steam workshop id the source does not (duplicate-publish hazard).`
                        : '') +
                    ` Run with --backup-existing-workshop to move the existing folder aside.`,
                'warn',
            );
        } else if (outcome.error) {
            surface(
                `Workshop link failed for '${itemName}': ${outcome.error}`,
                'warn',
            );
        } else {
            surface(
                `Workshop link refused for '${itemName}' [${outcome.state}]: ${outcome.detail ?? ''}`,
                'warn',
            );
        }
    }
    return results;
}

/**
 * The build command's link-step gate: dist mode attaches one junction per
 * built item; legacy mode is a hard no-op — nothing is created, nothing is
 * attempted (Review Focus 6). Empty item lists are a no-op in both modes.
 *
 * Superseded by `maybeMaterializeBuiltItems` (the dist-always amendment);
 * kept until the doctor retarget removes its last caller.
 */
export async function maybeLinkBuiltItems(
    distModel: DistModel,
    itemNames: string[],
    rest: Omit<AttachBuiltItemsInput, 'outDir' | 'workshopRoot' | 'itemNames'>,
): Promise<AttachOutcome[]> {
    if (distModel.mode !== 'dist' || itemNames.length === 0) {
        return [];
    }
    return attachBuiltItems({
        ...rest,
        outDir: distModel.outDir,
        workshopRoot: distModel.workshopRoot,
        itemNames,
    });
}

/** Input for the per-item materialize step (both modes). */
export interface MaterializeBuiltItemsInput {
    /** The RESOLVED absolute project root (hashed into the identity). */
    projectRoot: string;
    /** The expanded absolute deployment root (slots live under it). */
    outDir: string;
    /** The canonical build output root `<projectRoot>/dist`. */
    distRoot: string;
    /** Item directory names to materialize (one per built variant). */
    itemNames: string[];
    /** Symlink mode: rename a conflicting real dir aside before attaching. */
    backupExisting?: boolean;
    /** Symlink mode: replace a foreign link slot. */
    forceLink?: boolean;
    /**
     * Symlink mode: the GENERATED workshop.txt content per item name (what
     * the build just wrote into dist) — feeds the refuse-path
     * duplicate-publish diagnosis.
     */
    sourceWorkshopTxtByItem?: Record<string, string>;
    /** Test seams; default to the real fs. */
    linkFs?: LinkFs;
    realFs?: RealFs;
    copyFs?: CopyFs;
    markerFs?: ProjectFileSystem;
    /** Defaults to the host platform (caller's privilege, never the module's). */
    platform?: 'win32' | 'posix';
    /** Usage recorder slice; defaults to the process recorder. */
    usage?: Pick<UsageRecorder, 'recordOp'>;
    /** Console surface (info for successes, warn for refusals/failures). */
    onSurface?: (line: string, level: 'info' | 'warn') => void;
}

export type MaterializeOutcome = {
    itemName: string;
    error?: string;
} & {
    ok: boolean;
    state?: string;
    detail?: string;
    filesCopied?: number;
    filesPruned?: number;
};

/**
 * The copy-mode materialize pass: one verified, reconciled real copy per
 * built item, through the platform-node copy materializer's 4-step gate.
 * NON-FATAL by contract (the same rule as the link step): every refusal,
 * gate violation, or fs failure is recorded and surfaced; the remaining
 * items still materialize. The deployment root itself is created if
 * missing (a fresh `~/Zomboid/Workshop`). One `materialize.copy` usage op
 * per item; the one-line optimization hint prints once per invocation.
 */
async function copyMaterializeBuiltItems(
    input: MaterializeBuiltItemsInput,
): Promise<MaterializeOutcome[]> {
    const platform =
        input.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
    const linkFs = input.linkFs ?? nodeLinkFs;
    const realFs = input.realFs ?? nodeRealFs;
    const copyFs = input.copyFs ?? nodeCopyFs;
    const markerFs = input.markerFs ?? promisesFileSystem;
    const usage = input.usage ?? getUsageRecorder();
    const surface = input.onSurface ?? defaultSurface;
    const outDir = resolve(input.outDir);
    const distRoot = resolve(input.distRoot);
    const projectId = await computeProjectId(resolve(input.projectRoot));

    try {
        // A fresh deployment root (init wrote the tilde token, but the
        // folder itself may not exist until the first game install).
        await fsp.mkdir(outDir, { recursive: true });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const failed: MaterializeOutcome[] = input.itemNames.map(
            (itemName) => ({
                itemName,
                ok: false,
                state: 'DEPLOY_ROOT_UNAVAILABLE',
                detail: `deployment root ${outDir} could not be created: ${message}`,
            }),
        );
        for (const outcome of failed) {
            usage.recordOp({
                op: USAGE_OP_MATERIALIZE_COPY,
                host: 'cli',
                durMs: 0,
                status: 'error',
                err: { code: outcome.state!, where: USAGE_OP_MATERIALIZE_COPY },
            });
            surface(
                `Deployment failed for '${outcome.itemName}': ${outcome.detail}`,
                'warn',
            );
        }
        return failed;
    }

    const results: MaterializeOutcome[] = [];
    let anyOk = false;
    for (const itemName of input.itemNames) {
        const W = pathJoin(outDir, itemName);
        const D = pathJoin(distRoot, itemName);
        let outcome: MaterializeOutcome;
        try {
            const result = await materializeCopySlot(
                copyFs,
                linkFs,
                realFs,
                W,
                D,
                {
                    platform,
                    readMarker: workshopReadMarker(input.projectRoot, markerFs),
                    readCopyMarker: (slotDir) =>
                        readCopySlotMarker(markerFs, copyMarkerPath(slotDir)),
                    writeCopyMarker: async (slotDir, files) => {
                        await writeCopySlotMarker(markerFs, {
                            projectDir: resolve(input.projectRoot),
                            itemId: itemName,
                            slotDir,
                            files,
                        });
                    },
                    copyIdentity: { projectId, itemId: itemName },
                },
            );
            outcome = { ...result, itemName };
        } catch (e) {
            outcome = {
                itemName,
                ok: false,
                error: e instanceof Error ? e.message : String(e),
            };
        }
        results.push(outcome);
        if (outcome.ok) anyOk = true;

        usage.recordOp({
            op: USAGE_OP_MATERIALIZE_COPY,
            host: 'cli',
            durMs: 0,
            status: outcome.ok ? 'ok' : 'error',
            err: outcome.ok
                ? undefined
                : {
                      code: outcome.state ?? 'MATERIALIZE_COPY_FAILED',
                      where: USAGE_OP_MATERIALIZE_COPY,
                  },
        });

        if (outcome.ok) {
            surface(
                `Deployed (copy): '${itemName}' -> ${outDir}` +
                    (outcome.filesCopied || outcome.filesPruned
                        ? ` (${outcome.filesCopied ?? 0} copied, ${outcome.filesPruned ?? 0} pruned)`
                        : ''),
                'info',
            );
        } else if (outcome.state === 'HAND_MADE_DIR') {
            surface(
                `Copy deployment refused for '${itemName}' [${outcome.state}]: ${outcome.detail ?? outcome.error ?? ''}` +
                    ` Move it OUT of the deployment root by hand (copy mode — the game scans that folder, a renamed folder inside it still registers as a duplicate mod), or run build with --backup-existing-workshop (symlink mode).`,
                'warn',
            );
        } else if (outcome.error) {
            surface(
                `Copy deployment failed for '${itemName}': ${outcome.error}`,
                'warn',
            );
        } else {
            surface(
                `Copy deployment refused for '${itemName}' [${outcome.state}]: ${outcome.detail ?? ''}`,
                'warn',
            );
        }
    }

    if (anyOk) {
        // Owner requirement: copying gets an optimization hint — the
        // default 'symlink' mode exposes dist/ with zero copy cost.
        surface(
            `Tip: materialize mode "symlink" (the default) exposes dist/ to the game with zero copy cost under watch — copy mode re-copies changed files on every build.`,
            'info',
        );
    }
    return results;
}

/**
 * The COPY_SLOT → junction pre-pass: for every item whose deployment slot
 * is an engine-owned real copy, prove (manifest + zero links + drift tiers)
 * that it is clean, delete it, and hand the item to the junction attach.
 * Refusals never abort — they become outcomes with their state/detail, keep
 * the slot intact, and exclude the item from attach (a real dir at W could
 * only refuse there too). An empty real dir is adopted exactly as the
 * attach table does (auto-replace parity).
 */
async function replaceProvenCleanCopySlots(
    materialization: MaterializationResolution,
    itemNames: string[],
    rest: Omit<MaterializeBuiltItemsInput, 'outDir' | 'distRoot' | 'itemNames'>,
): Promise<{ attachNames: string[]; outcomes: MaterializeOutcome[] }> {
    const platform =
        rest.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
    const linkFs = rest.linkFs ?? nodeLinkFs;
    const copyFs = rest.copyFs ?? nodeCopyFs;
    const markerFs = rest.markerFs ?? promisesFileSystem;
    const usage = rest.usage ?? getUsageRecorder();
    const surface = rest.onSurface ?? defaultSurface;
    const outDir = materialization.outDir!;
    const distRoot = materialization.distRoot;
    const projectId = await computeProjectId(resolve(rest.projectRoot));
    const readMarker = workshopReadMarker(rest.projectRoot, markerFs);
    const readCopyMarker = (slotDir: string) =>
        readCopySlotMarker(markerFs, copyMarkerPath(slotDir));

    const attachNames: string[] = [];
    const outcomes: MaterializeOutcome[] = [];
    for (const itemName of itemNames) {
        const W = pathJoin(outDir, itemName);
        const D = pathJoin(distRoot, itemName);
        try {
            const inspection = await inspectMaterializeSlot(linkFs, W, D, {
                platform,
                readMarker,
                readCopyMarker,
                copyIdentity: { projectId, itemId: itemName },
            });
            if (inspection.state !== 'COPY_SLOT') {
                // ABSENT / link states keep their pre-Batch-B behavior:
                // the attach pass owns them.
                attachNames.push(itemName);
                continue;
            }
            const result = await removeCleanCopySlot(copyFs, W, D, {
                platform,
                readMarker,
                readCopyMarker,
                copyIdentity: { projectId, itemId: itemName },
            });
            usage.recordOp({
                op: USAGE_OP_MATERIALIZE_TOGGLE,
                host: 'cli',
                durMs: 0,
                status: result.ok ? 'ok' : 'error',
                err: result.ok
                    ? undefined
                    : {
                          code: result.state,
                          where: USAGE_OP_MATERIALIZE_TOGGLE,
                      },
            });
            if (result.ok) {
                // The slot is gone (or was an empty dir): attach recreates
                // it as a junction in the same run.
                attachNames.push(itemName);
                continue;
            }
            outcomes.push({
                itemName,
                ok: false,
                state: result.state,
                detail: result.detail,
            });
            surface(
                `Copy slot toggle refused for '${itemName}' [${result.state}]: ${result.detail ?? ''}` +
                    ` Move it OUT of the deployment root by hand (the game scans that folder, a renamed folder inside it still registers as a duplicate mod), or run build with --backup-existing-workshop (symlink mode).`,
                'warn',
            );
        } catch (e) {
            // Non-fatal contract: one item's inspection/mutation failure
            // never escapes the materialize step.
            const detail = e instanceof Error ? e.message : String(e);
            outcomes.push({
                itemName,
                ok: false,
                state: 'RECONCILE_FAILED',
                detail,
            });
            usage.recordOp({
                op: USAGE_OP_MATERIALIZE_TOGGLE,
                host: 'cli',
                durMs: 0,
                status: 'error',
                err: {
                    code: 'RECONCILE_FAILED',
                    where: USAGE_OP_MATERIALIZE_TOGGLE,
                },
            });
            surface(
                `Copy slot toggle failed for '${itemName}': ${detail}`,
                'warn',
            );
        }
    }
    return { attachNames, outcomes };
}

/**
 * The materialize step gate: skip / empty item lists are no-ops; symlink
 * mode delegates to the junction attach (the 2026-11-11 link step, W =
 * `<target>/<Item>`, D = `dist/<Item>`); copy mode runs the reconciling
 * copy pass. Non-fatal either way — outcomes are recorded and surfaced.
 */
export async function maybeMaterializeBuiltItems(
    materialization: MaterializationResolution,
    itemNames: string[],
    rest: Omit<MaterializeBuiltItemsInput, 'outDir' | 'distRoot' | 'itemNames'>,
): Promise<MaterializeOutcome[]> {
    if (materialization.action !== 'materialize' || itemNames.length === 0) {
        return [];
    }
    if (materialization.mode === 'copy') {
        return copyMaterializeBuiltItems({
            ...rest,
            outDir: materialization.outDir!,
            distRoot: materialization.distRoot,
            itemNames,
        });
    }
    // Best-effort deploy-root creation for the junction path too: a fresh
    // machine has no `~/Zomboid/Workshop` yet, and symlink(2) fails ENOENT
    // on a missing parent. A failure here surfaces per item through the
    // attach outcomes (non-fatal), never aborts the build.
    await fsp
        .mkdir(materialization.outDir!, { recursive: true })
        .catch(() => {});
    const prePass = await replaceProvenCleanCopySlots(
        materialization,
        itemNames,
        rest,
    );
    if (prePass.attachNames.length === 0) {
        return prePass.outcomes;
    }
    const attached = await attachBuiltItems({
        ...rest,
        outDir: materialization.distRoot,
        workshopRoot: materialization.outDir!,
        itemNames: prePass.attachNames,
    });
    return [...prePass.outcomes, ...attached];
}

function defaultSurface(line: string, level: 'info' | 'warn'): void {
    if (level === 'warn') {
        console.warn(line);
    } else {
        console.log(line);
    }
}
