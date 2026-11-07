# 04 — Command Flows

Command metadata below is generated from the registry
(`packages/cli/src/lib/registry.ts`) — flags/positionals declared there are what the
parser enforces on both hosts. `*` marks a required positional; the global flags
(`--verbose`, `--quiet`, `--debug`, `--transport`, `-C/--project`, `--help`) are always
available and are not repeated per command.

| Command | Positionals | Flags | Silent | Hidden |
|---|---|---|---|---|
| `add` | `modName*` `[modId]` | `--offline` `--force-update` | | |
| `build` | — | `--production` `--development` `--both` | ✔ | |
| `clean` | — | — | ✔ | |
| `delete` | `modId*` | `--yes` `--dry-run` | | |
| `doctor` | — | `--game-build <v>` `--json` | | |
| `help` | `[command]` | — | ✔ | |
| `lang` | `modId*` `lang*` `[toLang]` | — | | ✔ |
| `list` | — | `--json` | | |
| `migrate` | — | — | | |
| `modconfig` | `modId*` `[action...]` | — | | |
| `modinfo` | `action*` `[modId]` | `--force` | ✔ | |
| `new` | `title*` `[modId]` | `--path <dir>` `--offline` `--force-update` `--symlinks` | | |
| `outdir` | `path*` | — | | |
| `rename` | `oldModId*` `newModId*` | `--yes` `--dry-run` | | |
| `update` | — | — | | |
| `watch` | — | `--production` `--development` `--both` | ✔ | |

Every project-aware command starts with the same fail-closed discovery gate
(`No pzstudio project found.` — see `02-project-resolution.md`). Template-consuming
commands additionally resolve their template first (see `03-template-resolution.md`).

Legend used in the diagrams:

- `ERR` (red) — the command aborts with a thrown error; the bin layer turns it into
  exit 1 (or 2 for `CliUsageError`).
- `WARN` (orange) — the command continues; a warning is printed to stderr.
- Rounded/gray — successful exit of the command.

Stream routing (CLI-2, pinned since 0.42200.1): human **progress** lines
(`Building main workshop...`, `Cleaning ... directory...`, `Deleting mod ...`,
`Renaming mod ...`, `Refreshing/Updating templates...`, scaffold/clone steps)
print to **stderr**. `LOG`/`stdout:` labels mark **data and results** (reports,
verdicts, dry-run `Would:` plans, the `Next:` block, JSON envelopes) which stay
on stdout. Since 0.42200.1 `build` prints nothing on stdout at all, and the
`[INFO]`/timestamp/color prefixes are presentation, not stable API.

---

## pzstudio new

`new` is a **transaction** (CLI-4): everything is scaffolded into a staging directory and
committed with a single atomic rename — the destination never exists in a partial state.

```mermaid
flowchart TD
    A["new <title> [modId]"] --> B{"--path flag<br/>given?"}
    B -- yes --> D["destDir = resolve(--path)<br/>no inside-project guard"]
    B -- no --> E["destDir = discoveryStartDir()"]
    E --> F{"inside a project?<br/>(non-throwing discovery)"}
    F -- yes --> ERR1["ERR: You cannot execute this<br/>command within a project directory!"]
    F -- no --> G["resolveTemplateDir(project)<br/>+ mod/workshop/language templates<br/>(local .template-* override first)"]
    D --> G
    G --> I["modId = formatTitleToId(modId ?? title)"]
    I --> J{"modId empty?"}
    J -- yes --> ERR2["ERR: Cannot derive a valid mod id ..."]
    J -- no --> K{"destDir/modId<br/>already exists?"}
    K -- yes --> ERR3["ERR: The project 'title' dir 'id' already exists!"]
    K -- no --> ST["PRE-COMMIT: scaffold 9 steps into<br/>staging .modId.staging-ts (same parent)"]
    ST --> V{"staging project.json<br/>valid?"}
    V -- no --> CL["remove staging dir"]
    V -- yes --> CM["COMMIT: renameSync(staging, dest)<br/>destination exists from here on"]
    CL --> ERR4["ERR: No project was created.<br/>Cause + Try (exit 1)"]
    CM --> HOOK["POST-COMMIT: experimental hooks<br/>(non-fatal, opt-in only)"]
    HOOK --> OK["stderr: The project 'title' has been created at 'path'<br/>stdout: Next: cd 'path' — globally: 'pzstudio doctor' / 'pzstudio watch'<br/>or via npx: 'npx -y @pzstudio/cli@latest doctor' / 'watch'"]

    style ERR1 fill:#c0392b,color:#fff
    style ERR2 fill:#c0392b,color:#fff
    style ERR3 fill:#c0392b,color:#fff
    style ERR4 fill:#c0392b,color:#fff
    style OK fill:#27ae60,color:#fff
```

