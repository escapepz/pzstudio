import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
    normalizeLinkTarget,
    inspectWorkshopLink,
    attachWorkshopLink,
    detachWorkshopLink,
    ERR_WORKSHOP_PATH_NOT_DIRECTORY,
    ERR_FOREIGN_WORKSHOP_LINK,
    ERR_LINK_IDENTITY_MISMATCH,
    ERR_UNOWNED_DIST_TARGET,
    ERR_WORKSHOP_DIR_EXISTS_REAL,
} from '../../packages/platform-node/src/link/linkManager';
import type {
    LinkFs,
    LinkState,
    StatsLike,
    RealFs,
} from '../../packages/platform-node/src/link/linkManager';

interface Errno {
    errno: string;
}

const err = (code: string): Errno => ({ errno: code });

const isErrno = (spec: unknown): spec is Errno =>
    typeof spec === 'object' &&
    spec !== null &&
    'errno' in (spec as Record<string, unknown>);

function errnoError(code: string): NodeJS.ErrnoException {
    const e = new Error(code) as NodeJS.ErrnoException;
    e.code = code;
    return e;
}

function makeStats(spec: {
    directory: boolean;
    symlink: boolean;
    dev?: bigint | number;
    ino?: bigint | number;
}): StatsLike {
    return {
        isDirectory: () => spec.directory,
        isSymbolicLink: () => spec.symlink,
        dev: spec.dev ?? 100n,
        ino: spec.ino ?? 4242n,
    };
}

const DEV = 100n;
const INO = 4242n;

const linkEntry = () => makeStats({ directory: false, symlink: true });

const identityStats = () =>
    makeStats({ directory: true, symlink: false, dev: DEV, ino: INO });

const WIN_W = 'C:\\games\\Workshop\\Item';
const WIN_D = 'd:\\PROJ\\dist\\item';
const WIN_LONG_TARGET = '\\\\?\\D:\\proj\\dist\\Item';
const WIN_FOREIGN_TARGET = '\\\\?\\D:\\other\\dist\\Other';

function makeFs(spec: {
    W: string;
    lstatW: StatsLike | Errno;
    readlinkW?: string | Errno;
    statW?: StatsLike | Errno;
    statD?: StatsLike | Errno;
}): LinkFs {
    const stat = async (
        p: string,
        _opts?: { bigint?: boolean },
    ): Promise<StatsLike> => {
        const chosen = p === spec.W ? spec.statW : spec.statD;
        if (chosen === undefined) {
            throw new Error(`unexpected stat(${p}) in scenario`);
        }
        if (isErrno(chosen)) throw errnoError(chosen.errno);
        return chosen;
    };
    return {
        lstat: async (p) => {
            if (isErrno(spec.lstatW)) throw errnoError(spec.lstatW.errno);
            return spec.lstatW;
        },
        readlink: async (p) => {
            if (spec.readlinkW === undefined) {
                throw new Error(`unexpected readlink(${p}) in scenario`);
            }
            if (isErrno(spec.readlinkW)) throw errnoError(spec.readlinkW.errno);
            return spec.readlinkW;
        },
        stat,
        realpath: async (p) => {
            throw new Error(`unexpected realpath(${p})`);
        },
        readdir: async (p) => {
            throw new Error(`unexpected readdir(${p})`);
        },
    };
}

function markerReaderFor(
    files: Record<string, { projectId: string } | undefined>,
    expectedProjectId: string,
): (distDir: string) => Promise<unknown> {
    return async (distDir) => {
        const marker = files[distDir];
        if (!marker) return undefined;
        return marker.projectId === expectedProjectId ? marker : undefined;
    };
}

const OWNED_MARKER = markerReaderFor(
    { [WIN_D]: { projectId: 'my-mod' } },
    'my-mod',
);

interface Row {
    name: string;
    platform: 'win32' | 'posix';
    W: string;
    D: string;
    lstatW: StatsLike | Errno;
    readlinkW?: string | Errno;
    statW?: StatsLike | Errno;
    statD?: StatsLike | Errno;
    readMarker?: (distDir: string) => Promise<unknown>;
    expected: LinkState;
    rawTarget?: string;
    detailContains?: string[];
}

