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

**Class-5 status (recorded later, at doc 18):** the accepted
silent-overwrite semantics of class 5 are superseded for every file
lacking valid ownership evidence — a digest mismatch ⇒ preserve and report
(doc 18 §3, I-DIGEST); a receipt-less file ⇒ ownership-unknown ⇒ preserve
(doc 18 §2 B1-A). Regeneration applies only to validly-evidenced files.

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

**E1-E supersession (recorded later, at doc 18):** the executed E1-E row
above stands as reproduction history only. The silent-overwrite semantics
are superseded for **every** file lacking valid ownership evidence: a
receipt-covered digest mismatch is reported immediately and the file
preserved (doc 18 §3, I-DIGEST); a receipt-less file is ownership-unknown
and preserved in every flow, including rebuild (doc 18 §2 B1-A). A rebuild
regenerates only validly-evidenced files, and the pending mutation batch
is aborted before it starts. A running watch session that detects
the mismatch stops mutating and continues in read-only observation until
the user acts and revalidation passes (doc 18 §3 / D9).

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
  is false-failure-prone: any user modification of generated output
  (E1-E — receipt-covered files are preserved instead, doc 18 §1)
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

**Copy-form supersession (recorded later, at doc 18):** the copy-then-delete
crash analysis above is historical candidate evaluation. Doc 18 §2 O-5
selects **atomic-rename-only** rescue, failing closed when safe rename
conditions cannot be verified; copy-and-delete is **not** an automatic
fallback. The completeness-check reasoning survives only as a
validation/gate design input, never as authority to switch to copy-delete
when rename is unavailable.

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

**M1 evidence supersession (recorded later, at doc 18 §2 B1-A):** the
"provably engine-owned" branch above is superseded — a subtree's presence
inside the committed output root of the same session is **not** ownership
evidence, and neither is the committed baseline, the build plan, session
history or subtree location. Under doc 18, ownership proof is per-file: a
valid receipt whose digest matches the current content, plus boundary and
authorization checks; receipt-less files are ownership-unknown and
preserved, and preflight findings abort the batch (doc 18 §2 B1-A/B2-B).
The baseline rule above stands as the record of this document's original
design, not as a rule in force.

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

**Name supersession (recorded later, at doc 18):** the reserved
rescue-folder base name was set to `_backup` by the Owner (doc 18 §7). The
`.pzstudio-rescue` spelling here and in the §5-C / §9 illustrations remains
the historical candidate-form record; `_backup` is not dot-prefixed, so
doc 18 replaces this section's dot-prefix invisibility argument with an
explicit reserved-name exclusion requirement. Doc 18 §1 also supersedes
M3/E1-E silent overwrite for files covered by a valid ownership receipt.
Doc 18 §2 O-5 likewise supersedes this section's copy-then-delete
completeness-gate sentence: rescue is atomic-rename-only and fails closed
when rename safety cannot be verified (no automatic copy-and-delete
fallback). Doc 18 §2 D1/D5 additionally place the ownership ledger at
`<project-root>/.pzstudio/ownership-ledger/` and protect it and the
reserved rescue paths through a centralized exact-scope exclusion policy —
never copied, overwritten or deleted as ordinary output. Read M2 together
with doc 18 §4 (I-UNOWNED) and §2 B2-B: non-empty output without valid
ownership evidence is rejected before mutation, and M2's automatic
rescue-then-proceed execution is superseded — abort, preserve, report
(resolved at doc 18 §10 item 13). Per doc 18 §2 B1-A, a file without valid
ownership evidence is preserved in every flow, including rebuild.

**M3 — Same-root rebuilds (reconciled).** This section originally pinned
today's semantics — a committed-root rebuild (E1-D) and the
user-modification overwrite (E1-E) "proceed exactly as today", no quarantine
noise, no false failures — citing doc 14 §16.1's plan-resolution-time
claim. As superseded by doc 18 §2 B1-A/B2-B and §3 (I-DIGEST), that is no
longer the rule: a same-root rebuild may regenerate **only** files with
valid ownership evidence whose current digest matches the receipt, and
only after the required safety checks pass; receipt-less files are
ownership-unknown — preserved and reported; digest mismatches are
preserved and reported, never overwritten or restored. A preflight
finding of unowned content aborts the batch before it starts.

**M4 — Failure semantics (re-scoped by doc 18 §2 B2-B).** Preflight and
rescue are separate: a preflight finding of unowned content aborts the
mutation batch (preserve, report) — it never triggers an automatic rescue
and never lets the build continue after one. The failure semantics below
apply only to a **user-initiated rescue** (O-6): a rescue that cannot
complete (lock errors, cross-device failure, quota) fails closed with the
existing actionable lock-error wording plus the reason; the destination is
left untouched (never partial-destruct). The rescue folder and its
retention are user-inspectable and doctor-visible; cleanup is a user
action (the engine never deletes quarantined content) — and a completed
rescue neither establishes ownership nor unblocks a batch.

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

