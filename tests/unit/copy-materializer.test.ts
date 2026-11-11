import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
    materializeCopySlot,
    inspectMaterializeSlot,
    COPY_MARKER_FILENAME as NODE_COPY_MARKER_FILENAME,
} from '../../packages/platform-node/src/link/copyMaterializer';
import type {
    CopyFs,
    CopySlotIdentity,
} from '../../packages/platform-node/src/link/copyMaterializer';
import type {
    LinkFs,
    RealFs,
} from '../../packages/platform-node/src/link/linkManager';
import type { ProjectFileSystem } from '@pzstudio/platform';
import {
    COPY_MARKER_FILENAME,
    computeProjectId,
    writeCopySlotMarker,
    readCopySlotMarker,
} from '../../packages/core/src/output-marker';
import { MemoryFileSystem } from '../helpers/memory-file-system';

/**
 * Real-fs fixtures over a tmpdir (the link-manager suite's approach): the
 * copy materializer's gates are defined against actual filesystem
 * semantics (junction unlink, ENOTEMPTY races), so the tests run the real
 * module over real trees. Junction creation works unprivileged on win32
 * ('junction' type); posix tests use 'dir' symlinks.
 */
const PLATFORM = process.platform === 'win32' ? 'win32' : 'posix';
const LINK_TYPE =
    PLATFORM === 'win32' ? ('junction' as const) : ('dir' as const);
const ITEM = 'My Item';

const nodeCopyFs: CopyFs = {
    lstat: (p) => fsp.lstat(p),
    stat: (p) => fsp.stat(p),
    readdirEntries: (p) => fsp.readdir(p, { withFileTypes: true }),
    readFile: (p) => fsp.readFile(p),
    writeFile: (p, d) => fsp.writeFile(p, d),
    mkdir: (p) => fsp.mkdir(p, { recursive: true }),
    unlink: (p) => fsp.unlink(p),
    rmdir: (p) => fsp.rmdir(p),
    utimes: (p, atime, mtime) => fsp.utimes(p, atime, mtime),
};

const nodeLinkFs: LinkFs = {
    lstat: (p) => fsp.lstat(p),
    readlink: (p) => fsp.readlink(p),
    stat: (p, opts) => fsp.stat(p, opts),
    realpath: (p) => fsp.realpath(p),
    readdir: (p) => fsp.readdir(p),
};

const nodeRealFs = fsp as unknown as RealFs;

/** A ProjectFileSystem over the real fs — what the CLI hands to core's
 * writeCopySlotMarker (plain absolute paths accepted). */
const markerFs: ProjectFileSystem = {
    read: async (uri) => new Uint8Array(await fsp.readFile(uri)),
    write: async (uri, data) => {
        await fsp.writeFile(uri, data);
    },
    delete: async (uri) => {
        await fsp.unlink(uri);
    },
    stat: async (uri) => {
        const s = await fsp.stat(uri);
        return {
            type: s.isDirectory() ? 'directory' : 'file',
            ctime: s.ctimeMs,
            mtime: s.mtimeMs,
            size: s.size,
        };
    },
    list: async (uri) =>
        (await fsp.readdir(uri, { withFileTypes: true })).map((e) => ({
            name: e.name,
            uri: `${uri}/${e.name}`,
            type: e.isDirectory() ? 'directory' : 'file',
        })),
};