Key behaviors:

- **Fail before commit → nothing is left behind**: the staging dir is removed and
  `CliError('No project was created.', {cause, tryHint})` is thrown
  (`packages/cli/src/lib/commands/new.ts:203-216`). Pinned black-box: no destination
  debris, no `.staging-` leftovers (`tests/real-env/bin-contract-gate.test.ts:256-274`).
- Failures during validation/preflight (before staging exists) keep their original
  messages and are not wrapped.
- **Golden path** (CLI-7): on success stdout ends with a `Next:` block telling
  the user to `cd '<path>'`, then `pzstudio doctor` + `pzstudio watch` when the
  package is installed globally, or the `npx -y @pzstudio/cli@latest`
  equivalents on the zero-install path
  (`packages/cli/src/lib/commands/new.ts:227-241`).
- The success message itself (`The project '...' has been created at '...'`) is `info`
  → stderr.

---

## pzstudio add

```mermaid
flowchart TD
    A["add <modName> [modId]"] --> C{"in a project?"}
    C -- no --> ERR1["ERR: No pzstudio project found."]
    C -- yes --> D{"project has local<br/>.template-mod?"}
    D -- yes --> E["use local .template-mod"]
    D -- no --> F["resolveTemplateDir(mod)"]
    E --> G["modId = formatTitleToId(modId ?? modName)"]
    F --> G
    G --> H{"modId in project.json<br/>OR folder exists?"}
    H -- yes --> ERR2["ERR: A mod with id 'id' already exists!"]
    H -- no --> I["copy mod template → project/<modId><br/>(always a real copy, never a junction)"]
    I --> J{"template cache<br/>was seeded by this run?"}
    J -- yes --> K["track seed for rollback"]
    J -- no --> L["add mods[modId] to project.json"]
    K --> L
    L --> M["updateExperimentalScripts(addMod)<br/>(no-op unless opted in)"]
    M --> OK["LOG: Added mod 'name' with id 'id'"]

    style ERR1 fill:#c0392b,color:#fff
    style ERR2 fill:#c0392b,color:#fff
    style OK fill:#27ae60,color:#fff
```

**Ownership rollback guard** (CLI-4): `createdPaths` tracks only what *this invocation*
created (the mod dir; the seeded `.template-mod` only when the cache did not exist
before). On failure the tracked paths are rolled back newest-first and the original error
is rethrown. A pre-existing mod directory is never deleted. The mod template is always
copied (junctions are intentionally not used — the mod folder must diverge from its
template).

---

## pzstudio build

