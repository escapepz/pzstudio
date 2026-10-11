# 12 — Project Cockpit Migration Matrix

Design/architecture audit at HEAD `f83704c` (branch `42.20.0-dev`, tree
clean at time of writing) after the completed API-v2 migration
([`11-api-v2-migration-plan.md`](11-api-v2-migration-plan.md), commits 1–12).
This document maps the **current implementation** onto the **Project
Cockpit Interaction Spec v1** ([`12-project-cockpit.md`](12-project-cockpit.md))
and produces the implementation migration matrix for UX-R0…UX-R4.

Not in this document: any implementation. Production source, tests, the
manifest and the CLI/Core API were **read only**; the only artifact is this
file.

Method and source-of-truth rules:

- Docs 00–08 describe the pre-v2 architecture in places (runner →
  `runCLI`, `setProjectDir`/`setVsCodeSettings`/`setLogger`, deactivate
  cleanup). Where they conflict with source at HEAD, **source wins**; the
  current wiring is documented in
  [`09-embedded-cli-bridge.md`](09-embedded-cli-bridge.md) (rewritten for
  v2) and verified below. No pre-v2 claim is carried into this matrix as
  current state.
- Every "current state" row was verified against source at `f83704c` and,
  where possible, against the tests that pin it. File:line references are
  to HEAD.
- Classification labels used throughout:
  **Existing and reusable** (A) · **Needs extension behavior fix** (B-fix)
  · **Needs extension architecture** (B-arch) · **Needs CLI/Core
  capability** (C) · **Deferred beyond v1** (D).

---

## 1. Current architecture at HEAD (post API-v2)

What the extension actually is after commit 12 — the baseline every
Cockpit change builds on:

