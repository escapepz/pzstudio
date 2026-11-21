# Changelog

All notable changes to the **PZ Studio** monorepo, grouped per release.
Format follows [Keep a Changelog](https://keepachangelog.com/); per-version
detail lives in [`docs/releases/`](docs/releases/) (CLI) and
[`packages/vscode-extension/CHANGELOG.md`](packages/vscode-extension/CHANGELOG.md)
(extension).

Versions follow `0.<gameBuild>.<patch>`: the minor encodes the supported
Project Zomboid build (build 42.20 → `42200`), the patch bumps for
tool-only releases. Game compatibility is declared separately in
`pzBuildCompatibility` (e.g. `"42.x"`).

## [Unreleased]

### CLI (@pzstudio/cli)

- **Ignore-rule semantics upgrade: `.gitignore` is now honored as a rule
  source next to `.pzstudioignore` on every surface** (build copy, watch,
  development sync, project explorer), through the unified engine in
  `@pzstudio/core` (the `ignore` package behind `readIgnoreRulesForDir` /
  `createIgnoreMatcher`). Within one directory, `.gitignore` entries apply
  first and `.pzstudioignore` second — later rules win, so
  **`.pzstudioignore` keeps the higher precedence at the same level**;
  across directories, the **closest rule file to an entry decides** (the
  deeper file wins, and the deciding level decides entirely).
- **Wildcard entries are now active**: `*.log`, `**/temp/**` and friends get
  their real gitignore meaning, matching at any depth below the rule file —
  previously entries were compared literally, so a wildcard never matched
  anything.
- **Negation is now real**: `!keep.txt` re-includes what an earlier rule
  ignored — previously a literal no-op.
- **Leading-slash entries are now active**: `/old.lua` anchors at the rule
  file's directory and matches there — under the old prefix matcher the
  leading slash was part of the literal, so the entry was dead and never
  matched anything.
- **Plain entries are unchanged**: a bare `entry` still matches the file or
  folder of that name at the rule file's own level — a folder with its whole
  subtree (gitignore `entry` + `entry/**`, anchored at that level), never a
  same-name basename deeper down (historical prefix semantics, pinned).
- One documented realization, kept for backward-compat with existing
  fixtures: trailing slashes are still stripped at parse, so a
  trailing-slash entry (`build/`) also excludes a same-level **file** named
  `build` — gitignore's dir-only semantics would not.
- Safety rails unchanged: rules only ever hide or copy-filter — they can
  never hide `mod.info` or the `.pzstudioignore`/`.gitignore` files
  themselves.
- Behavior notes: under the build copy's dot-file option
  (`ignoreDotFiles`), `.pzstudioignore` is exempt from dot-file exclusion
  but `.gitignore` is not — a `.gitignore` is still always **read** as
  rules, it just may not be copied as a file. A changed `.gitignore`
  re-steers ignore handling exactly like a changed `.pzstudioignore`:
  the watch filter reloads its root rules, and a mod-scoped rule change
  re-baselines the owning mod.
- The watch/devsync output protection sits above the rules: events under
  the build output tree (`dist/`) or a deployment root inside the project
  are dropped by the watch layer's own rail before the rule matcher is ever
  consulted — a `dist/**` rule can never own or break that protection.
- No changes to the JSON contract, the exit-code matrix, or the stream
  contract.
- **Materialize boundary gate (data safety)**: an `outdir` equal to the
  project root or lying inside the canonical `dist/` root is now refused
  (`DEPLOY_ROOT_INVALID` — hard error in build/watch, error finding in
  doctor) instead of writing links or copies into the source tree; an
  `outdir` equal to `dist/` itself is pure-build mode (skip +
  `OUTDIR_ALIAS_DIST` info). Watch no longer materializes variants with an
  empty included-mod set (dangling junctions), a locked deployment slot no
  longer erases the doctor's workshop findings (`INSPECT_FAILED` per item),
  and generic copy-slot reconcile failures report `RECONCILE_FAILED` —
  never the healthy `COPY_SLOT` label.

### Extension (pzstudio42)

- The PZ Project Explorer hides entries matched by ignore rules
  (`.gitignore`/`.pzstudioignore`) — the same visual treatment as dot
  entries — with rule-read failures failing open (every child shown). A
  declared mod folder hidden by rules stays "seen": it is hidden, not
  reported as missing on disk.

- **Behavior change: the Development Sync toggle no longer shows success
  popups.** Both information messages — "Development sync started." and
  "Development sync stopped." — are gone; the new status-bar item is the
  run's source of truth. The start-failure toast is kept.
- **New status-bar sync indicator**: a muted `$(circle-slash) DevSync off`
  while off, `$(sync~spin) DevSync: <project folder>` while a run is in
  flight, with a per-phase tooltip (and the last start failure while off).
  Clicking it runs the existing `pzstudio.watch` toggle, gated by the run
  phase — start only from idle, stop while syncing, queued stop while
  starting, no-op while stopping.
- **Queued-stop semantics**: stopping while the initial build is still
  running is honored once the build settles — the just-started session is
  stopped immediately and the indicator lands off (the session does not
  survive the request); stopping while syncing tears the run down, and
  stopping while already stopping or off is a no-op.
- **Re-entrancy hardening**: the DevSyncManager holds the authoritative
  atomic start gate — a start from a non-idle phase now fails honestly
  instead of re-anchoring the in-flight run — and the toggle re-checks the
  phase after the async project picker, so two stacked invocations can no
  longer race into a phantom run.
- **PZ Project Explorer badge** while a sync run is in flight: the view's
  badge shows `1` with a per-phase tooltip naming the project; cleared
  while off.
- **Sync error notifications gain a 'Stop Sync' action** next to 'Show
  Details', safe to click at any time (stops a syncing run, queues during
  start, no-ops otherwise). Other error notifications (doctor, commands)
  are unchanged.
