/**
 * Sweep d09-B2: the self-owned recursive fs.watch delivery leg
 * (packages/vscode-extension/src/util/fsWatcher.ts). The
 * vscode.FileSystemWatcher service silently stops delivering when the
 * watched tree's shape changes after the window's watcher established
 * itself (VM probe evidence 2026-11-16) — this walker subscribes what
 * exists at start and follows new directories, so delivery never depends
 * on the host watcher service. The pins below drive REAL fs events over
 * REAL temp trees (no vscode mock — the module is Node-only by design).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';
import {
    watchTreeRecursive,
    type RecursiveFsWatcherHandle,
} from '../../packages/vscode-extension/src/util/fsWatcher';

interface RecordedEvent {
    type: 'change' | 'delete';
    path: string;
}

let dirs: string[] = [];
let handles: RecursiveFsWatcherHandle[] = [];

function makeDir(): string {
    const dir = createTempDir();
    dirs.push(dir);
    return dir;
}

function collect(): {
    events: RecordedEvent[];
    errors: string[];
} {
    const events: RecordedEvent[] = [];
    const errors: string[] = [];
    return {
        events,
        errors,
    };
}

afterEach(() => {
    for (const handle of handles) handle.dispose();
    handles = [];
    for (const dir of dirs) deleteDir(dir);
    dirs = [];
});

describe('watchTreeRecursive (d09-B2 guaranteed delivery leg)', () => {
    it('delivers a change event for a file written under an existing directory', async () => {
        const root = makeDir();
        const sub = path.join(root, '42', 'media', 'lua');
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(sub, 'entry.lua'), 'print("v1")');

        const { events, errors } = collect();
        handles.push(
            watchTreeRecursive(
                root,
                (type, p) => events.push({ type, path: p }),
                (m) => errors.push(m),
            ),
        );

        fs.writeFileSync(path.join(sub, 'entry.lua'), 'print("v2")');

        await vi_waitFor(() =>
            events.some(
                (e) => e.type === 'change' && e.path.endsWith('entry.lua'),
            ),
        );
        expect(errors).toEqual([]);
    });

    it('delivers events for files created inside a directory tree that appeared AFTER start (the d09-B2 dead-watcher shape)', async () => {
        const root = makeDir();
        const { events, errors } = collect();
        handles.push(
            watchTreeRecursive(
                root,
                (type, p) => events.push({ type, path: p }),
                (m) => errors.push(m),
            ),
        );

        // The whole mod tree appears mid-session — exactly the journey flow
        // `pzstudio new` → add → build → watch reproduces.
        const modDir = path.join(root, 'my_mod', '42', 'media', 'lua');
        fs.mkdirSync(modDir, { recursive: true });
        fs.writeFileSync(path.join(modDir, 'late.lua'), 'late content');

        await vi_waitFor(() =>
            events.some(
                (e) => e.type === 'change' && e.path.endsWith('late.lua'),
            ),
        );
        expect(errors).toEqual([]);
    });

    it('surfaces files already inside a directory created after start', async () => {
        const root = makeDir();
        const { events } = collect();
        handles.push(
            watchTreeRecursive(
                root,
                (type, p) => events.push({ type, path: p }),
                () => {},
            ),
        );

        // A directory created WITH content before any event could fire.
        const newDir = path.join(root, 'brand_new_mod');
        fs.mkdirSync(path.join(newDir, 'media'), { recursive: true });
        fs.writeFileSync(path.join(newDir, 'media', 'readme.txt'), 'here');

        await vi_waitFor(() =>
            events.some(
                (e) => e.type === 'change' && e.path.endsWith('readme.txt'),
            ),
        );
    });

    it('delivers a delete event when a watched file vanishes', async () => {
        const root = makeDir();
        const file = path.join(root, 'gone.lua');
        fs.writeFileSync(file, 'bye');

        const { events } = collect();
        handles.push(
            watchTreeRecursive(
                root,
                (type, p) => events.push({ type, path: p }),
                () => {},
            ),
        );

        fs.unlinkSync(file);

        await vi_waitFor(() =>
            events.some((e) => e.type === 'delete' && e.path === file),
        );
    });

    it('dispose stops delivery', async () => {
        const root = makeDir();
        const { events } = collect();
        const handle = watchTreeRecursive(
            root,
            (type, p) => events.push({ type, path: p }),
            () => {},
        );
        handles.push(handle);
        handle.dispose();

        fs.writeFileSync(path.join(root, 'after_dispose.lua'), 'x');
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(events).toEqual([]);
    });

    it('reports a subscription error for a nonexistent root instead of failing silently', () => {
        const missing = path.join(makeDir(), 'does_not_exist');
        const errors: string[] = [];
        handles.push(
            watchTreeRecursive(
                missing,
                () => {},
                (m) => errors.push(m),
            ),
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('failed');
    });
});

/** Small waitFor helper over the vitest one, keeping the pins readable. */
async function vi_waitFor(cond: () => boolean): Promise<void> {
    await vi.waitFor(cond, { timeout: 5000, interval: 20 });
}
