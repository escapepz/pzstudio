import { describe, it, expect } from 'vitest';
import { MemoryFileSystem } from '../helpers/memory-file-system';
import {
    executeFileOperations,
    isSourcePathIncluded,
    joinPath,
    OperationLogger,
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
