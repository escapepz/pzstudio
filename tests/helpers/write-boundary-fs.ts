/**
 * Emulated alias-route filesystem for the F23-WRITE boundary suite
 * (tests/unit/f23-write-boundary.test.ts): the write-side counterpart of the
 * SymlinkFs read-side emulation. doc 17 §2's executed native semantics are
 * modeled here so the escape rows can assert byte-exact victim state at the
 * RESOLVED physical landing (the stored key) without requiring NTFS:
 *
 * - links live in a side map (link path → target path in the same key space)
 *   and are reported as 'symbolicLink' entries of their literal parent's
 *   listing (the doc-17 header probe: Node readdir withFileTypes reports a
 *   junction as isSymbolicLink);
 * - read/stat/list through a link resolve to the target (fs.stat semantics);
 * - write resolves EVERY ancestor component through links and also follows a
 *   link at the leaf (fs.writeFile semantics — the class-5 escape);
 * - delete of a link ITSELF removes only the link (B1 / B-native-baseline 1);
 *   delete of a descendant resolves ancestors through links and destroys the
 *   content behind the alias (B2/B3/B4-ii — the class-3 escape); links inside
 *   a removed real tree are removed as links, targets intact (B4-i).
 *
 * Optional list-failure injection supports the scanner-error gate: an entry
 * in listFailures makes list() of that existing directory throw a non-ENOENT
 * error, which the mutation guard must convert into an explicit refusal
 * instead of a silent skip.
 */
import { F23Fs } from './copytree-f23-harness';
import type { DeleteOptions, DirectoryEntry } from '@pzstudio/platform';

const ELOOP_HOPS = 8;

export class AliasRouteFs extends F23Fs {
    /** link path → target path; targets may not exist (dangling). */
    links = new Map<string, string>();
    /** Directories whose list() throws (existing dirs — scanner-error gate). */
    listFailures = new Map<string, Error>();

    private normalize(uri: string): string {
        return uri.replace(/\\/g, '/');
    }

    /** Chases a full link chain (no-op for non-link paths). */
    private chase(path: string): string {
        let current = path;
        for (let hops = 0; hops < ELOOP_HOPS; hops += 1) {
            const target = this.links.get(current);
            if (target === undefined) return current;
            current = this.normalize(target);
        }
        throw new Error(`ELOOP: too many symbolic links: ${current}`);
    }

    /**
     * Resolves ancestor components through links (the OS's per-component
     * resolution for mkdir/writeFile/rmdir): each accumulated prefix that is
     * a link — possibly a chain of links — jumps to its final target; the
     * final component follows only when `followLeaf` is set (writeFile
     * follows a link leaf; rm does not).
     *
     * Absolute inputs walk in the absolute key space: the walk starts at the
     * root sentinel and every candidate prefix carries the leading slash, so
     * each per-component lookup matches links at their stored (absolute)
     * keys — resolving ancestors exactly like the OS does for an absolute
     * path. An absolute input always yields an absolute landing; a
     * relative-keyed link target is re-anchored at the root instead of
     * demoting the landing to a relative key (and never double-slashed).
     */
    private resolveRoute(uri: string, followLeaf: boolean): string {
        const path = this.normalize(uri);
        const absolute = path.startsWith('/');
        const segments = path.split('/').filter((segment) => segment !== '');
        let current = absolute ? '/' : '';
        for (let i = 0; i < segments.length; i += 1) {
            const isLeaf = i === segments.length - 1;
            const candidate =
                current === ''
                    ? segments[i]
                    : current.endsWith('/')
                      ? `${current}${segments[i]}`
                      : `${current}/${segments[i]}`;
            current = !isLeaf || followLeaf ? this.chase(candidate) : candidate;
        }
        return absolute && !current.startsWith('/') ? `/${current}` : current;
    }

    /** Full link-chain resolution (stat/read/list semantics). */
    private resolveAll(uri: string): string {
        let current = this.normalize(uri);
        for (let hops = 0; hops < ELOOP_HOPS; hops += 1) {
            const target = this.links.get(current);
            if (target === undefined) return current;
            current = this.normalize(target);
        }
        throw new Error(`ELOOP: too many symbolic links: ${uri}`);
    }

    async read(uri: string): Promise<Uint8Array> {
        return super.read(this.resolveAll(uri));
    }

    async stat(uri: string): Promise<ReturnType<F23Fs['stat']>> {
        return super.stat(this.resolveAll(uri));
    }

    async write(uri: string, data: Uint8Array): Promise<void> {
        await super.write(this.resolveRoute(uri, true), data);
    }

    async delete(uri: string, options?: DeleteOptions): Promise<void> {
        const path = this.normalize(uri);
        if (this.links.has(path)) {
            // rm of a link removes the link, never the target (B1).
            this.deletes.push(uri);
            this.links.delete(path);
            return;
        }
        const resolved = this.resolveRoute(path, false);
        if (options?.recursive) {
            // Links inside the removed tree go as links; targets survive.
            for (const link of [...this.links.keys()]) {
                if (link === resolved || link.startsWith(`${resolved}/`)) {
                    this.links.delete(link);
                }
            }
        }
        await super.delete(resolved);
    }

    protected async rawList(uri: string): Promise<DirectoryEntry[]> {
        const failure = this.listFailures.get(this.normalize(uri));
        if (failure) {
            throw failure;
        }
        // Children of the RESOLVED directory when listing through a link,
        // plus link children keyed at the literal listed directory.
        const resolved = this.resolveAll(uri);
        const entries = await super.rawList(resolved);
        for (const base of new Set([resolved, this.normalize(uri)])) {
            const prefix = base.endsWith('/') ? base : `${base}/`;
            for (const link of this.links.keys()) {
                if (!link.startsWith(prefix)) continue;
                const name = link.slice(prefix.length);
                if (name.includes('/')) continue;
                if (entries.some((entry) => entry.name === name)) continue;
                entries.push({
                    name,
                    uri: link,
                    type: 'symbolicLink' as const,
                });
            }
        }
        return entries;
    }
}