**Race-closure supersession (recorded later, at doc 18 §2 B1-A/B2-B and
§7):** the summary above is the historical candidate analysis. In force
now: scan-then-capture is not a mechanism for letting a mutation batch
pass an ownership conflict — preflight findings abort the batch (preserve,
report); rescue is a separate user-initiated operation (O-6, D8a
rename-only, fail-closed); and legacy trees without ownership evidence are
ownership-unknown (preserved, reported) — no re-adoption or rescue process
for them is inferred here, and any such process needs separate Owner
approval. The copy-form wording above ("manifest-verified copy in the copy
form") is likewise superseded (doc 18 §2 O-5/D8a: no copy fallback).

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

  **Attribution refinement (recorded later, at doc 16; the experiment
  record above stands):** the *demonstrated* escape — in the executed
  fixture behind the measurements above (the surviving `GEN` outdir root
  with non-variant content, `tests/unit/copytree-case-alias.test.ts`
  E1a-B) and in the latest native NTFS reproduction — is **not** a pure
  variant-folder case flip. A pure title-case flip is bounded even
  pre-`2cacb4e`: `removeDir` removes the variant folder in either
  spelling (case-insensitive resolution), and the fresh levels are then
  plan-spelled, so the chain re-matches (E1a-D pins this green). The
  proven escape requires a **surviving case-variant ancestor** — an
  outdir root whose stored spelling differs from the plan's and that
  `removeDir` does not touch because only variant folders are removed
  (non-variant content under it keeps the stored spelling alive). The
  `2cacb4e` fix closes exactly that shape within its coverage; symlink
  and short-name aliases remain open (doc 16).
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

**Capture-form supersession (recorded later, at doc 18):** row 1's
"falls back to copy+verify+delete" phrasing is superseded by doc 18 §2
O-5 — atomic-rename-only, failing closed when safe-rename conditions
cannot be verified; copy-and-delete is not an automatic fallback. The
rename capability itself remains a pending frozen-API exception. Row 1's
"closes the capture race cleanly" is a design property claimed for atomic
rename, not a runtime-verified closure: residual race windows and their
consequences are recorded (§5; the §6 race-closure summary), never
claimed eliminated.

**Row-2 status (recorded later, at doc 18 §10 item 14):** the
planner-level ownership field is an OPEN Owner decision — a historical
proposal, not an approved contract. Committed baseline is not ownership
evidence (doc 18 §2 B1-A); a planner field, if ever adopted, would carry
assertions of intent only, never proof, and executors would still
independently verify receipts/digests, boundary and authorization
(doc 18 §6). No API field is designed or standardized here.

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
- **No new F23 behavior.** (Historical candidate rationale — superseded by
  doc 18 §7: safety was argued from the quarantine being dot-prefixed,
  hence invisible to `copyTree` and classification. The decided name
  `_backup` is **not** dot-prefixed, so no automatic by-name exclusion
  exists; the reserved-path exclusion is a design requirement to be
  specified and tested — doc 18 §10 item 5 — before any no-re-embedding
  claim can be made. Standing design requirements, **not**
  runtime-verified behavior: rescue content must never be re-embedded,
  foreign rescue content must never be overwritten or merged, and rescue
  content must never be automatically deleted — doc 18 §2 O-5, §6.)
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

*(Supersession, recorded later at doc 18: the copy-form and dot-prefix
rows above are historical candidate semantics — doc 18 §2 O-5 selects
rename-only rescue, and doc 18 §7 replaces dot-prefix exclusion with a
reserved-name exclusion; the final E1-E row is superseded for every file
lacking valid evidence (doc 18 §2 B1-A and §3); adoption of non-empty
output lacking valid ownership evidence is rejected before mutation per
doc 18 §4 (I-UNOWNED); and the first row's rescue-and-proceed behavior is
superseded by doc 18 §2 B2-B — abort, preserve, report. The compatibility
bullets above are likewise superseded where they rest on the old model:
"Same-root rebuilds are provable via the committed baseline" (baseline is
not evidence — doc 18 §2 B1-A), quarantine-at-adoption and
"rescued (not refused)" (preflight findings abort — doc 18 §2 B2-B),
"Expected rebuild behavior preserved … exactly as today" (regeneration
applies only to validly-evidenced files — doc 18 §2 B1-A, §3), and the
"No new F23 behavior" bullet's dot-prefix reasoning (historical candidate
rationale — doc 18 §7). Compatibility under the current decisions, by
output state: an **empty or absent** output root may be initialized after
the mandatory checks; **old content without valid receipts** is
ownership-unknown — the batch aborts and the content is preserved and
reported, never adopted; files with **valid receipts and matching
digests** may be regenerated; **receipt-but-mismatched** files are
preserved and reported. The "byte-identical to today" claim of the
non-case-6 bullet — including for a previously "engine-generated" external
outdir, which is not engine-owned merely because the engine once wrote it
or a committed baseline recognizes the root — described the superseded
mechanism and does not hold under B1-A/B2-B.)*