const rows: Row[] = [
    {
        name: 'ENOENT at W -> ATTACHABLE',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: err('ENOENT'),
        expected: 'ATTACHABLE',
    },
    {
        name: 'real directory at W -> CONFLICT_REAL_DIR',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: makeStats({ directory: true, symlink: false }),
        expected: 'CONFLICT_REAL_DIR',
    },
    {
        name: 'plain file (neither dir nor link) -> NOT_DIRECTORY',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: makeStats({ directory: false, symlink: false }),
        expected: 'NOT_DIRECTORY',
        detailContains: [ERR_WORKSHOP_PATH_NOT_DIRECTORY],
    },
    {
        name: 'readlink EINVAL (unsupported reparse tag) -> NOT_DIRECTORY',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: makeStats({ directory: false, symlink: true }),
        readlinkW: err('EINVAL'),
        expected: 'NOT_DIRECTORY',
        detailContains: [ERR_WORKSHOP_PATH_NOT_DIRECTORY],
    },
    {
        name: 'win32 \\?\\-prefixed target, case-mixed D -> OK_LINK',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: linkEntry(),
        readlinkW: WIN_LONG_TARGET,
        statW: identityStats(),
        statD: identityStats(),
        readMarker: OWNED_MARKER,
        expected: 'OK_LINK',
        rawTarget: WIN_LONG_TARGET,
    },
    {
        name: 'target resolving elsewhere -> FOREIGN_LINK',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: linkEntry(),
        readlinkW: WIN_FOREIGN_TARGET,
        expected: 'FOREIGN_LINK',
        rawTarget: WIN_FOREIGN_TARGET,
        detailContains: [ERR_FOREIGN_WORKSHOP_LINK, WIN_FOREIGN_TARGET],
    },
    {
        name: 'link to D but stat(W) ENOENT -> DANGLING_LINK',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: linkEntry(),
        readlinkW: WIN_LONG_TARGET,
        statW: err('ENOENT'),
        statD: identityStats(),
        expected: 'DANGLING_LINK',
        rawTarget: WIN_LONG_TARGET,
        detailContains: ['dangling', 'ENOENT'],
    },
    {
        name: 'link to D but dev/ino differ -> IDENTITY_MISMATCH',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: linkEntry(),
        readlinkW: WIN_LONG_TARGET,
        statW: makeStats({
            directory: true,
            symlink: false,
            dev: DEV,
            ino: 9999n,
        }),
        statD: identityStats(),
        readMarker: OWNED_MARKER,
        expected: 'IDENTITY_MISMATCH',
        rawTarget: WIN_LONG_TARGET,
        detailContains: [ERR_LINK_IDENTITY_MISMATCH],
    },
    {
        name: 'link resolves to D but stat(D) ENOENT -> DANGLING_LINK',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: linkEntry(),
        readlinkW: WIN_LONG_TARGET,
        statW: identityStats(),
        statD: err('ENOENT'),
        expected: 'DANGLING_LINK',
        rawTarget: WIN_LONG_TARGET,
        detailContains: ['dangling', 'ENOENT'],
    },
    {
        name: 'bigint and plain dev/ino compare equal via BigInt coercion',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: linkEntry(),
        readlinkW: WIN_LONG_TARGET,
        statW: identityStats(),
        statD: makeStats({
            directory: true,
            symlink: false,
            dev: 100,
            ino: 4242,
        }),
        readMarker: OWNED_MARKER,
        expected: 'OK_LINK',
        rawTarget: WIN_LONG_TARGET,
    },
    {
        name: 'ownership marker missing in D -> UNOWNED_TARGET',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: linkEntry(),
        readlinkW: WIN_LONG_TARGET,
        statW: identityStats(),
        statD: identityStats(),
        readMarker: markerReaderFor({}, 'my-mod'),
        expected: 'UNOWNED_TARGET',
        rawTarget: WIN_LONG_TARGET,
        detailContains: [ERR_UNOWNED_DIST_TARGET],
    },
    {
        name: 'marker with foreign projectId -> UNOWNED_TARGET',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: linkEntry(),
        readlinkW: WIN_LONG_TARGET,
        statW: identityStats(),
        statD: identityStats(),
        readMarker: markerReaderFor(
            { [WIN_D]: { projectId: 'someone-elses' } },
            'my-mod',
        ),
        expected: 'UNOWNED_TARGET',
        rawTarget: WIN_LONG_TARGET,
        detailContains: [ERR_UNOWNED_DIST_TARGET],
    },
    {
        name: 'default readMarker (callback omitted) -> UNOWNED_TARGET',
        platform: 'win32',
        W: WIN_W,
        D: WIN_D,
        lstatW: linkEntry(),
        readlinkW: WIN_LONG_TARGET,
        statW: identityStats(),
        statD: identityStats(),
        expected: 'UNOWNED_TARGET',
        rawTarget: WIN_LONG_TARGET,
        detailContains: [ERR_UNOWNED_DIST_TARGET],
    },
    {
        name: 'posix target differing only in case -> FOREIGN_LINK',
        platform: 'posix',
        W: '/games/Workshop/Item',
        D: '/data/proj/dist/Item',
        lstatW: linkEntry(),
        readlinkW: '/data/proj/DIST/Item',
        expected: 'FOREIGN_LINK',
        rawTarget: '/data/proj/DIST/Item',
        detailContains: [ERR_FOREIGN_WORKSHOP_LINK],
    },
    {
        name: 'relative target resolves against the workshop dir -> OK_LINK',
        platform: 'win32',
        W: WIN_W,
        D: 'C:\\Dist\\item',
        lstatW: linkEntry(),
        readlinkW: '..\\..\\dist\\Item',
        statW: identityStats(),
        statD: identityStats(),
        readMarker: markerReaderFor(
            { 'C:\\Dist\\item': { projectId: 'my-mod' } },
            'my-mod',
        ),
        expected: 'OK_LINK',
        rawTarget: '..\\..\\dist\\Item',
    },
];

