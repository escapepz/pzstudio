import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// resolve to repo-root scripts via relative path
const nodeRequire = createRequire(import.meta.url);
const pin = nodeRequire('../../scripts/pin-template-legacy.js');

describe('loadConfig', () => {
    it('loads the four templates with valid modes', () => {
        const cfg = pin.loadConfig();
        expect(cfg.map((c: any) => c.name)).toEqual([
            '.template-project',
            '.template-mod',
            '.template-workshop',
            '.template-language',
        ]);
        expect(
            cfg.every((c: any) => c.mode === 'tag' || c.mode === 'branch'),
        ).toBe(true);
        expect(
            cfg.every((c: any) =>
                c.url.startsWith('https://github.com/escapepz/'),
            ),
        ).toBe(true);
    });
});

describe('parseLsRemoteTags', () => {
    it('splits sha<TAB>ref lines and attaches ^{} peels to their base ref', () => {
        const out = [
            'ce4de87534349852087295069d2e1113137d9831\trefs/tags/42.13.1',
            '9aabe6726adc4789c24b1948b1a8dff01942e12e\trefs/tags/42.13.1^{}',
            'd26a2f800057e33d81e0592774c67dd812500f06\trefs/tags/42.22.0-20261109-1902',
            '75688f88daa9336230a4095156218aead123a82a\trefs/heads/main',
            '75688f88daa9336230a4095156218aead123a82a\tHEAD',
        ].join('\n');
        const entries = pin.parseLsRemoteTags(out);
        const annotated = entries.find(
            (e: any) => e.ref === 'refs/tags/42.13.1',
        );
        expect(annotated.peeledSha).toBe(
            '9aabe6726adc4789c24b1948b1a8dff01942e12e',
        );
        expect(entries.find((e: any) => e.ref === 'HEAD')).toBeTruthy();
    });
});

describe('resolvePin tag mode', () => {
    const entries = pin.parseLsRemoteTags(
        [
            '1111111111111111111111111111111111111111\trefs/tags/42.13.1',
            '2222222222222222222222222222222222222222\trefs/tags/42.13.1^{}',
            '3333333333333333333333333333333333333333\trefs/tags/42.13.1-simple',
            '4444444444444444444444444444444444444444\trefs/tags/42.0',
            '5555555555555555555555555555555555555555\trefs/tags/default',
            '6666666666666666666666666666666666666666\trefs/tags/42.22.0-20261109-1902',
            '7777777777777777777777777777777777777777\trefs/heads/main',
            '7777777777777777777777777777777777777777\tHEAD',
        ].join('\n'),
    );

    it('picks semver-highest numeric tag and uses the peeled sha for annotated tags', () => {
        expect(pin.resolvePin(entries, 'tag')).toEqual({
            sha: '6666666666666666666666666666666666666666',
            source: 'refs/tags/42.22.0-20261109-1902',
        });
    });
    it('suffix tags lose to the plain version', () => {
        const few = pin.parseLsRemoteTags(
            [
                '1111111111111111111111111111111111111111\trefs/tags/42.13.1',
                '2222222222222222222222222222222222222222\trefs/tags/42.13.1^{}',
                '3333333333333333333333333333333333333333\trefs/tags/42.13.1-simple',
            ].join('\n'),
        );
        expect(pin.resolvePin(few, 'tag')!.sha).toBe(
            '2222222222222222222222222222222222222222',
        );
    });
    it('returns undefined when no numeric tag exists', () => {
        const none = pin.parseLsRemoteTags('aaaa\trefs/tags/default');
        expect(pin.resolvePin(none, 'tag')).toBeUndefined();
    });
});

describe('resolvePin branch mode', () => {
    it('uses the HEAD tip sha', () => {
        const entries = pin.parseLsRemoteTags(
            '75688f88daa9336230a4095156218aead123a82a\tHEAD',
        );
        expect(pin.resolvePin(entries, 'branch')).toEqual({
            sha: '75688f88daa9336230a4095156218aead123a82a',
            source: 'HEAD',
        });
    });
});

// ---------------------------------------------------------------------------
// Pin diff, gitlink apply, CLI entry
// ---------------------------------------------------------------------------

