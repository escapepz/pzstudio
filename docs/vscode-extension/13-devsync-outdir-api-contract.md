# 13 — Authoritative DevSync Outdir Contract (Q3)

**Design-only pass.** Originally written at HEAD
`c34878c814bfedce22920c0164da094b37862a9f`; **hardened in a Q3 review
revision at HEAD `25af2b5cc39a9b9e89f2fb295e7ddacfee2d31c2`** (branch
`42.20.0-dev`, tree clean; the only commit between the two is the docs
commit that introduced this file, so every file:line reference is valid at
both). No production source, test, manifest or dependency was touched for
this document; the only artifact is this file. Every claim below was
verified against the implementation — file:line references are to HEAD.

> **Q3 hardening revision (what changed).** The review corrected four
> classes of claim, all tightened *against* the recommendation, not away
> from it: (A) temporal consistency — the document previously implied the
> two configuration reads at startup are effectively one snapshot and that
> per-flush re-resolution could follow the session; both are now stated
> precisely (§4, §6.2, §12); (B) unsafe-root containment — the behavior of
> `isWatchPathIgnored` under outdir configurations that contain the project
> root is now analyzed case-by-case and pinned by acceptance gates (§3.1);
> (C) double-resolution semantics — the two reads are documented as
> non-atomic with explicit equality/divergence/failure contracts (§6.2,
> §7); (D) API/type compatibility — corrected against the actual package
> versioning scheme and the optionality of `IProjectConfig.outdir` (§6.1,
> §8). The recommendation itself (Option B, startup-snapshot policy) is
> unchanged; it remains a recommendation, not an approval.

This document resolves **Q3** from
[`12-project-cockpit-migration-matrix.md`](12-project-cockpit-migration-matrix.md)
(§3 UX-09, §4 open questions): *how the extension obtains the session's
effective outdir for `isWatchPathIgnored` without duplicating outdir-tier
logic*. It unblocks **UX-R0.8 (UX-09 — DevSync watcher pre-filtering)**.

> **Status note (normative for reviewers).** This document *recommends* one
> public API addition. Recommendation is not approval: the v2 surface
> (`PzStudio`) has been frozen since doc 11 commit 12, and per the Q3 record
> "a CLI API change … is requiring its own decision — not smuggled into a UX
> fix". Implementation of UX-09 must not begin until this contract is
> explicitly accepted. **UX-09 remains blocked pending that approval.**

Companion reading: [`10-ui-ux-audit-findings.md`](10-ui-ux-audit-findings.md)
UX-09, [`12-project-cockpit-migration-matrix.md`](12-project-cockpit-migration-matrix.md)
§3/§4 (Q3), [`11-api-v2-migration-plan.md`](11-api-v2-migration-plan.md)
§8.0/§10/§13 (isolation R0/R1, settings model, legacy compatibility),
[`06-development-sync.md`](06-development-sync.md) (feature behavior).

---

## 1. Current source call graph (verified)

### 1.1 How the engine resolves its output root

One core serves all three hosts (`pzstudio watch`, the extension auto-sync,
API v2 instances — `packages/cli/src/lib/devsync.ts:1-7`):

```text
studio.createDevSync(projectDir)                       studio.ts:208-228
  → createDevSyncCore(projectPath, deps, options)      devsync.ts:64-98
      host.getPlanInput():                             devsync.ts:71-88
        settings   = resolveDep(deps.settings)         devsync.ts:72
                   (v2: () => provider({ projectDir }) — studio.ts:215-218,
                    invoked on EVERY plan input → UX-05 resource-scoped
                    snapshot, settings.ts:108-114)
        io         = { logger: deps.logger }           devsync.ts:73
        config     = resolveProjectConfigFor(          devsync.ts:74
                       projectPath, settings, io)      helper.ts:297-322
                       ├─ findProjectRoot(dir)         helper.ts:372-385
                       │    (walk up → nearest project.json, fail-closed
                       │     CliError — helper.ts:303-308)
                       ├─ readProjectConfig(...)       helper.ts:309
                       │    (migrate → validate → applyProjectDefaults,
                       │     helper.ts:457-501; throws on invalid JSON)
                       ├─ readGlobalConfig(false, io)  helper.ts:312
                       └─ outdir: getOutDir(project, global, {   helper.ts:314-321
                            projectDir: start, settings, logger })
      → gatherPlanInput(projectPath, config, template) devsync.ts:87,
                                                        helper.ts:836-858
session (BuildSession, core)                           buildsession.ts:337-341
  start(variants):   planInput = await host.getPlanInput()   buildsession.ts:365
                     (BASELINE — private, never re-exposed)
  apply(deltas):     classifyDelta(delta, this.planInput)     buildsession.ts:460
    project.json delta   → doFullRebuild → FRESH getPlanInput  470-472, 543-551
    mod.info/.pzstudioignore → scoped rebuild → FRESH input    518-537
    plain mod-file batch → baseline reused (no re-read)
  writes: resolveBuildOutputPath(config, variant)              buildplan.ts:119-128
          = joinPosix(config.outdir!, title [+ ' - dev_branch'])
```

The write root is therefore `planInput.config.outdir` — the value
`resolveProjectConfigFor` produced, already absolute
(`getOutDir` `resolve()`s every tier).

### 1.2 How the CLI watch filters

```text
watchCmd()                                             commands/watch.ts:39-175
  projectConfig = resolveProjectConfig()               watch.ts:40  (ONCE)
  outDir        = projectConfig.outdir!                watch.ts:57  (ONCE)
  session       = createDevSyncForEngine(projectPath)  watch.ts:69
  await session.start(variants)                        watch.ts:73
  subscribe(projectPath, events => {                   watch.ts:116-150
      isWatchPathIgnored(projectPath, outDir, event.path) → skip   watch.ts:124
      schedule(type, event.path)
  }, { ignore: [outRel, outRel + '/**'] })             watch.ts:142-148
```

The CLI's filtering root **and** the native watcher exclusion are frozen at
command start. The engine inside still re-resolves config on every plan
input (§1.1) — the CLI lives with that mismatch by construction.

### 1.3 How the extension feeds events today

```text
DevSyncController.start(projectDir)                    util/devsync.ts:47-74
  session = studio.createDevSync(projectDir)           devsync.ts:53
  await session.start(['main', 'development'])         devsync.ts:54
  watcher = createFileSystemWatcher(RelativePattern(   devsync.ts:56-58
                projectDir, '**/*'))                    — no path exclusion
  onDidCreate/Change/Delete → schedule(type, fsPath)   devsync.ts:59-61
schedule(): pending.push; debounce flush               devsync.ts:95-107
flush(): session.apply(batch)                          devsync.ts:109-125
```

