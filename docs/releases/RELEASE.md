# Release Runbook — `@pzstudio/cli` + extension (`pzstudio42`)

This runbook defines the exact steps to produce, smoke-test, and publish a
new `@pzstudio/cli` release (Steps 0–8) and the matching VS Code extension
release (Steps E1–E3 below), plus the stable graduation flow (Graduate to
stable, Graduation run). Every step is automated or documented; do not
deviate unless the deviation is recorded here.

**Publishes are owner-manual (owner rule 2026-11-08):** the owner runs
`npm publish` (Steps 5 / Graduation run 3), `vsce publish` (E3) and
marketplace web uploads BY HAND, with their own OTP — agents never run a
publish step, with or without an OTP. Agents build, pack, smoke, package,
tag, and verify with read-only registry checks, then hand the owner the
exact commands.

**Branch policy (owner rule 2026-11-11; two-branch topology):** every change
starts and stays on `42.22.0-dev` — strictly linear, direct pushes allowed.
A graduation is ONE PR `42.22.0-dev` → `main` merged with **Create a merge
commit** (one merge node per cycle on `main`; squash is disabled repo-wide,
and Rebase-and-merge is disabled after it silently no-opped on a
re-anchor-shaped PR). Per-cycle stable and `release/*` branches are
retired; old `*-dev` lines are frozen records and must not be deleted.

**Release operations (owner rule 2026-11-11):** releases are prepared ON
the dev worktree (`../pzstudio.worktrees/42.22.0-dev` — resolve `${VERSION}`
from its `packages/cli/package.json`). After the owner's manual test of the
pre-release, merge the `42.22.0-dev` → `main` graduation PR, tag `main`'s
post-merge tip with the bare version, and publish `latest` from `main@tag`
(see Graduation run).

---

## Version model

Two version shapes exist and must not be confused:

- **Logical version (bare, e.g. `0.42210.0`)** — lives in git, `package.json`,
  tags and release notes. It is the release's identity and is reserved for
  **latest-channel builds only** — it is never consumed by the routine
  next-channel flow.
- **Publish version** — the shape of every next-channel build; each build
  gets a fresh unix-seconds timestamp so a failed or burned attempt can
  never block a retry (npm burns an exact version name forever once
  published, even if unpublished afterwards):
  - **npm (CLI)**: semver prerelease `<bare>-next.<ts>`, e.g.
    `0.42210.0-next.1794079070`.
  - **Marketplace (extension)**: the plain bare `${EXT_VERSION}` — the
    gallery requires **exactly three numeric segments** (major.minor.patch,
    each `0..2147483647`, at least one non-zero). Confirmed empirically on
    2026-11-08: `0.42210.0-next.<ts>`, `0.42210.0-<ts>` AND the 4-part
    `0.42210.0.<ts>` were ALL rejected — no stamp of any kind fits in a
    marketplace version. The `--pre-release` flag is what puts the upload
on the pre-release channel. Marketplace versions are consumed only by
**successful** uploads — rejected attempts burn nothing — so a broken
upload that already landed is retried as a REAL bump on the next free
patch of the same parity (Channel parity below), the standard marketplace
practice.

Promotion to `latest` happens by dist-tagging the **verified `-next` build**
(Step 7). Publishing the bare version is a deliberate latest-channel build,
not part of the routine flow.

Marketplace versions are immutable (no unpublish): rejected uploads burn
nothing, and a broken upload that already landed is retried as a REAL bump
that preserves channel parity. After a stable graduation lands, the next
next-channel cycle starts at the next free odd patch.

### Channel parity (odd/even patch — adapted from the VS Code convention)

The official VS Code convention (odd minor = pre-release, even minor =
release) cannot be applied verbatim: the minor segment encodes the PZ game
build and moves only when the game build moves. The convention is therefore
applied to the **patch segment**:

- **Even patch** (`0.42210.2`, `0.42210.4`, ...) — stable/latest channel:
  bare versions published to npm `latest`, marketplace uploads WITHOUT
  `--pre-release`.
- **Odd patch** (`0.42210.1`, `0.42210.3`, ...) — pre-release/next channel:
  marketplace uploads WITH `--pre-release`; the matching npm builds are
  `<bare>-next.<ts>` (the odd bare version itself is never published to npm —
  bare is stable-only).

