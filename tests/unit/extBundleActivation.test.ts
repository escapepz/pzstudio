'use strict';

import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { createVscodeMock } from '../helpers/vscode-mock';

/**
 * ACTIVATION SMOKE TEST — loads the REAL built bundle (dist/extension.js)
 * with a stub 'vscode' module and runs activate() end to end.
 *
 * This is the runtime gate the typecheck/esbuild gates cannot provide:
 * a module that crashes on import or inside activate() (e.g. the
 * @parcel/watcher top-level require fixed in dc15821) shows up here as a
 * thrown error or a missing command registration — the exact symptoms
 * users see as "There is no data provider registered" / "command not
 * found". Requires a prior build of the extension (pnpm build).
 */
const EXT_ROOT = fileURLToPath(
    new URL('../../packages/vscode-extension', import.meta.url),
);
const BUNDLE_PATH = path.join(EXT_ROOT, 'dist', 'extension.js');

const nodeRequire = createRequire(import.meta.url);
const vscodeStub = createVscodeMock() as unknown as Record<string, unknown>;

// Route the bundle's require('vscode') to the stub: intercept resolution
// and serve the stub from the require cache under that fake id.
const VSCODE_STUB_ID = 'pzstudio-vscode-stub';
type ResolveFilename = (request: string, ...rest: unknown[]) => string;
const moduleApi = Module as unknown as {
    _resolveFilename: ResolveFilename;
};
const originalResolve = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') {
        return VSCODE_STUB_ID;
    }
    return originalResolve.call(this, request, ...rest);
};
(nodeRequire as unknown as { cache: Record<string, unknown> }).cache[
    VSCODE_STUB_ID
] = {
    id: VSCODE_STUB_ID,
    filename: VSCODE_STUB_ID,
    loaded: true,
    exports: vscodeStub,
};

const manifest = JSON.parse(
    fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'),
) as { contributes: { commands: Array<{ command: string }> } };
const manifestCommandIds = manifest.contributes.commands.map(
    (entry) => entry.command,
);

const UriStub = vscodeStub.Uri as unknown as {
    new (parts: string[]): unknown;
};
const context = {
    subscriptions: [] as Array<{ dispose(): unknown }>,
    extensionUri: new UriStub(EXT_ROOT.split(/[\\/]/)),
    workspaceState: { get: vi.fn(), update: vi.fn() },
    globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    asAbsolutePath: (relative: string) => path.join(EXT_ROOT, relative),
};

let activationError: unknown;
let activated = false;

beforeAll(async () => {
    if (!fs.existsSync(BUNDLE_PATH)) {
        throw new Error(
            'dist/extension.js is missing — build the extension first (pnpm build).',
        );
    }
    // Fresh module state for this suite.
    delete nodeRequire.cache[BUNDLE_PATH];
    try {
        const extension = nodeRequire(BUNDLE_PATH) as {
            activate(context: unknown): Promise<void>;
        };
        await extension.activate(context);
        activated = true;
    } catch (e) {
        activationError = e;
    }
});

describe('extension bundle activation (real dist/extension.js)', () => {
    it('activates without throwing', () => {
        expect(activationError).toBeUndefined();
        expect(activated).toBe(true);
    });

    it('registers every command contributed in the manifest', () => {
        expect(activationError).toBeUndefined();
        const commands = vscodeStub.commands as unknown as {
            registerCommand: { mock: { calls: Array<[string]> } };
        };
        const registered = commands.registerCommand.mock.calls.map(
            (call) => call[0],
        );
        const missing = manifestCommandIds.filter(
            (id) => !registered.includes(id),
        );
        expect(missing).toEqual([]);
    });

    it('registers the tree view and the task provider', () => {
        expect(activationError).toBeUndefined();
        const window = vscodeStub.window as unknown as {
            createTreeView: { mock: { calls: unknown[] } };
        };
        const tasks = vscodeStub.tasks as unknown as {
            registerTaskProvider: { mock: { calls: unknown[] } };
        };
        expect(window.createTreeView.mock.calls).toHaveLength(1);
        expect(tasks.registerTaskProvider.mock.calls).toHaveLength(1);
    });

    it('pushes disposables into the context subscriptions', () => {
        expect(activationError).toBeUndefined();
        expect(context.subscriptions.length).toBeGreaterThan(0);
    });
});