describe('inspectWorkshopLink cascade', () => {
    it.each(rows)('$name', async (row) => {
        const result = await inspectWorkshopLink(makeFs(row), row.W, row.D, {
            platform: row.platform,
            readMarker: row.readMarker,
        });

        expect(result.state).toBe(row.expected);
        if (row.rawTarget !== undefined) {
            expect(result.rawTarget).toBe(row.rawTarget);
        } else {
            expect(result.rawTarget).toBeUndefined();
        }
        if (row.detailContains) {
            expect(result.detail).toBeDefined();
            for (const fragment of row.detailContains) {
                expect(result.detail).toContain(fragment);
            }
        } else {
            expect(result.detail).toBeUndefined();
        }
    });
});

describe('inspectWorkshopLink marker discipline', () => {
    it('reads the ownership marker via D only, never via W', async () => {
        const markerCalls: string[] = [];
        const result = await inspectWorkshopLink(
            makeFs({
                W: WIN_W,
                lstatW: linkEntry(),
                readlinkW: WIN_LONG_TARGET,
                statW: identityStats(),
                statD: identityStats(),
            }),
            WIN_W,
            WIN_D,
            {
                platform: 'win32',
                readMarker: async (distDir) => {
                    markerCalls.push(distDir);
                    return { projectId: 'my-mod' };
                },
            },
        );

        expect(result.state).toBe('OK_LINK');
        expect(markerCalls).toEqual([WIN_D]);
    });
});

describe('inspectWorkshopLink reparse-tag blindness', () => {
    it('consults only isSymbolicLink/isDirectory and dev/ino on stats', async () => {
        const accessed = new Set<string>();
        const recordingStats = (spec: {
            directory: boolean;
            symlink: boolean;
        }): StatsLike => {
            const base: StatsLike = {
                isDirectory: () => spec.directory,
                isSymbolicLink: () => spec.symlink,
                dev: DEV,
                ino: INO,
            };
            return new Proxy(base, {
                get(target, prop) {
                    if (prop === 'then') return undefined;
                    accessed.add(String(prop));
                    return (target as Record<string | symbol, unknown>)[prop];
                },
            });
        };
        const fs: LinkFs = {
            lstat: async () =>
                recordingStats({ directory: false, symlink: true }),
            readlink: async () => WIN_LONG_TARGET,
            stat: async () =>
                recordingStats({ directory: true, symlink: false }),
            realpath: async (p) => {
                throw new Error(`unexpected realpath(${p})`);
            },
            readdir: async (p) => {
                throw new Error(`unexpected readdir(${p})`);
            },
        };

        const result = await inspectWorkshopLink(fs, WIN_W, WIN_D, {
            platform: 'win32',
            readMarker: async () => ({ projectId: 'my-mod' }),
        });

        expect(result.state).toBe('OK_LINK');
        const allowed = new Set([
            'isSymbolicLink',
            'isDirectory',
            'dev',
            'ino',
        ]);
        const unexpected = [...accessed].filter((prop) => !allowed.has(prop));
        expect(unexpected).toEqual([]);
    });
});

