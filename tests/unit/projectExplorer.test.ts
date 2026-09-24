'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── vscode mock ─────────────────────────────────────────────────────────────

type MockUri = { path: string; joinPath?: unknown };

const vscodeMock = vi.hoisted(() => {
    const makeUri = (parts: string[]): MockUri => {
        const uri: MockUri = {
            path: '/' + parts.join('/'),
            joinPath: undefined,
        };
        return uri;
    };
    return {
        Uri: {
            joinPath: (base: MockUri, ...rest: string[]): MockUri => {
                const baseParts = base.path.split('/').filter(Boolean);
                return makeUri([...baseParts, ...rest]);
            },
        },
        FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
        workspace: { fs: {} },
    };
});

vi.mock('vscode', () => ({ ...vscodeMock, default: vscodeMock }));

// ── import after mock ────────────────────────────────────────────────────────
import {
    naturalCompare,
    resolveModFolderIcon,
    PROJECT_FOLDER_ICON_LIGHT,
    PROJECT_FOLDER_ICON_DARK,
    MOD_BRANCH_INFO_FILE,
    MOD_BRANCH_ICON_FILE,
} from '../../packages/vscode-extension/src/providers/projectExplorer';

const asUri = (path: string) =>
    vscodeMock.Uri.joinPath(vscodeMock.Uri.joinPath({ path: '' }), path);

const FileType = vscodeMock.FileType;

type Entry = [string, number];

/**
 * Builds an in-memory listDir/stat pair from a tree like
 * { '42': { 'mod.info': 'file', 'icon.png': 'file' } }.
 */
function makeFs(
    tree: Record<string, Record<string, 'file' | 'dir' | undefined>>,
) {
    const listDir = vi.fn(async (dir: { path: string }) => {
        const segs = dir.path.split('/').filter(Boolean);
        let node: unknown = tree;
        for (const seg of segs) {
            node = (node as Record<string, unknown>)?.[seg];
        }
        if (!node || typeof node !== 'object') {
            throw new Error('ENOENT');
        }
        return Object.entries(node as Record<string, unknown>).map(
            ([name, value]): Entry => [
                name,
                value !== null && typeof value === 'object'
                    ? FileType.Directory
                    : FileType.File,
            ],
        );
    });
    const stat = vi.fn(async (uri: { path: string }) => {
        const segs = uri.path.split('/').filter(Boolean);
        let node: unknown = tree;
        for (let i = 0; i < segs.length - 1; i++) {
            node = (node as Record<string, unknown>)?.[segs[i]];
        }
        const last = segs[segs.length - 1];
        const entry = (node as Record<string, unknown> | undefined)?.[last];
        if (entry === undefined || entry === 'dir') {
            throw new Error('ENOENT');
        }
        return { type: FileType.File };
    });
    return { listDir, stat };
}

describe('naturalCompare', () => {
    it('compares digit runs numerically (9 before 10)', () => {
        expect(naturalCompare('9', '10')).toBeLessThan(0);
        expect(naturalCompare('10', '9')).toBeGreaterThan(0);
    });

    it('orders digits before letters (42 before common)', () => {
        expect(naturalCompare('42', 'common')).toBeLessThan(0);
    });

    it('falls back to alphabetical order for words', () => {
        expect(naturalCompare('common', 'dev')).toBeLessThan(0);
    });

    it('treats identical names as equal', () => {
        expect(naturalCompare('42', '42')).toBe(0);
    });
});

