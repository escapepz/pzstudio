# 15 — E1 Output Adoption Safety: Source Ownership and Non-Destructive Adoption

**Status: technical decision record (design + verification). Documentation-only;
nothing here authorizes implementation, approves the E1 exclusion of doc 14 §2,
or declares strict S1 satisfied.**

Written at HEAD `47abe28aeab4200fdf23fe0b5c93836c305bae47` (branch
`42.20.0-dev`, tree clean). The UX-09 regression stash was identified by its
descriptive message ("UX-09 red-first regression tests (A/B/C silent
source-event loss, proven at 8967ada) - blocked on session-root contract",
`stash@{0}`) and left untouched throughout: never applied, never popped,
never dropped, never renamed. No production source, test, manifest or
dependency was modified for this record. Every behavioral claim below was
executed as a deterministic, budgeted experiment against the unmodified real
engine (Core `BuildSession` / `planBuild` / `executeFileOperations` on a
gated memory filesystem; the CLI executor additionally against a real
temporary filesystem through the real `executeBuildPlan`), then the
disposable experiment files were deleted before this commit.

---

## 1. The accepted source-ownership contract (baseline of record)

The accepted model separates five content classes at the times that matter
(doc 13 §3.1, doc 14 §2, doc 14 §16.1 — all preserved verbatim here):

1. **Legitimate source at mutation time.** A create/change/delete at `P` is
   legitimate source iff `classifyDelta({type, P}, committedPlanInput)`
   returns a non-`ignore` classification (buildsession.ts:129–223). The
   classifier has **no outdir rule**: at mutation time, a file inside a
   *future* variant destination (a folder the engine has not adopted yet)
   classifies as `{ kind: 'mod-file' }` — in a case-6 layout (outdir inside
   a configured mod folder; a supported, doctor-flagged configuration, doc 13
   §3.1 case 6) this is the accepted semantics of record.
2. **Previously generated output owned by the engine.** Content the engine
   wrote into a variant folder of the *committed* output root. Rebuilding
   over it is the engine's contract (E1-E below); it is not a loss.
3. **Pre-existing destination content with unknown ownership.** Anything
   found inside a destination root the engine has not provably built itself.
   Today the engine treats it as deletable — this document's subject.
4. **A future output destination selected by a configuration change.** The
   *future* variant folders (`<outdir>/<sanitized title>` and
   `<outdir>/<sanitized title> - dev_branch`, `resolveBuildOutputPath`,
   buildplan.ts:119–129) of an output root a pending structural change will
   adopt. Nothing in the engine, doctor or classifier reserves these paths.
5. **Earlier-build output versus user-modified output.** A file the engine
   generated in an earlier build that the user subsequently modified sits in
   both ownership classes at once: the engine owns the write, the user owns
   the modification. The accepted engine semantics regenerate generated
   files on rebuild (E1-E below — silent overwrite of a modified
   `workshop.txt`), which is legitimate engine-owned territory; the same
   cannot be said for content the engine never wrote.

**Boundary statements this document is bound to (unchanged from the record):**

- Do not retroactively classify a user file as generated merely because the
  engine later selects its parent folder as a destination (doc 14 §16.1: at
  mutation time the file IS legitimate source under the accepted contract).
- A doctor warning is not an authorization to delete source content. The
  case-6 layout (outdir inside a configured mod folder) remains a valid,
  doctor-flagged configuration (doctor `filesystem.outDirInsideProject`,
  packages/core/src/doctor.ts:291–294 — advisory, not a gate).
- Doc 14 §2's E1 exclusion (variant-folder destinations removed from the
  legitimate-source set) is **not approved** as a change to legitimate-source
  semantics; §16.1 of doc 14 records exactly why owner approval is owed and
  why approving it would not prevent the destruction.
- The accepted ownership boundary does not retroactively classify user files
  as engine output merely because a later configuration change selects their
  parent folder as a destination.

## 2. The destructive mechanism, exactly

The destruction is a property of the engine's own build semantics, shared by
every host and independent of DevSync:

- `planBuild` opens each variant's plan with
  `{ type: 'removeDir', path: outPath }` where
  `outPath = joinPosix(config.outdir!, sanitizeFolderName(title [+ ' - dev_branch']))`
  (buildplan.ts:338–342). `planScopedModRebuild` does the same per mod
  folder (buildsession.ts:253).
