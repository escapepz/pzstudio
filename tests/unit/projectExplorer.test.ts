'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── vscode mock ─────────────────────────────────────────────────────────────

const mockUri = vi.hoisted(() => {
    const segments: string[] = [];
    return {
        path: '/' + segments.join('/'),
        joinPath: vi.fn((...parts: string[]) => {
            const s = [...segments, ...parts];
            const uri: typeof mockUri = Object.create(mockUri);
            uri.path = '/' + s.join('/');
            return uri;
        }),
    };
});

vi.mock('vscode', () => ({
    Uri: mockUri,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
        fs: {
            stat: vi.fn(),
        },
    },
}));

// ── import after mock ────────────────────────────────────────────────────────
import {
    resolveModFolderIcon,
    MOD_FOLDER_FALLBACK_ICON,
} from '../../packages/vscode-extension/src/providers/projectExplorer';

describe('projectExplorer helpers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('MOD_FOLDER_FALLBACK_ICON', () => {
        it('is a relative media path', () => {
            expect(MOD_FOLDER_FALLBACK_ICON).toBe('media/mod-folder.png');
        });
    });

    describe('resolveModFolderIcon', () => {
        it('returns iconUri when icon.png exists as a file', async () => {
            const modDir = mockUri as unknown as import('vscode').Uri;
            const stat = vi.fn().mockResolvedValue({ type: 1 }); // FileType.File

            const result = await resolveModFolderIcon(modDir, stat);

            expect(stat).toHaveBeenCalledOnce();
            expect(result?.path).toMatch(/icon\.png$/);
        });

        it('returns undefined when icon.png does not exist', async () => {
            const modDir = mockUri as unknown as import('vscode').Uri;
            const stat = vi
                .fn<() => Promise<{ type: number }>>()
                .mockRejectedValue(new Error('ENOENT'));

            const result = await resolveModFolderIcon(modDir, stat);

            expect(result).toBeUndefined();
        });

        it('returns undefined when icon.png is a directory', async () => {
            const modDir = mockUri as unknown as import('vscode').Uri;
            const stat = vi
                .fn<() => Promise<{ type: number }>>()
                .mockResolvedValue({ type: 2 }); // FileType.Directory

            const result = await resolveModFolderIcon(modDir, stat);

            expect(result).toBeUndefined();
        });
    });
});

const EXT_ROOT = path.resolve(__dirname, '../../packages/vscode-extension');
const PKG = JSON.parse(
    fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'),
);
const MEDIA = path.join(EXT_ROOT, 'media');

describe('extension manifest', () => {
    it('displayName is PZ Studio', () => {
        expect(PKG.displayName).toBe('PZ Studio');
    });

    it('package id is unchanged (pzstudio)', () => {
        expect(PKG.name).toBe('pzstudio');
    });

    it('Activity Bar icon uses the bundled PNG', () => {
        const icon = PKG.contributes.viewsContainers.activitybar[0].icon;
        expect(icon).toBe('media/pzstudio.png');
        expect(fs.existsSync(path.join(MEDIA, 'pzstudio.png'))).toBe(true);
    });

    it('bundled mod-folder fallback icon is present', () => {
        expect(fs.existsSync(path.join(MEDIA, 'mod-folder.png'))).toBe(true);
    });

    it('Activity Bar container title is PZ Studio', () => {
        expect(PKG.contributes.viewsContainers.activitybar[0].title).toBe(
            'PZ Studio',
        );
    });

    it('build command ID is preserved', () => {
        const cmd = PKG.contributes.commands.find(
            (c: { command: string }) => c.command === 'pzstudio.build',
        );
        expect(cmd).toBeDefined();
    });
});
