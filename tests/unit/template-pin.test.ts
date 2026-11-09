import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

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
}

/** Fake GitRunner: answers ls-remote/ls-tree from canned maps, records calls. */
function makeFakeGit(options: FakeGitOptions = {}) {
    const calls: string[][] = [];
    const runner = (args: string[]) => {
        calls.push(args);
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
        return { status: 0, stdout: '', stderr: '' };
    };
    return { runner, calls };
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
            expect(pin.main(['--sync'], fake.runner)).toBe(2);
        });
        expect(fake.calls).toEqual([]);
        expect(logs.some((line) => line.includes('Usage:'))).toBe(true);
    });
});
