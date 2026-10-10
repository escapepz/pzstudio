import { vi } from 'vitest';
import path from 'path';

/**
 * Shared vscode mock for extension unit tests. Import in a test file with:
 *
 *   vi.mock('vscode', async () =>
 *       (await import('../helpers/vscode-mock')).createVscodeMock(),
 *   );
 *   import * as vscode from 'vscode';
 *
 * The factory result IS the mocked module, so tests reach the vi.fn()
 * stubs directly through the imported namespace. URIs are path-only
 * (joinPath on '/'-separated segments); fsPath mirrors the segments with
 * the platform separator so path.dirname/startsWith logic works on every
 * CI OS.
 *
 * Configuration is modeled close enough to the real API that incorrect
 * resource scoping cannot pass silently (UX-05): `getConfiguration(section,
 * resource)` resolves resource-scoped settings through a three-layer store
 * (folder > workspace > global, defined-value semantics — `false`, `''`, `0`
 * are values, not absence). Folder values apply only when the resource lies
 * inside an opened `workspaceFolders` entry; a resource outside every folder
 * (or no resource at all) sees only the workspace and global layers, so no
 * unrelated folder's settings can leak. Tests seed/reset the store through
 * the exported `configurationStore` (also reachable as
 * `vscode.workspace.configurationStore`) and may replace the whole
 * `getConfiguration` implementation with narrower stubs — restoring the
 * faithful model is `mockImplementation(defaultGetConfiguration)`.
 */

/**
 * Three-layer configuration store with section-qualified keys
 * (e.g. 'pzstudio.outdir', 'pzstudio.build.target'). Folder keys are
 * normalized fsPaths; resolution checks every layer with `!== undefined`
 * so defined falsy values win over higher layers.
 */
export const configurationStore = {
    global: {} as Record<string, unknown>,
    workspace: {} as Record<string, unknown>,
    folders: {} as Record<string, Record<string, unknown>>,
    reset(): void {
        this.global = {};
        this.workspace = {};
        this.folders = {};
    },
};

const normalizeFsPath = (p: string): string =>
    p.split(/[\\/]/).filter(Boolean).join(path.sep);

/**
 * The opened workspace folder owning `resource` (longest fsPath prefix,
 * separator-bounded), or undefined when no resource is given or the
 * resource lies outside every opened folder. Real VS Code resolves
 * folder-scoped values exactly this way, so a resource outside the
 * workspace must never see a folder value.
 */
const owningFolderKey = (resource?: unknown): string | undefined => {
    if (!resource) return undefined;
    const target = normalizeFsPath((resource as { fsPath: string }).fsPath);
    let best: string | undefined;
    let bestLength = -1;
    for (const key of Object.keys(configurationStore.folders)) {
        const norm = normalizeFsPath(key);
        if (
            (target === norm || target.startsWith(norm + path.sep)) &&
            norm.length > bestLength
        ) {
            best = key;
            bestLength = norm.length;
        }
    }
    return best;
};

const folderValue = (
    folderKey: string | undefined,
    qualifiedKey: string,
): unknown =>
    folderKey === undefined
        ? undefined
        : configurationStore.folders[folderKey]?.[qualifiedKey];

/**
 * The faithful default `getConfiguration` model bound to
 * `configurationStore`. Exposed so tests that stubbed the whole
 * implementation can restore the resource-aware semantics.
 */
export function defaultGetConfiguration(section?: string, resource?: unknown) {
    const qualified = (key: string) => (section ? `${section}.${key}` : key);
    const folderKey = owningFolderKey(resource);

    return {
        get(key: string, defaultValue?: unknown): unknown {
            const q = qualified(key);
            for (const value of [
                folderValue(folderKey, q),
                configurationStore.workspace[q],
                configurationStore.global[q],
            ]) {
                if (value !== undefined) return value;
            }
            return defaultValue;
        },
        inspect(key: string) {
            const q = qualified(key);
            return {
                key,
                section,
                defaultValue: undefined,
                globalValue: configurationStore.global[q],
                workspaceValue: configurationStore.workspace[q],
                workspaceFolderValue: folderValue(folderKey, q),
            };
        },
        has(key: string): boolean {
            const q = qualified(key);
            return [
                folderValue(folderKey, q),
                configurationStore.workspace[q],
                configurationStore.global[q],
            ].some((value) => value !== undefined);
        },
        async update(
            key: string,
            value: unknown,
            target?: number,
        ): Promise<void> {
            const q = qualified(key);
            if (target === 3 /* ConfigurationTarget.WorkspaceFolder */) {
                const folder = owningFolderKey(resource);
                if (!folder) {
                    throw new Error(
                        `Cannot update a workspace-folder setting outside every opened folder: ${q}`,
                    );
                }
                configurationStore.folders[folder] ??= {};
                if (value === undefined) {
                    delete configurationStore.folders[folder][q];
                } else {
                    configurationStore.folders[folder][q] = value;
                }
                return;
            }
            const layer =
                target === 1 /* ConfigurationTarget.Global */
                    ? configurationStore.global
                    : configurationStore.workspace;
            if (value === undefined) {
                delete layer[q];
            } else {
                layer[q] = value;
            }
        },
    };
}

