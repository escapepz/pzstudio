# PZStudio CLI — Command Flow Reference

This directory documents the complete execution flow of `pzstudio` CLI commands,
including all decision branches, error paths, and state transitions. Code details are
intentionally omitted; see source files for implementation.

Described contract: the post-MVP parser/streams/errors/safety architecture
(Commander parser, stream contract, structured error model, fail-closed discovery,
exit matrix 0/1/2/130, machine JSON, consent gate, experimental opt-in) — commits
`6c8a58d`..`28da5fe` on `42.20.0-dev`.

Files in this directory:
- `00-overview.md` — Four-layer architecture, command inventory, global flags, exit codes
- `01-root-flow.md` — Invocation paths (executable + embedded), pure invocations, lifecycle
- `02-project-resolution.md` — Fail-closed project discovery, `-C/--project` anchor, config hierarchy
- `03-template-resolution.md` — Template cache, transport, official-only legacy fallback
- `04-commands.md` — Per-command flows: new, add, build, watch, clean, delete, rename, ...
- `05-mod-state-machine.md` — Build state transitions: include → dev-only → exclude
- `06-error-taxonomy.md` — CliError / CliUsageError / unexpected, Problem/Cause/Try rendering
- `07-config-files.md` — File-based state: project.json, config.json, .pzstudioignore
- `08-mechanics.md` — Cross-cutting: stream contract, consent gate, SIGINT, experimental
  opt-in hook, embedding API
- `09-machine-interface.md` — `--json` envelope contract v1 and the embedded `runCLI` API
  for hosts (VS Code extension)
