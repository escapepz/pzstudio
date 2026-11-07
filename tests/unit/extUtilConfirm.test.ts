'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import {
    confirmBeforeRun,
    disableConfirmBeforeRun,
} from '../../packages/vscode-extension/src/util/confirm';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

function withConfirmSetting(enabled: boolean | undefined) {
    asMock(vscode.workspace.getConfiguration).mockImplementation(
        () =>
            ({
                get: vi.fn((_key: string, defaultValue?: unknown) =>
                    enabled === undefined ? defaultValue : enabled,
                ),
                inspect: vi.fn(() => undefined),
                update: vi.fn(),
            }) as never,
    );
}

describe('confirmBeforeRun', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        withConfirmSetting(undefined);
    });

    it('asks modally and resolves yes on the action button', async () => {
        asMock(vscode.window.showWarningMessage).mockResolvedValue(
            vscode.l10n.t('Build'),
        );

        await expect(confirmBeforeRun('build', 'my_project')).resolves.toBe(
            'yes',
        );

        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            expect.stringContaining("Run build for project 'my_project'?"),
            { modal: true },
            vscode.l10n.t('Build'),
            vscode.l10n.t("Don't Ask Again"),
        );
    });

    it('resolves never on the Dont-Ask-Again button', async () => {
        asMock(vscode.window.showWarningMessage).mockResolvedValue(
            vscode.l10n.t("Don't Ask Again"),
        );
        await expect(confirmBeforeRun('clean', 'my_project')).resolves.toBe(
            'never',
        );
    });

    it('resolves cancel on dismissal', async () => {
        asMock(vscode.window.showWarningMessage).mockResolvedValue(undefined);
        await expect(confirmBeforeRun('build', 'p')).resolves.toBe('cancel');
    });

    it('skips the modal when the setting is disabled', async () => {
        withConfirmSetting(false);
        await expect(confirmBeforeRun('clean', 'p')).resolves.toBe('yes');
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
    });

    it('mentions deleting the workshop output when cleaning', async () => {
        asMock(vscode.window.showWarningMessage).mockResolvedValue(undefined);
        await confirmBeforeRun('clean', 'p');
        expect(asMock(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
            expect.stringContaining('workshop output'),
            { modal: true },
            expect.any(String),
            expect.any(String),
        );
    });
});

describe('disableConfirmBeforeRun', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('writes confirmBeforeRun=false into the workspace folder scope', async () => {
        const update = vi.fn();
        asMock(vscode.workspace.getConfiguration).mockImplementation(
            (_section?: string, _scope?: unknown) =>
                ({ get: vi.fn(), inspect: vi.fn(), update }) as never,
        );

        await disableConfirmBeforeRun('C:/somewhere/proj');

        expect(asMock(vscode.workspace.getConfiguration)).toHaveBeenCalledWith(
            'pzstudio',
            expect.objectContaining({ fsPath: expect.any(String) }),
        );
        expect(update).toHaveBeenCalledWith(
            'confirmBeforeRun',
            false,
            vscode.ConfigurationTarget.WorkspaceFolder,
        );
    });

    it('works without a project dir (no resource scope)', async () => {
        const update = vi.fn();
        asMock(vscode.workspace.getConfiguration).mockImplementation(
            (_section?: string, _scope?: unknown) =>
                ({ get: vi.fn(), inspect: vi.fn(), update }) as never,
        );

        await disableConfirmBeforeRun();
        expect(asMock(vscode.workspace.getConfiguration)).toHaveBeenCalledWith(
            'pzstudio',
            undefined,
        );
        expect(update).toHaveBeenCalled();
    });
});
