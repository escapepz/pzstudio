# 10 — UI/UX Audit Findings

Findings recorded while writing this documentation set. **Nothing here has
been fixed** — per the mid-turn rule, discoveries outside the current task's
contract are recorded, not patched. Severities: `high` = broken workflow for
real users; `medium` = wrong/confusing behavior in common scenarios; `low` =
polish, debt or documentation.

Format per finding: observed behavior → code path → why it matters →
classification → suggested direction → scope.

---

## UX-01 — Task target conflicts with `pzstudio.build.target` (broken tasks)

**Observed behavior:** running the task `pzstudio: build (development)`
while the setting `pzstudio.build.target` is `production` (or any other
concrete target ≠ task target) fails with
`Conflicting options: --development cannot be combined with --production.`
The task terminal prints `pzstudio build failed: …` and an error
notification appears. When both values agree the flag is merely duplicated
and passes.

**Code path:**
- `packages/vscode-extension/src/util/flags.ts:27-36` — `resolveFlags('build')` appends the setting's flag
- `packages/vscode-extension/src/providers/buildTaskProvider.ts:51-58` — the task appends its own target flag **on top of** `resolveFlags`
- `packages/cli/src/lib/parser.ts:473-486` — shared conflict validation (hardening `b2f26e8` moved it into `validateInvocation`, used by both hosts)
- `packages/cli/src/lib/commands/build.ts:206-208` — conflicts declared per flag

**Why it matters:** the task provider was written before conflicts were
enforced in the shared validator; since the hardening it produces broken
invocations whenever the user sets a target and then picks a *different*
task target — arguably the main scenario for having 4 tasks.

**Classification:** bug (regression surface of the CLI hardening inside ext code).

**Suggested direction:** the task target should **override** the setting —
e.g. `resolveFlags` accepts an explicit target for build and skips the
setting flag when one is given (or the task provider filters the setting
flag out before appending its own). Extension-only fix; no CLI change.

**Scope:** MVP ext candidate (small, user-visible bug).

---

## UX-02 — Cancelling the project picker in build/clean re-prompts, then lies

**Observed behavior:** invoking *PZ Studio: Build* from the palette in a
multi-project workspace and pressing `Esc` shows the project picker **a
second time**; cancelling that too produces the warning
*"no PZ project (project.json) found in this workspace — nothing to build"*
even though projects exist.

**Code path:**
- `packages/vscode-extension/src/commands/build.ts:14-16` — resolves the project for the confirm step; cancel → `undefined`
- `build.ts:34` (same in `clean.ts:14-34`) — passes `projectDir: dir?.fsPath` (undefined) into the runner
- `packages/vscode-extension/src/util/execute.ts:40-52` — the runner resolves **again** because no explicit projectDir arrived
- `packages/vscode-extension/src/util/project.ts:57-64` — `warnNoProject` after the second cancel

**Why it matters:** "cancel" must abort a command; here it costs two
cancels and ends in a factually wrong message. Other commands (`add`,
`delete`, `watch`, doctor) abort correctly on the first cancel.

**Classification:** bug / UX inconsistency.

**Suggested direction:** treat `resolveProjectDir() === undefined` in
build/clean as abort (mirror `add.ts:12-16`), passing the picked dir only
when truthy — or return a "cancelled" sentinel distinct from "no project".

**Scope:** MVP ext candidate (small).

---

## UX-03 — `PZStudio: Update` requires a project although the CLI operation is global

**Observed behavior:** running *PZ Studio: Update* in a workspace without a
PZ project yields *"no PZ project … nothing to update"*. The CLI's `update`
only refreshes global template caches and works fine project-less. This is
a **handler-level** gate in the generic runner, independent of activation
semantics — on modern VS Code the extension also activates on demand in
project-less workspaces (see `01-activation-and-architecture.md`), the
command just stops at project resolution.

**Code path:**
- `packages/vscode-extension/src/commands/update.ts:4-10` — `execute('update')` via the generic runner
- `packages/vscode-extension/src/util/execute.ts:44-52` — the runner always resolves a project and warns when none
- `packages/cli/src/lib/commands/update.ts:25-59` — `updateCmd` never calls `projectDir()`

**Why it matters:** template refresh is exactly what a user with a fresh
machine (and possibly an empty workspace) needs; the gate blocks it for a
reason that does not exist in the engine.

**Classification:** inconsistency.

**Suggested direction:** call `runCLI('update', [], { flags })` directly
(without project resolution) from the update command, mirroring how
watch/doctor already bypass the runner.

**Scope:** MVP ext candidate (small).

---

## UX-04 — `--verbose` diagnostic output never reaches the OutputChannel