const PROJECT_SHA = '8373400243235d4ce121656886393c58a70501b5';
const MOD_SHA = '561b717fa0224c404108cbc5ac1a70d80ce0eef7';
const NEWER_PROJECT_SHA = '6666666666666666666666666666666666666666';
const WORKSHOP_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// Canned `git ls-tree HEAD .template-legacy/` output (tree line + gitlinks).
const LS_TREE_OUTPUT = [
    '040000 tree e55734848205eefa023ac3eaf5393c8932c00a8a\t.template-legacy',
    `160000 commit ${PROJECT_SHA}\t.template-legacy/.template-project`,
    `160000 commit ${MOD_SHA}\t.template-legacy/.template-mod`,
].join('\n');

// Real URLs from scripts/template-pin.json, so `main` tests (which load the
// real config) can key their fake ls-remote answers by URL.
const URL_BY_NAME: Record<string, string> = {};
for (const entry of pin.loadConfig()) {
    URL_BY_NAME[entry.name] = entry.url;
}

interface FakeGitOptions {
    lsRemoteByUrl?: Record<string, string>;
    lsTree?: string;
    updateIndexStatus?: number;
    /** `git -C <dir> --git-dir=.git rev-parse HEAD` answer per submodule dir. */
    revParseByDir?: Record<string, { status?: number; stdout?: string }>;
    /** stdout for `git -C <dir> for-each-ref` (the update-ref --stdin feed). */
    forEachRefOut?: string;
    submoduleUpdateStatus?: number;
}

/** Fake GitRunner: answers git calls from canned maps, records calls+opts. */
function makeFakeGit(options: FakeGitOptions = {}) {
    const calls: string[][] = [];
    const runOpts: ({ input?: string } | undefined)[] = [];
    const runner = (args: string[], opts?: { input?: string }) => {
        calls.push(args);
        runOpts.push(opts);
        if (args[0] === 'ls-remote') {
            return {
                status: 0,
                stdout: options.lsRemoteByUrl?.[args[1]] ?? '',
                stderr: '',
            };
        }
        if (args[0] === 'ls-tree') {
            return { status: 0, stdout: options.lsTree ?? '', stderr: '' };
        }
        if (args[0] === 'update-index') {
            return {
                status: options.updateIndexStatus ?? 0,
                stdout: '',
                stderr: options.updateIndexStatus ? 'update-index failed' : '',
            };
        }
        if (args[0] === '-C' && args[2] === '--git-dir=.git') {
            const answer = options.revParseByDir?.[args[1]] ?? {};
            return {
                status: answer.status ?? 0,
                stdout: answer.stdout ?? '',
                stderr: '',
            };
        }
        if (args[0] === '-C' && args[2] === 'for-each-ref') {
            return {
                status: 0,
                stdout: options.forEachRefOut ?? '',
                stderr: '',
            };
        }
        if (args[0] === 'submodule') {
            return {
                status: options.submoduleUpdateStatus ?? 0,
                stdout: '',
                stderr: options.submoduleUpdateStatus
                    ? 'submodule update failed'
                    : '',
            };
        }
        // fetch, reset, update-ref, reflog expire, gc
        return { status: 0, stdout: '', stderr: '' };
    };
    return { runner, calls, runOpts };
}

/** Collect console.log lines emitted by fn, restoring the real log after. */
function captureLogs(fn: () => void): string[] {
    const logs: string[] = [];
    const spy = vi
        .spyOn(console, 'log')
        .mockImplementation((...args: any[]) => {
            logs.push(args.join(' '));
        });
    try {
        fn();
    } finally {
        spy.mockRestore();
    }
    return logs;
}

/** Capture lines written via the given console method (warn/error) during fn. */
function captureStream(method: 'warn' | 'error', fn: () => void): string[] {
    const lines: string[] = [];
    const spy = vi
        .spyOn(console, method)
        .mockImplementation((...args: any[]) => {
            lines.push(args.join(' '));
        });
    try {
        fn();
    } finally {
        spy.mockRestore();
    }
    return lines;
}

describe('readCurrentPins', () => {
    it('parses gitlink entries from ls-tree output and ignores tree lines', () => {
        const fake = makeFakeGit({ lsTree: LS_TREE_OUTPUT });
        const pins = pin.readCurrentPins(fake.runner);
        expect(pins.size).toBe(2);
        expect(pins.get('.template-project')).toBe(PROJECT_SHA);
        expect(pins.get('.template-mod')).toBe(MOD_SHA);
        expect(fake.calls).toEqual([['ls-tree', 'HEAD', '.template-legacy/']]);
    });
});