```mermaid
flowchart TD
    A["build"] --> B{"in a project?"}
    B -- no --> ERR1["ERR: No pzstudio project found."]
    B -- yes --> C{"flag conflict?<br/>validateInvocation (CLI-1)"}
    C -- "prod + dev, or both + prod/dev" --> ERR2["ERR: Conflicting options: ...<br/>CliUsageError → exit 2"]
    C -- ok --> D["resolve targets:<br/>flag > project.json build.target > default main"]
    D --> E["resolveTemplateDir(workshop)<br/>gatherPlanInput() snapshot"]
    E --> V{"which variants?"}

    V -- "main" --> M["main variant"]
    V -- "development" --> DV["dev variant"]
    V -- "both / target both" --> BOTH["main + dev, each isolated"]

    M --> M1{"mods eligible<br/>for main?"}
    M1 -- none --> MW["WARN: All mods are dev-only or excluded ...<br/>record OUTCOME_WARNING"]
    M1 -- yes --> M2{"dev-only mods<br/>present?"}
    M2 -- yes --> MW2["WARN: Dev-only mods skipped in the main build: ..."]
    M2 -- no --> M3
    MW2 --> M3["planBuild(main) + executeBuildPlan()<br/>record OUTCOME_SUCCESS"]
    M3 -- threw --> COL["record OUTCOME_FAILURE<br/>collect error"]
    MW --> AGG
    COL --> AGG
    M3 --> AGG

    DV --> D2{"mods eligible<br/>for dev?"}
    D2 -- none --> DW["WARN: All mods are excluded ...<br/>record OUTCOME_WARNING"]
    D2 -- yes --> D3["planBuild(development) + executeBuildPlan()"]
    D3 -- threw --> COL2["record OUTCOME_FAILURE"]
    D3 --> AGG
    DW --> AGG
    COL2 --> AGG

    BOTH --> M
    BOTH --> DV

    AGG["aggregateOutcomeSeverity:<br/>failure > warning > success"] -- "any failure" --> ERR4["throw CliError with collected errors<br/>exit 1"]
    AGG -- "success or warnings only" --> OK["stderr: Build complete in <n>s!<br/>exit 0"]

    style ERR1 fill:#c0392b,color:#fff
    style ERR2 fill:#c0392b,color:#fff
    style ERR4 fill:#c0392b,color:#fff
    style OK fill:#27ae60,color:#fff
    style MW fill:#e67e22,color:#fff
    style MW2 fill:#e67e22,color:#fff
    style DW fill:#e67e22,color:#fff
```

Exit semantics are mechanical, not prose (CLI-6,
`packages/cli/src/lib/commands/build.ts:143-210` + `packages/cli/src/lib/outcome.ts`):
a failed variant no longer aborts the other one under `--both` — every variant gets its
chance, then any `failure` outcome fails the command via a structured `CliError` (the old
`Unexpected error:` wrapper is gone). Warnings never flip the exit code.
Build progress (`Building main workshop...`, plan plan-messages, the `Build complete`
timing) prints to stderr — stdout stays empty on a successful build (CLI-2).

The workshop template resolution can touch the network (clone) when the cache is missing
or invalid — see `08-mechanics.md` → Template resolution during build/watch.

---

## pzstudio watch

```mermaid
flowchart TD
    A["watch"] --> B{"in a project?"}
    B -- no --> ERR1["ERR: No pzstudio project found."]
    B -- yes --> C{"flag conflict?<br/>validateInvocation (CLI-1)"}
    C -- yes --> ERR2["ERR: Conflicting options: ...<br/>CliUsageError → exit 2"]
    C -- no --> D["resolveWatchVariants()<br/>default: BOTH outputs"]
    D --> BN["stderr: Syncing 'title' (main + development) — press Ctrl+C to stop."]
    BN --> E["createDevSync(projectPath)"]
    E --> F["session.start(variants)<br/>initial FULL build"]
    F --> G{"initial build<br/>failed?"}
    G -- yes --> ERR3["session.stop() then throw<br/>(exit 1)"]
    G -- no --> H["subscribe @parcel/watcher on project root<br/>(output tree ignored natively)"]
    H --> SIG{"SIGINT<br/>(Ctrl+C)?"}
    SIG -- yes --> S1["exitCode = 130<br/>unsubscribe watcher<br/>session.stop()"]
    S1 --> OK["stderr: Development sync stopped.<br/>ONE message, exit 130"]
    SIG -- no --> EVT["waiting for file events ..."]

    EVT --> LOOP

    subgraph LOOP["event loop (300ms debounce window)"]
        L2{"path ignored?<br/>(outside project, output subtree,<br/>dot segments except .pzstudioignore)"} -- yes --> L3["drop event"]
        L2 -- no --> L4["queue delta"]
        L4 --> L6["session.apply(batch)"]
        L6 --> L7{"delta type?"}
        L7 -- "regular file" --> L8["incremental sync"]
        L7 -- "mod.info / .pzstudioignore" --> L9["scoped rebuild of that mod"]
        L7 -- "project.json" --> L10["full rebuild with fresh input"]
        L8 --> L11{"apply result?"}
        L9 --> L11
        L10 --> L11
        L11 -- "has errors" --> L12["WARN per error<br/>(session keeps running)"]
        L11 -- "clean" --> L13["stderr: - N file(s) synced. ..."]
    end

    LOOP --> SIG

    style ERR1 fill:#c0392b,color:#fff
    style ERR2 fill:#c0392b,color:#fff
    style ERR3 fill:#c0392b,color:#fff
    style OK fill:#27ae60,color:#fff
    style L12 fill:#e67e22,color:#fff
```

