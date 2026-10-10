'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
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
