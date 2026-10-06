# PZ Studio — VS Code Extension Behavior Docs

Behavioral specification and UI/UX audit of the **PZ Studio VS Code extension**
(`packages/vscode-extension`, package id `pzstudio42`), written the same way as
[`docs/cli/`](../cli/README.md): it documents **what the code does today**, not
what a roadmap says it should do.

## Purpose

This suite exists to **verify the current UI/UX before any refactor** of the
extension bridge (`createPzStudio(...)` API v2) or any UX changes. It is:

- a **behavioral spec** — an agent or maintainer should be able to trace any
  UI action to its code path using only these documents;
- a **UI/UX audit** — inconsistencies, gaps and debt found while writing it
  are recorded in [`10-ui-ux-audit-findings.md`](10-ui-ux-audit-findings.md)
  and are **not fixed** in the same pass that documents them.

## Source-of-truth rule

- **Code is the source of truth.** Every behavior claim below was checked
  against the implementation, with `file:line` references where useful.
- **Stream semantics are the CLI contract.** `[INFO]`/timestamps/colors are
  presentation, not API — the docs never rely on them (see
  [`09-embedded-cli-bridge.md`](09-embedded-cli-bridge.md)).
- Where the extension `README.md` and the code disagree, the code wins and the
  drift is recorded as an audit finding (UX-12).
- Where the roadmap (`pzstudio-roadmap-*.md`, private) and the code disagree,
  the code wins.

## Snapshot

- Branch `42.20.0-dev`, behavior documented at revision **`14d60a4`**
  (2026-10-05). This documentation pass itself is an untracked docs-only
  change on top of that revision.
- Extension version `0.42200.0` (`package.json:5`), engine `^1.102.0`.
- Line references are accurate for this revision and may drift afterwards.

## Index

| File | Contents |
| :--- | :--- |
| [`00-overview.md`](00-overview.md) | Architecture map, full command inventory, surfaces, user journeys |
| [`01-activation-and-architecture.md`](01-activation-and-architecture.md) | `activate()` wiring, output channel, watchers, subscriptions, import/bundle graph |
| [`02-project-and-mod-resolution.md`](02-project-and-mod-resolution.md) | How every command finds its project and its mod (extension-side and CLI-side) |
| [`03-project-explorer.md`](03-project-explorer.md) | PZ Project Explorer tree: hierarchy, icons, mod states, refresh, diagnostics badge |
| [`04-command-flows.md`](04-command-flows.md) | Every command flow: inputs, confirmations, flags, bridge calls, error paths |
| [`05-build-clean-and-tasks.md`](05-build-clean-and-tasks.md) | Build/Clean commands vs `pzstudio` task provider, flag precedence, consent |
| [`06-development-sync.md`](06-development-sync.md) | Toggle Development Sync lifecycle: `DevSyncController`, debounce, batching, stop |
| [`07-diagnostics.md`](07-diagnostics.md) | Doctor: shared engine, explorer badge/tooltip, `pzstudio.doctor` quick-pick |
| [`08-configuration-and-localization.md`](08-configuration-and-localization.md) | All `pzstudio.*` settings, config precedence, l10n layers and limits |
| [`09-embedded-cli-bridge.md`](09-embedded-cli-bridge.md) | `@pzstudio/cli/api` contract: embedded `runCLI`, module state, stream mapping |
| [`10-ui-ux-audit-findings.md`](10-ui-ux-audit-findings.md) | Audit findings (UX-01…) with code paths, severity and suggested direction |
| [`12-project-cockpit.md`](12-project-cockpit.md) | Project Cockpit interaction spec v1 — normative UX reference for the planned Cockpit surface (approved design, not current behavior) |

## Current mental model

The extension is a **thin UI over the embedded PZ Studio CLI**:

- One esbuild bundle (`dist/extension.js`) inlines the CLI's **api surface**
  (`@pzstudio/cli/api`) in-process — there is no CLI subprocess (see
  [`09-embedded-cli-bridge.md`](09-embedded-cli-bridge.md)).
- Almost every user command funnels through one runner
  (`createCommandRunner`, `src/util/execute.ts`) that resolves a project,
  translates VS Code settings into CLI flags, shows progress, and calls
  `runCLI(command, args, { flags })`.
- **Global module state in the CLI api** (logger, project anchor, settings
  bridge) is the current dependency glue; the extension sets it and clears it
  on `deactivate()`. This is the main API-v2 (`createPzStudio(...)`) target.
- The PZ Project Explorer mirrors the on-disk layout and carries the inline
  buttons; the doctor quick-pick and the explorer badge consume the **same**
  diagnostics engine as the CLI.
- Development Sync (watch) runs one `BuildSession` from core, driven by a
  VS Code `FileSystemWatcher`, never the CLI's own watcher.