Special rules:

- The banner is a **single line** (CLI-7):
  `Syncing '<title>' (main + development) — press Ctrl+C to stop.`
  (`packages/cli/src/lib/commands/watch.ts:68-71`).
- **watch owns SIGINT** (CLI-6): one `process.once('SIGINT')` sets `exitCode = 130`,
  unsubscribes, stops the session and prints `Development sync stopped.` exactly once —
  there is no global handler double-reporting anymore
  (`packages/cli/src/lib/commands/watch.ts:169-178`). Pinned on POSIX:
  `tests/real-env/bin-watch.test.ts` + `bin-contract-gate.test.ts` (skipped on Windows,
  which cannot reliably deliver SIGINT to a child).
- A source file that vanishes before the batch runs (atomic-save temp files) is silently
  skipped; directory events pass through as create/delete; RENAME arrives as delete+create.
- Unlike `build`, the default target is **both** outputs (dev_branch needs to stay live).
- `@parcel/watcher` is required lazily inside the command (native binding must not load
  through the embedded api import path).

---

## pzstudio clean

```mermaid
flowchart TD
    A["clean"] --> B{"in a project?"}
    B -- no --> ERR1["ERR: No pzstudio project found."]
    B -- yes --> C["resolve main + dev output paths"]
    C --> D{"main output<br/>exists?"}
    D -- yes --> E["removeDirRecursive<br/>(5 retries x 200ms on lock)"]
    E -- locked --> EW["collect failure outcome"]
    E -- ok --> EW2["cleaned = true"]
    D -- no --> F{"dev output<br/>exists?"}
    EW --> F
    EW2 --> F
    F -- yes --> G["removeDirRecursive<br/>(always attempted)"]
    G -- locked --> GW["collect failure outcome"]
    G -- ok --> GW2["cleaned = true"]
    F -- no --> H{"anything cleaned<br/>or failed?"}
    GW --> H
    GW2 --> H
    H -- "nothing at all" --> NC["LOG: Already clean.<br/>exit 0"]
    H -- "failures recorded" --> ERR2["throw CliError (joined failures)<br/>exit 1"]
    H -- "cleaned, no failures" --> OK["LOG: Clean complete in <n>s!"]

    style ERR1 fill:#c0392b,color:#fff
    style ERR2 fill:#c0392b,color:#fff
    style NC fill:#27ae60,color:#fff
    style OK fill:#27ae60,color:#fff
    style EW fill:#e67e22,color:#fff
    style GW fill:#e67e22,color:#fff
```

**Nothing to clean is success, not failure** (CLI-6): `Already clean.` with exit 0
replaced the old error path. Both outputs are always attempted — a locked main output
does not skip the dev output cleanup; failures are collected and thrown together
(`packages/cli/src/lib/commands/clean.ts:42-78`).

---

## pzstudio delete

```mermaid
flowchart TD
    A["delete <modId>"] --> B{"in a project?"}
    B -- no --> ERR1["ERR: No pzstudio project found."]
    B -- yes --> C{"modId in<br/>project.json?"}
    C -- no --> ERR2["ERR: Mod 'id' not found in project.json!<br/>Cause + Try (exit 1)"]
    C -- yes --> DR{"--dry-run?"}
    DR -- yes --> DRP["stdout: Would: delete mod directory ...<br/>Would: remove from project.json<br/>No files were changed.<br/>exit 0 — nothing mutated"]
    DR -- no --> GATE["confirmDestructive()<br/>TTY prompt [y/N] unless --yes<br/>refused exit 2 in non-interactive<br/>decline exit 1: Aborted. Nothing was changed."]
    GATE -- proceed --> E["rmSync mod folder<br/>(missing folder → WARN, continue)"]
    E --> F["remove mods entry + excludes entry"]
    F --> X["updateExperimentalScripts(removeMod)<br/>(no-op unless opted in)"]
    X --> OK["stderr: Mod 'id' deleted from project.json!"]

    style ERR1 fill:#c0392b,color:#fff
    style ERR2 fill:#c0392b,color:#fff
    style DRP fill:#95a5a6,color:#fff
    style OK fill:#27ae60,color:#fff
```