export function createVscodeMock() {
    class MockUri {
        constructor(readonly parts: string[]) {}
        get path(): string {
            return '/' + this.parts.filter(Boolean).join('/');
        }
        get fsPath(): string {
            const parts = this.parts.filter(Boolean);
            return parts.length ? path.sep + parts.join(path.sep) : path.sep;
        }
        static joinPath(base: MockUri, ...rest: string[]): MockUri {
            return new MockUri([...base.parts, ...rest.filter(Boolean)]);
        }
        static file(fsPath: string): MockUri {
            return new MockUri(fsPath.split(/[\\/]/));
        }
        toString(): string {
            return this.path;
        }
    }

    class MockEventEmitter<T> {
        event = vi.fn();
        fire = vi.fn((_value: T) => {});
        dispose = vi.fn();
    }

    class MockTreeItem {
        label: string;
        collapsible: number;
        constructor(label: string, collapsible: number) {
            this.label = label;
            this.collapsible = collapsible;
        }
    }

    class MockTask {
        constructor(
            public definition: unknown,
            public scope: unknown,
            public name: string,
            public source: string,
            public execution: unknown,
        ) {}
    }

    class MockRelativePattern {
        constructor(
            public base: unknown,
            public pattern: string,
        ) {}
    }

    const mock = {
        Uri: MockUri,
        EventEmitter: MockEventEmitter,
        RelativePattern: MockRelativePattern,
        TreeItem: MockTreeItem,
        Task: MockTask,
        CustomExecution: class {
            constructor(public callback: () => Thenable<unknown>) {}
        },
        ThemeIcon: class {
            constructor(public id: string) {}
        },
        FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        TaskScope: { Global: 1, Workspace: 2 },
        ViewColumn: { Active: -1, Beside: -2 },
        tasks: {
            registerTaskProvider: vi.fn(() => ({ dispose: vi.fn() })),
            taskExecutions: [],
            onDidStartTask: vi.fn(() => ({ dispose: vi.fn() })),
            onDidEndTask: vi.fn(() => ({ dispose: vi.fn() })),
        },
        l10n: {
            // Pass-through with indexed {0} substitution: assertions compare
            // against the English bundle keys.
            t: (message: string, ...args: (string | number)[]): string =>
                args.reduce(
                    (acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)),
                    message,
                ),
        },
        window: {
            showInputBox: vi.fn(),
            showQuickPick: vi.fn(),
            showWarningMessage: vi.fn(),
            showErrorMessage: vi.fn(),
            showInformationMessage: vi.fn(),
            showOpenDialog: vi.fn(),
            withProgress: vi.fn(
                async (_options: unknown, task: () => unknown) => task(),
            ),
            createOutputChannel: vi.fn(() => ({
                appendLine: vi.fn(),
                show: vi.fn(),
                clear: vi.fn(),
                dispose: vi.fn(),
            })),
            createTreeView: vi.fn(() => ({ dispose: vi.fn() })),
            activeTextEditor: undefined as
                | { document: { uri: unknown } }
                | undefined,
        },
        commands: {
            registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
            executeCommand: vi.fn(async () => {}),
        },
        workspace: {
            fs: {
                readFile: vi.fn(),
                stat: vi.fn(),
                readDirectory: vi.fn(),
            },
            getConfiguration: vi.fn(defaultGetConfiguration),
            // Test-only handle: seed/reset the configuration layers the
            // section/resource-aware getConfiguration resolves through.
            configurationStore,
            workspaceFolders: [] as Array<{ uri: MockUri; name: string }>,
            onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
            createFileSystemWatcher: vi.fn(() => ({
                onDidChange: vi.fn(),
                onDidCreate: vi.fn(),
                onDidDelete: vi.fn(),
                dispose: vi.fn(),
            })),
        },
    };
    return mock;
}
