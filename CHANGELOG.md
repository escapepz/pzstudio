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