- `executeFileOperations` executes it as
  `fs.delete(operation.path, { recursive: true })` (execute.ts:348–360);
  the CLI's `executeBuildPlan` calls `removeDirRecursive` (rmSync recursive
  + force; helper.ts:243–266). Neither checks *what* is being deleted: any
  pre-existing content inside the variant folder is removed, regardless of
  provenance, with no ownership proof, no capture, no report — an ordinary
  successful `removeDir` in the plan.
- A full rebuild that adopts a new output root therefore deletes whatever
  exists inside the future variant folders at adoption time. A user file
  placed there before the adoption is destroyed with `errors: []`, no
  diagnostic, and no recovery path (reproduced: §3, E1-A/B/C).

The mechanism is *pre-adoption destruction*: the file never reaches the
engine as actionable content, and nothing afterward (filtering, provenance,
reconciliation) can incorporate what the engine destroyed — the boundary
doc 14 §16.1 proves and labels E1. What this document adds is the
mechanism-level reproduction set and the Core/CLI split.

## 3. Reproductions (E1-A … E1-G)

**Method.** Disposable suite `tests/unit/e1-adoption-destruction.test.ts`
plus harness `tests/helpers/e1-adoption-harness.ts` (both deleted before the
commit; the results are recorded here verbatim). Harness: the real
`BuildSession` / `planBuild` / `executeFileOperations` on a gated memory
filesystem (alphabetical/insertion/reverse listing order, write/list budgets,
complete write and delete logs, an *effective*-delete log that distinguishes
deletions that actually removed content), plus a case-insensitive,
case-preserving fs emulation (NTFS semantics: first-seen casing wins,
lookups fold case, `list` reports stored casing). The CLI executor was
driven through the real `executeBuildPlan` on a real temporary directory.
No real user directory was ever touched. Fixture: project `/proj`, mod
`my_mod` (`media/lua/hello.lua`), case-6 roots `<mod>/gen-a` / `<mod>/gen-b`
inside the mod source folder; titles produce variant folders
`Sync Project` / `Sync Project - dev_branch`.

| # | Scenario | Result at `47abe28` |
| :--- | :--- | :--- |
| E1-A | Legitimate file inside a *future* variant destination (`<root-B>/Sync Project/Contents/mods/my_mod/extra.lua`) before root adoption | File exists on disk; the classifier has no outdir rule, so it is ordinary case-6 source by the accepted contract |
| E1-B | Its create event delivered *before* adoption | Delivered successfully: classified `mod-file`, applied incrementally as a *nested copy under the old root A* (`<root-A>/…/my_mod/gen-b/…` — bounded garbage abandoned with A); the original file remains intact; `errors: []` |
| E1-C | Full rebuild adopts root B | `fullRebuild: true`, **`errors: []`**; the file is gone; the delete log is exactly the two adopted variant folders' `removeDir` (plus mkdir sentinels). Silent. Identical to doc 14 G1-A |
| E1-D | Existing engine-generated destination rebuilt (same root, title change) | Normal rebuild semantics: variant folders removed and rewritten, no preflight failure, no error — the legitimate engine-owned half that any fix must preserve |
| E1-E | User modifies an engine-generated file (`workshop.txt`) before the next rebuild | The modification is overwritten by the rebuild, silently — accepted engine-owned semantics (the user edited an output copy); distinct from E1-A where the content was *never* engine-written |
| E1-F | Title change with illegal characters (`Sync: Project?`) | Sanitized variant names (`Sync_ Project_`, `Sync_ Project_ - dev_branch`) are the exact destruction targets: a pre-placed file under the sanitized name is destroyed silently; a **near-miss** folder (`Sync_ Project`) is untouched — the removal targets are exactly `sanitizeFolderName(title)`-derived, segment-exact |
| E1-G | Root A→B→A with stale generated folders | Stale trees survive byte-for-byte on both migrations and are consumed as source (the F23-fix preservation policy); the future-variant victim is destroyed silently; the re-adopted root's own variant folder is rebuilt normally (`removeDir` + rebuild) |

Before/after tree assertion for E1-C: the only disappearance is the victim
file under the adopted variant folder; the delete log is exactly the
`removeDir` targets. The event in E1-B was **successfully delivered and
acted on** before adoption (the G1-B refinement: delivery does not save
content) — the destruction is exclusively `planBuild`'s
`removeDir(outPath)` at execution time.

## 4. Core versus CLI execution coverage

The two executors are **not** the same code, and in the E1 flow they are
not even the same failure mode:

| Aspect | Core `executeFileOperations` (BuildSession, `pzstudio watch`, extension DevSync) | CLI `pzstudio build` (`executeBuildPlan`) |
| :--- | :--- | :--- |
| Deletion | `fs.delete(path, { recursive: true })` through the injected `ProjectFileSystem` (execute.ts:348–360); lock errors rethrown with the actionable message | `removeDirRecursive` — `rmSync(recursive, force, 5 retries × 200 ms)` (helper.ts:243–266) |
| Copy | `copyTree` in `execute.ts` with the F23 destination-subtree exclusion (`segmentsBelow`/`isInsideDestination`, execute.ts:271–304) | `scaffoldProject` → `readdirSync` + `cpSync(recursive, filter)` (templateManager.ts:766–820): **no destination exclusion — the F23 fix never reached the CLI executor** |
| E1 adoption outcome (reproduced) | Silent: victim destroyed by `removeDir`, `errors: []`, bounded garbage embedding completes | `cpSync` throws `Cannot copy <root-B> to a subdirectory of self <root-B>\Sync Project\Contents\mods\my_mod\gen-b` — the build **fails noisily mid-way** (after `removeDir` already destroyed the victim), leaving a truncated output |
| Case-6 adoption with a stale sibling root | Bounded under the F23 fix (destination exclusion) | **Unbounded recursion still possible** — the F23 fix never reached this executor; under `cpSync`'s live traversal the same self-embedding fuel exists, and Node's self-copy guard aborts it as an error |

Consequences for the mechanism design: (a) any ownership/preflight
mechanism must be specified twice — once for the Core executor's
`ProjectFileSystem` contract and once for the CLI's synchronous executor —
or the mechanism must be **hoisted into the planner** (plan-level ownership
data both executors can act on); (b) the CLI currently fails case-6 adoption
loudly with a confusing self-copy error *after* destroying the victim —
so the CLI does not even reproduce E1's *silent* form; it produces a
different, equally destructive but louder failure (recorded as CLI-side F23
exposure, §7).

## 5. Ownership-safe mechanism candidates

Each candidate is analyzed against the six decision criteria (brief §6) and
— mandatorily — its **check-to-delete race**: a decision made from a
filesystem observation, executed by a later deletion, is TOCTOU-broken if
another process can modify the destination between the two. The session
queue serializes applies *within* the session; it does not serialize the
game, Steam, Explorer, antivirus or the user, and no host filesystem
provides transactions that would eliminate the window (doc 14 §9.4).

### Candidate A — fail-closed preflight

Before destructive planning or execution, refuse adoption when the
destination contains content that cannot be proven engine-owned.

- **Proof problem.** With no ownership metadata (Candidate B) and no
  prior-build knowledge of the adopted root, "provable" can only mean
  *derived*: the engine would have to recompute the expected output tree of
  the new plan and compare. For a first adoption there is no previous plan
  for that root — the derivable expected set exists only *for the new
  plan*, and matching the *old* content against the *new* plan proves
  nothing about who wrote the old content. Every pre-existing file is
  therefore unprovable, and the refusal is total: the first adoption of any
  non-empty root fails.
- **False-failure analysis.** Legitimate rebuilds of a committed root are
  provable *by the session state* (the committed baseline names the root the
  engine built). But the two legitimate case-6 flows fail: (i) adopting a
  root that contains an *older PZ Studio build* (CLI-built, or built by a
  previous session — no session state carries over) is refused although the
  content is genuinely stale engine output; (ii) the `pzstudio build`
  command has no session at all — there is no committed baseline to compare
  against, so every build of a non-empty existing root fails. This breaks
  E1-D (normal rebuild) unless "same root as last build" is knowable —
  which it is not for a fresh CLI process.
- **Check-to-delete race.** A preflight scan (list the destination) followed
  by the plan's `removeDir` has an unbounded window — the plan is computed
  before execution, and the two variant deletions are separated by the
  whole main-variant build. A file created in the window is destroyed. A
  preflight alone is **not a complete proof** — it converts the destruction
  from "always" to "unless you were unlucky", which is still silent
  destruction.
- **Verdict: rejected as a standalone mechanism.** Fail-closed is the right
  *failure posture* (explicit, actionable, no silent loss) but cannot be
  the whole mechanism: it false-fails legitimate rebuilds (E1-D shapes with
  no session state) and its race still destroys content. Retained as a
  component of the hybrid (§6).

### Candidate B — explicit output ownership metadata

