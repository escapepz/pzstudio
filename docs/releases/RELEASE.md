# Release Runbook — `@pzstudio/cli`

This runbook defines the exact steps to produce, smoke-test, and publish a
new `@pzstudio/cli` release. Every step is automated or documented; do not
deviate unless the deviation is recorded here.

---

## Preflight

Before starting, verify:

- [ ] `npm whoami` — you are logged into the target registry as the `@pzstudio` scope owner.
- [ ] `@pzstudio` scope is writable (you have permission to publish).
- [ ] Target registry is correct (`npm config get registry`).
- [ ] `@pzstudio/cli@<version>` does not already exist on the registry.

---

## Step 1 — Build once

From the repo root:

```bash
pnpm build --filter @pzstudio/cli
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
- **Bin smoke:** `pzstudio --version` and `pzstudio --help` succeed; pure invocation leaves no `~/.pzstudio`.
- **Library smoke:** `require("@pzstudio/cli/api")` returns the API object; embedded `runCLI("new", ..., { flags: ["--offline"] })` creates a real project from the bundled `/api` surface (proving `__dirname`-relative resource resolution survives bundling).
- **Negative smoke:** `require("@pzstudio/cli")` yields `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- **Type consumer:** isolated `tsc --noEmit` with `module: NodeNext, moduleResolution: NodeNext, strict: true` compiles the import from `@pzstudio/cli/api` exit 0.

If any check fails, diagnose, fix, rebuild (Step 1), pack (Step 2), then re-smoke. Do not repack without rebuilding.

---

## Step 4 — Publish to `next`

```bash
npm publish "<exact-tgz>" --ignore-scripts --access public --tag next
```

`--ignore-scripts` mirrors the pack step. Publish the **exact bytes** from the tgz — do not rebuild between pack and publish.

If publish succeeds, proceed to Step 5. If it fails:

**On failure DO NOT promote / DO NOT rebuild+republish the same version.** Published name@version pairs are not reusable. Fix the root cause, bump the patch version (e.g. `0.42200.1`), then rebuild → pack → smoke → publish the new version to `next`. Optionally `npm deprecate` the failed version.

---

## Step 5 — Registry smoke

Verify the published package works end-to-end via the registry:

```bash
# Via npx (fetches latest next)
npx -y @pzstudio/cli@next --version

# Via pnpm dlx
pnpm dlx @pzstudio/cli@0.42200.0 --version
```

Both must succeed. If either fails, investigate (possible registry CDN lag; retry after 60 s).

---

## Step 6 — Promote `next` → `latest`

```bash
npm dist-tag add @pzstudio/cli@0.42200.0 latest
```

This makes the version the default for `npm install @pzstudio/cli` without a tag.

---

## Rollback procedure

If a promoted release is broken in production:

1. **Do not rebuild and republish the same version.** Versions are immutable once published.
2. Fix the issue in the codebase.
3. Bump the patch version in `packages/cli/package.json`.
4. Follow Steps 1–6 with the new version.
5. Optionally `npm deprecate @pzstudio/cli@<broken-version> "Fixed in @<new-version>"`.

---

## CI integration

The full pipeline can run in CI with:
- Node 20+ environment.
- Registry credentials via `NPM_TOKEN` env var (for publish).
- Repo checkout with submodules (`git clone --recurse-submodules`).
- No workspace dependencies required at smoke-test time (the tgz is self-contained).