- New indicator strings ship English-only for now — the translation bundles
  gain them (and drop the two retired popup strings) at the next
  translation regen pass.

## [CLI 0.42220.1 / Extension 0.42220.1] - 2026-11-21

### CLI (@pzstudio/cli 0.42220.1) — notes: [`docs/releases/0.42220.1.md`](docs/releases/0.42220.1.md)

- **`--json` envelopes for `build`, `migrate` and `update`**, plus
  `usage export --json` — machine-readable output for the everyday
  commands.
- **migrate hardening**: root-level `authors` are kept (a single
  migrated mod adopts them, otherwise they stay verbatim with a notice)
  and the migrated output is validated before success; `description`
  survives migrate → generate.
- **update hardening**: the legacy template cache and refresh use a
  staged swap — the old copy is removed only after the replacement is
  secured, so an interrupted update never poisons the cache.
- **Copy-mode prune warns with full paths** per pruned file (plus a
  total line) instead of silently deleting hand-edited files.
- **Loud refusals and honest codes**: `add` duplicate refusals exit with
  a typed `CliError`, invalid enum values exit 2 on every path (messages
  name the accepted aliases), `add --yes` is refused, and buildplan
  aggregates name the missing mod.
- **`rename` no longer renames subdirectories carrying the old mod id**
  — it warns with the full path (owner re-decision: user-designed
  skeleton directories are the user's to manage; the game does not
  require them to follow the id).
- **CLI quick-wins**: the `watch` stop message notes the exit-130 path,
  `usage export` acknowledges `--purge`, empty usage-event `meta` is
  omitted, `update` output names the cache directories and end states,
  `clean` enumerates every removed path, `migrate` warns on missing
  required fields, and the deploy docs explain the reconcile stale
  window.

### Extension (pzstudio42 0.42220.1) — changelog: [`packages/vscode-extension/CHANGELOG.md`](packages/vscode-extension/CHANGELOG.md)

- **Success toasts** for `new` / add / clean; `rename` and delete honor
  `pzstudio.confirmBeforeRun` through the shared consent ladder.
- modinfoGenerate injects the project directory context-aware (no more
  "No pzstudio project found" on generated targets); Development Sync's
  watcher gains a self-owned `fs.watch` leg — deliveries no longer stall
  at zero when the project tree appears after setup.

## [CLI 0.42210.3 / Extension 0.42210.3] - 2026-11-09

### CLI (@pzstudio/cli 0.42210.3) — notes: [`docs/releases/0.42210.3.md`](docs/releases/0.42210.3.md)

- **Usage logging** (local-only, nothing is ever uploaded): one NDJSON
  event per command (command name, duration, error code, flag names —
  never paths or values) in `~/.pzstudio/usage/`, on by default and
  announced by a one-time notice; manage with `pzstudio usage status` /
  `off [--purge]` / `export [--out <file>]`. Help/banner invocations
  record nothing — pure invocations stay side-effect-free.
- The first successful `build` prints the project landing-page URL once
  per machine on standalone runs, as a closing note after the completion
  line (`See tips & updates -> <url>`).