describe('normalizeLinkTarget', () => {
    it('strips a leading \\?\\ prefix and lowercases on win32', () => {
        expect(
            normalizeLinkTarget(
                '\\\\?\\D:\\proj\\dist\\Item',
                'C:\\games\\Workshop',
                'win32',
            ),
        ).toBe('d:\\proj\\dist\\item');
    });

    it('resolves a relative target against the link directory (win32)', () => {
        expect(
            normalizeLinkTarget(
                '..\\..\\dist\\Item',
                'C:\\games\\Workshop',
                'win32',
            ),
        ).toBe('c:\\dist\\item');
    });

    it('resolves a relative target against the link directory (posix)', () => {
        expect(
            normalizeLinkTarget('../dist/Item', '/games/Workshop', 'posix'),
        ).toBe('/games/dist/Item');
    });

    it('keeps case on posix so comparisons stay case-sensitive', () => {
        expect(normalizeLinkTarget('/Data/Proj/Item', '/x', 'posix')).toBe(
            '/Data/Proj/Item',
        );
    });
});

function realMutationFs(): RealFs {
    return {
        symlink: (target, linkPath, type) =>
            fsp.symlink(target, linkPath, type),
        rmdir: (p) => fsp.rmdir(p),
        rename: (src, dest) => fsp.rename(src, dest),
        unlink: (p) => fsp.unlink(p),
        readFile: (p) => fsp.readFile(p, 'utf8'),
    };
}

function realLinkFs(): LinkFs {
    return {
        lstat: (p) => fsp.lstat(p),
        readlink: (p) => fsp.readlink(p),
        stat: (p, opts) => fsp.stat(p, opts),
        realpath: (p) => fsp.realpath(p),
        readdir: (p) => fsp.readdir(p),
    };
}

type MutationOp = 'symlink' | 'rmdir' | 'rename' | 'unlink';
interface MutationCall {
    op: MutationOp;
    args: string[];
}

function spyMutations(inner: RealFs): {
    realFs: RealFs;
    calls: MutationCall[];
} {
    const calls: MutationCall[] = [];
    const record =
        (op: MutationOp) =>
        async (...args: string[]): Promise<void> => {
            calls.push({ op, args });
            const fn = inner[op] as (...a: string[]) => Promise<void>;
            return fn(...args);
        };
    return {
        realFs: {
            symlink: record('symlink'),
            rmdir: record('rmdir'),
            rename: record('rename'),
            unlink: record('unlink'),
            readFile: (p) => inner.readFile(p, 'utf8'),
        },
        calls,
    };
}

function withFault(
    inner: RealFs,
    op: 'rename' | 'symlink',
    code: string,
): RealFs {
    const fail = async (..._args: string[]): Promise<never> => {
        throw errnoError(code);
    };
    return { ...inner, [op]: fail } as RealFs;
}

function withSwapOnUnlink(inner: RealFs): RealFs {
    return {
        ...inner,
        unlink: async (p: string) => {
            await fsp.unlink(p);
            await fsp.mkdir(p);
            await fsp.writeFile(path.join(p, 'user-file.txt'), 'precious');
            throw errnoError('ENOTEMPTY');
        },
    };
}

const fixtureRoots: string[] = [];

afterEach(async () => {
    while (fixtureRoots.length > 0) {
        const root = fixtureRoots.pop() as string;
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
});

interface AttachFixture {
    base: string;
    W: string;
    D: string;
}

async function attachFixture(): Promise<AttachFixture> {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'pz-link-manager-'));
    fixtureRoots.push(base);
    const W = path.join(base, 'Workshop', 'Item');
    const D = path.join(base, 'dist', 'Item');
    await fsp.mkdir(path.dirname(W), { recursive: true });
    await fsp.mkdir(D, { recursive: true });
    return { base, W, D };
}

const ownedMarker = async (): Promise<unknown> => ({ projectId: 'my-mod' });

async function pathExists(p: string): Promise<boolean> {
    try {
        await fsp.lstat(p);
        return true;
    } catch {
        return false;
    }
}

let dirSymlinkSupported: boolean | undefined;
async function canCreateDirSymlinks(): Promise<boolean> {
    if (dirSymlinkSupported === undefined) {
        const probe = await fsp.mkdtemp(
            path.join(os.tmpdir(), 'pz-link-probe-'),
        );
        try {
            const target = path.join(probe, 't');
            await fsp.mkdir(target);
            await fsp.symlink(target, path.join(probe, 'l'), 'dir');
            dirSymlinkSupported = true;
        } catch {
            dirSymlinkSupported = false;
        } finally {
            await fsp.rm(probe, {
                recursive: true,
                force: true,
                maxRetries: 5,
            });
        }
    }
    return dirSymlinkSupported;
}

