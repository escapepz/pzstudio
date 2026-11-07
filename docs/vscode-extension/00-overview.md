# 00 — Overview

Architecture map, the complete command inventory, the UI surfaces the
extension contributes, and the high-level user journeys.

## Architecture map

```mermaid
flowchart TB
    subgraph VSCode["VS Code host"]
        CP["Command Palette<br/>12 visible commands"]
        EXPL["PZ Project Explorer<br/>(tree view)"]
        TASKS["Task runner<br/>(pzstudio tasks)"]
        NOTIF["Notifications /<br/>progress / pickers"]
    end

    subgraph ExtBundle["dist/extension.js (esbuild bundle)"]
        CMD["src/commands/*<br/>(20 commands)"]
        RUNNER["util/execute.ts<br/>createCommandRunner"]
        PICK["util/project.ts<br/>project + mod pickers"]
        CONF["util/confirm.ts<br/>build/clean modal"]
        DEVSYNC["util/devsync.ts<br/>DevSyncController"]
        DOCTORUI["util/doctor.ts +<br/>commands/doctor.ts"]
        PROV["providers/<br/>projectExplorer + buildTaskProvider"]
        LOGGER["util/logger.ts<br/>PZ OutputChannel logger"]
        SETTINGS["util/settings.ts<br/>host settings snapshot"]
        FLAGS["util/flags.ts<br/>setting → CLI flags"]
    end

    subgraph HostInstance["createPzStudio host instance (bundled @pzstudio/cli/api, in-process)"]
        RUN["studio.run(command, args,<br/>{ flags, projectDir? })<br/>engine lock per invocation"]
        MODINFO["studio.resolveModInfoTargets"]
        DEVSYNCFACT["studio.createDevSync →<br/>core BuildSession<br/>(+ studio.resolveOutDir filter root)"]
        DOCTORAPI["studio.runProjectDoctor"]
    end

    WATCHSHARED["standalone api exports (@pzstudio/cli/api)<br/>isWatchPathIgnored · WATCH_DEBOUNCE_MS ·<br/>summarizeApplyResult"]

    CORE["@pzstudio/core<br/>planBuild · BuildSession · doctor engine ·<br/>project contract · textgen"]

    CP --> CMD
    EXPL --> CMD
    TASKS --> PROV
    CMD --> PICK
    CMD --> CONF
    CMD --> RUNNER
    CMD --> MODINFO
    RUNNER --> FLAGS
    RUNNER --> RUN
    PROV --> RUN
    DEVSYNC --> DEVSYNCFACT
    DEVSYNC --> WATCHSHARED
    DOCTORUI --> DOCTORAPI
    RUN --> CORE
    DEVSYNCFACT --> CORE
    DOCTORAPI --> CORE
    NOTIF --> CMD
    LOGGER -. "createPzStudio({ logger })<br/>instance sink" .-> HostInstance
    SETTINGS -.->|"instance-level<br/>settings provider"| HostInstance
```

Key structural facts:

- The extension bundle **inlines the whole CLI api surface** —
  `scripts/bundle.js:8-21` bundles `src/extension.ts` with only `vscode` and
  `@parcel/watcher` external. The `@parcel/watcher` native module stays
  external because only the CLI's own `watch` command loads it, lazily, inside
  `watchCmd` (`packages/cli/src/lib/commands/watch.ts:111`) — the extension
  never invokes it (`dc15821` lesson; see
  [`01-activation-and-architecture.md`](01-activation-and-architecture.md)).
- **One host-owned `PzStudio` instance** for the whole extension lifetime
  (`extension.ts:35-38`): `createPzStudio({ logger, settings })` receives the
  OutputChannel logger and the pull-model settings provider as instance
  inputs; every command hands its context to `run()` per invocation. The
  legacy module-state setters (`setProjectDir` / `setVsCodeSettings` /
  `setLogger`) are still exported from the API as deprecated facade slots but
  are **no longer written by the extension runtime** — only its integration
  test uses the legacy facade (`src/test/integration.test.ts`).
- Three command paths bypass the generic runner: **watch**
  (`commands/watch.ts` → `DevSyncController` → `studio.createDevSync`),
  **doctor** (`commands/doctor.ts` → the shared diagnostics runner →
  `studio.runProjectDoctor`), and the three **explorer** commands (direct
  provider methods) — none of them calls `studio.run`. ModInfo also uses the
  host instance directly (`studio.resolveModInfoTargets`) for its
  overwrite check before going through the runner.
