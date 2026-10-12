# 13 — Authoritative DevSync Outdir Contract (Q3)

**Design-only pass.** Originally written at HEAD
`c34878c814bfedce22920c0164da094b37862a9f`; **hardened in a Q3 review
revision at HEAD `25af2b5cc39a9b9e89f2fb295e7ddacfee2d31c2`**; **re-hardened
in a second Q3 safety revision at HEAD `0701ccacb920a8c44eeb812cb2e4def2cac30ecb`**
(branch `42.20.0-dev`, tree clean; the only commits between the three heads
are the docs commits that introduced and hardened this file, so every
file:line reference is valid at all of them). No production source, test,
manifest or dependency was touched for this document; the only artifact is
this file. Every claim below was verified against the implementation —
file:line references are to HEAD; the second revision additionally grounded
its behavioral claims in a disposable source-level probe (untracked, run
once against the real `isWatchPathIgnored` and `classifyDelta`, then
deleted).

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

> **Second Q3 safety revision (what changed).** The first revision still
> asserted that a stale startup filter root is "harmless for source
> delivery". That assertion is **disproven** (§3.2, §4 Scenario 3): when
> the engine's write root moves mid-session away from a descendant output
> root that lies inside a configured mod folder, the formerly filtered
> subtree reverts to ordinary mod source semantics — `classifyDelta` has
> no outdir rule — and the stale filter then silently discards legitimate
> source events. This revision (i) removes every absolute stale-root-
> is-harmless claim, (ii) extends the safety invariant to the temporal
> dimension (§3.2), (iii) replaces the bare startup-snapshot filtering
> policy with a **refresh-triggered re-resolution policy** (§6.3) that
> closes the loss without new API beyond the already-proposed reader, and
> (iv) adds the corresponding acceptance gates (§10-B.11/B.12/B.13,
> §10-A.8). Two decisions in this document remain independent approvals: Option B
> (`studio.resolveOutDir`) is an **API reader** recommendation; the
> §6.3 filtering policy is an **extension policy** recommendation layered
> on that reader. Accepting one does not imply accepting the other —
> though without some root reader the extension has no filter at all
> (today's fail-open-by-absence behavior, self-feed loops included), so
> the policy's implementation does depend on the reader being available
> in some form.

> **Q4 addendum (appended below — §14).** A fourth task (the DevSync
> session-owned baseline contract) appended §14 to this document,
> audited at the same source baseline (`8967ada`). It does not modify
> the accepted Q3 contract above: the §6.1 reader and the §6.3 policy
> remain the shipped, accepted Q3 decision. §14 establishes — from
> source, against the UX-09 red-first findings — that the three
> residual windows §6.3 named are proven silent source-event losses,
> and specifies the narrowest contract that closes them (a Core-owned
> committed-baseline accessor plus a transition-safe watcher policy).
> §14 resolves the deferral recorded in §12.2; read §12 with §14 in
> hand.
>
> **Q4 second safety revision (§14 revised in place).** An independent
> adversarial review of the first Q4 addendum identified four contract
> gaps (P1–P4); the re-audit at HEAD `caf4c42` confirmed the underlying
> source facts and went further: the assignment-before-write visibility
> theorem (§14.3) dissolves the first revision's transition state
> machine entirely. The revised §14 replaces the predicted-root
> transition/buffer/resolve machinery (former C3–C5) and the correction
> reads (former C6) with one live per-event getter read, reworks the
> delivery-retry contract (former C8) into a bounded, terminal-state design,
> and re-derives every safety timeline from source. The Q3 sections
> above remain untouched; `studio.resolveOutDir` stays unchanged.
>
> **Q4 adversarial closure (§14 revised in place, third revision).** A
> second independent adversarial review — commissioned explicitly not to
> accept the second revision's GO verdict — confirmed the second
> revision's architecture (live committed-baseline getter, forwarding,
> territory contract) but disproved three of its claims at HEAD
> `20b48be`: the theorem's headline overclaimed (mutation provenance is
> unprovable from `(type, path)` events — §14.3 restated as decision-time
> ownership, T′), the single retry slot collides under overlapping
> rejected flushes from one live session (§14.11, replaced by a bounded
> FIFO failed-batch queue), and result-level errors of re-baseline-class
> applies were treated as completely handled delivery while they can
> abandon truncated source deltas (§14.13, repaired by the C10 degraded
> state). One item is an explicit product confirmation, not a proof: the
> committed-outdir territory granularity (§14.8.6). The Q3 sections
> remain untouched; no public API beyond the already-proposed getter.
>
> **Q4 final correctness gate (§14 revised in place, fourth revision).**
> A final correctness gate — again commissioned not to accept the prior
> GO — disproved three more claims at HEAD `ff80f13`, each verified
> against the real engine: a *successful* scoped rebuild whose fresh
> plan input resolves a different outdir committed an incomplete new
> root (missing every non-scoped mod and `workshop.txt`) with zero
> errors and no C10 signal (§14.13 outcome 6 — repaired by **C11**, the
> root-change promotion to a full rebuild); the failed-batch FIFO could
> re-deliver stale deltas whose `delete` type destroys output the
> source still has (§14.11.10 — repaired by **C12**, execution-time
> delete reconciliation), and its 16-entry cap bounded entries, not
> memory (a dual entry/delta bound added); and the successful-build
> late-mutation residual was mis-described as bounded by "the next
> successful full rebuild" when no such rebuild is guaranteed — it can
> persist indefinitely (§14.17 — the bound claim withdrawn, the two
> policy contracts separated, and the exact S1 relaxation stated for
> the owner decision). The Q3 sections remain untouched; still no
> public API beyond the already-proposed getter.
>
> **UX-09 scope reconciliation (governance pass, appended below —
> §15).** An independent scope review reconciled this contract with the
> Project Cockpit migration matrix and the original UX-09 acceptance
> baseline. It classifies every §14 normative change (C1–C12) against
> the original UX-09 boundary, separates technical correctness from
> product approval (Contract A vs Contract B), labels S1–S6 and
> RG-1…RG-29 by their approval dependency, resolves the "Q4" naming
> collision with the migration matrix's missing-mod Q4, and records the
> outstanding owner decisions. §14's text above is preserved verbatim
> as the proposal record — **nothing in it is approved by this
> document, and no GO verdict recorded there constitutes product-owner
> consent**. The current descriptive name of the proposed work is the
> **UX-09 DevSync Baseline Safety Contract**. The accepted, shipped Q3
> contract is untouched. See §15.

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
discard legitimate source events — neither because the configured output
root contains the project root (the static dimension, this section), nor
because the filter holds a stale root that has ceased to be the engine's
write root while still excluding a subtree that now contains legitimate
source (the temporal dimension, §3.2).*

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
code**: the invariant already holds by construction **for every fixed
configuration** — this section's analysis is static, and its verdict does
not extend to configurations that *change* under a live filter (§3.2).
Three honest caveats:

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
- **The descendant cases (3, 6) are safe only while the configuration is
  stable.** Their exclusion is by design and correct for a genuine output
  subtree — but "genuine" is a temporal property this static analysis
  cannot grant: once the engine's write root moves elsewhere mid-session,
  the formerly filtered subtree reverts to ordinary source semantics and
  the same exclusion starts discarding legitimate source events. That
  temporal dimension is analyzed in §3.2 and closed by the §6.3 policy.

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

### 3.2 Temporal stale-root containment (second revision — the gap, proven)

The §3.1 analysis fixes the configuration. This section asks what happens
when the configuration changes *under a live filter* — and the answer for
the descendant cases (3, 6) is the first proven violation of the invariant
in this document.

