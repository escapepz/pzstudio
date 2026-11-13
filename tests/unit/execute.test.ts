import { describe, it, expect } from 'vitest';
import { MemoryFileSystem } from '../helpers/memory-file-system';
import {
    createIgnoreMatcher,
    executeFileOperations,
    isSourcePathIncluded,
    joinPath,
    OperationLogger,
    readIgnoreRulesForDir,
} from '../../packages/core/src/execute';
import { FileOperation } from '../../packages/core/src/buildplan';

describe('executeFileOperations (fs-driven executor)', () => {
    it('executes removeDir/makeDir/writeFile/copyFile/log in order', async () => {
        const fs = new MemoryFileSystem();
        const logs: string[] = [];
        const log: OperationLogger = (level, message) =>
            logs.push(`${level}:${message}`);

        await fs.writeText('/src/preview.png', 'PNG');
        await executeFileOperations(
            fs,
            [
                { type: 'log', level: 'info', message: 'hello' },
                { type: 'removeDir', path: '/out/x' },
                { type: 'makeDir', path: '/out/x' },
                {
                    type: 'writeFile',
                    path: '/out/x/workshop.txt',
                    content: 'title=T',
                },
                {
                    type: 'copyFile',
                    from: '/src/preview.png',
                    to: '/out/x/preview.png',
                },
            ],
            log,
        );

        expect(logs).toEqual(['info:hello']);
        expect(await fs.readText('/out/x/workshop.txt')).toBe('title=T');
        expect(await fs.readText('/out/x/preview.png')).toBe('PNG');
        expect((await fs.stat('/out/x')).type).toBe('directory');
    });

    it('maps lock errors to an actionable message', async () => {
        const fs = new MemoryFileSystem();
        // Simulate the game holding a handle: delete reports EBUSY.
        fs.delete = async () => {
            const e = new Error('EBUSY') as Error & { code: string };
            e.code = 'EBUSY';
            throw e;
        };
        const operations: FileOperation[] = [
            { type: 'removeDir', path: '/out' },
        ];

        await expect(executeFileOperations(fs, operations)).rejects.toThrow(
            /folder is in use by another program/,
        );
    });

    it('copies trees recursively applying the copyTree filter options', async () => {
        const fs = new MemoryFileSystem();
        // Source tree:
        //   a.lua                     kept
        //   .gitkeep                  never copied
        //   .dotfile                  skipped (ignoreDotFiles)
        //   .pzstudioignore           skipped (excludeIgnoreFile)
        //   .git/config               skipped (git rules)
        //   dev/scratch.lua           excluded by .pzstudioignore
        //   media/.pzstudioignore     closest rules file (skipped as a file)
        //   media/old.lua             excluded by the closest rules file
        //   media/other.lua           KEPT despite the root rules listing it
        //                               (closest file wins with no match)
        //   nested/                   only holds .gitkeep — not materialized
        await fs.writeText('/tpl/.pzstudioignore', 'dev/\nmedia/other.lua\n');
        await fs.writeText('/tpl/media/.pzstudioignore', 'old.lua\n');
        await fs.writeText('/tpl/a.lua', 'print("a")');
        await fs.writeText('/tpl/.gitkeep', '');
        await fs.writeText('/tpl/.dotfile', 'x');
        await fs.writeText('/tpl/.git/config', 'git');
        await fs.writeText('/tpl/dev/scratch.lua', 'scratch');
        await fs.writeText('/tpl/media/old.lua', 'old');
        await fs.writeText('/tpl/media/other.lua', 'other');
        await fs.writeText('/tpl/nested/.gitkeep', '');

        await executeFileOperations(fs, [
            {
                type: 'copyTree',
                from: '/tpl',
                to: '/out',
                excludeIgnoreFile: true,
                ignoreDotFiles: true,
                ignoreItems: ['vendor'],
            },
        ]);

        expect(await fs.readText('/out/a.lua')).toBe('print("a")');
        expect(await fs.readText('/out/media/other.lua')).toBe('other');
        // Everything filtered is absent:
        expect(fs.files.has('/out/.gitkeep')).toBe(false);
        expect(fs.files.has('/out/.dotfile')).toBe(false);
        expect(fs.files.has('/out/.pzstudioignore')).toBe(false);
        expect(fs.files.has('/out/.git/config')).toBe(false);
        expect(fs.files.has('/out/dev/scratch.lua')).toBe(false);
        expect(fs.files.has('/out/media/old.lua')).toBe(false);
        expect(fs.files.has('/out/media/.pzstudioignore')).toBe(false);
        expect(fs.files.has('/out/nested/.gitkeep')).toBe(false);
    });

    it('applies ignoreItems to direct children of the copy root only', async () => {
        const fs = new MemoryFileSystem();
        await fs.writeText('/mod/vendor/lib.lua', 'lib');
        await fs.writeText('/mod/media/lua/vendor.lua', 'deep');

        await executeFileOperations(fs, [
            {
                type: 'copyTree',
                from: '/mod',
                to: '/out',
                ignoreItems: ['vendor'],
            },
        ]);

        expect(fs.files.has('/out/vendor/lib.lua')).toBe(false);
        expect(await fs.readText('/out/media/lua/vendor.lua')).toBe('deep');
    });

    it('isSourcePathIncluded matches what the walker copies', async () => {
        const fs = new MemoryFileSystem();
        await fs.writeText('/mod/.pzstudioignore', 'dev/\n');
        await fs.writeText('/mod/media/.pzstudioignore', 'old.lua\n');

        const cases: Array<[string, boolean]> = [
            ['a.lua', true],
            ['dev/scratch.lua', false],
            ['dev', false],
            ['media/old.lua', false],
            ['media/new.lua', true],
            // Entries only match their exact relative path or a prefix of
            // it — 'old.lua' has no verdict for 'sub/old.lua', and the
            // closest file wins, so the nested file is kept.
            ['media/sub/old.lua', true],
            ['.gitkeep', false],
            ['.hidden', false],
            ['.git/config', false],
            ['.pzstudioignore', false],
        ];
        for (const [rel, expected] of cases) {
            expect(
                await isSourcePathIncluded(fs, '/mod', rel, {
                    excludeIgnoreFile: true,
                    ignoreDotFiles: true,
                }),
            ).toBe(expected);
        }
    });

    it('joinPath normalizes backslashes and trailing separators', () => {
        expect(joinPath('/out', 'My Mod', 'media/lua')).toBe(
            '/out/My Mod/media/lua',
        );
        expect(joinPath('C:\\proj\\mod', 'media\\')).toBe('C:/proj/mod/media');
        expect(joinPath('', 'a', '', 'b')).toBe('a/b');
    });
});

