# 09 — Machine Interface (`--json` + Embedded API)

The CLI offers two non-interactive interfaces for tools and hosts: the `--json` flag on
select commands (machine-readable stdout) and the embedded `runCLI` API (in-process
library use — the VS Code extension's path).

---

## The `--json` envelope (CLI-8)

Commands that opt in print **exactly one JSON envelope on stdout and no human report**:

```json
{
  "schemaVersion": 1,
  "command": "doctor",
  "result": { }
}
```

- Printed pretty (2-space indent) through `log()` → stdout
  (`packages/cli/src/lib/json.ts:34-41`).
- `schemaVersion` is currently **1** (`JSON_SCHEMA_VERSION`).
- The `result` shape is owned by the command; semantic fields only, no prose.

### Failure semantics (pinned by the header comment of `lib/json.ts` and `bin-json.test.ts`)

| Case | stdout | stderr | exit |
|---|---|---|---|
| 1. Command executed and produced a domain result | the envelope; diagnostics only on stderr | error/progress lines | follows the **result** — e.g. `doctor` with blocking issues prints the envelope (`result.status: "error"`) and still exits 1 |
| 2. Runtime failure before a result exists | **empty** — judge with `trim()`; the pinned contract is `stdout.trim() === ''` (`bin-json.test.ts`) | the formatted error | 1 |
| 3. Parser/usage failure | **empty** | the usage error | 2 |

Machine consumers must **not** assume the envelope exists on non-zero exits.

### stdout purity (hard contract)

On any `--json` invocation, stdout carries **no text other than the JSON document and
surrounding whitespace** (the lifecycle prints blank separator lines around dispatch —
whitespace only, which `JSON.parse` tolerates). Plain `JSON.parse(stdout)` is the
supported parsing style — no `trim()`/block-locating heuristics needed. Migration
markers, progress and warnings go to **stderr only**, even when a config migration runs
before the command (`01-root-flow.md`). Pinned by `tests/real-env/bin-json.test.ts`,
including a regression case with a pending config migration.

### Compatibility rule

A schemaVersion 1 patch may only **add optional fields** — never rename, remove, or
reinterpret existing ones. Only a major change moves `schemaVersion` to 2
(`packages/cli/src/lib/json.ts:24-27`).

### `list --json`

The envelope is the *only* stdout content of the command — the human report is skipped.

```json
{
  "schemaVersion": 1,
  "command": "list",
  "result": {
    "title": "Json Project",
    "mods": [
      { "id": "my_mod", "name": "My Mod", "onDisk": true, "excluded": false, "devOnly": false }
    ]
  }
}
```

Fields are plain booleans with the exclusion precedence already applied
(`devOnly` is `!excluded && build.devOnly === true`,
`packages/cli/src/lib/commands/list.ts:36-54`).

### `doctor --json`

The JSON branch runs **before** the human header/report, so stdout stays clean.

```json
{
  "schemaVersion": 1,
  "command": "doctor",
  "result": {
    "status": "ok | warnings | error",
    "projectDir": "<absolute path>",
    "gameBuild": "42.20.1",
    "counts": { "errors": 0, "warnings": 0, "infos": 0 },
    "diagnostics": [
      {
        "severity": "error | warning | info",
        "module": "project | environment | filesystem | templates | mods | buildTarget",
        "code": "mods.missing",
        "message": "...",
        "hint": "..."
      }
    ]
  }
}
```

- `status` is derived from counts: `errors > 0` → `error`, else `warnings > 0` →
  `warnings`, else `ok`.
- `gameBuild` is present only when `--game-build` was passed.
- `hint` is present only when the diagnostic carries one.
- Exit follows the result: `status: "error"` → the envelope is still printed, then the
  command throws → exit 1 (`packages/cli/src/lib/commands/doctor.ts:51-76`).

---

## Embedded API — `runCLI` (the host contract)

```ts
import { runCLI, setProjectDir } from '@pzstudio/cli/api';

setProjectDir(projectDir);                                  // external anchor
await runCLI('delete', [modId], { flags: ['--yes'] });      // never prompts; --yes required
await runCLI('build', [], { flags: ['--verbose'] });        // flags instead of argv
```

`@pzstudio/cli/api` is the only importable surface: the package root is the
executable entry and `require('@pzstudio/cli')` throws
`ERR_PACKAGE_PATH_NOT_EXPORTED` (see `08-mechanics.md` → Embedding API).

### Invocation semantics

- Shape: `runCLI(cmdName?, cmdArgs?, options?: { flags?: string[] })` — `flags` is the
  only option. Passing either a command name or `options.flags` selects the
  **embedded** path: the tokens are structured against the same registry schema the
  executable parser uses (`normalizeLegacyInvocation`) and flow through the same
  `validateInvocation`.
- **Rejects like a promise, never exits the host process.** Runtime failures reject with
  the thrown error; usage failures reject with `CliUsageError`. The host decides exit
  codes/UI. Pinned: a rejected `runCLI` is followed by a successful new invocation in
  the same process (`tests/real-env/bin-contract-gate.test.ts:304-332`).
- **Never prompts** (embedded interaction mode, CLI-9), and destructive commands
  (`delete`, `rename`) **require explicit confirmation intent**: without `--yes` they
  refuse with a `CliUsageError` — `Refusing '<cmd>' without explicit confirmation
  (embedded API). Pass { flags: ['--yes'] } once your host UI has confirmed, or use
  --dry-run to preview.` The host passes `--yes` after its own UI has confirmed, or
  uses `--dry-run` for previews.
- Per-invocation state: verbose/quiet/debug derive from the passed flags; the
  `-C/--project` anchor derives from the `flags` array itself (`--project <dir>` or
  `-C <dir>`; an invocation without that flag clears the anchor). The external anchor
  (`setProjectDir`) and the transport singleton persist until changed.
- Output goes through the logger bridge (`setLogger`) and/or the real streams per the
  stream contract (see `08-mechanics.md`); hosts that capture output can swap the CliIO
  sink in tests.

### Error objects

- `CliUsageError` — usage-level failure; hosts should treat it as input error (exit 2
  semantics).
- `CliError` — domain failure with optional `cause`/`tryHint` fields (exit 1 semantics).
- Anything else — unexpected; render via `formatError(e, {debug})` for the same wording
  the CLI would print (`packages/cli/src/lib/errors.ts`).

### Anchoring and settings

- `setProjectDir(dir | undefined)` sets/clears the external anchor; it must point at (or
  inside) a real project — anchors go through discovery and fail closed
  (`02-project-resolution.md`).
- `setVsCodeSettings(workspace?, user?)` injects editor settings into the config
  resolution chain (workspace above user, both above `config.json`).
- Long-lived hosts report through the direct logger exports
  (`log`/`info`/`warn`/`verbose`) so sync summaries land in the same channel as build
  output.

### What hosts use beyond `runCLI`

The api surface also exposes the pure engines directly, so hosts can bypass argv
entirely: `runProjectDoctor` (diagnostics), `createDevSync` (Development Sync Engine —
the extension's auto-sync uses this instead of the `watch` command), `planBuild`,
`resolveModInfoTargets`, `resolveTemplateDir`, and the transports
(`packages/cli/src/api.ts`).
