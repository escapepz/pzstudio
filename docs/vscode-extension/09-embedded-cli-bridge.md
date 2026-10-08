# 09 — Embedded CLI Bridge (API v2)

The exact contract between the extension and `@pzstudio/cli/api`. The
extension never spawns the CLI binary; `scripts/bundle.js` inlines the api
bundle (`packages/cli/dist/api.js`, built from `packages/cli/src/api.ts`)
into `dist/extension.js`. Two important consequences of the packaging:

- The extension and the `pzstudio` executable are **separate bundles with
  separate module state** — the executable's process state never affects
  the extension host (`docs/cli/08-mechanics.md` packaging contract).
- The package root is not importable (`ERR_PACKAGE_PATH_NOT_EXPORTED`);
  `@pzstudio/cli/api` is the only supported surface.

This document was rewritten for the completed API v2 migration
(`11-api-v2-migration-plan.md`, commits 1–12). The pre-migration
architecture it described — extension code calling `runCLI`, `setLogger`,
`setProjectDir` and `setVsCodeSettings` against module-global CLI state —
is retained only by the **legacy facade** (§6 below), which exists for
external consumers of the published package and for the integration suites
that deliberately exercise it. The extension production runtime uses
none of it.

## 1. The host instance (activation)

At activation the extension creates **one** `PzStudio` instance and owns it
for the extension's lifetime:

```ts
const studio = createPzStudio({
    logger: createPZLogger(channel),                 // the OutputChannel bridge
    settings: (ctx) => readPzStudioHostSettings(ctx) // pure settings reader
});
```

- **Logger**: the same `createPZLogger` OutputChannel adapter as before —
  every engine and non-engine emission of this instance lands in the
  channel (stream mapping in §5).
- **Settings provider**: a pure reader of the VS Code `inspect()` layers
  (`workspaceValue`/`globalValue`). The MVP adapter **ignores the
  resource context** — the folder-settings blind spot (UX-05) is preserved
  bit-for-bit; the later per-folder fix is adapter-internal.
- **No factory `projectDir`**: every project-scoped call passes its
  explicit project context (the extension resolves a project per command —
  picker/active editor/tree node — exactly as before).
- **Lifetime**: the instance holds only its inputs. There is nothing to
  clear at deactivate (the legacy global-anchor/logger/settings cleanup is
  gone); the DevSync controller stops its session via disposal as before.
- The instance is created once and handed to the runner, task provider,
  DevSync controller, doctor and modinfo factories.

## 2. Runtime consumer mapping

| Consumer | Call | Notes |
| :--- | :--- | :--- |
| Generic runner (`util/execute.ts`) | `studio.run(command, args, { flags, projectDir })` | same-command busy guard unchanged; cross-command overlap queues on the engine lock (§4) |
| Task provider (`providers/buildTaskProvider.ts`) | `studio.run(...)` | explicit project context; no guard (unchanged UX); queues instead of racing (UX-08's race → serialization) |
| Development Sync (`util/devsync.ts`) | `studio.createDevSync(projectDir)` | per-project session; per-apply settings freshness; instance logger |
| Doctor (`util/doctor.ts`) | `studio.runProjectDoctor(fsPath)` | explicit context — no anchor save/restore; same `DoctorReport` |
| ModInfo overwrite check (`commands/modinfo.ts`) | `studio.resolveModInfoTargets(modId, projectDir)` | explicit project; read-only |

`summarizeApplyResult`, `WATCH_DEBOUNCE_MS`, `isWatchPathIgnored` and the
core re-exports are pure helpers, imported as before.

## 3. `studio.run` invocation contract

Identical to the embedded `runCLI` contract (both feed the same locked
lifecycle, `11-api-v2-migration-plan.md` §8.1):

- **Never prompts.** Embedded mode is decided from the invocation shape;
  destructive consent is the host's job.
- **Destructive consent** (`91620af`): `delete`/`rename` without `--yes`
  refuse with a `CliUsageError` whose message instructs the host to pass
  `{ flags: ['--yes'] }` once its UI has confirmed. The extension forwards
  `--yes` exactly there ([`04-command-flows.md`](04-command-flows.md)).
- **Flags in, not argv** (C2): `{ flags }` replaces `process.argv`; the
  extension never mutates argv; errors are thrown, never `process.exit`
  (C1) — the runner catches and swallows because `logger.error` already
  reported (`util/execute.ts`), the task terminal prints the message.
- **Project precedence** (normative): parsed `-C/--project` flag >
  per-call `projectDir` option > factory default > `process.cwd()`.
  Discovery semantics unchanged: start dir → walk up to fs root →
  fail closed.
- **Settings resolve once per run, after parsing**, with the *effective*
  project — a command targeting A can never run with settings resolved
  for B. Help/banner/usage-error runs also trigger exactly one provider
  call (a harmless pure read).
- Store/global-config migrations run before every real command; help and
  banner emit through the instance logger.

## 4. Engine lock and concurrency model

- The engine invocation lock is **process-wide and FIFO** within the api
  module: overlapping `studio.run` calls — palette runner vs task
  provider — **queue** instead of racing on shared engine state. This is
  the migration's single intentional behavioral change (UX-08: race →
  serialization); user-visible strings and the per-command busy guard are
  unchanged.