**No filtering of any kind** — every event under the project (including
`Output/...`, `.git/...` writes) becomes a `FileDelta` fed to
`session.apply`. Core classification absorbs most of it
(`classifyDelta`, `buildsession.ts:129-223`: dot entries, non-mod folders,
excluded mods) — but it has **no outdir rule**, so output written *inside a
mod folder* feeds the engine its own writes (UX-09's loop case), and
otherwise every output event costs a full apply pass.

---

## 2. Verified blocker

The prior audit's chain —
`createDevSyncCore → getPlanInput() → resolveProjectConfigFor() → getOutDir()
→ effective outdir` — is **confirmed** (§1.1 references). Each subordinate
claim, re-verified at HEAD:

| Claim | Verdict | Evidence |
| :--- | :--- | :--- |
| `getOutDir` implements five precedence tiers | **Confirmed** | `helper.ts:677-713` (scope form, lines 689-712): project config → workspace host layer → user host layer → global config → `~/Zomboid/Workshop` default |
| `BuildSession` owns its plan input internally | **Confirmed** | `private planInput` (`buildsession.ts:339`); no accessor, no status event, no phase enum (matrix §1 "DevSync engine surface") |
| The extension can access `isWatchPathIgnored` | **Confirmed** | Exported from `api.ts:67-71` (`watch-shared.ts:36-57`); re-exported by the watch command (`watch.ts:33-37`) |
| The extension has no authoritative effective-outdir reader | **Confirmed** | No outdir resolver on the api surface (grep of `api.ts`: only the pure `resolveBuildOutputPath` core re-export); the extension never reads `outdir` (grep of `packages/vscode-extension/src`); `runProjectDoctor` resolves outdir internally (`doctor.ts:65-83`) and `DoctorReport` does not expose it (`core/src/doctor.ts` — diagnostics embed the path only in message text) |
| CLI watch resolves its output root when starting | **Confirmed** | `watch.ts:40,57` — once per command |
| DevSync can request fresh plan input on each apply | **Confirmed, with precision** | `getPlanInput` is re-invoked on `rebuild()`, `project.json` full rebuilds and `mod.info`/`.pzstudioignore` scoped rebuilds (`buildsession.ts:379,545,519`); plain mod-file batches reuse the baseline (`buildsession.ts:453-514`) |

Additional verified facts the design rests on:

- `resolveProjectConfigFor` has exactly **one** production caller — the
  DevSync plan input (`grep`: `devsync.ts:74`). It is the DevSync-specific
  resolver, R1-clean by construction (explicit `dir` + `settings` + `io`,
  never ambient, never the anchor — `helper.ts:287-296`).
- Settings freshness per plan input is pinned:
  `tests/unit/extUtilDevSync.test.ts:418-497` ("resolves settings per plan
  input: S1 → S2 without recreating the session…") — the provider is called
  with `{ projectDir }` on every plan input and a settings swap moves the
  write root to the new outdir on the next full rebuild, same session.
- Resource-scoped settings (UX-05, commit `330324a`) are resolved
  extension-side in `readLayerSnapshot` (`settings.ts:30-91`): folder tier
  composes in front of the workspace tier for the project's own resource.
  The plan input inherits this automatically through the provider.
- The extension's watcher call has **no path-exclusion parameter**
  (`devsync.ts:56-58` — `createFileSystemWatcher(pattern)` takes only
  event-type toggles). Unlike the CLI's parcel `ignore` (`watch.ts:142-148`),
  event-level filtering is the only exclusion mechanism PZ Studio owns
  (editor-side defaults such as `files.watcherExclude` are user-controlled,
  not a contract).

---

## 3. Effective outdir precedence (normative, unchanged)

The contract must reproduce exactly this tier order — which it does by
**delegating**, not re-implementing (see §6):

```text
1. project.json outdir        resolved against the project root
                              (resolve(scope.projectDir, project.outdir))
2. workspace host layer       provider(ctx).workspace.outdir   ← folder tier
                              (extension: workspaceFolderValue ?? workspaceValue,
                               settings.ts:76-79 — UX-05)
3. user host layer            provider(ctx).user.outdir        (globalValue)
4. global CLI config          ~/.pzstudio/config.json outdir
5. default                    join(homedir(), 'Zomboid', 'Workshop')
```

Every tier is `path.resolve()`d — the returned value is always an absolute,
platform-native path (`helper.ts:690-712`). Tier 5's verbose emission routes
through the supplied logger (`helper.ts:711`, pinned by
`tests/unit/cliCores.test.ts:902-906`).

Path conventions: `isWatchPathIgnored` compares with `path.relative` over
the same platform-native string space (`watch-shared.ts:41-48`), and the
extension feeds `uri.fsPath` — the same space. No URI/normalization layer is
introduced; parity with the CLI is string-level on one platform, which is
exactly the CLI's own semantics.

### 3.1 Unsafe-root containment of the shared filter (verified)

**Acceptance invariant (normative):** *Watcher filtering must never silently
discard legitimate source events because the configured output root
contains the project root.*

`isWatchPathIgnored(projectPath, outDir, target)` (`watch-shared.ts:36-57`)
applies its outdir rule only under `!outRel.startsWith('..')` where
`outRel = relative(projectPath, outDir)`. Each configuration that would
make the output root "contain" the project was traced through the actual
implementation (and probed against the transpiled helper):

| # | Configuration | `outRel` | What actually happens |
| :--- | :--- | :--- | :--- |
| 1 | `outDir === projectDir` | `''` | The outdir rule is a **complete no-op**: `rel === outRel` matches only the watched root (already returned `false` above it), and `rel.startsWith(outRel + sep)` becomes `rel.startsWith(sep)` — `path.relative` never returns a leading separator, so it matches nothing. **Source events are forwarded**; corollary: generated output is *not* filtered either — the filter degenerates to dot-segment + outside-project rules. The CLI behaves identically: its native parcel `ignore` also disables itself for an empty `outRel` (`watch.ts:143-145`). |
| 2 | `outDir` is an **ancestor** of `projectDir` | `'..'` or `'..\<…>'` | The `!outRel.startsWith('..')` guard skips the whole outdir rule. **Source events are forwarded.** |
| 3 | `outDir` is a **descendant** of `projectDir` | e.g. `'Output'` | The intended case: the outdir subtree is filtered, everything outside it (all legitimate source) is forwarded. |
| 4 | `outDir` is **outside** the project | `'..\<…>'` | Same as 2 — rule skipped. (The watcher does not observe the output tree at all in this configuration.) |
| 5 | `outDir` is **string-prefix-similar** but not an ancestor (e.g. `<parent>/proj-out` next to `<parent>/proj`; or sibling segments inside the project, `my_mod2` vs `my_mod`) | `'..\<sibling>'` / `'my_mod2'` | **No false containment.** Across parents, `relative()` computes the true path relation (a `'..'`-prefixed `outRel`), not a string prefix; inside the project, the `outRel + sep` suffix prevents segment-prefix matches (`'my_mod2\'` does not match `'my_mod\…'`). |
| 6 | `outDir` is **inside a configured mod folder** (e.g. `<project>/my_mod/build-out`) | `'my_mod\build-out'` | Only the output subtree is filtered; sibling mod sources (`my_mod/media/...`) are forwarded. Generated output is filtered under stable config — this is a valid, intended configuration. |

**Verdict:** in every unsafe configuration (1, 2, 4, 5) the helper already
**fails open** — no source events are discarded. The conditional
extension-side guard sketched by the review ("unsafe filtering root → fail
open → preserve source event delivery") is therefore **not required as new
code**: the invariant already holds by construction. Two honest caveats:

- **The fail-open property is emergent, not designed.** It rests on two
  subtleties — the `..` guard and the empty-`outRel` no-op — not on an
  explicit containment check. A refactor of `watch-shared.ts` could break
  it silently, so the acceptance matrix (§10-B.4/C) pins cases 1, 2 and 5
  as gates: source events under an equal/ancestor root must reach
  `session.apply`.
- **Case 1's corollary must be pinned, not "fixed" silently:** with
  `outDir === projectDir` the filter provides *no output exclusion* (and
  the CLI's native exclusion is likewise disabled). Events for engine
  writes inside the project are forwarded and absorbed by classification —
  except the pathological mod-id collision (§4/§12.5), which this filter
  cannot address in any root configuration.

Parity framing: shared-helper parity holds for **valid** configurations
(3, 6) and unsafe configurations fail open **identically in both hosts**
(the CLI's guards at `watch.ts:142-148` mirror the helper's). No
byte-for-byte parity is claimed for what the code deliberately treats
differently — the CLI's native parcel `ignore` has no
`createFileSystemWatcher` equivalent (§12.4) — and that asymmetry is
pre-existing, not introduced by this contract. One pre-existing quirk is
noted for completeness, out of scope: the outside-project test
`rel.startsWith('..')` is a string test, so a project child whose first
segment literally begins with `..` (legal on POSIX) classifies as outside;
this predates UX-09, is shared by both hosts, and is not a containment
issue.

---

## 4. Temporal consistency analysis (mandatory)

**The central distinction this section maintains (normative for every
claim in this document):**

```text
The root a FRESH config resolution returns at time t
  ≠ (necessarily) the baseline root the ACTIVE BuildSession is using at t
```

A fresh `resolveOutDir()` reads the *current* resolved configuration. The
engine writes from its *baseline plan input* — the config captured at the
last plan-input refresh (`buildsession.ts:365,379,519,545`), which plain
mod-file batches reuse without re-reading (`buildsession.ts:453-514`).
These two roots coincide only under stable configuration between the two
reads (§6.2); nothing in the source makes them coincide by mechanism.

Two scenarios bound the exposure (both traced against source):

**Scenario 1 — settings changed, no plan-input refresh.** The filter can
*lead* the engine:

```text
Session starts using A            (baseline planInput = A, buildsession.ts:365)
Settings change to B              (nothing re-reads settings — no settings watcher)
Plain source delta arrives        (apply → classifyDelta against the BASELINE)
Engine continues writing A        (baseline reused, buildsession.ts:453-514)
resolveOutDir() would return B    (a fresh read sees the new settings)
```

A startup-snapshot filter (root = A) happens to still match the engine
here — the snapshot's accidental advantage. But a per-flush re-resolving
filter would return B while the engine still writes A: it would filter B's
subtree — safe only while B holds no legitimate source (§3.1) — and
forward A's output events. Re-reading does not track the session; it
tracks the configuration.

**Scenario 2 — plan-input refresh moves the root.** The engine can *lead*
the filter:

```text
Session starts using A            (baseline = A)
Settings change to B
project.json delta causes rebuild (doFullRebuild → fresh getPlanInput,
                                   buildsession.ts:543-551)
Engine switches to B              (baseline planInput = B)
Startup filter still points to A  (output events under B are forwarded)
```

The sequence from the brief, traced against source:

```text
Start DevSync using outdir A
    ↓ session.start(): baseline planInput ← resolveProjectConfigFor(A-era
      settings) — buildsession.ts:365; watcher filters with a root for A
Watcher filters outdir A
    ↓
User changes resource-scoped settings to outdir B
    ↓ nothing re-reads settings yet — the engine has no settings watcher
DevSync processes a new change
    ├─ plain mod-file delta → apply uses the BASELINE → writes to A
    └─ project.json delta (or mod.info/.pzstudioignore) → full/scoped
       rebuild → FRESH getPlanInput → provider re-invoked (studio.ts:215-218)
       → config.outdir = B → writes to B       buildsession.ts:543-551, 518-537
    ↓
Engine writes to outdir B
    ↓
Watcher observes output B (only when B sits inside the watched project dir)
```

**What prevents output B from being forwarded back into the engine when
filtering still uses A? Nothing.** No host blocks the forwarding:

- The CLI cannot: its filter root and parcel `ignore` are the start-time A
  (`watch.ts:57,124,142-148`).
- The extension cannot: it has no filter at all today.
- The only backstop is core classification: an output path under B whose
  first segment below the project is not a configured mod id classifies as
  `'…' is not a configured mod` → ignored (`buildsession.ts:167-170`).
  `workshop/…` output subtrees classify as `unused workshop file`
  (`buildsession.ts:163-165`); dot-segment outputs are filtered by
  `isWatchPathIgnored`'s dot rule regardless of outdir knowledge.

The forwarding is therefore *wasted work* (each output write batch becomes a
debounced apply whose deltas are all classified-ignored, logged only at
verbose), **except in the pathological layouts** where the outdir's first
segment under the project equals a configured, non-excluded mod id (outdir
inside a mod folder, or named like one) — there output writes classify as
`mod-file` events and the engine genuinely feeds itself: a loop. That is the
class doctor already flags (`filesystem.outDirInsideProject`,
`core/src/doctor.ts:286-296`) and the Cockpit plans to remediate
([`12-project-cockpit.md`](12-project-cockpit.md) §8.4 "Change Output
Folder…"). For outdirs **outside** the project — the default
(`~/Zomboid/Workshop`) and the recommended shape — the watcher never sees
output events at all and the exposure is zero.

The five determinations the brief requires:

1. **Does the engine support changing output roots during a session?**
   Yes — structurally, and it is pinned by test
   (`extUtilDevSync.test.ts:418-497`): a live session moves from out1 to
   out2 on a `project.json`-triggered full rebuild, without recreation.
   But **only** on plan-input refreshes (full rebuild, scoped rebuild,
   `rebuild()`); plain saves keep writing to the baseline root. A
   settings-only change moves nothing until the next triggering event.
2. **Does configuration freshness apply to outdir in this path?** Yes.
   The provider is invoked per plan input with the session's projectDir
   (`studio.ts:215-218`), and `resolveProjectConfigFor` re-reads
   `project.json` *and* the global config each time (`helper.ts:309-321`).
   Outdir is as fresh as any other config field on every refresh.
3. **Must the session refresh its filtering root?** With a startup-snapshot
   root, the filter does not follow the engine across a mid-session move —
   the mismatch window of §4 opens. The root *can* be re-read
   extension-side by re-invoking the same reader (per flush, or on
   configuration-change events) — that needs no new API, but per §4
   Scenario 1 a re-read is another unsynchronized fresh read: it may trail,
   lead or coincide with the session's baseline arbitrarily. It narrows the
   window; it does not close it. That policy is deliberately **not** part
   of this release (see 5 and §12).
4. **Should relevant settings changes require a session restart?**
   Rejected for this release. It is new UX behavior (restart loops,
   lifecycle churn) neither host has today; it does **not** cover the
   `project.json`-outdir-edit path (a file event, not a settings change —
   the engine's full-rebuild-on-project.json is the intended behavior for
   that event); and the CLI watch — the parity target of UX-09 — never
   restarts either. Revisit only with the R2 state owner if user demand
   appears.
5. **Is startup-snapshot semantics accepted, identical to CLI watch?**
   **Yes — deliberately, not silently.** Limitations, stated:
   - After a mid-session outdir move (settings change + triggering event,
     or a `project.json` outdir edit), output events under the new root are
     forwarded to the engine until restart. In every non-pathological
     layout they are absorbed by classification (bounded waste: one
     ignored-classification apply per output write batch, verbose-only
     logging).
   - In the pathological layout (outdir inside a configured mod folder) the
     pre-existing loop persists — it exists in the shipped CLI watch today
     under the identical conditions; this contract neither introduces nor
     worsens it. Mitigation is configuration guidance (doctor finding +
     Cockpit remediation), not the watcher filter.
   - Why safe enough for this release: (a) zero exposure for outdirs
     outside the project (the default and dominant configuration); (b)
     inside-project outdirs are already doctor-flagged for exactly this
     risk; (c) the *stable* inside-project outdir — the common case among
     flagged configs — becomes fully filtered, which is the UX-09
     improvement; (d) the filtering *decisions* are byte-for-byte the CLI
     watch's shipped semantics (the same `isWatchPathIgnored` helper; the
     CLI's additional native parcel `ignore` is a deliberate pre-existing
     asymmetry, §12.4), and CLI/extension parity is UX-09's stated goal;
     (e) the
     *narrower* follow-up (per-flush re-read, §12) needs no new API —
     though per §4 Scenario 1 re-reading is not session tracking, and
     exact plan-input-lifecycle tracking would require Option C or a
     supplementary contract, i.e. an API change. Nothing about this choice
     forecloses either.

**Conclusions (normative, replacing any stronger earlier phrasing):**

- Option B provides **startup-snapshot parity** — at start, under stable
  configuration, the filter root and the engine's baseline write root
  coincide by construction (same resolver, same inputs; the §6.2 race
  window is the only gap, and stable configuration closes it).
- Option B does **not** provide live-session root truth. A fresh read at
  any later time answers "what would a *new* session resolve now?", not
  "what is the running session writing to?".
- **Per-flush re-resolution alone does not guarantee synchronization with
  the active session** — it is subject to the same two-read race as
  startup (§6.2) and can disagree with the baseline in either direction
  (§4 Scenarios 1–2).
- Tracking that follows the plan-input lifecycle exactly (the engine's
  actual write root across refreshes) requires Option C (session-owned
  recorded root) or a supplementary contract — a further API decision.
- Accordingly, this document makes **no claim that future live tracking
  certainly needs no API change**; it claims only that the per-flush
  re-read *policy* is implementable with the API this document already
  proposes.

The startup-snapshot policy remains the recommendation for this release,
with the residual risk stated exactly: after a mid-session root move,
output events under the new root are forwarded to the engine until
restart (absorbed by classification except in the pathological layout —
§4's chain above), and the filter may in the interim keep excluding the
stale root — harmless for source delivery, because the stale root is
either a genuine output subtree (no legitimate source) or an unsafe root
where the outdir rule no-ops (§3.1).

---

## 5. Comparison of the three API designs

### Option A — broad resolved config: `studio.resolveProjectConfig(projectDir)`

Expose the full effective project configuration (the `resolveProjectConfigFor`
result: workshop metadata, mods, excludes, build target, effective outdir).

- **Reuse:** maximal on the CLI side — it is a one-line delegation to the
  existing resolver (`helper.ts:297-322`).
- **Return type stability:** poor. `IProjectConfig` is a wide, mutable
  domain type (`core/src/project.ts:123+`); every schema evolution becomes
  a public-API conversation.
- **API surface size:** the largest of the three, for one consumer need
  (a string).
- **Coupling:** invites the extension to read unrelated fields from the
  CLI's resolved config — a second raw-read path parallel to the tolerant
  tree reads UX-18 exists to retire, and in tension with Q5's recommendation
  (extension adopts `@pzstudio/core` directly for validated reads).
- **Settings provider invocation:** identical to DevSync's (one call with
  `{ projectDir }`) — parity holds.
- **Exactly matches DevSync's plan input:** yes at call time (same
  resolver, same inputs) — but no better than B, and the *extra* surface
  buys nothing for matching.
- **Cockpit reuse:** hypothetical; UX-18/Q5 already picked the direct-core
  path for validated project reads. This method would duplicate that door.
- **Verdict: rejected** — exposes unrelated configuration data; the brief
  instructs preferring the narrowest correct contract.

### Option B — narrow outdir reader: `studio.resolveOutDir(projectDir)`

One synchronous method returning the effective output root, delegating to
`resolveProjectConfigFor` and returning `.outdir`.

- **Delegation without duplication:** yes — it *is* the same resolver call
  the plan input makes (`devsync.ts:74`), with the instance provider and
  instance logger threaded exactly as `createDevSync` does
  (`studio.ts:215-218`). Zero tier logic exists anywhere outside
  `getOutDir`.
- **Absolute and canonical:** yes — every tier `resolve()`s
  (`helper.ts:690-712`); platform-native, same string space as
  `uri.fsPath` and `path.relative` in `isWatchPathIgnored`.
- **Async work:** none. `resolveProjectConfigFor` is synchronous (Node fs
  sync reads); the settings provider invocation is synchronous. The shape
  mirrors `resolveModInfoTargets(modId, projectDir): string[]`
  (`studio.ts:242-244`) — the existing sync, explicit-context precedent.
- **One settings read per explicit request:** yes — provider invoked once
  per call; global config re-read per call (no caching, matching the
  engine's own behavior per plan input).
- **Can it disagree with a running session?** Yes, in the same window every
  fresh read disagrees: the session's baseline is the config captured at
  the last plan-input refresh; a fresh read returns the *current*
  configuration. At startup the two reads are back-to-back synchronous
  reads (see the ordering rule in §6.2) — expected to agree under stable
  configuration, but the window between them is real: nothing atomic
  spans the two reads (§6.2). Mid-session it is exactly the CLI's shipped
  mismatch (§4.5). The method is *also* sufficient to implement the
  per-flush re-read policy later without any new API — but a re-read is
  not engine truth (§4, §12) — see §12.
- **Two independently timed configuration reads:** yes — one for the
  filtering root, one for the session's first plan input. This is not new:
  the CLI watch does precisely this today (`watch.ts:40` then the plan
  input inside `session.start`), and the reads are lock-free and
  milliseconds apart at start in practice. They are **not** an atomic
  snapshot; §6.2 specifies what may change between them and what happens
  when it does.

### Option C — session-owned resolved output context

`studio.createDevSync(projectDir)` → `session.start(...)` → the session
exposes the outdir actually used.

- **Source ownership:** the plan input is created in the CLI's
  `getPlanInput` closure (`devsync.ts:71-88`) and stored privately in core
  (`buildsession.ts:339`). Two implementation shapes exist:
  1. **Core accessor** — add a public getter to `BuildSession`. A Core
     public-API change; `BuildSession` is frozen at "only `start`,
     `rebuild`, `apply`, `stop`" (matrix §1), and CP-12 (structured session
     status) is the deferred vehicle for engine-truth surface — a one-field
     accessor would fragment that decision.
  2. **CLI wrapper** — `createDevSyncCore` records `config.outdir` from
     every plan input it resolves and returns a forwarding wrapper
     (`DevSyncSession extends BuildSession` + `getEffectiveOutDir()`).
     Core untouched; but `PzStudio.createDevSync`'s return type widens —
     a public v2 surface change with new lifecycle semantics.
- **When available:** only after the first plan input resolves — i.e.
  during `start()` (`buildsession.ts:365`), *not* at `createDevSync` time.
  The contract would need to expose an `undefined`-until-started getter
  (a partial function) — worse than B's total function.
- **Available before watcher subscription?** Yes in practice — the
  controller subscribes after `await session.start(...)`
  (`devsync.ts:54-58`) — but only via the wrapper shape, and only by
  ordering convention, not by type.
- **Does it change during `apply()`?** Yes — and that is C's one real
  advantage: a getter recording the *last resolved* plan input tracks the
  engine's actual write root across mid-session moves (§4), strictly better
  temporal fidelity than any fresh read. (Micro-caveat: during one apply,
  the incremental phase writes from the old baseline while the scoped phase
  writes from the fresh input; the recorded value flips when the fresh
  input resolves, mid-apply.)
- **Getter vs returned startup result:** a `start()`-returned result would
  freeze the value at startup (equivalent to B's snapshot) while changing
  core's `start(): Promise<void>` signature — the worst of both. A getter
  is the only C shape worth anything, and it needs the wrapper or core
  change above.
- **Internal or public surface:** it cannot remain internal — the
  extension bundles only `@pzstudio/cli/api` (no deep imports), so the
  wrapper type and getter are a public v2 addition regardless.
- **Prevents a second configuration resolution:** yes — no read at all;
  the value *is* the session's.

### Decision matrix

| Criterion | Broad config (A) | Narrow outdir (B) | Session-owned (C) |
| :--- | :--- | :--- | :--- |
| Single authoritative resolver | Yes (delegates) | Yes (delegates to the same `resolveProjectConfigFor`) | Yes — no second resolution at all (sourced from the plan input) |
| Exactly matches active session | No — fresh read; matches at start only (under stable config) | No — fresh read; matches at start only (under stable config); a per-flush re-read policy is possible later without new API, but re-reading ≠ session tracking (§4) | Yes — recorded from the session's own plan input, tracks refreshes |
| Supports changing outdir | No (snapshot per call) | No as a start snapshot; a re-read-per-flush policy can be layered on later with zero new API — it narrows, not closes, the mismatch window and never becomes engine truth | Yes (getter follows plan-input refreshes) |
| Minimal public API | No — wide `IProjectConfig` exposed | **Yes — one total sync method** | No — widened `createDevSync` return type or a Core accessor; `undefined`-until-started semantics |
| R0/R1 safe | Yes (explicit context, lock-free) | Yes (explicit context, lock-free, instance deps only) | Yes (inside the existing session) |
| Testability | Good | Good — pure instance method; same fixture style as `resolveModInfoTargets` and the `getOutDir` scope-tier tests | Moderate — value only observable through session lifecycle timing |
| Compatibility risk | Medium — broad type surface, drift pressure toward raw config reads | Low — additive method, no existing member changes | Medium — new public type/lifecycle semantics on a frozen surface |
| Implementation complexity | Low | **Low** (~15 lines in `studio.ts`; controller ~10 lines) | Medium-high (wrapper type + forwarding or core change; lifecycle documentation) |
| Long-term maintainability | Medium — overlaps UX-18/Q5's direct-core read path | High — narrow now, extensible to stricter freshness policies later | Medium — couples filtering to session internals; overlaps the deferred CP-12 engine-status decision |

### Selection: **Option B** — `studio.resolveOutDir(projectDir)`

The narrowest contract that provides correct behavior for this release:

- It reuses the *one* authoritative resolver — no tier logic is duplicated,
  and UX-05's resource-scoped settings arrive through the same provider
  invocation the engine uses, so "same outdir as the engine" holds at
  startup by construction, not by convention.
- It is fail-closed *aligned* with the session: it throws exactly when the
  session's first `getPlanInput` would throw (same resolver, same inputs),
  so no "filter without a session" state can exist (§7).
- It matches the CLI watch's startup shape byte-for-byte (config read →
  session start → filter), which is UX-09's parity goal.
- Its only deficiency versus C — the mid-session move window — is (i)
  identical to the shipped CLI behavior, (ii) confined to doctor-flagged
  configurations (§4), and (iii) *mitigable* later through this same API
  (per-flush re-read) with zero additional surface — mitigable, not
  eliminable: the re-read remains an unsynchronized fresh read, not engine
  truth (§4). C's extra fidelity does not justify widening a frozen public
  surface and adding `undefined`-until-started lifecycle semantics now;
  if engine-truth tracking is ever required, C or a supplementary contract
  is the honest vehicle (§12).

A is rejected (§5). C is **deferred**, not rejected on merit: if the R2
DevSync state owner ever needs engine-truth tracking (e.g. alongside
CP-12's structured session status), the wrapper shape is the right vehicle
— decided then, not smuggled in now.

---

## 6. Chosen API contract and type-level sketch

### 6.1 The v2 addition (CLI)

```ts
// packages/cli/src/lib/studio.ts — PzStudio interface gains:

export interface PzStudio {
    // … existing members unchanged …

    /**
     * Resolves the effective build output directory for ONE project —
     * the same five-tier resolution the DevSync plan input and `build`
     * use: project.json outdir (against the project root) > workspace
     * host layer > user host layer > global CLI config > default.
     *
     * Reads the instance's settings provider exactly once with the given
     * projectDir and threads the instance logger for plan-input emissions
     * ([MIGRATION] warns, defaulting verboses). Synchronous, lock-free,
     * touches no legacy state (R0/R1). Performs the config-resolution
     * step of a plan input ONLY — no template resolution, no source
     * snapshots (§6.2).
     *
     * Failure contract (fail closed): throws exactly what the config-
     * resolution step of the session's first plan input would throw for
     * the same directory — the structured no-project CliError when no
     * project.json exists at or above `projectDir`, the parse error for
     * corrupt JSON, and the validation error when project.json is
     * invalid. A missing or invalid *resolved outdir* additionally
     * throws (see the guard below) rather than returning an unchecked
     * optional. Returns an absolute, platform-native path (path.resolve
     * semantics).
     *
     * Pass the same projectDir string the session was created with.
     * The result is the OUTPUT ROOT (the outdir tier), not a per-variant
     * folder — matching what isWatchPathIgnored(projectDir, outDir, path)
     * expects.
     */
    resolveOutDir(projectDir: string): string;
}
```

Implementation sketch (delegation only — `resolveProjectConfigFor` already
exists and is already imported into the bundle by the DevSync core):

```ts
// packages/cli/src/lib/studio.ts (inside createPzStudio's returned object)
resolveOutDir(projectDir) {
    const config = resolveProjectConfigFor(
        projectDir,
        settingsProvider ? settingsProvider({ projectDir }) : undefined,
        { logger: instanceLogger() },
    );
    if (!config) {
        // Unreachable in practice (resolveProjectConfigFor fails closed
        // first); kept for type soundness — fail closed, never guess.
        throw new CliError('No pzstudio project found.', {
            cause: `Searched from '${projectDir}' up to the filesystem root for a project.json.`,
            tryHint: `Run 'pzstudio new <title>' to create a project.`,
        });
    }
    const outdir = config.outdir;
    // Explicit failure contract: IProjectConfig.outdir is OPTIONAL
    // (core/src/project.ts:126), so `return config.outdir` would rest on
    // an unchecked `string | undefined`. At runtime the scope-form
    // getOutDir always yields a non-empty string (every falsy tier falls
    // through to the default, helper.ts:689-712), so the guard is
    // unreachable today — but the `string` return must be EARNED here,
    // not asserted with `!`. Fail closed, never guess.
    if (typeof outdir !== 'string' || outdir.length === 0) {
        throw new CliError(
            `Failed to resolve the output directory for '${projectDir}'.`,
            {
                cause: 'The resolved project configuration has no usable outdir.',
                tryHint: 'Check the outdir tiers: project.json, host settings, ~/.pzstudio/config.json.',
            },
        );
    }
    return outdir;
}
```

Naming: `resolveOutDir` follows the surface's `resolve*` family
(`resolveModInfoTargets`) and the domain vocabulary (`getOutDir`, config
field `outdir`, `resolveBuildOutputPath`). `resolveProjectOutDir` was
considered and dropped — verbosity without ambiguity gain; there is exactly
one outdir in the contract.

### 6.2 The extension consumption (UX-09, unblocked)

```ts
// packages/vscode-extension/src/util/devsync.ts (sketch)
import { isWatchPathIgnored } from '@pzstudio/cli/api';   // already exported

export class DevSyncController implements vscode.Disposable {
    private session: BuildSession | undefined;
    private watcher: vscode.FileSystemWatcher | undefined;
    private projectDir: string | undefined;      // NEW: the session's dir
    private filterRoot: string | undefined;      // NEW: the resolved outdir
    // … pending/timer/starting unchanged …

    async start(projectDir: string): Promise<void> {
        if (this.active || this.starting) return;
        this.starting = true;
        try {
            const session = this.studio.createDevSync(projectDir);
            // Resolve the filtering root BEFORE the initial build: the two
            // reads are then back-to-back (the tightest ordering a fresh
            // read can achieve — the CLI watch reads its config before
            // creating the session too, watch.ts:40 → watch.ts:69). The
            // reads are NOT an atomic snapshot; see "Two reads, not a
            // snapshot" below.
            const filterRoot = this.studio.resolveOutDir(projectDir);
            await session.start(['main', 'development']);

            const watcher = vscode.workspace.createFileSystemWatcher(/* …unchanged… */);
            watcher.onDidCreate((uri) => this.schedule('create', uri.fsPath));
            watcher.onDidChange((uri) => this.schedule('change', uri.fsPath));
            watcher.onDidDelete((uri) => this.schedule('delete', uri.fsPath));

            // Publish the filter state only once the session is live, so no
            // event can ever be filtered by a root without a session.
            this.projectDir = projectDir;
            this.filterRoot = filterRoot;
            this.watcher = watcher;
            this.session = session;
        } catch (e) { /* unchanged: warn, stop half-start, rethrow */ }
        finally { this.starting = false; }
    }

    async stop(): Promise<void> {
        // … existing teardown … then:
        this.projectDir = undefined;
        this.filterRoot = undefined;
    }

    private schedule(type: FileDelta['type'], path: string): void {
        if (!this.session) return;
        // Fail OPEN: an unknown filtering root must never discard arbitrary
        // source changes. Unreachable in practice (the root is published
        // before the watcher exists and cleared after it is disposed), but
        // the safe direction is forward-not-drop.
        if (this.filterRoot && this.projectDir &&
            isWatchPathIgnored(this.projectDir, this.filterRoot, path)) {
            return;
        }
        this.pending.push({ type, path });
        // … debounce unchanged …
    }
}
```

Startup ordering (normative for the implementation):

```text
createDevSync(projectDir)
  → resolveOutDir(projectDir)          (sync; may throw → abort before the
                                        initial build; the UX-06 catch path
                                        handles the failure unchanged)
  → await session.start(...)           (the session's first plan input
                                        resolves here, with the same
                                        provider/state the read just saw)
  → create watcher, publish (projectDir, filterRoot), subscribe
```

#### Two reads, not a snapshot (normative)

`resolveOutDir()` and the session's first `getPlanInput()` inside
`start()` are **two independent configuration resolutions, not one atomic
snapshot** — the same double-read the CLI watch has always had
(`watch.ts:40` + the plan input), and the source provides no mechanism
that spans them.

- **What can change between the two reads:** the settings provider result
  (the host's `inspect()` snapshot is taken at call time — a user or
  another extension host can change settings between the calls),
  `project.json` on disk (an editor save, a CLI command, another process),
  and the global config (`~/.pzstudio/config.json`, plus the
  `.pzstudio.bak` fallback tier — `templateManager.ts:398-409`); both
  resolutions re-read all of these (`helper.ts:302-321`).
- **Side effects:** the *config-resolution* step both calls perform is
  read-only — `readProjectConfig` migrates in memory only and never
  writes back (`helper.ts:478-500`), and `readGlobalConfig(false, io)` is
  called with validation off, so no migration/validation writes occur
  (`helper.ts:312`, `templateManager.ts:383-439`). The session's first
  plan input, however, does **more** than config resolution: it resolves
  the workshop template (`resolveTemplateDir` — which can acquire/refresh
  the template cache through the transport and can throw;
  `devsync.ts:80-86`) and gathers per-mod source snapshots (fs reads that
  can throw; `helper.ts:836-858`). Those steps are outside
  `resolveOutDir`'s surface.
- **When the two results are equal:** when no tier input changes between
  the calls, both runs of the same deterministic resolver over the same
  inputs return the same outdir. This is the *expected* case under stable
  configuration — an expectation about timing, not a guarantee built into
  the source.
- **When they differ:** the filter root (first read) and the engine's
  baseline write root (second read) diverge. Consequences, in both
  directions: output events under the root the engine actually writes are
  forwarded (absorbed by classification except the pathological layout,
  §4); output events under the stale root are filtered (harmless unless
  the stale root contains legitimate source — which §3.1's invariant
  forbids the filter from ever discarding: equal/ancestor/sibling-prefix
  roots fail open by construction). **Source-event delivery does not
  depend on which of the two roots the filter holds**: in every case the
  filter only ever excludes paths under a genuine descendant output
  subtree (§3.1 cases 3/6) — never under equal/ancestor/sibling-prefix
  roots, where the rule fails open (§3.1 cases 1/2/5).
- **Failure directions:** resolution failures fail **closed** — no
  project.json (structured CliError, `helper.ts:303-308`), corrupt JSON
  (`helper.ts:469-476`), failed validation (`helper.ts:489-497`), or a
  throwing settings provider propagates out of `resolveOutDir`, aborting
  start before the initial build and before any watcher or filter state
  exists (§7). At *event time*, the filter fails **open** — an unknown
  root forwards (§6.2 sketch below), and an unsafe root fails open by
  construction (§3.1). No new locking or synchronization design is
  proposed or required; the snapshot policy accepts the window, and the
  acceptance matrix (§10) pins behavior under both stable and changed
  configuration rather than claiming atomicity.

Alignment claim, stated precisely: `resolveOutDir` throws exactly when the
**config-resolution step** of the session's first plan input would throw —
same resolver (`resolveProjectConfigFor`), same settings source (the
instance provider at the same `projectDir`), same global-config read. The
converse ("the session cannot fail where `resolveOutDir` succeeded") does
**not** hold: the plan input can additionally fail at template resolution
or source-snapshot gathering (`devsync.ts:80-88`), failure modes
`resolveOutDir` does not perform. The ordering above still guarantees that
*every* such failure aborts before the watcher exists — no filter state
without a session, in either direction. There is exactly one extra
provider call per session start (a pure read) — the same double-read the
CLI watch has always had (`watch.ts:40` + plan input).

---

## 7. Error/failure semantics

| Failure | Behavior | Why it is safe |
| :--- | :--- | :--- |
| No `project.json` at/above `projectDir` | `resolveOutDir` throws the structured `CliError` (`helper.ts:303-308`); the controller aborts before the initial build; UX-06's catch surfaces one notification; nothing is started | Fail-closed **alignment at the config-resolution step**: the session's own plan input runs the same resolver on the same inputs and throws the same error — a filtering root can never exist without a session (§6.2 "Two reads, not a snapshot") |
| Invalid `project.json` (bad JSON / validation failure) | Throws (`helper.ts:469-498`) — same as the session's config-resolution step | Same alignment; doctor remains the surface that *reports* broken configs |
| Session start fails *after* config resolution (template resolution / source snapshots, `devsync.ts:80-88`) | `resolveOutDir` has already succeeded; `session.start` rejects; the controller's catch stops the half-start; no watcher, no filter state | One-directional by design: the two reads share only the config-resolution step; every post-resolution failure still aborts before the filter is published |
| Settings provider throws | Propagates out of `resolveOutDir` and aborts start | The provider is the host's own code (`readPzStudioHostSettings` — pure `inspect()` reads; throwing is theoretical); the session's plan input would hit the identical provider |
| Global config unreadable (tier 4) | `readGlobalConfig` handles/migrates internally (`templateManager.ts`); behavior identical to every other tier-4 consumer | No new failure mode introduced |
| `resolveOutDir` returns a path inside the project | Filter works as designed; doctor's `filesystem.outDirInsideProject` is the user-facing guidance | Outdir-inside-project is a known, flagged configuration (§4) |
| Resolved root **contains or adjoins** the project root (equal / ancestor / outside / string-prefix sibling — §3.1 cases 1/2/4/5) | The outdir rule fails **open by construction**: source events are forwarded; no guard needed | The invariant "unsafe root must never discard legitimate source events" already holds in the shared helper; §10 pins it as an acceptance gate so a refactor cannot silently regress it. Corollary (case 1): no output filtering occurs either — pinned, not a bug |
| Filtering root unknown at event time (defensive; unreachable) | **Fail open — forward the event** (§6.2 sketch) | "An unknown filtering root must not result in silently discarding arbitrary source changes": forward-not-drop is the only safe direction; today's behavior is also fail-open |
| Settings change during a session | No effect on the filter root (startup-snapshot policy, §4.5); the engine's write root moves only on plan-input refreshes | Documented limitation, CLI-identical; the per-flush re-read policy is implementable with the proposed API, while engine-truth tracking needs Option C or a supplementary contract (§12) |

No new lock, no new module-global state, no error swallowing: the method is
a stateless synchronous read; the controller's only new state is two
instance fields cleared in `stop()`.

---

## 8. API compatibility consequences

- **Additive v2 surface change.** `PzStudio` gains one method; no existing
  member's signature or behavior changes; the legacy facade, the CLI
  executable and `@pzstudio/core` are untouched. Doc 11 §13's compatibility
  doctrine freezes *existing* exports — a new export is a new decision,
  which is exactly what this document requests (and §0's status note
  qualifies).
- **Runtime factory surface: additive.** Hosts obtain the API through
  `createPzStudio` (`api.ts:2`), whose returned object gains the method;
  nothing an existing consumer calls changes shape or behavior.
- **Structural interface implementers: source-level TypeScript break.**
  `PzStudio` is a plain interface; any host that types a value as
  `PzStudio` without implementing `resolveOutDir` stops compiling (missing
  member). In-repo, no *production* code implements the interface — the
  extension consumes `createPzStudio` (`extension.ts:35`) — and the test
  stubs satisfy it only through `as unknown as PzStudio` double-casts
  (`extUtilDevSync.test.ts:95-98`, `extCommandsWatch.test.ts:58-61`,
  `extUtilDoctor.test.ts:34-37`, `extCommandsModinfo.test.ts:34-39`), so
  they compile unchanged. The break is therefore real for external
  structural implementers and for future in-repo stubs written as
  complete literals typed `: PzStudio` — which is exactly why this
  addition is gated on the explicit approval this document requests.
- **Public API versioning: evaluated against the actual package policy.**
  The published package `@pzstudio/cli` is at `0.42200.1`
  (`packages/cli/package.json:3`) with a game-build-aligned version scheme
  (`pzBuildCompatibility: '42.x'`) rather than classic semver — the earlier
  draft's "semver impact: minor" presumed a standard semver policy the
  package does not visibly follow. Classification: an additive member on
  a factory-produced interface, low compatibility risk; the concrete
  version-bump decision must follow the project's actual release policy,
  and under semver-zero conventions even breaking changes are nominally
  permissible, so this document asserts no specific bump. The freeze
  doctrine (doc 11 §13) still applies to *existing* exports regardless of
  scheme.
- **Return-type contract.** `resolveOutDir(): string` does not rest on an
  unchecked optional: `IProjectConfig.outdir` is optional
  (`core/src/project.ts:126`), so the implementation carries an explicit
  runtime failure contract for a missing/invalid resolved outdir (§6.1) —
  fail closed with a structured error, never a silent `undefined`.
- **Bundle impact: none.** The method lives in `studio.ts`
  (already inlined into the extension's esbuild bundle) and delegates to
  `resolveProjectConfigFor`, which the bundle already contains via the
  DevSync core. No new dependency, no new module.
- **Legacy facade untouched.** No legacy export changes; `getOutDir`'s
  ambient form and the `§13` write-through table are unaffected.
- **`api.ts` needs no edit**: `PzStudio` (and thus the method) re-exports
  from `./lib/studio` (`api.ts:3-12`).

---

## 9. Concrete files the implementation would change

| File | Change |
| :--- | :--- |
| `packages/cli/src/lib/studio.ts` | Add `resolveOutDir` to the `PzStudio` interface and the instance; import `resolveProjectConfigFor` from `./helper` and `CliError` from `./errors` (both already within the bundle's import graph) |
| `packages/vscode-extension/src/util/devsync.ts` | Store `projectDir`/`filterRoot` alongside the session; resolve the root after `createDevSync` before `await start`; filter in `schedule()` via `isWatchPathIgnored`; clear both in `stop()` |
| `tests/unit/cliStudio.test.ts` | New `describe` for `studio.resolveOutDir` (tier matrix + failures) — see §10 |
| `tests/unit/extUtilDevSync.test.ts` | New `describe` for controller pre-filtering (UX-09 acceptance) — see §10 |

Explicitly unchanged: `packages/cli/src/api.ts` (type re-export only),
`packages/cli/src/lib/helper.ts`, `packages/cli/src/lib/devsync.ts`,
`packages/core/src/**`, `packages/vscode-extension/package.json`, extension
commands/manifest, settings wiring.

---

## 10. Acceptance test matrix (specification — NOT implemented in this task)

Owners follow the existing split: instance/engine behavior in the CLI
suites (fixture + provider injection, patterns of
`tests/unit/cliStudio.test.ts` / `cliCores.test.ts`), controller behavior in
the extension suite (stubbed `vscode` + real v2 instance, patterns of
`tests/unit/extUtilDevSync.test.ts`).

### Mandatory scenario gates (normative)

Every row below MUST be covered by at least one test in matrices A/B; the
right column is the required proof, not a suggestion:

| Scenario | Required proof |
| :--- | :--- |
| Normal startup | Filter root matches the initial engine write root under stable config (B.1) |
| Outdir equals project root | Legitimate source events are not silently dropped (§3.1 case 1; C.1 + B.4) |
| Outdir is project ancestor | Legitimate source events are not silently dropped (§3.1 case 2; C.2 + B.4) |
| Outdir is nested in a configured mod | Generated output is filtered under stable config (§3.1 case 6; C.4 + B.3) |
| Outdir outside project | Source events remain forwarded (A.2/B.2) |
| Similar path prefixes | No false containment (§3.1 case 5; C.3) |
| Settings A→B without rebuild | Engine still writes A; test acknowledges snapshot semantics explicitly (B.5a) |
| Settings A→B with rebuild | Engine can switch to B; known mismatch is explicitly pinned (B.5b) |
| Provider changes between two reads | No claim of atomic equivalence — behavior is defined and source-safe in both orders (B.10) |
| Stop/start with new root | New session resolves a new startup root (B.8) |
| Failure during resolution | No watcher/session state leaks (A.6/B.9) |

**How the tests must assert (normative, applies to every case below):**

- Controller tests must assert **actual `session.apply` calls or the
  resulting batches/written trees** — spying on `session.apply` and
  inspecting the delivered `FileDelta[]`, or asserting the output tree on
  disk — never only the boolean return of `isWatchPathIgnored`. A green
  utility test does not prove the filter is wired into event delivery.
- Watcher input must be **deterministic fake events**: invoke the recorded
  `onDidCreate/Change/Delete` handlers with controlled `fsPath`s (the
  existing `extUtilDevSync.test.ts` harness pattern), never real
  filesystem timing.
- Provider state must be **controllable**: a mutable-layers closure behind
  the provider (the S1→S2 harness pattern,
  `extUtilDevSync.test.ts:418-497`) so settings changes are exact and
  reproducible.

### A. `studio.resolveOutDir` — owner: `tests/unit/cliStudio.test.ts` (new describe; fixtures mirror `cliCores.test.ts` "getOutDir explicit scope: exact tier order")

1. **Project-level outdir overrides host settings** — `project.json` outdir
   + conflicting workspace/user layers → the project value (resolved
   against the project root for a relative outdir).
2. **Folder settings override workspace/user values** — provider returning
   `readPzStudioHostSettings`-shaped layers with a folder-tier outdir → the
   folder value wins; absence falls through to workspace, then user
   (UX-05 composition, `settings.ts:76-79`).
3. **CLI global/default fallback** — no project outdir, empty host layers →
   `~/.pzstudio/config.json` outdir; empty global → `join(homedir(),
   'Zomboid', 'Workshop')`.
4. **Absolute, canonical result** — relative project outdir resolves
   against the project root; every tier's result is absolute
   (`path.isAbsolute`).
5. **Two project contexts never cross-leak** — two instances (or one
   instance, two `projectDir`s) with different providers/layers → each
   resolves its own root; provider receives exactly the requested
   `projectDir` (pin mirrors `extUtilDevSync.test.ts:461-464`).
6. **Fail-closed errors** — no project above the dir → structured CliError
   message/cause/tryHint; invalid `project.json` (corrupt JSON → parse
   error; validation failure → validation error); a throwing settings
   provider propagates. (The §6.1 outdir guard for a missing/invalid
   *resolved* outdir is unreachable through the real resolver — the
   scope-form `getOutDir` always falls through to the default — and is
   therefore documented, not test-injected; the guard exists so the
   `string` return never rests on an unchecked optional, per §8.)
7. **Lock-free / R0/R1** — call while a `studio.run` is mid-flight (lock
   held) → resolves without queueing and consumes no legacy slot (pattern:
   `cliStudioInstances.test.ts` overlap tests).

### B. Controller pre-filtering — owner: `tests/unit/extUtilDevSync.test.ts` (new describe "DevSyncController pre-filtering (UX-09)"; real v2 instance + stubbed watcher per the existing harness)

1. **Same effective output root as actual DevSync writes (normal startup)**
   — project with a `pzstudio.outdir`-equivalent provider layer, stable
   configuration → the initial build lands in `outDir/<title>/`; events
   under `outDir` never reach `apply` (spy on `session.apply` / assert
   batch emptiness), while the root itself is filtered.
2. **Same filtering decisions as CLI watch** — replay the
   `tests/unit/watch.test.ts:32-113` case set (root itself, outside
   project, outdir subtree, dot segments, `.pzstudioignore` kept, normal
   source files kept, `project.json` kept) through the controller's
   `schedule` path with the same `projectDir`/`outDir` inputs.
3. **Output nested inside watched source is ignored — including a
   configured mod folder** — outdir configured inside the project (e.g.
   `<project>/Output`, §3.1 case 3) and outdir nested inside a configured
   mod folder (e.g. `<project>/my_mod/build-out`, §3.1 case 6): synthetic
   create/change/delete under the output subtree never reach `apply`,
   while sibling mod sources (`my_mod/media/...`) still do.
4. **Legitimate source events remain forwarded — under any filtering
   root** — `my_mod/media/lua/x.lua` create/change/delete and
   `project.json` change reach `apply` as the corresponding `FileDelta`s
   (existing batching pins continue to hold). Repeat the source-event
   replay with an **equal** filter root (`filterRoot === projectDir`, §3.1
   case 1) and an **ancestor** filter root (§3.1 case 2): the events still
   reach `apply` — the controller-level delivery proof of the §3.1
   fail-open invariant, independent of the helper-level pins in matrix C.
5a. **Settings A→B without rebuild (snapshot semantics acknowledged)** —
   swap the provider layers A→B mid-session (the S1→S2 harness at
   `extUtilDevSync.test.ts:418-497`), then deliver a **plain mod-file**
   delta: the engine still writes to **A** (baseline reused,
   `buildsession.ts:453-514`); the test asserts the batch reaches `apply`
   and the write lands in A, and **explicitly acknowledges in its
   assertions that the filter root is the startup snapshot A** — i.e. the
   test documents that the filter did not re-resolve, not that the roots
   happened to agree.
5b. **Settings A→B with rebuild (known mismatch explicitly pinned)** —
   same swap, then a `project.json` delta: the write root moves to B
   (fresh plan input, `buildsession.ts:543-551`); events under B are
   **still forwarded** to `apply` in this release (startup-snapshot
   policy — pin the policy explicitly so a future change is deliberate);
   classification absorbs them (assert `result.ignored` counts and
   `session.apply`'s received deltas, no write amplification into B). The
   test names the §4 Scenario-2 mismatch as expected behavior of this
   release.
6. **Two project contexts never cross-leak (filter side)** — extend the
   UX-05 folder-scoped describe (`extUtilDevSync.test.ts:620-683`):
   session A's filter root is A's outdir, session B's is B's; an outdir-A
   write replayed during session B is not filtered by A's root and vice
   versa.
7. **Concurrent engine invocation preserves R0/R1 isolation** — a
   `studio.run` in flight while the controller starts/filters → the
   session's plan inputs and the filtering read each consume only instance
   dependencies (pattern: the commit-9 routing pins,
   `extUtilDevSync.test.ts:320-363`).
8. **Stop/start with a new root leaves no stale filtering state** —
   `stop()`/`dispose()` → later events ignored entirely (existing pin,
   `extUtilDevSync.test.ts:242-260`); a fresh `start()` re-resolves a new
   root (provider re-consulted; events under the *new* root filtered, under
   the *old* root no longer special).
9. **Start failure before the build** — provider/resolver throws → the
   UX-06 single-notification path fires, no watcher is created, no filter
   state persists (extend the existing "start failure warns… and rethrows"
   pin at `extUtilDevSync.test.ts:296-319`).
10. **Provider changes between the two startup reads (no atomic-equivalence
    claim)** — a controllable provider returns layers A for the
    `resolveOutDir` call and B for the session's first plan input (and
    the reverse order): the test asserts **no atomic equivalence is
    promised or asserted** — whichever root each read observed, the
    behavior is defined by §6.2 ("Two reads, not a snapshot"): source
    events always reach `apply`, no state leak, no crash; output filtering
    applies only to the observed filter root's genuine descendant subtree.

### C. Containment invariants of the shared filter — owner: `tests/unit/watch.test.ts` (extended)

The controller reuses `isWatchPathIgnored` itself and B.2 replays its case
set through the schedule path; the pure-helper suite gains the §3.1
containment gates (the natural owner — the same suite that already pins
the helper's decision logic):

1. **Outdir equals the project root (§3.1 case 1)** — source paths
   (`my_mod/...`, `project.json`) are **not** ignored; the corollary is
   pinned too: nothing under the project is output-filtered in this
   configuration (the rule is a no-op, mirroring the CLI's disabled native
   `ignore`).
2. **Outdir is a project ancestor (§3.1 case 2)** — source paths not
   ignored (the `..` guard skips the outdir rule).
3. **Similar path prefixes (§3.1 case 5)** — `<parent>/proj-out` next to
   `<parent>/proj`, and sibling segments inside the project (`my_mod2` vs
   `my_mod`): no false containment.
4. **Outdir nested in a configured mod folder (§3.1 case 6)** — the output
   subtree is ignored, sibling mod sources are not.

These pin the emergent fail-open property so a `watch-shared.ts` refactor
cannot silently regress it.

---

## 11. Proposed implementation commit decomposition

Two atomic commits, each compiling and testing green independently; both
**blocked on contract approval** (§0 status note):

1. `feat(cli): expose studio.resolveOutDir for hosts`
   - `packages/cli/src/lib/studio.ts` (interface + implementation),
     `tests/unit/cliStudio.test.ts` (matrix A).
   - No behavior change for any existing consumer; the method has no
     in-repo caller until commit 2.
2. `fix(ext): pre-filter Development Sync watcher events (UX-09)`
   - `packages/vscode-extension/src/util/devsync.ts` (§6.2),
     `tests/unit/extUtilDevSync.test.ts` (matrix B).
   - Closes UX-09's achievable scope; the temporal policy of §4.5 is the
     documented behavior of this commit.

No release/publish step, no manifest change, no dependency change.

---

## 12. Explicit deferred issues

1. **Live filtering-root freshness (per-flush re-read)** — re-resolving
   the root per flush (or on `onDidChangeConfiguration`). Implementable
   with **no new API** — `studio.resolveOutDir` is re-invocable; the cost
   is one extra config read per debounced batch (the engine itself pays
   the same per plan input). Honest scope, per §4: a re-read tracks the
   *configuration*, not the *session* — it narrows the mismatch window
   (the re-read is at most one batch stale) but can still trail, lead or
   coincide with the active baseline arbitrarily, and never constitutes
   engine truth. Decision deferred to the R2 DevSync state owner
   (CP-04/`devsyncState.ts`), where the root belongs as state.
2. **Session-owned live root (Option C) or a supplementary contract** —
   the wrapper/accessor shape is the right vehicle whenever the filter
   must track the engine's *actual* write root across plan-input
   refreshes (e.g. together with CP-12 structured session status, a Core
   decision); exact plan-input-lifecycle tracking cannot be achieved by
   re-reading alone (§4). Not needed while the snapshot policy stands —
   which is a statement about this release's policy, not a claim that
   live tracking will never need an API change.
3. **Restart-on-settings-change policy** — rejected for this release (§4.4);
   revisit only with user demand and Cockpit UX support.
4. **Native watcher exclusion parity** — the CLI's parcel `ignore`
   (`watch.ts:142-148`) has no `createFileSystemWatcher` equivalent
   (event-type toggles only); the event filter is the sole mechanism PZ
   Studio owns. Editor-side excludes (`files.watcherExclude`) remain
   user-controlled and non-contractual.
5. **Pathological outdir layouts** — an outdir inside a configured mod
   folder can self-feed even with correct filtering if the root moves
   mid-session; with `outDir === projectDir` the outdir rule is a no-op
   and no output exclusion exists at all (§3.1 case 1). The durable
   mitigation is configuration guidance (doctor
   `filesystem.outDirInsideProject` + Cockpit §8.4 "Change Output
   Folder…"), not watcher mechanics.
6. **CP-12 (structured session status)** — unchanged by this contract; this
   design deliberately avoids preempting its surface decisions.

---

## 13. Validation checklist (this document)

- [x] Filename `13-devsync-outdir-api-contract.md` did not exist (verified
  before writing).
- [x] Every referenced source path exists at HEAD (originally verified at
  `c34878c`, re-verified at `25af2b5` — the only intervening commit is the
  docs commit introducing this file); every API claim is supported by
  cited source (§1–§2, verified by direct reads and greps).
- [x] Prior-audit blocker claims individually re-verified (§2 table) — none
  accepted on report authority alone.
- [x] Temporal question answered with an explicit determination on all five
  sub-questions; the snapshot policy is chosen *with* its limitations, not
  by default (§4).
- [x] All three designs assessed against the required criteria; one
  selected with reasons; the others rejected/deferred explicitly (§5).
- [x] §7's guarantee list satisfied item-by-item (§3, §5, §6, §7).
- [x] Error semantics explicit; unknown-root behavior is fail-open
  (§7).
- [x] Tests specified with files and owners, not implemented (§10).
- [x] No production source, test, manifest or dependency touched; docs-only
  commit (§13 here; `git status` verified before commit).

**Q3 hardening revision checklist:**

- [x] Current-resolved-root vs active-baseline-root distinction stated and
  maintained through §4 (Scenarios 1–2), §5, §6.2 and §12; the startup-
  snapshot conclusion set is explicit (§4 Conclusions).
- [x] No remaining unconditional claim of active-session outdir
  equivalence; no claim that per-flush re-reading necessarily solves
  temporal consistency (§4, §5, §12.1).
- [x] Unsafe-root containment analyzed case-by-case against the real
  helper and probed empirically; fail-open invariant documented as an
  acceptance gate (§3.1, §10-B.4, §10-C); no guard implementation
  proposed (none needed).
- [x] Double-resolution semantics documented: mutable sources, read-only
  config side-effect profile, equality/divergence consequences,
  fail-closed/fail-open directions (§6.2, §7); no locking design
  proposed.
- [x] API compatibility corrected: runtime-additive factory surface,
  structural-implementer source break (with in-repo double-cast stub
  facts), versioning per the actual `0.42200.1` package scheme, `string`
  return earned via an explicit failure contract over the optional
  `IProjectConfig.outdir` (§6.1, §8).
- [x] §10 mandates the scenario→proof gate table and assertion method
  (apply-call/batch assertions, deterministic events, controllable
  provider).