**The loss scenario** (the brief's sequence, each step grounded):

```text
1. DevSync starts with outdir <project>/my_mod/generated-A
     (a §3.1 case-6 root: descendant of the project, inside a configured
      mod folder — doctor-flagged, but a valid, intended configuration)
2. The watcher filter holds root A = <project>/my_mod/generated-A
3. project.json is edited: outdir becomes /external/output-B
4. The project.json delta is NOT under A, so the filter forwards it;
   apply() classifies it 'full-rebuild' (buildsession.ts:145-150),
   doFullRebuild fetches a fresh plan input (buildsession.ts:543-551)
   → the engine's baseline write root is now B
5. A source file is created/edited under <project>/my_mod/generated-A/
6. The startup-snapshot filter still calls
   isWatchPathIgnored(projectDir, A, eventPath)
```

Verified against the implementation (and against a disposable probe that
executed the real helper and classifier, then was deleted):

- **Step 6 drops the event.** `outRel = relative(projectPath, A)` is a
  non-`..` descendant (`watch-shared.ts:44`); the event path satisfies
  `rel.startsWith(outRel + sep)` (`watch-shared.ts:47`) → the helper
  returns `true`, and the §6.2 sketch's `schedule()` discards the event
  before it can enter `pending`. The CLI behaves identically — its filter
  root and native parcel `ignore` are equally frozen at start
  (`watch.ts:57,124,142-148`) — so **CLI parity is not safety evidence
  here: both hosts lose the event.**
- **The engine would have accepted it.** `classifyDelta` has **no outdir
  rule** (`buildsession.ts:129-223` — `outdir` appears nowhere in the
  function): first segment `my_mod` is a configured, non-excluded mod, no
  dot segments, not `mod.info`/`.pzstudioignore` → the event classifies as
  `{ kind: 'mod-file', modId: 'my_mod', relativePath: 'generated-A/…' }`
  and the incremental applier would have copied it into the new root B.
- **No contract forbids reusing A as source.** Nothing in the resolver
  (`getOutDir`, `helper.ts:677-713`), the classifier, or the doctor
  (`filesystem.outDirInsideProject` is advisory guidance) reserves a
  formerly-output subtree; §3.1 case 6 itself calls the layout "a valid,
  intended configuration". After the move, `generated-A` is an ordinary
  directory inside `my_mod`, and files created in it are ordinary mod
  source.

**Loss condition, stated precisely (normative):** a stale startup filter
root silently discards legitimate source events **iff the stale root is a
descendant of the project that lies inside a configured, non-excluded mod
folder** (or equals one) **and the engine's write root has moved away from
it**. All other stale shapes remain harmless *temporally as well*: equal/
ancestor/outside roots fail open by a time-independent mechanism (§3.1
cases 1/2/4 — the `..` guard and the empty-`outRel` no-op do not depend on
when the root was read), and a stale descendant **outside** every
configured mod folder discards only events `classifyDelta` would ignore
anyway (`'…' is not a configured mod`, `buildsession.ts:167-170`). The
losing shape is exactly the doctor-flagged inside-a-mod-folder layout —
flagged, not forbidden.

**Consequence for this contract:** the first revision's claim that a stale
filter root is "harmless for source delivery" is withdrawn. A bare
startup-snapshot policy (former Option C's filtering half) is therefore
**not acceptable** on its own; the §6.3 policy exists to close this gap.

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

Two scenarios bound the forwarding exposure (both traced against source);
a third bounds the loss exposure (§4 Scenario 3):

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

**Scenario 3 — stale filter root holds a former output subtree (source
loss; proven, see §3.2 for the full trace).** The direction the first
revision missed: the engine can *lead* the filter into discarding
legitimate source.

```text
Session starts using A, A inside a configured mod folder
    (baseline = A; startup filter root = A — a §3.1 case-6 descendant)
project.json outdir edited to B (B outside the project)
    ↓ project.json is not under A → forwarded → 'full-rebuild'
    → fresh plan input → baseline = B               buildsession.ts:543-551
Source file created/edited under the OLD subtree A
    ↓ filter still excludes A's subtree (startup snapshot)
    → isWatchPathIgnored(projectDir, A, path) === true   watch-shared.ts:44-48
    → schedule() discards the event BEFORE pending.push
classifyDelta against the NEW baseline would call it a mod-file
    (no outdir rule — buildsession.ts:129-223); the engine would have
    synced it into B. The event never reaches session.apply().
```

This is **silent loss**, not wasted work: no error, no log, no apply pass —
the §6.2 sketch drops the event inside `schedule()`. It is bounded to the
§3.2 loss condition (stale root inside a configured, non-excluded mod
folder) and lasts until session restart — the filter never re-examines its
root under the bare snapshot policy. The §6.3 policy closes the
project.json-move path; §4 determination 3 and §12 record what remains.

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
3. **Must the session refresh its filtering root?** With a bare
   startup-snapshot root, the filter does not follow the engine across a
   mid-session move — and §4 Scenario 3 shows that mismatch is not merely
   cosmetic: it silently discards legitimate source. The second revision
   therefore **changes this answer**: the recommendation now includes a
   refresh-triggered re-resolution policy (§6.3) — the filter root is
   re-read via the same reader on a `project.json` watcher event (the one
   event whose full re-baseline is guaranteed) and after every re-baseline
   the session reports (post-start, and post-apply when the result reports
   `fullRebuild` or a scoped rebuild). That still needs no new API beyond
   the reader itself, and it deliberately does **not** re-read per flush
   or on every refresh-capable event: per §4 Scenario 1 a re-read tracks
   the configuration, not the session, and a re-read that runs while the
   engine still writes the old root can lead the engine and re-open the
   self-feed loop in §3.1-case-6 layouts. Triggering the re-read where a
   re-baseline is guaranteed or just observed aligns it with the engine's
   own lifecycle, which is the tightest alignment a fresh read can achieve
   without engine truth (§12.2).
4. **Should relevant settings changes require a session restart?**
   Rejected for this release. It is new UX behavior (restart loops,
   lifecycle churn) neither host has today; it does **not** cover the
   `project.json`-outdir-edit path (a file event, not a settings change —
   the engine's full-rebuild-on-project.json is the intended behavior for
   that event); and the CLI watch — the parity target of UX-09 — never
   restarts either. Revisit only with the R2 state owner if user demand
   appears.
5. **Is startup-time resolution accepted, with CLI-shaped decisions?**
   **Yes — deliberately, not silently, and no longer as a bare snapshot:**
   the filter root is resolved once at startup (CLI-identical shape) and
   then re-resolved on guaranteed-re-baseline events (`project.json`) and
   after every re-baseline the session reports (§6.3 — an extension
   policy the CLI does not have; see the parity caveat below). Limitations, stated:
   - After a mid-session outdir move, output events under the new root
     are forwarded to the engine until the filter's next re-resolution
     adopts the new root (§6.3) or the session restarts. In every
     non-pathological layout they are absorbed by classification (bounded
     waste: one ignored-classification apply per output write batch,
     verbose-only logging).
   - **The stale-root source loss (§3.2/§4 Scenario 3) is real under a
     bare snapshot** — the first revision called it harmless; that claim
     is withdrawn. The §6.3 policy closes it for every move the engine
     itself reacts to: every re-baseline is either the session's first
     plan input (post-start correction), caused by a `project.json` event
     (schedule-time switch), or reported by the apply result (post-apply
     correction) — each has a switch point; the residuals that remain are
     the during-apply scoped window, the same-burst scheduling window and
     the §6.2 race class, all bounded and stated in §6.3.
   - In the pathological layout (outdir inside a configured mod folder) the
     pre-existing loop persists wherever the root has not verifiably moved
     — the §6.3 policy keeps filtering in that state precisely to preserve
     the loop protection; it exists in the shipped CLI watch today under
     the identical conditions, and this contract neither introduces nor
     worsens it. Mitigation is configuration guidance (doctor finding +
     Cockpit remediation), not the watcher filter.
   - Why safe enough for this release: (a) zero exposure for outdirs
     outside the project (the default and dominant configuration); (b)
     inside-project outdirs are already doctor-flagged for exactly this
     risk; (c) the *stable* inside-project outdir — the common case among
     flagged configs — becomes fully filtered, which is the UX-09
     improvement, and the §6.3 policy keeps it filtered unless the root
     verifiably moved; (d) the *filtering decisions* reuse the CLI watch's
     shipped helper (`isWatchPathIgnored`), and CLI/extension parity is
     UX-09's stated goal — **but parity is a consistency goal, not safety
     evidence**: §3.2 shows the shipped CLI watch suffers the same
     stale-root source loss under the same conditions, so this document
     no longer cites parity as an argument that the policy is safe;
     (e) the policy needs no new API beyond the already-proposed reader —
     `resolveOutDir` is re-invocable as-is — and exact plan-input-lifecycle
     tracking would still require Option C or a supplementary contract,
     i.e. an API change. Nothing about this choice forecloses either.

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
  certainly needs no API change**; it claims only that the
  refresh-triggered re-resolution *policy* (§6.3) is implementable with
  the API this document already proposes.

The recommendation for this release is the **refresh-triggered
re-resolution policy** (§6.3) — startup resolution plus re-resolution on
plan-input-refresh signals — replacing the first revision's bare
startup-snapshot policy. The residual risk is stated exactly: between the
engine's re-baseline and the filter's next re-resolution, output events
under the new root are forwarded (absorbed by classification except in
the pathological layout — §4's chain above), and a same-burst source
event scheduled before the triggering event may still be dropped by the
pre-switch filter — bounded by one flush and, for the moves the engine
reacts to, healed by the rebuild's own disk re-read (§6.3). What the
policy removes is the unconditional form of the first revision's claim:
the stale root is **no longer asserted to be harmless for source
delivery** — §3.2 proves the opposite for the inside-a-mod-folder
descendant shape — and the filter therefore no longer holds its root
unconditionally across a session.

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
  §6.3 refresh-triggered re-resolution policy with no new API — this
  revision adopts exactly that — but a re-read is not engine truth
  (§4, §12) — see §12.
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
  input resolves, mid-apply.) The second revision sharpens C's standing:
  since the stale-root source loss is now proven (§3.2), C's fidelity is
  what would close the loss *completely* — including moves that ride
  settings changes or the §6.2 race window, where a fresh read cannot
  prove alignment — which is why C remains the deferred vehicle for
  engine truth (§12.2) rather than a rejected design.
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
| Exactly matches active session | No — fresh read; matches at start only (under stable config) | No — fresh read; matches at start only (under stable config); the §6.3 refresh-triggered re-resolution policy is layered on this same API (adopted by the second revision), but re-reading ≠ session tracking (§4) | Yes — recorded from the session's own plan input, tracks refreshes |
| Supports changing outdir | No (snapshot per call) | No as a start snapshot; the §6.3 trigger-based re-resolution layers on with zero new API — it closes the proven loss paths and leaves the §6.3 residual windows, but never becomes engine truth | Yes (getter follows plan-input refreshes) |
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
- It matches the CLI watch's startup shape (config read → session start
  → filter), which is UX-09's parity goal — with one deliberate addition
  the CLI does not perform: the §6.3.3 post-start correction re-read
  after `start`, adopted because the CLI's frozen root is demonstrably
  not safety evidence (§3.2).
- Its only deficiency versus C — the mid-session move window — is (i)
  shared with the shipped CLI behavior (though §3.2 shows parity is not
  safety evidence — the CLI loses the same events), (ii) confined to
  doctor-flagged configurations (§3.2's loss condition), and (iii)
  *mitigated by this revision* through the §6.3 policy, layered on this
  same API with zero additional surface — mitigated, not eliminated: every
  re-resolution remains an unsynchronized fresh read, not engine truth
  (§4). C's extra fidelity does not justify widening a frozen public
  surface and adding `undefined`-until-started lifecycle semantics now;
  if engine-truth tracking is ever required — to close the §6.3 residuals
  completely, or to make `mod.info`/`.pzstudioignore` events safe
  re-resolution triggers — C or a supplementary contract is the honest
  vehicle (§12).

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
// No basename import: the §6.3 trigger is exact root-level path matching
// (isRootProjectJson below), not a basename test — see §6.3's
// implementation correction.

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
            let filterRoot = this.studio.resolveOutDir(projectDir);
            await session.start(['main', 'development']);
            // §6.3.3 post-start correction: the session's first plan input
            // resolved inside start(); re-read now and adopt whatever the
            // race window changed, so the published root follows the
            // baseline instead of trailing it.
            try {
                filterRoot = this.studio.resolveOutDir(projectDir);
            } catch { /* retain the pre-start root */ }

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
        // §6.3 policy, schedule-time half: a project.json event is the
        // only in-band signal that GUARANTEES a full re-baseline attempt
        // is imminent ('full-rebuild' is classified before any mod lookup,
        // buildsession.ts:145-150), so the filter is never switched here
        // without a re-baseline immediately behind it (the rebuild-fails
        // direction is a bounded §6.3 residual).
        // Re-resolve-and-compare (NOT unconditional invalidation — a
        // same-root result keeps filtering, preserving loop protection);
        // retain the last good root on throw (engine-aligned: the rebuild
        // this event triggers keeps its baseline on the same failure,
        // buildsession.ts:543-551). mod.info/.pzstudioignore events do
        // NOT switch here — their re-baseline is conditional (a stray or
        // non-configured mod's event classifies 'ignore' and rebuilds
        // nothing) — they are covered by the post-apply half below.
        if (this.projectDir && isRootProjectJson(this.projectDir, path)) {
            try {
                const fresh = this.studio.resolveOutDir(this.projectDir);
                if (fresh) this.filterRoot = fresh;
            } catch { /* retain last good root — engine-aligned */ }
        }
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

    private async flush(): Promise<void> {
        // … existing apply/batch logic …
        const result = await session.apply(batch);
        // §6.3 policy, post-apply half: fullRebuild and a non-empty scoped
        // list are the only SessionApplyResult shapes an engine
        // re-baseline produces (buildsession.ts:519-520, 545) — after
        // either, the baseline is the fresh input, so re-resolving NOW is
        // the best-aligned read a fresh read can be (it follows the
        // re-baseline instead of racing ahead of it). Covers moves that
        // ride a scoped rebuild (settings changed, then a mod.info /
        // .pzstudioignore edit). Existing public result type; no new API.
        if (result.fullRebuild || result.scoped.length > 0) {
            try {
                const fresh = this.studio.resolveOutDir(this.projectDir!);
                if (fresh) this.filterRoot = fresh;
            } catch { /* retain last good root */ }
        }
        // … summary logging unchanged …
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
  → resolveOutDir(projectDir) again    (§6.3.3 post-start correction —
                                        adopt what the race window changed;
                                        retain on throw)
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
  §4); and events under the stale root are filtered — harmless **only
  while the stale root is a genuine output subtree or a root the rule
  no-ops on**. The second revision withdraws the first revision's
  absolute claim here: if the engine's baseline later moves away from a
  stale **descendant** root that lies inside a configured mod folder,
  that subtree reverts to legitimate source and the filter silently
  discards its events (§3.2 — the first revision's parenthetical "which
  §3.1's invariant forbids the filter from ever discarding" was wrong:
  §3.1's fail-open cases are equal/ancestor/sibling roots, time-
  independent, but the *descendant* cases 3/6 discard by design and are
  safe only while the subtree is genuinely output). **Source-event
  delivery therefore does depend on which root the filter holds, in
  exactly one configuration shape** — the §3.2 loss condition — and the
  §6.3 policy exists so the filter does not hold such a root
  unconditionally: it re-resolves on `project.json` events and after
  every apply that reports a re-baseline, adopting the moved root.
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

### 6.3 Filtering policy: refresh-triggered re-resolution (second revision)

This subsection is **extension policy**, not API: it specifies how the
controller holds and refreshes its filtering root. It is separable from
the Option B reader decision (§0 status note) — but it consumes the
reader, so some root reader must exist for the policy to be implementable
(§0, second-revision note).

**Policy (normative):**

1. **Startup.** `filterRoot = resolveOutDir(projectDir)` — resolved
   before `session.start`, published with the watcher (§6.2 ordering).
2. **Schedule-time switch — `project.json` events only.** When an event
   whose basename is `project.json` is scheduled, re-invoke
   `resolveOutDir(projectDir)`; if it returns a *different* absolute
   root, adopt it as `filterRoot`; if it throws, retain the last good
   root. Rationale: `project.json` is the only watcher event whose
   `full-rebuild` classification is unconditional (`buildsession.ts:
   145-150` — classified before any mod lookup), so a full re-baseline
   attempt always follows in the imminent apply — the filter is never
   switched *without* a re-baseline immediately behind it (the
   rebuild-fails direction is a bounded residual, listed below).
   Re-resolution is **compare-and-adopt, never unconditional
   invalidation**: a same-root result keeps filtering (preserving the
   §3.1-case-6 loop protection the filter exists to provide), and an
   unconditional "disable on any refresh-capable event" policy is
   explicitly rejected — it would re-open the engine self-feed loop on
   every outdir-irrelevant `project.json` edit (§12.5).
3. **Post-baseline correction (start and apply).** The engine re-baselines
   at its first plan input (inside `session.start`) and afterwards only
   inside `apply` — and both re-baseline shapes are visible to the
   controller without new API: `start` resolves by returning (its build
   failure rejects and the controller stops the session), and an apply
   reports `fullRebuild === true` or `scoped.length > 0` (the only two
   result shapes a re-baseline produces; `buildsession.ts:519-520,545`).
   After either — once after `await session.start(...)` resolves, and
   after every such `apply` — re-invoke `resolveOutDir(projectDir)` once
   and adopt a changed root. This is the best-aligned read available
   without engine truth: it *follows* the re-baseline instead of racing
   ahead of it, it covers the §6.2 startup race (a provider or
   `project.json` change between the pre-start read and the session's
   first plan input is adopted, not stranded), and it covers moves that
   ride a **scoped** rebuild (settings or global-config tier changed,
   then a `mod.info`/`.pzstudioignore` edit). It uses only the existing
   public `SessionApplyResult` — no new API.
4. **No other switch points.** `mod.info`/`.pzstudioignore` events do not
   switch at schedule time (their re-baseline is conditional — a stray or
   non-configured mod's event classifies `ignore` and rebuilds nothing,
   so switching there could leave the filter ahead of an engine still
   writing the old root); plain mod-file events never re-resolve (pure
   cost); `rebuild()` is not part of the controller's surface.
5. **Fail-open invariants unchanged.** Unknown root forwards (§6.2);
   unsafe roots no-op (§3.1 cases 1/2/4/5); a throw during any
   re-resolution retains the last good root — aligned with the engine,
   which keeps its baseline when the same resolution fails
   (`buildsession.ts:543-551`; for the scoped path the assignment at
   `buildsession.ts:519-520` never completes either).

**Implementation correction (UX-09 — trigger expression).** The §6.2
sketch's `basename(path) === 'project.json'` trigger is corrected to
**exact root-level path matching** (`isRootProjectJson`):
`normalizePath(eventPath) === normalizePath(projectDir) + '/project.json'`,
with `normalizePath` replicating the classifier's own convention
(backslashes fold to '/', trailing separators drop, case-sensitive).
Evidence: `classifyDelta` returns `full-rebuild` only when the delta's
FULL normalized relative path equals the literal `'project.json'`
(`buildsession.ts:137-150`); a nested `project.json`
(`<project>/my_mod/data/project.json`) classifies as an ordinary
`mod-file` — or `'…' is not a configured mod` — and never triggers a
re-baseline. A basename trigger would switch the filter root on an event
no re-baseline follows, leaving the filter ahead of an engine still
writing the old root — the exact filter-leads-engine hazard §6.3.4
rejects for `mod.info`/`.pzstudioignore` events (self-feed window under
the old root until the next switch point). The policy itself is
unchanged: same switch point, same compare-and-adopt, same
retain-on-throw — only the trigger's path test is exact instead of
name-based.

**Why this closes the §3.2 loss (normative claim, with its exact scope):**
every engine re-baseline is caused by an apply whose triggering event
passed through `schedule()` (a `project.json` event — switched at
schedule time — or a `mod.info`/`.pzstudioignore` event under a
configured, non-excluded mod — switched at the post-apply correction
point; the controller never calls `rebuild()`), or by the session's first
plan input (covered by the post-start correction). After the switch, events
under the old root are forwarded: the engine — now writing the new root —
classifies them per the §3.2 trace (legitimate `mod-file` delivery when
the old subtree lies in a configured mod). Same-burst source events
scheduled *before* the `project.json` trigger are still subject to the
pre-switch filter — but the full rebuild that the trigger performs
re-reads every mod's source tree from disk at execution time
(`copyTree` walks and reads the live tree — `execute.ts:196-221`;
`gatherPlanInput`'s snapshot feeds planner decisions, not the copy), so
any such edit already saved to disk is incorporated into the new output
by the rebuild itself. The residual windows that remain are stated, not
hidden:

- **During-apply saves on the scoped path.** A save landing while a
  scoped-rebuild apply is in flight is scheduled with the pre-switch
  filter and may be dropped; the scoped rebuild's `copyTree` heals it
  only if the save landed before that mod's copy executed. Bounded by
  one flush plus apply duration; healed by the next re-baseline or
  restart.
- **The §6.2 race class, narrowed.** Configuration changing between any
  two reads (pre-start read vs. the session's first plan input — adopted
  by the post-start correction; schedule-time switch vs. the apply's own
  plan input; the apply's input vs. the post-apply correction) can strand
  the filter on the wrong side until the next switch point. Every
  re-baseline is followed by a correction read, so a stranded state
  self-corrects at the next re-baseline; not eliminable without engine
  truth (Option C, §12.2).
- **A failed rebuild after a schedule-time switch.** If `project.json`
  changes between the schedule-time read and the apply's own read such
  that the rebuild fails, the engine retains its old baseline while the
  filter holds the switched root until the next switch point. Same race
  class; same bound.

**Why not the other candidate policies (decided against source evidence):**

- **Bare startup snapshot (the first revision's policy): rejected** —
  §3.2 disproves its harmlessness premise; the loss persists until
  restart.
- **Unconditional invalidation on any refresh-capable event (the brief's
  Option A in its naive form): rejected** — the build output itself
  contains `mod.info` files (`buildplan.ts:199-290`: copied and
  id-patched, or generated, at `outModsPath/<target>/mod.info`), which
  classify as `mod-scoped` (`buildsession.ts:183-191`); disabling the
  filter on such events — or on any outdir-irrelevant `project.json`
  edit in a stable case-6 layout — forwards the engine's own output
  writes and re-opens the self-feed loop (§1.3, §12.5) that UX-09's
  filter exists to close. Invalidation is also irreversible in the brief's
  formulation (disabled until restart), trading a bounded loss window for
  a permanent loop window.
- **Per-flush re-resolution (the first revision's deferred §12.1 idea):
  rejected in favor of the trigger-based form** — a per-flush read runs
  while the engine may still be writing the old root (§4 Scenario 1),
  leading the engine and re-opening the loop; the trigger-based switch
  points are ordered *with* the engine's re-baselines instead.
- **Session-owned root (Option C): deferred, not rejected** — its
  fidelity would close the residual windows completely (§5, §12.2), but
  it requires the API surface widening this release avoids.

**Option B impact: none.** The policy consumes `resolveOutDir` exactly as
§6.1 specifies it — synchronous, total, re-invocable, no state. The
reader decision and this policy decision remain independent approvals;
approving the policy without the reader leaves the extension filter-less
(today's behavior: fail-open by absence, self-feed loops included), and
approving the reader without the policy leaves the §3.2 loss open.

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
| `project.json` outdir edited mid-session (root A → B) | The `project.json` event triggers a schedule-time re-resolution (§6.3.2); the filter adopts B, the engine's full rebuild re-baselines to B; events under the old root A are forwarded afterwards | The §3.2 loss is closed for this path: the filter never holds a root the engine has verifiably left; same-burst pre-trigger edits are healed by the rebuild's disk re-read (§6.3) |
| Settings/global-tier move riding a scoped rebuild (mod.info / .pzstudioignore) | No schedule-time switch (re-baseline is conditional, §6.3.4); the post-apply correction (§6.3.3) adopts the moved root after `apply` reports the scoped re-baseline | Switch only on observed re-baselines keeps the filter from leading the engine (the naive alternative re-opens the self-feed loop, §6.3); residual: saves landing during the apply window may be dropped until the next re-baseline (§6.3) |
| Re-resolution throws at any switch point (transient invalid config) | Last good root retained (§6.3.5) | Engine-aligned: the rebuild the same event triggers keeps its baseline on the same failure (`buildsession.ts:543-551`); filter and engine stay on the same side |
| Settings change during a session, no refresh event yet | No effect on the filter root; the engine's write root also does not move (baseline reused) — filter and engine remain aligned on the old root | Documented limitation, CLI-identical; the alignment (not the snapshot) is the point: both sides move together at the next refresh event, via §6.3's switch points |

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
| `packages/vscode-extension/src/util/devsync.ts` | Store `projectDir`/`filterRoot` alongside the session; resolve the root after `createDevSync` before `await start`; filter in `schedule()` via `isWatchPathIgnored`; refresh the root per the §6.3 policy (schedule-time switch on `project.json` events; post-apply correction when the result reports a re-baseline); clear both in `stop()` |
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
| Settings A→B without rebuild | Engine still writes A; test acknowledges the no-switch-on-plain-delta policy explicitly (B.5a) |
| Settings A→B with rebuild | Engine can switch to B; the §6.3 switch adopts B and output events under B stop reaching `apply` (B.5b) |
| Provider changes between two reads | No claim of atomic equivalence — behavior is defined and source-safe in both orders (B.10) |
| Stop/start with new root | New session resolves a new startup root (B.8) |
| Failure during resolution | No watcher/session state leaks (A.6/B.9) |
| Engine moves output A → B (`project.json` edit); a file under the previously filtered A becomes valid source afterwards | The source delta reaches `session.apply` (B.11) — the §3.2 temporal gate; the loss this policy forbids is demonstrably detectable |
| Stable layout, outdir-irrelevant `project.json` edit or engine output `mod.info` event | Filter root unchanged; output subtree still never reaches `apply` (B.12) — no naive invalidation, loop protection pinned |
| Root move riding a scoped rebuild (settings A→B, then mod.info edit) | Post-apply correction adopts the moved root; post-flush events under the old root reach `apply` (B.13) |
| Reader re-invocation reflects config changes | Same call, changed tiers → new root; unchanged tiers → same root (A.8) — the policy's compare-and-adopt dependency |

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
8. **Re-invocable root tracking (the §6.3 dependency)** — call
   `resolveOutDir`, change the outdir tier it resolves from (fixture
   `project.json` edit or provider-layer swap), call again → the second
   call returns the *new* absolute root; a second call with unchanged
   tiers returns the same root (stateless, no caching — the §6.3
   compare-and-adopt switch depends on re-invocation being a faithful
   fresh read every time).

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
   assertions that the filter root is the startup root A — no §6.3 switch
   point fires on a plain delta** — i.e. the test documents that the
   filter did not re-resolve (by policy), not that the roots happened to
   agree.
5b. **Settings A→B with rebuild (the §6.3 switch, pinned)** — same swap,
   then a `project.json` delta: the schedule-time switch re-resolves and
   adopts B, the write root moves to B (fresh plan input,
   `buildsession.ts:543-551`), and the post-apply correction re-confirms
   B. Assert the filter root is now B and that **output events under B no
   longer reach `apply`** (the new root is filtered — the UX-09 loop
   protection follows the engine to its new root, not just the startup
   root); any output events delivered in the pre-switch window are
   absorbed by classification (assert `result.ignored` counts, no write
   amplification). The test names the §4 Scenario-2 window — between the
   engine's re-baseline and the filter's adoption — as expected behavior
   of this release, closed at the next switch point.
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
    applies only to the observed filter root's genuine descendant subtree,
    and the post-start correction (§6.3.3) has adopted the session's own
    baseline root once `start` resolves.
11. **Engine transitions output A → B; a file under the previously
    filtered A becomes valid source (the §3.2 temporal gate — the
    acceptance test this revision mandates)** — configure the outdir
    inside a configured mod folder (§3.1 case 6, e.g.
    `<project>/my_mod/generated-A`), start the session (filter root =
    A), then move the outdir to an external B (provider-layer swap or
    fixture `project.json` edit) and deliver a **`project.json` delta**
    through the recorded watcher handler. After the flush completes (the
    full rebuild re-baselined the engine to B), deliver a
    **create/change under `<project>/my_mod/generated-A/`** and assert
    **`session.apply` receives the delta** — spy on `apply`, inspect the
    delivered `FileDelta[]` (the §6.3 schedule-time switch must have
    adopted B, so the stale filter must NOT discard the event) — and
    that the classification/written tree treats it as a `my_mod` source
    file (the write lands under B). The same test pins the *negative*:
    with the switch points bypassed (filter deliberately held at A, the
    bare-snapshot shape), the identical event must NOT reach `apply` —
    proving the harness detects the exact loss this policy forbids.
12. **Stable layout: no spurious root switch; loop protection retained** —
    case-6 layout (outdir inside a configured mod folder), no
    configuration change: deliver (a) a `project.json` event that does
    not change the outdir and (b) an engine-shaped output `mod.info`
    event under the filter root (the output contains mod.info files —
    `buildplan.ts:199-290`); assert the filter root is unchanged and
    that subsequent events under the output subtree still never reach
    `apply` — pinning that §6.3 adopts compare-and-adopt, never
    unconditional invalidation, and that the engine's own output writes
    remain filtered.
13. **Root move riding a scoped rebuild** — swap the provider layers
    A→B mid-session, deliver a `mod.info` delta under a configured mod;
    assert the apply result's `scoped` list is non-empty and that, after
    the flush, a source event under the old root A reaches `apply` (the
    post-apply correction adopted B). Also pin the residual explicitly:
    an event delivered *during* the apply window may legitimately be
    filtered — assert post-flush delivery only, and name the §6.3
    residual in the test.

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
   - `packages/vscode-extension/src/util/devsync.ts` (§6.2 sketch plus the
     §6.3 policy: startup resolution, post-start correction, schedule-time
     `project.json` switch, post-apply correction),
     `tests/unit/extUtilDevSync.test.ts` (matrix B, including the §3.2
     temporal gate B.11 and the loop-preservation pins B.12/B.13).
   - Closes UX-09's achievable scope; the §6.3 refresh-triggered
     re-resolution policy is the documented behavior of this commit, and
     the §3.2 loss condition is its named residual boundary.

No release/publish step, no manifest change, no dependency change.

---

## 12. Explicit deferred issues

1. **Live filtering-root freshness — partially adopted, partially
   deferred.** The second revision ADOPTS the event-triggered form:
   re-resolution on `project.json` events and after every reported
   re-baseline (§6.3) — implementable with **no new API** beyond the
   already-proposed reader (`studio.resolveOutDir` is re-invocable and
   stateless; A.8 pins that). Still deferred: (a) per-flush
   re-resolution — rejected deliberately (§6.3): a read that runs while
   the engine may still write the old root leads the engine and re-opens
   the self-feed loop; (b) `onDidChangeConfiguration`-driven
   re-resolution — currently unnecessary, because a settings change moves
   nothing until a refresh event re-baselines the engine, and that event
   already triggers a switch point (§6.3); revisit only if a future
   session model re-baselines without watcher-visible events. Honest
   scope, per §4: every adopted re-read tracks the *configuration*, not
   the *session* — the residual windows of §6.3 are the exact price of
   that. The root still belongs as state in the R2 DevSync state owner
   (CP-04/`devsyncState.ts`) if/when that lands.
2. **Session-owned live root (Option C) or a supplementary contract** —
   the wrapper/accessor shape is the right vehicle whenever the filter
   must track the engine's *actual* write root across plan-input
   refreshes (e.g. together with CP-12 structured session status, a Core
   decision); exact plan-input-lifecycle tracking cannot be achieved by
   re-reading alone (§4). The second revision sharpens its standing: the
   §6.3 policy closes the *proven* loss paths, but its residual windows
   (during-apply saves on the scoped path; the race class) close
   **completely** only with engine truth — C is the honest vehicle for
   that, deferred until the residual windows justify the frozen-surface
   widening (§5).
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
   and no output exclusion exists at all (§3.1 case 1). The second
   revision adds the *loss* direction to the same family: a stale filter
   root inside a configured mod folder silently discards legitimate
   source after the engine's root moves away (§3.2 — proven); the §6.3
   policy closes the loss for every move the engine reacts to, and
   deliberately keeps filtering wherever the root has not verifiably
   moved, because the same layouts are the loop cases. The durable
   mitigation for the layouts themselves is configuration guidance
   (doctor `filesystem.outDirInsideProject` + Cockpit §8.4 "Change Output
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

**Second Q3 safety revision checklist (stale-outdir filtering):**

- [x] Stale-root source-loss scenario traced step-by-step against the
  implementation and confirmed by a disposable source-level probe (helper
  drop + classifier acceptance + delivery-chain replica; probe untracked,
  run once, deleted) — the first revision's "harmless for source
  delivery" claim withdrawn (§3.2, §4 Scenario 3, §6.2).
- [x] The loss condition stated precisely (stale descendant root inside a
  configured, non-excluded mod folder, engine root moved away) and every
  other stale shape shown harmless temporally as well (§3.2).
- [x] Safety invariant extended to the temporal dimension (§3.1
  invariant, §3.2).
- [x] Candidate filtering policies decided against source evidence: bare
  startup snapshot rejected (the proven loss); naive invalidation
  rejected (re-opens the self-feed loop — the build output itself
  contains mod.info files, `buildplan.ts:199-290`); per-flush re-read
  rejected (can lead the engine); session-owned root deferred. Chosen:
  refresh-triggered re-resolution (§6.3) — schedule-time switch on
  `project.json` events, post-start/post-apply corrections on observed
  re-baselines, retain-on-throw, compare-and-adopt never unconditional.
- [x] CLI parity explicitly demoted from safety evidence to a consistency
  goal — the shipped CLI watch shares the §3.2 loss (§3.2, §4.5d).
- [x] Acceptance gates added: the mandated A→B transition test with
  `session.apply`-level proof and a demonstrably detectable negative
  (B.11), loop-preservation pins (B.12), scoped-move correction (B.13),
  reader re-invocability (A.8); gates table extended (§10).
- [x] Residual windows stated exactly and bounded (§6.3): during-apply
  saves on the scoped path, the narrowed §6.2 race class, failed-rebuild
  strandings.
- [x] Option B's surface unchanged by this revision; the reader decision
  and the filtering-policy decision remain independent approvals (§0,
  §6.3).
- [x] Docs-only change re-verified: no production source, test, manifest
  or dependency touched (`git status` verified before commit).

---

## 14. Q4 addendum — the session-owned committed-baseline contract

Written at HEAD `8967ada1e51bbaa3beb2b0e0845ed8be53ed6424` (branch
`42.20.0-dev`, tree clean, no staged changes); **revised in the Q4 second
safety revision at HEAD `caf4c424e799d57c02a5428630d500ad2a2f1a1d`** (same
branch, tree clean; the only commits between the two heads are
documentation commits, so every file:line reference below is valid at
both); **revised again in the Q4 adversarial closure (third revision) at
HEAD `20b48beba26622c4ff69bf94a6240950f85fbbb6`**; **and revised once
more in the Q4 final correctness gate (fourth revision) at HEAD
`ff80f135295076daccc4692db072d0a4a35c3546`** (same branch, tree clean;
the commits between `20b48be` and `ff80f13` are documentation-only, so
every file:line reference remains valid at all four heads). The UX-09 red-first regression tests produced by the closure task
are retained in a stash identified by its message ("UX-09 red-first
regression tests (A/B/C silent source-event loss, proven at 8967ada) -
blocked on session-root contract"; `stash@{N}` positions are not
load-bearing — the message is) and were inspected **read-only**: never
applied, never popped. Design-only: no production source, test, manifest
or dependency change belongs to this addendum; the only artifact is this
section (plus the pointer blockquote in the header).

**What this addendum is and is not.** It does not rewrite the accepted Q3
contract above. The §6.1 reader (`studio.resolveOutDir`) stays exactly as
shipped and accepted. The §6.3 policy also stays as shipped — §14 is the
Q4 successor contract for the extension's filtering root, resolving
§12.2's deferral (the session-owned root becomes the recommended Q4
decision), and it supersedes the §6.3 policy's correction reads *for the
extension only* when implemented; the CLI watch keeps its start-frozen
root (§12.4, unchanged). The UX-09 closure work proved — with three red
tests retained in the stash — that §6.3's residual windows are silent
source-event losses, not cosmetic misalignments. The first revision of
this addendum answered with a predicted-root transition state machine;
the second revision re-audited the engine, found a stronger mechanism the
first revision missed (§14.3), and replaces that machinery with it. The
third revision is the adversarial closure of the second: its GO verdict
was explicitly not accepted, three counterexamples were re-audited
against source (§14.0's second table), and the corrections they force —
the T′ theorem restatement, the C7 retry queue, the C10 degraded state,
the §14.8.6 territory confirmation — are folded in below. The fourth
revision (this text) is the final correctness gate of the third: its GO
verdict was again not accepted as a given, and the three remaining proof
gaps were re-audited against the real engine at `ff80f13` — a
*successful* scoped rebuild that commits a different, incomplete output
root with no errors and no signal (C10's false negative), FIFO retry
re-delivery that can execute stale deltas with unbounded retained
memory, and a late-mutation residual mis-described as time-bounded — and
the corrections they force (the C11 root-change promotion, the C12
execution-time delete reconciliation, the dual retry-queue bound, and
the corrected residual and decision record) are folded in below. Every claim below is labeled **FACT** (verified against source
at the audited HEAD), **DECISION** (a design choice this addendum makes
and justifies), or **RESIDUAL** (a named, bounded behavior that is not a
silent loss).

### 14.0 The independent review, and what this revision answers

An independent adversarial review of the first revision identified four
significant contract gaps. The review document itself is not part of the
repository; its findings are recorded here as answered by this revision,
from the brief that commissioned it (P1–P4), together with its proposed
corrections (MC-1…MC-5), which this revision treats as proposals to
evaluate, not decisions to accept:

| Finding | Review's claim | Disposition (section) |
| :--- | :--- | :--- |
| **P1** | The COMMITTED-discard rule (former C4) can silently lose buffered source events — a build that fails before `copyTree` reaches the relevant subtree (case A), or an edit landing after the final traversal (case B), is discarded at resolution with no delivery and no guaranteed healing. | **Confirmed from source**; the fix is not a better discard rule but deletion of the buffer-and-discard mechanism (§14.9). |
| **P2** | The proposed coalesced 256-path transition buffer with `session.rebuild()` overflow recovery is unproven: coalescing semantics unspecified; whether `rebuild()` actually restores omitted changes unproven; failure paths undefined. | **Confirmed and sharpened**: the cap premise is false (overflow is the common case, not pathological), the proposed rebuild-on-overflow recovery is S2-fatal (an unbounded rebuild loop), and the buffer itself is deleted (§14.10). |
| **P3** | The former C8 rejection policy (requeue at the head of `pending`, "the existing debounce re-delivers it") is unsound: no session-identity guard specified, retry depends on new watcher events, no finite budget, no terminal semantics; a terminal log plus irreversible batch loss violates S1/S6. | **Confirmed**; reworked into a bounded, terminal-state design (§14.11). |
| **P4** | The transition lifecycle (former C4) under-specifies supersession: the armed-resolution rule protects against unrelated flush completions but not premature supersession; ownership, token identity, buffering and replay across nine phases undefined. | **Superseded**: the state machine is dissolved — the nine phases collapse under the §14.3 theorem, and every hazard the machinery guarded is discharged by a mechanism that cannot be stale (§14.12). |

The review's MC corrections, evaluated: **MC-1** (coalesced 256-path
buffer) — rejected with the buffer (§14.10); **MC-2** (`rebuild()` as
overflow recovery) — rejected as specified (the flood-loop counterexample,
§14.10.3) while `rebuild()` itself is retained as a specified, bounded
recovery primitive; **MC-3** (three-attempt retry limit) — accepted in
reworked form (§14.11); **MC-4** (armed-resolution rule) — moot with the
state machine (§14.12); **MC-5** (cached root for diagnostics) — moot: the
revised controller holds no cached root at all (§14.7 C2).

**The third revision's commission (P0-A/P0-B/P0-C).** A second
independent adversarial review challenged the second revision's theorem
and its recovery design specifically; its GO verdict was explicitly not
accepted as a given. Its findings, dispositioned from source at
`20b48be`:

| Finding | Review's claim | Disposition (section) |
| :--- | :--- | :--- |
| **P0-A** | Asynchronous watcher delivery can observe a different baseline than the one active when the underlying mutation occurred — a legitimate source edit under a *future* root, delayed past that root's commit, is dropped as territory with no guaranteed incorporation. | **Confirmed as a real window, conditional on watcher ordering** — the source provides no delivery-ordering guarantee relative to `BuildSession` assignments, so T3 (mutation provenance) is unprovable from `(type, path)` events. The theorem is restated as decision-time ownership (§14.3, T′); the window is named (§14.4.10, §14.8.6); every *non-incorporating* commit becomes observable via the C10 degraded state, leaving one named micro-residual (§14.17). |
| **P0-B** | Overlapping rejected flushes from the same live session collide in the proposed single retry slot — the second rejection overwrites the first batch; identity guards check session identity, not batch ownership. | **Confirmed** — the second revision's §14.11 rule 8 claim ("overlapping flushes cannot … drop it") was false. Replaced by a bounded FIFO failed-batch queue with one retry driver, per-entry terminal semantics and an explicit overflow policy (§14.11). |
| **P0-C** | A failed full-rebuild batch can abandon its truncated source remainder: F7 truncation + F13 abort-on-first-failing-operation leaves the edit on disk, unincorporated and undelivered, while result-level errors are treated as completely handled delivery. | **Confirmed** — healing holds only on successful rebuilds; the second revision's §14.13 disposition (log-only) and its rule-7 healing assumption fail exactly for under-root files whose next-save events the territory filter drops. Repaired by C10: re-baseline-class failures set the degraded state instead of counting as handled (§14.13); no auto-retry is attached (loop prevention stands). |
| **Territory** | The committed-outdir territory policy is a product ownership decision, not a proof that every discarded event was irrelevant. | **Accepted as a decision item** — the whole-outdir granularity is continuity with the shipped CLI watch and the Q3-accepted policy, pinned by F18; the genuinely new semantic (decision-time ownership with retroactive capture of pre-commit mutations) is stated for explicit owner confirmation (§14.8.6). |

**The fourth revision's commission (P0-D/P0-E/P0-F).** A final
correctness gate challenged the third revision's remaining proof
obligations; its findings, dispositioned against the real engine at
`ff80f13` (the behavioral counterexamples were executed as disposable
scratch tests against unmodified `BuildSession` + memory fs, then
deleted — the source-line facts were additionally re-read directly):

| Finding | Gate's claim | Disposition (section) |
| :--- | :--- | :--- |
| **P0-D** | A *successful* scoped rebuild whose fresh plan input resolves a **different outdir** commits the new baseline (520) while re-syncing only the scoped mods (F21): the new root is missing every other mod's output and `workshop.txt`, the result carries zero errors, and C10 — keyed on a non-empty `errors` array — reports nothing. The new root is committed territory, yet not a complete, usable project build. | **Confirmed as a design blocker** (real-engine counterexample: two mods, A→B via a single `mod.info` delta — `mod_beta` and `workshop.txt` absent from B, `errors: []`, baseline behaviorally proven to be B). Repaired at the engine boundary by **C11**: a root-moving scoped batch is promoted to a full rebuild (§14.7, §14.13 outcome 6). |
| **P0-E** | The failed-batch FIFO re-delivers by rejection time, not source order: a stale `delete` retried after a newer `create` deletes output the source still has — a divergence no later event heals (proven against the real engine); and the 16-entry cap bounds entries, not memory — each entry may hold an arbitrary number of paths. | **Confirmed** (real-engine counterexamples for delete-after-create, create-after-delete and repeated-change): repaired by **C12** — execution-time delete reconciliation makes delivery order unable to change the final tree — plus a **dual bound** (16 entries AND 256 total retained deltas; overflow takes the terminal path, never a silent drop) (§14.11). |
| **P0-F** | §14.17 described the successful-build late-mutation residual's bound as "the next successful full rebuild" — but no such rebuild is guaranteed to occur, and in case-6 layouts even re-saving the missed file does not deliver (its event is territory). The residual can persist **indefinitely**. | **Confirmed**: the bound claim is withdrawn; the residual is restated as unbounded-until-user-action; the two possible contracts are separated with their exact costs; and the S1 relaxation the territory policy implies is stated verbatim for the owner decision (§14.8.6, §14.8.7, §14.17). |

### 14.1 Confirmed source facts (all file:line at `caf4c42`; re-verified
### at `20b48be` for the third revision, whose additions are F19–F21, and
### at `ff80f13` for the fourth revision, whose addition is F22)

Facts the Q3 document established, facts the first Q4 revision added, and
new facts this revision adds, each re-verified by direct reads at the
audited HEAD. **FACT** throughout.

Engine (`packages/core/src/buildsession.ts` unless noted):

- **F1 — the baseline is one private field.** `planInput:
  Omit<PlanBuildInput, 'variant'> | undefined` (`buildsession.ts:339`). No
  accessor, no event, no status enum. `BuildSession`'s public surface is
  `start`/`rebuild`/`apply`/`stop` (358–396) — the matrix §1 freeze Q3
  relied on.
- **F2 — exactly four assignment sites**, each in the same synchronous
  continuation as its own `await this.host.getPlanInput()`: `start()`
  (365 — before the initial build runs, and *not* serialized through the
  apply queue), `rebuild()` (379, inside the queue), the scoped path of
  `applyCoalesced` (519–520 — the assignment at 520 is **not** inside any
  try/catch), and `doFullRebuild` (545, inside the try/catch at 543–551).
  A whole-tree grep confirms there is no fifth site.
- **F3 — the output root is never stored.** Every engine write derives
  `resolveBuildOutputPath(config, variant)` = `joinPosix(config.outdir!,
  sanitize(title) [+' - dev_branch'])` (`buildplan.ts:119–129`) from the
  *current* `this.planInput.config` at operation time — full build
  (`buildsession.ts:425` via `buildVariants`' `this.planInput` read at
  409), scoped rebuild (529, from the just-assigned `freshInput`),
  incremental mod-file sync (558/630), workshop text (679), preview
  (705). "The root the engine uses" is a function of (planInput, time),
  not a field.
- **F4 — full-rebuild failure shapes are asymmetric** (543–551): a
  plan-input-phase failure (`getPlanInput` throws at 545) skips the
  assignment — the baseline is **retained**; a build-phase failure
  (`buildVariants` throws after 545 completed) leaves the **new input
  committed**. Both produce the identical observable result
  `{ fullRebuild: false, errors: [...] }` — `result.fullRebuild = true`
  (547) is reachable only on success. Consequence: Q3 §6.3.3's rule
  ("`fullRebuild` or `scoped.length > 0` are the only result shapes a
  re-baseline produces") is correct only in the forward direction;
  `fullRebuild === false` does **not** imply the baseline did not move.
- **F5 — the scoped path escapes the failure envelope.** The plan input is
  fetched at 519 outside any try/catch, so a scoped plan-input rejection
  **rejects `apply()`** — contradicting apply()'s own contract comment
  ("Never throws: per-action failures are collected in the result",
  384–387). Per-variant execution failures *are* normalized (526–534), and
  `result.scoped` is pushed regardless of execution outcome (536) because
  the baseline was already committed at 520.
- **F6 — queue and lifecycle.** `enqueue` (398–406) serializes
  apply/rebuild work and survives rejections; `stop()` sets `stopped` and
  drains the queue (393–396); `applyCoalesced` no-ops when stopped or
  before the first assignment (449–451). `start()` is deliberately **not**
  enqueued: a delta delivered during the initial build would run
  concurrently with it. Both in-repo hosts order start before any event
  delivery (extension: `util/devsync.ts:112–117` subscribes after
  `await session.start()`; CLI: `commands/watch.ts:73` then subscribe at
  116) — a host convention, not an engine guarantee.
- **F7 — a full-rebuild delta truncates its own batch's remainder**
  (`return result` at 472). Disk-safe: `planBuild` deletes and recreates
  the *variant folder* `resolveBuildOutputPath(config, variant)` before
  copying (`buildplan.ts:341–342` — the outdir container itself is never
  deleted) and re-reads the live source tree, so any same-burst source
  edit already on disk is incorporated by the rebuild itself — the fact
  Q3 §6.3 already relied on.
- **F8 — three failure phases inside one plan input.** `getPlanInput`
  (`packages/cli/src/lib/devsync.ts:71–88`) resolves config
  (`resolveProjectConfigFor`, 74 — the point where `config.outdir` becomes
  known), then the workshop template (80–86), then per-mod source
  snapshots (`gatherPlanInput`, 87). A failure in the later phases leaves
  the resolved outdir known to the wrapper but **unassigned** in the
  engine — the baseline stays on the old input. Only the engine's failure
  envelope (F4/F5) decides whether a resolved input was committed.

Executor and planner (new facts this revision adds):

- **F13 — the executor aborts on the first failing operation.**
  `executeFileOperations` runs the plan's operations in order and throws
  on the first failure (`packages/core/src/execute.ts:262–310`; only
  lock-error codes are re-wrapped, 272–283). `buildVariants` catches
  per-variant and **continues to the next variant** (`buildsession.ts:
  422–433`), then throws if any variant failed (434–436). Consequence: a
  build-phase failure leaves every operation *after* the failing one
  unexecuted for that variant — a mod whose `copyTree` follows the
  failing operation is never written, even though the baseline (assigned
  at 545) already names the new root.
- **F14 — `copyTree` reads the live tree with no output-root exclusion.**
  The traversal lists and reads the source tree at execution time
  (`execute.ts:202–228`); its filters are `.pzstudioignore` rules, dot
  files, `.gitkeep`, and the project `excludes` list (via `ignoreItems`)
  — nothing excludes an output subtree that happens to lie inside the
  copied source (there is no destination check). Consequence: in a
  §3.1-case-6 layout (outdir inside a mod folder) every full build and
  scoped rebuild copies the outdir subtree's *current content* into the
  mod's output as if it were source — a bounded, one-generation
  self-embedding that is **pre-existing `pzstudio build` semantics**
  (each build deletes the variant folders first, so nothing accumulates).
- **F15 — `gatherPlanInput` is fully fresh and synchronous** (`packages/
  cli/src/lib/helper.ts:836–858`): config (F8), template, per-mod source
  snapshots, workshop metadata — everything a plan input needs is re-read
  at call time. `rebuild()` and every engine re-baseline therefore
  observe the world as of their own call; no mod metadata or source
  discovery can remain stale across a re-baseline.
- **F16 — `makeDir` materializes through a sentinel file**
  (`execute.ts:286–294`): a write+delete of `.pzstudio-mkdir` inside the
  target directory. Engine makeDir operations therefore generate
  create+delete event pairs — dropped by the outdir rule *and* the dot
  rule of `isWatchPathIgnored`.
- **F17 — `coalesceDeltas` semantics** (`buildsession.ts:61–85`), the
  exact coalescing the engine applies to every batch: paths are
  normalized (backslashes fold to `/`, trailing separators drop,
  case-sensitive); each path appears once with its **final state** —
  create→change stays `create`; any→`delete` stays `delete`;
  `delete`→`create` becomes `create`; `create`→anything stays `create`;
  `change`→`change` stays `change`; first-occurrence order is preserved;
  the *latest* path spelling wins. Repeated changes to one path collapse
  to a single final-state delta; a path created and deleted in one window
  collapses to `delete`.

Controller, hosts and tests:

- **F9 — every filter-root read is a fresh read.** The controller
  re-resolves at four points (`packages/vscode-extension/src/util/
  devsync.ts`: pre-start 100, post-start correction 106–110, schedule-time
  switch on a root-level `project.json` 171–177, post-apply correction
  213–224 guarded on the F4-shaped result heuristic and session identity)
  — each a fresh `resolveOutDir` read, documented as "NOT a handle on a
  running BuildSession's baseline, and not synchronized with one"
  (`packages/cli/src/lib/studio.ts:121–129`).
- **F10 — a rejected apply loses its batch on both hosts.** The extension
  splices the batch before the await (`util/devsync.ts:202`) and fires the
  flush as `void this.flush()` (195): a rejected `apply` becomes an
  unhandled promise rejection and the spliced batch is silently abandoned
  — no log, no requeue. The CLI watch has the identical shape
  (`commands/watch.ts:82–96`, `void flush()` at 101). The defect is
  cross-host.
- **F11 — the v2 session type is the core class.** `PzStudio.createDevSync`
  returns `BuildSession` directly (`studio.ts:100`; the type re-exported
  through `api.ts:59–66` ← `lib/devsync.ts:158–163`). There is no v2
  session wrapper interface. `IProjectConfig.outdir` is optional
  (`core/src/project.ts:104/119/126`) but `resolveProjectConfigFor` always
  yields a non-empty resolved outdir in the DevSync path (every falsy tier
  falls through to the default — `helper.ts:689–712`).
- **F12 — test stubs double-cast.** Extension-test session stubs are
  `as unknown as BuildSession & {…}` (`tests/unit/extUtilDevSync.test.ts:
  76–97`): additive class members do not break their compilation, but
  stubs must gain any newly read member for runtime behavior. Real-engine
  tests drive actual `BuildSession` instances (`extUtilDevSync.test.ts:
  1373+`).
- **F18 — the stashed A1 control pins outdir-granular post-commit
  filtering.** The stashed A1 test's control phase asserts that after a
  *successful* re-baseline to B, an event under B **but outside B's
  variant folder** (the stash fires `<outB>/media/lua/revived.lua` where
  the engine writes `<outB>/<title>/…`) is **filtered** (not delivered).
  The outdir subtree, once committed, is engine territory by the test
  record — this gates the getter's granularity (§14.6) and the territory
  contract (§14.8.3).
- **F19 — watcher delivery is asynchronous, batched and unordered
  relative to engine continuations.** The CLI's parcel callback delivers
  whole event *arrays* per tick (`watch.ts:117–138`); the extension's
  `FileSystemWatcher` handlers fire across the extension-host boundary
  (`util/devsync.ts:115–117`). No host's source contains any ordering
  contract between a filesystem mutation and the callback that reports
  it, nor any bound on the mutation→callback interval (a full rebuild's
  own output flood is a routine queue-delay source). The interval can
  span any number of `BuildSession` assignments. Consequence: **no
  mechanism built on `(type, path)` events can recover the baseline
  (or ownership status) that was current when the mutation occurred** —
  only decision-time state is available.
- **F20 — full-rebuild truncation is position-independent within the
  batch.** `applyCoalesced` classifies the whole batch in one loop and
  only *executes* incremental writes after it (`buildsession.ts:459–514`);
  the `full-rebuild` case returns at 472 before that phase. A source
  delta positioned *before* the `project.json` delta in the same batch
  is exactly as truncated as one after it — nothing in the batch except
  the rebuild itself is ever applied.
- **F21 — a scoped rebuild re-syncs only the scoped mods.** The scoped
  block commits the fresh input for the whole config (`buildsession.ts:
  519–520`) but executes `planScopedModRebuild` only for the mods whose
  `mod.info`/`.pzstudioignore` changed (521–537). A root move committed
  on the scoped path therefore leaves every *other* mod's output absent
  from the new root (pre-existing engine semantics, host-independent);
  the next successful full rebuild is what completes it. *(Fourth
  revision: the engine-level fact stands, but the contract no longer
  lets a root move reach the engine through this path — C11 promotes a
  root-moving scoped batch to a full rebuild before it can commit an
  incomplete root, §14.7; for a stable root this fact is exactly what
  makes a scoped re-baseline unable to clear C10's flag, §14.13.)*
- **F22 — the scoped block is the only re-baseline site that can move
  the output root without a full rebuild (new in the fourth revision).**
  Site-by-site over F2's four assignment points: `start` (365) runs
  `buildVariants` immediately after its assignment (366); `rebuild`
  (379) likewise (380); `doFullRebuild` assigns and builds in one
  envelope (545–546); the scoped block assigns (520) and then re-syncs
  only the scoped mods (521–537). A root move that leaves the new root
  incomplete can therefore originate **only at 520** — the exhaustiveness
  fact that makes C11's single-site promotion close the entire class
  (there is no second site to guard). **FACT** (site-by-site read;
  the workshop-text and preview writers re-baseline nothing).

### 14.2 The four states, and which one the filter needs

| State | Definition | Where it lives |
| :--- | :--- | :--- |
| **S1** — last configuration resolved successfully | the outdir of the most recent successful `resolveProjectConfigFor` run, by *any* reader — including reads that are not plan inputs at all (`studio.resolveOutDir`) | transient inside resolver calls and fresh reads |
| **S2** — last plan input returned successfully | the most recent `getPlanInput()` completion | the wrapper closure under Option A |
| **S3** — plan input assigned to the session | `this.planInput` (F2) | BuildSession private state |
| **S4** — output root used by the engine for build operations | `resolveBuildOutputPath(this.planInput.config, variant)` evaluated at each operation (F3) | derived: f(S3, time) |

The Q3 distinction ("fresh read ≠ baseline") is S1 ≠ S3. The Q4 question
is whether S2 ≡ S3 closely enough to build the filter on S2:

- **S2 and S3 differ only inside a microtask.** Between a `getPlanInput`
  completion and the assignment continuation nothing else is scheduled
  (F2: all four sites assign first). The controller's observers —
  `schedule` runs in watcher-event macrotasks, `flush` in timer macrotasks
  and in the post-await continuation of an apply that has fully settled —
  cannot observe the gap. But nothing in the type system enforces "every
  resolved input is assigned"; it holds by the four-site convention (F2).
- **S1 and S3 diverge for whole macrotask windows.** S1 advances on every
  successful config read (pre-start reads, schedule-time switch reads,
  post-apply corrections) and on plan inputs whose later phases fail (F8)
  — where S3 provably did not move. That is exactly the A1/C1 class, and
  why a filter built on S1 can only ever be heuristic.

**Answer to the brief's question:** a CLI wrapper that records
`config.outdir` inside `getPlanInput()` *can* temporarily expose a new
root before `BuildSession.planInput` is assigned — in an
unobservable-to-hosts microtask window if (and only if) it records at
plan-input **completion**, and in a fully observable macro window if it
records earlier (e.g. right after config resolution succeeds — F8: a
template or snapshot failure then leaves the wrapper on a root the engine
never commits, reintroducing the A1 shape from the recording side). A
completion-recorded closure is therefore "the latest resolved plan input"
by mechanism and "the committed baseline" only under two unenforced
conventions (record-at-completion; every-resolution-is-assigned). §14.6
selects the contract that makes the equivalence hold by construction.

**The three guarantee levels the third revision separates (normative
vocabulary).** The second revision proved one property and inferred two
more from it; the inference was the error. Stated separately:

- **T1 — assignment-before-engine-write.** The engine assigns its
  baseline before writing under it. **Proven from source** — F2/F3, the
  proof obligations below.
- **T2 — callback-time observation.** A `schedule()`-time getter read
  observes the committed baseline as of that instant. **Proven from
  source** — the getter is the field itself (C1); nothing separates the
  read from the state.
- **T3 — mutation provenance.** The baseline observed at callback time
  identifies the baseline (and ownership status) that was current when
  the underlying filesystem mutation occurred. **NOT provable from
  source** — F19: delivery is asynchronous and unordered relative to
  engine continuations; the mutation→callback interval can span
  assignments. T3 does not follow from T1 + T2 without a
  delivery-ordering guarantee no host provides. Everything below is
  therefore derived from T1 + T2 alone; wherever a claim would need T3,
  it is named as a residual instead of asserted.

### 14.3 The assignment-before-write visibility theorem (restated as T′ in the third revision — still the linchpin)

The first revision built a prediction/buffer/resolution machine because
it assumed the filter cannot see the moment the engine's write root
moves. The source says otherwise. The second revision stated the
resulting theorem with a stronger second sentence than the source
supports; the third revision narrows it to exactly what is proven. **FACT
(each clause cited):**

> **Theorem T′ (assignment-before-write visibility, decision-time form).**
> Every filesystem write or delete the engine performs derives its output
> root from `this.planInput` read at operation time (F3), and every
> assignment to `this.planInput` (F2's four sites) happens in the same
> async continuation chain strictly before the writes that follow it:
> `start` 365 → 366; `rebuild` 379 → 380; scoped 520 → 526+; full
> 545 → 546; the incremental, workshop-text and preview writers read
> `this.planInput` per operation (558, 665, 701) and run only in the
> pre-assignment phase of their batch. Therefore, at any instant, the
> engine's committed baseline names the root — and the whole outdir
> subtree — under which all engine activity at that instant occurs, and
> a `schedule()`-time getter read observes that same state (T1 + T2,
> §14.2). The getter read therefore supports exactly one drop rule:
> **at decision time, the committed root's subtree is engine territory,
> and every other path is not.** The theorem makes **no claim about when
> a watcher event's underlying mutation occurred** (T3 is unprovable —
> F19), and no claim that an event under the committed root at decision
> time was engine-generated or was incorporated by the commit that
> named that root.

**What the second revision's stronger form claimed, and why it fails
(noted for the record).** Theorem T's original headline — "no
engine-generated event can ever be classified against a getter value
that does not name the root the event came from" — asserted T3. The
"Watcher latency" proof obligation reasoned "the engine wrote it under
that same root at write time" from "between write and read the root can
only have moved by a *later* re-baseline"; the premise is true
(assignment order, T1) but the conclusion does not follow, because the
delivery interval is unbounded (F19) and a later re-baseline can
*adopt the event's own root* (a case-6 A→B move makes formerly-forwarded
under-A paths drop, and under-B paths that were legitimate source at
mutation time drop). No `(type, path)` event stream can distinguish
engine output from a user mutation under the same path — §14.8.3 already
stated this as the indistinguishability fact; the original theorem's
headline contradicted it. The revised drop rule (decision-time
ownership) is the one both revisions actually specified; T′ aligns the
theorem with the specification.

Proof obligations, discharged against source:

- *No pre-assignment writes to the future root.* `doFullRebuild` assigns
  (545) before `buildVariants` (546) writes anything; the scoped block
  assigns (520) before its `executeFileOperations` (527); `start` and
  `rebuild` likewise. The first revision's "pre-assignment full-rebuild
  writes to the predicted root" — the window its transition buffer
  claimed to cover — **does not exist**: there are no engine writes
  under any root before that root is assigned, and after the assignment
  the getter already names it.
- *Overlapping applies.* The queue serializes (F6); a later batch is
  classified and written against the baseline an earlier batch left.
  An event scheduled while batch *n* writes root X is read against the
  getter **at schedule time**: if batch *n*+1 has since re-baselined to
  Y, the event is not under Y's root and is forwarded — the engine
  applies it against its current baseline and writes into the current
  root (terminating, bounded one-generation garbage — §14.8.4); if not,
  the event is under X — the committed root at **decision time** — and
  is dropped. Sound in both orders *as a decision-time rule*; what the
  drop means for a delayed mutation is §14.8.5's business, not this
  obligation's.
- *Delivery latency (corrected — was "Watcher latency").* A mutation's
  event arrives after the mutation by an **unbounded, unordered**
  interval (F19). At decision time exactly one of two dispositions
  occurs, both safe as decisions: the event is under the root the
  getter currently names (dropped — territory; what that means for a
  delayed mutation is governed by §14.8.5, not by this theorem), or it
  is under a root the engine has left or never committed (forwarded —
  the engine classifies it against the committed baseline, a
  terminating write, §14.8.4). **Engine-output events under an
  abandoned root are therefore forwarded, not filtered** — bounded
  garbage by the §14.8.4 analysis, never loop protection in the strong
  "every engine event is filtered" sense. No mis-dropped *decision*
  exists under T′; whether a drop loses a *mutation* is the residual
  the territory contract owns.
- *Batch truncation (corrected).* A full-rebuild delta truncates its
  batch's remainder (F7) — same-batch events are never classified
  (position-independently, F20). Their disk mutations preceded the
  flush (watcher events trail disk writes), and the rebuild's
  `copyTree` reads the live tree at execution time (F14), so truncated
  edits are incorporated by the rebuild itself **iff the rebuild
  succeeds** — F13's abort-on-first-failing-operation bounds that
  guarantee. A late-delivered event (arriving after the rebuild) is a
  *later batch*, classified normally. The failed-rebuild remainder is
  owned by C10 (§14.13), not by this theorem.
- *Rapid alternation and containment (new obligation).* A→B→A changes
  produce, at each decision, the same two-way split — under the
  current committed root or not; no decision requires knowing the
  order of past re-baselines, so rapid alternation adds bounded churn
  (forwarded stale-root events per move, §14.8.4) but no new drop
  shape. Roots that contain one another (an outdir at
  `<project>/a/b` while a previous root was `<project>/a`): the
  helper's segment-exact relative test (`watch-shared.ts:44–48`) makes
  the deeper root's subtree a strict subset — the two configurations
  filter nested territories, each decision taken against the getter's
  single current value; no combined or shadowed state is ever
  consulted. Both cases are decision-safe under T′ without additional
  mechanism.

**Consequences (normative for everything below):**

1. An outdir-level committed-baseline getter, read live at schedule
   time, is a **sound decision-time loop-protection authority**: under a
   stable root, every engine write lands under the root the getter
   names when the write's event is decided, and is dropped. Under root
   moves the protection degrades *safely*: engine events from an
   abandoned root are forwarded and re-absorbed (bounded one-generation
   garbage, §14.8.4) — bounded forwarding, not universal event
   filtering, is the honest statement of the loop property (§14.8.4's
   no-self-sustaining-cycle proof).
2. A path **outside the committed root at decision time** is not
   identifiable as engine output and is forwarded. Forwarding is safe:
   the engine classifies it against its committed baseline and writes
   into the committed root (terminating). In particular the A1 window —
   a predicted root the engine never adopts (failed plan input) — needs
   no buffer and no replay: the events are simply delivered, which is
   what the stashed A1 test requires.
3. No prediction, no transition state, no buffer, no correction read
   can improve on the live getter for the *decision* it makes, because
   none of them can be *less stale* than a value that is never stale —
   and none of them can recover a delayed mutation's provenance either
   (T3, F19): provenance-based narrowing is not a better design, it is
   an impossible one on the available information. Every root-holding
   structure the first revision introduced is strictly redundant.

### 14.4 Failure timelines (ten scenarios, re-derived)

For each scenario: the authoritative engine baseline (S3), what the live
getter exposes, and the disposition under the revised contract. **FACT**
for the source clauses; **DECISION** for the disposition.

1. **Initial `session.start()`.** Assignment at 365 precedes the build; a
   `buildVariants` failure rejects `start()` with the baseline already
   committed (the controller's catch stops the session — `util/devsync.ts:
   125–133` — so the extension never observes this state; the CLI watch
   exits, `watch.ts:74–78`). Getter: `undefined` until 365, then the
   initial root for the session's lifetime. There is no pre-start filter
   read to diverge (the revised controller makes none — C6). **The getter
   is the authority from the first assignment onward.**
2. **Successful full rebuild.** Classification 469–472 →
   `doFullRebuild`: assignment 545, build succeeds, `fullRebuild: true`.
   The getter flips at 545 — *before* the rebuild writes anything — so
   the rebuild's own output events are dropped from the first write.
   **Getter: the fresh root, never trailing.**
3. **Full rebuild with plan-input failure.** 545 throws inside the
   try/catch; baseline **retained** (A1's mechanism); result
   `{fullRebuild: false, errors}` (F4). Getter: unchanged (no
   completion). Events under the predicted-but-uncommitted root that
   arrive while the attempt has failed are forwarded and applied
   against the retained baseline (consequence 2). **A1's loss is
   structurally absent for this state** — conditional, as every
   territory drop now is: an under-B event *delayed past a later
   successful commit of B* is territory (scenario 10), and the failed
   attempt's errors now set the C10 degraded state (§14.13), which is
   what makes the A1 outcome (delivery) resumable rather than assumed.
4. **Full rebuild with build-phase failure after assignment.** 545
   completed, `buildVariants` threw (A′); baseline = the **new input**
   (committed despite the failure — its outputs are partial per F13: the
   operations after the failing one never ran). Result shape identical
   to scenario 3 (F4) — but the getter distinguishes them (unchanged vs
   moved), which is the consumer-visible difference the first revision's
   R2 pinned. The filter follows the getter to the new root: its
   (partial) output events are dropped; old-root events are forwarded
   and synced into the new root by the engine (terminating). **Getter:
   moved; no result-shape heuristic involved.**
5. **Successful scoped rebuild.** The incremental phase writes under the
   old root (getter still old — drops apply); 519–520 commit the fresh
   input mid-apply; the scoped `copyTree` writes the new root (529) under
   the getter's new value (dropped). **Getter: flips exactly at 520,
   between the two write phases.** *(Fourth revision: this scenario is
   the **stable-root** shape only. When the fresh input's outdir differs
   from the committed baseline, C11 promotes the batch to a full rebuild
   — the getter still flips exactly at 520 before any write, and the
   promoted build completes the new root instead of committing it
   incomplete; the pre-assignment incremental writes, if any, land in
   the abandoned root as bounded garbage (§14.8.4). See §14.13 outcome
   6.)*
6. **Scoped rebuild failure before assignment.** 519 throws outside any
   try/catch: the rejection escapes `apply()` (F5) → cross-host batch
   loss (F10). Baseline retained. After the C7 fix: result
   `{errors: [msg]}`, baseline retained, no rejection. **The delivery
   pipeline, not the baseline, is what broke; C7 owns the pipeline
   (§14.11).**
7. **Scoped rebuild failure after assignment.** 520 committed;
   per-variant execution failures collected (526–534); `scoped` still
   reported (536). The getter has moved; the filter follows; partial
   output is territory (F13 bounds what was written). **Getter: moved.**
   *(Fourth revision: with C11, a root-moving scoped batch that fails
   after assignment is the promoted full rebuild's build-phase failure —
   the F4 shape, C10-flagged; a stable-root scoped failure keeps this
   shape with the root unchanged.)*
8. **Overlapping controller flushes × the serialized apply queue.**
   Flushes overlap freely (no in-flight guard; the debounce only orders
   scheduling); the session's queue (F6) serializes their applies; each
   batch is classified against the baseline current at *its* execution.
   Event-level filtering happened at schedule time against the
   then-current getter — the forward direction (consequence 2) absorbs
   every mismatch, the drop direction is a decision-time territory
   drop (§14.8.5 governs what it means for delayed mutations).
   **Safe at both layers as a decision rule; no cross-flush state
   exists to desynchronize.**
9. **Delayed delivery across a root move (P0-A — new in the third
   revision).** The mutation→decision interval is unbounded (F19), so a
   *user* mutation can be decided after the mutation's root has been
   committed by a re-baseline that did not incorporate it. Full
   timeline (the case-6 shape, all steps source-grounded):

   ```text
   Baseline A (case-6 root inside a configured mod).
   User edits <A>/media/lua/revived.lua — legitimate source at
     mutation time (classifyDelta against the current plan input
     has no outdir rule; the engine would sync it into A).
   A project.json event (or a scoped trigger) flushes; the engine
     commits root B (545 or 520) and — failure shapes F13/F20 —
     does not copy revived.lua into B.
   The edit's watcher callback is finally delivered.
   getBaselineOutDir() → B; isWatchPathIgnored(projectDir, B,
     <A>/media/lua/revived.lua) → true (B's subtree covers A when
     A ⊂ B; conversely an under-B edit after an A-commit is
     covered by the same rule when B ⊂ A).
   The event is dropped as territory — with no delivery, no
     retry, and (pre-C10) no observable signal.
   ```

   Determination, point by point: (1) the mutation **was legitimate
   source when it occurred** — classification happens against the
   plan input at apply time, and ownership is not retroactive in
   intent; (2) the commit to B **does not necessarily incorporate** the
   mutation — F7's healing requires a successful rebuild, F13 bounds
   it to operations before the first failure, and a scoped commit
   re-syncs only the scoped mods (F21); (3) the callback-time getter
   **cannot distinguish** this case from an engine-output event — T3
   is unprovable (F19, §14.8.3); (4) the territory contract **is
   decision-time and therefore does reclassify ownership
   retroactively from the event's viewpoint** — that semantic is
   explicit product policy, stated in §14.8.6; (5) without C10 the
   event **could remain unprocessed indefinitely** (no later event
   exists — the file was not re-saved; nothing else names it); with
   C10 every non-incorporating commit leaves an observable degraded
   state whose resync heals it, and the §14.17 micro-residual covers
   the incorporating-commit remainder. Reverse ordering (engine writes
   under A; baseline moves to B; A's delayed output event arrives;
   getter returns B): the event is **forwarded** (not under B) and
   re-absorbed per §14.8.4 — bounded forwarding is the actual loop
   behavior; no universal "every engine-generated event is filtered"
   claim survives F19. **Getter: the decision is always well-defined;
   the mutation's meaning is the named residual.**
10. **Stop/restart and stale asynchronous completion.** `stop()` clears
    controller state, disposes the watcher, drains the session queue
    (`util/devsync.ts:137–151` + F6). An in-flight flush's continuation
    is identity-guarded (213–215 shape retained) so it cannot adopt
    into the next session; its spliced batch may still be written by
    the *old* session after the new one started (bounded: one drained
    batch; the watcher is gone). C7's failed-batch queue is
    identity-guarded the same way (§14.11). **The new session's getter
    is the only authority read after restart; the old session's getter
    is dead state that is never read.**

### 14.5 Assessment: closure snapshot vs committed baseline

The closure *can* be made equivalent to the committed baseline at every
macrotask boundary, but the equivalence rests on two unenforced
conventions — record-at-completion, and every-resolution-is-assigned
(F2) — and breaks silently if either drifts. F8 is the recorded-early
trap; any future non-assigning `getPlanInput` consumer in core (a
speculative read, a CP-12 status probe) would break the second. The
closure also needs a wrapper type: `createDevSyncCore` returns
`new BuildSession(host)` (`lib/devsync.ts:97`) today, so exposing a
closure means `DevSyncSession extends BuildSession` plus widening
`PzStudio.createDevSync`'s declared return type — a new exported type on
the v2 surface. Verdict: **do not accept the closure proposal as
proposed**; it is correct today but convention-bearing. §14.6 selects the
by-construction alternative.

### 14.6 Options comparison and selection

**Option A — CLI closure snapshot** (`createDevSyncCore` records the
completion outdir; a `DevSyncSession extends BuildSession` wrapper exposes
`getEffectiveOutDir()`):

- *Authority/consistency:* indirect — S2 tracks S3 by convention
  (§14.5); equivalent at every macrotask boundary today; not
  type-enforced.
- *Assignment/observation ordering:* microtask gap, unobservable to
  hosts; the recording-point discipline is load-bearing (F8).
- *Failed rebuilds:* plan-input failure → closure unchanged (aligned);
  build-phase failure → closure moved *with* the engine (it records the
  input that was committed). No divergence in either direction today.
- *Instance/session isolation:* per-session closure; R0/R1 unchanged;
  no ambient reads.
- *Lifecycle:* `undefined` until the first completion (partial
  function); retains the last value after `stop()` (harmless; hosts
  discard the session).
- *Compatibility:* core untouched (the matrix §1 freeze and CP-12 stay
  intact), but the v2 surface gains an exported wrapper type and a
  widened `createDevSync` return type; `PzStudio.resolveOutDir`
  unaffected.
- *Testability:* convergence pinnable per assignment site with a fake
  host; wrapper forwarding pinnable; the convention itself is **not**
  pinnable against future core changes (a test can only pin today's
  four sites).

**Option B — Core-owned committed-baseline accessor** (`BuildSession`
gains a read-only getter over F2's field — shape
`getBaselineOutDir(): string | undefined` returning
`this.planInput?.config.outdir` — surfaced through the *existing*
`PzStudio.createDevSync` return type; no wrapper, no new type):

- *Authority/consistency:* direct — the getter **is** S3; divergence is
  impossible by construction; the microtask question disappears (there
  is no second recording). With theorem T′ it is a *decision-complete*
  filtering authority (consequences 1–3), which is what the first
  revision did not realize.
- *Assignment/observation ordering:* reads observe assignments exactly
  (same field, same synchronous domain).
- *Failed rebuilds:* scenarios 3 vs 4 become **distinguishable** at the
  consumer (getter unchanged vs moved) — F4's asymmetry becomes usable
  information instead of a trap for the result-shape heuristic.
- *Instance/session isolation:* a pure private-field read; no ambient,
  no legacy slots; browser-safe (a string field on a host-agnostic
  class); R0/R1 intact (C9/C10 below).
- *Lifecycle:* `undefined` before the first assignment (documented);
  retains the last value after `stop()` (harmless — sessions are not
  restarted; the controller clears its own state).
- *Compatibility:* one additive member on an already-exported class —
  no interface change (`PzStudio` is untouched), no new export, no
  signature change. Existing consumers compile unchanged; structural
  literal implementers would break at compile exactly like any additive
  member (none exist in-repo — F12's stubs double-cast).
- *Testability:* getter convergence needs no per-site pinning (it is
  the same field); the scenario-3-vs-4 distinction is directly
  testable; stubs gain one member (F12).

**Option C — epoch/generation snapshot** (a baseline-change counter, or a
`{root, generation}` snapshot):

- Would add value only if a consumer needed to correlate an event with
  the baseline version it was classified against. The revised contract
  holds **no cross-event state** (§14.7) — there is nothing to
  correlate. **Rejected** as unproven additional surface. Revisit only
  if a future design cannot name its release conditions without one.

**Getter granularity — a question the first revision never asked.** The
engine's actual write surface is the per-variant folders
`resolveBuildOutputPath(config, variant)` (F3), not the outdir itself:
the engine never writes under the outdir *outside* its variant folders,
and never deletes anything outside them (F7). A getter exposing the
variant folders would let the filter drop a strictly smaller set. It was
evaluated and **rejected**: (a) F18 — the stashed A1 control pins
outdir-granular filtering after a successful re-baseline (an event under
the outdir but outside the variant folders is expected to be *filtered*);
the narrower drop set breaks a compatibility gate; (b) the outdir
subtree's territory status is the ownership contract this addendum
codifies (§14.8.3) — the variant-folder refinement would silently
reclassify part of that territory as source; (c) it is a wider surface
buying nothing the theorem needs. The outdir-level getter is the
contract.

**Selection: Option B.** Correctness: by construction beats by
convention (§14.5). Surface: one member on an existing class beats a new
exported type plus a widened signature. The Q3 §5/§12.2 objections are
resolved, not ignored: (a) CP-12 is structured session *status* (phases
and events for the Cockpit state owner, doc 12's CP-12 row); a single
derived read-only scalar is not status events and does not preempt that
surface — the getter can seed CP-12 later, not the reverse; (b) the
partial function is real but harmless: the only consumer (the
controller) reads it strictly after `start()` resolves (F6 ordering),
and `undefined` before start is *honest engine truth* — the total
function Q3 preferred is precisely the fresh read whose false confidence
produced C1. This addendum resolves §12.2's deferral: the residual
windows it reserved engine truth for are now proven losses (the stashed
A1/B1/C1), which is the justification §12.2 asked for. Option A is
recorded as the runner-up (correct today, cheaper for core, but
convention-bearing and surface-heavier); Option C is rejected.

### 14.7 The selected contract (normative invariants, second revision)

- **C1 — committed-baseline authority.** `BuildSession` exposes the
  committed baseline's output root and nothing else:
  `getBaselineOutDir(): string | undefined` — `this.planInput?.config.outdir`.
  The full private `PlanBuildInput` stays private. `undefined` means "no
  plan input has ever been assigned" (pre-first-assignment only). The
  name is a suggestion; the contract is the semantics.
- **C2 — the filter reads the committed root, live, per event.** The
  controller's schedule-time drop decision is
  `session.getBaselineOutDir()` fed to
  `isWatchPathIgnored(projectDir, root, path)`, **read at every event**
  — never cached. The `filterRoot` field is **deleted** (no correction
  reads exist to maintain it, and a cache would reintroduce the S1/S3
  divergence class Q4 exists to close). Fail-open: `undefined`
  forwards. Because the getter is the engine's own field (C1, theorem
  T), this is the *only* root state in the delivery path.
- **C3 — no prediction, no transitions.** The schedule-time switch on
  root-level `project.json` events, the predicted-root transition, the
  open/resolve lifecycle and the buffer (first revision C3–C5) are
  **deleted**. A root-level `project.json` event is delivered like any
  other event; the engine's full rebuild re-baselines; the getter
  follows at the assignment (theorem T′) — *adopt-on-commit replaces
  adopt-on-prediction*, which is strictly safer: a prediction the
  engine never commits (A1) adopts nothing.
- **C4 — no buffer, no cap, no overflow.** The transition buffer is
  deleted with C3. The only buffered event state in the delivery path is
  `pending` — the pre-existing debounce queue, unchanged in shape and
  bound (Q3 shipped it; its burst bound is the debounce window plus
  watcher throughput, and its flood source — unfiltered engine output —
  is removed by C2). A failed batch never re-enters `pending` (C7 owns
  it separately).
- **C5 — correction reads disappear entirely.** The post-start
  correction and the post-apply correction (Q3 §6.3.3), and the
  schedule-time switch read (Q3 §6.3.2), are all deleted — there is no
  filter root to correct. The controller performs **zero**
  `resolveOutDir` calls. `studio.resolveOutDir` remains in the surface
  unchanged (Q3 contract, §5/§6.1) for hosts, diagnostics and tests;
  it simply has no in-policy controller caller anymore. The startup
  sequence reduces to `createDevSync` → `await start()` → subscribe: a
  broken config now fails at the session's own plan input (the same
  resolver error), and the existing UX-06 catch path (warn, stop the
  half-start, rethrow) owns the notification — the fail-closed
  alignment §6.2 documented is preserved with one fewer read.
- **C6 — (renumbered) apply never rejects (engine normalization).** The
  scoped plan-input fetch moves inside the failure envelope (§14.13):
  `apply()` resolves `{…, errors: [message]}` with the baseline
  retained. This is a Core behavior fix aligned with the documented
  contract (F5); it repairs both hosts at once (F10).
- **C7 — (renumbered) delivery recovery is host-side and bounded.** Both
  flushes (extension `util/devsync.ts`; CLI `commands/watch.ts`) gain a
  rejection guard with session-identity checks, a bounded failed-batch
  queue with a single retry driver and per-entry budgets (third
  revision — the second revision's single retry slot collided under
  overlapping rejected flushes, P0-B), and a terminal state with an
  explicit recovery procedure. Full specification in §14.11 —
  the first revision's "requeue at the head of `pending`" is
  **replaced** (it re-delivered only on the next watcher event and had
  no terminal semantics).
- **C8 — R0/R1 untouched.** The getter reads session state only; no
  ambient, no legacy slots, no engine lock. Concurrent `studio.run`
  invocations are unaffected (the getter is not a lifecycle call).
- **C9 — instance/session isolation.** Each session's getter observes
  only its own field; two sessions on two projects never cross. The
  controller reads the getter through its captured session reference;
  identity guards (§14.11) keep a stopped session's getter out of the
  next session's decisions.
- **C10 — result-level re-baseline failures are observable degradation,
  not handled delivery (new in the third revision).** When an apply
  whose batch contains a `full-rebuild` or `mod-scoped` delta resolves
  with a non-empty `errors` array (the F4 shapes: a failed full rebuild
  or scoped rebuild — including truncation of the batch's remainder,
  F7/F20), the controller sets a sticky **`resyncRequired`** state —
  the same terminal-state flag C7 uses — and logs one error naming the
  failure and the recovery. The batch is **not** retried (deterministic
  build failures must not loop); subsequent deliveries continue
  flowing. The flag clears only per §14.13's clearing rule — a
  successful `start()`, or an apply reporting `fullRebuild === true`
  with no errors (a successful scoped re-baseline that did **not** move
  the root never clears it — under C11 a root-moving scoped batch *is*
  a full rebuild, so a success that clears the flag is always a rebuild
  that provably re-read the whole tree).
  Rationale: theorem T′ + F13 + F20/F21 prove a failed re-baseline can
  leave source work unincorporated and its future events
  territory-dropped, so "errors logged" is not "delivery complete";
  the degraded state makes the gap observable and recoverable without
  introducing a retry loop. Full specification in §14.13.
- **C11 — a root-moving scoped batch is promoted to a full rebuild
  (new in the fourth revision; the P0-D repair).** In `applyCoalesced`'s
  scoped block, after the fresh plan input is fetched (519) and
  **before** the assignment (520), the fresh input's resolved
  `config.outdir` is compared with the committed baseline's
  (`this.planInput.config.outdir`), both normalized with the engine's
  own `normalizePath` convention (backslashes fold to `/`, trailing
  separators drop; case-sensitive, like every engine comparison — a
  case-only spelling change of the same directory is harmless in both
  directions: a false-positive promotion costs one correct rebuild, a
  false-negative leaves the same physical directory complete). When the
  normalized roots differ, the scoped block **delegates the batch to the
  full-rebuild path**: assign the fresh input (520 — the getter flips
  before any write, preserving theorem T′ and F22's ordering), run
  `buildVariants(this.variants)` inside the `doFullRebuild` failure
  envelope, and report `fullRebuild: true` on success with `scoped`
  empty (nothing was scoped-rebuilt). The stable-root scoped path is
  byte-identical to today's (F21 stands; RG-7's outcome is unchanged).
  Failure semantics are the existing F4 shapes, verified against the
  real engine: a build-phase failure leaves the new baseline committed
  with `fullRebuild: false` and non-empty `errors` — exactly the
  condition C10 flags — and the plan-input phase cannot fail here (the
  input is already fetched; C6 owns the fetch's rejection). Result
  compatibility: `fullRebuild === true` keeps its truthful meaning ("a
  full rebuild ran"); no consumer distinguishes the cause
  (`summarizeApplyResult` prints "full rebuild"; the C10 clearing rule
  consumes the shape correctly, because a promoted success *provably*
  re-read the whole live tree). Exhaustiveness: F22 proves the scoped
  block is the only re-baseline site that can move the root without a
  full rebuild, so this single site closes the class. Loop safety: the
  promoted rebuild writes only into the newly committed root —
  territory-dropped from the first write (C2) — and generates no source
  deltas, so exactly one full rebuild runs per root-moving batch and no
  follow-up chain exists (S4; the "do not automatically trigger
  unbounded follow-up rebuilds" constraint holds by construction).
  Cost honesty: a root change arriving on a scoped trigger now pays a
  full rebuild instead of committing a broken root — the work the next
  structural change would have paid anyway, paid at the moment the
  incompleteness would otherwise arise. The abandoned root's partial
  output (and any pre-assignment incremental writes into it) is bounded
  garbage on disk the engine never deletes — pre-existing semantics for
  every root move (F7 deletes variant folders, never the outdir).
  **Alternatives evaluated and rejected (the gate's B2/B3):** an
  **explicit root-change result/degraded contract** (the engine reports
  "committed a different outdir without a full rebuild"; the host marks
  `resyncRequired`) — rejected because it leaves the incomplete root
  committed and *in use* until the user reacts (a degraded window of
  unbounded duration whose incremental deliveries only partially
  populate the new root), adds a result field every host must honor
  (a consumer that ignores it silently keeps the gap — the exact
  false-negative class being closed), and spends surface to report a
  state C11 simply prevents; and a **host-side baseline comparison**
  around applies (read the getter before and after each flush's apply)
  — rejected on a deterministic counterexample: with overlapping
  flushes (no in-flight guard; the queue serializes applies, F6), both
  flushes pre-read A before either apply commits; apply 1 (settings →
  B) commits B, apply 2 (settings → A) commits A; both post-reads
  return A — the A→B→A round trip is invisible to every bracketing
  read, and its damage is real: files saved during the B excursion were
  written into B (the then-committed root), so the restored A root is
  stale for them with no event left to deliver. Even a *detected*
  transition cannot be attributed to the right flush. B3 also
  reintroduces the correction-read class C5 deleted (the S1-vs-S3
  divergence shape Q4 exists to close). C11 avoids the entire class by
  making every root-moving re-baseline complete at commit time, at the
  engine boundary — where F22 proves the one site to fix is.
- **C12 — execution-time delete reconciliation (new in the fourth
  revision; the P0-E repair).** The engine's incremental writer is
  driven by the *original* delta type: a `delete` removes the output
  copy without consulting the source (`buildsession.ts:642–645`), while
  a non-delete copies the **live** source at apply time (647). A delta
  whose type is stale relative to the current source state — a retried
  batch's (§14.11), or any event delivered out of source-order across
  batches (F19's unbounded delay makes the fresh pipeline vulnerable
  too) — therefore cannot be applied safely by type alone: a stale
  `delete` executed after a newer `create` deletes output the source
  still has, a divergence no later event heals (proven against the real
  engine). The repair is **at the operation, not the queue**: when an
  incremental `delete` delta names a source path that currently exists,
  the engine treats it as a change of that path (the same live-source
  copy a fresh change event performs, including the existing
  `isSourcePathIncluded` check); when the source is absent, the delete
  executes as today. The decision is made in the same continuation as
  the write (the queue serializes applies, F6), so no host-side timing
  can reopen it. With C12 every incremental delta converges the output
  toward the **current** source state for its path regardless of when
  the delta was generated: stale non-delete deltas already converge
  (live content re-read; a vanished source is skipped as ignored,
  592–608), and stale deletes now converge too. Deterministic
  determination of the three sequences the gate demanded: create→delete
  (stale create, source absent) → skipped, output stays without the
  file — converged silently; delete→create (stale delete, source
  present) → reconciled to a copy — converged; repeated change →
  live-content copy — converged. Delivery order between batches stops
  affecting the final tree. Loop safety: the reconciled copy writes
  into the committed root, whose events are dropped (C2) — no chain
  (S2). Mechanics note: the shipped pin "apply() creates and deletes
  files in the output" deletes a delta whose source still exists — a
  synthetic sequence no watcher produces; under C12 it must model the
  source deletion (remove the source first) and its outcome is
  unchanged for every realistic sequence (watcher deletes trail disk
  writes, so a fresh delete's source is always already gone — F19's
  premise).

### 14.8 What the filter drops, and why that is not a loss (the territory contract)

**DECISION (normative).** Under C2, the *only* events the controller
discards are events under the **committed** output root at schedule
time. This section states why that discard is a contract, not a silent
loss, and bounds every residual behavior around it.

1. **The engine's writes are exactly covered at decision time.** Every
   write/delete the engine performs is under `resolveBuildOutputPath(this.planInput.config,
   variant)` for the plan input current at operation time (F3), and
   theorem T′ guarantees the getter names that root at every decision
   made while the engine is actively writing it. Engine output can
   never *sustain* a self-feeding loop (§14.8.4's cycle proof): **S2
   holds by construction**, including the §3.1-case-6 layouts the
   filter exists for. (Engine events from a root abandoned before
   their delivery are forwarded — bounded, §14.8.4.)
2. **The committed outdir is engine territory by existing semantics.**
   The engine deletes and rewrites the variant folders on every
   structural change (F7, `buildplan.ts:341–342`); its own output
   contains `mod.info` files that classify as `mod-scoped`
   (`buildsession.ts:183–191`); and the stashed A1 control pins
   outdir-granular post-commit filtering as correct behavior (F18). A
   file placed under the committed output root is in the engine's
   output directory — the same standing any build tool's output
   directory has. **RESIDUAL (named, not a silent loss, in intent):** a
   user file created under the committed outdir is not source-delivered
   while that root is committed — and neither is a *mutation event*
   decided there, whatever the mutation's history (§14.8.6). In a
   §3.1-case-6 layout the file lies inside a mod folder, so the *next*
   full build or scoped rebuild of that mod re-reads it from disk and
   incorporates it (F14) — the same healing-by-rebuild the Q3 contract
   relies on for same-burst edits. When the root moves away, the getter
   moves with it and the subtree reverts to ordinary source semantics
   (the §3.2 temporal loss is structurally closed — no cached root
   exists to be stale).
3. **What cannot be distinguished, and why it does not matter.** From a
   `(type, path)` watcher event and the committed-root getter alone, a
   user edit under the committed root is indistinguishable from an
   engine write — no timing, provenance or content signal exists in the
   event stream (this is the precise answer to the brief's P1
   ambiguity question). The third revision makes this fact load-bearing
   in the temporal dimension as well: because delivery is unordered
   relative to assignments (F19), the same indistinguishability holds
   for *when* the mutation happened — T3 is unprovable (§14.2). The
   territory contract resolves the ambiguity by ownership rather than
   by provenance: under the committed root, both origins are
   out-of-scope for delivery; outside it, both are delivered and the
   engine — the component that owns classification — decides what they
   mean. Forwarding outside-root events is safe because the engine
   writes only into the committed root (terminating; bounded
   one-generation garbage, below).
4. **Bounded garbage, no self-sustaining cycle.** An event under a root
   the engine has left (stale title folder, a root abandoned mid-apply,
   the incremental phase of a C11-promoted batch — written against the
   pre-assignment baseline before the root move was detected — or an
   outdir-subtree path in a case-6 layout) is forwarded, classified
   against the current baseline, and written into the *current* root's
   variant folders (F3) — where subsequent events for it are dropped
   (C2). Each root move can thus cause at most one spurious sync per
   in-flight or delayed event; no chain of forwards closes a cycle
   *through engine writes*, because a forwarded event's write lands
   under the committed root, whose own events are dropped. Stated
   precisely (the third revision's narrowing): the cycle proof is
   about **self-sustaining loops** — a loop would require an
   engine write to generate an event that is itself forwarded into
   another engine write without bound, and each forwarded write's
   output events terminate in committed territory. Delayed or
   re-delivered events of *one* generation may each cause one
   forwarding (bounded by the event's own re-delivery, not by engine
   output); **S2's "unbounded feedback loop" is impossible** in that
   sense, and "every engine-generated event is filtered" is
   deliberately *not* claimed (§14.4.9, reverse ordering).
5. **The pre-assignment scoped window, restated.** An event under the
   *future* root arriving between the schedule-time decision and the
   scoped assignment (520) is forwarded and applied against the old
   baseline — in a case-6 layout it is synced into the old root's
   variant folders (bounded garbage) and, if its disk mutation landed
   before the scoped `copyTree` read the tree, incorporated into the
   new root by that rebuild (F14). **RESIDUAL (named):** a late edit
   (landing after its mod's copy executed) is delivered but lands in
   the old root, and the file — now under the committed new root — is
   thereafter territory. This is the first revision's §14.7-B residual,
   surviving in a strictly weaker form: the event is *delivered*
   (nothing is silently dropped); what remains is placement plus the
   heal-iff-timing property, governed by the same territory contract.
6. **Delayed delivery and retroactive ownership (third revision — the
   P0-A contract statement).** Because delivery is unordered relative
   to assignments (F19), ownership is evaluated **at decision time**:
   a mutation performed while a root was uncommitted source territory
   can be dropped if its event is decided after that root — or a root
   containing it — is committed (§14.4.9). The contract states this
   openly instead of claiming provenance sensitivity it cannot have.
   The observable consequences are bounded by two mechanisms:
   - **Incorporating commits** (a successful full rebuild whose
     `copyTree` traversed the file's subtree before any failure —
     F14/F13) make the drop lossless: the mutation is in the output,
     and the drop only prevents a redundant re-delivery. The residual
     when a commit incorporates *most* but not *all* pending mutations
     is named in §14.17 (the incorporate/miss boundary is per-subtree —
     F13 — not per-file).
   - **Non-incorporating commits** (a failed re-baseline — F4/F13/F20 —
     would strand the mutation silently; C10 makes them observable
     (`resyncRequired`) and recoverable (restart/`pzstudio build`
     re-reads the live tree — every stranded mutation predates the
     commit, so a post-commit resync provably heals them all). *(Fourth
     revision: the third revision's other stranded-commit class — "a
     scoped commit that excludes the file's mod, F21" — is now
     impossible as stated: a root-moving scoped batch is promoted to a
     full rebuild by C11 before it can commit an incomplete root, and a
     **stable-root** scoped commit excludes only mods whose output
     already exists in that same committed root, so nothing goes
     missing. What survives of the class is the failed-re-baseline
     family and the outcome-5 residual below.)* The repair is
     *available* up to the next successful full rebuild, not per-event —
     but that rebuild is **user-action-dependent and not guaranteed to
     occur** (§14.17); strictly weaker than per-event delivery, and
     stated as such.
   This item is what replaces the second revision's unconditional "the
   event is never mis-dropped" claim: decisions are exact, mutation
   outcomes are contract + healing.
7. **Territory granularity is a product decision, not a proof
   (third revision — decision item).** That the **whole committed
   outdir** (not just the engine's per-variant write folders) is
   territory — including user edits under outdir paths that are not
   engine-written files, pre-commit mutations captured by a
   post-commit decision, and case-6 layouts where the outdir doubles
   as mod source — is a **policy choice**, adopted for three reasons
   and requiring explicit owner confirmation with the Q4 approval:
   (a) continuity — the shipped CLI watch filters the same whole
   subtree for a stable root (`watch.ts:142–148`), and the Q3-accepted
   policy did the same, so Q4 does not change the drop *set* for
   stable roots; (b) the stashed A1 control pins outdir-granular
   filtering as the regression expectation (F18); (c) per-variant
   narrowing cannot recover provenance anyway (T3) — it would only
   shrink the drop set while keeping the retroactive-capture semantic
   at variant-folder granularity. Consequences an owner accepts with
   it: a *narrower* drop set (per-variant write roots) would reclassify
   non-variant outdir paths as source and is rejected on (b) + surface
   grounds (§14.6); a *root-migration source↔output flip* is handled
   by the same getter (former output reverts to source the moment the
   committed root moves — no stale cache exists; new territory is
   captured the moment the commit lands); and the S1 invariant must be
   read with §14.17's exact relaxation — the decision-time repair
   bound is user-action-dependent, not a guarantee (fourth revision:
   the residual persists indefinitely absent user action). If the
   owner instead requires per-event mutation provenance — the strict
   "every mutation is delivered or incorporated" contract — that is a
   **missing contract capability**: neither engine-side write
   provenance nor a delivery-ordering guarantee exists in the public
   API, and the fourth revision's assessment (§14.17) records what the
   provenance alternative would cost before it could be selected. The
   correct disposition for that requirement is
   BLOCKED-for-that-requirement pending an architectural decision, not
   a silent narrowing.

### 14.9 P1 — COMMITTED-discard reassessed (CN-1)

**The finding, confirmed from source.** The first revision's C4 resolved
an open transition by comparing the predicted root to the committed root
and, on COMMITTED, **discarding the buffered events** — justified by
F7's claim that "any same-burst source edit was incorporated by the
rebuild's disk re-read". That justification is conditional, and the
conditions fail in both of the brief's cases:

- **Case A — the build fails before `copyTree` reaches the relevant
  subtree.** The plan input committed the predicted root B (545), but
  `executeFileOperations` aborts on the first failing operation (F13) —
  every mod whose `copyTree` follows the failure is never written, and
  `buildVariants` moves on to the next variant. A source edit under B
  that arrived during the window, for a mod whose copy never ran, is on
  disk and **not** in the output; the COMMITTED resolution discards its
  buffered event; F7's healing never happens for it. **FACT: the
  discard loses the edit.**
- **Case B — the build succeeds, but the edit arrives after the final
  traversal that could have incorporated it.** Same buffer, same
  discard; the edit is on disk under B, absent from the output, its
  event gone. **FACT: the discard loses the edit.**
- **The loss shape is exactly the case-6 family.** An event under the
  committed root classifies as a source delta (`mod-file`) iff the
  root's first project-relative segment is a configured, non-excluded
  mod (`buildsession.ts:167–222` — `classifyDelta` has no outdir rule),
  i.e. iff the output root lies inside a mod folder — §3.1 case 6, a
  valid, intended configuration that this contract may not reject. In
  every other layout the discarded events are ones `classifyDelta`
  would ignore anyway. The first revision's "closed with zero loss"
  claim for scenario A (its §14.7-A) held only for the *FAILED*
  resolution; its COMMITTED branch carried this loss.
- **The ambiguity facts.** Under the committed root, a user edit, an
  engine write, and a coalesced notification of both are
  indistinguishable from `(type, path)` events plus the root getter
  (§14.8.3). No narrowing of the *discard rule* can separate them:
  replaying the buffer re-feeds the engine its own output (the
  self-feed direction the first revision itself rejected in its
  §14.7-B); keeping the discard loses case A/B edits. **The first
  revision's proposed API cannot satisfy S1 and S2 simultaneously for
  case-6 layouts — the review's P1 was correct, and stronger than it
  knew.**

**Disposition: delete the buffer-and-discard mechanism.** The theorem
(§14.3) shows the buffer's coverage target is empty: there are no
pre-assignment engine writes to the predicted root, so nothing needs
holding. Under the revised contract the case-A and case-B events are
**forwarded, not buffered** — they reach `session.apply`, the engine
classifies them against the committed baseline, and syncs them into the
root the engine actually writes (terminating; §14.8.4). The stashed A1
test's required outcome — "the under-B event reaches `session.apply`
and the engine writes it into A" — holds *by construction*, without a
transition, a replay, or a resolution step. S1 and S2 both hold for
every supported configuration with the outdir-level getter alone:
**no missing capability, not BLOCKED** — the missing capability the
review anticipated (output-write provenance) is rendered unnecessary
for the decision-layer guarantee by theorem T′ (provenance recovery is
in fact impossible on `(type, path)` events — F19; the territory
contract §14.8.6/§14.8.7 owns what provenance would have decided), and
the alternative narrowing (a write-roots getter) is
rejected on the F18 gate (§14.6).

**Alternatives compared (all against source):**

| Alternative | Verdict | Reason |
| :--- | :--- | :--- |
| Replay the whole buffer at COMMITTED | Rejected | Re-feeds engine output writes into the engine in case-6 layouts — the exact self-feed direction §14.7-B (first revision) rejected; bounded garbage per event, but it re-opens by policy what C2 exists to prevent. |
| Widen the getter to the per-variant write roots; drop only those subtrees | Rejected | Breaks the stashed A1 control's outdir-granular post-commit pin (F18); reclassifies part of the committed territory as source; wider surface for no theorem benefit (§14.6). |
| Trigger `session.rebuild()` at COMMITTED when the buffer is non-empty | Rejected | Heavy (a second full rebuild per structural change), F4-asymmetric on failure, and unnecessary once events are forwarded instead of buffered; the same primitive is retained for explicit recovery (§14.10.4). |
| Engine-side write provenance (report written paths per apply) | Rejected for Q4 | A new result-contract surface on the frozen engine; theorem T′ makes per-write attribution unnecessary for the decision rule — the *boundary* of engine writes at decision time is already implied by the committed root (provenance recovery across delivery delay is impossible anyway, F19). |
| Configuration constraint (reject case-6 layouts for DevSync) | Rejected | §3.1 case 6 declares the layout valid and intended; the doctor flags it, and §12.5 assigns layout remediation to configuration guidance, not watcher mechanics. The brief forbids rejecting existing layouts without justification. |
| **Forward under-uncommitted-root events; drop only under the committed root (C2, live)** | **Selected** | The engine is the classifier; the decision is safe by theorem T′; the discard set is exactly the engine's decision-time territory (§14.8); the stashed A1/B1/C1 outcomes hold by construction. |

### 14.10 P2 — the degraded buffer and overflow recovery

The review's MC-1 proposed a coalesced transition buffer with a
256-distinct-path cap; MC-2 proposed `session.rebuild()` as the
recovery when the cap overflows. Both are evaluated and rejected; the
evaluation is retained as the record, because the same `rebuild()`
properties govern the recovery paths that *do* remain (§14.11).

1. **Coalescing semantics (FACT, F17).** The engine's own
   `coalesceDeltas` defines the canonical semantics: per normalized
   path, final state wins (`create→change` = create; any→delete =
   delete; delete→create = create; repeated change = change;
   first-occurrence order preserved). A buffer coalescing "the same
   way" is therefore expressible — the semantics were never the
   problem.
2. **The cap premise is false (FACT + arithmetic).** The first revision
   justified the 256 cap with "the window is one apply's duration;
   overflow signals a pathological burst". But the window's events
   under the predicted root are *dominated by the rebuild's own output
   writes* whenever the predicted root lies inside the watched project:
   a full rebuild emits one watcher event per written file (template
   tree + every mod's tree + workshop.txt + preview, plus a
   create/delete pair per `makeDir` sentinel — F16), coalescing to one
   buffer entry per distinct path. Any real project's rebuild exceeds
   256 distinct paths. **Overflow is the common case for in-project
   outdirs, not a pathological burst** — the cap would fire on routine
   structural changes.
3. **MC-2's rebuild-on-overflow is S2-fatal (counterexample).** Trigger
   `rebuild()` on overflow and the loop closes: the rebuild writes the
   output tree under the (still-open) transition's predicted root →
   the watcher emits the tree's events → they overflow the buffer
   again → `rebuild()` again. Nothing in the proposal terminates it:
   the recovery mechanism *is* the flood source. This is precisely the
   unbounded feedback S2 forbids — reintroduced by the recovery path
   of the mechanism built to prevent it. **The proposed recovery is
   rejected on a concrete counterexample.**
4. **`rebuild()` itself: the recovery properties, source-grounded
   (FACT).** For every recovery design that uses it (now or later):
   - *Freshness:* `rebuild()` fetches a **fresh** plan input (379) —
     config, template, and per-mod source snapshots are all re-read
     (F15). Nothing about mod metadata or source discovery can remain
     stale. It does **not** reuse the existing plan input.
   - *Root selection:* it writes `resolveBuildOutputPath(freshInput.config,
     variant)` for the session's start-time variants — the **current**
     configuration's root, which is the transition's predicted root iff
     the config still says so.
   - *Incorporation:* it runs `planBuild` per variant — variant folders
     deleted and recreated (F7), `copyTree` reading the live tree at
     execution time (F14). Because `executeFileOperations` throws on
     the first failing operation (F13), **`rebuild()` resolving implies
     every planned operation succeeded implies all on-disk source state
     at rebuild time is incorporated** — that is the recovery proof,
     and it is verifiable only by asserting the written tree, never by
     "the rebuild resolved".
   - *Failure:* either phase rejects the `rebuild()` promise with the
     F4 asymmetry (plan-input failure → baseline retained; build-phase
     failure → baseline committed, output partial). A rejecting
     recovery is not a recovered session — the caller must treat it as
     a failure state, not as progress.
   - *Case-6 feedback:* a rebuild in a case-6 layout performs the
     bounded one-generation self-embedding every case-6 full build
     performs (F14: the outdir subtree is read as mod source; variant
     folders are deleted first, so nothing accumulates). It does **not**
     reintroduce an unbounded loop — the subsequent writes land under
     the current root and are dropped (§14.8.4).
5. **Disposition.** The transition buffer is deleted (C4) — there is no
   cap, no overflow, and no degraded-buffer state to recover, because
   there is nothing to recover: the events the buffer would have held
   are forwarded (§14.9). The recovery machinery that remains is C7's
   bounded delivery retry and its terminal state (§14.11), whose
   deterministic recovery — session restart or `pzstudio build` — is a
   **superset** of any `rebuild()` healing: `start()` performs the same
   fresh-input, live-tree full build (365–366, F14/F15) and is the
   operation the hosts already own. An explicit `session.rebuild()`
   remains available as a future in-place recovery affordance (a
   command surface, not a watcher-policy one): at most one attempt per
   invocation, no automatic re-arming — S4-bounded.

### 14.11 P3 — bounded delivery retry and terminal behavior (C7, full specification; reworked in the third revision)

Post-C6 (normalization), `apply()` rejects only on unexpected engine or
host failure — every expected per-action failure is reported in
`result.errors`. The rejection guard exists so a spliced batch can never
be silently abandoned (F10) *whatever* throws. The second revision
specified this as a single retry slot; the third revision replaces the
slot with a bounded FIFO failed-batch queue (P0-B, rules 2/8). **DECISION
(normative, both hosts):**

1. **Session identity guard before every requeue or asynchronous state
   mutation.** `flush()` captures `session` and `projectDir` at entry
   (the existing shape, `util/devsync.ts:200–201`). The rejection
   handler — and every continuation that touches failed-batch state —
   proceeds only if `this.session === session && this.projectDir === projectDir`;
   otherwise the batch belongs to a stopped session and is dropped with
   a warn (its changes are on disk; the documented stop semantics
   discard it — §14.4.10). The same guard wraps the retry driver's
   fire.
2. **Failed batches enter a bounded FIFO queue, never `pending`, and
   never overwrite one another (third revision — replaces the single
   retry slot).** The second revision specified one `retryBatch` slot;
   P0-B showed two overlapping rejected flushes from the same live
   session overwrite it (the second rejection wins, the first batch is
   silently lost — the identity guard checks *session* identity, which
   is equal for both, not *batch* ownership). The contract is therefore
   a **failed-batch queue** (`failedBatches: Array<{ deltas, attempt }>`,
   append-only on rejection), with these bounds and semantics:
   - **Capacity bound (S4, dual — fourth revision): 16 entries AND 256
     total retained deltas.** The third revision's 16-entry cap bounds
     entries, not memory — each entry is an arbitrary `FileDelta[]`, so
     16 unbounded batches is no hard limit (P0-E). Both bounds are
     enforced at enqueue: if admitting a batch would exceed either, the
     oldest *terminal* (exhausted) entry is retired to the
     `resyncRequired` bookkeeping (its paths are already logged and
     covered by the recovery re-read — §14.11.6) to make room; if no
     entry is terminal, the *newly rejected* batch takes the terminal
     path immediately (logged + `resyncRequired`, not queued) instead
     of displacing a pending retry. 16 exceeds any realistic overlap:
     flush overlap is bounded by the debounce cadence (300 ms) against
     serialized applies, so more than a handful of *concurrently
     rejected* batches already implies a persistently failing engine —
     which is the terminal state's job, not the queue's; 256 deltas is
     the hard memory ceiling (a batch too large to retain safely is
     exactly the case where the recovery re-read is the right answer,
     and its paths are logged before the flag is set).
   - **At-least-once delivery:** every queued entry is delivered by a
     `session.apply` call until it either resolves (success — entry
     removed) or exhausts its budget (terminal — logged, flagged,
     removed). No path removes an entry without one of the two
     outcomes. Failure of a delivery *attempt* leaves the entry in
     place with its attempt counter incremented.
   - **Ordering:** FIFO by rejection time — which does **not**
     preserve source-mutation order against interleaved fresh `pending`
     flushes, and the third revision's claim that the engine's
     final-state semantics (F17) make that safe was **disproven** (the
     fourth revision's P0-E counterexample: a stale `delete` retried
     after a newer `create` deletes output the source still has; F17
     coalesces final states *within one batch* and has no cross-batch
     view). Safety comes from C12's execution-time reconciliation
     (rule 10), not from ordering or from F17.
   - **Memory:** each entry is the spliced `FileDelta[]` it failed
     with — the same data the pre-C7 design dropped; the queue holds at
     most 16 entries and at most 256 deltas in total (the dual
     overflow rule above), so retention is bounded regardless of batch
     size. No growth loop exists: rejections are host-event-driven (a
     burst ends) and the terminal path retires entries permanently.
3. **Retry scheduling is independent of watcher events, and driven by
   exactly one timer.** A single retry driver timer re-delivers the
   queue's head entry on its own backoff — never a timer per entry
   (which would re-introduce racing drivers) and never a reliance on
   `pending`'s debounce (which only arms on a *new* `schedule()` call:
   with no further events a failed batch would sit forever). When the
   head entry resolves successfully the driver advances to the next
   entry; when it rejects, the entry's attempt count increments and the
   driver re-arms.
4. **Finite budget with deterministic backoff, per entry.** Each queued
   batch gets at most **3 retries** after its initial delivery (4
   attempts total); the retry delay is `WATCH_DEBOUNCE_MS × 2^attempt`
   (300/600/1200 ms) — deterministic for tests, long enough to clear
   transient host/fs contention (emfile-class errors), short enough
   that a deterministic failure exhausts in ~2 s and surfaces instead
   of spinning. The attempt counter lives on the queued entry.
5. **Separation and terminal handling of deterministic repeated
   failures.** Queued entries are delivered as their own `session.apply`
   calls; `pending` continues to drain independently (the engine's queue
   serializes the two — F6). A slow-failing batch never withholds fresh
   user edits, and a fresh burst never inflates a failed one. After an
   entry's third failed retry it is retired terminally: removed from
   the queue (no further automatic attempts — **S4**), the controller
   enters a `resyncRequired` state, and one **error-level** log names
   the delta count and each undelivered path plus the recovery
   procedure (below). `resyncRequired` is sticky: it clears on the
   next `start()` (or the host's equivalent of a session rebuild) — or
   on the next apply reporting `fullRebuild === true` with no errors,
   per §14.13 (a successful scoped re-baseline that did not move the
   root does not clear it — under C11 a root-moving one *is* a full
   rebuild, so the clearing shape always names a proven resync). If
   the underlying failure persists, each subsequent rejected batch
   terminates the same way — one error log per exhausted batch, bounded
   by flush frequency.
6. **Recovery after the underlying failure is corrected.** The
   deterministic procedure is **toggle DevSync off and on (or run
   `pzstudio build`)**: the new session's `start()` full-builds from the
   live tree (365–366, F14/F15) — a superset of every exhausted entry's
   changes and of any re-baseline-truncated remainder (C10), since
   every delta in a rejected batch and every mutation predating the
   failed commit was a filesystem mutation already on disk (watcher
   events trail disk writes). This is why terminal parking is not
   irreversible loss: the information preserved is the batch's presence
   (flag + logged paths), and the recovery provably resynchronizes from
   disk. **A terminal log alone would not satisfy S1/S6; the log
   *plus* the sticky state plus the provable resynchronization does.**
   **Exact clearing condition (third revision):** a *failed restart*
   (the new session's `start()` rejects — its baseline is already
   committed at 365 even when `buildVariants` fails, §14.4.1) leaves
   the recovery requirement observable: the controller's catch path
   keeps the degraded/`resyncRequired` state surfaced (the toggle UX's
   error notice), and the recovery must be attempted again. A manual
   `pzstudio build` **corrects the output on disk but does not clear
   the extension session's flag** — the flag belongs to the controller
   process; it clears only when the live session next proves recovery
   (a successful `start()`, or an apply reporting `fullRebuild === true`
   with no errors, per §14.13). Recovery *attempted* is not recovery
   *proven*.
7. **No duplicated retries across layers.** Hosts retry only
   *rejections*. Per-action failures inside a resolved
   `SessionApplyResult` are logged once and never requeued — with the
   single third-revision exception of C10 (a re-baseline-class batch's
   errors set the degraded state instead of being treated as handled;
   the state is *not* a retry — see §14.13). The engine's own semantics
   own per-file errors (the lock-error message documents
   next-save/full-rebuild healing, `buildsession.ts:329–335`). C6's
   normalization is what makes this separation real: without it, the
   scoped-path rejection would bypass every result-driven rule (F5).
8. **Overlapping flush promises (third revision — the P0-B fix).**
   Flushes may overlap (no in-flight guard — the queue serializes
   applies, §14.4.8). The second revision's claim that a single retry
   slot makes this safe was **false**: two overlapping rejected
   flushes both pass the (session-level) identity guard and the second
   `retryBatch = …` assignment silently overwrites the first batch —
   one of two user batches lost with no signal. Under the queue design
   each rejection **appends** its own entry (`failedBatches.push(…)`),
   so concurrent rejections accumulate instead of colliding; the single
   retry driver serializes their re-delivery; entries are removed only
   by their own success or terminal retirement. A retry driver fire
   during another flush simply enqueues one more apply behind it (F6).
   The interleavings the review demanded, resolved: retry fire during
   another flush → two queued applies, ordered; two rejections settling
   consecutively → two entries; retry succeeds while another failure is
   being parked → success removes its own entry only, the parked entry
   is untouched; stop with a retry armed and a flush pending → the
   identity guard retires all failed-batch state with the session
   (§14.4.10); new watcher events during repeated failure → they flow
   through `pending` independently (separation, rule 5); one poison
   batch → exhausts its own budget and terminates alone; several
   independent failures → each terminates on its own budget, one log
   each. No owner ambiguity remains: the *queue* owns every failed
   batch; the *driver* owns delivery order; the *entry* owns its own
   attempt count.
9. **CLI parity.** `commands/watch.ts`'s flush gains the same guard:
   identity check (trivially true — one session per command), the same
   failed-batch queue + single driver + per-entry budget, terminal
   error naming the paths and the recovery (`rerun pzstudio watch`, or
   `pzstudio build`). No other CLI behavior changes (Q3 §12.4's frozen
   root stands).
10. **Retry ordering is safe by execution-time reconciliation, not by
    ordering (fourth revision — the P0-E proof).** The gate demanded a
    determination of whether re-delivering older deltas after newer
    batches can change the final filesystem output, distinguished along
    four axes; each is settled against source and the real engine:
    - *`coalesceDeltas` within a batch* (F17): final-state-wins per
      normalized path, first-occurrence order preserved. It governs one
      batch only and has **no cross-batch view** — it cannot make
      cross-batch re-delivery safe, and the third revision's reliance
      on it was the error.
    - *Ordering between batches*: FIFO by rejection time ≠ source
      order. A batch rejected first and retried after a newer
      successful batch executes out of source-order — reachable by the
      design's own terms (flush overlap × the serialized apply queue,
      F6). **Order matters, proven**: the counterexample is a stale
      `delete` retried after a newer `create` — the output file is
      deleted while the source still has it, and no later event heals
      the divergence (the user has not touched the file since; no
      rebuild is scheduled).
    - *Engine reads of current filesystem state*: the incremental
      writer re-reads the **live source** for every non-delete delta at
      apply time (592–608, 647) — content staleness is impossible for
      create/change; a vanished source is skipped as ignored, not
      errored. A retried create/change therefore always converges
      (repeated-change and create-after-delete sequences: converged,
      verified against the real engine — the second silently, without
      error noise).
    - *Engine operations driven by the original delta type*: the
      **only** unsafe operation is the `delete` — it removes the output
      copy without consulting the source (642–645), so a stale delete
      destroys output the source still has. This is exactly the gap
      **C12** closes at the operation: the delete is reconciled against
      the current source in the same continuation that writes (the
      queue serializes applies, F6), making every retried delta a
      convergence statement about the *current* source state rather
      than a replay of a past event.
    With C12, the final filesystem tree is independent of delivery
    order across batches: any interleaving of retried and fresh batches
    leaves each path at its current source state (modulo the
    outcome-5-class mutation-after-last-read race, §14.17, which no
    build tool can exclude and whose own fresh event heals it outside
    committed territory). Alternatives evaluated and rejected:
    **serializing fresh flushes behind retry deliveries** — withholds
    fresh user edits behind a poison batch, the exact shape the P0-B
    disposition already rejected; **host-side re-validation of delta
    types at retry time** (re-stat each path, re-derive the type) —
    shrinks but cannot close the staleness window (the stat and the
    apply are separated by awaits any macrotask can interleave with),
    duplicating machinery the engine already owns; **merging retry
    entries into fresh flushes** — merges batch identities (the P0-B
    ownership failure). C12 is the smallest mechanism that makes the
    property hold by construction.

**Assessment of the proposed three-attempt limit:** appropriate —
post-C6 rejections are unexpected failures, so the budget's job is to
absorb transient faults and then *stop*, surfacing a deterministic
failure state instead of an unbounded loop. A larger budget would only
delay the terminal state; a smaller one would park recoverable batches.
The backoff, the separation, and the terminal semantics are what make
the number safe; any of 2–5 attempts would also be defensible — 3 is
selected and pinned by test (§14.15, RG-11/RG-12). **P0-B disposition
record:** the review was right that identity guards alone cannot solve
same-session collisions — the guards distinguish *sessions*, and the
colliding flushes share one. Of the candidate shapes, serialized
host-side delivery was rejected (it would withhold fresh edits behind a
poison batch and changes the shipped overlap behavior); a deliberately
coalesced recovery state was rejected (it merges distinct batches'
identities — the exact ownership failure P0-B names — and cannot
at-least-once deliver per batch); a one-shot explicit resync trigger was
rejected as the *primary* mechanism (it makes every transient rejection
user-visible) but is retained as the terminal state's recovery. The
bounded FIFO queue is the narrowest shape that gives per-batch
at-least-once delivery, no overwrite, bounded memory and a terminal
exit — with the missing contract made explicit: **failure-handling
state ownership is per batch, and the host owns the retry policy.**

### 14.12 P4 — transition lifecycle: the state machine dissolved

The brief models nine phases of a transition lifecycle and asks for
ownership, token identity, buffering, completion ordering, replay, and a
verdict on supersession and slot count. Under theorem T′ the machinery
those phases describe does not exist, and each phase's hazard is
discharged by a mechanism that cannot be stale. **The mapping (each row:
the first revision's hazard → the revised discharge):**

1. **T1 trigger scheduled but not yet flushed.** No transition exists;
   the triggering delta sits in `pending`. The only root state is the
   getter — events scheduled meanwhile are classified against it, live.
2. **T1 apply queued but not started.** Queue order (F6) owns
   sequencing. Events scheduled while the apply waits see the
   pre-apply getter — correct, because the engine is still writing the
   old root (or nothing).
3. **T1 apply running before baseline assignment.** The engine writes
   nothing under the future root in this phase (theorem T′ — the
   window the transition buffer claimed to cover is empty). Events
   under the future root are forwarded and applied against the
   committed baseline — delivered, terminating (§14.8.4). **This is
   the A1 scenario, resolved by delivery instead of buffer-and-replay;
   the stashed A1 assertion holds by construction.**
4. **T1 baseline assigned but apply still running.** The getter already
   names the new root; the rebuild's own writes are dropped from the
   first operation; under-old-root events are forwarded and synced
   into the new root (the A′ disposition, §14.4.4).
5. **T1 apply settled.** Nothing to resolve — no transition state
   exists; the getter is steady at the new root.
6. **T2 trigger arrives in each of the phases above.** Supersession is
   **not retained — there is nothing to supersede**. T2's delta queues;
   if it is a `project.json` event its apply performs another full
   rebuild — the engine's existing, pre-existing behavior for queued
   structural deltas (double rebuild is today's engine semantics, not a
   Q4 invention). Every event in every phase is classified live.
7. **T1 and T2 triggers coalesce into the same flush batch.** The
   engine's `coalesceDeltas` merges them (F17); one full rebuild runs;
   the batch remainder truncates (F7, position-independently — F20)
   and is healed by the rebuild's live-tree re-read **iff the rebuild
   succeeds** (F13); the failure shapes are C10's (§14.13).
   **DECISION:** the healing is normative and pinned by test (RG-13,
   success-scoped; RG-19 for the failure shapes), not an assumption.
8. **A stale apply completion arrives after "T2 opens".** No T2 state to
   poison. The flush continuation is identity-guarded (the captured
   session reference — **the token identity is the session itself**);
   its result can only log. A settled apply's side effects (writes)
   are bounded by its own plan and are territory-dropped or
   forward-absorbed per §14.8.
9. **Stop/restart during any phase.** `stop()` clears state, disposes
   the watcher, drains the queue (F6); the identity guard prevents any
   in-flight continuation from mutating the next session's state; C7's
   failed-batch queue is guarded identically (§14.11.1); the old
   session's getter is dead state, never read (§14.4.10).

**Transition ownership:** the controller instance, reduced to
`session` + `projectDir` + `pending` + `timer` + C7's failed-batch queue
and retry driver + the C10/`resyncRequired` flag — there is no
transition owner because there is no transition. **Token identity:** the
session reference (S5). **One transition slot?** Zero slots; the bounded
representation is the getter read (a scalar), the pre-existing `pending`
queue, and C7's bounded failed-batch queue. **Generation ID?** No
concrete counterexample survives theorem T′: a generation would
correlate events with baseline versions, but no *decision* crosses a
re-baseline to be correlated (the delayed-mutation meaning is owned by
the territory contract, §14.8.6, not by decision state). **The
FAILED-declaration prohibition (a transition may not fail merely because
its predicted root is not yet committed while its trigger is pending) is
satisfied vacuously** — no FAILED state exists, and the situation it
feared (a predicted root the engine has not adopted) is the *normal,
safe* forwarding case (§14.8.2).

### 14.13 Scoped apply failure contract (reporting vs recovery; reworked in the third revision)

**Finding (confirmed against source):**

- The mismatch is real: `apply()`'s contract comment promises "Never
  throws: per-action failures are collected in the result"
  (`buildsession.ts:384–387`); the scoped plan-input fetch (519) sits
  outside every try/catch, so its rejection rejects `apply()`.
- The loss is real on both hosts: the batch is spliced before the await
  (extension `util/devsync.ts:202`; CLI `watch.ts:82`), the rejection
  escapes the `void`-ed flush (`devsync.ts:195`; `watch.ts:101`), so the
  deltas are abandoned with no log and no requeue, and the rejection
  surfaces as an unhandled promise rejection.
- The engine's queue survives (F6) — subsequent applies still run; the
  damage is exactly one batch plus one unhandled rejection.

**Third-revision finding (P0-C — result-level errors are not completely
handled delivery).** Even after normalization, a resolved result with
errors can represent a real delivery gap. The sequence, each step
source-grounded:

```text
Batch: [project.json delta, my_mod/media/lua/feature.lua delta]
  (F20: position-independent — any order truncates the same way)
classifyDelta hits 'full-rebuild' → doFullRebuild (472)
Fresh plan input succeeds (545) — the baseline moves to B
buildVariants runs; the failure lands before the my_mod
  copyTree for the relevant variant (F13: first failing
  operation aborts that variant's remaining operations)
The edit is on disk in the project, absent from B's output
apply() resolves { fullRebuild: false, errors: [...] } (F4)
The host logs the error — and treats the batch as delivered
The truncated delta is never processed: no retry, no queue
  entry, no state
Every later event for feature.lua is decided against the
  committed root B — dropped as territory (§14.8.6) if the
  file lies under B (a case-6 layout), silently forever.
```

F7's healing guarantee ("the rebuild's live-tree re-read incorporates
truncated edits") therefore holds **only for a successful rebuild** —
F13 bounds it operation-wise, and the second revision's §14.11 rule 7
generic claim ("per-action failures … the engine's own semantics own
them") and §14.13 shape-3 disposition ("hosts log; no retry") both
overlooked the truncated-remainder case. Distinguishing the six
outcomes the brief demands (the sixth added by the fourth revision):

1. *Successful full rebuild* — everything incorporated (F14's live-tree
   read); truncation harmless; delivery complete.
2. *Failed plan-input resolution* — the baseline is retained (F4); the
   batch's remainder was never executed (the whole batch's work is
   unstarted); C10 flags.
3. *Failed build before the relevant copy* — the baseline moved; the
   on-disk edit is unincorporated; its future events are territory if
   under the new root; C10 flags. **This is the persistent-missed-update
   case, now observable.**
4. *Failure after the relevant copy* — the edit was incorporated before
   the failure; the miss is bounded to the ops after the failing one;
   C10 still flags (the flag is conservative — it may clear on the next
   successful re-baseline with nothing to repair).
5. *Mutation landing after the copy traversal had passed the file* —
   the rebuild could not have seen it; the delta's event is still in
   the pipeline as a later batch (it was truncated from *this* apply
   only if coalesced into it — F17 — in which case outcome 3/4 governs
   by timing); C10 flags the commit whose incorporation is uncertain.
   The **successful-commit** sub-case of this outcome — the mutation
   landing after the traversal of a build that then reports zero
   errors — is the one shape C10 cannot observe; it is the
   §14.17 residual, classified by the fourth revision as persisting
   indefinitely absent user action (P0-F).
6. *Successful root-moving scoped batch* (fourth revision — P0-D).**
   Pre-C11 this outcome committed the new root while re-syncing only
   the scoped mods (F21): every other mod's output and `workshop.txt`
   absent from the new root, `errors: []`, `fullRebuild: false` —
   the C10 condition (non-empty errors) never fires, and the new root
   is committed territory despite being incomplete. Confirmed against
   the real engine (two mods, A→B via a single `mod.info` delta: the
   second mod and `workshop.txt` absent from B, baseline proven to be
   B by the next incremental write). Under **C11** the scoped block
   detects the root change at 519/520 and delegates to the
   full-rebuild envelope: success takes outcome 1's properties
   (complete root, `fullRebuild: true`, flag clears — a proven resync);
   failure takes outcomes 3/4's (F4 shape, C10 flags). The incomplete
   shape is the RED condition of RG-22.

**Decision (the two concerns are separated; shapes distinguished):**

- **Error reporting — Core (C6).** Normalize the scoped fetch into the
  result envelope, mirroring `doFullRebuild` (543–551): catch at the
  `applyCoalesced` scoped block, push `describeError(e)` into
  `result.errors`, retain the baseline, return the result. The `scoped`
  list stays empty (nothing was rebuilt). The four rejection shapes:
  1. *Failure before baseline assignment* (519 rejects): normalized —
     `{errors: [msg], scoped: [], …}`, baseline retained (the
     assignment never ran).
  2. *Failure after baseline assignment* (a scoped `copyTree` fails):
     collected per-variant (526–534), `scoped` still reported (536),
     baseline = the new input (moved — the getter distinguishes this
     from shape 1, which the result shape alone cannot, F4).
  3. *Partial incremental success followed by scoped failure:* the
     incremental writes (499–514) are durable — the engine performs no
     rollback — and the result reports both the `incremental` count and
     the errors.
  4. *Unexpected rejection escaping the result contract:* after C6 the
     only rejections are engine/host bugs — C7's guard catches them
     with bounded retry and a terminal state (§14.11). No expected
     failure path rejects. Post-C6, `apply()` honoring its "never
     throws" comment is what makes the host-side C10 rule implementable
     uniformly (a rejecting flush is C7's problem; a resolved-with-
     errors result is C10's).
- **Degraded-state rule — hosts (C10, new).** When an apply whose batch
  contained a re-baseline-class delta (`full-rebuild` classification,
  or any `mod-scoped` classification) resolves with a non-empty
  `errors` array, the controller sets `resyncRequired` (the same sticky
  flag as §14.11.5) and logs one error naming the failure and the
  recovery. The batch is **not** requeued: (a) a deterministic build
  failure would fail identically on retry — an unbounded loop is the
  one outcome worse than a flagged gap; (b) the queue + budget exists
  for *transient* rejections, and a resolved-with-errors result is by
  definition not transient-identifiable from the host side. Plain
  batches (no re-baseline-class delta) with per-action errors keep the
  second revision's log-only semantics — their failures are per-file,
  the engine's lock-error healing message applies, and no truncation
  occurred. **Clearing:** `resyncRequired` clears on a successful
  `start()` (fresh session) or on the next apply reporting
  `fullRebuild === true` with **no errors** — only a *full* rebuild
  re-reads the live tree for every mod (F14/F15) and provably
  incorporates everything stranded before it; a *stable-root* scoped
  success does **not** clear the flag (F21: it re-syncs only the
  scoped mods, so it cannot prove the stranded work is incorporated).
  *(Fourth revision: under C11 a root-moving scoped batch reports
  `fullRebuild === true` on success — it *is* a full rebuild — so the
  only success shapes that clear the flag are exactly the shapes that
  prove a whole-tree re-read.)*
  That is the recovery proof, verifiable by tree assertions. Retried
  applies (C7) and fresh applies (C10/C2)
  can never overwrite each other's state: retries remove their own
  queue entries; the flag is a single sticky scalar set by any
  failure-class event and cleared only by the success conditions above.
- **Delivery recovery — hosts (C7).** The bounded guard of §14.11. This
  is the correctness pairing: C6 makes expected failures non-rejecting
  (so the host can decide per result — log, or flag per C10 — instead
  of losing the batch to a rejection), and C7 makes unexpected
  rejections non-losing (so no future engine throw can silently abandon
  a spliced batch). Both hosts (§14.11.9).
- **Not chosen:** batch retry *inside* core (a rebuild attempt is not
  idempotent-cheap and the host owns retry policy); silent
  drop-with-log (loses user edits — the direction UX-09 exists to
  forbid); **automatic retry of every result error** (deterministic
  build failures would loop — the exact hazard §14.10.3's counterexample
  establishes for recovery-triggered rebuilds; loop prevention is why
  C10 flags instead of requeues); and *deleting* the truncated delta
  from the delivery pipeline without state (the second revision's
  treatment — superseded here).

### 14.14 Safety invariant matrix (S1–S6)

| Invariant | Mechanism | Source grounding | Residual named? |
| :--- | :--- | :--- | :--- |
| **S1 — no persistent silent source-event loss** | Every event is either delivered or dropped by one rule: under the committed root at decision time (C2 + theorem T′); no cached root exists, so no event is discarded by a stale or ambiguous root. Every *non-incorporating* re-baseline commit sets the C10 degraded state, so a dropped event's missing work is observable and healable rather than silent; a root move can no longer commit an incomplete root silently (C11 promotes it to a full rebuild — the P0-D blocker is closed at the engine boundary). The incorporate-commit remainder is the §14.17 micro-residual — **unobservable by any available signal and unbounded in time absent user action** (fourth revision; the S1 reading this implies is the exact relaxation stated in §14.17, pending owner confirmation). Territory contract governs the committed subtree (§14.8.2); a root move re-opens the subtree by the same getter. | F2/F3, theorem T′ (§14.3), F18, F19, C10, C11 | §14.8.2/§14.8.5/§14.8.6 (territory, pre-assignment placement, retroactive ownership — repair *available* up to the next successful full rebuild, which is not guaranteed to occur) + §14.8.7 (owner-confirmed policy) |
| **S2 — no output self-feeding** | Every engine write is under the committed root current at write time (T1); its events decided while that root holds are dropped (C2). Engine events from an abandoned root are *forwarded* — bounded one-generation garbage per event (§14.8.4); the cycle proof is no-self-sustaining-loop, not universal event filtering. The C11 promotion adds one full rebuild per root-moving batch whose output is territory-dropped from the first write (no chain); the C12 reconciled copy writes into the committed root likewise (no chain). | F3, F7, theorem T′, §14.8.4, F19, C11, C12 | The pre-existing case-6 one-generation self-embedding in full builds (F14) — bounded, not a loop, doctor-flagged |
| **S3 — authoritative baseline** | The filtering authority **is** `this.planInput` (C1) — no independent snapshot exists anywhere in the delivery path; the former S1-vs-S3 divergence class is deleted with the cached field. | F1/F2/F9, §14.2 | — |
| **S4 — bounded resources and recovery** | Buffering: `pending` (pre-existing, debounce-bounded) + the C7 failed-batch queue (dual bound — 16 entries AND 256 total retained deltas; overflow retires to the terminal path, never drops a batch silently; P0-E's unbounded-per-entry memory is closed). Retries: per-entry budget of 3, single driver, backoff 300/600/1200 ms; out-of-order re-delivery cannot corrupt the final tree (C12). Rebuild promotion (C11): exactly one full rebuild per root-moving batch — no follow-up chain. Recovery: restart/build, one-shot; no automatic re-arming; no background reconciliation loop. | §14.11.2–5/10, §14.10.5, C11, C12 | — |
| **S5 — session isolation** | Identity guard on every async continuation that mutates controller state or requeues (flush + failed-batch queue + driver); failed batches of a dead session are retired by the guard — no cross-session overwrite (the P0-B guard fix); the dead session's getter is never read; restart starts clean. | F6, §14.4.10, §14.11.1/8, §14.12.9 | The bounded drained batch of a stopped session (pre-existing, documented) |
| **S6 — observable failure and deterministic recovery** | Delivery failure (rejection): sticky `resyncRequired` + error log naming paths + the provable resynchronization (restart/build re-reads disk — superset healing). Re-baseline failure (resolved with errors): the same sticky state via C10 — a failed rebuild is degradation, not handled delivery; an *incompletely built* root can no longer occur silently (C11). A failed restart leaves the requirement observable (§14.11.6); a manual `pzstudio build` corrects the disk but does not clear the live session's flag. Recovery verified by tree assertions, never by attempt counts; the flag clears only on a proven recovery (§14.13's clearing rule). The one unobservable shape is the §14.17 outcome-5 residual (a mutation landing after a fully successful commit's traversal) — named, not signaled. | §14.11.5–6/10, §14.13, §14.10.4, C11, C12 | The §14.17 outcome-5 residual (indefinite absent user action — the owner decision item) |

**S1/S2 jointly for supported configurations: satisfied, with named
residuals and one owner decision.** The first review's conditional ("if
S1 and S2 cannot both be guaranteed using the proposed API, identify the
precise missing capability and mark the design BLOCKED") remains
answered for the *decision-layer* guarantee: the live getter + forwarding
+ territory contract needs no capability beyond the one additive getter.
The second review's challenge sharpens the answer's boundary: T3 (per-
mutation provenance) is a missing capability no `(type, path)` API can
provide (F19). The fourth revision corrects the S1 reading once more:
its honest meaning is now "no *silent* loss **except the one
unobservable shape** — every non-incorporating *failure* is observable
and recoverable (C10), an incompletely built root can no longer be
committed silently (C11), and out-of-order re-delivery cannot corrupt
the tree (C12); the single remaining silent shape is the outcome-5
residual, a mutation landing after a fully *successful* commit's
traversal, which is unobservable and unbounded in time absent user
action (§14.17)". "Every mutation is delivered or incorporated per
event" is not claimed and cannot be (F19). If the project owner
requires per-event provenance instead of the §14.8.6/§14.8.7 territory
semantics, that requirement is BLOCKED pending an architectural decision
(the fourth revision records the provenance alternative's exact cost in
§14.17); under the territory contract as specified, **verdict: not
BLOCKED**.

### 14.15 Regression matrix (implementation stage — NOT implemented here)

All tests must exercise delivered `FileDelta[]` and/or written trees,
never only root comparisons or getter values (Q3 §10's assertion
method). Deterministic harnesses: the stubbed-watcher + fake-timer
controller harness (`extUtilDevSync.test.ts:396+`), the gated-real-apply
harness (the stash's B1 pattern — the real engine runs unmodified behind
a result gate), and the fake-host engine harness (`buildsession.test.ts:
295+`). Each row names the **RED condition** — the assertion that fails
on a build of the *first-revision* contract (or of any regressions this
matrix guards against).

Core (`tests/unit/buildsession.test.ts`):

- **RG-1 — baseline agreement and failure distinguishability (F4
  pinned).** After `start`, after a successful full rebuild, after a
  scoped rebuild: `getBaselineOutDir()` equals the root the engine
  provably wrote to on disk. Plan-input failure → getter unchanged +
  `errors` + `fullRebuild === false`; build-phase failure → getter
  **moved** + `errors` + `fullRebuild === false`. RED: any
  result-shape-derived root inference (the F4 trap), or a getter that
  trails assignments.
- **RG-2 — scoped normalization (C6).** A rejecting `getPlanInput` on
  the scoped path resolves `{errors: [msg], scoped: [], incremental: N}`,
  retains the baseline (getter unchanged), does **not** reject, and the
  queue still processes a subsequent batch. RED: the F5 rejection
  escaping `apply()`.
- **RG-3 — real-engine scoped rejection, cross-host shape.**
  `createDevSyncCore` with a template resolution that throws on the
  scoped path — `apply` resolves with the error; no unhandled rejection
  (process-level `unhandledRejection` listener). RED: F10's silent
  abandonment.

Extension (`tests/unit/extUtilDevSync.test.ts`):

- **RG-4 — the stashed A1, verbatim outcome.** Failed full rebuild
  after a root move A→B: the under-B event reaches `session.apply` and
  the engine writes it into A. Mechanics updated (below). RED: any
  design that adopts a predicted root at schedule time (the stash's
  exact RED on `8967ada`) — including the first revision's transition
  opening.
- **RG-5 — A′.** Build-phase failure after assignment: the filter
  follows the committed root to B — under-B events filtered, under-A
  events delivered and written into B. RED: a filter stuck on the old
  root (dropping B's output requires it; forwarding A's source requires
  the getter).
- **RG-6 — mid-apply flip timing (theorem T′ pinned).** A gated full
  rebuild A→B: events under the *future* root B fired before the
  assignment are delivered (forwarded — B is not yet committed; in a
  case-6 layout they sync into A's variant folders, §14.8.4); events
  under B fired after the assignment are dropped (B is committed
  territory — the rebuild's own output). The flip is observable exactly
  at the assignment. This is the test that guards the four-site
  assignment discipline. RED: any future engine change that writes
  before assigning (the theorem's only failure mode).
- **RG-7 — the stashed B1, verbatim outcome.** Gated scoped apply, old-
  root event post-assignment: delivered (and the §14.8.5 placement/
  healing properties asserted via the written tree). RED: the shipped
  §6.3 policy's stale filter root (the stash's RED).
- **RG-8 — the stashed C1, verbatim outcome.** Startup divergence
  premise removed (no startup reads): the provider changing between
  `createDevSync` and the first plan input leaves the filter tracking
  the engine — the under-B event is delivered while the engine keeps
  A. RED: any filter built on a pre-start fresh read.
- **RG-9 — stable output remains filtered (loop protection).** The
  B.12 pins hold **unchanged in outcome**: engine output `mod.info`
  events; outdir-irrelevant `project.json` edits (no read fires — there
  is no switch left); the output subtree never reaches `apply`. RED:
  naive invalidation; a getter that trails writes.
- **RG-10 — flood safety / no recovery loop (the P2 counterexample
  pinned).** A full rebuild with an in-project outdir emits its whole
  output tree: assert every output event is dropped (none reaches
  `apply`), exactly **one** rebuild runs, and no re-trigger follows.
  RED: MC-2's rebuild-on-overflow (an unbounded rebuild loop), or any
  buffering of output floods.
- **RG-11 — bounded delivery retry (C7, queue form).** A stubbed
  rejecting `apply`: each rejected batch appends a queue entry, the
  single driver re-delivers the head on its own timers (assert with
  fake timers — no new watcher events needed), backoff escalates,
  subsequent fresh events deliver independently between retries, a
  later retry succeeds and delivers that entry. RED: the first
  revision's head-of-`pending` requeue (never redelivered without new
  events), F10's silent abandonment, or any per-entry timer racing.
- **RG-12 — terminal semantics.** Three failed retries of one entry:
  the entry is retired, `resyncRequired` is set, one error log names
  the paths and the recovery, no further automatic retries, fresh
  events still flow. Then the recovery: restart → the new `start()`
  full build delivers the retired changes (assert the written tree); a
  *failed* restart keeps the requirement observable (the flag/state is
  not silently cleared). RED: a terminal state without a working
  recovery, retries that never stop, or a failed restart that looks
  recovered.
- **RG-13 — truncation healing on a successful rebuild (F7 normative,
  success-scoped per the third revision).** A same-burst source edit +
  `project.json` in one batch (edit *before* the trigger, per F20): the
  edit's delta is truncated, the rebuild **succeeds**, and the written
  tree contains it. RED: any design that drops truncated deltas without
  the rebuild's re-read. (The failed-rebuild counterpart is RG-19.)
- **RG-14 — concurrency, stop/restart, isolation.** Overlapping
  flushes serialize in order; `stop()` with an in-flight flush and/or
  an armed retry: no cross-session adoption (identity guards), the
  drained batch bounded, restart clean; legacy doors cold; two
  sessions never cross (extends the existing stop/start and
  cross-leak pins). RED: any retry state or getter read leaking across
  a restart.

Compatibility gates:

- **The stashed A1/B1/C1 delivery assertions are preserved verbatim**
  (the RED assertions quoted in §14.9/§14.12). The harness *mechanics*
  evolve, enumerated so the diff is reviewable: the controller makes
  **zero** `resolveOutDir` calls, so every `resolveSpy` count becomes 0
  and the provider is invoked only by the engine's plan inputs — A1's
  five controller reads (pre-start, post-start correction, switch,
  control-phase switch, control-phase correction) disappear, leaving
  the three plan inputs (start, the failed rebuild's, the control
  rebuild's); B1's two startup reads and post-apply correction
  disappear, leaving the start and scoped-rebuild plan inputs; C1's
  three startup reads become the single start plan input. The
  `filterRoot` introspection disappears with the field. No delivery
  assertion changes.
- **Shipped §6.3-policy pins:** B.11 (temporal gate), B.12 (loop
  protection), B.13 (scoped-move delivery) hold **unchanged in
  outcome**; their read-count mechanics evolve per above; the
  switch/correction-specific tests (e.g. "retains the last good root at
  the switch", "post-apply correction") are superseded by RG-4…RG-8's
  stronger forms and are removed with the machinery they pin.
  Fourth-revision mechanics notes: C11 leaves every **stable-root**
  scoped pin (B.13, RG-7) byte-identical — it fires only when the
  resolved outdir changed; and the shipped engine pin "apply() creates
  and deletes files in the output" deletes a delta whose source still
  exists — a synthetic sequence no watcher produces (watcher deletes
  trail disk writes) — so under C12 its mechanics must model the
  source deletion (remove the source file first); its outcome is
  unchanged for every realistic sequence.
- **RG-15 — stubs and CLI parity.** `fakeSession` gains the getter (one
  line; F12's double-cast compiles unchanged otherwise). `watch.test.ts`
  filter pins unchanged (the CLI's frozen-root behavior is Q3-documented
  and not changed by Q4; C7's watch-side guard is the only `watch.ts`
  behavior delta, pinned by a rejecting-apply test mirroring RG-11 —
  the watch-side C10 counterpart is log-only: a CLI command holds no
  sticky state, so its degraded output names the resync procedure in
  the error text).

Third-revision rows (P0-A/P0-B/P0-C — every one uses the deterministic
tools already mandated: fake-watcher handler queues with manual
delivery-order control, gated real-engine applies, fake timers; no
real sleeps anywhere):

- **RG-16 — delayed delivery across a commit (P0-A, case-6).** Real
  engine, gated: deliver a `project.json` event (root A→B case-6 move),
  gate the flush, write a source file under A **on disk**, deliver its
  event only *after* the (successful) rebuild's assignment — i.e. after
  releasing the gate and awaiting the getter flip to B. The event is
  dropped (territory — the written tree contains the file via
  `copyTree`'s live re-read, proving the drop is lossless *here*).
  RED: a filter that forwards it (double-delivery) or any design whose
  drop leaves no recovery path. Pins the T′ drop rule and F19's
  ordering indifference.
- **RG-17 — future-root edit, non-incorporating commit (P0-A + C10).**
  Same harness; the rebuild is made to fail before the mod's copyTree
  (gated failing operation). The under-B source event delivered after
  the commit is dropped (B is committed territory), `result.errors` is
  non-empty, and **`resyncRequired` is set** — the loss is observable,
  not silent. Then restart: the new `start()` full build delivers the
  edit (assert the written tree). RED: the second revision's behavior
  (errors logged, delivery treated as complete, no state).
- **RG-18 — delayed engine-output notification after root migration.**
  Real engine: successful A→B move; an engine output event generated
  under A (written pre-move) is delivered after the commit — it is
  **forwarded** (not under B), classified by the engine against B, and
  the resulting write lands under B (bounded one-generation garbage,
  §14.8.4); assert no loop (exactly one extra apply, its output
  dropped). RED: any "every engine event is filtered" assumption (the
  reverse-ordering forwarding is real), or an unbounded forward chain.
- **RG-19 — failed full rebuild with a truncated source delta
  (P0-C).** Real engine, batch `[source edit, project.json]` (F20
  position-independence pinned by running both orders), gated to fail
  mid-`buildVariants` before the edit's mod copy: result resolves
  `{fullRebuild: false, errors: non-empty}`, the edit is on disk,
  absent from the output, `resyncRequired` set, no automatic retry.
  Recovery: a subsequent successful full rebuild (or restart)
  incorporates the edit and clears the flag. RED: log-only handling
  (the second revision's), any automatic retry of the failed batch, or
  a flag that clears on a scoped success.
- **RG-20 — overlapping rejected flushes (P0-B).** Stubbed rejecting
  `apply`, two overlapping flushes (fire the debounce twice without
  awaiting), both reject: **two** queue entries exist, neither
  overwritten (assert both batches' paths survive in queue
  introspection or via later successful delivery), the driver
  re-delivers both, budget is per entry. Includes the interleavings:
  retry fire during another flush; retry succeeding while another
  entry is failing; stop with a driver armed and an entry queued (no
  cross-session leak). RED: the single-slot design (one batch
  vanished — assertable as a missing delivery of the first batch's
  paths).
- **RG-21 — recovery state machine.** Terminal state via RG-12; then
  (a) restart with a *failing* `start()` → the degraded state remains
  surfaced (a failed recovery is not recovery); (b) restart with a
  healthy `start()` → flag cleared, written tree complete; (c) without
  restart, a later apply reporting `fullRebuild === true` with no
  errors → flag cleared; a scoped-only success → flag **retained**
  (F21). RED: a flag cleared by a failed restart, by a scoped success,
  or by a manual `pzstudio build` while the session is live.

Fourth-revision rows (P0-D/P0-E/P0-F — every one uses the same
deterministic tools: real unmodified `BuildSession` behind gated
operations, fake timers, manual delivery-order control; the P0-D and
P0-E counterexamples were verified as disposable scratch tests against
the real engine at `ff80f13` and deleted — the gates below pin them
permanently):

- **RG-22 — successful scoped A→B root migration, two mods, no errors
  (the P0-D counterexample, pinned as fixed by C11).** Real engine,
  both variants: start on outdir A (both mods' trees verified on
  disk), the config layer's outdir moves to B, deliver exactly
  `[change mod_alpha/mod.info]`. Expected: result
  `{fullRebuild: true, errors: [], scoped: []}`, and the written tree
  contains **both** mods' generated trees and `workshop.txt` under B
  for both variants; `mod_alpha`'s subsequent incremental write lands
  in B (baseline proven, not asserted). RED: the pre-C11 engine —
  `mod_beta`'s output and `workshop.txt` absent from B with zero
  errors (the exact counterexample executed at `ff80f13`).
- **RG-23 — root migration with a build-phase failure.** Same harness
  with a gated failing operation inside `buildVariants` after the
  promotion: result `{fullRebuild: false, errors: non-empty}` (F4),
  the baseline is committed to B (a later incremental write lands in
  B), `resyncRequired` is set, no automatic retry; a subsequent
  successful full rebuild (or restart) completes B and clears the
  flag. RED: the batch treated as handled delivery without the flag,
  or a flag cleared by anything but a proven whole-tree rebuild.
- **RG-24 — consecutive A→B→A scoped transitions.** Two config moves
  delivered via `mod.info` deltas (A→B, then B→A): each promotes to
  exactly one full rebuild (assert the promoted-rebuild count equals
  the root-move count — no cascade, no loop), and the final tree under
  the final root A is complete (every mod, both variants,
  `workshop.txt`). RED: an unbounded rebuild chain, a missed
  promotion on either transition, or a stale-root filter decision in
  either direction.
- **RG-25 — overlapping flushes spanning a root migration.** Flush 1
  (a `mod.info` delta, root A→B) and flush 2 (a `mod_beta` source
  delta) overlap; the engine queue serializes them. Expected: flush
  2's deltas are classified against the post-promotion baseline and
  written into B; no batch is lost; the final tree is consistent; any
  pre-assignment incremental write into A is bounded garbage (never
  asserted as correct output). RED: a batch applied against a stale
  root decision or abandoned.
- **RG-26 — failed older create, successful newer delete.** Real
  engine: `[create x]` rejected (gated), the source file then deleted
  and `[delete x]` delivered successfully; the retry of the stale
  create must be **skipped** (source absent — ignored, no error), the
  output stays without the file, and the result carries no errors.
  RED: an engine that resurrects the file from a stale snapshot or
  surfaces a spurious per-action error.
- **RG-27 — failed older delete, successful newer create (the P0-E
  divergence case, pinned as fixed by C12).** Real engine: `[delete
  x]` rejected (gated), the user re-creates `x` and `[create x]` is
  delivered successfully (output = current content); the retry of the
  stale delete must **reconcile to a copy** (C12) — the output still
  contains `x` with the current source content, no errors. RED: the
  confirmed divergence — output file deleted while the source still
  has it (the counterexample executed at `ff80f13`).
- **RG-28 — retry-queue capacity and total retained-delta bounds.**
  Stubbed rejecting apply: fill the queue past 16 entries and past
  256 total deltas (a large batch); assert both bounds are enforced
  at enqueue, the overflow batch takes the terminal path
  (`resyncRequired` + one error log naming its paths and the
  recovery), no queued entry is silently dropped, and a terminal
  retirement frees room for a subsequent rejection. RED: unbounded
  per-entry path growth retained in memory, or an overflow that
  discards without the flag and log.
- **RG-29 — successful-build late-mutation residual (outcome 5 —
  pins the documented residual, not a fix).** Real engine, case-6
  layout (outdir inside a mod folder), gated fs: a full rebuild
  succeeds; a source mutation lands **after** the traversal passed
  the file (gate released mid-plan); its event is delivered only
  after the commit. Expected: the event is dropped (committed
  territory), the output **lacks** the mutation, `errors` is empty,
  `resyncRequired` is **not** set (the build succeeded), and no
  recovery event exists — nothing schedules a rebuild. This row
  asserts §14.17's residual verbatim (indefinite persistence absent
  user action) and the exact S1 relaxation the owner is asked to
  confirm; it also guards against regressions that would set the flag
  on every successful rebuild (false-positive noise). RED: any design
  claiming per-event losslessness here, or a design that flags
  successful commits.

### 14.16 Proposed implementation boundaries (minimal)

1. `packages/core/src/buildsession.ts` — the getter (C1, a few lines
   with doc), the scoped-fetch normalization (C6: move 519–520
   inside the failure envelope), the scoped root-change promotion
   (C11: compare the fetched input's normalized outdir against the
   committed baseline before assigning; on a difference delegate to
   the full-rebuild envelope — F22 proves this is the only site), and
   the execution-time delete reconciliation (C12: an incremental
   delete whose source path currently exists is applied as a change
   of that path). No other engine change; no new export, type or
   result field (`SessionApplyResult` is untouched — C11 reports
   through the existing `fullRebuild` shape).
2. `packages/cli/src/api.ts` — **nothing** (the getter arrives through
   the existing `BuildSession` re-export). `packages/cli/src/lib/**` —
   nothing for the contract itself, except `commands/watch.ts`'s C7
   guard.
3. `packages/vscode-extension/src/util/devsync.ts` — delete
   `filterRoot`, the schedule-time switch, both correction reads and
   `isRootProjectJson`; implement C2's live per-event getter read; add
   C7's failed-batch queue, single retry driver, identity guards and
   terminal state, plus C10's degraded-state rule (§14.13).
   `packages/cli/src/lib/commands/watch.ts` — C7's guard plus the
   log-only C10 counterpart (§14.11.9).
4. Tests per §14.15. No manifest, dependency, or schema change.

Deliberately out of scope: the CP-12 status surface; CLI watch filter
re-resolution (Q3 documents the frozen root; unchanged); UX-10 and
Project Cockpit work; an in-place rebuild-recovery command (§14.10.5 —
a future Cockpit/CLI affordance, not a watcher-policy one).

### 14.17 Remaining risks and unresolved questions

- **RISK (territory contract is user-facing semantics):** files placed
  under the committed output root are not source-delivered while that
  root is committed (§14.8.2) — and neither are *events* decided
  there, whatever the mutation's history (§14.8.6). This is the
  contract the stashed A1 control pins and every build tool's output
  directory implies, but it must be documented for users (doctor
  guidance / doc 06) — the case-6 family heals such files on the next
  rebuild of the owning mod; other layouts never treat them as source;
  non-incorporating commits are covered by the C10 degraded state, not
  by healing.
- **RESIDUAL (the successful-commit late-mutation residual — named,
  reclassified by the fourth revision as UNBOUNDED in time; P0-F).**
  C10 makes every *failed* re-baseline observable and recoverable (the
  resync re-reads the whole live tree), not per event. Within one
  incorporating commit, F13's abort-on-first-failure makes the
  incorporate/miss boundary a per-subtree property (every mod whose
  copy ran is incorporated; every mod after the failure is not), so a
  user mutation can be incorporated by the same commit that fails
  elsewhere while a different, later mutation is missed by the very
  next commit — the degraded state covers both conservatively (it
  flags on the failure and clears only on a proven full rebuild); a
  mutation missed by an incorporating commit whose result *carries
  errors* is flagged. But a mutation missed by a commit that fully
  *succeeded* (landed after its subtree's traversal — outcome 5 of
  §14.13) leaves no error to flag. The third revision described that
  shape's bound as "the next successful full rebuild (any later
  structural change, user save in a non-case-6 layout, or the
  C10-flagged failure path)". **The fourth revision withdraws that
  bound claim (P0-F): none of those triggers is guaranteed to occur.**
  A structural change happens only if the user makes one; a re-save
  heals only in non-case-6 layouts (where the missed file's path is
  outside the committed root and its fresh event is forwarded) — in a
  case-6 layout the missed file lies *under* the committed root, so
  even re-saving the missed file itself is territory-dropped and
  delivers nothing; and the C10-flagged failure path is itself
  user-action-dependent. **Determination: the mutation can remain
  unincorporated indefinitely.** The only healing events are
  user-triggered — restarting DevSync, running `pzstudio build`,
  editing `project.json` (full rebuild), or changing the owning mod's
  `mod.info`/`.pzstudioignore` (scoped rebuild of that mod, which
  re-copies its tree) — and DevSync cannot force any of them without
  violating the no-auto-rebuild decisions (S4, the P2 flood
  counterexample). This is the irreducible remainder of T3 on the
  available information; it is not "closed to within a bound", it is
  an open-ended policy residual, and adopting it is exactly the
  territory decision recorded below.
- **RISK (the theorem is a discipline, not a type):** S2's and S1's
  decision-layer mechanisms rest on F2's four-site
  assignment-before-write discipline. A future engine change that
  writes before assigning would silently break them. The guards are
  RG-6 (the mid-apply flip pin) and RG-16/RG-17 (delivery-order
  injection): they fail loudly on any such change. A type-enforcement
  (a builder that cannot write before assigning) is a Core redesign —
  out of Q4 scope, noted for CP-12-era work.
- **RISK:** F4's semantics (a failed build still commits the new
  baseline) surprise consumers who assume "failed rebuild = nothing
  changed". Q4 does not change engine semantics; it makes them
  observable. Whether a failed build should roll the baseline back is
  a separate Core decision (rollback would change scenario 4 and
  RG-1).
- **RISK (pre-existing, unchanged):** the case-1 + title-named-mod
  collision (an outdir equal to the project root places the variant
  folder at `<project>/<title>`; a mod named exactly the sanitized
  title would be deleted by the build's `removeDir`) — a catastrophic
  layout the filter cannot fix in any root configuration (Q3 §3.1's
  corollary); doctor family, guidance not mechanics.
- **Unchanged Q3 deferrals:** §12.1's per-flush re-resolution stays
  rejected (superseded by the committed-root rule, which is strictly
  stronger); §12.5's pathological layouts remain doctor guidance;
  §12.4's native-exclusion parity gap is untouched.
- **QUESTION (for approval, not for this task): getter naming** —
  `getBaselineOutDir` (proposed) vs `getOutputRoot` vs
  `getEffectiveOutDir`. The contract is the semantics (C1); the name
  follows the API review.
- **QUESTION (for approval — decision item, restated by the fourth
  revision with the corrected residual):** confirm the territory
  policy as specified in §14.8.6/§14.8.7 — whole-committed-outdir
  granularity, decision-time ownership (including retroactive capture
  of pre-commit mutations). The fourth revision separates the two
  possible contracts explicitly, because they are different products,
  not different proofs:
  1. **Strict source mutation delivery or incorporation** — every
     legitimate source mutation is eventually delivered or
     incorporated, with no retroactive exclusion. On the available
     public API this is **not achievable**: delivery is unordered
     relative to engine continuations (F19) and T3 is unprovable, so
     a decision-time filter cannot know a delayed event's provenance.
     The only technically constructible route is **engine-side write
     provenance** — each apply reports the paths it wrote; the host
     keeps the latest apply's written-path set and, at decision time,
     delivers (instead of dropping) any event under the committed
     root whose path that apply did **not** write (the engine then
     incorporates it incrementally; its own output event lands in the
     next apply's written set and is dropped — terminating). That
     converts the outcome-5 residual into an observable, incorporated
     delivery, at the cost §14.9's table already priced for Q4: a new
     result-contract surface on the frozen engine plus bounded
     host-side per-apply state (and it still leaves the microscopic
     read→write race inside one file's copy, which only a
     content-comparison reconciliation could close).
  2. **Decision-time committed-output territory** — the contract as
     specified, accepting that a mutation whose event is decided under
     a committed root that did not incorporate it may be retroactively
     excluded; failures are observable (C10), incompleteness cannot
     commit silently (C11), re-delivery cannot corrupt (C12), and the
     one silent shape is the outcome-5 residual above — **unbounded
     in time absent user action**.
  The second is a product decision, not a technical proof of the
  first. The existing A1 control test (F18) and CLI parity do **not**
  constitute owner approval: they pin the *filter decision's*
  granularity and continuity, not the user-facing mutation-loss
  policy. Confirming contract 2 revises the *user-facing* reading of
  S1 — **the exact relaxation**: from "every legitimate source
  mutation is delivered or incorporated" (the original, stricter
  requirement — kept visible here and in §14.14 as the unmet-in-full
  strict contract) to "every legitimate source mutation is delivered,
  or dropped under the documented territory contract; every
  non-incorporating *failure* is observable and healable via C10, an
  incomplete root can no longer commit silently via C11, and
  out-of-order re-delivery cannot corrupt the output via C12 — except
  the outcome-5 residual, whose observable consequence is: in a
  case-6 layout, an edit saved during a build window after the
  traversal passed its file may never appear in the output, no
  diagnostic reports it, and it heals only when the user next
  restarts DevSync, runs `pzstudio build`, or changes the project or
  owning mod's structure". The UX-09 gates to re-read under that lens
  are B.11/B.12 (Q3 §10) and the stash's A1 control (F18), whose
  assertions are unchanged in outcome — only their *rationale* moves
  from "proven loss-prevention" to "owner-confirmed policy".
  Rejecting contract 2 (requiring contract 1) blocks the design per
  §14.14's carve-out until the provenance surface is specified and
  approved as its own API decision.
- **QUESTION:** whether the CLI watch should adopt the getter for its
  own filter root (it could re-read the committed root per event for
  free). Q4 does **not** propose it — the CLI's native parcel `ignore`
  is start-frozen regardless (Q3 §12.4), so the getter buys the CLI
  little; deferred with §12.

### 14.18 Q4 second-revision validation checklist

- [x] Preflight re-verified: branch `42.20.0-dev`, HEAD `caf4c42`, clean
  tree; the UX-09 stash identified by message and inspected read-only
  (never applied, never popped) — including its control assertions,
  which gate the getter's granularity (F18).
- [x] Every claim anchored to source at the audited HEAD; the Q3
  sections above untouched except for the appended pointer blockquote;
  first-revision line references corrected where drift was confirmed
  (F3: `buildplan.ts:119–129`; F7: `buildplan.ts:341–342`; F1: the
  public surface at 358–396).
- [x] The review's P1–P4 each dispositioned from source (§14.0,
  §14.9–§14.12); its MC corrections individually evaluated, none
  accepted as proposed (§14.0).
- [x] The assignment-before-write theorem stated with per-clause
  citations and its failure modes bounded (§14.3); the nine transition
  phases mapped and dissolved (§14.12); no transition slot, no
  generation ID — no surviving counterexample.
- [x] COMMITTED-discard reproduced as a real loss (both cases,
  F13-grounded) and eliminated by deletion of the mechanism, not by
  reclassifying the loss (§14.9); the territory contract stated and
  gated by the stash's own control (§14.8, F18).
- [x] The 256-path cap premise falsified, the rebuild-on-overflow
  counterexample recorded, and `rebuild()`'s recovery properties
  proven with their verification rule (§14.10).
- [x] Retry: identity guards, event-independent scheduling, finite
  budget + backoff, separation, terminal state, provable recovery —
  specified for both hosts (§14.11); the scoped apply failure shapes
  distinguished without duplicated retries (§14.13).
- [x] S1–S6 each mapped to a mechanism, a source grounding and a named
  residual (§14.14); the BLOCKED conditional answered (no missing
  capability).
- [x] Regression matrix with owners, deterministic harnesses, RED
  conditions and delivery/tree-level assertions; the stashed A1/B1/C1
  delivery assertions preserved verbatim with enumerated mechanics
  evolution (§14.15).
- [x] Docs-only change: no production source, test, manifest or
  dependency touched (§14.16 is a proposal, not an edit).

### 14.19 Q4 adversarial-closure (third-revision) validation checklist

- [x] Preflight re-verified at `20b48be`: branch `42.20.0-dev`, HEAD
  matches, clean tree, the UX-09 stash located by its message and
  inspected read-only (never applied, never popped) — its A1 control
  re-verified verbatim (F18), including the B1 gated-real-apply
  harness pattern reused by RG-16…RG-21.
- [x] The theorem assessment separated into T1/T2/T3 (§14.2): T1 and
  T2 proven from source; T3 stated unprovable (F19) — the second
  revision's stronger headline withdrawn and the theorem restated as
  T′ (§14.3) without weakening any specification that depends on it.
- [x] P0-A dispositioned (§14.0, §14.4.9, §14.8.6): legitimate-source
  determination, non-incorporating-commit determination, the
  indistinguishability determination, the retroactive-ownership
  statement, the reverse-ordering forwarding, rapid A→B→A and
  containment analysis (§14.3's last obligation) — the
  "unprocessed indefinitely" shape closed to within the C10 recovery
  bound (§14.17).
- [x] Territory contract converted from implicit proof to explicit
  policy (§14.8.6/§14.8.7) with the owner decision item recorded
  (§14.17's QUESTION) and the S1 reading revision it implies; F18's
  outdir-granular pin honored (no narrowing to variant folders).
- [x] P0-B dispositioned: the single-slot collision confirmed against
  the second revision's own rule-8 text, replaced by the bounded FIFO
  failed-batch queue with per-entry budget, single driver, explicit
  overflow policy and the nine interleavings resolved (§14.11.2/8);
  the candidate alternatives compared and rejected with reasons.
- [x] P0-C dispositioned: the truncation sequence confirmed (F7/F13/F20),
  the five outcomes distinguished, C10 added to the contract (§14.7,
  §14.13) with the no-auto-retry loop-prevention rationale, the
  scoped-success non-clearing rule, and the exact recovery/clearing
  conditions specified (§14.11.6, §14.13).
- [x] Recovery correctness re-derived: fresh-rebuild `start()`,
  pre/post-assignment failure shapes, failed-restart observability,
  `pzstudio build` non-clearing semantics, retry/fresh state
  separation (§14.11.6, §14.13, RG-21).
- [x] S1–S6 re-derived against the new mechanisms and residuals
  (§14.14); the BLOCKED carve-out stated precisely (T3 provenance).
- [x] Regression plan extended with the deterministic third-revision
  rows (RG-16…RG-21), each naming its RED condition and harness; no
  real sleeps; getter-dependent tests marked as implementation-stage
  (§14.15 preamble).
- [x] Docs-only change re-verified: no production source, test,
  manifest or dependency touched; Q3 sections untouched.

### 14.20 Q4 final correctness gate (fourth-revision) validation checklist

- [x] Preflight re-verified at `ff80f13`: branch `42.20.0-dev`, HEAD
  matches, clean tree; the UX-09 stash located by its message and
  inspected read-only (never applied, never popped — A1's control-phase
  assertion re-checked verbatim, F18 intact).
- [x] Every load-bearing §14 fact re-read against source at `ff80f13`;
  the commits between `20b48be` and `ff80f13` are documentation-only,
  so all file:line references remain valid (F1–F21 unchanged; F22
  added).
- [x] P0-D confirmed with a real-engine counterexample (two mods,
  successful scoped A→B migration: `mod_beta`'s output and
  `workshop.txt` absent from B, `errors: []`, baseline proven to be B
  behaviorally, no C10 signal) and repaired at the engine boundary by
  C11 — selected over the explicit-result (B2) and host-comparison
  (B3) alternatives: B3 is disproven by the A→B→A overlapping-flush
  concealment (§14.7's C11 record), B2 leaves the incomplete root in
  use until user action and adds surface; C11 preserves
  `SessionApplyResult` semantics, reuses the F4 failure envelope +
  C10, and cannot loop (one full rebuild per root-moving batch).
- [x] P0-E confirmed with real-engine counterexamples (stale delete
  after newer create diverges; stale create after newer delete
  converges silently; repeated change converges) and repaired by C12
  (execution-time delete reconciliation — order can no longer change
  the final tree) plus the dual queue bound (16 entries AND 256 total
  retained deltas; overflow takes the terminal path, never a silent
  drop); the four-axis determination (within-batch coalescing /
  between-batch ordering / engine reads / delta-type-driven
  operations) recorded in §14.11.10; host-side serialization,
  re-validation and merge alternatives rejected with reasons.
- [x] P0-F confirmed: the third revision's "bound" on the
  successful-commit residual is withdrawn — the residual persists
  indefinitely absent user action; re-saving the missed file does not
  deliver in case-6 layouts; the two contracts separated with exact
  costs (§14.17), the S1 relaxation stated verbatim, the original
  stricter requirement kept visible in the decision record, and A1/CLI
  parity explicitly not treated as owner approval.
- [x] S1–S6 re-derived against C11/C12 and the corrected residual
  (§14.14); the S1 meaning restated ("no silent loss except the one
  unobservable shape"); verdict unchanged: not BLOCKED under the
  territory contract, BLOCKED-for-requirement if per-event provenance
  is demanded.
- [x] Regression plan extended with the deterministic fourth-revision
  rows (RG-22…RG-29), each naming its RED condition, harness, expected
  `FileDelta[]` deliveries and written-tree assertions; the stashed
  A1/B1/C1 outcomes and the stable-root scoped pins (B.13, RG-7)
  unchanged; the C12 mechanics note recorded for the shipped delete
  pin (§14.15 compatibility gates).
- [x] Docs-only change re-verified: no production source, test,
  manifest or dependency touched; Q3 sections untouched; the scratch
  counterexample tests used for verification were deleted before
  commit.

---

## 15. UX-09 scope reconciliation and approval record (governance pass)

Written at HEAD `80c80fe6331538c3cb500c5caeae2954f3fc1a1c` (branch
`42.20.0-dev`, tree clean). Documentation-only governance review: no
production source, test, manifest or dependency change belongs to this
section, and **nothing in it authorizes implementation**. It reconciles
the §14 proposal with the original UX-09 acceptance baseline
([`10-ui-ux-audit-findings.md`](10-ui-ux-audit-findings.md) UX-09,
[`12-project-cockpit-migration-matrix.md`](12-project-cockpit-migration-matrix.md)
§3/§4/§11) and separates, for every normative §14 item: what is already
shipped and accepted, what is an independently defensible defect fix,
what is proposed hardening, and what is a product decision still
awaiting the owner. §14 above is preserved verbatim as the proposal
record — the four revision GO verdicts recorded there were review-process
artifacts commissioned by the design work itself, not product-owner
consent, and none of them approves implementation.

> **Naming (normative for all documents).** The §14 addendum and its
> revisions used the label **"Q4"** for the DevSync baseline-safety work.
> That label collides with the migration matrix's **Q4** — the missing-mod
> "Remove from Project…" semantics question
> ([`12-project-cockpit-migration-matrix.md`](12-project-cockpit-migration-matrix.md)
> §4, UX-13). Resolution, without rewriting history: the "Q4" labels in
> this file (header blockquotes, §14 heading, §14.0–§14.20) are
> **historical identifiers of completed review iterations** and stay as
> written; the current descriptive name of the proposed work is the
> **UX-09 DevSync Baseline Safety Contract** (this section, §14). Every
> reference to matrix Q4 keeps the missing-mod meaning; no mass rename is
> performed in either document. The accepted Q3 contract (§1–§13,
> `studio.resolveOutDir` + the §6.3 policy, shipped at `8967ada`) is
> untouched and remains the contract of record for the shipped UX-09
> remediation.

### 15.1 The original UX-09 boundary (source-grounded reconstruction)

1. **Original problem.** The extension fed every watcher event under the
   project into `session.apply`; the CLI watch pre-filtered through
   `isWatchPathIgnored` (outdir + dot segments, `watch.ts:124`). Core
   classification has no outdir rule (`buildsession.ts:129-223`),
   so an outdir inside a mod folder would feed the engine its own
   writes (the loop case) and every other output event cost a wasted
   apply pass — a host-consistency gap plus cheap loop insurance
   (audit UX-09, doc 06).
2. **Original proposed fix.** Call
   `isWatchPathIgnored(projectDir, outDir, path)` in
   `DevSyncController.schedule`, with the outdir obtained without
   duplicating tier logic — which became open question Q3.
3. **Original safety invariants.** Deliver legitimate source events
   (fail open under unsafe or unknown roots); never self-feed the
   engine's output; dot-segment noise filtered.
4. **Original acceptance tests.** Events under a dot segment never
   reach `apply`; CLI/extension parity cases from
   `tests/unit/watch.test.ts` reused (matrix §3 UX-09), later
   formalized as the Q3 §10 matrices A/B/C.
5. **Allowed package boundaries.** UX-R0 is "Correctness
   (extension-only; CLI/Core: **no**)" (matrix §11). Q3 was the single
   sanctioned API decision, and the matrix record is explicit: an
   engine addition "is a **CLI API change** requiring its own decision —
   not smuggled into a UX fix".
6. **Explicitly deferred at the time.** Full outdir exclusion pending
   the outdir-resolution decision (Q3); the DevSync state owner and any
   persistent sync UI (UX-R2/CP-04); structured session status (CP-12).

**Status of the original scope: shipped and accepted.** Commit
`8967ada` implemented the approved Q3 contract — `studio.resolveOutDir`
(`studio.ts:148,282`) plus the §6.3 refresh-triggered re-resolution
policy in the controller (filter root, post-start correction,
schedule-time `project.json` switch, post-apply correction; verified in
`packages/vscode-extension/src/util/devsync.ts`) with the Q3 §10 test
matrices. UX-09's original acceptance is met; §14 exists because the
red-first stash tests (A1/B1/C1) then **proved** that §6.3's residual
windows are silent source-event losses, not cosmetic misalignments —
which is a *new* finding about the shipped behavior, not part of the
original acceptance baseline.

### 15.2 Dependency graph (decisions vs milestones)

```text
UX-R0 / UX-09
  ├─ Extension pre-filtering .................. shipped (8967ada, §6.3 policy)
  ├─ Accepted/shipped Q3 effective-outdir work   (studio.resolveOutDir + §10 tests)
  └─ Proposed DevSync safety prerequisites
       (the UX-09 DevSync Baseline Safety Contract, §14 — nothing below
        is approved; each needs its own explicit decision)
       ├─ Core/API decisions ............... C1 getter (DX-2); territory
       │                                     policy Contract B (DX-9)
       ├─ Independent engine correctness fixes   C6 (DX-4), C11 (DX-7)
       └─ Host reliability enhancements .... C7/C12 retry package (DX-5/DX-8),
                                             C10 degraded state (DX-6)

UX-R2
  └─ Cockpit Development Sync state owner/UI .. CP-04; persistent
                                              resyncRequired UI; CP-12
```

The graph distinguishes **decisions** (approvals the owner owes) from
**implementation milestones** (UX-R0 shipped; UX-R2 deferred). The
proposed prerequisites hang off UX-09 but are *not* UX-R0 work: UX-R0's
extension-only boundary holds exactly as the matrix froze it, and every
cross-package item below is an exception requiring its own approval.

### 15.3 C1–C12 classification

Labels used (exactly the six permitted):
`DIRECT_UX09`, `REQUIRED_PREREQUISITE`, `OPTIONAL_HARDENING`,
`SEPARATE_DEFECT`, `PRODUCT_DECISION`, `DEFERRED`. No item is
`REQUIRED_PREREQUISITE` merely because it appears in §14; each such
label names the contract it is a prerequisite *of*, and states why a
narrower implementation cannot satisfy that target.

**C1 — Core-owned committed-baseline getter (`getBaselineOutDir`).**

| Field | Assessment |
| :--- | :--- |
| Requirement | `BuildSession` exposes the committed baseline's outdir (`this.planInput?.config.outdir`) read-only; `undefined` before first assignment. |
| Source evidence | `buildsession.ts:339` private field, public surface only `start/rebuild/apply/stop` (verified — no accessor exists); fresh reads (S1) diverge from the committed baseline (S3) across macrotask windows (F2/F8). |
| Original UX-09 dependency | **Indirect.** The original pre-filter shipped without it; the getter is needed only to close the *proven* A1/B1/C1 residual windows of the shipped §6.3 policy. |
| Package owner | Core. |
| Behavioral impact | None on existing semantics — additive read-only member. |
| Compatibility impact | Additive member on an exported class; no interface or result-shape change; in-repo stubs double-cast (F12). `PzStudio` untouched. |
| Necessity | Not a must-have for UX-09 closure (shipped). REQUIRED_PREREQUISITE **of the §14 successor contract**: every fresh read (the shipped policy's root source) is heuristic by construction (S1 ≠ S3), and §14's decision-time drop rule is unsound without the field itself. No narrower mechanism satisfies that target — §14.5/§14.6 show the CLI-closure alternative is convention-bearing and the wrapper widens the frozen surface more. |
| Alternative | Keep the shipped §6.3 policy with its documented residuals; or Option A closure (rejected in §14.6). |
| Milestone | Independent prerequisite of the proposed §14 work — outside UX-R0. |
| Approval | New approval required (v2/Core surface exception to UX-R0). Status: **PROPOSED** (DX-2). |
| Test obligation | RG-1 (baseline agreement + F4 failure distinguishability); RG-6 guards the four-site assignment discipline the getter rests on. |

**C2 — live per-event getter read; `filterRoot` deleted.**

| Field | Assessment |
| :--- | :--- |
| Requirement | Schedule-time drop decision reads `session.getBaselineOutDir()` at every event; no cached root; `undefined` fails open. |
| Source evidence | Controller holds `filterRoot` refreshed at four points (`devsync.ts:68,100-110,171-177,213-224`); every refresh is a fresh read that can strand on the wrong side of a re-baseline (F9; the stash's A1/B1/C1). |
| Original UX-09 dependency | **Direct lineage** (it is the pre-filter with a better root source) — but not necessary for the original closure, which shipped. |
| Package owner | VS Code extension. |
| Behavioral impact | Replaces the shipped §6.3 policy's correction reads; the drop set for a stable root is unchanged (continuity with CLI watch and Q3, F18). |
| Compatibility impact | Extension-internal policy; no public API. Supersedes accepted behavior — therefore a decision, not a bug fix. |
| Necessity | REQUIRED_PREREQUISITE of the §14 contract (it *is* that contract's filter). Narrower alternative that satisfies the *original* UX-09 invariants: the shipped §6.3 policy — which is why C2 is gated on the owner accepting the §14 residuals story (DX-9), not on UX-09. |
| Alternative | Ship nothing; keep §6.3 + documented residual windows. |
| Milestone | Deferred — gated on DX-2 + DX-9. |
| Approval | New approval required (changes accepted §6.3 behavior). Status: **PROPOSED** (DX-3). |
| Test obligation | RG-4…RG-9; shipped B.11/B.12/B.13 outcomes preserved. |

**C3 / C4 / C5 — deletion of the prediction/switch, the buffer, and the correction reads.**

| Field | C3 (no prediction/switch) | C4 (no buffer) | C5 (correction reads deleted) |
| :--- | :--- | :--- | :--- |
| Requirement | Root-level `project.json` events deliver like any event; adopt-on-commit replaces adopt-on-prediction. | Only `pending` remains; a failed batch never re-enters it. | Controller performs zero `resolveOutDir` calls; the reader stays on the surface for hosts/diagnostics. |
| Source evidence | T′/§14.12 (the transition machinery's coverage target is empty); F7/F20. | F6 (queue serialization), F17. | F9 (the four reads are the S1-divergence class §14 exists to delete). |
| UX-09 dependency | Indirect — consequences of adopting C2, not independent needs. | Same. | Same. |
| Owner | Extension. | Extension. | Extension. |
| Behavioral impact | Removes the shipped switch points; residuals move to the getter. | No shipped buffer exists to remove — normative constraint. | Removes shipped post-start/schedule/post-apply reads. |
| Compatibility impact | Extension-internal. | Extension-internal. | Extension-internal; `resolveOutDir` unchanged on the surface. |
| Necessity | REQUIRED_PREREQUISITE **within the C2 adoption** (C2 without C3 leaves two root authorities). | Same (C4 prevents reintroducing the P1/P2 buffer class). | Same (C5 without C2's live read would strand the filter). |
| Alternative | None within the §14 adoption; outside it, the shipped policy stands. | — | — |
| Milestone | Deferred with DX-3. | Deferred with DX-3. | Deferred with DX-3. |
| Approval | New approval required (part of the DX-3 package). | Same. | Same. |
| Test obligation | RG-4/RG-6/RG-8 (stash outcomes verbatim; read-count mechanics evolve per §14.15). | RG-10. | RG-8. |

**C6 — `apply()` never rejects (scoped plan-input normalization).**

| Field | Assessment |
| :--- | :--- |
| Requirement | The scoped fetch (519) moves inside the failure envelope; a scoped plan-input rejection resolves `{errors:[msg], scoped:[], …}` with the baseline retained. |
| Source evidence | Verified defect: `buildsession.ts:519` sits outside every try/catch while `apply()`'s own contract comment (385–387) promises "Never throws"; F10 — both hosts splice the batch before the await and fire the flush `void`-ed (`devsync.ts:195,202`; `watch.ts:82–101`), so the rejection silently abandons the batch and surfaces as an unhandled rejection. |
| Original UX-09 dependency | **Unrelated** to the original pre-filter (the flush path is untouched by filtering). |
| Package owner | Core. |
| Behavioral impact | Existing semantics changed: a rejecting scoped plan input now resolves instead of rejecting — aligning implementation with the documented contract. |
| Compatibility impact | No result-shape change; callers relying on the rejection would change behavior (none in-repo — both hosts treat it as a defect today). |
| Necessity | **SEPARATE_DEFECT** (verified contract violation, host-independent) **and** REQUIRED_PREREQUISITE of the §14 host rules (C7's guard/C10's result-driven rule both presuppose a non-rejecting `apply`). Narrower implementation cannot satisfy the original invariant *as §14 restates it* because a rejecting apply bypasses every result-driven rule by construction (F5). |
| Alternative | A minimal host-side rejection guard alone (catch, log, flag) — defensible as the narrow F10 fix, but leaves the engine violating its own contract. |
| Milestone | Independent engineering work (Core) — a UX-R0 exception requiring approval; recommended independently of DX-9. |
| Approval | New approval required. Status: **APPROVAL_REQUIRED** (DX-4). |
| Test obligation | RG-2/RG-3. |

**C7 — bounded failed-batch FIFO retry, backoff and resource bounds (both hosts).**

| Field | Assessment |
| :--- | :--- |
| Requirement | Rejection guard + session-identity checks; bounded FIFO queue (16 entries AND 256 retained deltas); single retry driver; 3-retry budget with 300/600/1200 ms backoff; sticky terminal state with recovery procedure. |
| Source evidence | F10 (verified: a rejected `apply` abandons the spliced batch on both hosts with no log, no requeue — an unhandled rejection). |
| Original UX-09 dependency | **None for filtering.** C7 is not intrinsically required for output pre-filtering — the shipped pre-filter never touches the flush path. It is a **consequence of the newly proposed recovery design**: §14 adopts "at-least-once delivery" for rejected batches, an ambition strictly beyond S1-original (which forbids silent loss *caused by watcher filtering*, not transient rejections of any batch). |
| Package owner | Hosts (extension `util/devsync.ts` + CLI `commands/watch.ts`). |
| Behavioral impact | New retry/re-delivery behavior and a new terminal state; shipped overlap semantics preserved. |
| Compatibility impact | No public API; host-internal. Cross-host behavior change (CLI watch gains a retry queue). |
| Necessity | The **underlying F10 defect is real** and deserves a narrow fix (rejection catch → error-level log naming the loss + recovery advice — the "no silent abandonment" minimum). The **full queue/backoff/budget design is OPTIONAL_HARDENING** relative to the original scope: it is required only by §14's S4/S6 reading (at-least-once + bounded resources + terminal semantics), not by UX-09. |
| Alternative | The narrow F10 fix above; or C7 as specified under the §14 approval. |
| Milestone | Deferred (§14 package); the narrow fix may proceed as independent work. |
| Approval | New approval required for the full design. Status: **PROPOSED** (DX-5). |
| Test obligation | RG-11/RG-12/RG-20/RG-26/RG-27/RG-28 (and RG-10's no-loop guard). |

**C8 / C9 — R0/R1 untouched; instance/session isolation.**

Not changes: they restate standing invariants (doc 11 §8.0 R0/R1; per-session getter isolation). Classification: **DIRECT_UX09-compatible preserved invariants** — APPROVED_EXISTING (already pinned by `cliStudio*`/`extUtilDevSync` suites); RG-14/RG-15 re-pin them under the §14 shapes.

**C10 — sticky `resyncRequired` / degraded state.**

| Field | Assessment |
| :--- | :--- |
| Requirement | A re-baseline-class apply resolving with non-empty `errors` sets a sticky degraded state; clears only on a proven whole-tree resync; one error naming failure + recovery. |
| Source evidence | F4/F13/F20: a failed rebuild can strand source work while the hosts treat the result as handled — verified today the extension logs result errors via `logger.warn` (`devsync.ts:231-233`), which is **channel-only** (doc 09 §5: warn produces no notification), and no state is kept. "Logged" is not "observable". |
| Original UX-09 dependency | **Indirect** — failure observability, not filtering. Required by §14 to make non-incorporating commits recoverable rather than silent. |
| Package owner | Hosts (extension flag; CLI log-only counterpart, §14.11.9). |
| Behavioral impact | New host state; no engine change. |
| Compatibility impact | Extension-internal; no API. |
| Necessity | REQUIRED_PREREQUISITE **of the §14 territory contract** (without it, decision-time drops after non-incorporating commits are silent — the S1 violation). As an independent hardening, the minimal form (route re-baseline-class failures through `logger.error` — the existing notification-producing path — plus the recovery advice) is defensible alone. |
| Alternative | Minimal error-routing hardening; or full C10 under §14. |
| Milestone | The persistent Development-section state ownership is **UX-R2 (CP-04) — deferred**; the minimal current-host contract is independent work. |
| Approval | New approval required for the §14 semantics; the minimal routing fix is an ordinary host hardening. Status: **PROPOSED** (minimal) / **DEFERRED** (persistent UI) — DX-6. |
| Test obligation | RG-17/RG-19/RG-21/RG-23; plus the §15.7 observability rule (assert the notification path, not only the flag). |

**C11 — scoped outdir migration promoted to full rebuild.**

| Field | Assessment |
| :--- | :--- |
| Requirement | In the scoped block, a fresh input whose normalized outdir differs from the committed baseline delegates to the full-rebuild envelope before assignment. |
| Source evidence | Verified defect: `buildsession.ts:519-537` commits the fresh input for the whole config (520) but re-syncs only the scoped mods (F21); F22 proves the scoped block is the only re-baseline site that can move the root without a full rebuild — so a root-moving scoped batch commits an **incomplete output root with zero errors** (the P0-D counterexample: second mod + `workshop.txt` absent, `errors: []`). Pre-existing, host-independent (`pzstudio watch` hits the same engine path). |
| Original UX-09 dependency | **Indirect** — not a filtering item; §14's territory contract needs "committed root is complete" to hold (C10's false-negative closure). |
| Package owner | Core. |
| Behavioral impact | Existing semantics changed: a root change arriving on a scoped trigger now pays a full rebuild instead of committing a broken root. |
| Compatibility impact | `SessionApplyResult` untouched; `fullRebuild === true` keeps its truthful meaning; stable-root scoped path byte-identical. |
| Necessity | **SEPARATE_DEFECT** (a committed, in-use output tree that is not a complete usable build, with no signal — a correctness defect on its own) **and** REQUIRED_PREREQUISITE of §14. Narrower alternative: the explicit root-change result/degraded contract — rejected in §14.7 with a deterministic counterexample (B3's A→B→A concealment) and a sound objection to B2 (the incomplete root stays in use until user action). |
| Alternative | As above; or fix nothing and document the incomplete-root window (not recommended — silent data-shape corruption). |
| Milestone | Independent engineering work (Core) — a UX-R0 exception requiring approval; recommended independently of DX-9. |
| Approval | New approval required. Status: **APPROVAL_REQUIRED** (DX-7). |
| Test obligation | RG-22/RG-23/RG-24/RG-25. |

**C12 — execution-time incremental-delete reconciliation.**

| Field | Assessment |
| :--- | :--- |
| Requirement | An incremental `delete` delta whose source path currently exists is applied as a change (live-source copy); absent source deletes as today. |
| Source evidence | Verified: `buildsession.ts:642-645` executes the delete by delta type without consulting the source; a stale delete after a newer create deletes output the source still has (P0-E counterexamples). |
| Original UX-09 dependency | **None for filtering.** Like C7, C12 is a **consequence of the proposed retry design**: the FIFO re-delivers stale deltas by rejection time, not source order, and §14.11.10 derives the reconciliation from exactly that ordering property. §14 further notes F19 leaves the fresh pipeline without an ordering guarantee, but no fresh-path counterexample was executed — the proven case is the retry queue's. |
| Package owner | Core. |
| Behavioral impact | Existing semantics changed (type-driven delete → reconcile-with-source); converges output toward current source state regardless of delivery order. |
| Compatibility impact | No result-shape change; the shipped pin "apply() creates and deletes files in the output" needs the §14.15 mechanics note (model the source deletion). |
| Necessity | REQUIRED_PREREQUISITE **of C7** (the queue is what re-delivers stale deltas). Without C7 it is OPTIONAL_HARDENING (defense-in-depth against F19's unordered delivery). |
| Alternative | Without C7: ship nothing; the fresh pipeline has no proven stale-delete case. |
| Milestone | Deferred — conditional on DX-5. |
| Approval | New approval required (Core behavior change). Status: **PROPOSED**, conditional (DX-8). |
| Test obligation | RG-26/RG-27 + the shipped-pin mechanics note. |

### 15.4 S1-original vs S1-relaxed; Contract A vs Contract B

**S1-original (normative, unchanged — the acceptance baseline of
record):** *No legitimate source mutation may be silently lost
indefinitely because of watcher filtering.*

**The fourth revision's counterexample violates S1-original.** Each link
is source-verified: outdir inside configured mod source (§3.1 case 6 —
valid, doctor-flagged); source mutation after the relevant build
traversal (F13's abort-on-first-failure bounds what a rebuild
incorporates; F14's live-tree read is traversal-ordered); watcher
callback delayed until after the outdir commit (F19 — delivery is
unordered relative to engine continuations); decision-time territory
filtering drops the event (the §14.8.6 rule); no build failure, no
diagnostic (the commit fully succeeded — outcome 5 of §14.13); no
guaranteed future rebuild (P0-F — every healing trigger is
user-action-dependent); potentially persistent unsynchronized output
(RG-29's residual, unbounded in time absent user action). The fourth
revision correctly withdrew the earlier "bounded by the next successful
full rebuild" claim; this record adopts that withdrawal: **the residual
is not bounded in time.**

**Contract A — strict source delivery/incorporation.**

- Current approved APIs **cannot** guarantee it: T3 (mutation
  provenance) is unprovable from `(type, path)` events (F19) — a
  decision-time filter cannot know what a delayed event meant.
- The §14.17 write-provenance mechanism (each apply reports written
  paths; the host delivers under-committed-root events that set did not
  write) is **directionally sufficient but not established**: it needs a
  new result-contract surface on the frozen engine, bounded per-apply
  host state, and still leaves the microscopic read→write race inside
  one file's copy (only content-comparison reconciliation closes that).
  It is a candidate for a future architecture decision, not a validated
  design — this record does not adopt it on §14's say-so.
- Remaining race cases even under provenance: the single-file
  read→write race above; provenance-set staleness across overlapping
  applies (the B3 counterexample class); and any future engine change
  that breaks the four-site assignment discipline (RG-6's guard).
- Approval path: a new API decision (result-contract surface), its own
  design pass, then implementation. Status: **BLOCKED** for this
  requirement pending that decision (DX-10).

**Contract B — decision-time committed-output territory.**

- Compatibility with the original invariant: for a **stable** root the
  drop set equals the shipped CLI watch's native exclusion and the
  accepted Q3 policy (continuity, F18) — the *original* UX-09 gates hold
  unchanged. The **new** semantic is retroactive capture of pre-commit
  mutations (decision-time ownership), and its cost is exactly the
  residual above. The exact relaxation: S1-original's "delivered or
  incorporated" becomes "delivered, or dropped under the documented
  territory contract, with every non-incorporating *failure* observable
  (C10) and no incomplete root silently committed (C11) — except the
  outcome-5 residual, which persists indefinitely absent user action."
- Effect on UX-09 acceptance: none on the shipped, original-scope gates
  (they pass at HEAD); the relaxation governs only whether the §14
  closure may *replace* S1-original in future acceptance language.
- Mitigation: doctor's `filesystem.outDirInsideProject` and user
  documentation mitigate the *layout* risk (case-6 exposure) but do
  **not** deliver or report the missed mutation — they cannot satisfy
  S1-original; they lower its probability surface only.
- **Classification: a product-policy change, not a technical
  correction.** Test expectations, CLI parity, architectural economy and
  the four §14 GO verdicts do not constitute owner consent.
  **Contract B is NOT approved; owner approval is recorded as pending
  (DX-9).** S1-original is retained as the acceptance baseline of record
  until the owner decides; it is not rewritten here into S1-relaxed.

### 15.5 S1–S6 status labels

| Invariant | Label | Basis |
| :--- | :--- | :--- |
| **S1** | **Unmet** in the strict original form (the outcome-5 residual — verified above); the relaxed reading is **Conditional on owner approval** (Contract B, DX-9). S1-original remains the baseline of record. | §15.4; §14.14; §14.17 (P0-F) |
| **S2** | **Proven under the original requirement** — no self-sustaining output loop; the shipped §6.3 policy provides the stable-root form, §14's getter extends it to decision-time completeness with bounded forwarding. | C2+T′; §14.8.4; shipped B.12 |
| **S3** | **Conditional on an implementation mechanism** — the getter (C1); the shipped policy's baseline alignment is heuristic (fresh reads) by construction. | §14.2; F9 |
| **S4** | **Conditional on an implementation mechanism** (C7's dual bounds, C11's single-promotion) — and **Outside original UX-09 scope** (the retry machinery is not a filtering concern). | §14.11; §14.10 |
| **S5** | **Conditional on an implementation mechanism** (identity guards) — **Outside original UX-09 scope**. | §14.11.1/8; F6 |
| **S6** | **Conditional on owner approval and on an implementation mechanism** — C10's semantics are §14 work (DX-6/DX-9); **Unmet today**: re-baseline-class failures surface as channel-only warnings with no state and no notification (verified: `devsync.ts:231-233` logs via `logger.warn`; doc 09 §5 maps `warn` to a channel line only). | §14.13; §15.7 |

### 15.6 RG-1…RG-29 classification; the stash

The Q3 §10 matrices (A/B/C) are the **original UX-09 acceptance gates**
— implemented and green at HEAD (shipped `8967ada`); they are not part
of the RG matrix. The RG rows are implementation-stage specifications
for §14 and classify as:

- **Required for original UX-09 safety closure:** none as *new* gates —
  the original closure is complete; RG-9 and RG-13 re-pin properties the
  shipped contract already relies on (loop protection; F7
  success-scoped healing) and become mandatory only if §14 is approved.
- **Required for separately approved Core prerequisites:** RG-1 (C1);
  RG-2/RG-3 (C6); RG-22/RG-23/RG-24/RG-25 (C11); RG-6 also guards the
  assignment discipline once C1 lands.
- **Required for proposed recovery hardening (§14 as a package):**
  RG-10, RG-11, RG-12, RG-14, RG-17, RG-18, RG-19, RG-20, RG-21,
  RG-26, RG-27, RG-28.
- **Product-policy characterization tests (require Contract B owner
  approval before their assertions may be treated as acceptance):**
  RG-16 (territory drop as lossless here) and RG-29 (pins the §14.17
  residual verbatim, including the S1 relaxation).
- **Deferred / unnecessary for the minimal scope:** RG-4, RG-5, RG-7,
  RG-8, RG-15 (the §14 policy-adoption and compatibility rows — required
  only under DX-3's approval; their subject matter is otherwise covered
  by the shipped B-series pins).

**The stash (A1/B1/C1).** Identified by its message ("UX-09 red-first
regression tests (A/B/C silent source-event loss, proven at 8967ada) -
blocked on session-root contract"; verified present at this HEAD,
inspected read-only, never applied/popped/dropped). Status: **read-only
regression evidence**, preserved verbatim — its assertions are not
altered by this pass and its RED verdicts against the shipped §6.3
policy are the empirical proof behind §15.4. Its *mechanics*
(`resolveSpy` counts, `filterRoot` introspection) encode the §6.3
implementation, so applying it under the §14 contract requires exactly
the §14.15 mechanics evolution — permitted only after DX-3/DX-9 are
decided. If a regression gate depends on Contract B (RG-16, RG-29, and
the A1 control's territory reading), it is labeled above as requiring
owner approval.

### 15.7 UX-R2 boundary and the minimum current-host observability contract

The persistent Development Sync UI — phase/owner/last-sync rows, the
Needs-attention presentation, `resyncRequired` as a surfaced state —
belongs to UX-R2 (CP-04, spec §6). No §14 item may pull it forward: no
new persistent state service, tree hierarchy, status UI, command, or
manifest contribution belongs in any UX-09 work. **An internal flag is
not proof of observability.** The minimum current-host contract, if
degraded-state reporting is approved in minimal form (DX-6), is:

1. **Internal bookkeeping** — a controller field is permitted but counts
   for nothing user-facing.
2. **User-visible reporting in the existing UX-R0 surface** — route the
   degraded condition through `logger.error` (the existing
   notification-producing path, doc 09 §5) with one message naming the
   failure and the recovery (restart DevSync or run `pzstudio build`).
   Today's `logger.warn` routing (`devsync.ts:231-233`) is
   channel-only and does not meet this bar.
3. **Persistent state ownership** — UX-R2 only.

**Host-capability distinction (no cross-host equivalence claimed).**
The CLI watch's native parcel `ignore` and its filter root are both
start-frozen (`watch.ts:57,124,142-148`) — a static exclusion, not a
live committed-baseline filter. The shipped extension policy adds
correction reads; the proposed §14 policy reads the committed root per
event. These are three different filtering lifecycles; C7 is specified
for both hosts, C10's sticky state is extension-only (the CLI
counterpart is log-only, §14.11.9). No claim that CLI watch matches the
extension's filtering lifecycle is made anywhere in this document, and
none may be inferred from it.

### 15.8 Approval decision table

| Decision ID | Proposal | Original scope compatibility | Technical recommendation | Owner approval required | Current status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| DX-1 | Shipped Q3: `studio.resolveOutDir` + §6.3 policy + §10 matrices | The accepted Q3 decision, shipped `8967ada` | Keep as the contract of record for UX-09 | No — already accepted | APPROVED_EXISTING |
| DX-2 | C1 Core committed-baseline getter | Outside UX-R0 (Core API) | Approve only as the §14 prerequisite, not as UX-09 work | Yes (v2/Core surface exception) | PROPOSED |
| DX-3 | C2–C5 extension policy adoption (live getter filter; correction machinery deleted) | Supersedes accepted §6.3 behavior | Approve only as a package with DX-2 and the territory decision DX-9 | Yes (changes accepted behavior) | PROPOSED |
| DX-4 | C6 `apply()` normalization | Independent of UX-09; verified contract violation | Approve as standalone Core correctness work | Yes (Core change) | APPROVAL_REQUIRED |
| DX-5 | C7 bounded failed-batch FIFO retry (both hosts) | Beyond the original invariant; consequence of the §14 recovery design | The narrow F10 fix (guard + error log) is defensible independently; the full design only with DX-9 | Yes (cross-host behavior change) | PROPOSED |
| DX-6 | C10 sticky `resyncRequired` | Not required by original UX-09 | Minimal form (error-level routing + recovery text) approvable alone; persistent state is UX-R2 | Yes for the §14 semantics; UI part deferred | PROPOSED (minimal) / DEFERRED (UX-R2 UI) |
| DX-7 | C11 scoped root-move promotion to full rebuild | Independent of UX-09; verified incomplete-root defect | Approve as standalone Core correctness work | Yes (Core change) | APPROVAL_REQUIRED |
| DX-8 | C12 execution-time delete reconciliation | Consequence of C7's retry ordering, not of filtering | Approve only with DX-5; optional hardening otherwise | Yes (Core behavior change) | PROPOSED (conditional on DX-5) |
| DX-9 | Contract B — decision-time committed-output territory (the S1 relaxation) | Product-policy change; relaxes S1-original | Owner decision; DX-3/DX-5/DX-8 and the §14 reading of DX-6 are meaningful only under it | **Yes — explicit product-owner approval**; prior GO reports, test expectations and CLI parity do not consent | BLOCKED (pending owner decision) |
| DX-10 | Contract A — strict per-event delivery/incorporation via write provenance | Matches S1-original intent | Not achievable on approved APIs; the §14.17 sketch is unproven to implementation depth and needs its own API decision | Yes (new API decision) | BLOCKED (missing capability) |
| DX-11 | Apply the UX-09 stash (A1/B1/C1) as regression tests | Red-first evidence at `8967ada` | Preserve read-only; apply only after DX-3/DX-9 with the §14.15 mechanics evolution | Yes (part of DX-3's approval) | DEFERRED |
| DX-12 | Declare UX-09 complete | Original acceptance = shipped Q3 §10 matrices + dot/parity gates (green at HEAD); strict-S1 closure is a separate question | Record UX-09 as shipped with named residuals; full closure gated on DX-9/DX-10 | No for the original scope; strict closure gated on DX-9 | APPROVED_EXISTING (original scope) |

### 15.9 Answers to the six scope questions

1. **What can be implemented using already-approved requirements?**
   Nothing further on the DevSync safety path. The approved, shipped
   contract (DX-1) is complete as implemented; this governance pass
   authorizes no code.
2. **Which Core/API changes require a separate explicit exception to
   UX-R0?** C1 (DX-2), C6 (DX-4), C11 (DX-7), C12 (DX-8) — Core — and
   C7's `commands/watch.ts` guard (DX-5) — CLI. None may ride a UX-09
   implementation commit.
3. **Which improvements should be independent engineering work?** C6
   (DX-4) and C11 (DX-7) as standalone Core correctness fixes; the
   narrow F10 rejection-guard fix (a subset of DX-5); the minimal C10
   error-routing hardening (DX-6 minimal). Each still needs its own
   approval because UX-R0 is extension-only — but each is decidable
   without the territory decision.
4. **What is blocked solely by the S1 product-policy decision (DX-9)?**
   The successor filter policy (C2–C5/DX-3), the retry package as
   designed (C7+C12/DX-5+DX-8 in their §14 forms), C10's sticky-state
   semantics as specified, the RG-16/RG-29 characterization gates, and
   the stash application (DX-11).
5. **Which regressions must pass before declaring UX-09 complete?**
   The original scope is already met: the Q3 §10 matrices A/B/C and the
   dot-segment/parity gates are green at HEAD (DX-12). Strict-S1
   closure is a separate, owner-gated question: under Contract B it
   would require the RG matrix per §15.6's classification with the
   stash outcomes verbatim; under Contract A it first requires the
   provenance architecture (DX-10).
6. **What remains deferred to UX-R2?** Persistent Development Sync
   state ownership (CP-04), any user-visible `resyncRequired`
   presentation, structured session status (CP-12), and the
   multi-project sync UX (UX-15). None of it may be pulled forward by
   a UX-09 commit.

### 15.10 Reconciliation verification

- [x] Preflight verified at `80c80fe`: branch `42.20.0-dev`, HEAD
  matches, clean tree; the UX-09 stash located by message and inspected
  read-only (never applied, never popped).
- [x] The shipped Q3 contract re-verified in source (`studio.ts:148,282`;
  controller §6.3 shape; Q3 §10 tests present); §14's load-bearing F-facts
  spot-verified (F2/F4/F5/F10/F20/F21/F22; C1's absence; the C12 delete
  site) — no drift found requiring §14 corrections.
- [x] Docs-only change: no production source, test, manifest or
  dependency touched; §1–§14 preserved verbatim; the only edits are this
  section and the companion pointer notes.
- [x] Naming: historical "Q4 DevSync" labels preserved; matrix Q4
  (missing-mod) untouched; current name = UX-09 DevSync Baseline Safety
  Contract.
- [x] Cross-document status consistency: matrix Q3/Q4 notes and the
  matrix's reconciliation addendum point here; no document marks
  Contract B approved, S1-original satisfied, or §14 implementation
  authorized.

> **Follow-up record (pointer).** The Contract A feasibility investigation
> that DX-10 was gated on is complete and lives in
> [`14-ux09-strict-s1-feasibility.md`](14-ux09-strict-s1-feasibility.md):
> deterministic real-engine experiments at `3246eb8` (A1/B1/C1 re-proven
> red; RG-29, the read→write race, collision, echo-boundedness, loop and
> reconciliation-fixed-point gates), the §14.17 written-path proposal
> adjudicated scenario by scenario (necessary, not sufficient), candidate
> comparison A–D, and the verdict `FEASIBLE_WITH_PROOF_OBLIGATIONS` with
> the exact owner decisions named (DX-13, the DX-9 drop-set reversal, on
> top of DX-2, plus the new engine fact F23 — listing-order-dependent
> `copyTree` self-embedding — filed as a sibling defect). Nothing in that
> record authorizes implementation; this §15 approval table remains the
> decision authority.