describe('unified ignore engine (.gitignore + .pzstudioignore)', () => {
    it('readIgnoreRulesForDir parses both rule files, tolerating missing and unreadable dirs', async () => {
        const fs = new MemoryFileSystem();
        await fs.writeText(
            '/mod/.pzstudioignore',
            '*.tmp\n\n# comment\n!special.tmp\n',
        );
        await fs.writeText('/mod/.gitignore', 'build/\n');

        expect(await readIgnoreRulesForDir(fs, '/mod')).toEqual({
            pzstudio: ['*.tmp', '!special.tmp'],
            // 'build/' parses to 'build' — the trailing slash is stripped
            // and dir behavior comes from the matcher's anchored matching.
            git: ['build'],
        });

        // A directory without either file carries no rules.
        expect(await readIgnoreRulesForDir(fs, '/mod/plain')).toEqual({
            pzstudio: null,
            git: null,
        });

        // An unreadable directory carries no rules either.
        const sealed = new MemoryFileSystem();
        sealed.list = async () => {
            throw new Error('EACCES');
        };
        expect(await readIgnoreRulesForDir(sealed, '/sealed')).toEqual({
            pzstudio: null,
            git: null,
        });
    });

    it('createIgnoreMatcher walks rulesByDir closest-wins', () => {
        const matcher = createIgnoreMatcher({
            '': { pzstudio: ['*.log'], git: null },
            media: { pzstudio: null, git: ['!keep.log'] },
        });
        expect(matcher.isIgnored('a.log')).toBe(true);
        // The deepest directory with rules decides entirely: the root
        // '*.log' is never consulted for media paths.
        expect(matcher.isIgnored('media/keep.log')).toBe(false);
        expect(matcher.isIgnored('media/other.log')).toBe(false);
        expect(matcher.isIgnored('media/sub/keep.log')).toBe(false);
        expect(matcher.isIgnored('deep/other.log')).toBe(true);
    });

    it('createIgnoreMatcher skips directories whose rule set is empty', () => {
        const matcher = createIgnoreMatcher({
            sub: { pzstudio: null, git: null },
            '': { pzstudio: ['*.log'], git: null },
        });
        expect(matcher.isIgnored('sub/a.log')).toBe(true);
        expect(matcher.isIgnored('sub/new.lua')).toBe(false);
    });

    it('createIgnoreMatcher keeps plain entries anchored to the rules directory', () => {
        const matcher = createIgnoreMatcher({
            '': { pzstudio: ['old.lua'], git: null },
        });
        expect(matcher.isIgnored('old.lua')).toBe(true);
        expect(matcher.isIgnored('old.lua/inner.lua')).toBe(true);
        // Plain entries never match their basename at depth — the prefix
        // semantics the existing fixtures pin.
        expect(matcher.isIgnored('sub/old.lua')).toBe(false);
    });

    it('createIgnoreMatcher applies .gitignore entries first and .pzstudioignore second', () => {
        const matcher = createIgnoreMatcher({
            '': { pzstudio: ['!a.log'], git: ['*.log'] },
        });
        expect(matcher.isIgnored('a.log')).toBe(false);
        expect(matcher.isIgnored('b.log')).toBe(true);
    });

    it('createIgnoreMatcher keeps rails included regardless of rules', () => {
        const matcher = createIgnoreMatcher({
            '': { pzstudio: ['*'], git: ['*'] },
        });
        expect(matcher.isIgnored('mod.info')).toBe(false);
        expect(matcher.isIgnored('media/mod.info')).toBe(false);
        expect(matcher.isIgnored('.pzstudioignore')).toBe(false);
        expect(matcher.isIgnored('nested/.gitignore')).toBe(false);
        expect(matcher.isIgnored('other.lua')).toBe(true);
    });

    it('isSourcePathIncluded honors .gitignore negation', async () => {
        const fs = new MemoryFileSystem();
        await fs.writeText('/mod/.gitignore', '*.txt\n!keep.txt\n');

        expect(await isSourcePathIncluded(fs, '/mod', 'keep.txt')).toBe(true);
        expect(await isSourcePathIncluded(fs, '/mod', 'other.txt')).toBe(false);
        expect(await isSourcePathIncluded(fs, '/mod', 'sub/keep.txt')).toBe(
            true,
        );
        expect(await isSourcePathIncluded(fs, '/mod', 'sub/other.txt')).toBe(
            false,
        );
    });

    it('isSourcePathIncluded gives ** patterns their real gitignore reach', async () => {
        const fs = new MemoryFileSystem();
        await fs.writeText('/mod/.pzstudioignore', '**/temp/**\n');

        expect(await isSourcePathIncluded(fs, '/mod', 'a/b/temp/x.lua')).toBe(
            false,
        );
        expect(await isSourcePathIncluded(fs, '/mod', 'temp/y.lua')).toBe(
            false,
        );
        expect(await isSourcePathIncluded(fs, '/mod', 'a/b/keep.lua')).toBe(
            true,
        );
    });

    it('isSourcePathIncluded lets .pzstudioignore outrank .gitignore at the same level', async () => {
        const fs = new MemoryFileSystem();
        await fs.writeText('/mod/.gitignore', '*.log\n');
        await fs.writeText('/mod/.pzstudioignore', '!a.log\n');

        expect(await isSourcePathIncluded(fs, '/mod', 'a.log')).toBe(true);
        expect(await isSourcePathIncluded(fs, '/mod', 'b.log')).toBe(false);
    });

    it('isSourcePathIncluded lets deeper rules win two levels down', async () => {
        const fs = new MemoryFileSystem();
        await fs.writeText('/mod/.gitignore', '*.log\n');
        await fs.writeText('/mod/media/.gitignore', '!keep.log\n');

        expect(await isSourcePathIncluded(fs, '/mod', 'other.log')).toBe(false);
        expect(await isSourcePathIncluded(fs, '/mod', 'media/keep.log')).toBe(
            true,
        );
        expect(await isSourcePathIncluded(fs, '/mod', 'media/other.log')).toBe(
            true,
        );
    });

    it('isSourcePathIncluded never rules out mod.info', async () => {
        const fs = new MemoryFileSystem();
        await fs.writeText('/mod/.pzstudioignore', '*.info\n');

        expect(await isSourcePathIncluded(fs, '/mod', 'other.info')).toBe(
            false,
        );
        expect(await isSourcePathIncluded(fs, '/mod', 'deep/other.info')).toBe(
            false,
        );
        expect(await isSourcePathIncluded(fs, '/mod', 'mod.info')).toBe(true);
        expect(await isSourcePathIncluded(fs, '/mod', 'media/mod.info')).toBe(
            true,
        );
    });
});
