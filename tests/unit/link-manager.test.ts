import { describe, it, expect } from 'vitest';
import {
    normalizeLinkTarget,
    inspectWorkshopLink,
    ERR_WORKSHOP_PATH_NOT_DIRECTORY,
    ERR_FOREIGN_WORKSHOP_LINK,
    ERR_LINK_IDENTITY_MISMATCH,
    ERR_UNOWNED_DIST_TARGET,
} from '../../packages/platform-node/src/link/linkManager';
import type {
    LinkFs,
    LinkState,
    StatsLike,
} from '../../packages/platform-node/src/link/linkManager';

/** Thrown instead of a StatsLike / raw target in a fake-LinkFs scenario. */
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

/** lstat(W): the workshop entry itself is a link. */
const linkEntry = () => makeStats({ directory: false, symlink: true });

/**
 * stat(W) with bigint:true — following the link lands on the dist
 * directory, so the stats describe a real directory with the identity
 * every scenario shares.
 */
const identityStats = () =>
    makeStats({ directory: true, symlink: false, dev: DEV, ino: INO });

/** win32 scenario paths (as Task 4 passes them: absolute, mixed case). */
const WIN_W = 'C:\\games\\Workshop\\Item';
const WIN_D = 'd:\\PROJ\\dist\\item';
const WIN_LONG_TARGET = '\\\\?\\D:\\proj\\dist\\Item';
const WIN_FOREIGN_TARGET = '\\\\?\\D:\\other\\dist\\Other';

/**
 * Fake LinkFs for one scenario. realpath/readdir belong to Task 2's
 * attach/detach maintenance — the inspection cascade must never call them,
 * so they fail loudly instead of returning fake data.
 */
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

/**
 * Simulates the marker reader Task 3/4 will wire: reads the ownership
 * marker of `distDir` and returns it only when it belongs to the expected
 * project — a missing file and a foreign projectId both come back as
 * undefined, i.e. "not ours".
 */
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
    /** Required when the cascade reads a link target. */
    rawTarget?: string;
    /** Fragments that must appear in detail; omit when detail is absent. */
    detailContains?: string[];
}

// One scenario per cascade branch, in the brief's order.
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
        // OneDrive cloud placeholders and AppExecLink entries report
        // link-shaped metadata while readlink rejects them with EINVAL.
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
        // The seam may hand back plain-number stats (a stat impl ignoring
        // the bigint option) while W reports bigints — identity must be
        // compared numerically, never by reference.
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
        // No marker file at D — the reader reports "not ours".
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
        // Keyed by this row's D: the reader is probed with D as passed,
        // which differs from WIN_D.
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
        // Exactly one probe, addressed to D as passed — never to W (which
        // differs from D in every scenario by construction).
        expect(markerCalls).toEqual([WIN_D]);
    });
});

describe('inspectWorkshopLink reparse-tag blindness', () => {
    it('consults only isSymbolicLink/isDirectory and dev/ino on stats', async () => {
        // The fake seam cannot express junction-vs-symlink metadata (Node
        // reports junctions through the same isSymbolicLink() predicate as
        // symlinks anyway). To pin the blindness contract, every stats
        // object is a Proxy that records each property the cascade reads:
        // a full OK_LINK pass must access nothing beyond the two
        // predicates and the dev/ino identity fields.
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
                    // The thenable check the promise machinery runs on the
                    // fake's return value is not a cascade access; ignore
                    // it so only real reads are recorded.
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