**Observed behavior:** with `pzstudio.verbose` enabled, commands show the
OutputChannel but the CLI's verbose (`[DEBUG]`) lines — e.g.
`Project Dir: …`, target/flag decisions — are not in it. They are written to
the extension host's `process.stderr` (visible only in *Developer: Toggle
Developer Tools*).

**Code path:**
- `packages/vscode-extension/src/util/logger.ts:16-41` — `createPZLogger` implements `log/info/warn/error/clear` but **not** `verbose`
- `packages/cli/src/lib/logger.ts:151-163` — `verbose()` falls back to `emit('stderr', …)` when the external logger has no `verbose`
- `packages/vscode-extension/src/util/execute.ts:73-75` — the runner shows the channel precisely when `--verbose` is set

**Why it matters:** the setting's promise ("Enable verbose/diagnostic output
for all commands") is only half-kept; the diagnostic lines are the ones
users need when something misbehaves.

**Classification:** bug (incomplete bridge implementation).

**Suggested direction:** implement `verbose(msg)` in `createPZLogger` (e.g.
`[<timestamp>] [DEBUG] <msg>` lines in the channel).

**Scope:** MVP ext candidate (tiny).

---

## UX-05 — Resource-scoped settings ignore folder-level values

**Observed behavior:** in a multi-root workspace, per-folder values of
`pzstudio.outdir`, `pzstudio.templates.*` (and any flag-read setting)
declared in a folder's `.vscode/settings.json` are silently ignored; only
the workspace-level and user-level values are bridged to the CLI.

**Code path:**
- `packages/vscode-extension/src/util/settings.ts:6-7,26-34` — reads `inspect().workspaceValue` / `globalValue` only
- `util/flags.ts` uses `config.get()` without a resource for the flag settings
- `package.json:192-332` — all bridged settings are declared `scope: "resource"`
- `packages/cli/src/lib/helper.ts:93-123` — merge is per-category (templates) / per-field (outdir, useSymlinks)

**Why it matters:** the manifest invites per-folder configuration that does
not work; multi-root users get silently wrong templates/outdir.

**Classification:** bug / debt (documented limitation at minimum).

**Suggested direction:** either document "workspace/user only" in the
setting descriptions now, and later resolve per folder at invocation time
(needs the per-command project dir to pick the right folder — natural fit
for API v2 where settings resolution is a host callback).

**Scope:** document now; proper fix = MVP ext / Track B candidate.

---

## UX-06 — Development Sync start: no progress, failure double-reports

**Observed behavior:** toggling sync on runs the initial **full build of
both outputs** with no progress UI (the palette appears dead on large
projects). If start fails, the channel gets `[WARN] …` **and** the
uncaught rejection surfaces as a second, generic host error toast.

**Code path:**
- `packages/vscode-extension/src/commands/watch.ts:30` — `await controller.start(...)` with no `withProgress` and no `catch`
- `packages/vscode-extension/src/util/devsync.ts:53-58` — catch logs `warn(...)` and **rethrows**

