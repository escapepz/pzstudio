/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore - necessary because we can't reliably predict if typescript will resolve this outside src without structural errors in some configs
import { version } from '../../package.json';
/* eslint-enable @typescript-eslint/ban-ts-comment */
import fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join as pathJoin, relative, resolve, sep } from 'node:path';
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

function defaultWorkshopRoot(): string {
    return pathJoin(homedir(), 'Zomboid', 'Workshop');
}

export interface DistModelConfig {
    outdir?: string;
    workshopRoot?: string;
}

export interface DistModel {
    mode: 'dist' | 'legacy';
    outDir: string;
    workshopRoot: string;
}

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

export interface MaterializationResolution {
    action: 'skip' | 'materialize';
    mode: MaterializeMode;
    outDir?: string;
    distRoot: string;
    targetNonLocal?: boolean;
    refused?: string;
    aliasDistRoot?: boolean;
}

export interface ResolveMaterializationInput {
    projectRoot: string;
    effectiveOutdir?: string;
    projectMaterialize?: MaterializeMode;
    globalMaterialize?: MaterializeMode;
    flagMaterialize?: MaterializeMode;
    noMaterialize?: boolean;
}

export function resolveMaterialization(
    input: ResolveMaterializationInput,
): MaterializationResolution {
    const mode =
        input.flagMaterialize ??
        input.projectMaterialize ??
        input.globalMaterialize ??
        'symlink';
    const distRoot = distRootOf(input.projectRoot);
    if (input.noMaterialize || !input.effectiveOutdir) {
        return { action: 'skip', mode, distRoot };
    }
    const outDir = expandOutdirToken(input.effectiveOutdir);
    const resolvedOutDir = resolve(outDir);
    const resolvedProjectRoot = resolve(input.projectRoot);
    const resolvedDistRoot = resolve(distRoot);
    const samePath = (a: string, b: string): boolean =>
        process.platform === 'win32'
            ? a.toLowerCase() === b.toLowerCase()
            : a === b;
    const insideOrEqual = (root: string, target: string): boolean => {
        const cr = process.platform === 'win32' ? root.toLowerCase() : root;
        const ct = process.platform === 'win32' ? target.toLowerCase() : target;
        return ct === cr || ct.startsWith(cr + sep);
    };
    if (samePath(resolvedOutDir, resolvedDistRoot)) {
        return { action: 'skip', mode, distRoot, aliasDistRoot: true };
    }
    if (
        samePath(resolvedOutDir, resolvedProjectRoot) ||
        insideOrEqual(resolvedDistRoot, resolvedOutDir)
    ) {
        const why = samePath(resolvedOutDir, resolvedProjectRoot)
            ? 'it is the project root itself'
            : `it lies inside the build output root '${resolvedDistRoot}'`;
        return {
            action: 'skip',
            mode,
            distRoot,
            refused: `Deployment target '${outDir}' refused — ${why}; deploying there would write links or copies into the source tree.`,
        };
    }
    return { action: 'materialize', mode, outDir, distRoot };
}

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

export const nodeLinkFs: LinkFs = {
    lstat: (p) => fsp.lstat(p),
    readlink: (p) => fsp.readlink(p),
    stat: (p, opts) => fsp.stat(p, opts),
    realpath: (p) => fsp.realpath(p),
    readdir: (p) => fsp.readdir(p),
};

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

const nodeRealFs = fsp as unknown as RealFs;

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
    projectRoot: string;
    outDir: string;
    workshopRoot: string;
    itemNames: string[];
    backupExisting?: boolean;
    forceLink?: boolean;
    sourceWorkshopTxtByItem?: Record<string, string>;
    platform?: 'win32' | 'posix';
    linkFs?: LinkFs;
    realFs?: RealFs;
    markerFs?: ProjectFileSystem;
    usage?: Pick<UsageRecorder, 'recordOp'>;
    onSurface?: (line: string, level: 'info' | 'warn') => void;
}

export type AttachOutcome = {
    itemName: string;
    error?: string;
} & Partial<AttachResult> & {
        ok: boolean;
    };

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

export interface MaterializeBuiltItemsInput {
    projectRoot: string;
    outDir: string;
    distRoot: string;
    itemNames: string[];
    backupExisting?: boolean;
    forceLink?: boolean;
    sourceWorkshopTxtByItem?: Record<string, string>;
    linkFs?: LinkFs;
    realFs?: RealFs;
    copyFs?: CopyFs;
    markerFs?: ProjectFileSystem;
    platform?: 'win32' | 'posix';
    usage?: Pick<UsageRecorder, 'recordOp'>;
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
    prunedPaths?: string[];
};

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
            const prunedPaths = outcome.prunedPaths ?? [];
            for (const prunedPath of prunedPaths) {
                surface(
                    `Pruned hand-made file from deployment slot '${itemName}' (not in the build manifest): ${prunedPath}`,
                    'warn',
                );
            }
            if (prunedPaths.length > 0) {
                surface(
                    `Copy deployment for '${itemName}': ${prunedPaths.length} file(s) outside the build manifest were pruned — rebuilds mirror dist/, hand-made files in the deployment slot do not survive them.`,
                    'warn',
                );
            }
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
        surface(
            `Tip: materialize mode "symlink" (the default) exposes dist/ to the game with zero copy cost under watch — copy mode re-copies changed files on every build.`,
            'info',
        );
    }
    return results;
}

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