Ordering matters (CLI-9, `packages/cli/src/lib/commands/delete.ts:51-66`):
validation failures keep exit 1; `--dry-run` wins over `--yes` and runs **before** the
gate; the consent gate is the last step before the first mutation.
See `08-mechanics.md` → Destructive consent gate for the full policy.

---

## pzstudio rename

```mermaid
flowchart TD
    A["rename <oldModId> <newModId>"] --> B{"in a project?"}
    B -- no --> ERR1["ERR: No pzstudio project found."]
    B -- yes --> C{"old id in<br/>project.json?"}
    C -- no --> ERR2["ERR: Mod 'old' does not exist!<br/>Try: pzstudio list ..."]
    C -- yes --> D{"new id already in<br/>project.json OR on disk?"}
    D -- yes --> ERR3["ERR: A mod with id 'new' already exists!"]
    D -- no --> E{"old folder<br/>on disk?"}
    E -- "no (and new folder also missing)" --> ERR4["ERR: Mod folder 'old' was not found on disk. ..."]
    E -- yes --> DR{"--dry-run?"}
    E -- "no, config-only entry" --> DR2{"--dry-run?"}
    DR -- yes --> DRP["Would: rename folder ...<br/>Would: rewrite occurrences in text files ...<br/>No files were changed."]
    DR2 -- yes --> DRP2["Would: rename the project.json mods key ...<br/>No files were changed."]
    DR -- no --> GATE
    DR2 -- no --> GATE["confirmDestructive()<br/>(same policy as delete)"]
    GATE -- proceed --> F["scaffold old folder → new folder<br/>then delete old"]
    F --> G["rewrite file contents: replace old id<br/>in every text file (binary skipped)"]
    G --> H["rename mods key, keep fields"]
    H --> I{"old id in<br/>excludes?"}
    I -- yes --> J["rewrite excludes entry to new id"]
    I -- no --> X
    J --> X["updateExperimentalScripts(renameMod)<br/>(no-op unless opted in)"]
    X --> OK["LOG: Mod 'old' updated to 'new' in project.json!"]
    DRP --> END0["exit 0 — nothing mutated"]
    DRP2 --> END0

    style ERR1 fill:#c0392b,color:#fff
    style ERR2 fill:#c0392b,color:#fff
    style ERR3 fill:#c0392b,color:#fff
    style ERR4 fill:#c0392b,color:#fff
    style OK fill:#27ae60,color:#fff
    style END0 fill:#95a5a6,color:#fff
```

Only the **id** changes (folder + project.json key + occurrences inside files);
the mod's `name` field is untouched, and an excluded mod stays excluded under its new id.
Binary extensions are skipped to avoid corruption. A config-only entry (no folder on
disk) can be renamed: only the project.json key moves
(`packages/cli/src/lib/commands/rename.ts:60-131`).

---

## pzstudio modinfo generate

```mermaid
flowchart TD
    A["modinfo generate [modId]"] --> B{"in a project?"}
    B -- no --> ERR1["ERR: No pzstudio project found."]
    B -- yes --> C{"action is<br/>'generate'?"}
    C -- no --> ERR2["ERR: Unknown modinfo action"]
    C -- yes --> D{"modId<br/>given?"}
    D -- yes --> E["generate for that mod"]
    D -- no --> F["generate for every<br/>non-excluded mod"]

    E --> G{"mod in<br/>project.json?"}
    G -- no --> ERR3["ERR: Mod not found in project.json"]
    G -- yes --> H{"build.modInfo<br/>== 'skip'?"}
    H -- yes --> S1["LOG: skipping (modInfo: skip)"]
    H -- no --> I["resolveModInfoTargets()<br/>(branch folders with media/)"]
    I --> J{"targets<br/>found?"}
    J -- no --> S2["LOG: no valid Build 42 branch<br/>folders found, skipping"]
    J -- yes --> K["overwrite = --force OR<br/>build.modInfo == 'auto'"]
    K --> LOOP["for each branch folder"]
    LOOP --> L{"mod.info exists<br/>AND !overwrite?"}
    L -- yes --> S3["LOG: skipping (already exists, use --force)"]
    L -- no --> M["generateModInfoText()<br/>write mod.info"]
    M --> LOOP

    style ERR1 fill:#c0392b,color:#fff
    style ERR2 fill:#c0392b,color:#fff
    style ERR3 fill:#c0392b,color:#fff
    style S1 fill:#95a5a6,color:#fff
    style S2 fill:#95a5a6,color:#fff
    style S3 fill:#95a5a6,color:#fff
```