- API v2 is therefore **not fully parallel-safe**, and is not documented
  as such: engine runs serialize. Full per-call parallelism is phase-2
  work (explicit context through all command handlers).
- **Non-engine operations do not take the lock** and run genuinely in
  parallel with commands: DevSync sessions (`createDevSync`), doctor
  runs, `resolveModInfoTargets` and the template helpers. Their
  dependencies are resolved per operation from the instance (or, on the
  legacy facade, from raw legacy slots) — never from an ambient context.

## 5. Stream mapping (the real contract, unchanged)

`PzStudioLogger` is structurally identical to the legacy `ILogger` and is
implemented by `createPZLogger` (`util/logger.ts`):

| CLI logger call (semantic channel) | Extension rendering |
| :--- | :--- |
| `log(msg)` — **data** (reports, results, `Next:`, sync summaries) | `appendLine(msg)` — plain, **no timestamp/prefix** |
| `info(msg)` — **progress** | `[<timestamp>] [INFO] <msg>` |
| `warn(msg)` — **warning** | `[<timestamp>] [WARN] <msg>` |
| `error(err)` — **failure** | `[<timestamp>] [ERROR] <msg>\n<stack?>` **plus** `showErrorMessage(t('PZStudio Error: {0}', …))` |
| `verbose(msg)` — **debug** | **not implemented** → falls through to the CLI default: `process.stderr` of the extension host — invisible in the channel (UX-04) |
| `clear()` | `outputChannel.clear()` — implemented but currently **dead** |

The single "PZ Studio" OutputChannel interleaves both streams, with the
ext-side decoration produced **by the extension itself** — the extension
depends only on the *semantics* of the calls, never on the CLI's
`[INFO]` text formatting.

Routing after the migration: everything the extension triggers flows
through the instance logger above. The published `log`/`info`/`warn`/
`verbose` exports are **raw-legacy wrappers** (§6) — the extension runtime
does not import them anymore.

## 6. Legacy facade compatibility (external consumers)

Everything `@pzstudio/cli/api` exported before the migration still exists
with its exact signature and observable behavior — including state side
effects — for consumers of the published package:

- `runCLI` + the setters (`setLogger`, `setProjectDir`, `setVsCodeSettings`,
  `setTemplateTransport`) keep their legacy module-slot semantics
  (write-through per `11-api-v2-migration-plan.md` §13.1);
  the setters carry `@deprecated` JSDoc since commit 11 (removal is a
  major-version decision).
- The published `log/info/warn/verbose` are **raw-legacy wrappers**: they
  route by the legacy slots only and never consult an active v2 context —
  a call while any instance run is active still behaves exactly as before
  the migration.
- Legacy non-engine exports (`createDevSync`, `runProjectDoctor`,
  `resolveModInfoTargets`, template helpers) keep their documented side
  effects (anchor write, anchor save/restore, resolved-root discovery)
  and remain lock-free.
- The **extension production runtime no longer calls** the legacy setters
  (grep-guarded in `extActivation.test.ts`) — but the integration suites
  still exercise `runCLI`/`setProjectDir` deliberately to pin the facade
  contract inside a real host (`src/test/integration.test.ts`).

## 7. Build and packaging facts

- esbuild externals: `vscode`, `@parcel/watcher` (native binding stays out
  of the bundle; the CLI watch command lazy-requires it inside a function
  — permanent rule from `dc15821`, gate-checked at runtime and statically
  in `extBundleActivation.test.ts`).
- `minify: true` for production bundles; `sourcemap: true`.
- `.vscodeignore` keeps `dist/extension.js(.map)`, `l10n/`, `package.nls*`,
  `schemas/`, `resources/`, `icon.png`, `.template-legacy/` (offline
  template fallback probed at `<bundleDir>/../.template-legacy`).
- The CLI **must be built before** the extension (`tsconfig.json:16-18`
  maps `@pzstudio/cli/*` to `../cli/dist/*`; esbuild resolves through the
  workspace symlink + exports map). CI builds in dependency order.

## 8. Intentionally unsupported / deferred

- No prompts from embedded invocations; no per-call logger override (the
  instance logger is the only sink for the extension).
- No typed domain-command surface (`studio.build({target})`) — CLI-shaped
  `run` is the MVP contract (Track B).
- No web host yet: the v2 type surface is data-only, but the engine
  implementation stays Node until Track B.
- The UX findings in [`10-ui-ux-audit-findings.md`](10-ui-ux-audit-findings.md)
  still reproduce — the API migration fixed none of them (the one
  classification change is UX-08's race → serialization, §4).
