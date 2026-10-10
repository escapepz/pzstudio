'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import {
    configurationStore,
    defaultGetConfiguration,
} from '../helpers/vscode-mock';
import { resolveFlags } from '../../packages/vscode-extension/src/util/flags';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

/** Pins the pzstudio.* settings resolveFlags reads. */
function withConfig(values: Record<string, unknown>) {
    asMock(vscode.workspace.getConfiguration).mockImplementation(
        () =>
            ({
                get: vi.fn((key: string) => values[key]),
                inspect: vi.fn(() => undefined),
                update: vi.fn(),
            }) as never,
    );
}

describe('resolveFlags', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        withConfig({});
    });

    it('sends no target flag for build from the default setting', () => {
        withConfig({ 'build.target': 'default' });
        expect(resolveFlags('build')).toEqual([]);
    });

    it.each([
        ['production', ['--production']],
        ['development', ['--development']],
        ['both', ['--both']],
    ] as const)(
        'maps the configured target %s to its flag',
        (target, expected) => {
            withConfig({ 'build.target': target });
            expect(resolveFlags('build')).toEqual(expected);
        },
    );

    // UX-01: an explicit build target (VS Code task) REPLACES the
    // pzstudio.build.target setting instead of being appended after it —
    // the CLI rejects conflicting target flags, so the override must leave
    // exactly one target flag for every configured value.
    describe.each(['default', 'production', 'development', 'both'] as const)(
        'with pzstudio.build.target=%s',
        (configured) => {
            it.each(['production', 'development', 'both'] as const)(
                'explicit %s wins with exactly one flag',
                (explicit) => {
                    withConfig({ 'build.target': configured });
                    expect(resolveFlags('build', explicit)).toEqual([
                        {
                            production: '--production',
                            development: '--development',
                            both: '--both',
                        }[explicit],
                    ]);
                },
            );
        },
    );

    it('sends no target flag for clean, with or without an override', () => {
        withConfig({ 'build.target': 'production' });
        // clean is not a build target: the clean command never carries one,
        // whatever the setting says and whatever the caller passes.
        expect(resolveFlags('clean', 'clean')).toEqual([]);
        expect(resolveFlags('clean')).toEqual([]);
    });

    it('keeps --verbose alongside the explicit target', () => {
        withConfig({ verbose: true, 'build.target': 'production' });
        expect(resolveFlags('build', 'development')).toEqual([
            '--verbose',
            '--development',
        ]);
    });
});

/**
 * UX-05: the flag settings (`verbose`, `offline`, `forceUpdate`,
 * `useSymlinks`, `build.target`) are `scope: "resource"` — `resolveFlags`
 * must read them for the operated project's folder, so two projects in a
 * multi-root workspace resolve different flags instead of sharing the
 * resource-less snapshot. The explicit task target keeps beating the
 * folder-level configured target (UX-01), and a project-less call stays
 * resource-less (global update, UX-03).
 */
describe('resolveFlags (UX-05 resource-scoped flags)', () => {
    const UriCtor = vscode.Uri as unknown as new (
        parts: string[],
    ) => vscode.Uri;
    let folderA: { fsPath: string };
    let folderB: { fsPath: string };

    beforeEach(() => {
        vi.clearAllMocks();
        configurationStore.reset();
        asMock(vscode.workspace.getConfiguration).mockImplementation(
            defaultGetConfiguration as never,
        );
        folderA = new UriCtor(['ws', 'project-a']);
        folderB = new UriCtor(['ws', 'project-b']);
        (
            vscode.workspace as unknown as { workspaceFolders: unknown }
        ).workspaceFolders = [
            { uri: folderA, name: 'project-a' },
            { uri: folderB, name: 'project-b' },
        ];
    });

    function setFolder(
        folder: { fsPath: string },
        values: Record<string, unknown>,
    ): void {
        configurationStore.folders[folder.fsPath] = { ...values };
    }

    it('resolves verbose per folder: A true → --verbose, B false → none', () => {
        setFolder(folderA, { 'pzstudio.verbose': true });
        setFolder(folderB, { 'pzstudio.verbose': false });

        expect(resolveFlags('build', undefined, folderA.fsPath)).toEqual([
            '--verbose',
        ]);
        expect(resolveFlags('build', undefined, folderB.fsPath)).toEqual([]);
    });

    it('resolves the build target per folder', () => {
        setFolder(folderA, { 'pzstudio.build.target': 'production' });
        setFolder(folderB, { 'pzstudio.build.target': 'development' });

        expect(resolveFlags('build', undefined, folderA.fsPath)).toEqual([
            '--production',
        ]);
        expect(resolveFlags('build', undefined, folderB.fsPath)).toEqual([
            '--development',
        ]);
    });

    it('lets the explicit task target beat the folder-level build.target', () => {
        setFolder(folderA, { 'pzstudio.build.target': 'production' });
        setFolder(folderB, { 'pzstudio.build.target': 'development' });

        // UX-01 precedence: task target > folder target — exactly one
        // flag, never both.
        expect(resolveFlags('build', 'development', folderA.fsPath)).toEqual([
            '--development',
        ]);
        expect(resolveFlags('build', 'production', folderB.fsPath)).toEqual([
            '--production',
        ]);
    });

    it('emits no build-target flag for clean whatever the folder target says', () => {
        setFolder(folderA, { 'pzstudio.build.target': 'both' });

        expect(resolveFlags('clean', undefined, folderA.fsPath)).toEqual([]);
        expect(resolveFlags('clean', 'clean', folderA.fsPath)).toEqual([]);
    });

    it('resolves the new/add flags per folder', () => {
        setFolder(folderA, {
            'pzstudio.offline': true,
            'pzstudio.forceUpdate': true,
            'pzstudio.useSymlinks': true,
        });

        expect(resolveFlags('new', undefined, folderA.fsPath)).toEqual([
            '--offline',
            '--force-update',
            '--symlinks',
        ]);
        expect(resolveFlags('add', undefined, folderA.fsPath)).toEqual([
            '--offline',
            '--force-update',
        ]);
        expect(resolveFlags('new', undefined, folderB.fsPath)).toEqual([]);
    });

    it('falls back to workspace and user layers when the folder sets nothing', () => {
        configurationStore.workspace['pzstudio.verbose'] = true;
        configurationStore.global['pzstudio.build.target'] = 'both';

        expect(resolveFlags('build', undefined, folderA.fsPath)).toEqual([
            '--verbose',
            '--both',
        ]);
    });

    it('stays resource-less without a projectDir (global update, UX-03)', () => {
        setFolder(folderA, { 'pzstudio.verbose': true });

        // No project context → no resource: the folder values of opened
        // folders must not be borrowed.
        expect(resolveFlags('update')).toEqual([]);
        expect(resolveFlags('update', undefined, undefined)).toEqual([]);
    });

    it('gives a project outside every workspace folder no folder flags', () => {
        setFolder(folderA, { 'pzstudio.verbose': true });
        configurationStore.workspace['pzstudio.verbose'] = false;

        const outside = new UriCtor(['elsewhere', 'standalone-proj']);
        expect(resolveFlags('build', undefined, outside.fsPath)).toEqual([]);
    });
});