The engine records which files or directories it owns and may safely
replace (e.g., a sentinel file or manifest inside each variant folder; a
marker at the output root; content hashes of generated files).

- **What it solves.** A `removeDir` whose target carries the engine's
  current marker is provably engine-built; deletion proceeds. An adopted
  root without the marker contains unproven content → fail-closed or
  quarantine. This is the only mechanism that turns "unknown" into
  "provable" *for later* builds — it is the only candidate that can prove
  ownership across sessions (a rebuilt CLI process has no memory except
  what the filesystem preserves).
- **Legacy outputs.** Every existing output tree has no marker: the first
  rebuild after shipping this mechanism fails closed everywhere (all
  existing users' rebuilds break) unless the marker is introduced with a
  migration path — and a migration that *adopts* unproven trees once
  re-opens exactly the hole being closed. A structural proof ("the tree
  matches what the planner would generate for the current plan input")
  is false-failure-prone: any user modification of generated output (E1-E)
  breaks the match, and case-6 variant-folder content is simultaneously
  source — the match test cannot distinguish "user's stale build" from
  "user's modified source" without re-running the classification this
  whole exercise shows is ambiguous.
- **Marker corruption/interruption.** A crashed build (F4) leaves a
  truncated variant tree; with a marker written first, the truncated tree
  is marked owned (acceptable — engine territory); with the marker written
  last, a crash before the marker makes the engine's own output unprovable
  (false failure on the next rebuild). Both need explicit semantics.
- **Ships-to-workshop pollution.** A marker file inside a variant folder
  ships in the workshop output unless the planner excludes it — a new
  reserved filename in the output contract, and the game/workshop upload
  semantics gain an unknown file (workshop.txt parsing is strict; unknown
  files in the workshop root are at best noise, at worst uploaded).
- **Check-to-delete race.** Marker verified → user/another process removes
  the marker and drops files → engine deletes. The race persists; the
  marker reduces the *probable* loss surface, it does not close the window.
- **Verdict: rejected as a complete mechanism** (legacy trees, marker
  lifecycle, output pollution, and it still does not close the race). A
  marker is at best one *evidence input* to a larger mechanism.

### Candidate C — non-destructive source preservation

Before replacing a destination, preserve or relocate the content that cannot
be proven engine-owned.

- **What it solves.** The only candidate that never destroys: content is
  moved aside before the variant folder is replaced, and the user is told
  where it went. Combined with a provable-ownership test it produces zero
  silent destruction by construction.
- **Semantic correctness.** "Preserve" must not mean "incorporate": the
  file already classifies as source at that path (case-6), and EXP-3b/G1-C
  shows outdir files outside variant folders are incorporated by the
  live-tree read — preservation here means *rescue from deletion*, not
  duplication into the build. Relocated content must not be re-copied into
  the new output (it would double-incorporate legitimate source and embed
  garbage); the rescue location must therefore be **invisible to both the
  walk and the classifier** — a dot-prefixed path is, by both existing
  rules (`ignoreDotFiles` in copyTree; the dot-entry rule in
  `classifyDelta`).
- **Conflicts and rollback.** Relocation to a dot-prefixed quarantine
  inside the output root (e.g. `<outdir>/.pzstudio-rescue/<ts>-<variant>/`)
  collides with nothing: dot-prefixed entries are excluded from mod copyTree
  walks and from classification, so quarantine cannot self-feed (S2).
  Crash safety: copy-then-delete (the only form available on today's
  `ProjectFileSystem`, which has **no rename/move** — platform/src/index.ts)
  is loss-safe only in the direction "original survives a partial copy";
  the final delete of the original must be gated on a completeness check
  (file count/size manifest), else a crash between copy and delete with a
  partial copy loses the tail. Rename is atomic (same device — the variant
  folder and its quarantine live under the same output root) but needs a
  new capability (§8).
- **Unbounded copying.** Quarantine copies the *pre-existing* content, which
  is finite on disk but unbounded in principle (the user's own folder could
  be gigabytes). It is a one-time cost per adoption of an unproven
  destination — bounded by the data being rescued, not recursive (the
  quarantine is dot-prefixed, so no copyTree can re-enter it; S2 holds).
- **Verdict: correct in kind, rejected in isolation** — applied blindly it
  quarantines every stale engine output on every adoption (the ownership
  proof is still needed to avoid relocating the engine's own legitimate
  output), and on its own it does not answer the check-to-delete race
  (§5-A) unless the capture happens by *rename before* the delete.

### Candidate D — narrow hybrid (preflight + capture-then-remove)

The minimum composition: **provable-ownership preflight whose failure mode
is capture-then-adopt (never silent delete)**. §6 specifies it; here only
the race-closure argument: the scan-then-delete TOCTOU is structural for
any decide-then-delete mechanism (A and B keep the window; only the
*consequence* changes). Capture-then-remove converts the window from
"data loss" to "content was quarantined one step before the build claimed
the folder" — the race becomes a reporting problem (the file may be
quarantined rather than incorporated), not a destruction. The residual
window (file created between the capture and the rebuild's `makeDir`) is
the ordinary concurrent-write race the §16.2 cadence bound already prices;
it cannot be eliminated on any host filesystem without transactions
(doc 14 §9.4).

## 6. Preferred safe mechanism: capture-then-adopt with provable-ownership preflight

**Established, with named residual obligations — an owner decision is
required before implementation (§11).** The narrowest mechanism that meets
the criteria:

**M1 — Ownership proof rule (decide before planning).** For each
`removeDir(outPath)` the plan is about to execute, the engine classifies the
target as:

- **provably engine-owned**: the target subtree is inside the variant
  folder of the *committed* output root of the same session (the session's
  committed plan input names exactly these roots — buildsession.ts:339,
  the field doc 13 C1/DX-2 proposes to expose), or
- **provably empty**, or
- **unproven**: everything else — including every first adoption, every
  cross-session rebuild of an old output tree, and every CLI build of a
  pre-existing root.

**M2 — Capture-then-adopt for unproven targets.** An unproven non-empty
destination is not deleted silently. The engine moves it aside —
`<outdir>/.pzstudio-rescue/<UTC-timestamp>-<folderName>/` (dot-prefixed:
invisible to `copyTree`'s `ignoreDotFiles` and to `classifyDelta`'s
dot-entry rule, so no re-embedding and no classification feedback) — and
the rebuild proceeds. The operation result (and the CLI stderr) names the
rescue path and the count of rescued files: explicit, actionable, no
silent loss, no refusal of a legitimate build. Deletion of the *captured*
subtree is then safe by construction; the completeness gate applies only
in the copy-then-delete form (rename form is atomic).

**M3 — Same-root rebuilds keep today's semantics.** A committed root
rebuild (E1-D) and the user-modification overwrite (E1-E) proceed exactly
as today: content inside a committed variant folder is engine territory by
the accepted semantics (doc 14 §16.1 plan-resolution-time claim). No
quarantine noise, no false failures.

**M4 — Failure semantics.** A rescue that cannot complete (lock errors,
cross-device failure, quota) fails the build with the existing actionable
lock-error wording plus the reason (unproven content inside the variant
destination); the destination is left untouched (fail-closed, never
partial-destruct). The rescue folder and its retention are user-inspectable
and doctor-visible; cleanup is a user action (the engine never deletes
quarantined content).

**Race-closure summary (per candidate):** A's scan-then-delete window and
B's verify-then-delete window both end in destruction; M2's
scan-then-*capture* ends in preservation, and the capture itself is a
single atomic step in the rename form (or manifest-verified copy in the
copy form) — the remaining post-capture window writes into the *new* build
territory, which is the priced §16.2 race, not a destruction.

**Why not smaller:** a bare preflight (A) false-fails legitimate flows and
still races; a marker alone (B) cannot bootstrap legacy trees and still
deletes in the race; pure preservation (C) without the proof rule
quarantines the engine's own legitimate output on every adoption. No
smaller mechanism satisfies "never silently destroy unowned content"
without breaking E1-D; nothing larger (registry, migration framework) is
needed either — M1 needs no new registry, M2 no new public API beyond what
§8 lists, and no migration framework: legacy trees are simply *unproven*
and get the rescue path on their first re-adoption.

**Compatibility with frozen API-v2 boundaries.** M1/M2 live inside the
planner/executor contract (`FileOperation` gains no type; the executor's
`removeDir` case gains the preflight-capture behavior). No public API
signature changes. If the rename form is chosen, the delta is a new
**optional** capability flag + method on the `ProjectFileSystem` contract
(§8) — an API-v2 exception requiring its own approval, same gate as every
DX item in doc 13 §15.8.

## 7. F23 integration boundary (fix `47abe28`, focused source review)

The F23 fix excludes the operation's own destination subtree from the
`copyTree` walk (execute.ts:271–304): `segmentsBelow` computes the
destination chain segment-wise (drive prefix case-insensitive, everything
else case-sensitive), and the walk skips entries whose walk-relative path
matches that chain. Verified boundary properties:

- **Does not mask E1.** The exclusion affects only *which source entries
  are copied*; it never touches `removeDir`. E1-C above reproduces
  identically post-fix (the deletion is `removeDir`'s, before any walk).
  The F23-R5 gate (tests/unit/copytree-destination-exclusion.test.ts:668)
  pins the same boundary. The preservation policy (stale roots and
  non-variant outdir files are still copied) is intact (E1-G).
- **Path-segment containment** is segment-exact (no string-prefix false
  matches — the `outRel + sep` hazard of doc 13 §3.1 case 5 does not
  exist here); only a Windows drive prefix compares case-insensitively.
- **Same-path and alias-path behavior — one new demonstrable escape
  (blocker):** the containment is evaluated against the *plan's path
  spelling*, while the walk consumes *on-disk names* from `fs.list`. On a
  case-insensitive filesystem (NTFS default; macOS default), a destination
  chain whose spelling differs in case from the stored names — concretely:
  a **title case change** (`sync project` built earlier, config now says
  `Sync Project`) — makes every comparison miss: the walk re-enters the
  destination it is writing. Executed result (NTFS-emulating memory fs):
  the case-exact flow is bounded as documented (≤ 2 generations), but the
  case-variant flow produced **nesting depth 6** under alphabetical
  listing (vs ≤ 2) and **tripped a 400-write budget — unbounded
  recursion — under insertion-order listing** in the adoption flow. This
  voids the fix's own docstring claim ("a pre-existing case-variant twin
  … could contribute at most one bounded generation"). Filed as a **new
  F23 blocker (F23-E1a)**: the containment comparison must resolve case
  (or the exclusion must be spelling-independent) before any case-6
  reliability claim holds. Not fixed here, per the brief.
- **Symlink traversal.** The walk dereferences symlinks (`resolveEntryType`,
  execute.ts:306–320) and descends by the *link's own* name; a link inside
  the source that resolves into the destination subtree (or a cycle) is
  entered under a name the containment check does not recognize. Not
  executed (memory-fs symlinks unavailable); recorded as a source-review
  finding in the same blocker class — containment must hold on the
  *resolved* path, not the walk-relative name.
- **Core/CLI executor difference:** the CLI executor has no exclusion at
  all (§4) — its F23 exposure in the adoption flow is bounded only by
  Node `cpSync`'s self-copy guard aborting the build with an error
  (reproduced), which is an accidental tripwire, not a fix.

No F23 *refactor* is proposed here; the escape is reported as a separate
blocker exactly as the brief requires.

## 8. New Core/API decisions, if unavoidable

| Item | Surface | Why it cannot be avoided | Approval gate |
| :--- | :--- | :--- | :--- |
| Rename/move capability | `ProjectFileSystem.move(from, to)` (or `rename`) + `PlatformCapabilities.rename` | Copy-then-delete quarantine is implementable without it but is only manifest-verified-safe (completeness check before the final delete); rename is atomic, crash-safe, and closes the capture race cleanly. Without it the mechanism falls back to copy+verify+delete | New v2/Core surface exception (same class as DX-2/DX-13; frozen-API decision) |
| Planner-level ownership data | A `FileOperation` payload field (e.g., `ownership: 'proven' \| 'unproven'` on `removeDir`) computed by `planBuild` from the session's committed baseline | Lets *both* executors (Core and CLI) act on one decision — the CLI has no session state, so ownership evidence must travel in the plan | New planner-contract surface; additive `FileOperation` field (frozen-API decision) |
| Adoption outcome reporting | Non-silent result surfacing for rescued content (paths quarantined) | E1's fix must not be silent in the other direction: a rescue that is not reported is a silent relocation. Channel: existing `OperationLogger` warn/info — no new API | None beyond the above |
| Doctor gate (alternative) | `filesystem.outDirInsideProject` severity escalation | If the owner chooses *accept-and-warn* over prevention, the only honest form is an explicit, blocking doctor gate for case-6 adoption flows — a product decision, listed as such in §11 | Product decision |

No registry, migration framework or new public API beyond the two
mechanical capability additions is required by the preferred mechanism.

## 9. Compatibility implications

- **Non-case-6 layouts.** A destination outside the project is always
  unproven at first adoption; with M2 the first build into a pre-existing
  non-empty external output root quarantines instead of destroying. For the
  overwhelmingly common shape (an empty or engine-generated external
  outdir) behavior is byte-identical to today. Same-root rebuilds are
  provable via the committed baseline; nothing changes.
- **Case-6 layouts are preserved, not prohibited.** The mechanism acts only
  at the moment a variant folder is claimed; case-6 adoption keeps working,
  with any pre-existing unproven content rescued (not refused, not
  silently deleted). This satisfies "protect supported case-6 layouts
  without silently prohibiting them" — the layout remains valid; the
  destructive first-build semantics change.
- **Expected rebuild behavior preserved.** E1-D and E1-E semantics are
  pinned by M3: same-root rebuilds and engine-owned output regeneration
  behave exactly as today. The hybrid never adds preflight friction to the
  rebuild path (the committed-baseline proof is a string comparison, not a
  filesystem scan).
- **DevSync (strict-S1/UX-09) interaction.** M1/M2 are engine-side and
  orthogonal to the §14 mechanism design: they change what survives the
  adoption, not how events are filtered or delivered. The E1 boundary of
  doc 14 §2/§16.1 remains exactly as recorded — this document neither
  approves the E1 exclusion nor relaxes strict S1; it makes the
  destruction the E1 exclusion was named for preventable, which §16.1
  disposition (b) requires as a *separate engine decision*.
- **No new F23 behavior.** The quarantine is dot-prefixed, so it cannot
  re-enter any copyTree walk or classification (no new F23-shaped
  feedback); rescue content is not re-copied into the build, so no
  unbounded copying or recursive growth is introduced.
- **Frozen API-v2 boundaries.** No `PzStudio`/v2 surface change in the
  preferred mechanism's core; the only possible frozen-surface deltas are
  the optional rename capability and the additive planner field (§8), each
  an explicitly gated approval. Doc 13 §15's UX-R0 extension-only boundary
  is untouched: this is Core/CLI work with its own approval path.

### Failure and recovery semantics (summary)

| Event | Behavior |
| :--- | :--- |
| Unproven non-empty destination at adoption | Content quarantined under `<outdir>/.pzstudio-rescue/<ts>-<name>/`; rebuild proceeds; result names the rescue path and count |
| Rescue impossible (lock, quota, cross-device copy failure) | Build fails explicitly with the lock-error wording + reason; destination untouched; no partial destruction |
| Crash during copy-form quarantine | Original survives (delete gated on a completeness manifest); orphaned partial quarantine is inert (dot-prefixed, engine-invisible) |
| Crash after rename-form capture, before rebuild | Quarantined tree intact under its dot-prefixed path; user-visible; next build proceeds (the destination is now empty) |
| Rescue folder retention | Never deleted by the engine; doctor-visible; cleanup is a user action |
| Same-root rebuild failure (locks) | Unchanged: today's actionable lock-error semantics (execute.ts:352-359 / helper.ts:259-262) |
| Rescue folder retention | Never deleted by the engine; doctor-visible; cleanup is a user action |
| Same-root rebuild failure (locks) | Unchanged: today's actionable lock-error semantics (execute.ts:352-359 / helper.ts:259-262) |
| E1-E (user edits generated output) | Unchanged: overwritten on rebuild, engine-owned semantics (accepted) |

## 10. RED-first permanent regression matrix (for the implementation stage)

Every row was executed as a disposable experiment at `47abe28` (§3); the
implementation stage re-lands them as permanent gates. RED-first means:
each gate is written against the *post-fix* expectation and fails at
today's HEAD.

| ID | Gate | Red condition at today's HEAD | Green condition |
| :--- | :--- | :--- | :--- |
| E1-R1 | Adoption destroys a pre-placed future-variant-folder file silently (Core session) | Destruction happens, `errors: []` — pin as documented boundary until the mechanism is approved; after the mechanism lands: file is quarantined, rebuild proceeds, result names the rescue path | File present under the rescue path; original path rebuilt; `fullRebuild: true` |
| E1-R2 | Same flow with the event delivered first (E1-B) | Nested garbage under old root + original destroyed at adoption | Rescue path preserves the original; no nested-capture change |
| E1-R3 | Same victim, CLI `executeBuildPlan` on a real fs | Today: `cpSync` self-copy abort *after* the `removeDir` destroyed the victim | No destruction before the plan's ownership decision; CLI rescue parity with Core |
| E1-R4 | Same-root rebuild (E1-D) and user-modified generated file (E1-E) | Today: silent overwrite — stays identical under M3 (green today, must stay green) | No quarantine noise, no preflight failure, byte-identical output |
| E1-R5 | Sanitized variant names (E1-F): title `Sync: Project?` | Destruction target is exactly `sanitizeFolderName(title)`-derived; near-miss folders survive | Same, plus the sanitized-name quarantine path is exact |
| E1-R6 | A→B→A with stale generated folders (E1-G) | Stale trees preserved (F23-fix policy) while the future-variant victim is destroyed | Stale trees still survive; victims quarantined; re-adopted root rebuilt normally |
| E1-R7 | Check-to-delete race probe | A file created between the ownership scan and the `removeDir` is destroyed (structural TOCTOU of any decide-then-delete mechanism) | Capture form: file quarantined (no destruction possible post-capture); race residual = post-capture concurrent write into new build territory (§16.2-priced) |
| E1-R8 | Rescue visibility | — | Quarantined paths never classify as source; never re-embedded (dot-prefix pin); never deleted by the engine |
| E1-R9 | CLI/Core parity of the mechanism | CLI executor currently *loudly* destroys (cpSync guard) — parity fails today | Both executors honor planner-provided ownership data (§8) with identical rescue semantics |
| E1-R10 | F23-E1a (case-variant destination) | Alphabetical: nesting depth > 2 (measured 6); insertion order: write-budget trip (unbounded) | Containment resolves case; both orders bounded; regression pins both flows |

The suite above is specified, not implemented (the disposable experiment
suite was deleted before this commit). E1-R1/E1-R2 re-target the executed
reproductions of §3; E1-R3..R8 are new gates for the mechanism stage.

## 11. Explicit owner decisions required before implementation

1. **Prevent vs accept vs scope out** (doc 14 §16.1 disposition (b), restated
   as the E1 decision this record serves): prevent the destruction (the §6
   mechanism), accept-and-warn (doctor gate escalation, §8), or reject
   case-6 adoption flows (Candidate C's layout rejection — the only
   zero-mechanism alternative; a product decision forbidden to this task).
2. **Approve the E1 exclusion or not** as legitimate-source semantics (doc
   14 §16.1 disposition (a)) — this record does not resolve it; if the
   mechanism of §6 is approved, the E1 exclusion becomes unnecessary for
   the *destruction* class (content is rescued), but the sync-contract
   scoping question (whether variant-folder mutations are in-contract for
   DevSync) remains separate.
3. **Capture form**: rename capability (§8 row 1 — frozen-surface
   exception) versus copy+manifest-verify+delete (no new capability, crash
   window wider). The rename form is recommended; both are specified.
4. **Planner-ownership field** (§8 row 2): required for CLI parity — a
   frozen-API additive decision.
5. **F23-E1a** (§7 blocker) and the **CLI-side F23 exposure** (§4): file as
   sibling defect tickets; no case-6 reliability claim survives without
   them (doc 14 §16.3's condition, now including the CLI executor).
6. **Rescue-folder contract**: location, naming, retention policy and
   doctor visibility are user-facing output-contract decisions (the
   reserved `.pzstudio-rescue` name becomes part of the output-root
   contract).

## 12. Verdict

**`READY_FOR_E1_OWNER_DECISION`.**

The destructive mechanism is fully specified and reproduced (E1-A…E1-G,
Core and CLI separately); the accepted ownership boundary is preserved
verbatim; the candidates are evaluated with their check-to-delete races
closed analytically; the preferred mechanism (capture-then-adopt with
provable-ownership preflight) meets the brief's criteria with the two
gated surface deltas of §8 named; one new demonstrable F23 escape is
reported as a separate blocker (§7, F23-E1a). Nothing here is an
implementation approval, an E1-exclusion approval, or a strict-S1
satisfaction claim.

**Residual obligations before implementation** (inherited from the
mechanism analysis, not from missing evidence): (1) the §11 decision set —
each is the owner's, not derivable; (2) the rename-vs-copy decision and
its manifest-check design (§8 row 1); (3) the exact quarantine retention
and doctor-surfacing UX; (4) the E1-B nested-garbage cleanup semantics
(bounded garbage under abandoned roots is recorded behavior, unchanged by
this design).

---

*Pointer: doc 14 §16.1 (Gate 1 — E1 source-ownership legitimacy) links
here for the mechanism-level investigation its disposition (b) requires;
doc 13 §15 is unaffected.*


