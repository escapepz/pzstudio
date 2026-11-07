# Changelog

All notable changes to the **PZ Studio** VSCode extension will be documented in this file.

> **Archived history.** This changelog records `pzstudio42` in this
> repository, starting at [0.42200.1] — the `0.<gameBuild>.<patch>` version
> line. Everything before that belongs to the original **Project Zomboid
> Studio** project: the `2.242131.x` alpha releases and the `2.242170.0`
> nightly entries are archived — not carried in this codebase — at
> [`project-zomboid-studio@42.17.0` · CHANGELOG.md](https://github.com/escapepz/project-zomboid-studio/blob/42.17.0/packages/vscode-extension/CHANGELOG.md).

## [0.42210.0] - 2026-11-08

### Added

- **`PZStudio: Update` now refreshes the global legacy template cache** (`~/.pzstudio/.template-legacy`): when the bundled templates are newer (version/buildDate stamp), the shared cache is refreshed so new projects pick up current templates. The stamp is written only after the cache copy completes — an interrupted copy never poisons the cache.

### Changed

- Marketplace display name is now **PZ Studio 42** — the legacy `escapepz.pzstudio` listing keeps "PZ Studio"; display names must be unique within a publisher.
- Project and mod template defaults target **PZ 42.21.0** (vendored `.template-project` / `.template-mod` pinned to tag 42.21.0).
- Extension releases publish on the **pre-release channel** (packaged with `vsce --pre-release`).

### Fixed

- Development Sync: the flush path no longer breaks when the verbose logger sink is absent.
- Shipped legacy template copies no longer contain `.git` gitfiles from the template checkouts.

### Safety

- The bundled engine (**`@pzstudio/cli` 0.42210.0**) adds the stamp-gated legacy template cache refresh — see the `@pzstudio/cli` 0.42210.0 release notes.

---

## [0.42200.1] - 2026-11-07

### Added

- **PZ Project Explorer**: tree view mirroring workspace projects and mods with inline Build/Clean (confirmation-gated via `pzstudio.confirmBeforeRun`), build-state badges (`included` / `dev builds only` / `excluded from build`), diagnostics finding counts with tooltip, and multi-root workspace resolution.
- **Toggle Development Sync**: engine-driven incremental sync — saved files apply in order, `mod.info`/`.pzstudioignore` edits re-sync their mod, `project.json` edits trigger a full rebuild; startup failures surface and stop cleanly.
- **Run Diagnostics** quick-pick with per-project diagnostics caching; new `pzstudio.gameBuild` setting enables the `pzBuildCompatibility` check.
- **`pzstudio.openProjectJson`** — safe remediation for mods missing on disk (all destructive actions are hidden for missing mods).
- **25-language UI** with localized progress titles; `pzstudio.language` applies live.
- New settings: `pzstudio.verbose`, `pzstudio.offline`, `pzstudio.forceUpdate`, `pzstudio.build.target`, `pzstudio.gameBuild`, `pzstudio.confirmBeforeRun`.

### Changed

- Development Sync pre-filters engine output events; filtered events are reported as one aggregate line at verbose level — never per-event warnings.
- Task targets replace `pzstudio.build.target` instead of composing conflicting flags.
- Errors are actionable: a localized notification with **Show Details** opens the PZ Studio output channel; verbose runs reveal the channel automatically.
- `PZStudio: Update` refreshes templates without requiring a project.
- Development Sync failures surface through the error notification; a rejected sync pass is reported instead of failing silently.

### Fixed

- Cancelling a project picker no longer re-prompts or misreports — Build/Clean/Update abort cleanly.
- Cancel in New Project leaves the disk untouched (the destination is recorded only after verified creation).
- `--verbose` output reaches the OutputChannel (`[DEBUG]` lines).
- Doctor diagnostics are cached per project fingerprint instead of running a full doctor pass on every rescan.

### Safety

- The bundled engine (`@pzstudio/cli` 0.42200.2) includes the E1 Stage-1 ownership guard (fail-closed destinations inside the mod source tree) and the F23-WRITE alias-route guard on build/clean — see the `@pzstudio/cli` 0.42200.2 release notes.

---

_Based on the original [Project Zomboid Studio](https://github.com/Konijima/project-zomboid-studio)._