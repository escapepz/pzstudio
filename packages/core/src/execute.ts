/**
 * Generic executor for FileOperation[] plans on an injected ProjectFileSystem.
 *
 * This is the host-agnostic counterpart of the CLI's synchronous build
 * executor: same plan, same ignore semantics, but running through the
 * filesystem contract so the Node adapter, the vscode.workspace.fs adapter
 * and any future host can drive it. The ignore rule handling is a faithful
 * port of the CLI's createIgnoreFilter (closest .pzstudioignore wins, dot
 * files optional, .gitkeep never copied).
 *
 * Known divergence from the synchronous executor: directories whose entire
 * content is filtered out are not materialized in the output (there is no
 * mkdir on the filesystem contract). The game only consumes files, so empty
 * directories have no effect.
 */
import type {
    DirectoryEntry,
    FileObjectType,
    ProjectFileSystem,
} from '@pzstudio/platform';
import type { FileOperation } from './buildplan';
import {
    aliasRouteError,
    assertNoAliasRoute,
    listRouteDirectory,
    lookupRouteEntry,
    MutationRouteOptions,
} from './mutation-guard';

export type OperationLogLevel = 'verbose' | 'info' | 'warn';
export type OperationLogger = (
    level: OperationLogLevel,
    message: string,
) => void;

/** Filter options carried by a copyTree operation. */
export interface CopyTreeOptions {
    excludeIgnoreFile?: boolean;
    ignoreDotFiles?: boolean;
    ignoreItems?: string[];
}

/**
 * Joins path-space segments with '/'. Paths in a build plan are opaque
 * strings in the adapter's accepted space (plain absolute paths for the
 * Node adapter); forward slashes are the common denominator.
 */
export function joinPath(...segments: string[]): string {
    return segments
        .filter((segment) => segment !== '')
        .map((segment) => segment.replace(/\\/g, '/').replace(/\/+$/, ''))
        .filter((segment) => segment !== '')
        .join('/');
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Decodes file content as UTF-8 (ignore rules and generated text). */
export function decodeUtf8(data: Uint8Array): string {
    return TEXT_DECODER.decode(data);
}

/** Encodes a string as UTF-8 bytes for writing. */
export function encodeUtf8(text: string): Uint8Array {
    return TEXT_ENCODER.encode(text);
}

/**
 * Reads the .pzstudioignore entries of one directory, or null when the
 * directory has no readable ignore file. Mirrors the CLI's parsing: lines
 * are trimmed, blanks and comments dropped, backslashes normalized.
 */
async function readIgnoreEntries(
    fs: ProjectFileSystem,
    dirUri: string,
): Promise<string[] | null> {
    let entries: DirectoryEntry[];
    try {
        entries = await fs.list(dirUri);
    } catch {
        return null;
    }
    const ignoreEntry = entries.find(
        (entry) => entry.name === '.pzstudioignore',
    );
    if (!ignoreEntry) {
        return null;
    }
    try {
        const content = decodeUtf8(await fs.read(ignoreEntry.uri));
        const lines = content
            .split(/\r?\n/)
            .map((line) => line.trim().replace(/\\/g, '/'))
            .filter((line) => line && !line.startsWith('#'))
            .map((line) => (line.endsWith('/') ? line.slice(0, -1) : line));
        return lines.length > 0 ? lines : null;
    } catch {
        return null;
    }
}

/**
 * Checks a path (relative to the .pzstudioignore's directory) against that
 * file's entries. Entries only ever ignore: a match means "excluded", a
 * non-match means this file has no verdict for the path and the closest-wins
 * walk stops here with "included".
 */
function matchesIgnoreEntries(entries: string[], relPath: string): boolean {
    for (const entry of entries) {
        if (relPath === entry || relPath.startsWith(`${entry}/`)) {
            return true;
        }
    }
    return false;
}

/**
 * Decides whether a source path is copied by a copyTree with the given
 * options. This is the standalone (non-walking) form of the ignore rules so
 * the sync engine can test a single changed file against the same semantics
 * the full build used, reading .pzstudioignore files through the injected
 * filesystem.
 *
 * @param fs The injected filesystem (used to read .pzstudioignore files)
 * @param sourceRoot The copy root the relative path is measured from
 * @param relativePath The candidate path relative to sourceRoot, '/'-separated
 * @param options The copyTree filter options
 * @returns true when the path would be copied
 */
export async function isSourcePathIncluded(
    fs: ProjectFileSystem,
    sourceRoot: string,
    relativePath: string,
    options: CopyTreeOptions = {},
): Promise<boolean> {
    const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (rel === '') {
        return true; // The root itself
    }
    const segments = rel.split('/');
    const name = segments[segments.length - 1];

    // Rule 0: built-in defaults (mirrors createIgnoreFilter)
    if (name === '.gitkeep') {
        return false;
    }
    if (
        rel === '.git' ||
        rel.startsWith('.git/') ||
        rel === '.github' ||
        rel.startsWith('.github/') ||
        rel === '.gitmodules'
    ) {
        return false;
    }

    // Rule 0.5: optional dotfile ignore
    if (options.ignoreDotFiles && name.startsWith('.')) {
        if (name !== '.pzstudioignore') {
            return false;
        }
    }

    // Rule 1: .pzstudioignore files themselves
    if (name === '.pzstudioignore') {
        return !options.excludeIgnoreFile;
    }

    // Rule 1.5: ignoreItems apply to direct children of the copy root only
    if (
        segments.length === 1 &&
        options.ignoreItems &&
        options.ignoreItems.includes(name)
    ) {
        return false;
    }

    // Rule 2: the closest .pzstudioignore between the entry's parent and the
    // copy root wins. A directory entry is governed by its parent's rules,
    // never by its own (a file in dir D is evaluated against D's rules).
    const parentSegments = segments.slice(0, -1);
    let current = parentSegments;
    while (true) {
        const dirUri = current.length
            ? joinPath(sourceRoot, ...current)
            : sourceRoot;
        const entries = await readIgnoreEntries(fs, dirUri);
        if (entries) {
            const relToDir = segments.slice(current.length).join('/');
            return !matchesIgnoreEntries(entries, relToDir);
        }
        if (current.length === 0) {
            break;
        }
        current = current.slice(0, -1);
    }
    return true;
}

/**
 * Splits a plan-space path into '/'-separated segments. Backslashes fold to
 * '/' (the build plan's common denominator, matching joinPath) and empty
 * segments drop, so leading, trailing and duplicated separators are ignored.
 */
function pathSegments(path: string): string[] {
    return path
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment !== '');
}

