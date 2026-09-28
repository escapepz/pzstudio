/**
 * Host-agnostic contracts shared by every PZ Studio package.
 *
 * This package is deliberately dependency-free and I/O-free: it only
 * declares the interfaces an adapter must implement. The Node adapter
 * (@pzstudio/platform-node) and the web adapter (@pzstudio/platform-web)
 * provide the implementations, while @pzstudio/core consumes the interfaces
 * as injected arguments and never imports a host runtime.
 */

/** Kind of a filesystem entry, mirroring vscode.FileType semantics. */
export type FileObjectType = 'file' | 'directory' | 'symbolicLink' | 'unknown';

export interface FileStat {
    type: FileObjectType;
    /** Creation timestamp in milliseconds (0 when unknown). */
    ctime: number;
    /** Modification timestamp in milliseconds (0 when unknown). */
    mtime: number;
    /** Size in bytes (0 when unknown). */
    size: number;
}

export interface DirectoryEntry {
    /** Entry name relative to the listed directory. */
    name: string;
    /** Absolute URI of the entry. */
    uri: string;
    type: FileObjectType;
}

export interface DeleteOptions {
    /** Delete the target and everything below it (directories). */
    recursive?: boolean;
}

/**
 * The single filesystem abstraction @pzstudio/core is allowed to think
 * through. URIs are opaque strings (file://, vscode-vfs://, ...) — core must
 * not assume absolute OS paths and adapters translate to their own scheme.
 */
export interface ProjectFileSystem {
    /** Reads the full content of a file. */
    read(uri: string): Promise<Uint8Array>;
    /** Writes (creating or replacing) a file with the given content. */
    write(uri: string, data: Uint8Array): Promise<void>;
    /** Deletes a file, or a directory (with everything below it). */
    delete(uri: string, options?: DeleteOptions): Promise<void>;
    /** Resolves metadata for a file or directory. */
    stat(uri: string): Promise<FileStat>;
    /** Lists the direct children of a directory URI. */
    list(uri: string): Promise<DirectoryEntry[]>;
}

/**
 * What the current host is capable of. Features ask capabilities instead of
 * branching on `isWeb` — hosts hide commands whose capability is false.
 */
export interface PlatformCapabilities {
    /** Running inside a Node.js runtime. */
    node: boolean;
    /** Spawning shell processes is available. */
    shell: boolean;
    /** Executing local executables (game client, git, ...) is available. */
    localExecutables: boolean;
    /** Creating symlinks/junctions is available. */
    symlinks: boolean;
    /** Writing into the opened workspace is available. */
    workspaceWrite: boolean;
    /** Writing directly into the game/workshop output folders is available. */
    workshopOutput: boolean;
    /** Producing a portable build archive (zip) is available. */
    portableBuild: boolean;
}

/**
 * A transport knows how to download a template repository (optionally at a
 * ref) into a local directory and refresh an existing cache directory.
 *
 * The CLI and the Node VS Code extension default to GitTransport; the web
 * extension (vscode.dev) injects FetchTransport. Which transport is used is
 * a wiring decision per package — the core never branches on host type.
 */
export interface TemplateTransport {
    readonly name: 'git' | 'fetch';
    /** Download the template at url (at ref) into destDir. Throws on failure. */
    download(url: string, ref: string | undefined, destDir: string): void;
    /** Bring the cached template at cacheDir up to ref. Returns true on success. */
    refresh(cacheDir: string, ref: string | undefined): boolean;
    /** Whether a cache directory produced by this transport is usable. */
    isCacheValid(dir: string): boolean;
}