- No changes to the JSON contract, the exit-code matrix, or the stream
  contract.

### Extension (pzstudio42 0.42210.3) — changelog: [`packages/vscode-extension/CHANGELOG.md`](packages/vscode-extension/CHANGELOG.md)

- **First-build success popup**: after the first successful `build`, a
  one-time popup offers "See tips & updates" and opens the project landing
  page; localised across all language bundles.
- Bundles engine `@pzstudio/cli` 0.42210.3; `PZ Studio 42` display name
  synced into every locale nls table; the banner loads from the repository
  (VSIX ~497 KB smaller).
- Release channel: **pre-release** (packaged with `--pre-release`).

## [CLI 0.42210.2 / Extension 0.42210.2] - 2026-11-08

### CLI (@pzstudio/cli 0.42210.2) — notes: [`docs/releases/0.42210.2.md`](docs/releases/0.42210.2.md)

- **Stable graduation of the `0.42210.x` line** (channel parity: even patch
  = stable): identical engine content to 0.42210.0, shipped as the first
  bare version on npm `latest` — semver ranges like `^0.42210.0` resolve
  again.
- No changes to the JSON contract, the exit-code matrix, or the stream
  contract.

### Extension (pzstudio42 0.42210.2) — changelog: [`packages/vscode-extension/CHANGELOG.md`](packages/vscode-extension/CHANGELOG.md)

- First **stable-channel** release (packaged without `--pre-release`);
  stable-channel users auto-update onto `0.42210.2` from `0.42200.1`.
- Bundles engine `@pzstudio/cli` 0.42210.2 — identical content to the
  0.42210.0 pre-release.

## [CLI 0.42210.1 / Extension 0.42210.1] - 2026-11-08

### CLI (@pzstudio/cli 0.42210.1) — notes: [`docs/releases/0.42210.1.md`](docs/releases/0.42210.1.md)

- **Pre-release re-stamp** of the `0.42210.0` content (channel parity: odd
  patch = pre-release), rebuilt from tag `0.42210.0` on
  `release/0.42210.1` after the marketplace burned the bare `0.42210.0`
  name on its pre-release channel. Published bare (no `-next` stamp) to
  npm `latest`.
- No code changes; no changes to the JSON contract, the exit-code matrix,
  or the stream contract.

### Extension (pzstudio42 0.42210.1) — changelog: [`packages/vscode-extension/CHANGELOG.md`](packages/vscode-extension/CHANGELOG.md)

- Pre-release channel re-stamp of `0.42210.0` (packaged with
  `--pre-release`); pre-release users auto-update onto `0.42210.1`.
- Bundles engine `@pzstudio/cli` 0.42210.1 — identical content to
  0.42210.0.

## [CLI 0.42210.0 / Extension 0.42210.0] - 2026-11-08

### CLI (@pzstudio/cli 0.42210.0) — notes: [`docs/releases/0.42210.0.md`](docs/releases/0.42210.0.md)

- `pzstudio update` refreshes the global legacy template cache
  (`~/.pzstudio/.template-legacy`) when the bundled templates are newer —
  the stamp is written only after the copy completes; `--force-update`
  bypasses the stamp check.
- Project/mod template targets move to **PZ 42.21.0** (vendored pins and
  runtime defaults; workshop `42.0` / language `42.13.1` unchanged).
- Shipped declarations are self-contained again: internal route-guard
  helpers no longer leak Node's `Dirent` type into the
  `@pzstudio/cli/api` d.ts chain.
- No changes to the JSON contract, the exit-code matrix, or the stream
  contract.

### Extension (pzstudio42 0.42210.0) — changelog: [`packages/vscode-extension/CHANGELOG.md`](packages/vscode-extension/CHANGELOG.md)

- Marketplace display name is now **PZ Studio 42** (the legacy listing keeps
  "PZ Studio"); releases publish on the **pre-release channel**.
- Bundles engine `@pzstudio/cli` 0.42210.0; `PZStudio: Update` surfaces the
  legacy template cache refresh; project/mod template defaults target
  42.21.0.
- The legacy marketplace listing (`escapepz.pzstudio`) receives the same
  engine as a one-off bridge update **2.242170.1**; its listing content is
  replaced by the pzstudio42 README/CHANGELOG pointing at the new listing.

## [CLI 0.42200.2 / Extension 0.42200.1] - 2026-11-07

