/**
 * Aliased-filesystem emulations for the F23-E1a path-alias regression suite
 * (tests/unit/copytree-case-alias.test.ts). Both extend the F23 harness so
 * budgets, listing orders and write/delete logs work unchanged.
 */
import { F23Fs } from './copytree-f23-harness';
import type { DirectoryEntry } from '@pzstudio/platform';

/**
 * NTFS-like filesystem: case-INSENSITIVE resolution (a path spelled with any
 * case finds the stored entry), case-PRESERVING storage (the first spelling
 * under which a directory was created wins; later writes through case-variant
 * paths map into the stored directories, and listings return the stored
 * spellings). This is the default behavior of NTFS and of macOS APFS/HFS+:
 * the destination-exclusion escape class documented in doc 15 §7 (F23-E1a).
 *
 * Storage invariant (mirrors the real filesystem): two directories that
 * differ only by case can never coexist, because every write resolves
 * case-insensitively before storing.
 */
export class CaseInsensitiveFs extends F23Fs {
    /** Lazily built lowercase-path → stored-path index; null when stale. */
    private lowerIndex: Map<string, string> | null = null;

    private invalidate(): void {
        this.lowerIndex = null;
    }

    /** Maps every stored key and each of its ancestor directories. */
    private ensureIndex(): Map<string, string> {
        if (this.lowerIndex) {
            return this.lowerIndex;
        }
        const index = new Map<string, string>();
        for (const key of this.files.keys()) {
            const parts = key
                .replace(/\\/g, '/')
                .split('/')
                .filter((part) => part !== '');
            for (let i = 1; i <= parts.length; i += 1) {
                const stored = parts.slice(0, i).join('/');
                const lower = stored.toLowerCase();
                if (!index.has(lower)) {
                    index.set(lower, stored);
                }
            }
        }
        this.lowerIndex = index;
        return index;
    }

    /**
     * Rewrites a requested path in stored spellings: each ancestor segment
     * that already exists case-insensitively keeps its stored name; segments
     * that exist nowhere stay as requested (they will be created now, with
     * the requested spelling — case preservation on creation).
     */
    private resolveStoredPath(uri: string): string {
        const index = this.ensureIndex();
        const root = uri.startsWith('/') || uri.startsWith('\\') ? '/' : '';
        const segments = uri
            .replace(/\\/g, '/')
            .split('/')
            .filter((segment) => segment !== '');
        const storedSegments: string[] = [];
        let lowerBase = '';
        for (const segment of segments) {
            const lowerPath = lowerBase
                ? `${lowerBase}/${segment.toLowerCase()}`
                : segment.toLowerCase();
            const storedPath = index.get(lowerPath);
            if (storedPath) {
                storedSegments.push(storedPath.split('/').pop()!);
            } else {
                storedSegments.push(segment);
            }
            lowerBase = lowerPath;
        }
        return `${root}${storedSegments.join('/')}`;
    }

    async read(uri: string): Promise<Uint8Array> {
        return super.read(this.resolveStoredPath(uri));
    }

    async write(uri: string, data: Uint8Array): Promise<void> {
        await super.write(this.resolveStoredPath(uri), data);
        this.invalidate();
    }

    async delete(uri: string): Promise<void> {
        await super.delete(this.resolveStoredPath(uri));
        this.invalidate();
    }

    async stat(uri: string): Promise<ReturnType<F23Fs['stat']>> {
        return super.stat(this.resolveStoredPath(uri));
    }

    protected async rawList(uri: string): Promise<DirectoryEntry[]> {
        // The listed directory itself resolves case-insensitively; children
        // are then derived from the STORED key spellings under it, exactly
        // like NTFS readdir returning whatever case a folder was created
        // with, regardless of how the caller spelled the open path.
        const prefix = this.resolveStoredPath(uri);
        const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
        const names = new Map<string, DirectoryEntry['type']>();
        for (const key of this.files.keys()) {
            if (!key.startsWith(withSlash)) continue;
            const rest = key.slice(withSlash.length);
            const slash = rest.indexOf('/');
            if (slash === -1) {
                names.set(rest, 'file');
            } else {
                names.set(rest.slice(0, slash), 'directory');
            }
        }
        return [...names.entries()].map(([name, type]) => ({
            name,
            uri: `${withSlash}${name}`,
            type,
        }));
    }
}

/**
 * Symlink-aware memory filesystem for the alias review (doc 15 §7): links
 * live in a side map (link path → target path in the same key space), are
 * reported as 'symbolicLink' entries in listings, and stat/read/list through
 * a link resolve to the target — the contract the Core executor's
 * resolveEntryType relies on when it dereferences links.
 */
export class SymlinkFs extends F23Fs {
    /** link path → target path; targets may not exist yet (dangling). */
    links = new Map<string, string>();

    private resolveLinks(uri: string): string {
        let current = uri;
        for (let hops = 0; hops < 8; hops += 1) {
            const target = this.links.get(current);
            if (!target) return current;
            current = target;
        }
        throw new Error(`ELOOP: too many symbolic links: ${uri}`);
    }

    async stat(uri: string): Promise<ReturnType<F23Fs['stat']>> {
        return super.stat(this.resolveLinks(uri)); // follows, like fs.stat
    }

    async read(uri: string): Promise<Uint8Array> {
        return super.read(this.resolveLinks(uri));
    }

    protected async rawList(uri: string): Promise<DirectoryEntry[]> {
        // Children (files AND links) are those of the RESOLVED directory:
        // listing through a link shows the target's content, including any
        // links that live inside the target.
        const resolved = this.resolveLinks(uri);
        const entries = await super.rawList(resolved);
        const prefix = resolved.endsWith('/') ? resolved : `${resolved}/`;
        for (const link of this.links.keys()) {
            if (!link.startsWith(prefix)) continue;
            const name = link.slice(prefix.length);
            if (name.includes('/')) continue;
            if (entries.some((entry) => entry.name === name)) continue;
            entries.push({ name, uri: link, type: 'symbolicLink' as const });
        }
        return entries;
    }
}
