# AGENTS.md

## Commands
- **Build:** `pnpm build` (workspace root; fans out to all packages in dependency order)
- **Lint:** `pnpm lint` (fix: `pnpm lint:fix`)
- **Format:** `pnpm format` (check: `pnpm format:check`)
- **Test all:** `pnpm test`
- **Single test:** `pnpm exec vitest run tests/unit/someFile.test.ts`
- **Test watch:** `pnpm test:watch`

On Windows 10:
- **Run any pnpm command:** `powershell -ExecutionPolicy Bypass -Command "pnpm ..."`

## Architecture
pnpm monorepo for PZ Studio. `pnpm-workspace.yaml` selects `packages/*`; the root package.json is a private workspace root (fan-out scripts + dev tooling only).

- `packages/core` (`@pzstudio/core`) — browser-safe domain logic, no Node builtins (enforced by `tests/unit/architecture-core.test.ts`): project types, `pzstudio.schema.json`-backed validation, migration, textgen (workshop.txt / mod.info / `patchModInfoId`), build planner (`planBuild`), mod.info parser, config defaults. Public project.json contract: `loadProject` / `validateProject` / `migrateProject` / `saveProject` with `schemaVersion` (chain: detectVersion → migrate → validate → normalize).
- `packages/platform` (`@pzstudio/platform`) — host-agnostic contracts: `ProjectFileSystem` (URI-based read/write/delete/stat/list), `PlatformCapabilities`, `TemplateTransport`.
- `packages/platform-node` (`@pzstudio/platform-node`) — Node adapter (`NodeFileSystem`, `NODE_CAPABILITIES`).
- `packages/platform-web` (`@pzstudio/platform-web`) — vscode.dev adapter (`WorkspaceFileSystem`, `WEB_CAPABILITIES`); imports the `vscode` module, only usable inside an editor host.
- `packages/cli` (`pzstudio-cli`, published, bin `pzstudio`) — thin CLI adapter: `packages/cli/src/index.ts` entry, public API at `packages/cli/src/api.ts`, commands in `packages/cli/src/lib/commands/`. Owns host-side helpers (fs probes, `~/.pzstudio` config, transports). `.template-legacy/` (git submodule container) stays at the repo root; the build copies it into `packages/cli/dist/`.
- `packages/vscode-extension` (`pzstudio42`) — VS Code extension; imports the CLI via `pzstudio-cli/api` (workspace dep; esbuild inlines the CLI's built `dist/api.js`, so build the CLI first).

Tests use Vitest from the repo root (`tests/unit/`, e2e in `tests/e2e/`, setup in `tests/setup/vitest.setup.ts`); extension suites import `packages/vscode-extension/src` with a shared `vscode` mock. `vitest.config.ts` aliases `@pzstudio/*` to package sources (tests need no prior package build) and pins `pzstudio-cli` to `packages/cli/dist`.

## Code Style
- **TypeScript strict mode** (but `strictNullChecks: false`). Target `esnext`, module `CommonJS`.
- **Prettier:** 4-space indent, single quotes, no tabs.
- **ESLint:** `@typescript-eslint/no-explicit-any` is off; unused vars warn with `^_` ignore pattern; `no-require-imports` off. `packages/*/src` are typed-linted through their own `tsconfig.build.json`.
- **Naming:** Commands are single lowercase files (e.g., `build.ts`).
- **Imports:** Use `require()`-style (CommonJS). `esModuleInterop` and `allowSyntheticDefaultImports` enabled.
- **Dependencies:** Runtime deps are minimal (picocolors, fflate, tslib). Use pnpm exclusively.
- **Browser safety:** `@pzstudio/core` and `@pzstudio/platform` must never import Node builtins or touch `process` — features ask `PlatformCapabilities` instead of branching on host type.
- **Error handling:** Validation logic in `packages/core/src/validation.ts` (host: `packages/cli/src/lib/expect.ts`, arg parsing in `args.ts`).