Root-level mod.info is NOT a target — only branch folders (e.g. `42/`, `common/`) that
contain a `media/` directory qualify (Build 42 layout).

---

## pzstudio modconfig

```mermaid
flowchart TD
    A["modconfig <modId> [action] [key] [value]"] --> B{"modId<br/>missing?"}
    B -- yes --> ERR1["ERR: usage message"]
    B -- no --> C["read project.json RAW<br/>(no defaults materialized)"]
    C --> D{"mod in<br/>project.json?"}
    D -- no --> ERR2["ERR: Mod 'id' is not in project.json<br/>(lists known mods)"]
    D -- yes --> E{"action?"}

    E -- show --> S["print every field +<br/>build.* fields + state"]
    E -- include --> I["remove from excludes,<br/>remove build.devOnly"]
    E -- devonly --> J["set build.devOnly=true,<br/>remove from excludes"]
    E -- exclude --> K["add to excludes,<br/>remove build.devOnly<br/>(excluded wins over dev-only)"]
    E -- set --> L{"key unknown /<br/>value missing /<br/>invalid modInfo value?"}
    L -- yes --> ERR3["ERR: unknown key / missing value /<br/>invalid modInfo value"]
    L -- no --> M["coerce value<br/>(arrays split on commas)"]
    E -- unset --> N{"key unknown /<br/>key required?"}
    N -- yes --> ERR4["ERR: unknown key / cannot unset required key"]
    N -- no --> O["delete the field"]

    I --> P{"anything<br/>changed?"}
    J --> P
    K --> P
    M --> P
    O --> P
    P -- no --> DONE["return (no write)"]
    P -- yes --> Q["validate project.json<br/>against schema"]
    Q -- "validation errors" --> ERR5["ERR: Validation failed<br/>(nothing written)"]
    Q -- ok --> R["write project.json<br/>(atomic, preserving unknown fields)"]
    R --> OK["stdout: project.json updated."]

    style ERR1 fill:#c0392b,color:#fff
    style ERR2 fill:#c0392b,color:#fff
    style ERR3 fill:#c0392b,color:#fff
    style ERR4 fill:#c0392b,color:#fff
    style ERR5 fill:#c0392b,color:#fff
    style OK fill:#27ae60,color:#fff
    style DONE fill:#95a5a6,color:#fff
```

No-op edits (already in the requested state) print "was already ..." and skip the write
entirely. Validation happens **after** the edit and **before** the write — an invalid
result never lands on disk.

---

## pzstudio list

```mermaid
flowchart TD
    A["list"] --> B{"in a project?"}
    B -- no --> ERR1["ERR: No pzstudio project found."]
    B -- yes --> J{"--json?"}
    J -- yes --> JE["stdout: exactly one v1 envelope<br/>{schemaVersion, command: list,<br/>result: {title, mods: [{id, name,<br/>onDisk, excluded, devOnly}]}}<br/>no human report (see 09)"]
    J -- no --> C{"mods in<br/>project.json?"}
    C -- "0 mods" --> S1["LOG: No mods in project 'title'."]
    C -- yes --> LOOP["for each mod"]
    LOOP --> D{"folder on disk?"}
    D -- no --> S2["missing on disk"]
    D -- yes --> E{"excluded?"}
    E -- yes --> S3["on disk, excluded from workshop build"]
    E -- no --> F{"dev-only?"}
    F -- yes --> S4["on disk, dev builds only"]
    F -- no --> S5["on disk, included"]
    S2 --> LOOP
    S3 --> LOOP
    S4 --> LOOP
    S5 --> LOOP

    style ERR1 fill:#c0392b,color:#fff
    style JE fill:#27ae60,color:#fff
    style S1 fill:#95a5a6,color:#fff
```