- The task provider runs `studio.run` in-process through its own
  `Pseudoterminal` (`providers/buildTaskProvider.ts`) with **no confirmation
  modal** and **no shared busy-guard** with the palette runner (UX-08) — a
  new task is not rejected merely because another command is running: it
  may wait for the engine invocation lock inside `studio.run` before
  executing.

## Command inventory

All 20 contributed commands (`package.json:336-432`). "Palette" = appears in
the Command Palette; entries in `contributes.menus.commandPalette`
(`package.json:128-161`) with `when: false` hide a command from the palette
while keeping it usable from tree menus and inline buttons.

| Command id | Palette | Menus / buttons | Handler | Project needed | Mod needed | Destructive | Confirm | Execution path |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `pzstudio.new` | yes | — | `commands/new.ts:185-201` | no (creates one) | no | creates files | no (folder picker + 2 inputs) | runner → `studio.run('new')` |
| `pzstudio.newHere` | yes | — | `commands/new.ts:202-206` | no (creates one) | no | creates files | no | runner → `studio.run('new')` |
| `pzstudio.add` | yes | — | `commands/add.ts:9-39` | yes (picker first) | no (created) | creates files | no | runner → `studio.run('add')` |
| `pzstudio.build` | yes | project row inline button (`inline@1`), `package.json:62-66` | `commands/build.ts:12-50` | yes | no | overwrites output | **modal** (`confirmBeforeRun`) | runner → `studio.run('build')` |
| `pzstudio.clean` | yes | project row inline button (`inline@2`), `package.json:67-71` | `commands/clean.ts:12-50` | yes | no | deletes output | **modal** (`confirmBeforeRun`) | runner → `studio.run('clean')` |
| `pzstudio.delete` | yes | mod context menu (`3_mod`, `package.json:122-126`); mod row inline button (`inline@6`, `package.json:102-106`) | `commands/delete.ts:7-39` | yes | yes | **yes** | **modal** | runner → `studio.run('delete')` **with `--yes`** |
| `pzstudio.rename` | yes | mod context menu (`2_mod`); mod row inline button (`inline@5`) | `commands/rename.ts:7-44` | yes | yes | **yes** | **modal** (added with `91620af`) | runner → `studio.run('rename')` **with `--yes`** |
| `pzstudio.lang` | yes | — | `commands/lang.ts:6-24` | yes | yes | creates files | no | runner → `studio.run('lang')` |
| `pzstudio.update` | yes | — | `commands/update.ts:4-14` | **no** (global — `requiresProject: false`, UX-03 fix) | no | refreshes global template cache | no | runner → `studio.run('update')` |
| `pzstudio.modinfoGenerate` | yes | mod context menu (`1_mod`); mod row inline button (`inline@4`) | `commands/modinfo.ts:10-58` | yes | yes | overwrites mod.info | **modal only when a mod.info exists** (`--force`) | host-instance overwrite check (`studio.resolveModInfoTargets`) then runner → `studio.run('modinfo generate')` |
| `pzstudio.watch` | yes | — | `commands/watch.ts:12-75` | yes (to start) | no | writes outputs | no (toggle) | **direct** → `DevSyncController` → `studio.createDevSync` (no runner) |
| `pzstudio.doctor` | yes | project context menu (`0_project@1`, `package.json:56-61`) | `commands/doctor.ts:22-69` | yes | no | read-only | no | **direct** → shared diagnostics runner → `studio.runProjectDoctor` (no runner) |
| `pzstudio.modIncluded` | hidden | mod row inline (`inline@1`) when `mod-included`/`mod-devonly` | `commands/modstate.ts:45-67` | yes | yes | config write | no | runner → `studio.run('modconfig <id> exclude')` |
| `pzstudio.modExcluded` | hidden | mod row inline (`inline@1`) when `mod-excluded` | `commands/modstate.ts:45-67` | yes | yes | config write | no | runner → `studio.run('modconfig <id> include')` |
| `pzstudio.modDevOnly` | hidden | mod row inline (`inline@2`) when `mod-devonly` | `commands/modstate.ts:45-67` | yes | yes | config write | no | runner → `studio.run('modconfig <id> include')` |
| `pzstudio.modDevOnly.dim` | hidden | mod row inline (`inline@2`) when `mod-included`/`mod-excluded` | `commands/modstate.ts:45-67` | yes | yes | config write | no | runner → `studio.run('modconfig <id> devonly')` |
| `pzstudio.modConfigure` | hidden | mod context menu (`0_mod@1`) | `commands/configure.ts:50-190` | yes | yes | config write | no | runner → `studio.run('modconfig …')` |
| `pzstudio.explorer.refresh` | hidden | view title (`navigation@3`) | `commands/explorer.ts:11-13` | no | no | no | no | direct provider refresh |
| `pzstudio.explorer.toggleFiles` | hidden | view title (`navigation@1`) when `pzstudioExplorer.showAllFiles` | `commands/explorer.ts:16-18` | no | no | no | no | direct provider toggle |
| `pzstudio.explorer.toggleFiles.hidden` | hidden | view title (`navigation@1`) when `!pzstudioExplorer.showAllFiles` | `commands/explorer.ts:19-22` | no | no | no | no | direct provider toggle |