Versions only increase, and every successful landing burns its number
forever, so the next cycle starts at the next free odd patch after the last
stable. Multiple pre-releases before one graduation skip even numbers
(`.1`, `.3`, then stable `.4`); gaps are normal and intentional. A broken
landed upload retries on the next free patch of ITS OWN parity.

Grandfathered exception: `0.42210.0` landed on the marketplace as a
pre-release before this convention existed (even patch on the pre-release
channel). It stays as-is; parity applies from `0.42210.1` onward.

Transition exception (owner decision 2026-11-08): `0.42210.1` is published
to npm as a BARE build without the `-next` suffix — the clean re-stamp of
the `0.42210.0` content, built from tag `0.42210.0` on branch
`release/0.42210.1`, so the npm `latest` string and the marketplace
pre-release share one version. Strict bare-is-stable-only parity resumes
with the `0.42210.2` graduation.

## Graduate to stable after the owner's manual test

Every release publishes **pre-release first**; graduating to stable is a
separate, deliberate step — never both in one pass:

1. **Publish pre-release.** npm: `${PUB_VERSION}` (`<bare>-next.<ts>`) to
   the `next` tag (Steps 0–6). Marketplace: `${EXT_VERSION}` packaged with
   `--pre-release` (Steps E1–E3). Pre-release is the default channel for
   in-progress versions.
2. **Owner's manual test.** The owner tests the pre-release build; this
   test is the gate before every stable upload. One of its scripts is the
   bridge × `pzstudio42` coexistence check
   ([COEXISTENCE-CHECK.md](COEXISTENCE-CHECK.md)).
3. **Graduate.** Rebuild at the graduation version — the next free EVEN
   patch (Channel parity below) — and upload without the pre-release flag:
   - npm: publish the bare graduation version as a deliberate
     latest-channel build with an explicit `--tag latest` override
     (`publishConfig.tag` is `next`; see Graduation run) — it never
     participates in the routine `-next` flow. When the bare version was
     deleted from npmjs and is burned (Step 7's accepted promote case, e.g.
     `0.42210.0`), graduation cannot reuse that name — it moves to the
     next even patch instead.
   - Marketplace: package the graduation version without `--pre-release`
     and upload to the stable channel (Step E2's stable exception).

Versions are immutable **per version string**: bare and `-next.<ts>` are
distinct strings, so both can exist — on npm the promoted `-next.<ts>`
build on `latest` and a bare stable build never collide. Marketplace
versions are likewise immutable per version string AND per version number
ACROSS channels: confirmed empirically on 2026-11-08, re-uploading a
version that already landed as a marketplace pre-release WITHOUT the flag
does NOT move it to the stable channel — the upload is refused, so a
pre-release burn blocks that version from ever becoming stable. Graduation
therefore always lands on its own (even) version; Channel parity is what
keeps pre-release and stable numbers disjoint so a pre-release burn never
blocks a graduation.

### Graduation run (concrete sequence)

1. Commit the bump of BOTH `packages/cli/package.json` and
   `packages/vscode-extension/package.json` to the graduation version —
   the bump is a COMMITTED release-prep commit (the new release identity),
   unlike the next-channel stamp (Step 0) — together with the changelog
   entries (see CHANGELOG (every release)).
2. CLI Steps 1–4 unchanged (no Step 0 stamp: `package.json` already
   carries the bare version, so `build.json` and the legacy-template
   stamps embed it). Steps 3–4 (isolated smoke, golden) still run — the
   artifact is new. Step 8 does not apply: the tree is supposed to change.
3. Publish the exact tgz with an explicit tag override
   (`publishConfig.tag` is `next`; a bare build must land on latest):
   ```bash
   npm publish "<exact-tgz>" --ignore-scripts --access public --tag latest
   ```
4. Registry smoke: `npx -y @pzstudio/cli@latest --version` prints the bare
   version, and `npm view "@pzstudio/cli@^<previous-bare>" version`
   resolves to it (this finally satisfies `^`-range consumers — the
   tradeoff noted in Step 7).
5. Extension: Step E1 build, Step E2 package WITHOUT `--pre-release`,
   Step E3 publish without the flag; verify the listing shows the
   graduation version NOT flagged Pre-release.
6. Tag `main`'s post-merge tip with the bare graduation version (after the
   `42.22.0-dev` → `main` PR merges with Create a merge commit); the
   GitHub release is marked **Latest** (the cycle's pre-release GitHub
   release stays marked **Pre-release**). Optionally `npm deprecate` the
   cycle's `-next` builds with a pointer at the graduation version.

