# Coexistence check (G-3) — `escapepz.pzstudio` × `pzstudio42` in one profile

Manual gate script. It decides — by observation, not assumption — whether
the legacy bridge listing (`escapepz.pzstudio`) and the current
`escapepz.pzstudio42` listing can be installed **simultaneously in one VS
Code profile**, and how the bridge listing's README notice must be worded.

Run it whenever the coexistence surface changes materially: a new stable
`pzstudio42` upload, a new bridge version on the `2.242170.x` line, or a
change to the extension's command/view/configuration contributions.

## Setup

1. Start from a VS Code profile that has neither extension installed (a
   throwaway profile keeps the daily driver clean).
2. Install both, side by side:

   ```bash
   code --install-extension escapepz.pzstudio@2.242170.1
   code --install-extension escapepz.pzstudio42
   ```

   A plain `--install-extension` installs the **stable** channel — do not
   pass `--pre-release` for this check. The bridge `2.242170.1` rides the
   legacy listing's stable channel (owner decision recorded in
   [RELEASE.md](RELEASE.md#legacy-listing-bridge-one-off-escapepzpzstudio)).
   If the `@<version>` form is not supported by the installed `code` CLI,
   download the exact version's vsix from the marketplace web UI and
   install it from the file instead.
3. Open a real PZ Studio project workspace (a folder containing
   `project.json`) so both extensions activate.

## Expected observations

Coexistence is expected to work, with these visible caveats — record each
one as observed:

- **Duplicate `pzstudio.*` command ids in the palette.** Both extensions
  contribute the same command ids (`pzstudio.new`, `pzstudio.build`,
  `pzstudio.doctor`, ...). Expect each id to appear twice — once per
  extension's title. Which copy actually handles an invocation is not
  readable from the palette; if a command misbehaves, check the
  **Extension Host** output channel and record which extension served it.
  (If the palette deduplicates the entries instead, record that.)
- **Two tree views.** Two `pzstudio` activity-bar containers, each with
  its own `pzstudio.projectExplorer` view — one per extension.
- **Shared settings keys.** The `pzstudio.*` configuration keys
  (`pzstudio.verbose`, `pzstudio.outdir`, `pzstudio.templates.*`, ...) are
  not namespaced per extension id: both extensions contribute and read the
  same keys, so every `pzstudio.*` setting holds a single shared value —
  last writer wins per setting. Changing a value "for one extension"
  changes it for both.

## Verdict rule

- **Supported with caveats** — all of these hold:
  - Both extensions activate with no Extension Host errors.
  - Both tree views render and populate from the workspace's
    `project.json`.
  - Commands execute (from either copy) and the engine behaviors
    (`doctor`, `build`, `watch`) work.
  - The shared-settings last-writer-wins behavior surprises but does not
    break: no setting change leaves either extension in a broken state.
- **Must uninstall the old extension first** — any of these:
  - Extension Host activation errors naming either extension or a
    duplicate registration.
  - A `pzstudio.projectExplorer` view fails to render or populates
    wrongly.
  - Command invocations resolve to the old engine and fail or break the
    new one's behavior.
  - A shared settings value leaves either extension unusable.

## What this feeds

The bridge update replaces the legacy listing's content with the
pzstudio42 README/CHANGELOG pointing at the new listing (see
[RELEASE.md](RELEASE.md#legacy-listing-bridge-one-off-escapepzpzstudio)).
The notice's wording in that README is this check's verdict:

- *Supported with caveats* → the notice says both listings can be
  installed side by side and lists the caveats above.
- *Must uninstall the old extension first* → the notice instructs
  uninstalling `escapepz.pzstudio` before installing or updating
  `escapepz.pzstudio42`.