Palette-visible set = **12 commands** (10 workflow + watch + doctor; the
hidden set is pinned by `tests/unit/projectExplorer.test.ts`
"keeps explorer-only commands out of the command palette" and
`ea3d16b` moved the block to the correct `contributes.menus.commandPalette`
path — the current manifest has no `contributes.commandPalette` key).

## Surfaces

| Surface | What the extension puts there |
| :--- | :--- |
| Command Palette | 12 commands (table above) |
| Activity bar / tree view | `pzstudio-container` → `pzstudio.projectExplorer` ("PZ Project Explorer", `package.json:19-37`) |
| Tree inline buttons | build/clean on project rows; include/exclude + dev-only + modinfo + rename + delete on mod rows |
| Tree context menus | doctor on project rows; configure/modinfo/rename/delete on mod rows (incl. `mod-missing`) |
| View title | eye/eye-closed "Toggle All/Essential Files" pair + refresh |
| Tasks | 4 tasks of type `pzstudio`: build (production/development/both), clean |
| Notifications | modal confirms (build/clean/delete/rename/modinfo-overwrite), progress (every runner command), warnings/errors |
| Output channel | `PZ Studio` channel: every embedded CLI run's data + progress + errors |
| JSON schema | `jsonValidation` for `project.json` → bundled `schemas/pzstudio.schema.json` (`package.json:183-188`) |
| Keyboard Shortcuts UI | all 20 commands are listed there even when hidden from the palette (platform behavior of `when: false`) |

There are **no keybindings, no webviews, no status-bar item, no decoration
providers** contributed.

## User journeys (as the code implements them)

1. **First project** — Command Palette → *PZ Studio: New Project* → folder
   picker (initial location: setting → last recorded destination → first
   workspace folder — it only initializes the picker, never counts as
   confirmation) → title → optional mod id → `pzstudio new <title>
   [modId] --path <dest>` with the destination anchored as the invocation's
   `projectDir` (`commands/new.ts:185-201`). Cancelling the folder picker
   aborts the flow silently — no fallback destination, no further prompts
   (A13/UX-14). The destination is remembered only after the flow completes
   and a new `<destination>/<child>/project.json` shows up in the best-effort
   before/after child scan — the owner-accepted filesystem heuristic, not an
   authoritative engine creation receipt (no transaction outcome is implied).
   *New Project Here* shares the same creation prompts but never records the
   destination. Installed-VSIX interactive acceptance of the remediated flow
   is pending R1.3 (see the UX-14 audit annotation).
2. **Everyday edit** — open project files, edit; **Toggle Development Sync**
   keeps both workshop outputs fresh (see
   [`06-development-sync.md`](06-development-sync.md)).
3. **Package for the game** — inline ▶ on a project row → confirm modal
   (workshop title shown) → `pzstudio build` with flags from
   `pzstudio.build.target` (see
   [`05-build-clean-and-tasks.md`](05-build-clean-and-tasks.md)).
4. **Something is wrong** — right-click project row → *Run Diagnostics* →
   quick-pick listing findings from the shared engine, or read the `✗ n ⚠ n`
   badge in the row description
   ([`07-diagnostics.md`](07-diagnostics.md)).
5. **Manage mods** — mod rows and their context menus cover modinfo, rename,
   delete, build-state toggles and field edits (all routed through
   `pzstudio modconfig` / `modinfo` / `rename` / `delete` via the runner).