Read-only command in both modes — `--json` never writes and never prints the human
report (`packages/cli/src/lib/commands/list.ts:36-54`; envelope contract in
`09-machine-interface.md`).

---

## pzstudio outdir

```mermaid
flowchart TD
    A["outdir <newOutDir>"] --> B["resolve(path)"]
    B --> C{"path exists?"}
    C -- no --> ERR1["ERR: The output directory ... does not exist.<br/>Try: Create the directory first ..."]
    C -- yes --> D{"is a<br/>directory?"}
    D -- no --> ERR2["ERR: ... is not a directory.<br/>Try: Pass the path to a directory ..."]
    D -- yes --> E{"same as<br/>current?"}
    E -- yes --> ERR3["ERR: The output directory is already set to this value."]
    E -- no --> F["write config.json<br/>(GLOBAL, not project.json)"]
    F --> OK["stdout: The output directory has been changed to ..."]

    style ERR1 fill:#c0392b,color:#fff
    style ERR2 fill:#c0392b,color:#fff
    style ERR3 fill:#c0392b,color:#fff
    style OK fill:#27ae60,color:#fff
```

The first two failures throw structured `CliError`s with Try hints
(`packages/cli/src/lib/commands/outdir.ts:28-46`); the third is still a plain error
(rendered through the unexpected-error wrapper). ⚠️ Writes the **global** config.json —
this affects every project on the machine that does not set its own `outdir`.

---

## pzstudio doctor

```mermaid
flowchart TD
    A["doctor [--game-build v] [--json]"] --> B{"in a project?<br/>(projectDir() throws first)"}
    B -- no --> ERR0["ERR: No pzstudio project found."]
    B -- yes --> J{"--json?"}
    J -- yes --> JE["stdout: one v1 envelope<br/>{schemaVersion, command: doctor,<br/>result: {status, projectDir,<br/>counts, diagnostics[]}}<br/>errors > 0: envelope printed, then exit 1<br/>(see 09)"]
    J -- no --> C["runProjectDoctor(projectDir, gameBuild)<br/>core engine over NodeFileSystem"]
    C --> HD["stdout: PZ Studio doctor — 'title'"]
    HD --> D0{"0 diagnostics?"}
    D0 -- yes --> OK1["stdout: ✓ Ready to develop.<br/>exit 0"]
    D0 -- no --> PR["print each finding:<br/>glyph ✗ ⚠ · + [module] message<br/>+ gray hint line"]
    PR --> SU["stdout: Summary: N error(s), M warning(s), K info(s)."]
    SU --> V{"errors > 0?"}
    V -- yes --> ERR1["stdout: ✗ Doctor found N blocking issues.<br/>throw CliError → exit 1"]
    V -- no --> W{"warnings > 0?"}
    W -- yes --> OK2["stdout: ⚠ Doctor completed with N warnings.<br/>You can continue, but review the items above.<br/>exit 0"]
    W -- no --> OK1

    style ERR0 fill:#c0392b,color:#fff
    style ERR1 fill:#c0392b,color:#fff
    style OK1 fill:#27ae60,color:#fff
    style OK2 fill:#27ae60,color:#fff
    style JE fill:#27ae60,color:#fff
```

The verdict is result-based (CLI-7, `packages/cli/src/lib/commands/doctor.ts:78-115`):
zero diagnostics and warnings-only both end in a verdict line on stdout with exit 0;
only errors exit 1 (the thrown message is
`Doctor found N blocking issues. See the report above.`).

Checks performed by the engine (severity in parentheses):
- **project**: missing project.json (single `project.missing` finding); parse/version/validation
  failures; description.txt missing (warning); preview.png missing (info)
- **environment**: capability-based (web hosts get info-level notes)
- **filesystem**: outDir missing (info — created by build); not a directory (error); inside the
  project folder (warning)
- **templates**: cache not populated (info)
- **mods**: included mod folder missing (error); excluded mod folder missing (warning); no branch
  folder (error); modInfo=skip with no mod.info anywhere (warning); devOnly + excluded (warning);
  orphan excludes entries (warning); zero mods (info)