## 10. RED-first permanent regression matrix (for the implementation stage)

Every row was executed as a disposable experiment at `47abe28` (§3); the
implementation stage re-lands them as permanent gates. RED-first means:
each gate is written against the *post-fix* expectation and fails at
today's HEAD.

**Gate reconciliation (recorded later, at doc 18 §2 B2-B):** the green
conditions of E1-R1/R2/R3/R5/R6/R7 are re-targeted from rescue-then-proceed
to abort/preserve/report — a preflight finding of content without valid
ownership evidence aborts the pending batch; nothing is automatically
moved to `_backup` to bypass preflight, and a successful rescue never
authorizes continuing the batch. E1-R4's receipt-less scope is likewise
superseded by doc 18 §2 B1-A (every file lacking valid evidence is
preserved, including rebuild). The red conditions remain the executed
record of today's HEAD.

| ID | Gate | Red condition at today's HEAD | Green condition |
| :--- | :--- | :--- | :--- |
| E1-R1 | Adoption destroys a pre-placed future-variant-folder file silently (Core session) | Destruction happens, `errors: []` — pin as documented boundary until the approved mechanism lands (doc 18 §2 B2-B: abort, preserve, report) | Pending batch aborted before any mutation; the pre-placed file preserved byte-exact; conflict reported with paths, reason and next steps; retry only after resolution and revalidation (doc 18 §2 B2-B) |
| E1-R2 | Same flow with the event delivered first (E1-B) | Nested garbage under old root + original destroyed at adoption | Batch aborted; the original file intact — no rescue, no nested capture; conflict reported (doc 18 §2 B2-B) |
| E1-R3 | Same victim, CLI `executeBuildPlan` on a real fs | Today: `cpSync` self-copy abort *after* the `removeDir` destroyed the victim | No destruction before the ownership decision; identical abort/preserve/report parity between the CLI and Core executors (doc 18 §2 B2-B) |
| E1-R4 | Same-root rebuild (E1-D) and user-modified generated file (E1-E) | Today: silent overwrite of user-modified generated output (historical baseline behavior; the old "stays identical under M3 — green today, must stay green" expectation is superseded — see the green column) | Rebuild regenerates only validly-evidenced files (receipt with matching digest); every file lacking valid evidence — receipt-less or mismatched — is preserved and reported (doc 18 §2 B1-A, §3) |
| E1-R5 | Sanitized variant names (E1-F): title `Sync: Project?` | Destruction target is exactly `sanitizeFolderName(title)`-derived; near-miss folders survive | Same refusal semantics against the exact `sanitizeFolderName`-derived segments; near-miss folders untouched; no quarantine path created (doc 18 §2 B2-B) |
| E1-R6 | A→B→A with stale generated folders (E1-G) | Stale trees preserved (F23-fix policy) while the future-variant victim is destroyed | Stale trees still survive; victims preserved — batch aborted and reported (doc 18 §2 B2-B); the re-adopted root rebuilds only over validly-evidenced files; old output roots are never auto-cleaned and may be doctor-reported (doc 18 O-2/D10) |
| E1-R7 | Check-to-delete race probe | A file created between the ownership scan and the `removeDir` is destroyed (structural TOCTOU of any decide-then-delete mechanism) | No destruction of unverified content in the observable window; findings abort the batch (preserve, report); the residual race window is documented, never claimed closed (doc 18 §2 B2-B, §6) |
| E1-R8 | Rescue visibility | — | Quarantined paths never classify as source; never re-embedded (reserved-name exclusion of `_backup` — supersedes the dot-prefix pin, doc 18 §7); never deleted by the engine |
| E1-R9 | CLI/Core parity of the mechanism | CLI executor currently *loudly* destroys (cpSync guard) — parity fails today | Both executors abort the pending batch before mutation on preflight-unowned findings and preserve/report identically (doc 18 §2 B2-B); a planner ownership field joins any contract only by separate Owner decision and approvals (doc 18 §10 item 14) |
| E1-R10 | F23-E1a (case-variant destination) | Alphabetical: nesting depth > 2 (measured 6); insertion order: write-budget trip (unbounded) | Containment resolves case; both orders bounded; regression pins both flows |

The suite above is specified, not implemented (the disposable experiment
suite was deleted before this commit). E1-R1/E1-R2 re-target the executed
reproductions of §3; E1-R3..R8 are new gates for the mechanism stage.

## 11. Explicit owner decisions required before implementation