## Version parameter

Resolve the logical release version from the package once per run and use
`${VERSION}` everywhere below — never hardcode a version into a command:

```bash
VERSION="$(node -p "require('./packages/cli/package.json').version")"
```

Derive the publish version once per run too (all of Steps 0–7 use it):

```bash
TS="$(date +%s)"
PUB_VERSION="${VERSION}-next.${TS}"
```

---

## CHANGELOG (every release)

Every release-prep updates the changelog surfaces BEFORE building — the
VSIX auto-includes `packages/vscode-extension/CHANGELOG.md` (vsce packs it
unless `.vscodeignore` excludes it; the npm tgz carries no changelog — the
npm `files` field stays unchanged):

- **Root `CHANGELOG.md`** — one combined
  `## [CLI <bare> / Extension <bare>] - <date>` entry at the top, linking
  the per-version notes and the extension changelog.
- **`packages/vscode-extension/CHANGELOG.md`** — for every extension
  version, a `## [<EXT_VERSION>] - <date>` entry with `### Added` /
  `### Changed` / `### Fixed` / `### Safety` subsections as needed.
- **`docs/releases/<bare>.md`** — for every CLI version, the per-version
  release notes (H1, summary line, `## What's changed`,
  `## Compatibility`).

The changelog edits are part of the release-prep commit — the same commit
as the version bump. A graduation adds its own stable entry to both
changelogs in the graduation prep commit (Graduation run).

---

## Preflight

Before starting, verify:

- [ ] Submodules are populated in this checkout (`git submodule update --init`) — a fresh worktree ships empty template stubs, and packing one carries an empty `dist/.template-legacy/`: the packlist check still passes (the stamp file is present) while offline `new` fails its smoke with "No valid cached or legacy template found".
- [ ] `npm whoami` — you are logged into the target registry as the `@pzstudio` scope owner.
- [ ] `@pzstudio` scope is writable (you have permission to publish).
- [ ] Target registry is correct (`npm config get registry`).
- [ ] `@pzstudio/cli@<version>` does not already exist on the registry.
- [ ] CHANGELOG entries for this version exist (root `CHANGELOG.md` +
      `packages/vscode-extension/CHANGELOG.md` +
      `docs/releases/<version>.md`) — see CHANGELOG (every release).

---

## Step 0 — Stamp the publish version (next channel)

Next-channel (odd-patch) cycles only — a graduation run skips Steps 0, 5
and 7 and publishes the committed bare version instead (see Graduation
run).

Bump the package to `${PUB_VERSION}` BEFORE building — `build.json` and the
bundled legacy-template stamps embed the version, so everything in the
artifact must carry the same value:

```bash
cd packages/cli
npm version "${PUB_VERSION}" --no-git-tag-version --allow-same-version
```

`package.json` is now intentionally dirty; it is restored in Step 8. The
stamp is a temp edit and is **never committed**.

## Step 1 — Build once

From the repo root:

```bash
pnpm --filter @pzstudio/cli... build
```

This runs, in order:
1. `tsc -p tsconfig.build.json` — type-checks and emits JavaScript + declarations to `dist/`.
2. `node scripts/bundle.js` — esbuild bundles `src/index.ts` → `dist/index.js` and `src/api.ts` → `dist/api.js`. The closure gate asserts `package.json.dependencies` exactly equals the normalized externals set derived from the metafile.
3. `node scripts/update-build-date.js` — stamps `dist/build.json` with the build timestamp.

If the build fails, fix the root cause before proceeding.

---

## Step 2 — Pack once

```bash
node pack-artifact.mjs <release-dir>
```

Where `<release-dir>` is an absolute path to an empty directory.

**Rules:**
- Run exactly once per release. Never run `npm pack` a second time.
- `--ignore-scripts` is always used — no `prepare`/`prepack`/`postpack` may mutate the artifact.
- The exact tarball filename is read from the JSON output. Do not construct it yourself.
- Assert the file exists at the resolved path.