describe('attachWorkshopLink (real fs)', () => {
    it('W absent (win32) -> symlink(D, W, junction) with absolute D; junction resolves; target keeps its content', async () => {
        const { W, D } = await attachFixture();
        await fsp.writeFile(
            path.join(D, 'workshop.txt'),
            'version=1\nid=99999\n',
        );
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
        });

        expect(result.ok).toBe(true);
        expect(result.state).toBe('OK_LINK');
        expect(calls).toEqual([
            { op: 'symlink', args: [path.resolve(D), W, 'junction'] },
        ]);
        const throughLink = await fsp.stat(W);
        const direct = await fsp.stat(D);
        expect(throughLink.isDirectory()).toBe(true);
        expect(throughLink.dev).toBe(direct.dev);
        expect(throughLink.ino).toBe(direct.ino);
        expect((await fsp.lstat(W)).isSymbolicLink()).toBe(true);
        expect(await fsp.readFile(path.join(W, 'workshop.txt'), 'utf8')).toBe(
            'version=1\nid=99999\n',
        );
    });

    it('W absent (posix opt) -> symlink(D, W, dir) with absolute D; resolves when the OS allows dir symlinks, clean abort otherwise', async () => {
        const { W, D } = await attachFixture();
        await fsp.writeFile(
            path.join(D, 'workshop.txt'),
            'version=1\nid=99999\n',
        );
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'posix',
            readMarker: ownedMarker,
        });

        expect(calls).toEqual([
            { op: 'symlink', args: [path.resolve(D), W, 'dir'] },
        ]);
        if (await canCreateDirSymlinks()) {
            expect(result.ok).toBe(true);
            expect(result.state).toBe('OK_LINK');
            const throughLink = await fsp.stat(W);
            const direct = await fsp.stat(D);
            expect(throughLink.ino).toBe(direct.ino);
            expect(
                await fsp.readFile(path.join(W, 'workshop.txt'), 'utf8'),
            ).toBe('version=1\nid=99999\n');
        } else {
            expect(result.ok).toBe(false);
            expect(result.state).toBe('ATTACHABLE');
            expect(result.detail).toContain('EPERM');
            expect(await pathExists(W)).toBe(false);
        }
    });

    it('empty real dir at W -> rmdir(W) then junction (auto-replace)', async () => {
        const { W, D } = await attachFixture();
        await fsp.writeFile(path.join(D, 'workshop.txt'), 'version=1\n');
        await fsp.mkdir(W);
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
        });

        expect(result.ok).toBe(true);
        expect(result.state).toBe('OK_LINK');
        expect(calls).toEqual([
            { op: 'rmdir', args: [W] },
            { op: 'symlink', args: [path.resolve(D), W, 'junction'] },
        ]);
        expect((await fsp.lstat(W)).isSymbolicLink()).toBe(true);
        expect(await fsp.readFile(path.join(W, 'workshop.txt'), 'utf8')).toBe(
            'version=1\n',
        );
    });

    it('non-empty real dir, default opts -> refuse: zero mutation calls, CONFLICT_REAL_DIR, itemCount, unsynced id flagged', async () => {
        const { W, D } = await attachFixture();
        await fsp.writeFile(
            path.join(D, 'workshop.txt'),
            'version=1\nid=99999\n',
        );
        await fsp.mkdir(W);
        await fsp.writeFile(
            path.join(W, 'workshop.txt'),
            'version=1\nid=12345\n',
        );
        await fsp.writeFile(path.join(W, 'user-settings.cfg'), 'legacy');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
            sourceWorkshopTxt: 'version=1\ntitle=Item\n',
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('CONFLICT_REAL_DIR');
        expect(result.itemCount).toBe(2);
        expect(result.hasUnsyncedWorkshopId).toBe(true);
        expect(result.detail).toContain(ERR_WORKSHOP_DIR_EXISTS_REAL);
        expect(result.detail).toContain(W);
        expect(calls).toEqual([]);
        // Nothing at W was touched.
        expect(
            await fsp.readFile(path.join(W, 'workshop.txt'), 'utf8'),
        ).toContain('id=12345');
        expect(
            await fsp.readFile(path.join(W, 'user-settings.cfg'), 'utf8'),
        ).toBe('legacy');
    });

    it('refuse diagnosis: source carries the same id -> hasUnsyncedWorkshopId false', async () => {
        const { W, D } = await attachFixture();
        await fsp.mkdir(W);
        await fsp.writeFile(path.join(W, 'workshop.txt'), 'id=12345\n');
        await fsp.writeFile(path.join(W, 'extra.txt'), 'x');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
            sourceWorkshopTxt: 'version=1\nid=12345\n',
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('CONFLICT_REAL_DIR');
        expect(result.hasUnsyncedWorkshopId).toBe(false);
        expect(calls).toEqual([]);
    });

    it('refuse diagnosis: W/workshop.txt missing -> hasUnsyncedWorkshopId undefined', async () => {
        const { W, D } = await attachFixture();
        await fsp.mkdir(W);
        await fsp.writeFile(path.join(W, 'a.txt'), 'x');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
            sourceWorkshopTxt: 'version=1\nid=12345\n',
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('CONFLICT_REAL_DIR');
        expect(result.itemCount).toBe(1);
        expect(result.hasUnsyncedWorkshopId).toBeUndefined();
        expect(calls).toEqual([]);
    });

    it('refuse diagnosis: no source workshop.txt provided -> hasUnsyncedWorkshopId undefined', async () => {
        const { W, D } = await attachFixture();
        await fsp.mkdir(W);
        await fsp.writeFile(path.join(W, 'workshop.txt'), 'id=12345\n');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('CONFLICT_REAL_DIR');
        expect(result.hasUnsyncedWorkshopId).toBeUndefined();
        expect(calls).toEqual([]);
    });

    it('non-empty real dir + backupExisting -> rename to sibling backup then junction; backup returned and intact', async () => {
        const { W, D } = await attachFixture();
        await fsp.writeFile(
            path.join(D, 'workshop.txt'),
            'version=1\nid=99999\n',
        );
        await fsp.mkdir(W);
        await fsp.writeFile(path.join(W, 'workshop.txt'), 'id=12345\n');
        await fsp.writeFile(path.join(W, 'data.txt'), 'payload');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
            backupExisting: true,
        });

        expect(result.ok).toBe(true);
        expect(result.state).toBe('OK_LINK');
        expect(typeof result.backupPath).toBe('string');
        const backupPath = result.backupPath as string;
        expect(backupPath).not.toBe(W);
        expect(backupPath.startsWith(`${W}.backup-`)).toBe(true);
        expect(calls).toEqual([
            { op: 'rename', args: [W, backupPath] },
            { op: 'symlink', args: [path.resolve(D), W, 'junction'] },
        ]);
        expect(
            await fsp.readFile(path.join(backupPath, 'workshop.txt'), 'utf8'),
        ).toBe('id=12345\n');
        expect(
            await fsp.readFile(path.join(backupPath, 'data.txt'), 'utf8'),
        ).toBe('payload');
        expect((await fsp.lstat(W)).isSymbolicLink()).toBe(true);
        expect(await fsp.readFile(path.join(W, 'workshop.txt'), 'utf8')).toBe(
            'version=1\nid=99999\n',
        );
    });

    it('rename fails EBUSY -> clean abort: nothing deleted, no symlink, error surfaced without throwing', async () => {
        const { W, D } = await attachFixture();
        await fsp.mkdir(W);
        await fsp.writeFile(path.join(W, 'workshop.txt'), 'id=12345\n');
        await fsp.writeFile(path.join(W, 'data.txt'), 'payload');
        const faulty = withFault(realMutationFs(), 'rename', 'EBUSY');
        const { realFs, calls } = spyMutations(faulty);

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
            backupExisting: true,
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('CONFLICT_REAL_DIR');
        expect(result.detail).toContain('EBUSY');
        expect(calls).toEqual([
            { op: 'rename', args: [W, expect.any(String)] },
        ]);
        expect((await fsp.lstat(W)).isSymbolicLink()).toBe(false);
        expect(await fsp.readFile(path.join(W, 'data.txt'), 'utf8')).toBe(
            'payload',
        );
        expect(await pathExists(calls[0].args[1])).toBe(false);
    });

    it('symlink fails after the backup rename -> abort: backup preserved, slot empty, error surfaced', async () => {
        const { W, D } = await attachFixture();
        await fsp.mkdir(W);
        await fsp.writeFile(path.join(W, 'workshop.txt'), 'id=12345\n');
        const faulty = withFault(realMutationFs(), 'symlink', 'EPERM');
        const { realFs, calls } = spyMutations(faulty);

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
            backupExisting: true,
        });

        expect(result.ok).toBe(false);
        expect(result.detail).toContain('EPERM');
        expect(calls.map((c) => c.op)).toEqual(['rename', 'symlink']);
        const backupPath = calls[0].args[1];
        expect(
            await fsp.readFile(path.join(backupPath, 'workshop.txt'), 'utf8'),
        ).toBe('id=12345\n');
        expect(await pathExists(W)).toBe(false);
        expect(result.state).toBe('ATTACHABLE');
        expect(result.backupPath).toBe(backupPath);
    });

    it('FOREIGN_LINK + forceLink -> after cascade, unlink(W) then re-attach to D', async () => {
        const { base, W, D } = await attachFixture();
        await fsp.writeFile(
            path.join(D, 'workshop.txt'),
            'version=1\nid=99999\n',
        );
        const foreign = path.join(base, 'Other');
        await fsp.mkdir(foreign);
        await fsp.writeFile(path.join(foreign, 'keep.txt'), 'foreign');
        await fsp.symlink(foreign, W, 'junction');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
            forceLink: true,
        });

        expect(result.ok).toBe(true);
        expect(result.state).toBe('OK_LINK');
        expect(calls).toEqual([
            { op: 'unlink', args: [W] },
            { op: 'symlink', args: [path.resolve(D), W, 'junction'] },
        ]);
        expect(await fsp.readFile(path.join(W, 'workshop.txt'), 'utf8')).toBe(
            'version=1\nid=99999\n',
        );
        expect(await fsp.readFile(path.join(foreign, 'keep.txt'), 'utf8')).toBe(
            'foreign',
        );
    });

    it('FOREIGN_LINK without forceLink -> refuse: zero mutations', async () => {
        const { base, W, D } = await attachFixture();
        const foreign = path.join(base, 'Other');
        await fsp.mkdir(foreign);
        await fsp.writeFile(path.join(foreign, 'keep.txt'), 'foreign');
        await fsp.symlink(foreign, W, 'junction');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('FOREIGN_LINK');
        expect(result.detail).toContain(ERR_FOREIGN_WORKSHOP_LINK);
        expect(calls).toEqual([]);
        expect((await fsp.lstat(W)).isSymbolicLink()).toBe(true);
        const throughLink = await fsp.stat(W);
        const foreignStats = await fsp.stat(foreign);
        expect(throughLink.ino).toBe(foreignStats.ino);
    });

    it('UNOWNED_TARGET refuses even with forceLink', async () => {
        const { W, D } = await attachFixture();
        await fsp.writeFile(path.join(D, 'workshop.txt'), 'version=1\n');
        await fsp.symlink(D, W, 'junction');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: async () => undefined,
            forceLink: true,
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('UNOWNED_TARGET');
        expect(result.detail).toContain(ERR_UNOWNED_DIST_TARGET);
        expect(calls).toEqual([]);
        expect((await fsp.lstat(W)).isSymbolicLink()).toBe(true);
    });

    it('IDENTITY_MISMATCH refuses even with forceLink (fake cascade, real mutation spy)', async () => {
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(
            makeFs({
                W: WIN_W,
                lstatW: linkEntry(),
                readlinkW: path.resolve(WIN_D),
                statW: makeStats({
                    directory: true,
                    symlink: false,
                    dev: DEV,
                    ino: 9999n,
                }),
                statD: identityStats(),
            }),
            realFs,
            WIN_W,
            WIN_D,
            { platform: 'win32', readMarker: OWNED_MARKER, forceLink: true },
        );

        expect(result.ok).toBe(false);
        expect(result.state).toBe('IDENTITY_MISMATCH');
        expect(result.detail).toContain(ERR_LINK_IDENTITY_MISMATCH);
        expect(calls).toEqual([]);
    });

    it('DANGLING_LINK -> refuse: zero mutations (re-creating the link cannot fix a missing D)', async () => {
        const { W, D } = await attachFixture();
        await fsp.symlink(D, W, 'junction');
        await fsp.rm(D, { recursive: true, force: true });
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('DANGLING_LINK');
        expect(calls).toEqual([]);
    });

    it('OK_LINK -> idempotent no-op: zero mutation calls', async () => {
        const { W, D } = await attachFixture();
        await fsp.writeFile(
            path.join(D, 'workshop.txt'),
            'version=1\nid=99999\n',
        );
        await fsp.symlink(D, W, 'junction');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
            readMarker: ownedMarker,
        });

        expect(result.ok).toBe(true);
        expect(result.state).toBe('OK_LINK');
        expect(calls).toEqual([]);
        expect(await fsp.readFile(path.join(W, 'workshop.txt'), 'utf8')).toBe(
            'version=1\nid=99999\n',
        );
    });

    it('W absent without a readMarker -> attach succeeds; identity verified, ownership unverified (UNOWNED_TARGET)', async () => {
        const { W, D } = await attachFixture();
        await fsp.writeFile(path.join(D, 'workshop.txt'), 'version=1\n');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await attachWorkshopLink(realLinkFs(), realFs, W, D, {
            platform: 'win32',
        });

        expect(result.ok).toBe(true);
        expect(result.state).toBe('UNOWNED_TARGET');
        expect(result.detail).toContain(ERR_UNOWNED_DIST_TARGET);
        expect(calls.map((c) => c.op)).toEqual(['symlink']);
        expect((await fsp.lstat(W)).isSymbolicLink()).toBe(true);
    });
});

