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
 * the link â€” the junction is outward-facing only.
 *
 * Mode gate: the link step (and the build-path marker write) run ONLY when
 * the resolved `outdir` sits inside the project root â€” the dist model. An
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
    type AttachResult,
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
    markerPath,
    readOutputMarker,
    writeOutputMarker,
    type IProjectConfig,
} from '@pzstudio/core';
import { getUsageRecorder } from './usage';
import { USAGE_OP_LINK_ATTACH, USAGE_OP_LINK_BACKUP } from './usage';
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

/**
 * A node:fs/promises-backed ProjectFileSystem that mirrors NodeFileSystem's
 * URI scheme and stat/list semantics verbatim (plain absolute paths and
 * file:// URIs both accepted; list reports symbolicLink entries; stat
 * follows links like fs.stat). Deliberately NOT an import of
 * `NodeFileSystem` â€” that class sources from `'fs'`, which build.test.ts
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

const promisesFileSystem: ProjectFileSystem = {
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

/** The mutation seam is fs.promises itself (RealFs is its exact slice). */
const nodeRealFs = fsp as unknown as RealFs;

/**
 * Writes the per-item ownership marker for one successfully built variant
 * on the standalone build path. The session path (watch/devsync) writes
 * its own markers through `BuildSession`; the assembly is shared
 * (`buildOutputMarker`), so marker content is identical on both paths.
 * Dist mode only â€” legacy outdirs have no junction cascade to prove
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

function defaultSurface(line: string, level: 'info' | 'warn'): void {
    if (level === 'warn') {
        console.warn(line);
    } else {
        console.log(line);
    }
}
