import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// resolve the CJS build scripts via relative path (same pattern as
// template-pin.test.ts)
const nodeRequire = createRequire(import.meta.url);
const { copyDirRecursive } = nodeRequire(
    '../../packages/cli/scripts/template-copy.js',
);
const { templateSyncFilter } = nodeRequire(
    '../../packages/vscode-extension/scripts/template-sync-filter.js',
);

const cleanupDirs: string[] = [];

afterEach(() => {
    for (const dir of cleanupDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
});

/** Build a template-like tree: .github/, .git gitfile, .gitignore, content. */
function makeTemplateFixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-template-copy-'));
    cleanupDirs.push(root);
    const src = path.join(root, '.template-project');
    fs.mkdirSync(path.join(src, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(src, 'workshop'), { recursive: true });
    fs.writeFileSync(
        path.join(src, '.github', 'workflows', 'ci.yml'),
        'on: push\n',
    );
    fs.writeFileSync(path.join(src, '.gitignore'), 'node_modules\n');
    // submodule checkouts carry .git as a gitfile (plain file), not a dir
    fs.writeFileSync(path.join(src, '.git'), '');
    fs.writeFileSync(path.join(src, 'workshop', 'x.txt'), 'x\n');
    return src;
}

describe('copyDirRecursive', () => {
    it('copies content but skips .git and .github entries', () => {
        const src = makeTemplateFixture();
        const dest = path.join(path.dirname(src), 'dest');

        copyDirRecursive(src, dest, ['.git', '.github']);

        expect(fs.existsSync(path.join(dest, '.gitignore'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'workshop', 'x.txt'))).toBe(true);
        expect(
            fs.readFileSync(path.join(dest, 'workshop', 'x.txt'), 'utf8'),
        ).toBe('x\n');
        expect(fs.existsSync(path.join(dest, '.git'))).toBe(false);
        expect(fs.existsSync(path.join(dest, '.github'))).toBe(false);
    });

    it('does nothing when the source does not exist', () => {
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'pz-template-copy-'),
        );
        cleanupDirs.push(root);
        const dest = path.join(root, 'dest');

        copyDirRecursive(path.join(root, 'missing'), dest, ['.git']);

        expect(fs.existsSync(dest)).toBe(false);
    });
});

describe('templateSyncFilter', () => {
    it('keeps template content, drops .git and .github paths', () => {
        const base = path.join(
            os.tmpdir(),
            'repo',
            '.template-legacy',
            '.template-project',
        );
        expect(templateSyncFilter(path.join(base, 'workshop', 'x.txt'))).toBe(
            true,
        );
        expect(templateSyncFilter(path.join(base, '.gitignore'))).toBe(true);
        expect(templateSyncFilter(path.join(base, '.gitmodules'))).toBe(true);
        expect(templateSyncFilter(path.join(base, '.git'))).toBe(false);
        expect(templateSyncFilter(path.join(base, '.github'))).toBe(false);
        expect(
            templateSyncFilter(
                path.join(base, '.github', 'workflows', 'ci.yml'),
            ),
        ).toBe(false);
    });
});