describe('detachWorkshopLink (real fs)', () => {
    it('junction at W -> unlink(W) only; the target keeps its content', async () => {
        const { W, D } = await attachFixture();
        await fsp.writeFile(
            path.join(D, 'workshop.txt'),
            'version=1\nid=99999\n',
        );
        await fsp.symlink(D, W, 'junction');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await detachWorkshopLink(realLinkFs(), realFs, W, {
            platform: 'win32',
        });

        expect(result.ok).toBe(true);
        expect(result.state).toBe('ATTACHABLE');
        expect(calls).toEqual([{ op: 'unlink', args: [W] }]);
        expect(await pathExists(W)).toBe(false);
        expect(await fsp.readFile(path.join(D, 'workshop.txt'), 'utf8')).toBe(
            'version=1\nid=99999\n',
        );
    });

    it('W absent -> idempotent ok, zero mutation calls', async () => {
        const { W } = await attachFixture();
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await detachWorkshopLink(realLinkFs(), realFs, W, {
            platform: 'win32',
        });

        expect(result.ok).toBe(true);
        expect(result.state).toBe('ATTACHABLE');
        expect(result.detail).toContain('nothing to detach');
        expect(calls).toEqual([]);
    });

    it('real non-empty dir at W -> refuse: zero mutation calls, nothing removed', async () => {
        const { W } = await attachFixture();
        await fsp.mkdir(W);
        await fsp.writeFile(path.join(W, 'workshop.txt'), 'id=12345\n');
        await fsp.writeFile(path.join(W, 'user-file.txt'), 'precious');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await detachWorkshopLink(realLinkFs(), realFs, W, {
            platform: 'win32',
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('CONFLICT_REAL_DIR');
        expect(result.detail).toContain('unlink-only');
        expect(calls).toEqual([]);
        expect(await fsp.readFile(path.join(W, 'user-file.txt'), 'utf8')).toBe(
            'precious',
        );
    });

    it('empty real dir at W -> refused as well: detach never rmdirs', async () => {
        const { W } = await attachFixture();
        await fsp.mkdir(W);
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await detachWorkshopLink(realLinkFs(), realFs, W, {
            platform: 'win32',
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('CONFLICT_REAL_DIR');
        expect(calls).toEqual([]);
        expect(await pathExists(W)).toBe(true);
    });

    it('plain file at W -> refuse NOT_DIRECTORY: zero mutation calls', async () => {
        const { W } = await attachFixture();
        await fsp.writeFile(W, 'a file');
        const { realFs, calls } = spyMutations(realMutationFs());

        const result = await detachWorkshopLink(realLinkFs(), realFs, W, {
            platform: 'win32',
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('NOT_DIRECTORY');
        expect(result.detail).toContain(ERR_WORKSHOP_PATH_NOT_DIRECTORY);
        expect(calls).toEqual([]);
    });

    it('TOCTOU: real non-empty dir swapped in during the race -> unlink rejects ENOTEMPTY -> clean error, zero deletions, no rm/rmdir in the log', async () => {
        const { W, D } = await attachFixture();
        await fsp.writeFile(path.join(D, 'workshop.txt'), 'version=1\n');
        await fsp.symlink(D, W, 'junction');
        const swapping = withSwapOnUnlink(realMutationFs());
        const { realFs, calls } = spyMutations(swapping);

        const result = await detachWorkshopLink(realLinkFs(), realFs, W, {
            platform: 'win32',
        });

        expect(result.ok).toBe(false);
        expect(result.state).toBe('CONFLICT_REAL_DIR');
        expect(result.detail).toContain('ENOTEMPTY');
        expect(result.detail).toContain('nothing was deleted');
        expect(calls).toEqual([{ op: 'unlink', args: [W] }]);
        expect((await fsp.lstat(W)).isSymbolicLink()).toBe(false);
        expect(await fsp.readFile(path.join(W, 'user-file.txt'), 'utf8')).toBe(
            'precious',
        );
        expect(await fsp.readFile(path.join(D, 'workshop.txt'), 'utf8')).toBe(
            'version=1\n',
        );
    });
});