/**
 * Locates `candidate` strictly inside `root`, segment-wise. Returns the
 * segments of candidate below root, or null when candidate is not inside
 * root (the common case: the destination lies outside the copied source).
 * Only a Windows drive prefix compares case-insensitively ('C:' vs 'c:');
 * everything else is compared case-sensitively here — case-variant
 * resolution is the destination chain probe's job (resolveDestinationChain).
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

/** How a destination-chain level matches walk-relative path segments. */
type ChainSegment = {
    /** The spelling the walk compares against. */
    segment: string;
    /**
     * 'ci' when the filesystem resolves the plan's spelling onto a
     * differently-cased stored directory, so walk-relative names in ANY
     * case at this level may be the destination and must compare
     * case-insensitively; 'exact' otherwise.
     */
    mode: 'exact' | 'ci';
};

/**
 * Resolves how each destination-chain level is spelled on disk (F23-E1a):
 * the walk consumes on-disk names from fs.list, while the plan spells the
 * destination in config spelling. On a case-insensitive, case-preserving
 * filesystem (NTFS/macOS default) a surviving case-variant ancestor — the
 * outdir root spelled 'GEN' on disk while the config says 'gen', kept
 * through removeDir because only variant folders are removed — made every
 * comparison miss and the walk re-enter its own destination.
 *
 * Per level: an exact on-disk match wins (both filesystem classes;
 * writes into an existing exact spelling resolve to it). Without one, a
 * UNIQUE case-insensitive match counts as the destination only when a
 * stat of the plan-spelled path SUCCEEDS — the witness that this
 * filesystem resolves case-variant spellings onto that stored directory.
 * On a case-sensitive filesystem the same shape fails the stat (the plan
 * path does not exist), so a case-variant twin of the destination stays
 * ordinary source and the fresh destination is matched exactly once the
 * walk creates it — distinct-path semantics are preserved. Levels with no
 * on-disk directory (fresh creation) compare exactly against the plan
 * spelling: everything the copy writes there is plan-spelled.
 *
 * Uses only the ProjectFileSystem contract (list + stat) — no new
 * capability. Bounded: one list + at most one stat per chain level, once
 * per copyTree operation. It does NOT see symlink or short-name (8.3)
 * aliases: containment remains lexical by name (recorded open risk —
 * closing it needs resolved-path identity, which the contract does not
 * expose).
 */
