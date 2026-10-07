'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { readPzStudioHostSettings } from '../../packages/vscode-extension/src/util/settings';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

/**
 * Configuration stub whose inspect() mirrors a workspace where every layer
 * is exercised: workspace-only values, global-only values, both, and
 * neither. readPzStudioHostSettings must surface exactly the same
 * workspaceValue/globalValue snapshot the old push bridge fed
 * setVsCodeSettings (doc 11 §10 — UX-05 preserved bit-for-bit).
 */
function withLayeredConfig() {
    const table: Record<string, Record<string, unknown>> = {
        pzstudio: {
            outdir: { workspaceValue: 'C:/ws/out', globalValue: 'C:/user/out' },
            useSymlinks: { workspaceValue: false, globalValue: true },
        },
        'pzstudio.templates.project': {
            url: {
                workspaceValue: 'https://ws/project.git',
                globalValue: 'https://user/project.git',
            },
            ref: { workspaceValue: '42.17.0' },
        },
        'pzstudio.templates.mod': {
            url: { globalValue: 'https://user/mod.git' },
            ref: { globalValue: '42.13.0' },
        },
        'pzstudio.templates.workshop': {},
        'pzstudio.templates.language': {
            url: { workspaceValue: 'https://ws/lang.git' },
        },
    };
    asMock(vscode.workspace.getConfiguration).mockImplementation(
        (section: string) =>
            ({
                get: vi.fn(),
                inspect: vi.fn((key: string) => table[section]?.[key]),
                update: vi.fn(),
            }) as never,
    );
}

describe('readPzStudioHostSettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: nothing configured anywhere (implementations mocked by
        // one test must not leak into the next).
        asMock(vscode.workspace.getConfiguration).mockImplementation(
            () =>
                ({
                    get: vi.fn(),
                    inspect: vi.fn(() => undefined),
                    update: vi.fn(),
                }) as never,
        );
    });

    it('returns the same workspace/global layer shapes the pushed bridge fed the CLI', () => {
        withLayeredConfig();

        expect(readPzStudioHostSettings({ projectDir: 'C:/proj' })).toEqual({
            workspace: {
                templates: {
                    project: { url: 'https://ws/project.git', ref: '42.17.0' },
                    language: { url: 'https://ws/lang.git' },
                },
                outdir: 'C:/ws/out',
                useSymlinks: false,
            },
            user: {
                templates: {
                    project: { url: 'https://user/project.git' },
                    mod: { url: 'https://user/mod.git', ref: '42.13.0' },
                },
                outdir: 'C:/user/out',
                useSymlinks: true,
            },
        });
    });

    it('yields all-undefined layers when nothing is configured', () => {
        expect(readPzStudioHostSettings({ projectDir: 'C:/proj' })).toEqual({
            workspace: {
                templates: undefined,
                outdir: undefined,
                useSymlinks: undefined,
            },
            user: {
                templates: undefined,
                outdir: undefined,
                useSymlinks: undefined,
            },
        });
    });

    it('ignores the context for now — identical snapshots for different projects (UX-05 deliberately unchanged)', () => {
        withLayeredConfig();

        const forA = readPzStudioHostSettings({ projectDir: 'C:/a/proj' });
        const forB = readPzStudioHostSettings({ projectDir: 'C:/b/proj' });

        expect(forB).toStrictEqual(forA);
    });
});