**Why it matters:** the first impression of the flagship feature (the 28/09
direction's priority 1) is a silent freeze or a duplicated error.

**Classification:** polish / UX inconsistency.

**Suggested direction:** wrap start in `withProgress` (title = project
name), catch the rethrow in the command and show one friendly notification.

**Scope:** MVP ext candidate.

---

## UX-07 — Explorer runs full doctor for every project on every rescan

**Observed behavior:** each root-level tree render executes
`runProjectDoctor` once per discovered project — reading config, resolving
outdir, probing the template cache and walking the project tree. This
happens on every debounced refresh (500 ms coalesced), every
`project.json` change, and after **every** command run (the runner's
`onFinished` hook).

**Code path:**
- `packages/vscode-extension/src/providers/projectExplorer.ts:431` — `await this.projectDiagnostics(dir)` inside `getProjectNodes`
- `packages/vscode-extension/src/util/doctor.ts:20-32` — full engine run
- `packages/cli/src/lib/doctor.ts:32-74` — gatherer (fs walks included)

**Why it matters:** in a workspace with many/large projects every file save
that touches `project.json` (or every command) triggers N full diagnostics
sweeps; the badge is decoration, the cost is real.

**Classification:** debt (performance).

**Suggested direction:** cache the summary per project until its
`project.json` mtime changes, or make the badge opt-in/explicitly
refreshable; alternatively compute badge counts from a cheaper source.

**Scope:** MVP ext candidate (bounded cache) / backlog.

---

## UX-08 — Concurrency: per-command guard only; tasks bypass it; global anchor shared

**Observed behavior:** the runner refuses only a **repeat of the same
command** (`build` while `build` runs). Different commands can overlap
(`build` + `clean`, or `modconfig` during a build), the task provider has
**no guard at all**, and every path writes the same CLI module state
(`setProjectDir`, settings, logger) — the state that `runCLI`'s
non-reentrancy comment warns about.

**Code path:**
- `packages/vscode-extension/src/util/execute.ts:26-37` — `busyCommands` keyed by command id, with the "runCLI is not reentrant" comment
- `packages/vscode-extension/src/providers/buildTaskProvider.ts:37-71` — direct `setProjectDir` + `runCLI`, no guard
- `packages/cli/src/lib/helper.ts:173-208` — the global anchor being raced

**Why it matters:** overlapping invocations can anchor the wrong project for
a mid-flight command (e.g. task starts while a palette `modconfig` is
between resolution and execution) — silent wrong-target writes.

**Classification:** debt / API-boundary (the structural case for API v2).

**Suggested direction:** short term — one shared mutex (command id agnostic)
covering runner and task provider. Structural — `createPzStudio(...)`
instances with their own anchor/logger/settings; the anchor rows in
[`02-project-and-mod-resolution.md`](02-project-and-mod-resolution.md) are
the migration checklist.

**Scope:** mutex = MVP ext candidate; instance model = the API v2 milestone itself.

---

## UX-09 — DevSync feeds unfiltered events; `isWatchPathIgnored` unused

**Observed behavior:** the CLI's watch filters watcher events through
`isWatchPathIgnored` (outdir, dot segments) before the session; the
extension feeds **every** event under the project into `session.apply` and
relies on core classification to ignore the noise. Core classification has
no outdir rule — output written **inside a mod folder** would feed the
engine its own writes (pathological config, but a loop); outdir elsewhere is
merely wasted work per event.

**Code path:**
- `packages/vscode-extension/src/util/devsync.ts:44-49,83-95` — no filtering
- `packages/cli/src/lib/commands/watch.ts:120` — the CLI's pre-filter
- `packages/cli/src/lib/watch-shared.ts:36-57` + `api.ts:47-51` — helper exported for exactly this purpose, unused
- `packages/core/src/buildsession.ts:129-219` — classification covers dot entries/non-mod/excluded but not outdir

**Why it matters:** consistency between hosts (the stated reason for
adopting the shared helper) and a cheap guard against self-feeding sync.

**Classification:** inconsistency / debt.

**Suggested direction:** call `isWatchPathIgnored(projectDir, outDir,
path)` in `DevSyncController.schedule` (outDir from the session's plan
input or `getOutDir`).

**Scope:** MVP ext candidate (small).

---

## UX-10 — `modinfo` command touches the global anchor and Node `fs` directly

**Observed behavior:** before running, the modinfo command sets the CLI's
global project anchor itself and uses Node's `existsSync` to probe branch
mod.info files — outside the runner, leaving the anchor set afterwards.

**Code path:**
- `packages/vscode-extension/src/commands/modinfo.ts:30-33` — `setProjectDir(...)` + `resolveModInfoTargets(modId)` + `existsSync`

**Why it matters:** it is the only command that manipulates bridge state
directly in handler code (everything else goes through the runner/task
provider), and it hard-depends on Node `fs` — a web-host blocker to remove
later. Anchor persistence is benign today (every command re-anchors) but is
exactly the pattern API v2 removes.

**Classification:** API-boundary debt.

**Suggested direction:** an api helper taking an explicit project dir
(e.g. `resolveModInfoTargets(projectDir, modId)`), or move the probe behind
a `workspace.fs`-based utility.

**Scope:** API v2 / Track B item.

---

## UX-11 — Doctor command lacks `gameBuild`; engine errors surface raw

**Observed behavior:** the extension never passes the `gameBuild` option,
so the `pzBuildCompatibility` check is silently absent from both the
quick-pick and the explorer badge (the CLI gets it via `--game-build`).
Additionally, an exception from the diagnostics path propagates out of the
command handler as a generic host error.

**Code path:**
- `packages/vscode-extension/src/util/doctor.ts:23` — `runProjectDoctor(projectDir.fsPath)` with no options
- `packages/cli/src/lib/doctor.ts:19-25` — the `gameBuild` option that enables the check
- `packages/vscode-extension/src/commands/doctor.ts:35-36` — no try/catch around the diagnostics call

**Why it matters:** the compatibility warning is one of doctor's advertised
checks; users comparing CLI and extension output see different findings with
no explanation.

**Classification:** feature gap + polish.

**Suggested direction:** optional `pzstudio.gameBuild` setting (or detect
later) forwarded to `runProjectDoctor`; catch and notification-wrap engine
failures.

**Scope:** backlog (needs a small settings decision).

---

## UX-12 — README drift (extension `README.md`)

**Observed behavior:** several README claims no longer match the code.

**Code path / claims vs reality:**
- `README.md:18` — *"Clean execution: Automatic log clearing at the start of
  command execution"* — **false**: nothing calls the logger's `clear()` (no
  CLI command calls it since CLI-2; the extension never does). The bridge
  implements `clear()` but it is dead code ([`09`](09-embedded-cli-bridge.md)).