describe('copy materializer (real fs fixtures)', () => {
    let root: string;
    let projectDir: string;
    let distItem: string;
    let slotDir: string;

    beforeEach(async () => {
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pz-copy-'));
        projectDir = path.join(root, 'project');
        distItem = path.join(projectDir, 'dist', ITEM);
        slotDir = path.join(root, 'deploy', ITEM);
        await fsp.mkdir(distItem, { recursive: true });
    });

    afterEach(async () => {
        await fsp.rm(root, { recursive: true, force: true });
    });

    /** Writes the dist tree: keys are item-relative POSIX paths. */
    async function makeDist(files: Record<string, string>): Promise<void> {
        for (const [rel, content] of Object.entries(files)) {
            const target = path.join(distItem, ...rel.split('/'));
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.writeFile(target, content);
        }
    }

    async function identity(): Promise<CopySlotIdentity> {
        return {
            projectId: await computeProjectId(projectDir),
            itemId: ITEM,
        };
    }

    const readCopyMarker = async (dir: string): Promise<unknown> => {
        try {
            return JSON.parse(
                await fsp.readFile(
                    path.join(dir, COPY_MARKER_FILENAME),
                    'utf8',
                ),
            );
        } catch {
            return undefined;
        }
    };

    const writeMarker = (dir: string) =>
        writeCopySlotMarker(markerFs, {
            projectDir,
            itemId: ITEM,
            slotDir: dir,
        });

    const opts = () => ({
        platform: PLATFORM,
        readCopyMarker,
        writeCopyMarker: writeMarker,
        copyIdentity: undefined as CopySlotIdentity | undefined,
    });

    it('inspect: ABSENT when nothing occupies the slot', async () => {
        const inspection = await inspectMaterializeSlot(
            nodeLinkFs,
            slotDir,
            distItem,
            { platform: PLATFORM },
        );
        expect(inspection.state).toBe('ABSENT');
    });

    it('inspect: COPY_SLOT for a real dir with a matching copy marker', async () => {
        await makeDist({ 'workshop.txt': 'id=1' });
        await fsp.mkdir(slotDir, { recursive: true });
        await writeMarker(slotDir);
        const inspection = await inspectMaterializeSlot(
            nodeLinkFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(inspection.state).toBe('COPY_SLOT');
    });

    it('inspect: HAND_MADE_DIR for a real dir without a marker', async () => {
        await fsp.mkdir(slotDir, { recursive: true });
        await fsp.writeFile(path.join(slotDir, 'hand.txt'), 'mine');
        const inspection = await inspectMaterializeSlot(
            nodeLinkFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(inspection.state).toBe('HAND_MADE_DIR');
        expect(inspection.detail).toContain('ERR_COPY_SLOT_HAND_MADE');
    });

    it('inspect: HAND_MADE_DIR when the marker names another project', async () => {
        await fsp.mkdir(slotDir, { recursive: true });
        await fsp.writeFile(
            path.join(slotDir, COPY_MARKER_FILENAME),
            JSON.stringify({
                schemaVersion: 1,
                mode: 'copy',
                projectId: 'deadbeefdeadbeef',
                itemId: ITEM,
                createdAt: '2026-01-01T00:00:00.000Z',
            }),
        );
        const inspection = await inspectMaterializeSlot(
            nodeLinkFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(inspection.state).toBe('HAND_MADE_DIR');
    });

    it('inspect: NOT_DIRECTORY when a file occupies the slot', async () => {
        await fsp.mkdir(path.dirname(slotDir), { recursive: true });
        await fsp.writeFile(slotDir, 'not a dir');
        const inspection = await inspectMaterializeSlot(
            nodeLinkFs,
            slotDir,
            distItem,
            { platform: PLATFORM },
        );
        expect(inspection.state).toBe('NOT_DIRECTORY');
    });

    it('inspect: delegates an owned junction to the link cascade (OK_LINK)', async () => {
        await makeDist({ 'workshop.txt': 'id=1' });
        await writeCopySlotMarker(markerFs, {
            projectDir,
            itemId: ITEM,
            slotDir: distItem,
        }); // the dist OUTPUT marker equivalent for the readMarker probe
        await fsp.mkdir(path.dirname(slotDir), { recursive: true });
        await fsp.symlink(distItem, slotDir, LINK_TYPE);
        const inspection = await inspectMaterializeSlot(
            nodeLinkFs,
            slotDir,
            distItem,
            {
                platform: PLATFORM,
                readMarker: async (dir) =>
                    dir === distItem ? { projectId: 'x' } : undefined,
            },
        );
        expect(inspection.state).toBe('OK_LINK');
    });

    it('materialize: ABSENT slot gets the full copy plus the marker', async () => {
        await makeDist({
            'workshop.txt': 'id=1',
            'Contents/mods/m1/media/lua/a.lua': '-- a',
            'Contents/mods/m1/media/textures/b.png': 'png-bytes',
        });
        const result = await materializeCopySlot(
            nodeCopyFs,
            nodeLinkFs,
            nodeRealFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(result.ok, result.detail).toBe(true);
        expect(result.state).toBe('COPY_SLOT');
        expect(result.filesCopied).toBe(3);
        expect(
            await fsp.readFile(
                path.join(slotDir, 'Contents/mods/m1/media/lua/a.lua'),
                'utf8',
            ),
        ).toBe('-- a');
        const marker = await readCopySlotMarker(
            markerFs,
            path.join(slotDir, COPY_MARKER_FILENAME),
        );
        expect(marker?.projectId).toBe((await identity()).projectId);
        expect(marker?.itemId).toBe(ITEM);
        // dist is untouched by the copy pass.
        expect(
            await fsp.readFile(path.join(distItem, 'workshop.txt'), 'utf8'),
        ).toBe('id=1');
    });

    it('materialize: an owned junction is UNLINKED first (dist intact, slot real)', async () => {
        await makeDist({ 'workshop.txt': 'id=1', 'Contents/a.lua': '-- a' });
        await fsp.mkdir(path.dirname(slotDir), { recursive: true });
        await fsp.symlink(distItem, slotDir, LINK_TYPE);
        const result = await materializeCopySlot(
            nodeCopyFs,
            nodeLinkFs,
            nodeRealFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(result.ok, result.detail).toBe(true);
        const slotStats = await fsp.lstat(slotDir);
        expect(slotStats.isSymbolicLink()).toBe(false);
        expect(slotStats.isDirectory()).toBe(true);
        // The dist file must be byte-identical — the copy never wrote
        // through the link.
        expect(
            await fsp.readFile(path.join(distItem, 'Contents/a.lua'), 'utf8'),
        ).toBe('-- a');
        expect(
            await fsp.readFile(path.join(slotDir, 'Contents/a.lua'), 'utf8'),
        ).toBe('-- a');
    });

    it('materialize: a dangling owned junction heals into a copy slot', async () => {
        // True DANGLING: the link already targets D, but D does not exist
        // yet (a junction to a DIFFERENT missing path is FOREIGN_LINK).
        await fsp.mkdir(path.dirname(slotDir), { recursive: true });
        await fsp.symlink(distItem, slotDir, LINK_TYPE);
        await makeDist({ 'workshop.txt': 'id=1' });
        const result = await materializeCopySlot(
            nodeCopyFs,
            nodeLinkFs,
            nodeRealFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(result.ok, result.detail).toBe(true);
        expect((await fsp.lstat(slotDir)).isSymbolicLink()).toBe(false);
        expect(
            await fsp.readFile(path.join(slotDir, 'workshop.txt'), 'utf8'),
        ).toBe('id=1');
    });

    it('materialize: refuses a hand-made non-empty slot, content untouched', async () => {
        await makeDist({ 'workshop.txt': 'id=1' });
        await fsp.mkdir(slotDir, { recursive: true });
        await fsp.writeFile(path.join(slotDir, 'hand.txt'), 'mine');
        const result = await materializeCopySlot(
            nodeCopyFs,
            nodeLinkFs,
            nodeRealFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(result.ok).toBe(false);
        expect(result.detail).toContain('ERR_COPY_SLOT_HAND_MADE');
        expect(await fsp.readFile(path.join(slotDir, 'hand.txt'), 'utf8')).toBe(
            'mine',
        );
        expect(await fsp.readdir(slotDir)).toEqual(['hand.txt']);
    });

    it('materialize: adopts an EMPTY real dir (auto-replace parity)', async () => {
        await makeDist({ 'workshop.txt': 'id=1' });
        await fsp.mkdir(slotDir, { recursive: true });
        const result = await materializeCopySlot(
            nodeCopyFs,
            nodeLinkFs,
            nodeRealFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(result.ok, result.detail).toBe(true);
        expect(
            await fsp.readFile(path.join(slotDir, 'workshop.txt'), 'utf8'),
        ).toBe('id=1');
    });

    it('materialize: refuses when a link exists inside the slot (nothing deleted)', async () => {
        await makeDist({ 'workshop.txt': 'id=1', 'Contents/a.lua': '-- a' });
        await fsp.mkdir(slotDir, { recursive: true });
        await writeMarker(slotDir);
        await fsp.writeFile(path.join(slotDir, 'keep.txt'), 'keep');
        const nested = path.join(slotDir, 'Contents');
        await fsp.mkdir(nested, { recursive: true });
        await fsp.symlink(distItem, path.join(nested, 'sneaky'), LINK_TYPE);
        const result = await materializeCopySlot(
            nodeCopyFs,
            nodeLinkFs,
            nodeRealFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(result.ok).toBe(false);
        expect(result.detail).toContain('ERR_COPY_SLOT_LINK_INSIDE');
        expect(await fsp.readFile(path.join(slotDir, 'keep.txt'), 'utf8')).toBe(
            'keep',
        );
    });

    it('materialize: an interrupted copy self-heals on the next pass', async () => {
        await makeDist({ 'workshop.txt': 'id=1', 'Contents/a.lua': '-- a' });
        // A crashed earlier pass left the marker + one stale file.
        await fsp.mkdir(path.join(slotDir, 'Contents'), { recursive: true });
        await writeMarker(slotDir);
        await fsp.writeFile(path.join(slotDir, 'workshop.txt'), 'stale');
        const result = await materializeCopySlot(
            nodeCopyFs,
            nodeLinkFs,
            nodeRealFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(result.ok, result.detail).toBe(true);
        expect(
            await fsp.readFile(path.join(slotDir, 'workshop.txt'), 'utf8'),
        ).toBe('id=1');
        expect(
            await fsp.readFile(path.join(slotDir, 'Contents/a.lua'), 'utf8'),
        ).toBe('-- a');
    });

    it('reconcile: prunes stale entries, overwrites changed, converges to zero-copy', async () => {
        await makeDist({
            'workshop.txt': 'id=1',
            'Contents/keep.lua': '-- keep',
            'Contents/gone/g.lua': '-- g',
        });
        await materializeCopySlot(
            nodeCopyFs,
            nodeLinkFs,
            nodeRealFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        // dist moves on: one file changed, one file gone, one tree gone.
        await fsp.writeFile(
            path.join(distItem, 'Contents/keep.lua'),
            '-- keep v2',
        );
        await fsp.unlink(path.join(distItem, 'Contents/gone/g.lua'));
        await fsp.rmdir(path.join(distItem, 'Contents/gone'));
        const before = await fsp.stat(path.join(slotDir, 'workshop.txt'));
        const second = await materializeCopySlot(
            nodeCopyFs,
            nodeLinkFs,
            nodeRealFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(second.ok, second.detail).toBe(true);
        expect(second.filesCopied).toBe(1); // keep.lua only
        expect(second.filesPruned).toBe(1); // the stale g.lua (dirs are structure)
        expect(
            await fsp.readFile(path.join(slotDir, 'Contents/keep.lua'), 'utf8'),
        ).toBe('-- keep v2');
        expect(await fsp.readdir(path.join(slotDir, 'Contents'))).toEqual([
            'keep.lua',
        ]);
        // The untouched file keeps its mtime — the third pass copies nothing.
        const after = await fsp.stat(path.join(slotDir, 'workshop.txt'));
        expect(after.mtimeMs).toBe(before.mtimeMs);
        const third = await materializeCopySlot(
            nodeCopyFs,
            nodeLinkFs,
            nodeRealFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(third.filesCopied).toBe(0);
        expect(third.filesPruned).toBe(0);
    });

    it('reconcile: replaces a slot dir with a dist file of the same name', async () => {
        await makeDist({ payload: 'now a file' });
        await fsp.mkdir(path.join(slotDir, 'payload'), { recursive: true });
        await writeMarker(slotDir);
        await fsp.writeFile(path.join(slotDir, 'payload', 'old.txt'), 'old');
        const result = await materializeCopySlot(
            nodeCopyFs,
            nodeLinkFs,
            nodeRealFs,
            slotDir,
            distItem,
            { ...opts(), copyIdentity: await identity() },
        );
        expect(result.ok, result.detail).toBe(true);
        const slotStats = await fsp.stat(path.join(slotDir, 'payload'));
        expect(slotStats.isDirectory()).toBe(false);
        expect(await fsp.readFile(path.join(slotDir, 'payload'), 'utf8')).toBe(
            'now a file',
        );
    });
});

describe('copy-slot marker (core)', () => {
    it('write → read roundtrip preserves the identity fields', async () => {
        const fs = new MemoryFileSystem();
        await writeCopySlotMarker(fs, {
            projectDir: '/proj',
            itemId: 'My Item',
            slotDir: '/deploy/My Item',
        });
        const marker = await readCopySlotMarker(
            fs,
            '/deploy/My Item/.pzstudio-copy.json',
        );
        expect(marker?.mode).toBe('copy');
        expect(marker?.itemId).toBe('My Item');
        expect(marker?.projectId).toBe(await computeProjectId('/proj'));
    });

    it('readCopySlotMarker rejects a JSON array', async () => {
        const fs = new MemoryFileSystem();
        await fs.write(
            '/slot/.pzstudio-copy.json',
            new TextEncoder().encode('[1,2]'),
        );
        expect(
            await readCopySlotMarker(fs, '/slot/.pzstudio-copy.json'),
        ).toBeUndefined();
    });

    it('readCopySlotMarker yields undefined for an absent marker', async () => {
        const fs = new MemoryFileSystem();
        expect(
            await readCopySlotMarker(fs, '/slot/.pzstudio-copy.json'),
        ).toBeUndefined();
    });

    it('platform-node excludes the same marker filename core owns', () => {
        // The materializer must neither copy nor prune the marker core
        // writes — the two constants must never drift apart.
        expect(NODE_COPY_MARKER_FILENAME).toBe(COPY_MARKER_FILENAME);
    });
});
