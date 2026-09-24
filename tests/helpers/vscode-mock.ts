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
 */
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

    const mock = {
        Uri: MockUri,
        EventEmitter: MockEventEmitter,
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
            getConfiguration: vi.fn(() => ({
                get: vi.fn(
                    (_key: string, defaultValue?: unknown) => defaultValue,
                ),
                inspect: vi.fn(() => undefined),
                update: vi.fn(),
            })),
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
