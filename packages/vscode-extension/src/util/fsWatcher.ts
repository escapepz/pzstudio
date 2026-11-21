import { watch, statSync, type FSWatcher, type WatchEventType } from 'fs';
import { readdirSync } from 'fs';
import { join } from 'path';

const MAX_DIRECTORIES = 4000;

export interface RecursiveFsWatcherHandle {
    dispose(): void;
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
            subscribeSubtree(path);
            return;
        }
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
            return;
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

    const subscribeSubtree = (dir: string): void => {
        const isNew = !watchers.has(dir);
        walkAndSubscribe(dir);
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