- `README.md:55-68` (Configuration table) — **missing 5 existing settings**:
  `pzstudio.verbose`, `pzstudio.offline`, `pzstudio.forceUpdate`,
  `pzstudio.build.target`, `pzstudio.confirmBeforeRun`.
- No mention of the **task provider** (4 `pzstudio` tasks, default build
  task support) anywhere in the README.
- `README.md:3` — version badge still `2.242170.0` (package is `0.42200.0`).
- `README.md:104-107` — *"Node.js: Required to run the underlying engine"* —
  misleading (the engine is bundled in-process; the extension host provides
  Node). *"Git: Required for cloning documentation and libraries"* — Git is
  the default transport but fetch is the automatic fallback when git is
  absent.
- `packages/vscode-extension/CHANGELOG.md` — stale since
  `2.242170.0-nightly-2` (known, tracked in the roadmap as a separate task).

**Classification:** docs drift.

**Suggested direction:** one README refresh commit (settings table, tasks
section, remove the auto-clear claim, fix requirements, bump badge), done
together with — or before — the next extension release.

**Scope:** docs-only MVP ext candidate.

---

## UX-13 — Missing mods have full context menus but no inline buttons

**Observed behavior:** a mod declared in `project.json` but absent on disk
renders as `mod-missing` and gets **Edit Mod Configuration / ModInfo
Generate / Rename / Delete** in its context menu (the `^mod/` matcher), but
none of the inline state buttons (which require a concrete state).

**Code path:**
- `packages/vscode-extension/src/providers/projectExplorer.ts:524-537` — missing-mod nodes
- `packages/vscode-extension/src/providers/projectExplorer.ts:374-382` — `contextValue: 'mod-missing'`
- `package.json:108-126` — context menu entries match `viewItem =~ /^mod/`

**Why it matters:** configuring/renaming/deleting a mod that does not exist
on disk mostly produces CLI errors (or, for rename, renames a config entry
whose folder is missing). The UI implies these operations are meaningful.

**Classification:** inconsistency / polish.

**Suggested direction:** either narrow the context menu to
`^mod-(included|devonly|excluded)` and offer only Delete for missing mods,
or make Delete-on-missing the one-tap "remove stale entry" flow.

**Scope:** MVP ext polish / backlog.

---

## UX-14 — New Project: cancelling the folder picker silently continues

**Observed behavior:** pressing `Esc` in the New Project destination picker
does **not** abort — the flow falls back to the default destination and
continues to the title prompt. Only cancelling the **title** input aborts.