- **One host instance.** `extension.ts:35-38` creates one `PzStudio` via
  `createPzStudio({ logger: createPZLogger(channel), settings: (ctx) =>
  readPzStudioHostSettings(ctx) })` and owns it for the extension
  lifetime. The extension runtime calls **no** legacy facade export
  (grep-guarded by `tests/unit/extActivation.test.ts` "extension source
  imports no legacy facade setter"). `deactivate()` is empty
  (`extension.ts:96-100`).
- **Five consumer paths, all on the instance:**
  1. Generic runner (`util/execute.ts:69`) — `studio.run(command, args,
     { flags, projectDir })` with the per-command-id busy guard
     (`execute.ts:30-38`), non-cancellable notification progress
     (`execute.ts:61-66`), swallow-after-`logger.error`
     (`execute.ts:70-72`), channel auto-show only under `--verbose`
     (`execute.ts:76-78`), and an `onFinished` explorer-refresh hook
     (`execute.ts:81`).
  2. Task provider (`providers/buildTaskProvider.ts:65-68`) —
     `studio.run` with explicit project, no guard, no confirm; overlapping
     runs **queue on the engine lock** (FIFO), pinned by
     `tests/unit/buildTaskProvider.test.ts` "queues a task behind an
     in-flight engine invocation and completes FIFO without deadlock".
  3. Development Sync (`util/devsync.ts:53`) —
     `studio.createDevSync(projectDir)`; per-apply settings freshness and
     instance-logger routing pinned by `tests/unit/extUtilDevSync.test.ts`.
  4. Doctor (`util/doctor.ts:31`) — `studio.runProjectDoctor(fsPath)`,
     explicit context, no anchor save/restore (pinned by
     `tests/unit/extUtilDoctor.test.ts`).
  5. ModInfo probe (`commands/modinfo.ts:34-36`) —
     `studio.resolveModInfoTargets(modId, projectDir.fsPath)`, no legacy
     anchor write (pinned by `tests/unit/extCommandsModinfo.test.ts`).
- **Engine lock.** `studio.run` acquires a process-wide FIFO lock for the
  full invocation lifecycle (`packages/cli/src/lib/studio.ts:192-205`,
  `withEngineLock`); non-engine operations (DevSync, doctor,
  `resolveModInfoTargets`) are lock-free with instance-only dependencies
  (`studio.ts:208-244`). Isolation rules R0/R1 are pinned by
  `tests/unit/cliStudio.test.ts`, `cliStudioAcceptance.test.ts`,
  `cliStudioInstances.test.ts`.
- **Settings.** `util/settings.ts:58-62` is a pure provider reading the
  `inspect()` workspace/global layers and **intentionally ignoring the
  context** (UX-05 preserved bit-for-bit; pinned by
  `tests/unit/extUtilSettings.test.ts` "ignores the context for now").
- **Explorer.** `providers/projectExplorer.ts` is a filesystem-mirror tree
  (projects → directories/mod folders/missing mods/files) with tolerant
  raw-JSON reads (`projectExplorer.ts:592-605`) and a doctor badge
  computed per project per rescan (`projectExplorer.ts:431`).
- **What did NOT change with v2:** every UX finding of doc 10 except
  UX-08 (structurally hardened) and UX-10's anchor half still reproduces
  (doc 11 §19; re-verified below per finding).

### DevSync engine surface (what can honestly be reported)

`BuildSession` (`packages/core/src/buildsession.ts:337-396`) exposes
**only** `start(variants)`, `rebuild()`, `apply(deltas)`, `stop()`. There
is **no state accessor, no phase enum, no status event, no last-success
timestamp**. Real data available to a host:

- `start()` resolving = initial full build of both variants succeeded;
  rejecting = startup failure (message = per-variant errors joined,
  `buildsession.ts:430-436`).
- `apply()` returns `SessionApplyResult { incremental, scoped[],
  fullRebuild, ignored, errors[] }` (`buildsession.ts:261-272`) and
  **never throws** (`buildsession.ts:388-390`); `errors.length > 0` is the
  only reliable "needs attention" signal.
- `host.log(level, message)` emissions (wired to the instance logger,
  `packages/cli/src/lib/devsync.ts:89-95`).

Everything else is extension-inferred. The Cockpit Development section
(§9 below) is designed around exactly this boundary.

### Doctor surface (Project Health input)

`DoctorReport.diagnostics[]` items carry a **stable `code`** per finding
(`packages/core/src/doctor.ts:43-51`; e.g. `mods.missing`:392,
`filesystem.outDirInsideProject`:291, `templates.notCached`:310,
`project.validation`:173, `buildTarget.compatibility`:504). The engine is
host-blind (`runDoctor(fs, input)`) and the Node gatherer
(`packages/cli/src/lib/doctor.ts:58-104`) accepts `gameBuild` — already
exposed on the v2 API as `ProjectDoctorOptions.gameBuild`
(`studio.ts:103-106`, `doctor.ts:22-28`); the extension simply never
passes it (UX-11).

---

## 2. VS Code API constraints for the Cockpit (audited)

The Cockpit mock (spec §2) must be realized with native TreeView
contributions — no webview. Exact constraints that shape every row below:

| Capability | Available? | Consequence for the Cockpit |
| :--- | :--- | :--- |
| `TreeItem.command` | Yes — **one** command per row, fires on single click (label/icon/whole row), static `arguments` allowed | Section rows and status rows can carry a default action (e.g. Start Sync on the stopped-sync row). It cannot be "select only" — a row with a command always executes on click, so **rows whose spec interaction is "select only" must not set `command`**. |
| Inline buttons | `view/item/context` with `group: "inline"` + `when: viewItem == <contextValue>`; ~2–3 visible before overflow | Mod rows: at most the state-toggle pair inline; Configure/Generate/Rename/Delete stay context-menu-only (current pattern, kept). |
| Context menus | `view/item/context` groups with `when` on `viewItem` (single string; matchers `=~ /^…/` possible) | One `contextValue` per row; compound states must be encoded in the value (current `mod-<state>` / `mod-missing` pattern is the right shape). |
| Section headers inside one tree | No native header rows. Sections are **tree nodes** (non-expandable label rows with `description`) or collapsible section roots | "Mods / Development / Build / Project Health" become header nodes with counts in `description`; ordering is fully controlled by `getChildren` (filesystem ordering already isn't consulted — spec §2 holds). |
| Two-line rows | Not available — one line = `label + description`; `tooltip` supports MarkdownString | "Main + Development / Last sync: just now" become **child rows** under the sync row (non-interactive, no command) or tooltip content. |
| Row badges | No `TreeItem.badge`. Options: `description` text (current), label glyph prefixes, or a `FileDecorationProvider` (badge letter + color via `resourceUri`) | Spec: "Text communicates the state" — description/suffix text is the primary mechanism; FileDecoration optional later. |
| Welcome content | `contributes.viewsWelcome` renders only when the provider returns **zero** root items, gated by a `when` clause | Current empty state returns an info placeholder node (`projectExplorer.ts:416`) — the Cockpit empty workspace must return `[]` and move both CTAs (Create New Project / Set Up Existing Mod) into `viewsWelcome` variants switched by a context key (e.g. `pzstudio.existingModDetected`). |
| View chrome | `TreeView.title/description/message` writable; `view/title` menu for actions | "PZ STUDIO" container title is static (manifest); sync/global status could ride `treeView.message` if ever needed — default: keep state in-tree, not in chrome. |
| Collapsible states | `None/Collapsed/Expanded`; expansion is user-controlled | Sections default `Collapsed`/`Expanded` per spec (Project Files and Other Projects collapsed); the provider cannot force re-collapse without `TreeView.reveal` tricks — initial state only. |
| Selection events | `TreeView.onDidChangeSelection` exists; `TreeView.reveal(element, {select, focus, expand})` available | "Selecting an Other Projects row switches Active Project" = the row's click command (`pzstudio.switchProject` with static `arguments: [dir]`), not selection-change (avoids oscillation from keyboard navigation). |
| Keyboard/a11y | Inline buttons and context menus are keyboard-reachable; `TreeItem.command` fires on Enter; no pointer-only affordance may carry state changes | All state transitions must exist as commands reachable from the context menu (they already do). |

Nothing in the spec mock requires a control VS Code does not offer; the
two real reshapes are (a) multi-line status rows → child rows/tooltip and
(b) empty-state CTAs → `viewsWelcome` + context keys.

---

## 3. UX-01…UX-18 audit at HEAD

Per-finding: original symptom → original source → current HEAD behavior →
status → evidence → Cockpit-era remediation → dependencies → regression
tests. Status values: **Open** (reproduces unchanged), **Structurally
addressed** (root cause removed by v2; residual UX concern noted),
**Partially addressed**, **Docs-only**.

### UX-01 — Task target conflicts with `pzstudio.build.target` — **Open**

- Symptom: task `pzstudio: build (development)` + setting `production` →
  `Conflicting options: --development cannot be combined with --production.`
- Original source: `buildTaskProvider.ts:51-58` layering the task flag on
  `resolveFlags('build')` (`flags.ts:27-36`); conflict validation
  `packages/cli/src/lib/parser.ts:473-486`, conflicts
  `packages/cli/src/lib/commands/build.ts:209-211`.
- HEAD: identical. Task flag assembly is `buildTaskProvider.ts:56-63`;
  the conflict validator is unchanged (verified at `parser.ts:481`).
- Evidence: `tests/unit/buildTaskProvider.test.ts` pins the current
  assembly ("runs build through the host instance with the production
  flag" etc.).
- Remediation: `resolveFlags('build')` gains an explicit-target override
  (skip the setting flag when one is given), used by the task provider;
  the palette command keeps the setting. Extension-only; no CLI change.
- Dependencies: none. Cockpit Build section (R3) reuses the same helper.
- Regression tests: task target + setting = different → exactly one
  target flag; equal → one flag; setting `default` → task flag only;
  clean task unaffected.

### UX-02 — Cancelling the project picker in build/clean re-prompts, then lies — **Open**

- Symptom: first `Esc` re-prompts; second `Esc` yields the false
  "no PZ project … nothing to build" warning.
- Original source: `commands/build.ts:14-16,34` / `clean.ts:14-16,34`
  pass `dir?.fsPath` (undefined on cancel) into the runner;
  `util/execute.ts:46-54` re-resolves; `util/project.ts:57-64` warns.
- HEAD: identical (verified; `execute.ts` now calls `studio.run` but the
  resolution/re-warn shape is unchanged).
- Evidence: no test pins the double-prompt; `extUtilExecute.test.ts`
  pins "warns and skips when the workspace has no project".
- Remediation: cancel = abort (spec §13 "Cancel means no side effects;
  no second hidden prompt"): pass the picked dir only when truthy and
  treat `undefined` as stop. With the Cockpit (R1), the palette default
  becomes Active Project, so the picker disappears from the common path
  entirely.
- Dependencies: none. R1's Active Project makes it mostly moot but R0
  closes the wrong-message path.
- Regression tests: cancel once → no run, no second picker, no warning;
  tree-node context → no picker.

### UX-03 — `PZ Studio: Update` requires a project although the CLI operation is global — **Open**

- Symptom: project-less workspace → "no PZ project … nothing to update".
- Original source: `commands/update.ts:4-10` via the generic runner's
  unconditional resolution.
- HEAD: identical (`update.ts:7-9`). The v2 API removed the *engine*
  requirement — `studio.run('update')` with no `projectDir` is valid
  (discovery from cwd; `packages/cli/src/lib/studio.ts:187`), but the
  extension still pre-resolves.
- Evidence: runner path `execute.ts:46-54`; engine contract doc 09 §3.
- Remediation: call `studio.run('update', [], { flags })` directly from
  the handler (bypass the runner's resolution, like watch/doctor do).
  Extension-only.
- Dependencies: none.
- Regression tests: update runs in a project-less workspace; flags still
  honor `pzstudio.verbose`; output lands in the channel.

### UX-04 — `--verbose` diagnostic output never reaches the OutputChannel — **Open**

- Symptom: with `pzstudio.verbose`, `[DEBUG]` lines go to the extension
  host's stderr, invisible in the channel.
- Original source: `util/logger.ts:16-41` — `createPZLogger` implements
  `log/info/warn/error/clear`, **not `verbose`**; engine fallback to
  stderr (`packages/cli/src/lib/logger.ts` verbose fallback, doc 09 §5).
- HEAD: identical (verified — `createPZLogger` has no `verbose`).
- Evidence: doc 09 §5 table row "verbose — not implemented"; no test
  contradicts.
- Remediation: implement `verbose(msg)` → `[<timestamp>] [DEBUG] <msg>`
  in `createPZLogger`. Extension-only, tiny. Unlocks honest Cockpit
  diagnostics.
- Dependencies: none.
- Regression tests: instance logger receives verbose lines during a
  `--verbose` run (capture in `extUtilExecute.test.ts` shape).

### UX-05 — Resource-scoped settings ignore folder-level values — **Open (by design; fix is now adapter-internal)**

- Symptom: per-folder `pzstudio.outdir`/`templates.*` in multi-root
  workspaces silently ignored.
- Original source: `util/settings.ts` reading only
  `workspaceValue`/`globalValue`; flag reads without a resource.
- HEAD: reproduced deliberately — `settings.ts:58-62` accepts the v2
  context and ignores it ("UX-05 deliberately unchanged", pinned by
  `tests/unit/extUtilSettings.test.ts`). v2 resolved the structural
  blocker: the provider is invoked with the **effective projectDir**
  post-parse (`packages/cli/src/lib/studio.ts:135-157`), so a per-folder
  fix needs no API change.
- Evidence: test pin above; doc 11 §10/§19.
- Remediation: `readPzStudioHostSettings(ctx)` resolves folder-scoped
  values from `ctx.projectDir` (map projectDir → containing workspace
  folder, read `inspect()` with that resource). Also give flag reads a
  resource (`flags.ts` needs the projectDir — resolved in the runner
  where it is already known). Extension-only.
- Dependencies: none structural; do it before the Cockpit trusts
  per-folder templates (R0).
- Regression tests: two folders with different `pzstudio.outdir` → each
  command's run resolves its own folder's layer (provider receives the
  right projectDir — already pinned generically in
  `tests/unit/cliStudio.test.ts`).

### UX-06 — Development Sync start: no progress, failure double-reports — **Open**

- Symptom: initial full build of both outputs with no progress UI; start
  failure logs `[WARN]` **and** surfaces an uncaught host error toast.
- Original source: `commands/watch.ts:30` (`await controller.start(...)`
  — no `withProgress`, no `catch`); `util/devsync.ts:65-70` (warn +
  rethrow).
- HEAD: identical (verified; the controller now creates the session via
  `studio.createDevSync`, same start/rethrow shape).
- Evidence: `tests/unit/extUtilDevSync.test.ts` "start failure warns
  through the instance logger, stops the half-start and rethrows".
- Remediation: wrap start in `withProgress` (title = project name,
  "Preparing Main + Development"), catch the rethrow in the command and
  show one friendly notification. R2's Development section makes the
  state persistent (`◌ Starting…` row) instead of transient-only.
- Dependencies: none for the R0 fix; R2 consumes the state owner.
- Regression tests: start shows progress; start failure → exactly one
  notification, no unhandled rejection, controller back to idle.

### UX-07 — Explorer runs full doctor for every project on every rescan — **Open**

- Symptom: every debounced refresh / `project.json` change / command run
  executes N full `runProjectDoctor` sweeps.
- Original source: `providers/projectExplorer.ts:431`
  (`projectDiagnostics(dir)` inside `getProjectNodes`); no cache.
- HEAD: identical (verified).
- Evidence: doc 03 "Diagnostics badge"; no cache exists in the provider.
- Remediation: **minimal R0**: cache the `ProjectDiagnosticsSummary` per
  project dir keyed by `project.json` mtime (or a dirty-flag set fed by
  the same events that trigger refresh); full **R2** HealthService owns
  it properly (§10 below). No CLI change.
- Dependencies: R2 HealthService supersedes the minimal cache.
- Regression tests: badge unchanged after one refresh; second refresh
  within the same `project.json` state performs zero doctor runs (spy on
  the diagnostics source); mutation → one re-run.

### UX-08 — Concurrency: per-command guard only; tasks bypass it — **Structurally addressed (race → serialization); residual UX open**

- Symptom (original): overlapping `runCLI` calls racing on module-global
  state — task provider vs palette runner.
- HEAD: the engine lock (FIFO) serializes all `studio.run` calls
  (`studio.ts:192-205`); the palette runner keeps its same-command
  busy-guard (`execute.ts:30-38`); the task provider deliberately has
  none and **queues** (`buildTaskProvider.ts:18-23` comment; pinned by
  `tests/unit/buildTaskProvider.test.ts` "has no task-specific busy
  guard: concurrent tasks both dispatch" + the FIFO/deadlock test).
- Residual UX: a task started mid-command waits silently — the terminal
  shows `started...` and nothing else until the engine frees; the Cockpit
  Build section (R3) should surface a queued/Building state so waiting is
  visible. Full per-call parallelism is phase-2 engine work (doc 11 §9) —
  **D** for this matrix; not a Cockpit prerequisite.
- Regression tests: existing FIFO tests; R3 adds "build row shows
  Building… while a task holds the lock" if the state owner observes it.

### UX-09 — DevSync feeds unfiltered events; `isWatchPathIgnored` unused — **Open**

- Symptom: every event under the project is fed to `session.apply`;
  outdir-inside-project (pathological) would self-feed.
- Original source: `util/devsync.ts:59-61,95-107` (no filter);
  `isWatchPathIgnored` exported for hosts (`packages/cli/src/lib/watch-shared.ts:36-57`,
  re-exported `api.ts:67-71`), used by the CLI watch command
  (`packages/cli/src/lib/commands/watch.ts:124`).
- HEAD: identical (verified; controller shape unchanged post-v2).
- Remediation: filter in `DevSyncController.schedule` using the session's
  resolved outdir (`getOutDir` via the plan input is not exposed to the
  extension — but `isWatchPathIgnored(projectDir, outDir, path)` needs an
  outDir; the controller can obtain the effective outdir once per session
  via the doctor gatherer or a cheap `getOutDir` through
  `studio.runProjectDoctor`'s report? No — see open question Q3: the
  minimal honest fix is dot-segment filtering + outdir exclusion derived
  from the first full-rebuild/plan information the extension can obtain
  without new API; if the outdir cannot be resolved extension-side without
  duplicating tier logic, filter dot/outside-project cases now and file
  the outdir case against the DevSync state owner in R2 where the session's
  first apply already reveals classification behavior). Extension-only
  for the achievable half; **open question Q3** for the rest.
- Regression tests: events under a dot segment never reach `apply`;
  CLI/extension parity cases from `tests/unit/watch.test.ts` reused.
- **Reconciliation addendum (governance pass, 2026-10-12).** The
  achievable remediation **shipped** at `8967ada` after the accepted Q3
  decision: `studio.resolveOutDir` plus the doc 13 §6.3
  refresh-triggered re-resolution policy, with the Q3 §10 test
  matrices (A/B/C) — this row's "HEAD: identical" snapshot predates
  that commit and describes the matrix's audit point, not today. The
  residual windows §6.3 named were subsequently **proven** silent
  source-event losses (red-first evidence retained in the UX-09 stash,
  read-only). The proposed successor — the **UX-09 DevSync Baseline
  Safety Contract** (doc 13 §14, historically labeled "Q4 DevSync";
  **unrelated to this matrix's Q4**) — spans Core/API items that are
  outside UX-R0's extension-only boundary and is gated on the owner
  decisions recorded in doc 13 §15 (Contract B and the C1–C12
  classifications). UX-R0's boundary is unchanged; no cross-package
  prerequisite may ride a UX-09 commit.

### UX-10 — `modinfo` command touches the global anchor and Node `fs` directly — **Partially addressed**

- Anchor half: **fixed** — `commands/modinfo.ts:34-36` calls
  `studio.resolveModInfoTargets(modId, projectDir.fsPath)`; no
  `setProjectDir` import remains (pinned by `tests/unit/extCommandsModinfo.test.ts`
  "without a legacy anchor write" and the `extActivation` grep-guard).
- Node fs half: **open** — `existsSync`/`join` from `fs`/`path`
  (`modinfo.ts:3-4,36`) probe existing `mod.info` files. Web-host
  blocker, Track B per doc 11 §11. **D** (beyond v1; the Cockpit does not
  change it).

### UX-11 — Doctor lacks `gameBuild`; engine errors surface raw — **Open (the API part became trivial)**

- Symptom: `pzBuildCompatibility` check silently absent from extension
  surfaces; an engine exception propagates as a raw command error.
- HEAD: `util/doctor.ts:31` calls `studio.runProjectDoctor(fsPath)` with
  no options — but `ProjectDoctorOptions.gameBuild` **exists** on the v2
  API (`studio.ts:103-106`), so forwarding it is a one-line extension
  change plus a settings decision (`pzstudio.gameBuild`, string, empty =
  skip). `commands/doctor.ts:37-38` still awaits the diagnostics with no
  try/catch.
- Remediation: add the setting (R0 decision, Q2), forward it; wrap the
  diagnostics call and route failures through `logger.error` (single
  error pipeline, UX-16).
- Dependencies: Q2 decision; R2 Health reuses the same runner.
- Regression tests: gameBuild set → compatibility findings appear;
  engine throw → notification + channel, no unhandled rejection.

### UX-12 — README drift — **Docs-only** (unchanged; one refresh commit before the next release; not a Cockpit dependency)

### UX-13 — Missing mods have full context menus but no inline buttons — **Open**

- Symptom: `mod-missing` rows offer Configure/ModInfo/Rename/Delete
  (matcher `viewItem =~ /^mod/`, `package.json:108-126`) though the
  operations mostly error without the folder.
- HEAD: identical (`projectExplorer.ts:374-382` sets `mod-missing`;
  manifest matchers unchanged).
- Remediation (spec §5.6): missing rows expose only Remove from
  Project… / Open project.json / Refresh. Concretely: keep
  `contextValue: 'mod-missing'`, narrow the four context-menu entries to
  `^mod-(included|devonly|excluded)` (inline entries already are), and add
  `pzstudio.removeMissingMod` (a confirmed `delete`-entry-only flow — the
  CLI `modconfig`/`delete` split needs one decision, Q4: "Remove from
  Project" without a folder is **not** today's `pzstudio delete` (it
  removes the mod folder). The safe v1 action set is Open project.json +
  Refresh; a true "remove entry from project.json" needs either CLI
  support or an extension-side `modconfig`-free edit — **Q4, defer to
  R0/R1 implementation**, do not ship an invalid action).
- Dependencies: Q4. Manifest-only for the narrowing; new command only if
  Q4 resolves to "remove entry" in v1.
- Regression tests: `mod-missing` context menu shows no
  Configure/Generate/Rename; inline buttons still absent (existing
  behavior).

### UX-14 — New Project: cancelling the folder picker silently continues — **Open (spec resolves the open UX question)**

- HEAD: unchanged and still test-pinned
  (`commands/new.ts:45-51` cancel → `defaultUri?.fsPath`;
  `tests/unit/extCommandsNew.test.ts` "uses pzstudio.newProject.defaultLocation
  as the picker default and cancel fallback").
- The Interaction Spec §13 is explicit: cancel = no mutation, no fallback
  selection. The old pin (issue #43 spec) is thereby superseded by the
  locked product decision — the behavior changes in R0 and the test is
  updated to assert abort. Flagged here so the change is deliberate, not
  accidental.
- Regression tests: explicit cancel with a default present → abort, no
  title prompt; no default configured → previous fallback acceptable or
  also abort (decide in implementation; spec favors abort).

### UX-15 — Development Sync toggle is global and does not name the running project — **Open (v2 enabled the fix; UX work remains)**

- HEAD: one controller per window (`extension.ts:71`); `watch.ts:16-19`
  stops whatever runs; the controller records **no owning project**
  (`util/devsync.ts:26-31` — session/watcher/pending/timer/starting
  only); no persistent indicator (status bar was dropped pre-v2; nothing
  replaced it).
- Remediation: the DevSync state owner (§9) tracks the owning project;
  start-while-active offers the named stop/switch confirmation (spec
  §6.7); the Cockpit Development section renders owner + phase persistently.
  Extension-only — sessions are already per-project objects fed by the
  instance (doc 11 §19 "UX-15 enabled").
- Regression tests: start B while A active → confirmation names A;
  cancel → A keeps running; confirmed → A stopped fully (watcher
  disposed, session drained) before B starts; stop failure → B not
  started, actionable error.

### UX-16 — OutputChannel never opens on errors — **Open**

- HEAD: `util/logger.ts:23-38` — error → notification only;
  `execute.ts:76-78` — channel shows only under `--verbose`.
- Remediation: on `logger.error`, show an "Open Output" action on the
  notification (or `outputChannel.show(true)` on first error of a run).
  Single error pipeline adopted by every Cockpit section.
- Regression tests: injected error → notification offers Open Output →
  activating it shows the channel; only one action per error.

### UX-17 — Progress/notification strings use raw command ids — **Open**

- HEAD: `execute.ts:35,64` use the raw id in the busy warning and the
  progress title.
- Remediation: command-id → localized-title map (`t()` at call time).
  Extension-only, tiny.
- Regression tests: progress title for `build` = "PZ Studio: Build";
  busy warning uses the title.

### UX-18 — Extension reads `project.json` as raw JSON, bypassing the project contract — **Open (consumption path exists in core)**

- HEAD: all reads tolerant raw JSON — `util/project.ts:16-38,231-279,291-310`,
  `projectExplorer.ts:592-605`. `loadProject` (detect → migrate →
  validate → normalize) is public in `@pzstudio/core`
  (`packages/core/src/project-contract.ts:112-151`) but **not** on
  `@pzstudio/cli/api` (`packages/cli/src/api.ts` exports no project
  contract), and the extension does not depend on `@pzstudio/core`
  directly.
- Remediation (R1): two options — (a) extension adds `@pzstudio/core` as
  a direct dependency and implements a ~30-line `ProjectFileSystem`
  adapter over `vscode.workspace.fs` (the platform contract is
  URI-based; `loadProject` is browser-safe); (b) CLI api gains
  `studio.loadProject(projectDir)` (CLI change, Q5). Recommendation:
  **(a)** — zero CLI surface change, core is already in the bundle
  transitively. The Cockpit consumes the validated snapshot for all
  rendering; the tolerant fallback remains for the broken-file
  placeholder row (spec §18 "keep the tolerant fallback").
- Regression tests: v1-shape project renders identically after
  migration; newer `schemaVersion` → clear error row, not garbage;
  malformed JSON → placeholder row (unchanged).

### Counts

- Structurally addressed by API-v2: **1** (UX-08; residual queue
  visibility → R3 note).
- Partially addressed: **1** (UX-10 anchor half; fs half deferred).
- Open / reproducing: **15** (UX-01–07, 09, 11, 13–18 minus 12).
- Docs-only: **1** (UX-12).
- Nobody may label all 18 "open": UX-08 and UX-10's anchor half are
  closed by the migration and carry different work items.

---

## 4. The migration matrix

Change types: *rearrange* · *behavior fix* · *new state-owner* · *new
capability*. Owner layers: **Ext UI** (commands/providers/manifest) ·
**Ext service** (util/ new services) · **CLI API** (`@pzstudio/cli/api`)
· **Core** (`@pzstudio/core`).

| ID | Current state (HEAD) | Target state (Spec v1) | Change type | Owner layer | Affected files | Required API | Dependencies | Priority | Verification | Risk |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| UX-01 | Task target flag layered over setting flag → conflict failure (`buildTaskProvider.ts:56-63`) | Task target **overrides** configured target; single flag source | behavior fix | Ext UI | `util/flags.ts`, `providers/buildTaskProvider.ts` | Existing | none | R0 | Task+setting differ → one flag; task runs | Low — flag assembly regression |
| UX-02 | build/clean cancel re-prompts then false-warns (`build.ts:14-16,34`) | Cancel aborts once, no false warning | behavior fix | Ext UI | `commands/build.ts`, `commands/clean.ts`, `util/execute.ts` | Existing | none | R0 | Cancel → no run, no warning | Low |
| UX-03 | `update` gated on project resolution (`update.ts:7-9`) | Global update runs project-less | behavior fix | Ext UI | `commands/update.ts` | Existing (`studio.run` project-less) | none | R0 | Runs in empty workspace | Low |
| UX-04 | `createPZLogger` lacks `verbose` → stderr (`logger.ts:16-41`) | `[DEBUG]` lines in channel | behavior fix | Ext service | `util/logger.ts` | Existing | none | R0 | Verbose run shows `[DEBUG]` in channel | Low |
| UX-05 | Provider ignores context; folder settings dead (`settings.ts:58-62`) | Folder-scoped values resolved per effective project | behavior fix | Ext service | `util/settings.ts`, `util/flags.ts` | Existing (provider gets `projectDir`) | none | R0 | Two folders → two resolved layers | Medium — tier-parity tests |
| UX-06 | Sync start: no progress; failure double-reports (`watch.ts:30`, `devsync.ts:65-70`) | Progress during initial build; single error surface | behavior fix | Ext UI | `commands/watch.ts` | Existing | none | R0 | One notification on failure; progress shown | Low |
| UX-07 | Full doctor per project per rescan (`projectExplorer.ts:431`) | Bounded cached badge; full policy in HealthService | new state-owner (minimal) → superseded | Ext service | `providers/projectExplorer.ts`, new `util/health.ts` (R2) | Existing (`runProjectDoctor`) | R2 HealthService supersedes | R0/R2 | Zero doctor runs on unchanged rescan | Low |
| UX-08 | Engine lock serializes; task queues silently | Queued state visible (Cockpit Build row) | behavior fix | Ext UI | R3 build section | Existing | R1 (Cockpit) | R3 | Build row reflects queued/Building | Low |
| UX-09 | Watcher feeds every event (`devsync.ts:59-61`) | Outdir/dot events pre-filtered like CLI | behavior fix | Ext service | `util/devsync.ts` | Existing (`isWatchPathIgnored` exported) | Q3 (outdir resolution) | R0 | Dot/outside events never reach `apply` | Low |
| UX-10 | Anchor fixed; Node `existsSync` probe remains (`modinfo.ts:3,36`) | Web-safe probe | new capability | CLI API/Core | `commands/modinfo.ts` | Missing (web fs) | Track B | D | — (not v1) | Web-host only |
| UX-11 | No `gameBuild`; raw engine errors (`doctor.ts:31`, `commands/doctor.ts:37-38`) | Compatibility check forwarded; errors routed through logger | behavior fix | Ext UI | `util/doctor.ts`, `commands/doctor.ts`, manifest (setting) | Existing (`ProjectDoctorOptions.gameBuild`) | Q2 | R0 | Setting set → findings appear; throw → notification | Low |
| UX-12 | README drift | Refreshed README | docs | Ext docs | `packages/vscode-extension/README.md` | none | next release | R0 | Manual review | none |
| UX-13 | `mod-missing` gets Configure/Generate/Rename/Delete (`package.json:108-126`) | Remediation-only actions on missing rows | behavior fix | Ext UI | `package.json`, `providers/projectExplorer.ts`, possibly new command | Existing | Q4 (remove-entry semantics) | R0 | Missing menu = Open project.json/Refresh only | Low |
| UX-14 | Picker cancel falls back to default destination (`new.ts:45-51`) | Explicit cancel aborts | behavior fix | Ext UI | `commands/new.ts`, `tests/unit/extCommandsNew.test.ts` | Existing | spec supersedes old pin | R0 | Esc → abort, no title prompt | Low — pinned test changes |
| UX-15 | Global toggle; no owning project; no persistent indicator (`watch.ts:16-19`, `devsync.ts:26-31`) | Named owner, switch confirmation, persistent state | new state-owner | Ext service | `util/devsync.ts` → `util/devsyncState.ts`, `commands/watch.ts` | Existing (sessions per project) | R1 Cockpit shell | R2 | Switch confirmation names A; cancel keeps A | Medium — stop/start ordering |
| UX-16 | Channel never opens on errors (`logger.ts:23-38`) | Error notifications carry Open Output | behavior fix | Ext service | `util/logger.ts` | Existing | none | R0 | Action opens channel | Low |
| UX-17 | Raw command ids in progress/busy strings (`execute.ts:35,64`) | Localized titles everywhere | behavior fix | Ext service | `util/execute.ts` | Existing | none | R0 | "PZ Studio: Build" in progress | Low |
| UX-18 | Tolerant raw-JSON reads everywhere (`project.ts:16-38` etc.) | Cockpit renders validated snapshot; tolerant fallback kept | new capability (consumption) | Ext service (+Core direct dep) | `util/project.ts`, new `util/projectContract.ts`, `providers/*` | Core `loadProject` public; not on CLI api (Q5: adapter vs api export) | none (option a) | R1 | v1 project migrates visually; newer version → error row | Medium — two read paths coexist |
| CP-01 | No Active Project concept; per-command resolution (`util/project.ts:323-360`) | One Active Project per window; auto-select/switch/pin semantics | new state-owner | Ext service | new `util/activeProject.ts`, `extension.ts`, palette command | Existing (`findProjectDirs`) | none | R1 | §8 acceptance list | Medium — oscillation guards |
| CP-02 | Filesystem-mirror explorer (`projectExplorer.ts`) | Cockpit hierarchy: Header, Mods, Development, Build, Health, Files, Other Projects | rearrange | Ext UI | new `providers/cockpit.ts` (evolves explorer), manifest | Existing | CP-01, UX-13, UX-18 | R1 | Section order fixed; states render | Medium — tree rewrite scope |
| CP-03 | Project row = name + id/title + doctor badge | Header with aggregate status precedence (§4 spec) | new state-owner | Ext service | cockpit provider + health/devsync states | Existing | CP-01, R2 states | R2 | Precedence order per spec | Low |
| CP-04 | Sync state = output-channel lines only | Persistent Development section with phase/owner/last-sync | new state-owner | Ext service | new `util/devsyncState.ts` | Existing (start/apply/stop results) | CP-01 | R2 | §9 state mapping tests | Medium — honest inference |
| CP-05 | Build state invisible (channel/terminal only) | Build section: Ready/Building/Completed/Failed; configured target primary | new state-owner | Ext service | new `util/buildState.ts`, cockpit provider, commands | Existing | CP-01, UX-01 | R3 | Target display; state transitions | Medium |
| CP-06 | Explorer mirrors root files (`PROJECT_ROOT_FILES`) | Project Files section collapsed by default | rearrange | Ext UI | cockpit provider | Existing | CP-02 | R1 | Collapsed default; navigation works | Low |
| CP-07 | All projects rendered as equal roots | Other Projects collapsed at bottom; low-detail rows | rearrange | Ext UI | cockpit provider | Existing | CP-01 | R1 | Row click switches; no nested cockpit | Low |
| CP-08 | Empty workspace → info placeholder node (`projectExplorer.ts:416`) | `viewsWelcome` CTAs (Create / Set Up Existing Mod) | rearrange | Ext UI | manifest, cockpit provider | Existing (viewsWelcome) | CP-02 | R1/R4 | Welcome shows when 0 projects | Low |
| CP-09 | No detection of unmanaged mods | Strong-signal detection + one-time notification + persistent CTA | new capability | Ext service | new `util/existingModDetect.ts` | Existing (workspace.fs reads only) | CP-08 | R4 | Detection matrix §11 | Medium — false positives |
| CP-10 | **No adoption capability exists** (verified: no analyze/plan/import in CLI/Core; only `scaffoldProject`) | Detect→Analyze→Preview→Confirm→Set Up→Health→Sync CTA, non-destructive | new capability | Core + CLI API | new core adoption planner + `studio.*` wrapper (Q1) | **Missing** | Q1 decision | R4 | Preview lists exact writes; apply creates only new files | High — data safety gate |
| CP-11 | Refresh = implicit (runner `onFinished`); no health invalidation events | One operation service: resolution/cancellation/consent/error routing/refresh+health events | new state-owner | Ext service | new `util/operations.ts` wrapping execute/doctor/devsync hooks | Existing | CP-01 | R1 | All entry points emit same events | Medium |
| CP-12 | BuildSession exposes no status/events (`buildsession.ts:337-396`) | Structured session status API | new capability | Core + CLI API | `packages/core/src/buildsession.ts`, `packages/cli/src/lib/devsync.ts` | **Missing** — v1 works without it (§9) | none | D | — (beyond v1) | Deferred |

Owner-layer count (rows whose primary work lands in each layer): Ext UI —
UX-01, UX-02, UX-03, UX-06, UX-08, UX-11, UX-13, UX-14, CP-02, CP-06,
CP-07, CP-08 (**12**). Ext service — UX-04, UX-05, UX-07, UX-09, UX-15,
UX-16, UX-17, UX-18, CP-01, CP-03, CP-04, CP-05, CP-09, CP-11 (**14**).
CLI API — UX-10, CP-12 (**2**, both deferred). Core — CP-10 (**1**, with
CLI API). Docs — UX-12 (**1**).

### A. Existing capabilities that can be reused (verified at HEAD)

- `studio.run(command, args, { flags, projectDir })` — every runner
  command including project-less `update` (engine side already supports
  it).
- `studio.createDevSync(projectDir)` → `BuildSession` with per-apply
  settings freshness and instance-logger routing.
- `studio.runProjectDoctor(projectDir, { gameBuild })` — the option
  already exists; only the extension omits it.
- `studio.resolveModInfoTargets(modId, projectDir)` — explicit context,
  anchor-free.
- Project discovery: `findProjectDirs` / `findEnclosingProjectDir` /
  `resolveProjectDir` (`util/project.ts:111-216,323-360`) — the Active
  Project service builds directly on these.
- Mod operations: `modconfig include|devonly|exclude|set|unset`,
  `delete`/`rename` with host-confirmed `--yes`, `modinfo generate
  [--force]`, `add`, `lang` — all through the runner.
- Pure helpers on the api surface: `summarizeApplyResult`,
  `WATCH_DEBOUNCE_MS`, `isWatchPathIgnored`, `resolveWatchVariants`,
  `planBuild`, `collectIncludedModIds`, `runDoctor`,
  `matchBuildCompatibility`, `Diagnostic` types (`api.ts:31-71`).
- Existing commands (20), task provider (4 tasks), OutputChannel +
  `createPZLogger`, l10n two-layer system (25 locales), `jsonValidation`
  schema contribution, views container.
- Core public contract (for the UX-18 adapter): `loadProject` /
  `migrateProject` / `validateProject` / `saveProject`
  (`packages/core/src/project-contract.ts`).

### B. Extension-only behavior changes (no CLI/Core change)

- Active Project state-owner (CP-01) and switching UX (palette + rows).
- Cockpit TreeDataProvider with section ordering (CP-02/06/07/08).
- All R0 behavior fixes: UX-01, 02, 03, 04, 05, 06, 09 (achievable half),
  11, 13, 14, 16, 17.
- DevSync state owner (CP-04) built from real `start/apply/stop` data —
  no new engine API required for the v1 state set (§9).
- Health state-owner/cache (UX-07 minimal + R2 HealthService).
- Build state-owner (CP-05) from runner lifecycle observation.
- UX-18 validated snapshot via `@pzstudio/core` direct dependency +
  `vscode.workspace.fs` adapter (option a; Q5).
- Existing-mod **detection** (CP-09) — read-only `workspace.fs` probing.

### C. Capabilities not yet exposed (verified missing — not assumptions)

1. **Non-destructive existing-mod adoption plan/apply** (CP-10). Nothing
   in CLI/Core analyzes an existing mod folder, plans a project.json, or
   applies an adoption. Closest existing pieces: `scaffoldProject`
   (creates *new* projects only), `saveProject` (writes a config through
   a `ProjectFileSystem`), `loadProject` (validates). A real adoption
   capability (analyze → plan → preview → apply, fail-closed on existing
   files) must be built — recommendation in §12.
2. **Structured DevSync status events** (CP-12). `BuildSession` has no
   status accessor or events; v1 Cockpit states are derived
   extension-side from real `start/apply/stop` data (§9), so this is
   **deferred**, not required.
3. **Validated project snapshot on the api** (UX-18 option b) — only if
   Q5 resolves against the direct-core-dependency option.
4. **Web-safe modinfo probe** (UX-10 second half) — Track B.
5. **Reliable build-state reporting beyond process observation** — v1
   Build states are runner-observed (§11); a persistent freshness model
   ("Up to date") is explicitly **not** claimable and not planned (spec
   §7.3).

### Open questions (blockers or decisions)

- **Q1 (R4, product/architecture):** who writes `project.json` during
  adoption — a new Core/CLI adoption capability (recommended: pure
  planner in Core + `studio.adoptExistingMod(projectDir, {mode:
  'preview'|'apply'})` on the api) or an extension-only writer (creates
  a second project.json writer outside the CLI contract — the exact
  pattern UX-18 exists to remove). Data safety is the release gate either
  way.
- **Q2 (R0, small):** introduce `pzstudio.gameBuild` (string setting,
  empty = skip the compatibility check) to feed
  `ProjectDoctorOptions.gameBuild`?
- **Q3 (R0→R2):** how the extension obtains the session's effective
  outdir for `isWatchPathIgnored` without duplicating outdir-tier logic —
  minimal: filter dot-segments/outside-project now; full outdir
  exclusion when the DevSync state owner can source it honestly. If a
  one-line engine addition is ever preferred (e.g. expose the resolved
  plan input's outdir on `SessionApplyResult`), it is a **CLI API
  change** requiring its own decision — not smuggled into a UX fix.
  *(Resolved and shipped — see doc 13, the accepted Q3 contract
  (`studio.resolveOutDir` + the §6.3 policy, commit `8967ada`);
  residual safety windows and any further engine work are governed by
  doc 13 §15, not by this question.)*
- **Q4 (R0/R1):** semantics of "Remove from Project…" on a missing mod —
  today's `pzstudio delete` deletes the (absent) folder and errors or
  no-ops by CLI version; removing only the `project.json` entry has no
  CLI command (`modconfig` edits build state, not membership). v1 may
  ship Open project.json + Refresh only.
  **(Naming note — Q4 here keeps this missing-mod meaning. The DevSync
  baseline-safety work that also used the label "Q4" in doc 13 §14 is a
  different, unrelated item; its current name is the UX-09 DevSync
  Baseline Safety Contract, and its "Q4" labels are historical review
  identifiers. See doc 13 §15 for the disambiguation record.)**
- **Q5 (R1):** UX-18 wiring — extension adopts `@pzstudio/core` directly
  (recommended) vs. `studio.loadProject` added to the CLI api.
- **Q6 (carried from doc 11, OPEN QUESTION A1):** external consumers of
  the legacy facade — affects only deprecated-export removal, not the
  Cockpit.

---

## 5. Operation consistency across entry points

Entry points today: palette commands, explorer tree context/inline, VS
Code Tasks (the Cockpit joins in R1). Divergences verified at HEAD:

| Concern | Divergences today | Desired shared contract |
| :--- | :--- | :--- |
| Project resolution | Runner commands: active editor → single → picker. Tree rows: explicit node. Tasks: picker (no node context). Watch: picker only (no tree entry). Doctor: node → picker | **Active Project is the default context for every project-scoped operation**; an explicit row/tree context overrides it; the multi-project picker appears only when no Active Project can be established (or via an explicit "…" variant). Resolution lives in one service (CP-11), not per-handler. |
| Cancellation | build/clean double-prompt + false warning (UX-02); new-project fallback (UX-14); everything else aborts on first cancel | Cancel aborts everywhere exactly once, no side effects (spec §13). |
| Confirmation | build/clean: modal + `confirmBeforeRun` + Don't-Ask-Again (folder scope); delete/rename: modal + forwarded `--yes`; modinfo: conditional `--force`; tasks: none; watch: none | Keep: destructive deletion/rename always modal; build/clean honor `confirmBeforeRun`; tasks stay confirm-free (explicit intent — doc 05; spec §16 allows presentation differences, not semantic ones). New surfaces inherit the same helpers (`util/confirm.ts`). |
| Build-target semantics | Command: setting only. Tasks: setting flag **plus** task flag (UX-01). No explicit variant commands exist | Precedence: explicit target > configured target > engine default. One flag-assembly helper shared by command, Cockpit variants, and tasks (UX-01 fix generalizes). |
| Long-running lifecycle | Runner: notification progress + same-command guard. Tasks: terminal lines, no guard, queues on lock. Watch: no progress (UX-06), no persistent state (UX-15). Doctor: none | Commands keep transient progress; DevSync owns a persistent Cockpit state (R2); build owns a persistent state (R3); doctor/health shows "Checking…" row while running (R2). The engine lock queues silently — surfaced by CP-05, not by new engine behavior. |
| Error routing | Runner: `logger.error` → notification (+channel only verbose, UX-16). Tasks: terminal `failed:` line. Doctor: raw throw (UX-11) | One pipeline: `logger.error` (notification + Open Output action) for palette/Cockpit; task terminal additionally prints its status line; doctor never throws raw. |
| Refresh | Runner `onFinished` → explorer; task provider: none; direct fs edits: none (only `project.json` watcher) | The operation service (CP-11) emits typed events (`projectMutated`, `buildFinished`, `syncLifecycle`, `healthDirty`) consumed by the Cockpit and HealthService — replacing the implicit `onFinished` hook. |

The v2 instance solved **dependency ownership** (anchor races, cross-leet
settings/logger) but none of the above by itself — they are UX-layer
concerns and stay extension work.

---

## 6. Active Project and multi-root design (CP-01)

State owner: `ActiveProjectService` (`util/activeProject.ts`), created at
activation, holding `active: vscode.Uri | undefined`, an
`onDidChangeActiveProject` event, and the discovery cache from
`findProjectDirs()`.

- **Single project:** auto-selected on first discovery; no picker, no
  notification (spec §3.1).
- **Multi-project initial selection:** project of the active editor if it
  unambiguously resolves (`findEnclosingProjectDir`); else the persisted
  session selection (below); else the first discovered project (spec §3.2
  precedence). No auto-switch notification.
- **Explicit switching:** `PZ Studio: Switch Project…` (palette) and
  Other-Projects row commands. A **manual switch sets a session pin**:
  editor-follow is suspended for the rest of the session until the user
  re-enables it via `PZ Studio: Follow Active Editor` (or makes another
  manual switch). This is the oscillation guard the brief requires: the
  spec's precedence 1 (editor project) applies **only while follow mode
  is on** (the default for a fresh session); after any manual switch,
  precedence 2 (retained selection) wins until explicitly re-enabled.
- **Editor focus changes (follow mode):** switch only when the newly
  active editor's file lies inside a *different discovered project*;
  files outside every project never switch (spec §3.2).
- **Project removal (folder deleted / project.json deleted):** if active
  → re-resolve (editor project → first remaining); if none → empty-state
  welcome.
- **Newly discovered project:** appears under Other Projects; never
  auto-activates.
- **Workspace folder changes:** rescan; re-apply removal/initial rules.
- **Persistence:** workspaceState (`pzstudio.activeProject` fsPath,
  session-scoped semantics but survives reloads; invalid paths ignored) —
  justified: multi-root users should not re-pick after a window reload.
  Not synced, not global.
- **DevSync decoupling:** the owning project of a running sync is stored
  by the DevSync state owner, not derived from Active Project (spec
  §3.4). Cockpit Development section of a non-owning active project
  renders the foreign-owner row + `Switch Sync to This Project…` (spec
  §6.7 confirmation flow).
- **CLI interplay:** the studio instance needs **no factory
  `projectDir`** — every operation continues to pass explicit context
  (`ActiveProjectService.active ?? resolveProjectDir()`), preserving the
  v2 per-call contract (doc 09 §1 "No factory projectDir").

Acceptance tests: auto-select single; explicit switch updates sections
without running build/mutations; manual pin suppresses editor-follow;
follow mode switches on foreign-project editor; removal fallback; DevSync
ownership survives switches.

---

## 7. Development Sync state ownership (CP-04 / UX-15)

Owner: `DevSyncStateService` (evolves `util/devsync.ts`), one per window.

State (all extension-held):

```text
phase:        'stopped' | 'starting' | 'running' | 'syncing' | 'stopping'
owningProject: fsPath | undefined
lastSuccess:  timestamp | undefined        // last apply/start with errors.length === 0
lastFailure:  { message, at } | undefined  // last start failure or batch errors
lastBatch:    SessionApplyResult | undefined
```

Provenance discipline (real engine data vs. inference — the boundary the
brief demands):

| UI state | Source | Real data? |
| :--- | :--- | :--- |
| Stopped | controller has no session | yes |
| Starting | `start()` invoked, not yet resolved | yes (extension-observed) |
| Running / Up to date | `start()` resolved or last `apply()` returned `errors.length === 0` | yes — grounded in the last result; "Up to date" means *last known good*, never a freshness claim |
| Syncing (N files) | `apply()` in flight; N = batch size after coalescing | yes (extension-observed; not engine progress) |
| Needs attention | last `apply()` returned `errors.length > 0` and session alive (apply never throws, `buildsession.ts:388`) | yes |
| Fatal stopped | `start()` rejected → controller stops the half-start, phase `stopped`, `lastFailure` set | yes |
| Stopping | `stop()` invoked until watcher disposed + session drained | yes |

No structured progress events are assumed — none exist (§1). The one
inference the Cockpit must not make: per-file progress inside a batch
(the engine reports nothing between `apply` invocation and result).
Minimal API/data change required for v1: **none**. CP-12 (session status
events) remains deferred; if a later milestone wants engine-truth for
"queued/rebuilding" phases, that is a Core decision, not extension
guesswork.

Lifecycle invariants carried over: one session per window; start-while-
active requires the named stop/switch confirmation (spec §6.7); stop
failure blocks starting B; re-entrant start ignored while
`starting`/`active` (existing pins, `tests/unit/extUtilDevSync.test.ts`).

---

## 8. Project Health refresh design (UX-07 full / CP-03)

Owner: `HealthService` (`util/health.ts`) — the single caller of
`studio.runProjectDoctor` in the extension (doctor command, Cockpit
section, badges).

- **Cache:** `Map<fsPath, { summary, computedAt }>` keyed by project;
  entries only for projects that have been *shown* (active project or an
  expanded Other-Projects row) — no background scanning of unopened
  projects (multi-root cost bound).
- **Invalidation triggers (refresh scheduled, debounced 500 ms like the
  tree):** Active Project change; `project.json` change/create/delete
  (existing watcher); Add/Delete/Rename Mod; modconfig writes; modinfo
  generation; build completion; DevSync start success/failure; explicit
  `PZ Studio: Check Project Health` / section Refresh. **Not** on tree
  expansion, `getChildren`, arbitrary saves, sync batches, or repaints
  (spec §8.5 — the existing per-render call is exactly the anti-pattern
  being removed).
- **Stale-while-revalidate:** a previous result stays displayed while a
  refresh runs (spec §8.6); first-ever computation shows "Checking…"
  row.
- **Deduplication:** one in-flight promise per project; new triggers
  during a run coalesce into a single follow-up run.
- **Dispose:** clear timers, drop cache; an in-flight doctor run
  completes (the engine has no cancellation; it is read-only).
- **gameBuild:** forwarded per Q2; a setting change invalidates the
  active project's entry.
- Failure handling: engine error → cached "Health unavailable" state +
  `logger.error` routing (never a raw throw — UX-11 fix applies here).

Acceptance: badge values equal a fresh doctor run; no doctor call during
pure expansion/collapse; N rapid triggers → 1 (+1 trailing) run per
project; switch away and back uses the cache.

---

## 9. Cockpit information architecture (CP-02)

Concrete TreeView realization of spec §2 (single view
`pzstudio.projectExplorer` retained; new provider, manifest menu updates):

```text
Root children:
  [project header node]        label = project name; description = "N mods · <target>";
                               tooltip = markdown aggregate; contextValue 'cockpit-project'
  ▼ Mods (header node, description = count)   contextValue 'cockpit-mods'
      mod rows                 contextValue mod-included|mod-devonly|mod-excluded|mod-missing
                                description = state text (§5.2 spec); commands per §2 constraints
  ▼ Development (header node)  contextValue 'cockpit-dev'
      sync status row          label = "Development Sync"; description = phase;
                                child rows: variants ("Main + Development"), "Last sync: …",
                                foreign-owner note; commands: Start/Stop/Restart/Show Output/…
  ▼ Build (header node)        contextValue 'cockpit-build'
      target row               label = effective target ("Production" / "Production + Development");
                                description = Ready|Building…|Completed|Failed; command = Build
  ▼ Project Health (header)    contextValue 'cockpit-health'
      status row + diagnostic rows (label = message, description = [module] code,
                                command = code-derived action only where deterministic, §8.4 spec)
  ▸ Project Files              collapsed by default; existing directory/file rendering
OTHER PROJECTS (header node)   contextValue 'cockpit-others'
  other project rows           description = "⚠ N issues" (cached health, lazily computed);
                                command = switch project
```

Empty workspace: provider returns `[]`; `viewsWelcome` variants render
Create New Project / (when detected, context-key gated) Set Up Existing
Mod (CP-08). Command palette gains `Switch Project…`, `Start/Stop
Development Sync` (split from the toggle), `Check Project Health`, `Show
Output`, `Build Production/Development/Both` (spec §15); `pzstudio.watch`
toggle stays for compatibility. All new user-visible strings go through
both l10n layers (manifest NLS keys + runtime `t()` bundles, 25 locales —
key-parity tests exist and must cover additions).

---

## 10. Existing-mod adoption feasibility (CP-09/CP-10)

Verified ground truth: **no CLI/Core capability analyzes, previews, or
adopts an existing mod.** `pzstudio new` scaffolds into an empty
destination (`scaffoldProject`); nothing else writes `project.json`
except `saveProject` (core, fs-injected) and the CLI's own
config-mutating commands.

- **Recognizable existing mod (strong signal — notification-worthy):**
  folder (workspace root or depth-1, matching discovery) with **no**
  `project.json` containing (a) `mod.info` at root or inside exactly-one
  named branch subfolder (the 42 layout `<mod>/<42>/mod.info`), and (b)
  the branch carries `media/` or the folder carries `poster.png`/`icon.png`.
  **Weak signal (no notification):** PZ-ish folder names only, or
  multiple ambiguous branch roots. Detection is read-only
  `workspace.fs` — web-safe, conservative per spec §11.3.
- **Detection owner:** extension-only (`util/existingModDetect.ts`), run
  on activation + workspace-folder changes, one-time notification per
  workspace (workspaceState flag), Cockpit CTA persists (spec §11.2).
- **Analyze/Preview:** enumerate detected facts (mod.info id/name fields,
  branch layout, media presence) and the exact files PZ Studio would
  create: `project.json` (mods entry, schemaVersion stamped),
  `workshop/description.txt` (if absent). Preview must render file
  contents before confirmation (spec §12).
- **Mutation plan / collisions:** create-only. If any target file exists
  → it is disclosed in the preview (merge decision explicit) or the flow
  aborts; **existing mod files are never moved or overwritten** — release
  gate. A folder that already has `project.json` is by definition not an
  adoption target (it is a managed project).
- **Who writes:** see Q1. Recommendation: a pure adoption planner +
  applier in Core (fs-injected, fail-closed) exposed as
  `studio.adoptExistingMod(projectDir, { mode })` in R4, because an
  extension-only writer would duplicate validation/normalization and
  create the second writer UX-18 is eliminating. The interim extension
  path (`saveProject` through the same adapter as UX-18) is viable but
  carries the schema-drift risk the contract exists to prevent — decide
  before R4 implementation, do not start from the fallback silently.
- **After setup:** scheduled Health refresh + Development Sync CTA
  (spec §12 stage list) — both are existing capabilities.

---

## 11. Delivery milestones

Sequence is dependency-driven; each milestone is independently
reviewable and ships value. "CLI/Core" column answers whether engine
changes are required.

### UX-R0 — Correctness (extension-only; CLI/Core: **no**)

Scope: UX-01 (target override), UX-02 (cancel abort), UX-03 (project-less
update), UX-04 (verbose logger), UX-05 (per-folder settings), UX-06
(progress + single error), UX-09 (achievable pre-filter), UX-11 (gameBuild
forwarding + error wrap, pending Q2), UX-13 (narrow missing-mod menu,
pending Q4), UX-14 (cancel aborts — spec decision; pinned test updated),
UX-16 (Open Output action), UX-17 (localized titles), UX-12 (README
refresh), plus the minimal UX-07 badge cache.
Prerequisites: none. STOP boundary: no Cockpit UI, no manifest view
changes beyond menu matchers, no new services beyond the badge cache.
Acceptance: per-finding regression tests listed in §3; full `pnpm test`
green.

### UX-R1 — Cockpit Foundation (extension-only; CLI/Core: **no** — Q5 picks the UX-18 wiring)

Scope: CP-01 ActiveProjectService; CP-11 operation service (events,
shared resolution/cancellation contract); CP-02 cockpit provider
(Header/Mods/Project Files/Other Projects sections); CP-08 welcome
content; UX-18 validated snapshot; `Switch Project…` palette command;
manifest menus/contextValues for the new rows.
Prerequisites: R0 (especially UX-13 matchers — the Cockpit redefines
contextValues once, not twice).
STOP boundary: Development/Build/Health sections render **statically
honest placeholders** ("Stopped", target from setting, health from the
R0 cache) — no new state owners yet; no adoption work.
Acceptance: section order fixed; single-project auto-select; switch does
not run build or mutate files; other-projects row click switches;
validated-read placeholder row for broken/newer project.json.

### UX-R2 — Development + Health (extension-only; CLI/Core: **no**)

Scope: CP-04 DevSyncStateService (+ UX-15 named ownership, switch
confirmation, `Start/Stop` split commands); CP-03 header aggregate
precedence; HealthService (§8) replacing the R0 cache; Cockpit
Development + Health sections live.
Prerequisites: R1 (sections + operation events).
STOP boundary: no engine changes; no per-file sync progress claims; no
background health scanning.
Acceptance: §7 provenance table rendered as states; spec §6.1–6.7 flows
incl. 6.7 confirmation; §8 refresh policy tests.

### UX-R3 — Build (extension-only; CLI/Core: **no**)

Scope: CP-05 build state-owner; Cockpit Build section (configured target
primary, explicit variant commands `Build Production/Development/Both`,
Clean secondary); task/variant parity through the shared flag helper
(UX-01 generalized); queued/Building visibility (UX-08 residual).
Prerequisites: R1; benefits from R2's state patterns but no hard
dependency — may parallel R2 if review capacity allows.
STOP boundary: no freshness claims ("Up to date" forbidden); no engine
build API.
Acceptance: variant overrides configured target; states
Ready/Building/Completed/Failed observable; tasks and Cockpit agree on
semantics.

### UX-R4 — Acquisition (extension + **CLI/Core decision Q1**)

Scope: CP-09 detection + notification; CP-10 adoption (per Q1); Cockpit
CTA wiring; Set Up flow (Analyze→Preview→Confirm→Set Up→Health
Check→Sync CTA).
Prerequisites: R1 (welcome/CTA shell); R2 (health + sync CTA targets).
STOP boundary: adoption ships only with the non-destructive gate (§10):
create-only writes, explicit disclosure of any existing-file collision,
preview before confirmation.
Acceptance: detection matrix (strong/weak); preview lists exact writes;
apply creates only the disclosed files; health + sync CTA appear after
first success.

Recommended adjustment to the brief's default ordering: none — the R0 →
R1 → R2 → R3/R4 order reflects the real dependency chain (state owners
need the sections and event bus first; R3 can overlap R2).

---

## 12. Required risk analysis

- **Multi-root project context resolution** — Active Project must never
  guess: editor-follow only for unambiguous containment; explicit pick
  otherwise. Risk: silent wrong-project writes. Mitigation: the confirm
  modals already name the project; Cockpit header always names the
  active project; per-call explicit `projectDir` contract unchanged.
- **Active Project vs DevSync owning project** — a switch while syncing
  must not touch the session (spec §3.4). Mitigation: ownership stored in
  the DevSync state owner; header/section renders the foreign-owner row;
  switch confirmation required to move the session (§6.7).
- **Expensive tree/Doctor refresh loops** — the current per-render
  doctor run (UX-07) is the cautionary tale. Mitigation: HealthService
  cache + trigger list (§8); Other-Projects health computed lazily and
  cached; budget: zero doctor runs per getChildren.
- **Unreliable status inference** — Development/Build states are
  extension-observed. Mitigation: the provenance tables (§7, §11-R3)
  pin every state to a real event; no state is displayed that has no
  observed source; unknown → show the last known real state.
- **Cancellation side effects** — stop A/start B ordering (watcher
  disposed, session drained before B's start); confirm-cancel must not
  leave half-started sessions (existing `stop()`-on-failure path already
  does this — keep the pin). Mitigation: R2 acceptance test for the
  failed-stop path.
- **Concurrent operations despite the serialized engine** — engine runs
  queue, but DevSync/doctor are lock-free by design and filesystem
  collisions (two writers to one outdir) remain possible exactly as
  pre-v2 (doc 11 §9). Mitigation: do not add concurrency beyond today's
  shapes; the Build state-owner treats "sync writing" and "build
  running" as distinct states and the confirm modals warn about the game
  holding outputs.
- **Non-destructive setup** — adoption is a release gate (§10):
  create-only, disclosed collisions, fail-closed planner, tests that
  assert no pre-existing file is modified or moved.
- **Localization of new UI strings** — every Cockpit string must land in
  `package.nls.json` + runtime bundles; the key-parity suites (25
  locales) are the gate; spec wording ("Development Sync", "Up to date")
  is en-source and must be `t()`-wrapped, never hardcoded.
- **Accessibility / keyboard** — all actions exist as commands (context
  menus + palette); no state change on pointer-only affordances; state
  text is not color-only (spec §5.2). Inline buttons remain supplementary.
- **Compatibility with palette/tasks users** — existing command ids stay
  (`pzstudio.watch` keeps toggle semantics; new split commands are
  additive); task definitions unchanged in shape; the runner contract
  (guard strings aside, UX-17) is preserved.
- **Web-readiness boundaries** — remaining Node usage in the extension:
  `modinfo.ts` `existsSync` (UX-10 half, deferred) and nothing else on
  the hot path (util/project, providers, l10n are `workspace.fs`-based;
  DevSync's NodeFileSystem lives inside the CLI, behind the instance).
  Cockpit additions must keep using `workspace.fs` only; the engine
  stays Node until Track B (doc 11 §15) — do not over-engineer a web host
  that v1 does not ship.
- **Scope risk: the tree rewrite** — CP-02 is the largest single change.
  Mitigation: R1 keeps current contextValue shapes for mods
  (`mod-<state>`) and ports the existing provider incrementally (section
  provider delegating to existing node builders) rather than a big-bang
  rewrite; every R0 fix lands before the rewrite so it is not done
  twice.

---

## 13. Validation checklist (this document)

- [x] UX-01…UX-18 addressed individually (§3), with statuses that
  distinguish migration-fixed (UX-08, UX-10-half) from open.
- [x] Every locked Cockpit decision reflected (§§5–11; deviations: none —
  UX-14 resolves *toward* the spec).
- [x] No pre-v2 architectural claim presented as current (§1 states the
  post-v2 wiring; docs 00–08 pre-v2 passages not carried over).
- [x] Referenced source paths exist at HEAD `f83704c` (verified during
  the audit; see the file list below).
- [x] Every proposed API capability classified existing/missing (§4 A/B/C).
- [x] Milestones dependency-consistent (§11).
- [x] No production/test source changed by this document (docs-only
  commit; `git status` verified before commit).

Source files referenced (all verified present at HEAD):
`packages/vscode-extension/src/{extension.ts, commands/*.ts,
providers/*.ts, util/*.ts}`, `packages/vscode-extension/package.json`,
`packages/cli/src/{api.ts, lib/{studio.ts, devsync.ts, doctor.ts,
watch-shared.ts, helper.ts, logger.ts, transport.ts, invocation.ts,
commands/{build.ts, update.ts, watch.ts}}}`, `packages/core/src/{buildsession.ts,
project-contract.ts, doctor.ts}`, `tests/unit/{ext*, buildTaskProvider,
projectExplorer, cliStudio*}.test.ts`.

---

## 14. UX-09 scope reconciliation addendum (governance pass, 2026-10-12)

Documentation-only reconciliation at HEAD `80c80fe` (tree clean): this
section records where the DevSync baseline-safety proposal stands
relative to the milestones this matrix froze. The authoritative,
complete record is doc 13 §15
([`13-devsync-outdir-api-contract.md`](13-devsync-outdir-api-contract.md)
"UX-09 scope reconciliation and approval record"); this section carries
only what a matrix reader needs. No production source, test, manifest
or dependency change belongs to it, and nothing here authorizes
implementation.

**What happened to UX-09 (status of record).** The original UX-09
remediation was extension-only and is **shipped** (`8967ada`): the
accepted Q3 decision — `studio.resolveOutDir` + the doc 13 §6.3
refresh-triggered re-resolution policy — with the Q3 §10 acceptance
matrices. UX-R0's extension-only boundary therefore held and is
exhausted for this finding. After the ship, red-first regression tests
(retained in the UX-09 stash, read-only) **proved** that §6.3's
residual windows are silent source-event losses. The response is the
**UX-09 DevSync Baseline Safety Contract** (doc 13 §14; historical
label "Q4 DevSync" — unrelated to this matrix's Q4, which keeps the
missing-mod meaning, see §4 above).

**Dependency graph.**

```text
UX-R0 / UX-09
  ├─ Extension pre-filtering .................. shipped (8967ada)
  ├─ Accepted/shipped Q3 effective-outdir work   (resolveOutDir + §10 tests)
  └─ Proposed DevSync safety prerequisites ..... doc 13 §14 — NOT approved
       ├─ Core/API decisions ................ C1 getter; Contract B territory
       ├─ Independent engine correctness fixes   C6, C11
       └─ Host reliability enhancements ..... C7/C12 retry package, C10

UX-R2
  └─ Cockpit Development Sync state owner/UI .. CP-04; persistent
                                              resyncRequired UI; CP-12
```

**What this means for the milestones.**

- **UX-R0** keeps exactly its original boundary (§11 above). The
  cross-package prerequisites (C1/C6/C11/C12 in Core, C7's CLI guard)
  are **exceptions requiring their own approvals** — doc 13 §15 marks
  each `APPROVAL_REQUIRED`/`PROPOSED` with its decision ID (DX-1…DX-12)
  — and none may ride a UX-09 or UX-R0 commit. Two of them (C6, C11)
  are verified standalone Core correctness defects
  (`buildsession.ts:519` escaping `apply()`'s never-throws contract;
  the scoped path committing an incomplete output root with zero
  errors) and are recommended as independent engineering work.
- **UX-R2** owns the persistent Development Sync state (CP-04) and any
  user-visible presentation of a degraded/resync-required condition.
  Until R2, the minimum current-host contract is `logger.error`
  routing (the existing notification path) with recovery text — an
  internal controller flag alone is not observability (doc 13 §15.7).
- **Contract B** (decision-time committed-output territory — the
  relaxation of the strict "every source mutation is delivered or
  incorporated" invariant) is a **product decision, not approved**;
  owner approval is pending. S1-original remains the acceptance
  baseline of record; no document may silently rewrite it.
- **The UX-09 stash** stays untouched as read-only regression evidence
  (A1/B1/C1 silent source-event loss, proven at `8967ada`); applying
  it as tests is gated on the contract decision, with the doc 13
  §14.15 mechanics evolution.

Decision IDs and the full approval table: doc 13 §15.8. Nothing in
this addendum changes any other row of the matrix, the Q3 decision
record, or the milestone ordering.