### CLI (@pzstudio/cli 0.42200.2) — notes: [`docs/releases/0.42200.2.md`](docs/releases/0.42200.2.md)

#### Safety

- **E1 Stage-1 ownership guard**: destinations inside the mod source tree
  (including nested variant layouts) refuse to adopt — delete, replace or
  overwrite — content the engine cannot prove it created. The offending
  content is preserved and reported before any mutation; empty destinations
  still adopt normally. External output roots keep the previous adoption
  semantics as a recorded deviation until the full ownership ledger lands.
- **F23-WRITE alias-route guard**: `build` and `clean` refuse to delete or
  write through a symbolic link or NTFS junction below the configured
  output root (a junction configured **as** the root keeps working). The
  build's copy never re-enters its own destination chain — output roots
  nested inside the source tree no longer self-embed (bounded
  one-generation garbage), including case-variant paths on case-insensitive
  filesystems.

#### Hardening

- Add and Delete preserve the configured raw `outdir` (fail-closed
  snapshots); missing or blank mod IDs are derived safely and
  normalized-empty identifiers are rejected; cancelled prompts abort
  without fallback or engine execution; New Project records the
  destination only after creation is verified on disk.

#### Host API

- `@pzstudio/cli/api` adds the v2 instance surface: `createPzStudio(...)`
  with explicit-context devsync/doctor/modinfo cores and
  `studio.resolveOutDir(projectDir)`. Additive only — legacy exports remain.

### Extension (pzstudio42 0.42200.1)

#### Added

- PZ Project Explorer (inline Build/Clean with confirmation, build-state
  badges, diagnostics finding counts, multi-root resolution), Toggle
  Development Sync, Run Diagnostics with per-project caching and the
  `pzstudio.gameBuild` compatibility check, `pzstudio.openProjectJson` as
  safe remediation for mods missing on disk, 25-language UI with localized
  progress titles, and six new settings (`verbose`, `offline`,
  `forceUpdate`, `build.target`, `gameBuild`, `confirmBeforeRun`).

#### Changed

- Task targets replace `pzstudio.build.target` instead of composing
  conflicting flags; errors are actionable (localized notification with
  **Show Details**); Development Sync pre-filters engine output events —
  filtered drops are reported as one aggregate line at verbose level;
  sync failures surface through the error notification.

#### Fixed

- Project-picker cancel no longer re-prompts or misreports; New Project
  cancel leaves the disk untouched; `--verbose` output reaches the output
  channel; doctor diagnostics are cached per project fingerprint.

### Not in this release

- **No automatic log/record retention or pruning** (C-17 deferred with
  disclosure): logs are retained indefinitely in this version; a future
  retention mechanism will never remove ownership evidence.

## [CLI 0.42200.1] - 2026-10-05

### CLI (@pzstudio/cli) — notes: [`docs/releases/0.42200.1.md`](docs/releases/0.42200.1.md)

- CLI-2 stream contract: `progress → stderr`, `data/result → stdout`;
  `--json` remains a strict `JSON.parse` of stdout; a successful
  `pzstudio build` prints nothing on stdout. Timestamps, colors and the
  `[INFO]` prefix are presentation, not API.
- Packaging: `dist/pzstudio.cmd` no longer ships in the tarball; README
  documents the two pnpm mental models (`dlx` vs `exec`) and the
  `pnpm approve-builds @parcel/watcher` remediation; first-run template
  note (`--offline`).

## [CLI 0.42200.0] - 2026-10-04

### CLI (@pzstudio/cli) — notes: [`docs/releases/0.42200.0.md`](docs/releases/0.42200.0.md)

- Initial public release of `@pzstudio/cli` (binary `pzstudio`). Breaking
  changes: experimental integration features are opt-in
  (`experimental.integration.*` default OFF); embedded `delete`/`rename`
  require `--yes`; usage errors exit 2 while runtime failures exit 1;
  migration/progress output moved to stderr. Node.js 20+ required.

### Extension

- Versioning aligned to the `0.<gameBuild>.<patch>` scheme (`0.42200.0`).
  The extension's changelog in this repository begins at [0.42200.1]; all
  earlier extension history — the `2.242131.x` alpha releases and the
  `2.242170.0` nightly line, written under the original **Project Zomboid
  Studio** project — is archived at
  [`project-zomboid-studio@42.17.0` · CHANGELOG.md](https://github.com/escapepz/project-zomboid-studio/blob/42.17.0/packages/vscode-extension/CHANGELOG.md)
  and is intentionally not carried in this codebase.