describe('computeUpdates', () => {
    const config = [
        {
            name: '.template-project',
            url: 'https://example.com/project',
            mode: 'tag',
        },
        {
            name: '.template-mod',
            url: 'https://example.com/mod',
            mode: 'tag',
        },
        {
            name: '.template-workshop',
            url: 'https://example.com/workshop',
            mode: 'branch',
        },
    ];

    it('flags newer remotes, keeps exact pins, skips unresolvable repos', () => {
        const fake = makeFakeGit({
            lsTree: LS_TREE_OUTPUT,
            lsRemoteByUrl: {
                // project: remote moved ahead of the pinned sha -> update
                'https://example.com/project': `${NEWER_PROJECT_SHA}\trefs/tags/42.22.0-20261109-1902\n`,
                // mod: remote newest tag == pinned sha -> no update
                'https://example.com/mod': `${MOD_SHA}\trefs/tags/42.22.0\n`,
                // workshop: no remote answer -> resolvePin undefined -> skip
            },
        });
        expect(pin.computeUpdates(fake.runner, config)).toEqual([
            {
                name: '.template-project',
                from: PROJECT_SHA,
                to: NEWER_PROJECT_SHA,
                source: 'refs/tags/42.22.0-20261109-1902',
            },
        ]);
    });
});

describe('applyUpdates', () => {
    const updates = [
        {
            name: '.template-project',
            from: PROJECT_SHA,
            to: NEWER_PROJECT_SHA,
            source: 'refs/tags/42.22.0-20261109-1902',
        },
        {
            name: '.template-workshop',
            from: undefined,
            to: WORKSHOP_SHA,
            source: 'HEAD',
        },
    ];

    it('stages one update-index --cacheinfo per update and returns the count', () => {
        const fake = makeFakeGit();
        expect(pin.applyUpdates(fake.runner, updates)).toBe(2);
        expect(fake.calls).toEqual([
            [
                'update-index',
                '--cacheinfo',
                `160000,${NEWER_PROJECT_SHA},.template-legacy/.template-project`,
            ],
            [
                'update-index',
                '--cacheinfo',
                `160000,${WORKSHOP_SHA},.template-legacy/.template-workshop`,
            ],
        ]);
    });

    it('throws when update-index exits nonzero', () => {
        const fake = makeFakeGit({ updateIndexStatus: 128 });
        expect(() => pin.applyUpdates(fake.runner, [updates[0]])).toThrow(
            /update-index/,
        );
    });
});