**Decision-status supersession (recorded later, at doc 18):** the list
below is the **original historical decision list** as written at
`47abe28`; several items have since been decided by the Owner in doc 18,
and where an item's text still reads as an open question, the status here
governs. Current status per item — (1) is decided: prevent, via
fail-closed refusal (doc 18 §1, §2
B1-A/B2-B); (2) is decided as to destruction (superseded by B1-A/B2-B)
while the DevSync sync-contract scoping question remains open (doc 18 §10
item 15); (3) is decided: atomic rename only, fail-closed when rename
safety cannot be verified — no copy fallback (doc 18 O-5, D8a; the
rename-capability frozen-API approval remains a separate gate under D8c);
(4) remains OPEN — whether to adopt a planner-level ownership field as
planner contract is undecided (doc 18 §10 item 14; §6 there fixes only the
field's meaning: an assertion of intent, never proof); (5) remains tracked
as sibling defect tickets (F23-E1a partially landed; the CLI-side exposure
of §4 remains open); (6) is decided: reserved name `_backup`, collision
format `_backup-<timestamp>-<unique-suffix>`, ledger at
`<project-root>/.pzstudio/ownership-ledger/`, manual retention with no
automatic purge (doc 18 O-5, D4, D1); the reserved-path exclusion
mechanics stay open (doc 18 §10 item 5).

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
3. **Capture form (decided — doc 18 §2 O-5/D8a):** atomic rename only,
   failing closed when rename safety cannot be verified; copy +
   manifest-verify + delete is **not** a permitted fallback. (Historical
   record: this item originally posed rename versus
   copy+manifest-verify+delete with both specified — that choice is
   closed. The rename capability's frozen-API approval remains a separate
   gate, doc 18 D8c.)
4. **Planner-ownership field** (§8 row 2): originally proposed as required
   for CLI parity — now **OPEN — Owner decision required** (doc 18 §10
   item 14): not an approved contract; CLI parity is defined by identical
   abort/preserve/report behavior (doc 18 §2 B2-B), not by this field; any
   frozen-API additive decision remains a separate gate.
5. **F23-E1a** (§7 blocker) and the **CLI-side F23 exposure** (§4): file as
   sibling defect tickets; no case-6 reliability claim survives without
   them (doc 14 §16.3's condition, now including the CLI executor).
6. **Rescue-folder contract**: location, naming, retention policy and
   doctor visibility are user-facing output-contract decisions. (Decided
   later at doc 18: reserved base name **`_backup`** with collision format
   `_backup-<timestamp>-<unique-suffix>` — O-5/D4; ledger at
   `<project-root>/.pzstudio/ownership-ledger/` — D1; manual retention,
   never automatically purged, with Doctor reporting pending rescue and
   next steps — O-5/D7 at design level; detailed UX/reporting remains open
   where doc 18 §10 marks it so. The historical `.pzstudio-rescue`
   spelling is superseded — see §6 M2's note; `_backup` is not
   dot-prefixed, and neither the rescue folder nor its manifest is
   ownership proof.)

## 12. Verdict

**`READY_FOR_E1_OWNER_DECISION`.**

The destructive mechanism is fully specified and reproduced (E1-A…E1-G,
Core and CLI separately); the accepted ownership boundary is preserved
verbatim; the candidates are evaluated, with their check-to-delete races
analyzed and the residual race windows and their consequences recorded;
the preferred mechanism (capture-then-adopt with
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

**Verdict status (recorded later, at doc 18):** the verdict and residual
list above are the historical investigation record at `47abe28`. The
current state, per doc 18: the §6 mechanism direction was selected, but
its automatic capture-then-adopt / rescue-then-proceed execution is
superseded — preflight findings of unowned content abort the batch
(doc 18 §2 B2-B), and rescue is a separate user-initiated operation
(O-6, D8a); the rename-vs-copy choice is **decided** (atomic rename only,
no copy/manifest-check fallback — O-5/D8a; the rename capability's
frozen-API approval remains a separate gate, D8c). The residual
obligations, re-classified: **decided** — the resolved §11 items (see
§11's status note), rescue naming/collision and ledger location and
retention (O-5/D4/D1), cleanup trigger and semantics (O-2/O-3/O-4/O-6),
concurrency model (D6), retention architecture at design level (D12);
**open** — planner-level ownership field (doc 18 §10 item 14), DevSync
variant-folder scope (item 15), reserved-path exclusion mechanics
(item 5), legacy-output handling process, the remaining §10 implementation
details; **approval gates outstanding** — each frozen-API exception
individually (D8c); **not implemented or verified** — everything.
Nothing here is an implementation approval, an E1-exclusion approval, or
a strict-S1 satisfaction claim (unchanged).

---

*Pointer: doc 14 §16.1 (Gate 1 — E1 source-ownership legitimacy) links
here for the mechanism-level investigation its disposition (b) requires;
doc 13 §15 is unaffected.*


