'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { registerOpenProjectJsonCommand } from '../../packages/vscode-extension/src/commands/openProjectJson';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;
const UriCtor = vscode.Uri as unknown as new (parts: string[]) => vscode.Uri;

/** Extracts the handler registered under the given command id. */
function handlerFor(id: string): (node?: unknown) => Promise<void> {
    const calls = asMock(vscode.commands.registerCommand).mock.calls as Array<
        [string, (node?: unknown) => Promise<void>]
    >;
    const entry = calls.find(([commandId]) => commandId === id);
    expect(entry, `${id} must be registered`).toBeDefined();
    return entry![1];
}

// UX-13: the missing-mod remediation opens the declaring project.json —
// and does nothing else. No entry removal (Q4 remains open), no CLI run,
// no prompt: the only side effect is a plain `vscode.open` of the file.
describe('pzstudio.openProjectJson command (UX-13)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        registerOpenProjectJsonCommand();
    });

    it('opens the project.json of the missing-mod row’s own project', async () => {
        const handler = handlerFor('pzstudio.openProjectJson');

        await handler({
            modId: 'ghost',
            projectDir: new UriCtor(['proj']),
        });

        const calls = asMock(vscode.commands.executeCommand).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('vscode.open');
        expect((calls[0][1] as { path: string }).path).toBe(
            '/proj/project.json',
        );
        // The open path targets exactly the project configuration file.
        expect(calls[0][1]).toBeInstanceOf(vscode.Uri);
    });

    it('does not run the engine, edit documents, or prompt', async () => {
        const handler = handlerFor('pzstudio.openProjectJson');

        await handler({
            modId: 'ghost',
            projectDir: new UriCtor(['proj']),
        });

        // Only `vscode.open` was executed — no CLI invocation path, no
        // message boxes that could imply a write-back flow.
        expect(
            asMock(vscode.commands.executeCommand).mock.calls.map(([id]) => id),
        ).toEqual(['vscode.open']);
        expect(asMock(vscode.window.showQuickPick)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
        expect(asMock(vscode.window.showInputBox)).not.toHaveBeenCalled();
    });

    it('does nothing without tree-node context (no implicit project pick)', async () => {
        const handler = handlerFor('pzstudio.openProjectJson');

        await handler(undefined);

        expect(asMock(vscode.commands.executeCommand)).not.toHaveBeenCalled();
    });

    it('ignores nodes whose project directory is not attached', async () => {
        const handler = handlerFor('pzstudio.openProjectJson');

        await handler({ modId: 'ghost' });

        expect(asMock(vscode.commands.executeCommand)).not.toHaveBeenCalled();
    });
});