describe('main', () => {
    function fakeRunnerFor(remoteShas: Record<string, string>) {
        return makeFakeGit({
            lsTree: LS_TREE_OUTPUT,
            lsRemoteByUrl: Object.fromEntries(
                Object.entries(remoteShas).map(([name, sha]) => [
                    URL_BY_NAME[name],
                    `${sha}\trefs/tags/42.22.0-20261109-1902\n`,
                ]),
            ),
        });
    }

    it('--check exits 1 and lists pending updates', () => {
        const fake = fakeRunnerFor({
            '.template-project': NEWER_PROJECT_SHA,
            '.template-mod': MOD_SHA,
        });
        const logs = captureLogs(() => {
            expect(pin.main(['--check'], fake.runner)).toBe(1);
        });
        expect(logs).toContain(
            `- .template-project: ${PROJECT_SHA} → ${NEWER_PROJECT_SHA} (refs/tags/42.22.0-20261109-1902)`,
        );
    });

    it('--check exits 0 when every pin is current', () => {
        const fake = fakeRunnerFor({
            '.template-project': PROJECT_SHA,
            '.template-mod': MOD_SHA,
        });
        const logs = captureLogs(() => {
            expect(pin.main(['--check'], fake.runner)).toBe(0);
        });
        expect(logs.every((line) => !line.startsWith('- '))).toBe(true);
    });

    it('default mode applies pending updates and prints a summary', () => {
        const fake = fakeRunnerFor({ '.template-project': NEWER_PROJECT_SHA });
        const logs = captureLogs(() => {
            expect(pin.main([], fake.runner)).toBe(0);
        });
        expect(fake.calls).toContainEqual([
            'update-index',
            '--cacheinfo',
            `160000,${NEWER_PROJECT_SHA},.template-legacy/.template-project`,
        ]);
        expect(logs).toContain('Pinned 1 template(s)');
    });

    it('unknown flag prints usage and exits 2 without running git', () => {
        const fake = makeFakeGit();
        const logs = captureLogs(() => {
            expect(pin.main(['--bogus'], fake.runner)).toBe(2);
        });
        expect(fake.calls).toEqual([]);
        expect(logs.some((line) => line.includes('Usage:'))).toBe(true);
    });

    it('--sync materializes pinned checkouts and prints a line per move', () => {
        const fake = makeFakeGit({
            lsRemoteByUrl: {
                [URL_BY_NAME['.template-project']]:
                    `${NEWER_PROJECT_SHA}\trefs/tags/42.22.0-20261109-1902\n`,
                [URL_BY_NAME['.template-mod']]:
                    `${MOD_SHA}\trefs/tags/42.21.0\n`,
                [URL_BY_NAME['.template-workshop']]: `${WORKSHOP_SHA}\tHEAD\n`,
                [URL_BY_NAME['.template-language']]: `${LANG_SHA}\tHEAD\n`,
            },
            forEachRefOut: FOR_EACH_REF_OUT,
        });
        const logs = captureLogs(() => {
            expect(pin.main(['--sync'], fake.runner)).toBe(0);
        });
        expect(
            logs.filter((line) => line.startsWith('- Synced ')),
        ).toHaveLength(4);
        expect(logs).toContain(
            `- Synced .template-project (${NEWER_PROJECT_SHA})`,
        );
        expect(fake.calls).toContainEqual([
            '-C',
            '.template-legacy/.template-project',
            '-c',
            'protocol.version=2',
            'fetch',
            '--depth',
            '1',
            '--no-tags',
            'origin',
            NEWER_PROJECT_SHA,
        ]);
    });

    it('prints the error and exits 2 when git fails (error boundary)', () => {
        const runner = (args: string[]) => {
            if (args[0] === 'ls-remote') throw new Error('network down');
            return { status: 0, stdout: LS_TREE_OUTPUT, stderr: '' };
        };
        const errs = captureStream('error', () => {
            expect(pin.main([], runner)).toBe(2);
        });
        expect(errs.some((line) => line.includes('network down'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// --sync: depth-1 pinned checkout materialization
// ---------------------------------------------------------------------------

const PIN_SHA = 'dddddddddddddddddddddddddddddddddddddddd';
const OLD_SHA = 'cccccccccccccccccccccccccccccccccccccccc';
const LANG_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FOR_EACH_REF_OUT = 'delete refs/remotes/origin/main\n';

const SYNC_CONFIG = [
    {
        name: '.template-project',
        url: 'https://example.com/project',
        mode: 'tag',
    },
];

const SYNC_DIR = '.template-legacy/.template-project';

function fakeForPin(revParse: { status?: number; stdout?: string }) {
    return makeFakeGit({
        lsRemoteByUrl: {
            'https://example.com/project': `${PIN_SHA}\trefs/tags/42.22.0-20261109-1902\n`,
        },
        revParseByDir: { [SYNC_DIR]: revParse },
        forEachRefOut: FOR_EACH_REF_OUT,
    });
}

describe('syncSubmodules', () => {
    it('initializes a missing submodule at depth 1, moves it to the pin, purges', () => {
        const fake = fakeForPin({ status: 128 });
        const logs = captureLogs(() => {
            expect(pin.syncSubmodules(fake.runner, SYNC_CONFIG)).toBe(1);
        });
        expect(logs).toContain(`- Synced .template-project (${PIN_SHA})`);
        expect(fake.calls).toEqual([
            ['ls-remote', 'https://example.com/project'],
            ['-C', SYNC_DIR, '--git-dir=.git', 'rev-parse', 'HEAD'],
            ['submodule', 'update', '--init', '--depth', '1', '--', SYNC_DIR],
            [
                '-C',
                SYNC_DIR,
                '-c',
                'protocol.version=2',
                'fetch',
                '--depth',
                '1',
                '--no-tags',
                'origin',
                PIN_SHA,
            ],
            ['-C', SYNC_DIR, 'reset', '--hard', PIN_SHA],
            [
                '-C',
                SYNC_DIR,
                'for-each-ref',
                '--format=delete %(refname)',
                'refs/remotes',
                'refs/tags',
            ],
            ['-C', SYNC_DIR, 'update-ref', '--stdin', '--no-deref'],
            ['-C', SYNC_DIR, 'reflog', 'expire', '--expire=now', '--all'],
            ['-C', SYNC_DIR, 'gc', '--prune=now', '--quiet'],
        ]);
    });

    it('only purges when the checkout already sits at the pinned sha', () => {
        const fake = fakeForPin({ status: 0, stdout: `${PIN_SHA}\n` });
        const logs = captureLogs(() => {
            expect(pin.syncSubmodules(fake.runner, SYNC_CONFIG)).toBe(0);
        });
        expect(logs).toEqual([]);
        expect(fake.calls).toEqual([
            ['ls-remote', 'https://example.com/project'],
            ['-C', SYNC_DIR, '--git-dir=.git', 'rev-parse', 'HEAD'],
            [
                '-C',
                SYNC_DIR,
                'for-each-ref',
                '--format=delete %(refname)',
                'refs/remotes',
                'refs/tags',
            ],
            ['-C', SYNC_DIR, 'update-ref', '--stdin', '--no-deref'],
            ['-C', SYNC_DIR, 'reflog', 'expire', '--expire=now', '--all'],
            ['-C', SYNC_DIR, 'gc', '--prune=now', '--quiet'],
        ]);
    });

    it('fetches the pinned sha at depth 1 and resets when behind, then purges', () => {
        const fake = fakeForPin({ status: 0, stdout: `${OLD_SHA}\n` });
        const logs = captureLogs(() => {
            expect(pin.syncSubmodules(fake.runner, SYNC_CONFIG)).toBe(1);
        });
        expect(logs).toContain(`- Synced .template-project (${PIN_SHA})`);
        expect(fake.calls).toEqual([
            ['ls-remote', 'https://example.com/project'],
            ['-C', SYNC_DIR, '--git-dir=.git', 'rev-parse', 'HEAD'],
            [
                '-C',
                SYNC_DIR,
                '-c',
                'protocol.version=2',
                'fetch',
                '--depth',
                '1',
                '--no-tags',
                'origin',
                PIN_SHA,
            ],
            ['-C', SYNC_DIR, 'reset', '--hard', PIN_SHA],
            [
                '-C',
                SYNC_DIR,
                'for-each-ref',
                '--format=delete %(refname)',
                'refs/remotes',
                'refs/tags',
            ],
            ['-C', SYNC_DIR, 'update-ref', '--stdin', '--no-deref'],
            ['-C', SYNC_DIR, 'reflog', 'expire', '--expire=now', '--all'],
            ['-C', SYNC_DIR, 'gc', '--prune=now', '--quiet'],
        ]);
    });

    it('pipes the for-each-ref delete list into update-ref --stdin', () => {
        const fake = fakeForPin({ status: 0, stdout: `${OLD_SHA}\n` });
        captureLogs(() => {
            pin.syncSubmodules(fake.runner, SYNC_CONFIG);
        });
        const index = fake.calls.findIndex((args) => args[2] === 'update-ref');
        expect(index).toBeGreaterThan(-1);
        expect(fake.calls[index]).toEqual([
            '-C',
            SYNC_DIR,
            'update-ref',
            '--stdin',
            '--no-deref',
        ]);
        expect(fake.runOpts[index]).toEqual({ input: FOR_EACH_REF_OUT });
    });

    it('skips a repo whose pin cannot be resolved, with a warning', () => {
        const fake = makeFakeGit({
            lsRemoteByUrl: {
                'https://example.com/project': 'aaaa\trefs/tags/default\n',
            },
        });
        const warns = captureStream('warn', () => {
            expect(pin.syncSubmodules(fake.runner, SYNC_CONFIG)).toBe(0);
        });
        expect(fake.calls).toEqual([
            ['ls-remote', 'https://example.com/project'],
        ]);
        expect(warns.some((line) => line.includes('.template-project'))).toBe(
            true,
        );
    });
});

describe('defaultRunner', () => {
    // The purge feeds `update-ref --stdin` through the runner's `input` opt;
    // with stdio[0] ignored spawnSync silently drops the input, so pin the
    // stdin plumbing with real git (offline: plain hash-object, no repo).
    it('feeds the input option into git stdin', () => {
        const content = 'hello\n';
        const res = pin.defaultRunner(['hash-object', '--stdin'], {
            input: content,
        });
        expect(res.status).toBe(0);
        // git prints the blob object id: sha1("blob <len>\0" + content)
        expect(res.stdout.trim()).toBe(
            createHash('sha1')
                .update(`blob ${Buffer.byteLength(content)}\0`)
                .update(content)
                .digest('hex'),
        );
    });
});
