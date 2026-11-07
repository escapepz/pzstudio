# 06 — Error Taxonomy and Exit Behavior

## Error handling model

```
command run() throws
  → runCLI() catch: error(e)   (formatError → [ERROR] line on stderr)
  → rethrows (library contract — never process.exit here)
  → bin index.ts catch: process.exit(CliUsageError ? 2 : 1)

Embedded hosts: the same throw arrives as a rejected promise from runCLI();
the host process is never killed and no exit code is set by the library.

Success → no exit code set → 0
watch SIGINT → exitCode 130 (set by the watch command itself)
```

`packages/cli/src/lib/cli.ts:109-121` (log + rethrow) and
`packages/cli/src/index.ts:5-9` (the only `process.exit`).

## The three error classes (CLI-3)

| Class | Exit | Rendering by `formatError()` | Examples |
|---|---|---|---|
| `CliUsageError` (`lib/parser.ts:77-85`) | **2** | message only — no stack, no hint. Parse-level errors carry `alreadyReported` (Commander printed the detail); the caller logs nothing extra | unknown command/flag, arity violations, bad choice value, mutually exclusive options, unknown help topic, destructive refusal in non-interactive or embedded sessions |
| `CliError` (`lib/errors.ts:11-26`) | **1** | with `cause`/`tryHint`: a `Problem:` / `Cause:` / `Try:` block (continuation indented 8 spaces to align under `[ERROR] `); without them: the bare problem text. **Never a stack, never a `--debug` hint** — the block is already the guidance | `No pzstudio project found.`, `No project was created.`, `Aborted. Nothing was changed.`, `Refreshed X/4 template caches ...` |
| everything else (plain `Error`, non-Error) | **1** | wrapped as `Unexpected error: <message>` plus `Run with --debug for the full stack trace.`; with `--debug` the full stack replaces the hint | bugs, unconverted throw sites, `lang` stub |

`formatError` is pure (`packages/cli/src/lib/errors.ts:43-71`); `logger.error()` feeds it
and owns the `[ERROR] ` prefix, timestamp and color. The `--debug` flag reaches it via
`setDebug()` wired from the parsed invocation (not `process.argv`).

### Rendered examples (exact strings, pinned by real-env tests)

Structured with Cause/Try (`tests/real-env/bin-error-contract.test.ts:45-49`):

```
[ERROR] Problem: Mod 'missing_mod' not found in project.json!
        Cause: project.json only lists mods registered with pzstudio add.
        Try: Run 'pzstudio list' to see the mods of this project.
```

Unexpected without `--debug`:

```
[ERROR] Unexpected error: ENOENT: no such file or directory, ...
        Run with --debug for the full stack trace.
```

Usage error (message only):

```
[ERROR] Unknown command [definitely-not-a-command]. Did you mean one of: ...?
```

## Failure semantics for `--json` invocations (CLI-8)

The envelope does not change the exit matrix — it only changes stdout. Full contract in
`09-machine-interface.md`; the three cases:

1. Command produced a result → envelope on stdout; exit follows the **result**
   (`doctor` with blocking issues prints the envelope and still exits 1).
2. Runtime failure before a result → stdout stays **empty**, stderr carries the error,
   exit 1.
3. Usage failure → stdout stays **empty**, stderr carries the usage error, exit 2.

## Error message reference (verified against current sources)

| Error | Thrown by | Message shape | Notes |
|---|---|---|---|
| `ArgTypeError` | `expect()` | `Expected param [x] to be 'string', but got 'number'` | positionals are raw strings |
| Unknown command | parser | `Unknown command [x]. Did you mean one of: ...?` | exit 2; suggestion = shared-character heuristic |
| Unknown option | parser / Commander | `Unknown option '--x'.` (embedded path) or Commander's own usage text (`alreadyReported`) | exit 2 |
| Arity violation | `validateInvocation` | `Missing required argument '<name>' for command [cmd].` / `Too many arguments for command [cmd] (expected at most N, got M).` | exit 2 |
| Invalid choice | `validateInvocation` | `Invalid --transport value 'x' (expected one of: git, fetch).` | exit 2 |
| Destructive refusal | `confirmDestructive` | `Refusing '<cmd>' without confirmation in a non-interactive session. Try: pzstudio <cmd> <args> --yes` | `CliUsageError`, exit 2 |
| User declined | `confirmDestructive` | `Aborted. Nothing was changed.` | `CliError`, exit 1 |
| Not in a project | discovery + 9 guards | `No pzstudio project found.` + Cause `Searched from '<start>' ...` + Try `pzstudio new ... / -C <dir>` | `CliError`, exit 1 |
| `new` transaction failed | `new` | `No project was created.` + original message as Cause | staging removed, destination untouched |
| Project parse | `readProjectConfig` | `Failed to parse 'project.json': <reason>. Fix the JSON syntax and try again.` | corrupt ≠ missing |
| Project validation | `readProjectConfig` | `Validation failed for project.json:\n<errors>` | schema errors listed |
| Mod not found | delete/rename/modinfo/modconfig | delete: `Mod 'x' not found in project.json!` (+ Cause/Try); rename: `Mod 'x' does not exist!` (+ Try); modconfig: `Mod 'x' is not in project.json. Known mods: ...`; modinfo: `Mod [x] not found in project.json` | fail-fast before disk access |
| Mod/folder exists | new/add/rename | `... already exists!` | preflight before mutation |
| Invalid mod id | new | `Cannot derive a valid mod id from 'x': ...` | `formatTitleToId` returned '' |
| Template resolution | `resolveTemplateDir` | `No default template defined for category 'x'` / `Failed to resolve template ...` | community URLs get no legacy fallback |
| Outdir invalid | outdir | `The output directory "x" does not exist.` / `"x" is not a directory.` (+ Try hints) | structured |
| Output locked | `removeDirRecursive` | `Cannot delete 'x' — the folder is in use by another program (the game, Steam, or Explorer). Close it and try again.` | ENOTEMPTY/EBUSY/EPERM/EACCES after 5 retries |
| Conflicting flags | `validateInvocation` (registry `conflicts`) | `Conflicting options: --production cannot be combined with --development.` | `CliUsageError`, exit 2; shared by build/watch and both hosts |
| Unknown help topic | `helpCmd` | `Unknown command [x]. Did you mean one of: ...?` | `CliUsageError`, exit 2 — same shape as the parser's unknown command |
| Doctor blocking issues | doctor | `Doctor found N blocking issues. See the report above.` | report + `✗` verdict already on stdout |
| Update partial failure | update | `Refreshed X/4 template caches — N update(s) failed. Fix the reported causes and run 'pzstudio update' again.` | all 4 categories still attempted |
| Aggregate variant failure | build | collected variant errors joined (via `throwOnOutcomeFailures`) | no more `Unexpected error:` wrapper |
| Not implemented | lang | `Not implemented yet!` (rendered through the unexpected wrapper) | hidden stub |

