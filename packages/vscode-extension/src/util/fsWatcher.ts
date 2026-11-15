import { watch, statSync, type FSWatcher, type WatchEventType } from 'fs';
import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * A self-owned recursive directory watcher over Node's fs.watch (per-
 * directory inotify on Linux). This is the DevSync session's GUARANTEED
 * delivery leg: the vscode.FileSystemWatcher service is host-managed and
 * silently stops delivering when the watched tree's shape changes under it
 * (sweep d09-B2: on the VM's VS Code stable, directories created after the
 * window's watcher established itself — the standard extension flow
 * `pzstudio new` → add → build → watch — receive ZERO events, for the
 * project-dir base AND the workspace-folder base alike, probe evidence
 * 2026-11-16). Node fs.watch subscribes exactly what exists at subscribe
 * time, so this walker walks the tree once at start and subscribes every
 * directory, then subscribes newly created directories as their parent
 * reports them.
 *
 * Event mapping is deliberately engine-equivalent rather than
 * watcher-faithful: fs.watch cannot distinguish create from change, and
 * the sync engine treats them identically (both read the file's content at
 * apply time), so every existing path surfaces as 'change' and every
 * vanished path as 'delete'. A created DIRECTORY surfaces as 'change' for
 * every file found inside it after subscription (the engine skips
 * directory deltas; the files are what it syncs), and a deleted directory
 * surfaces as one 'delete' of its path (the engine's incremental delete is
 * recursive). Overlapping events from a second watcher source are safe:
 * the engine's coalesceDeltas collapses same-path duplicates.
 *
 * Errors surface through the onError callback — a subscription failure is
 * diagnostic gold when nothing syncs, never a silent drop.
 */

/** Subscription cap: a mod project is small; a pathological tree fails loud. */
const MAX_DIRECTORIES = 4000;

export interface RecursiveFsWatcherHandle {
    dispose(): void;
    /** Number of directories currently subscribed (observability). */
    readonly subscribedCount: number;
}

export function watchTreeRecursive(
    rootDir: string,
    onEvent: (type: 'change' | 'delete', path: string) => void,
    onError: (message: string) => void,
): RecursiveFsWatcherHandle {
    const watchers = new Map<string, FSWatcher>();
    const disposed = { value: false };

    const statQuiet = (path: string): 'file' | 'directory' | undefined => {
        try {
            return statSync(path).isDirectory() ? 'directory' : 'file';
        } catch {
            return undefined;
        }
    };

    const handleFsEvent = (dir: string, filename: string): void => {
        if (disposed.value) {
            return;
        }
        const path = join(dir, filename);
        const kind = statQuiet(path);
        if (kind === 'file') {
            onEvent('change', path);
            return;
        }
        if (kind === 'directory') {
            // A directory appeared (or moved in): subscribe it and its
            // subtree, and surface every file it already carries — files
            // created between the parent's event and this subscription
            // must still reach the engine.
            subscribeSubtree(path);
            return;
        }
        // Vanished: emit the delete (the engine's incremental delete is
        // recursive for directories) and drop any subscription we held.
        const sub = watchers.get(path);
        if (sub) {
            watchers.delete(path);
            sub.close();
        }
        onEvent('delete', path);
    };

    const subscribe = (dir: string): boolean => {
        if (disposed.value || watchers.has(dir)) {
            return true;
        }
        if (watchers.size >= MAX_DIRECTORIES) {
            onError(
                `Development sync: the watched project tree exceeded ${MAX_DIRECTORIES} directories — deeper folders are NOT watched. Report this if your project legitimately needs more.`,
            );
            return false;
        }
        let fsWatcher: FSWatcher;
        try {
            fsWatcher = watch(dir, (_event: WatchEventType, filename) => {
                // filename can be null when the platform does not report it;
                // Linux inotify always does, so the null case is skipped —
                // the next event for the same content re-delivers.
                if (filename !== null) {
                    handleFsEvent(
                        dir,
                        typeof filename === 'string'
                            ? filename
                            : String(filename),
                    );
                }
            });
        } catch (e) {
            onError(
                `Development sync: watching '${dir}' failed (${
                    e instanceof Error ? e.message : String(e)
                }).`,
            );
            return false;
        }
        fsWatcher.on('error', (e: unknown) => {
            if (!disposed.value) {
                onError(
                    `Development sync: watcher error under '${dir}' (${
                        e instanceof Error ? e.message : String(e)
                    }).`,
                );
            }
        });
        watchers.set(dir, fsWatcher);
        return true;
    };

    const walkAndSubscribe = (dir: string): void => {
        if (!subscribe(dir)) {
            return;
        }
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return; // vanished mid-walk
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                walkAndSubscribe(join(dir, entry.name));
            }
        }
    };

    const emitFilesRecursively = (dir: string): void => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                emitFilesRecursively(path);
            } else {
                onEvent('change', path);
            }
        }
    };

    /** Subscribes one directory and surfaces the files it already carries. */
    const subscribeSubtree = (dir: string): void => {
        const isNew = !watchers.has(dir);
        walkAndSubscribe(dir);
        // Only a freshly subscribed tree re-surfaces its files: an already
        // watched directory saw its files delivered event-by-event already.
        if (isNew) {
            emitFilesRecursively(dir);
        }
    };

    walkAndSubscribe(rootDir);

    return {
        dispose(): void {
            disposed.value = true;
            for (const fsWatcher of watchers.values()) {
                fsWatcher.close();
            }
            watchers.clear();
        },
        get subscribedCount(): number {
            return watchers.size;
        },
    };
}
