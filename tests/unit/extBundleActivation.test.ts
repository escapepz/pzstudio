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

/* ------------------------------------------------------------------ */
/* Commit 12 (doc 11 §16 bundle/runtime gates): static + runtime       */
/* packaging assertions over the SAME built bundle.                    */
/* ------------------------------------------------------------------ */

describe('bundle packaging gates (doc 11 §16)', () => {
    it('keeps the package entrypoint on dist/extension.js', () => {
        const pkg = JSON.parse(
            fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'),
        ) as { main: string };
        expect(pkg.main).toBe('./dist/extension.js');
    });

    it('references @parcel/watcher exactly once and only as a require call (lazy, never a top-level import site)', () => {
        const bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
        const occurrences = bundle.split('@parcel/watcher').length - 1;
        const requireCalls =
            bundle.split('require("@parcel/watcher")').length - 1;
        expect(occurrences).toBe(requireCalls);
        expect(occurrences).toBe(1);
    });

    it('keeps the legacy facade exports inlined in the bundle (external-consumer compat surface intact)', () => {
        const bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
        // The inlined api's export map must still publish the historical
        // legacy names (runCLI + the four facade setters + createPzStudio):
        // the facade contract survives inlining even though the extension
        // runtime no longer calls the setters.
        for (const name of [
            'runCLI',
            'setLogger',
            'setProjectDir',
            'setVsCodeSettings',
            'setTemplateTransport',
            'createPzStudio',
        ]) {
            expect(bundle.includes(name)).toBe(true);
        }
    });

    it('activates a fresh bundle evaluation that never requires @parcel/watcher (runtime native-import gate)', async () => {
        expect(fs.existsSync(BUNDLE_PATH)).toBe(true);

        const moduleApi = Module as unknown as {
            _resolveFilename: ResolveFilename;
        };
        const previousResolve = moduleApi._resolveFilename;
        const guardedResolve: ResolveFilename = function (request, ...rest) {
            if (request === '@parcel/watcher') {
                throw new Error(
                    '@parcel/watcher must never be required at import or activation time (lazy require contract, dc15821)',
                );
            }
            return previousResolve.call(this, request, ...rest);
        };

        // Fresh module state so the bundle's top level re-evaluates under
        // the guard; a top-level native require would throw here.
        delete nodeRequire.cache[BUNDLE_PATH];
        moduleApi._resolveFilename = guardedResolve;
        let freshError: unknown;
        let freshActivated = false;
        try {
            const extension = nodeRequire(BUNDLE_PATH) as {
                activate(ctx: unknown): Promise<void>;
            };
            const freshContext = {
                subscriptions: [] as Array<{ dispose(): unknown }>,
                extensionUri: new UriStub(EXT_ROOT.split(/[\\/]/)),
                workspaceState: { get: vi.fn(), update: vi.fn() },
                globalState: { get: vi.fn(() => undefined), update: vi.fn() },
                asAbsolutePath: (relative: string) =>
                    path.join(EXT_ROOT, relative),
            };
            await extension.activate(freshContext);
            freshActivated = true;
        } catch (e) {
            freshError = e;
        } finally {
            moduleApi._resolveFilename = previousResolve;
            delete nodeRequire.cache[BUNDLE_PATH];
        }

        expect(freshError).toBeUndefined();
        expect(freshActivated).toBe(true);
    });
});
