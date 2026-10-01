# `@pzstudio/cli`

Command-line interface for Project Zomboid Studio — effortlessly create and maintain Lua mods with intuitive structuring.

## Requirements

- **Node.js 20 or higher** (`node --version` to check)

## Quick start

Zero-install on any machine with Node 20+:

```bash
# Create a new mod project (prompts for workspace directory)
npx -y @pzstudio/cli@latest new "My First Mod"

# Verify the project is set up correctly
npx -y @pzstudio/cli@latest doctor

# Start the development watcher (rebuilds on file changes)
npx -y @pzstudio/cli@latest watch

# Build the mod once (pack to Media/scripts.zip)
npx -y @pzstudio/cli@latest build
```

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
npx pzstudio new "My First Mod"
```

## Command mental model

| Command | What it does |
|---------|-------------|
| `pzstudio new <name>` | Scaffold a new mod project interactively |
| `pzstudio doctor` | Verify project structure and toolchain |
| `pzstudio build` | Build the mod once to `Media/scripts.zip` |
| `pzstudio watch` | Watch source files and rebuild on change |
| `pzstudio modinfo` | Inspect or patch `mod.info` fields |
| `pzstudio list` | List all discovered projects |

## Troubleshooting

**`pzstudio: command not found`**

Make sure Node 20+ is installed and your `PATH` includes npm's global bin directory. Run `npm bin -g` to find it.

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

// Create a project programmatically
runCLI('new', ['My Mod'], { flags: ['--offline'] });

// Run diagnostics from a host (VS Code, custom tools)
const report = await runProjectDoctor({ projectDir: '/path/to/mod' });
```