## Warning (non-fatal) situations

Warnings print to stderr (`[WARN]`, yellow on TTY) and never change the exit code:

| Where | Warning |
|---|---|
| build | All mods are dev-only or excluded — nothing to build for the main workshop output (outcome recorded as warning; old output kept) |
| build | Dev-only mods skipped in the main build: `<ids>` (names listed) |
| build/watch | All mods are excluded — nothing to build for the dev_branch workshop output |
| watch | Per-batch apply errors (session keeps running); watcher transport errors |
| templateManager | Community template not verified by PZStudio; cache invalid → re-cloning; refresh failed → re-cloning |
| templateManager | Falling back to offline legacy template (official templates only) |
| new/add scaffolding | Failed to create junction → falling back to copy; failed to remove staging directory (original error preserved) |
| readProjectConfig | `[MIGRATION] project.json needs migration: <reason>` (then migrates in memory) |
| readGlobalConfig | `Validation failed for global config <name>: ...` + `Continuing with in-memory defaults.` |
| update | `Failed to update <category> template: <message>` (failure outcome recorded) |
| delete | Mod folder not found, skipping (config entry still removed) |
| modinfo | Skipping existing mod.info (use --force) |
| experimental scripts | `Failed to run experimental script: <e>` (only reachable when opted in) |
| `new` failure cleanup | `Failed to remove staging directory '...'` (cleanup failure never masks the original error) |

## Friendly-error design rules

1. **Usage errors are exit 2 and message-only**; runtime failures are exit 1 with as much
   guidance as the error class carries.
2. **Never raw-fs a user**: ENOENT/EPERM bubbles are wrapped with the path and a suggested fix.
3. **Corrupt ≠ missing**: a corrupt project.json throws a parse error; a missing one means
   "not in a project" (fail-closed — no silent wrong-directory operation).
4. **Fail fast before mutating**: existence/conflict checks and the consent gate run before
   any file write; `--dry-run` runs before the gate and mutates nothing.
5. **Validate before write**: modconfig and the `new` staging commit validate the edited
   config before it can reach disk.
6. **Partial failures are collected, not raced**: build variants, clean passes and update
   categories each attempt everything, then the aggregate outcome decides the exit code.
7. **Locks are retried**: directory removal retries 5 × 200 ms before surfacing the
   "folder is in use" error.
8. **Stack traces are opt-in**: only `--debug` shows a stack, and only for unexpected errors
   (structured errors never leak one).

## Exit code reference

| Code | When |
|---|---|
| 0 | command completed — including warnings-only results (`doctor` warnings, build variant skips, `clean` with nothing to clean) |
| 1 | any runtime failure: thrown `CliError` or unexpected error (bin entry); `doctor` with ≥ 1 error finding; `update` with any failed category |
| 2 | `CliUsageError`: unknown command/flag, arity, bad choice value, mutually exclusive options, unknown help topic, destructive refusal in a non-interactive or embedded session without `--yes` |
| 130 | SIGINT during `watch`: one `Development sync stopped.` message, cleanup, exit |

Only `watch` handles SIGINT (there is no global handler in `runCLI` since CLI-6); short
commands die by the default Node signal behavior, and the shell still reports 130 by
convention. On Windows the SIGINT path cannot be exercised reliably locally — it is pinned
by POSIX-only real-env tests and verified on ubuntu/macos CI.
