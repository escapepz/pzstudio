/**
 * Generic executor for FileOperation[] plans on an injected ProjectFileSystem.
 *
 * This is the host-agnostic counterpart of the CLI's synchronous build
 * executor: same plan, same ignore semantics, but running through the
 * filesystem contract so the Node adapter, the vscode.workspace.fs adapter
 * and any future host can drive it. The ignore rule handling unifies
 * .gitignore and .pzstudioignore through the `ignore` package (the closest
 * directory carrying rules wins; within one level .gitignore entries load
 * first so .pzstudioignore outranks them), with hard rails for mod.info
 * and the rule files themselves; dot files optional, .gitkeep never copied.
 *
 * Known divergence from the synchronous executor: directories whose entire
 * content is filtered out are not materialized in the output (there is no
 * mkdir on the filesystem contract). The game only consumes files, so empty
 * directories have no effect.
 */
import ignore from 'ignore';
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

const IGNORE_RAIL_BASENAMES = new Set([
    'mod.info',
    '.pzstudioignore',
    '.gitignore',
]);

const WILDCARD_PATTERN = /[*?[]/;

/**
 * The ignore rules carried by one directory. Entries keep the historical
 * parsing (trimmed, blanks and comments dropped, backslashes folded to '/',
 * trailing slashes stripped): plain names match at the directory's own
 * level — the directory itself and everything under it — while wildcards,
 * negations and `**` get their real gitignore meaning in the matcher.
 */
export interface IgnoreRuleSet {
    /** Parsed .pzstudioignore entries, or null when absent/unreadable. */
    pzstudio: string[] | null;
    /** Parsed .gitignore entries, or null when absent/unreadable. */
    git: string[] | null;
}

function parseIgnoreEntries(content: string): string[] | null {
    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/\\/g, '/').replace(/\/+$/, ''))
        .filter((line) => line && !line.startsWith('#'));
    return lines.length > 0 ? lines : null;
}

async function readNamedIgnoreEntries(
    fs: ProjectFileSystem,
    entries: DirectoryEntry[],
    name: string,
): Promise<string[] | null> {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) {
        return null;
    }
    try {
        return parseIgnoreEntries(decodeUtf8(await fs.read(entry.uri)));
    } catch {
        return null;
    }
}

/**
 * Reads the ignore rules of one directory: its .pzstudioignore and
 * .gitignore entries. A directory that cannot be listed, or a rule file
 * that cannot be read, carries no rules rather than failing the walk.
 */
export async function readIgnoreRulesForDir(
    fs: ProjectFileSystem,
    dirUri: string,
): Promise<IgnoreRuleSet> {
    let entries: DirectoryEntry[];
    try {
        entries = await fs.list(dirUri);
    } catch {
        return { pzstudio: null, git: null };
    }
    return {
        pzstudio: await readNamedIgnoreEntries(fs, entries, '.pzstudioignore'),
        git: await readNamedIgnoreEntries(fs, entries, '.gitignore'),
    };
}

function hasIgnoreRules(ruleSet: IgnoreRuleSet): boolean {
    return ruleSet.pzstudio !== null || ruleSet.git !== null;
}

function toIgnorePattern(entry: string): string {
    if (
        !entry.startsWith('!') &&
        !entry.startsWith('/') &&
        !WILDCARD_PATTERN.test(entry)
    ) {
        return `/${entry}`;
    }
    return entry;
}

/**
 * Builds the ignore matcher over rule sets keyed by their directory path
 * relative to the copy root ('' is the root itself, 'media' a child, and so
 * on) — the same keys the isSourcePathIncluded walk produces. isIgnored
 * walks from the entry's parent directory up to the root and the FIRST
 * directory carrying rules decides (closest-wins): its .gitignore entries
 * are added first, its .pzstudioignore entries second, so within that level
 * the .pzstudioignore wins. The basenames mod.info, .pzstudioignore and
 * .gitignore are rails: always included regardless of rules, at any depth.
 */
export function createIgnoreMatcher(
    rulesByDir: Record<string, IgnoreRuleSet>,
): { isIgnored(relPath: string): boolean } {
    return {
        isIgnored(relPath: string): boolean {
            const segments = relPath
                .replace(/\\/g, '/')
                .split('/')
                .filter((segment) => segment !== '');
            if (segments.length === 0) {
                return false;
            }
            if (IGNORE_RAIL_BASENAMES.has(segments[segments.length - 1])) {
                return false;
            }
            for (let end = segments.length - 1; end >= 0; end -= 1) {
                const ruleSet = rulesByDir[segments.slice(0, end).join('/')];
                if (!ruleSet || !hasIgnoreRules(ruleSet)) {
                    continue;
                }
                const relToDir = segments.slice(end).join('/');
                const ig = ignore({ allowRelativePaths: true });
                if (ruleSet.git) {
                    ig.add(ruleSet.git.map(toIgnorePattern));
                }
                if (ruleSet.pzstudio) {
                    ig.add(ruleSet.pzstudio.map(toIgnorePattern));
                }
                return ig.ignores(relToDir);
            }
            return false;
        },
    };
}

/**
 * Decides whether a source path is copied by a copyTree with the given
 * options. This is the standalone (non-walking) form of the ignore rules so
 * the sync engine can test a single changed file against the same semantics
 * the full build used, reading .gitignore/.pzstudioignore rules through the
 * injected filesystem.
 *
 * @param fs The injected filesystem (used to read the ignore rule files)
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
        return true;
    }
    const segments = rel.split('/');
    const name = segments[segments.length - 1];

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

    if (options.ignoreDotFiles && name.startsWith('.')) {
        if (name !== '.pzstudioignore') {
            return false;
        }
    }

    if (name === '.pzstudioignore') {
        return !options.excludeIgnoreFile;
    }

    if (
        segments.length === 1 &&
        options.ignoreItems &&
        options.ignoreItems.includes(name)
    ) {
        return false;
    }

    const parentSegments = segments.slice(0, -1);
    let current = parentSegments;
    const rulesByDir: Record<string, IgnoreRuleSet> = {};
    while (true) {
        const dirUri = current.length
            ? joinPath(sourceRoot, ...current)
            : sourceRoot;
        const ruleSet = await readIgnoreRulesForDir(fs, dirUri);
        if (hasIgnoreRules(ruleSet)) {
            rulesByDir[current.join('/')] = ruleSet;
            break;
        }
        if (current.length === 0) {
            break;
        }
        current = current.slice(0, -1);
    }
    return !createIgnoreMatcher(rulesByDir).isIgnored(rel);
}

function pathSegments(path: string): string[] {
    return path
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment !== '');
}

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

type ChainSegment = {
    segment: string;
    mode: 'exact' | 'ci';
};

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
        }
    };
    await walk(sourceRoot, '');
}

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