**Code path:**
- `packages/vscode-extension/src/commands/new.ts:45-51` — cancel → `defaultUri?.fsPath`
- pinned as intended by `tests/unit/extCommandsNew.test.ts` ("uses
  pzstudio.newProject.defaultLocation as the picker default and cancel
  fallback")

**Why it matters:** `Esc` conventionally means "stop"; creating a project
in an unexpected default folder (e.g. last-used location) after an explicit
cancel is a surprise. Deliberate design (issue #43 spec) — recorded so the
next UX pass decides consciously.

**Classification:** UX surprise (intentional, test-pinned).

**Suggested direction:** keep the fallback for *empty default* cases but
treat an explicit dialog cancel as abort when a default destination existed
— or at least phrase the title prompt to show where the project will land.

**Scope:** backlog (needs a UX decision).

**Status annotation (added with the UX-14 docs/l10n patch):** the finding
above records the historical issue #43 behavior at the documentation-set
baseline (`f83704c`: cancel → `defaultUri?.fsPath`, destination recorded at
pick time, pinned by the then-current "cancel fallback" test). UX-14
remediation implemented in R1.2-P source (branch `42.20.0-dev`, patch on
top of `e539b72`); installed-VSIX interactive acceptance pending R1.3. The
picker's resolved default is now only the initial location: cancelling
aborts silently — no fallback destination, no further prompt, no engine
call — and the destination is remembered only after an apparently
successful creation (A13 best-effort heuristic, not a transactional engine
receipt). This annotation records status; the original finding above is
retained as the historical baseline and is not rewritten.

---

## UX-15 — Development Sync toggle is global and does not name the running project

**Observed behavior:** one controller serves the whole window. If sync is
active for project A, invoking the toggle — from any context — stops it;
the start message names the project, the stopped state does not, and there
is no indication (status bar/badge) that sync is running.

**Code path:**
- `packages/vscode-extension/src/commands/watch.ts:16-22` — `controller.active` → stop
- `packages/vscode-extension/src/extension.ts:58` — single `DevSyncController`

**Why it matters:** multi-root users cannot run two syncs, and after
returning to the window there is no visible hint that outputs are being
rewritten in the background.

**Classification:** debt / feature gap.

**Suggested direction:** track the active project in the controller; refuse
or swap with a named message; surface activity (tree badge or status bar
item — status bar was deliberately dropped in v0.4, so a tree/badge
solution fits the current design).

**Scope:** backlog.

---

## UX-16 — OutputChannel never opens on errors

**Observed behavior:** failures show a one-line error notification; the
`PZ Studio` channel (with the full Problem/Cause/Try detail and progress)
only opens when `--verbose` is on. Users must find the channel manually
from the Output dropdown among all channels.

**Code path:**
- `packages/vscode-extension/src/util/logger.ts:23-37` — error → notification only
- `packages/vscode-extension/src/util/execute.ts:73-75` — channel opens only when `--verbose` in flags

**Why it matters:** the CLI's structured error model (Problem/Cause/Try) is
invisible exactly when it matters most; the notification string alone often
lacks the Try hint.

**Classification:** polish.

**Suggested direction:** `outputChannel.show(true)` (preserve focus) on the
first error of a run, or an "Open output" action button on the error
notification.

**Scope:** MVP ext polish.

---

## UX-17 — Progress/notification strings use raw command ids

**Observed behavior:** the progress title is `PZStudio: <command id>`
(e.g. `PZStudio: modconfig`), and the "already running" warning shows the
same raw id — while every other surface shows localized titles like
*PZ Studio: Build*.

**Code path:**
- `packages/vscode-extension/src/util/execute.ts:33,61` — `t('PZStudio: {0}', command)` with the id

**Why it matters:** inconsistent naming on the most visible UI element of
every command.

**Classification:** polish.

**Suggested direction:** a command-id → localized-title map for the runner
(messages must stay runtime-localizable; titles already exist in the NLS
tables).

**Scope:** MVP ext polish.

---

## UX-18 — Extension reads `project.json` as raw JSON, bypassing the project contract

**Observed behavior:** all extension reads (`getModSummaries`,
`readModConfig`, `readProjectSummary`, the explorer's `readProjectConfig`)
parse `project.json` tolerantly with no schema validation and no
`schemaVersion` migration — a legacy/v1 project renders differently in the
tree than the CLI (which migrates+validates on every command) would treat
it, and a malformed file is only surfaced via the doctor.

**Code path:**
- `packages/vscode-extension/src/util/project.ts:16-38,231-279,291-310`
- `packages/vscode-extension/src/providers/projectExplorer.ts:592-605`
- contract the extension skips: `loadProject/validateProject/migrateProject/saveProject`
  (`packages/core/src/project-contract.ts`, public since C6)

**Why it matters:** two sources of truth for "what does this project look
like"; drift grows as the schema evolves. (The `jsonValidation` contribution
gives *editing-time* schema hints but nothing runtime.)

**Classification:** debt / API-boundary.

**Suggested direction:** consume the core contract for reads (an async
`loadProject` wrapper on the api surface, or a validated snapshot exposed
by API v2); keep the tolerant fallback for the tree rendering.

**Scope:** API v2 milestone.

---

## Cross-cutting observations (no separate ID)

- **Consent is asymmetric by design and correctly so:** build/clean get a
  host-side modal (not an embedded-consent command), delete/rename get a
  modal **plus** forwarded `--yes` (embedded contract), modinfo gets a
  conditional `--force` modal, tasks get nothing. Documented in
  [`05`](05-build-clean-and-tasks.md); any future "clean consent gate"
  (CLI backlog) should reconcile the task path too.
- **Don't-Ask-Again writes folder-scope settings** — for a project that is
  not inside any workspace folder the update target is ill-defined
  (VS Code resolves the containing folder; none → error). Edge case, not
  observed broken.
- **The explorer never sees non-`project.json` writes** — output folders,
  modinfo generation etc. only refresh the tree when a `project.json`
  changed (or via the runner's post-command hook, which covers CLI-driven
  mutations). Direct file edits elsewhere require manual refresh; matches
  the 500 ms watcher design, worth remembering when judging "stale tree"
  reports.
