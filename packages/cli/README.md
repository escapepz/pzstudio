# `@pzstudio/cli`

Command-line interface for Project Zomboid Studio — effortlessly create and maintain Lua mods with intuitive structuring.

## Requirements

- **Node.js 20 or higher** (`node --version` to check)

## Quick start

Zero-install on any machine with Node 20+:

> On first use, `new` downloads the current templates from GitHub. Use
> `--offline` to scaffold from bundled templates without network access.

```bash
# Create a new mod project (created in the current directory —
# use --path <dir> to choose another location)
npx -y @pzstudio/cli@latest new "My First Mod"
cd <path printed by the command>       # e.g. my_first_mod

# Verify the project is set up correctly
npx -y @pzstudio/cli@latest doctor

# Start the development watcher (rebuilds on file changes)
npx -y @pzstudio/cli@latest watch

# Build the mod once into the configured output directory
# (outdir; default ~/Zomboid/Workshop)
npx -y @pzstudio/cli@latest build
```

While `watch` is running, save any Lua file under `<modId>/42/media/lua/…` —
the watcher prints `- N file(s) synced.` and the build lands in the configured
`outdir`. That summary is your first successful sync.

With pnpm:

```bash
pnpm dlx @pzstudio/cli@latest new "My First Mod"
pnpm dlx @pzstudio/cli@latest doctor
pnpm dlx @pzstudio/cli@latest watch
```

Global install (persists across projects):

```bash
npm install -g @pzstudio/cli
pzstudio new "My First Mod"
```

Pin to a project (recommended for CI reproducibility):

```bash
npm install --save-dev @pzstudio/cli
npm exec -- pzstudio new "My First Mod"

# with pnpm:
pnpm add -D @pzstudio/cli
pnpm exec pzstudio doctor
```

Two pnpm mental models:

- `pnpm dlx @pzstudio/cli …` runs the package **anywhere** — it fetches into
  an ephemeral store and never touches your project. Good for one-off
  commands.
- `pnpm add -D @pzstudio/cli` + `pnpm exec pzstudio …` runs the version
  pinned **where the local dependency is installed**. pnpm resolves binaries
  from the local `node_modules` only — it does not walk up the directory
  tree like npm — so run `pnpm exec` at the install root.

pnpm (v10+) blocks install scripts by default. `@pzstudio/cli` ships the
native `@parcel/watcher` binding used by `pzstudio watch`, so if the watcher
fails to start, approve its build script once:

```bash
pnpm approve-builds @parcel/watcher
pnpm install
```

The approval persists in the project config (`allowBuilds`), so this is a
one-time step per project. Approve only the packages you trust — avoid
`--all`.

## Command mental model

| Command | What it does |
|---------|-------------|
| `pzstudio new <name>` | Scaffold a new mod project (current directory by default) |
| `pzstudio doctor` | Verify project structure and toolchain |
| `pzstudio build` | Build the mod once into the configured `outdir` (default `~/Zomboid/Workshop`) |
| `pzstudio watch` | Watch source files and rebuild on change |
| `pzstudio modinfo` | Generate `mod.info` files for your mods |
| `pzstudio list` | List all discovered projects |

## Troubleshooting

**`pzstudio: command not found`**

Make sure Node 20+ is installed and that npm's global bin directory is on
your `PATH`. Run `npm prefix -g` to find npm's global prefix.

On macOS/Linux, global executables are normally under `<prefix>/bin`.
On Windows, the command shim is normally placed directly under `<prefix>`.

**Project not found / wrong workspace**

Use `-C <dir>` or `--project <dir>` to anchor to a specific project root.

**Offline / no internet**

Use `--offline` with `new` to use cached templates only:

```bash
pzstudio new "My Mod" --offline
```

**Still stuck?**

Run `pzstudio doctor` for a full diagnostics report. Add `--debug` for verbose output, or `--offline` if network access is unavailable.

## Embedding

The CLI surface is also usable as a Node module via `@pzstudio/cli/api`:

```js
const { runCLI, runProjectDoctor, createDevSync, planBuild } = require('@pzstudio/cli/api');

async function main() {
    // Create a project programmatically
    await runCLI('new', ['My Mod'], { flags: ['--offline'] });

    // Run diagnostics from a host (VS Code, custom tools) — doctor takes
    // the project directory, not a mod directory
    const report = await runProjectDoctor('/path/to/project');
}

main();
```