If this step fails, diagnose and rebuild (back to Step 1).

---

## Step 3 — Isolated smoke test

```bash
node pack-smoke.mjs <exact-tgz>
```

This script performs all acceptance gate checks in an **isolated OS temp project** (never under the repo to avoid climbing to ancestor `node_modules`):

- `npm install <exact-tgz>` into the temp project.
- `npm ls --omit=dev` — must be clean (no unmet deps, no extraneous).
- **Metadata:** version matches the source `package.json`; the only runtime dep is `@parcel/watcher`; no `workspace:*` references; no root `main`/`types` (embedders must use `@pzstudio/cli/api`); the packed `LICENSE` matches the repo `LICENSE.md` byte-for-byte.
- **Bin smoke:** `pzstudio --version` and `pzstudio --help` succeed; pure invocation leaves no `~/.pzstudio`.
- **Library smoke:** `require("@pzstudio/cli/api")` returns the API functions; embedded `runCLI("new", ..., { flags: ["--offline"] })` creates a real project from the bundled `/api` surface, and the bin surface does the same (proving `__dirname`-relative resource resolution survives bundling on both entries).
- **Negative smoke:** `require("@pzstudio/cli")` yields `ERR_PACKAGE_PATH_NOT_EXPORTED` — there is no supported package-root library import.
- **Type consumer:** isolated `tsc --noEmit` with `module: NodeNext, moduleResolution: NodeNext, strict: true, skipLibCheck: false` compiles the import from `@pzstudio/cli/api` exit 0.
- **Packlist:** read directly from the exact tarball (`tar -tzf`) — required entries present (including `dist/.template-legacy/` and `dist/vendor/`), no `src/`, `tests/`, `docs/`, `.tmp/`, lockfiles, or tsc intermediate `dist/lib/*.js`.
- The real `~/.pzstudio` is untouched by the whole run (existence sentinel).

If any check fails, diagnose, fix, rebuild (Step 1), pack (Step 2), then re-smoke. Do not repack without rebuilding.

---

## Step 4 — Golden-path smoke (3 HOMEs)

```bash
node pack-golden.mjs <exact-tgz>
```

Installs the exact tarball once and walks the user golden path in three NON-REUSED isolated HOMEs:

- **HOME_A offline:** `new "Offline Smoke" --offline` → `doctor` exits 0.
- **HOME_B online:** `new "Smoke Mod"` → `doctor` → `build` — build resolves the workshop template through the real network path (git clone or zip fetch), with a hard timeout.
- **HOME_C POSIX:** `watch` → banner → touch a Lua source → wait for the sync summary → SIGINT → exit 130 with exactly one `Development sync stopped.` message. Skipped on win32 (SIGINT delivery to children is unreliable there; CI ubuntu/macos verify it).

The workshop template cache in HOME_C is seeded from the tarball's own `.template-legacy` bundle so the watch startup build is hermetic. Every scenario has hard timeouts and the script always terminates the child process trees it spawned, so CI can never hang.

If any check fails, diagnose, fix, rebuild (Step 1), pack (Step 2), re-smoke (Step 3), then re-run the golden smoke. Do not repack without rebuilding.

---

## Step 5 — Publish to `next`

Next-channel (odd-patch) cycles only. A graduation run publishes the bare
tgz with `--tag latest` instead — see Graduation run.

```bash
npm publish "<exact-tgz>" --ignore-scripts --access public --tag next
```

`--ignore-scripts` mirrors the pack step. Publish the **exact bytes** from the tgz — do not rebuild between pack and publish.

If publish succeeds, proceed to Step 6. If it fails:

**On failure DO NOT promote / DO NOT rebuild+republish the same version.**
Published name@version pairs are not reusable, and an unpublished version
name stays burned forever. Fix the root cause, take a **fresh timestamp**
(`TS="$(date +%s)"`, re-derive `${PUB_VERSION}`), then restart at Step 0:
stamp → build → pack → smoke → publish the new `-next` version to `next`.
Optionally `npm deprecate` the failed version. The bare `${VERSION}` is
never consumed by this flow, so it stays available as the release identity.

---

## Step 6 — Registry smoke

Verify the published package works end-to-end via the registry:

```bash
# Via npx (fetches latest next)
npx -y @pzstudio/cli@next --version

# Via pnpm dlx
pnpm dlx @pzstudio/cli@${PUB_VERSION} --version
```

Both must succeed. If either fails, investigate (possible registry CDN lag; retry after 60 s).

---

## Step 7 — Promote `next` → `latest`

```bash
npm dist-tag add @pzstudio/cli@${PUB_VERSION} latest
```

This makes the verified `-next` build the default for
`npm install @pzstudio/cli` without a tag. The bare `${VERSION}` is NOT
published — `latest` intentionally points at the `-next.<ts>` build.

Promoting the existing `-next.<ts>` artifact to `latest` **as-is** is
allowed when the bare version was deleted from npmjs (concrete case:
`0.42210.0`): the name is burned and can never return, so do not rebuild
or republish under the bare version just to make `latest` show a clean
string — the promoted `-next` build is the accepted `latest`.

Known tradeoff (accepted, next-channel cycles only): semver ranges like
`^0.42210.0` never match a prerelease build; range consumers move again
when the graduation publishes the next even-patch bare version (Graduation
run, step 4).

## Step 8 — Restore the logical version

Only AFTER Step 5 (publish) has succeeded:

```bash
cd packages/cli
git checkout -- package.json
node -p "require('./package.json').version"   # must print the bare ${VERSION}
cd ../..
git status --short                             # must be clean
```

The working tree must end the release run exactly as it began — the stamp
and every other release artifact decision live in git history, not in
dirty files.

---

## Tagging

Tag the release-prep commit when the release ships — the tag name records
the **logical (bare) version** and reflects WHAT the release contains:

- **Joint CLI + extension release** (the normal case): bare version —
  e.g. `0.42210.0`.
- **CLI-only release**: `cli-<version>` — e.g. `cli-0.42215.1`.
- Extension-only release (if it ever happens): `ext-<version>` —
  e.g. `ext-0.42215.1`.

Each channel landing gets its own tag: the pre-release cycle tags its odd
bare version (GitHub release marked **Pre-release**), the graduation tags
the even bare version (GitHub release marked **Latest**). Published tags
are never moved or deleted.

## Extension release runbook (`pzstudio42`)

The extension release is coupled to the CLI release: the extension bundles
the engine from `packages/cli/dist` (`@pzstudio/cli/api`), so the CLI build
(Step 1) must exist before packaging. Produce the CLI release first, or at
minimum run the CLI build in the same working tree.

### Version parameter

Resolve the extension version once per run:

```bash
EXT_VERSION="$(node -p "require('./packages/vscode-extension/package.json').version")"
```

### Preflight

- [ ] Publisher `escapepz` publishing rights — a PAT with **Marketplace →
      Manage** scope, or web-upload access at
      <https://marketplace.visualstudio.com/manage>.
- [ ] `escapepz.pzstudio42@<EXT_VERSION>` does not already exist on the
      marketplace (published versions are immutable), is strictly higher
      than the listing's current maximum, and matches Channel parity: an
      ODD patch for a `--pre-release` upload, an EVEN patch for a stable
      upload.
- [ ] **Display-name uniqueness**: the `displayName` resolved from
      `package.nls.json` must be unique within the publisher. The
      marketplace **rejects** an upload whose display name is taken by the
      publisher's other listing ("This extension display name is taken").
      The legacy listing `escapepz.pzstudio` owns `PZ Studio`; the
      `pzstudio42` listing must resolve a different display name.
- [ ] `@types/vscode` is pinned to the `engines.vscode` minimum in
      `packages/vscode-extension/package.json` (vsce packaging requirement;
      see the packaging-restore fix).
- [ ] `homepage` does NOT point at the marketplace — marketplace item URLs
      are rejected at upload ("already in use by another publisher");
      point it at the project repo instead (confirmed empirically
      2026-11-08).

### Step E1 — Build

```bash
pnpm --filter pzstudio42... build
```

Builds the CLI engine first (workspace dependency order), then cleans,
typechecks and esbuild-bundles `dist/extension.js`, and syncs
`.template-legacy/` plus the JSON schemas into the package. If this fails,
fix the root cause before proceeding.

### Step E2 — Package

Package the default pre-release build:

```bash
pnpm --filter pzstudio42 vsce:package --pre-release
```

`--pre-release` remains the default channel for in-progress versions: the
version lands on the marketplace **pre-release channel**, and
stable-channel users are never auto-updated into it.

Stable uploads are allowed as the deliberate exception: package the **bare
committed version** (`${EXT_VERSION}` exactly as committed — no stamp)
**without** the flag — an EVEN patch strictly higher than the listing's
current maximum (Channel parity):

```bash
pnpm --filter pzstudio42 vsce:package
```

The **owner's manual test is the gate** before every stable upload — never
package for, or upload to, the stable channel from a build the owner has
not tested (see [Graduate to stable after the owner's manual test](#graduate-to-stable-after-the-owners-manual-test)).

In both cases the artifact is `pzstudio42-${EXT_VERSION}.vsix` — assert it
exists. No stamping, no manifest surgery: the marketplace accepts exactly
what vsce produces.

### Step E3 — Publish

Either:

```bash
pnpm --filter pzstudio42 exec vsce publish --pre-release -p <PAT>
```

or upload the vsix through
<https://marketplace.visualstudio.com/manage> (publisher `escapepz`). The
vsix carries the channel chosen at Step E2: pre-release by default; for
the stable exception publish without the flag (`vsce publish -p <PAT>`)
and only after the owner's manual test. Verify the listing shows
`${EXT_VERSION}` flagged **Pre-release** (default flow) or without the
**Pre-release** flag (stable exception). A broken upload that already
landed cannot be replaced — fix and retry on the next free patch of the
same parity (Channel parity).

### Rollback

Marketplace versions cannot be replaced or unpublished. Fix the issue, bump
to the next free patch of the same parity (Channel parity) in
`packages/vscode-extension/package.json`, and rerun E1 → E3.

### Legacy-listing bridge (one-off, `escapepz.pzstudio`)

The legacy marketplace listing predates the `pzstudio42` rename and keeps
the `2.242170.x` version line; the marketplace refuses any upload whose
version is not higher than the listing's current one. A bridge update
packages the SAME build under the legacy identity so old-listing users
receive the current engine (its listing content is intentionally replaced
by the pzstudio42 README/CHANGELOG pointing at the new listing):

1. Temporarily edit `packages/vscode-extension/package.json`:
   `name: pzstudio42 → pzstudio`,
   `version: <EXT_VERSION> → 2.242170.<current+1>`, and
   `displayName: "%displayName%" → "PZ Studio"` — the nls token now
   resolves to the NEW listing's display name (`PZ Studio 42`), which the
   marketplace would reject; the bridge must carry the legacy listing's
   own literal display name.
2. Package **directly in the package directory**, WITHOUT `--pre-release`
   (owner decision 2026-11-08: the bridge rides the legacy listing's
   stable channel so its users actually receive it) — the pnpm `--filter
   pzstudio42` selector matches by package NAME, which the temp edit just
   changed, and the `vsce:package` script's `-o` name is for the other
   identity:
   ```bash
   cd packages/vscode-extension
   pnpm exec vsce package --no-dependencies
   ```
3. Revert the manifest immediately — re-edit by hand, **never**
   `git checkout` (the release version bump may be uncommitted) — and
   verify `git diff` shows only the intended version line. The temp edit
   is **never committed**.

Bridge artifacts are exempt from the `-next` scheme: the legacy listing
keeps its `2.242170.x` line and receives stable-channel uploads only.

## Rollback procedure

If a promoted release is broken in production:

1. **Do not rebuild and republish the same version.** Versions are immutable
   once published, and an unpublished name stays burned forever.
2. Fix the issue in the codebase (the logical `${VERSION}` in git does not
   need to move for an npm-side fix).
3. Take a fresh timestamp and re-run Steps 0–8 with the new
   `${PUB_VERSION}`.
4. Re-promote (Step 7).
5. Optionally `npm deprecate @pzstudio/cli@<broken-pub-version> "Fixed in @<new-pub-version>"`.

---

## CI integration

The full pipeline can run in CI with:
- Node 20+ environment.
- Registry credentials via `NPM_TOKEN` env var (for publish).
- Repo checkout with submodules (`git clone --recurse-submodules`).
- No workspace dependencies required at smoke-test time (the tgz is self-contained).
