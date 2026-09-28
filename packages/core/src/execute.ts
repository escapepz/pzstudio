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
 * Recursively copies a source tree into destRoot through the injected
 * filesystem, applying the copyTree ignore options at every depth. Source
 * URIs come from fs.list() (adapter-native); destination URIs are built in
 * the plan's path space. Symbolic links are dereferenced (their targets are
 * copied as regular files), unlike the synchronous executor which copies the
 * link itself.
 */
async function copyTree(
    fs: ProjectFileSystem,
    sourceRoot: string,
    destRoot: string,
    options: CopyTreeOptions,
): Promise<void> {
    const walk = async (dirUri: string, relDir: string): Promise<void> => {
        const entries = await fs.list(dirUri);
        for (const entry of entries) {
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (!(await isSourcePathIncluded(fs, sourceRoot, rel, options))) {
                continue;
            }
            const type = await resolveEntryType(fs, entry);
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
 */
export async function executeFileOperations(
    fs: ProjectFileSystem,
    operations: FileOperation[],
    log?: OperationLogger,
): Promise<void> {
    for (const operation of operations) {
        switch (operation.type) {
            case 'log':
                log?.(operation.level, operation.message);
                break;
            case 'removeDir':
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
            case 'makeDir':
                // ProjectFileSystem has no mkdir: materialize the directory
                // through a write (adapters create missing parents) and drop
                // the sentinel afterwards so the directory stays empty.
                await fs.write(
                    joinPath(operation.path, '.pzstudio-mkdir'),
                    new Uint8Array(),
                );
                await fs.delete(joinPath(operation.path, '.pzstudio-mkdir'));
                break;
            case 'copyTree':
                await copyTree(fs, operation.from, operation.to, {
                    excludeIgnoreFile: operation.excludeIgnoreFile,
                    ignoreDotFiles: operation.ignoreDotFiles,
                    ignoreItems: operation.ignoreItems,
                });
                break;
            case 'writeFile':
                await fs.write(operation.path, encodeUtf8(operation.content));
                break;
            case 'copyFile':
                await fs.write(operation.to, await fs.read(operation.from));
                break;
        }
    }
}
