'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import {
    initExtensionL10n,
    t,
} from '../../packages/vscode-extension/src/util/l10n';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

function jsonBundle(entries: Record<string, string>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(entries));
}

function withLanguageSetting(language: string | undefined) {
    asMock(vscode.workspace.getConfiguration).mockImplementation(
        () =>
            ({
                get: vi.fn((_key: string, defaultValue?: unknown) =>
                    language === undefined ? defaultValue : language,
                ),
                inspect: vi.fn(() => undefined),
                update: vi.fn(),
            }) as never,
    );
}

function mockContext(): vscode.ExtensionContext {
    return {
        extensionUri: vscode.Uri.file('/ext'),
    } as unknown as vscode.ExtensionContext;
}

describe('extension l10n wrapper', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        withLanguageSetting(undefined);
        await initExtensionL10n(mockContext());
    });

    it('delegates to vscode.l10n in auto mode without reading bundles', async () => {
        expect(t('Hello {0}', 'World')).toBe('Hello World');
        expect(asMock(vscode.workspace.fs.readFile)).not.toHaveBeenCalled();
    });

    it('loads the selected locale bundle and substitutes {0}', async () => {
        withLanguageSetting('vi');
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            jsonBundle({ 'Hello {0}': 'Xin chào {0}!' }),
        );

        await initExtensionL10n(mockContext());

        expect(t('Hello {0}', 'PZ')).toBe('Xin chào PZ!');
        const uri = asMock(vscode.workspace.fs.readFile).mock.calls[0][0];
        expect(String(uri)).toContain('/l10n/bundle.l10n.vi.json');
    });

    it('maps the en setting to the English bundle file', async () => {
        withLanguageSetting('en');
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            jsonBundle({ Hi: 'Hi' }),
        );

        await initExtensionL10n(mockContext());

        expect(t('Hi')).toBe('Hi');
        const uri = asMock(vscode.workspace.fs.readFile).mock.calls[0][0];
        expect(String(uri)).toContain('/l10n/bundle.l10n.json');
    });

    it('falls back to the English bundle when the locale file is missing', async () => {
        withLanguageSetting('vi');
        asMock(vscode.workspace.fs.readFile)
            .mockRejectedValueOnce(new Error('ENOENT'))
            .mockResolvedValue(jsonBundle({ Hi: 'Hi there' }));

        await initExtensionL10n(mockContext());

        expect(t('Hi')).toBe('Hi there');
    });

    it('stays on the vscode.l10n delegate when even the English bundle fails', async () => {
        withLanguageSetting('vi');
        asMock(vscode.workspace.fs.readFile).mockRejectedValue(
            new Error('ENOENT'),
        );

        await initExtensionL10n(mockContext());

        expect(t('Hi {0}', 'x')).toBe('Hi x');
    });

    it('returns the original message for keys missing from the bundle', async () => {
        withLanguageSetting('vi');
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(jsonBundle({}));

        await initExtensionL10n(mockContext());

        expect(t('Only in English {0}', 7)).toBe('Only in English 7');
    });

    it('reloads the bundle when called again with another language', async () => {
        withLanguageSetting('vi');
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            jsonBundle({ Hi: 'Xin chào' }),
        );
        await initExtensionL10n(mockContext());
        expect(t('Hi')).toBe('Xin chào');

        withLanguageSetting('en');
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            jsonBundle({ Hi: 'Hi' }),
        );
        await initExtensionL10n(mockContext());
        expect(t('Hi')).toBe('Hi');
    });

    it('clears the override when switching back to auto', async () => {
        withLanguageSetting('vi');
        asMock(vscode.workspace.fs.readFile).mockResolvedValue(
            jsonBundle({ Hi: 'Xin chào' }),
        );
        await initExtensionL10n(mockContext());
        expect(t('Hi')).toBe('Xin chào');

        withLanguageSetting(undefined);
        await initExtensionL10n(mockContext());
        expect(t('Hi')).toBe('Hi');
    });
});