async function resolveDestinationChain(
    fs: ProjectFileSystem,
    sourceRoot: string,
    planSegments: string[],
): Promise<ChainSegment[]> {
    const chain: ChainSegment[] = [];
    let parentUri = sourceRoot;
    let parentReadable = true;
    for (const planSegment of planSegments) {
        if (!parentReadable) {
            chain.push({ segment: planSegment, mode: 'exact' });
            continue;
        }
        let entries: DirectoryEntry[];
        try {
            entries = await fs.list(parentUri);
        } catch {
            parentReadable = false;
            chain.push({ segment: planSegment, mode: 'exact' });
            continue;
        }
        const exact = entries.find((entry) => entry.name === planSegment);
        if (exact) {
            chain.push({ segment: exact.name, mode: 'exact' });
            parentUri = joinPath(parentUri, exact.name);
            continue;
        }
        const lowerPlan = planSegment.toLowerCase();
        const variantMatches = entries.filter(
            (entry) => entry.name.toLowerCase() === lowerPlan,
        );
        // The stat witness: only a filesystem that resolves the plan
        // spelling onto the stored directory may widen this level's
        // comparison to case-insensitive — otherwise a case-variant twin
        // on a case-sensitive filesystem would be wrongly excluded.
        let resolvesVariant = false;
        if (variantMatches.length === 1) {
            try {
                await fs.stat(joinPath(parentUri, planSegment));
                resolvesVariant = true;
            } catch {
                resolvesVariant = false;
            }
        }
        if (resolvesVariant) {
            chain.push({ segment: variantMatches[0].name, mode: 'ci' });
            parentUri = joinPath(parentUri, variantMatches[0].name);
        } else {
            chain.push({ segment: planSegment, mode: 'exact' });
            parentUri = joinPath(parentUri, planSegment);
        }
    }
    return chain;
}

/**
 * Whether a source-relative path steps into the destination's chain.
 * Levels probed as case-variant-resolved compare case-insensitively (the
 * walk's on-disk name may carry either spelling); every other level is
 * segment-exact, so string-prefix siblings never match.
 */
function isInsideDestination(
    relativeSegments: string[],
    destinationChain: ChainSegment[],
): boolean {
    if (relativeSegments.length < destinationChain.length) {
        return false;
    }
    for (let i = 0; i < destinationChain.length; i += 1) {
        const { segment, mode } = destinationChain[i];
        const equal =
            mode === 'ci'
                ? relativeSegments[i].toLowerCase() === segment.toLowerCase()
                : relativeSegments[i] === segment;
        if (!equal) {
            return false;
        }
    }
    return true;
}

/**
 * Recursively copies a source tree into destRoot through the injected
 * filesystem, applying the copyTree ignore options at every depth. Source
 * URIs come from fs.list() (adapter-native); destination URIs are built in
 * the plan's path space. Symbolic links are dereferenced (their targets are
 * copied as regular files), unlike the synchronous executor which copies the
 * link itself.
 *
 * The walk never enters the operation's own destination subtree (F23): when
 * the destination lies inside the source — case-6 layouts, outdir inside a
 * configured mod folder — the live listing would otherwise surface output
 * written moments ago as source, each level re-reading what the previous
 * level wrote with no fixed point. The exclusion compares against the
 * probed on-disk spelling of the destination chain (resolveDestinationChain),
 * so a case-insensitive filesystem's stored case-variant ancestor cannot
 * hide the destination from the walk (F23-E1a). Excluding exactly that
 * subtree keeps every other source path on the existing inclusion policy:
 * stale former output roots, case-variant twins on case-sensitive
 * filesystems, and files under the adopted output root outside this
 * operation's destination are still copied.
 *
 * When `outputRoot` is declared, every write below destRoot is guarded
 * against alias routes (F23-WRITE P0): the destRoot chain is authorized once
 * before the walk, and each source-directory descent lists the corresponding
 * destination directory (when it exists) and refuses any name the walk is
 * about to write onto or descend through that is a symbolicLink entry there
 * — a planted junction at a destination entry redirects every write under it
 * outside the generated territory. Unrelated links in an adopted destination
 * that the walk never touches cause no refusal.
 */
async function copyTree(
    fs: ProjectFileSystem,
    sourceRoot: string,
    destRoot: string,
    options: CopyTreeOptions,
    outputRoot?: string,
): Promise<void> {
    const planSegments = segmentsBelow(sourceRoot, destRoot);
    const destinationChain = planSegments
        ? await resolveDestinationChain(fs, sourceRoot, planSegments)
        : null;
    await assertNoAliasRoute(
        fs,
        outputRoot,
        destRoot,
        'write',
        `copyTree destination '${destRoot}'`,
    );
    const walk = async (dirUri: string, relDir: string): Promise<void> => {
        const entries = await fs.list(dirUri);
        const destDirUri = relDir ? joinPath(destRoot, relDir) : destRoot;
        const destEntries = outputRoot
            ? await listRouteDirectory(
                  fs,
                  `copyTree destination '${destRoot}'`,
                  destDirUri,
                  destDirUri,
              )
            : null;
        for (const entry of entries) {
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (
                destinationChain &&
                isInsideDestination(pathSegments(rel), destinationChain)
            ) {
                continue;
            }
            if (!(await isSourcePathIncluded(fs, sourceRoot, rel, options))) {
                continue;
            }
            const type = await resolveEntryType(fs, entry);
            if (type === 'directory' || type === 'file') {
                const clash = destEntries
                    ? await lookupRouteEntry(
                          fs,
                          destDirUri,
                          destEntries,
                          entry.name,
                      )
                    : null;
                if (clash?.type === 'symbolicLink') {
                    throw aliasRouteError(
                        `copyTree destination '${destRoot}'`,
                        joinPath(destRoot, rel),
                        outputRoot!,
                        clash.name,
                    );
                }
            }
            if (type === 'directory') {
                await walk(entry.uri, rel);
            } else if (type === 'file') {
                await fs.write(
                    joinPath(destRoot, rel),
                    await fs.read(entry.uri),
                );
            }
            // 'unknown' and unreadable entries are skipped silently
        }
    };
    await walk(sourceRoot, '');
}

