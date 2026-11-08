'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import {
    notifyFirstBuildSuccess,
    FIRST_SUCCESS_KEY,
} from '../../packages/vscode-extension/src/util/firstSuccess';
import { t } from '../../packages/vscode-extension/src/util/l10n';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

/**
 * Fake extension context carrying just the globalState the popup guards
 * through (pattern from extActivation.test.ts).
 */
function fakeContext(flag?: boolean) {
    return {
        globalState: {
            get: vi.fn(() => flag),
            update: vi.fn(async () => {}),
        },
    } as unknown as vscode.ExtensionContext;
}

describe('notifyFirstBuildSuccess', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('ignores non-build commands', () => {
        const context = fakeContext();

        notifyFirstBuildSuccess(context, 'watch');

        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();
        expect(asMock(context.globalState.update)).not.toHaveBeenCalled();
    });

    it('shows the popup once and sets the flag on the first build', () => {
        const context = fakeContext();

        notifyFirstBuildSuccess(context, 'build');

        expect(asMock(context.globalState.update)).toHaveBeenCalledWith(
            FIRST_SUCCESS_KEY,
            true,
        );
        expect(
            asMock(vscode.window.showInformationMessage),
        ).toHaveBeenCalledWith(
            t('First successful build with PZ Studio!'),
            'Open PZ Studio home',
        );
    });

    it('never shows again once the flag is set', () => {
        const context = fakeContext(true);

        notifyFirstBuildSuccess(context, 'build');

        expect(asMock(context.globalState.update)).not.toHaveBeenCalled();
        expect(
            asMock(vscode.window.showInformationMessage),
        ).not.toHaveBeenCalled();
    });

    it('button click opens the landing URL', async () => {
        const context = fakeContext();
        asMock(vscode.window.showInformationMessage).mockResolvedValue(
            'Open PZ Studio home',
        );

        notifyFirstBuildSuccess(context, 'build');

        await vi.waitFor(() => {
            expect(asMock(vscode.env.openExternal)).toHaveBeenCalledTimes(1);
        });
        const opened = asMock(vscode.env.openExternal).mock.calls[0][0];
        expect(String(opened)).toContain(
            'escapepz.github.io/pzstudio/?utm_source=ext-popup',
        );
    });

    it('never opens the URL when the popup is dismissed', async () => {
        const context = fakeContext();
        // Dismissed: the message resolves without a button choice.
        asMock(vscode.window.showInformationMessage).mockResolvedValue(
            undefined,
        );

        notifyFirstBuildSuccess(context, 'build');

        // Let the popup's promise chain settle before judging side effects.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(asMock(vscode.env.openExternal)).not.toHaveBeenCalled();
        // The one-time flag is set regardless of the dismissal: the popup
        // never shows again even when the user closed it.
        expect(asMock(context.globalState.update)).toHaveBeenCalledWith(
            FIRST_SUCCESS_KEY,
            true,
        );
    });
});