- **buildTarget**: no production output possible (info); no development output possible (info);
  pzBuildCompatibility mismatch with `--game-build` (warning, never blocks)

---

## pzstudio migrate

```mermaid
flowchart TD
    A["migrate"] --> B["read config.json<br/>(empty file = {})"]
    B --> B1{"parse<br/>error?"}
    B1 -- yes --> ERR1["ERR: Failed to parse —<br/>fix JSON and re-run"]
    B1 -- no --> C{"config needs<br/>migration?"}
    C -- yes --> C1["upgrade + write<br/>stderr: - Migrating config.json: ...<br/>→ config.json upgraded successfully."]
    C -- no --> C2["LOG: already up to date"]
    C1 --> D
    C2 --> D{"project.json in<br/>discovery start?"}
    D -- no --> S1["stdout: - No project.json found.<br/>(global config still migrated)"]
    D -- yes --> E{"project needs<br/>migration?"}
    E -- yes --> E1["upgradeProject in memory"]
    E -- no --> E2
    E1 --> E2["for each mod:<br/>import missing fields from<br/>mod.info into project.json"]
    E2 --> E3{"anything<br/>changed?"}
    E3 -- yes --> F["write project.json<br/>stderr: → project.json upgraded and synced successfully."]
    E3 -- no --> G["LOG: already up to date"]
    F --> OK["stderr: Migration complete."]
    G --> OK
    S1 --> OK

    style ERR1 fill:#c0392b,color:#fff
    style OK fill:#27ae60,color:#fff
    style S1 fill:#95a5a6,color:#fff
```

`migrate` works outside a project (CLI-5): discovery is non-throwing, and the no-project
message is the neutral `- No project.json found.`
(`packages/cli/src/lib/commands/migrate.ts:156`). Unknown fields are preserved.

---

## pzstudio update

```mermaid
flowchart TD
    A["update"] --> LOOP["for each category:<br/>project, mod, workshop, language"]
    LOOP --> B["resolveTemplateDir(category, forceUpdate=true)"]
    B --> C{"refresh<br/>succeeded?"}
    C -- yes --> D["record OUTCOME_SUCCESS"]
    C -- no --> W["WARN: Failed to update <category> template: ...<br/>record OUTCOME_FAILURE"]
    D --> LOOP
    W --> LOOP
    LOOP --> E{"aggregate severity?"}
    E -- "any failure" --> ERR1["throw CliError:<br/>Refreshed X/4 template caches — N update(s) failed.<br/>Fix the reported causes and run 'pzstudio update' again.<br/>exit 1"]
    E -- "all success" --> OK["stderr: All template caches refreshed successfully!"]

    style ERR1 fill:#c0392b,color:#fff
    style OK fill:#27ae60,color:#fff
    style W fill:#e67e22,color:#fff
```

**Partial failure is a failure** (CLI-6, `packages/cli/src/lib/commands/update.ts:39-58`):
every category is still attempted, but the command exits 1 when any refresh failed —
the summary message doubles as the retry instruction. Community template URLs get no
legacy fallback, so their failures are real failures (see `03-template-resolution.md`).

---

## pzstudio lang

`lang` is registered with `hidden: true` (CLI-7): the old route still runs and
`pzstudio help lang` prints its curated text, but it no longer appears in the generated
command listing (did-you-mean may still suggest it — only the help listing is contract).

```mermaid
flowchart TD
    A["lang <modId> <lang> [toLang]"] --> ERR1["throw: Not implemented yet!<br/>rendered as Unexpected error: ...<br/>exit 1"]
    style ERR1 fill:#c0392b,color:#fff
```

---

## pzstudio help [<command>]

```mermaid
flowchart TD
    A["help / --help"] --> B{"command<br/>given?"}
    B -- no --> C["stdout: Available commands:<br/>(auto-generated, hidden commands filtered)"]
    B -- yes --> D{"command<br/>known?"}
    D -- yes --> E["stdout: that command's help text (addHelp entries)"]
    D -- no --> F["throw CliUsageError: Unknown command [x].<br/>Did you mean one of: ...? → exit 2"]
```

`--help` is a pure invocation everywhere: it short-circuits positional arity validation
and never runs migrations or discovery (`packages/cli/src/lib/cli.ts:152-169`).