/** Resolves an entry's effective type, following symbolic links. */
async function resolveEntryType(
    fs: ProjectFileSystem,
    entry: { type: FileObjectType; uri: string },
): Promise<FileObjectType> {
    if (entry.type !== 'symbolicLink') {
        return entry.type;
    }
    try {
        return (await fs.stat(entry.uri)).type;
    } catch {
        // A dangling link cannot be copied as content — skip it.
        return 'unknown';
    }
}

function isLockError(e: unknown): boolean {
    const code = (e as { code?: string } | undefined)?.code;
    return (
        code === 'ENOTEMPTY' ||
        code === 'EBUSY' ||
        code === 'EPERM' ||
        code === 'EACCES'
    );
}

/**
 * Executes a build plan's operations in order against the injected
 * filesystem. Throws on the first failing operation; lock errors
 * (ENOTEMPTY/EBUSY/EPERM/EACCES) surface with the same actionable message
 * the CLI's removeDirRecursive produces.
 *
 * When `options.outputRoot` declares the configured build output root, every
 * mutating operation is guarded against alias routes before it touches the
 * filesystem (F23-WRITE P0, doc 17 §11.4): a symbolic link anywhere on a
 * mutation's route below the root — including a write's leaf — aborts the
 * plan with an explicit refusal naming the link; operations that already ran
 * remain on disk (disclosed partial output, the existing mid-plan abort
 * shape). Without an output root the executor keeps today's behavior.
 */
export async function executeFileOperations(
    fs: ProjectFileSystem,
    operations: FileOperation[],
    log?: OperationLogger,
    options?: MutationRouteOptions,
): Promise<void> {
    const outputRoot = options?.outputRoot;
    for (const operation of operations) {
        switch (operation.type) {
            case 'log':
                log?.(operation.level, operation.message);
                break;
            case 'removeDir':
                await assertNoAliasRoute(
                    fs,
                    outputRoot,
                    operation.path,
                    'delete',
                    `removeDir '${operation.path}'`,
                );
                try {
                    await fs.delete(operation.path, { recursive: true });
                } catch (e) {
                    if (isLockError(e)) {
                        throw new Error(
                            `Cannot delete '${operation.path}' — the folder is in use by another program (the game, Steam, or Explorer). Close it and try again.`,
                            { cause: e },
                        );
                    }
                    throw e;
                }
                break;
            case 'makeDir': {
                // ProjectFileSystem has no mkdir: materialize the directory
                // through a write (adapters create missing parents) and drop
                // the sentinel afterwards so the directory stays empty. The
                // sentinel delete targets a plain file this very operation
                // just created (leaf-local, non-recursive) — only the write
                // needs the route guard.
                const sentinelPath = joinPath(
                    operation.path,
                    '.pzstudio-mkdir',
                );
                await assertNoAliasRoute(
                    fs,
                    outputRoot,
                    sentinelPath,
                    'write',
                    `makeDir '${operation.path}'`,
                );
                await fs.write(sentinelPath, new Uint8Array());
                await fs.delete(sentinelPath);
                break;
            }
            case 'copyTree':
                await copyTree(
                    fs,
                    operation.from,
                    operation.to,
                    {
                        excludeIgnoreFile: operation.excludeIgnoreFile,
                        ignoreDotFiles: operation.ignoreDotFiles,
                        ignoreItems: operation.ignoreItems,
                    },
                    outputRoot,
                );
                break;
            case 'writeFile':
                await assertNoAliasRoute(
                    fs,
                    outputRoot,
                    operation.path,
                    'write',
                    `writeFile '${operation.path}'`,
                );
                await fs.write(operation.path, encodeUtf8(operation.content));
                break;
            case 'copyFile':
                await assertNoAliasRoute(
                    fs,
                    outputRoot,
                    operation.to,
                    'write',
                    `copyFile to '${operation.to}'`,
                );
                await fs.write(operation.to, await fs.read(operation.from));
                break;
        }
    }
}
