# Project Zomboid Studio Tests

This directory contains the test suite for Project Zomboid Studio.

## Structure

- `helpers/`: Shared test utilities and fixtures.
  - `test-fixtures.ts`: Unit test helpers and static project fixtures.
  - `e2e-fixtures.ts`: End-to-end test workspace and CLI invocation helpers.
  - `vscode-mock.ts`: Shared `vscode` module mock for extension unit tests.
- `unit/`: Unit tests for pure logic, parsing, and validation.
- `e2e/`: End-to-end tests organized by command.
- `setup/`: Vitest global setup configuration.

## End-to-End (E2E) Testing

E2E tests exercise the full CLI flow by invoking `runCLI()` against isolated temporary workspaces. This validates command routing, filesystem effects, and user-visible outcomes.

### Writing E2E Tests

1. Create a new test file in `tests/e2e/` (e.g., `new.test.ts`).
2. Use `createE2EWorkspace()` to get an isolated environment.
3. Use `workspace.run('command', ['args'])` to execute CLI commands.
4. Use `workspace.assertSuccess(result)` and `workspace.exists('file')` to verify outcomes.
5. Always call `workspace.cleanup()` in `afterEach`.

Example:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

describe('new command', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should create a new project', async () => {
        const result = await workspace.run('new', ['My Project', 'Author']);
        workspace.assertSuccess(result);
        expect(workspace.exists('project.json')).toBe(true);
    });
});
```

## Extension Unit Testing (vscode mock)

Extension sources (`packages/vscode-extension/src/`) are unit-tested with the shared vscode mock — no VS Code instance is launched. To import extension code with the mock active:

```typescript
vi.mock('vscode', async () =>
    (await import('../helpers/vscode-mock')).createVscodeMock(),
);
import * as vscode from 'vscode';
```

The factory result IS the mocked module: reach the `vi.fn()` stubs directly through the imported namespace (`vscode.window.showInputBox`, `vscode.workspace.fs.readFile`, ...). URIs are segment-based (`new (vscode.Uri as ...)(['proj', 'media'])`) and `fsPath` mirrors the platform separator, so `path.dirname`/`startsWith` logic behaves the same on every OS. `l10n.t` is a pass-through that substitutes `{0}`-style args, so assertions compare against the English bundle keys. External extension dependencies (`pzstudio-cli/api`) are mocked per test file with `vi.mock('pzstudio-cli/api', ...)`.

## Running Tests

```bash
pnpm test          # Run all tests
pnpm test:watch    # Run in watch mode
```