describe('resolveModFolderIcon', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the first qualifying branch icon (42 without icon, common with)', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                '42': { 'mod.info': 'file' },
                common: { 'mod.info': 'file', 'icon.png': 'file' },
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon?.path).toBe('/ee/common/icon.png');
    });

    it('stops scanning at the first branch with mod.info and icon.png', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                '42': { 'mod.info': 'file', 'icon.png': 'file' },
                common: { 'mod.info': 'file', 'icon.png': 'file' },
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon?.path).toBe('/ee/42/icon.png');
        const iconStatCalls = stat.mock.calls.filter((c) =>
            String(c[0].path).endsWith(MOD_BRANCH_ICON_FILE),
        );
        expect(iconStatCalls).toHaveLength(1);
    });

    it('skips subfolders without mod.info even when they have icon.png', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                docs: { 'icon.png': 'file' } as Record<
                    string,
                    'file' | 'dir' | undefined
                >,
                common: { 'mod.info': 'file', 'icon.png': 'file' },
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon?.path).toBe('/ee/common/icon.png');
    });

    it('returns undefined when no branch has mod.info', async () => {
        const { listDir, stat } = makeFs({
            ee: { random: { 'icon.png': 'file' } },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon).toBeUndefined();
    });

    it('returns undefined when valid branches carry no icon.png', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                '42': { 'mod.info': 'file' },
                common: { 'mod.info': 'file' },
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon).toBeUndefined();
    });

    it('returns undefined when the mod folder is unreadable', async () => {
        const listDir = vi.fn(async () => {
            throw new Error('ENOENT');
        });
        const stat = vi.fn(async () => ({ type: FileType.File }));
        const icon = await resolveModFolderIcon(asUri('gone'), listDir, stat);
        expect(icon).toBeUndefined();
    });

    it('ignores dot-prefixed folders', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                '.git': { 'mod.info': 'file', 'icon.png': 'file' } as Record<
                    string,
                    'file' | 'dir' | undefined
                >,
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon).toBeUndefined();
    });

    it('scans in numeric-alphabetical order (9 before 10)', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                '10': { 'mod.info': 'file', 'icon.png': 'file' },
                '9': { 'mod.info': 'file', 'icon.png': 'file' },
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon?.path).toBe('/ee/9/icon.png');
    });
});

describe('constants and manifest', () => {
    const EXT_ROOT = path.resolve(__dirname, '../../packages/vscode-extension');
    const PKG = JSON.parse(
        fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'),
    );

    it('project folder icons point at bundled theme variants', () => {
        expect(PROJECT_FOLDER_ICON_LIGHT).toBe(
            'resources/icons/pzstudio-project-explorer-light.svg',
        );
        expect(PROJECT_FOLDER_ICON_DARK).toBe(
            'resources/icons/pzstudio-project-explorer-dark.svg',
        );
        expect(
            fs.existsSync(path.join(EXT_ROOT, PROJECT_FOLDER_ICON_LIGHT)),
        ).toBe(true);
        expect(
            fs.existsSync(path.join(EXT_ROOT, PROJECT_FOLDER_ICON_DARK)),
        ).toBe(true);
    });

    it('tree-rendered SVGs use explicit colors, not currentColor', () => {
        // Tree rows and inline buttons render file icons as-is with no CSS
        // color context, where currentColor resolves to black. Only the
        // Activity Bar icon (theme-masked) may rely on currentColor.
        for (const svg of [
            PROJECT_FOLDER_ICON_LIGHT,
            PROJECT_FOLDER_ICON_DARK,
            'resources/icons/beaker-dim.svg',
        ]) {
            const content = fs.readFileSync(path.join(EXT_ROOT, svg), 'utf8');
            expect(content).not.toContain('currentColor');
        }
        const activityBar = fs.readFileSync(
            path.join(EXT_ROOT, 'resources/icons/pzstudio-icon.svg'),
            'utf8',
        );
        expect(activityBar).toContain('currentColor');
    });

    it('uses file names expected from the tree scan', () => {
        expect(MOD_BRANCH_INFO_FILE).toBe('mod.info');
        expect(MOD_BRANCH_ICON_FILE).toBe('icon.png');
    });

    it('displayName is PZ Studio', () => {
        expect(PKG.displayName).toBe('PZ Studio');
    });

    it('Activity Bar icon uses resources/icons and exists on disk', () => {
        const icon = PKG.contributes.viewsContainers.activitybar[0].icon;
        expect(icon).toBe('resources/icons/pzstudio-icon.svg');
        expect(fs.existsSync(path.join(EXT_ROOT, icon))).toBe(true);
    });

    it('manifest no longer references the removed media/ folder', () => {
        expect(
            PKG.contributes.viewsContainers.activitybar[0].icon,
        ).not.toContain('media/');
        const view = PKG.contributes.views['pzstudio-container'][0];
        expect(view.icon).not.toContain('media/');
        const dimCommand = PKG.contributes.commands.find(
            (c: { command: string }) => c.command === 'pzstudio.modDevOnly.dim',
        );
        expect(dimCommand.icon).toBe('resources/icons/beaker-dim.svg');
    });

    it('build command ID is preserved', () => {
        const cmd = PKG.contributes.commands.find(
            (c: { command: string }) => c.command === 'pzstudio.build',
        );
        expect(cmd).toBeDefined();
    });
});
