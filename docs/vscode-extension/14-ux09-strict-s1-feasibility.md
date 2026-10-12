# 14 — UX-09 Strict S1 Feasibility and Provenance/Reconciliation Proof Obligations

**Status: feasibility record (Contract A spike). Documentation-only; nothing
here authorizes implementation.**

Written at HEAD `3246eb8c3e8c37297c13f1dbdf2a135541167c30` (branch
`42.20.0-dev`, tree clean before this commit). The UX-09 regression stash
was identified by message ("UX-09 red-first regression tests (A/B/C silent
source-event loss, proven at 8967ada) - blocked on session-root contract",
commit `35605964aaf82242c5359d516bf9cfbcf44cae57`) and inspected
**read-only** — never applied, never popped, never mutated; its single file
was extracted with `git show` into a disposable scratch copy that ran red
and was deleted before this commit. No production source, test, manifest or
dependency was modified. Every behavioral claim below was executed as a
deterministic scratch experiment against the unmodified real `BuildSession`
plus a gated memory filesystem (the experiments are described verbatim in
§4 and were deleted before the commit, per the spike's ground rules).

---

## 1. Product decision and scope

**Contract A — strict S1 — is the binding product requirement** (owner
decision; doc 13 §15.4, DX-10). This record is the technical feasibility
investigation that DX-10 was gated on. Contract B (decision-time
whole-outdir territory with an accepted indefinite silent-loss residual,
DX-9) is **rejected as an implementation basis**; nothing here reinterprets
an impossibility as permission to select it. The verdict (§12) is one of:
`FEASIBLE_WITH_PROOF_OBLIGATIONS`, `INSUFFICIENT_EVIDENCE`,
`BLOCKED_TECHNICAL`.

Scope guards honored: no production implementation, no stash restoration,
no UX-R2/Cockpit/UX-10 work, no release work, no rewrite of the Q3 record
or the historical §14 revisions, no alteration of the UX-R0 milestone
classification. Doc 13 §15 receives one pointer (§13 below); Q3 and §14
stay as written.

## 2. Strict S1 acceptance baseline

**S1-original (verbatim from doc 13 §15.4, the acceptance baseline of
record):** *No legitimate source mutation may be silently lost indefinitely
because of watcher filtering.* Task-level restatement with the three
operational clauses this spike proves against:

- **S1a (delivery-or-incorporation).** Every legitimate source mutation
  either reaches the engine (an event for it is delivered and acted on) or
  is demonstrably incorporated into the output.
- **S1b (no filtering loss).** Filtering must not silently discard a
  legitimate mutation's event. A successful build result alone is not
  evidence that concurrent mutations were incorporated (doc 13 §14.13
  outcome 5; EXP-1).
- **S1c (no indefinite stalling).** A legitimate mutation must not remain
  silently unincorporated *indefinitely merely because no further user
  action occurs*. User-triggered healing (restart, manual build, structural
  edit) does not satisfy S1c.

S2 (no unbounded self-feeding), S3 (isolation), S4 (bounded recovery),
S5 (lifecycle) and S6 (observable failure) are preserved as specified in
doc 13 §14.14; a candidate that obtains S1 by introducing an unbounded
loop, unbounded retry history or terminal silent abandonment is rejected.

**Legitimate source mutation (definition used throughout, grounded in
existing layout and Core classification semantics).** A filesystem
create/change/delete at path `P` is a *legitimate source mutation* iff
`classifyDelta({type, P}, committedPlanInput)` returns a non-`ignore`
classification (`mod-file`, `mod-scoped`, `workshop-text`,
`workshop-preview`, or `full-rebuild`), **excluding**:

- **E1 — engine-owned destinations.** `P` inside a *variant folder*
  (`<outdir>/<sanitized title>` and `<outdir>/<sanitized title> -
  dev_branch`) of the committed output root **or of any output root a
  pending structural change will adopt**. Rationale: `planBuild`'s
  `removeDir(variantFolder)` deletes whatever is there at adoption
  (verified: EXP-3a) — the engine's own build semantics make these paths
  write-owned destinations, and no filtering, provenance or reconciliation
  mechanism can incorporate content the engine itself destroys. This
  exclusion is an **impossibility boundary, not a policy choice** (§9).
- **E2 — ignored content.** Paths a build would not copy (dot entries,
  `.pzstudioignore`-excluded, project `excludes`) — already outside the
  engine's own contract.

Under this definition, in a **case-6 layout** (outdir inside a configured
mod folder — a supported, doctor-flagged layout, doc 13 §3.1) files under
the outdir but *outside variant folders* **are** legitimate source: Core
classification returns `mod-file` for them and `copyTree` consumes them as
source on the next build (F14). In non-case-6 layouts nothing under the
outdir classifies as source, so no filtering rule can lose a legitimate
event there at all — **strict S1 is contested exclusively by case-6
layouts** (plus the engine-internal classes below, which are
layout-independent).

## 3. Current source-grounded failure model (verified at `3246eb8`)

The three stashed red tests were re-run unmodified (scratch copy) at this
HEAD: **A1, B1 and C1 are RED** — 3 failed / 3, exactly as at `8967ada`
(the shipped §6.3 policy's filter-root divergence silently discards source
events under case-6 roots in the failed-rebuild, in-flight-scoped and
post-start-correction windows). Doc 13 §14/§15's failure model is
therefore still the live baseline; this spike adds three classes the §14
record already names but had not executed deterministically at this HEAD,
and one **new engine fact** (§6):

| Class | Shape | Verified by |
| :--- | :--- | :--- |
| F-territory | Successful rebuild commits a case-6 root without a late in-contract mutation; its event is dropped as territory; no error exists to flag (outcome 5 / RG-29). | EXP-1 |
| F-race | Read→write race inside one incremental apply: the only event was delivered and consumed; the engine wrote stale content; no signal exists. | EXP-2 |
| F-stranded | Failed rebuild moves the baseline and truncates output; with no further events the divergence persists (C10 makes it observable but healing stays user-action-dependent — violates S1c). | EXP-6 |
| F-order (new) | `copyTree` self-embedding is listing-order dependent; F14's "bounded one-generation" claim is not structural. | EXP-7 |

## 4. Deterministic experiments (real engine, gated memory fs)

**Harness disclosure.** Every experiment drives the **real `BuildSession`**
(packages/core, unmodified) through a `GatedMemoryFs` — the repo's
`MemoryFileSystem` wrapped with (a) explicit one-shot barriers on
`read`/`list`/`write`/`delete` (a barrier suspends the engine's next
matching operation until the test releases it, or rejects it for
deterministic failure injection), (b) a complete engine write/delete log,
(c) an optional write cap, and (d) alphabetical `list` ordering emulating
NTFS readdir (the raw harness's key-insertion order is restorable for
EXP-7). **Modeled:** watcher callback delivery (events are delivered by
explicit `apply()` calls at test-chosen instants — exactly the F19 freedom
the real watchers provide) and time (no sleeps; all ordering is causal via
barriers). **Source-verified:** the engine, planner, executor, ignore
semantics, coalescing, and both hosts' filter predicates
(`isWatchPathIgnored`) — imported and executed, not reimplemented. The
full suite (8 experiments) passed deterministically before deletion; the
stash reproduction (3 RED) is §3.

Common fixture: project `/proj` with one configured mod `my_mod`
(`media/lua/hello.lua` = `v1`, `media/lua/util.lua`), a workshop template,
and a case-6 output root inside the mod folder. Titles produce variant
folders `<root>/Sync Project` and `<root>/Sync Project - dev_branch`.

### EXP-1 — RG-29 / scenario A: successful-build late mutation

Sequence: session starts on external root `/out-a`; `project.json` delta
moves the config to case-6 root `<my_mod>/a-generated`; a barrier parks the
engine on the **last write** of the rebuild (dev variant's `workshop.txt`)
so both variants' `copyTree` traversals have provably completed; the user
creates `<root>/staging/late.lua` (legitimate source: `classifyDelta` →
`mod-file`); the barrier releases; the apply resolves.

Results (asserted): `fullRebuild: true`, `errors: []` — no C10 flag is
even possible. The mutation exists on disk but appears **nowhere** in the
output tree (exact assertion: no output path ends with `late.lua`).
Decision-time territory drops its event
(`isWatchPathIgnored(project, root, latePath) === true`), and the apply's
written-path set does **not** contain the path (every engine write is
inside the variant folders or an engine file) — so the §14.17 written-path
rule would deliver it. **Territory filtering violates S1a/S1b
deterministically; written-path delivery closes this shape.**

### EXP-2 — scenario E: read→write race inside one incremental apply

Sequence: barrier parks the engine on the **destination write** of an
incremental sync (its source read has completed); the user edits the source
between read and write; the barrier releases; the single coalesced event
has already been consumed.

Results: `incremental: 2` (both variants), `errors: []`; source reads
`v2`, output keeps `v1`. Delivery was **complete** — no filter was involved
— so **every event-based mechanism (territory, provenance, epochs) is
blind to this class**; only content comparison detects it. A modeled
re-delivery converges (delivered again → `v2`), but in the coalesced
single-event shape nothing re-delivers: the divergence persists until user
action — an S1c violation owned by the engine, not the filter. Closes only
under reconciliation (EXP-6's comparator finds precisely this
source≠destination mismatch).

### EXP-3a — scenario G (out-of-contract side): variant-folder destruction

Sequence: while root A is committed, the user places a file inside the
**future** root's variant folder (`<root-B>/Sync Project/Contents/mods/
my_mod/extra.lua`); the structural change adopts root B.

Result: the rebuild's `removeDir` deletes the variant folder; the file is
gone from disk, `errors: []`, no diagnostic. **No delivery mechanism can
incorporate content the engine itself destroyed** — this is exclusion E1
(§2), the impossibility boundary of §9. (Delivering the *event* would be
possible under written-path; there is no longer anything to sync.)

### EXP-3b — scenario G (in-contract collision): create+delete at the same path

Sequence: the user creates `<root-B>/staging/collide.lua` **before** the
adopting traversal (root A still committed); the rebuild incorporates it
(live-tree read; exact assertions: both variants' output copies contain
the content, at the embedded case-6 path); the user then **deletes** the
source; the delete event arrives after the commit.

Results: territory drops it (stale copies persist indefinitely — S1
violation); the written-path rule delivers it (path never written by the
apply) and the engine converges (both copies removed). **The in-contract
half of the collision class closes under written-path delivery.**

### EXP-4 — scenarios C/D: delayed engine echo after provenance advanced

Sequence: apply 1 writes the output copy of `hello.lua`; apply 2 syncs an
unrelated file (its written set does not contain that path); the watcher
delivers apply 1's engine event late; decided against the **latest-only**
set it is delivered; the engine classifies it as `mod-file` (case-6) and
writes exactly **one** nested copy per variant; the nested write's event
**is** in the newest set and is dropped.

Results: bounded one-generation garbage (embedded depth exactly 2;
asserted), termination without further engine activity, no loss. A
full-history set would have dropped the original event too — at the price
of unbounded retention under unbounded callback latency (F19).
**Latest-only provenance satisfies S1 and S2 here; the cost is one spurious
bounded sync per late engine echo.**

### EXP-5 — scenario B/D + loop: phantom filter root self-feed

Sequence: case-6 root committed at `<my_mod>/a-generated`; the filter root
mistakenly held at a *different* root (the shipped §6.3 divergence that
A1/C1 prove is reachable); the engine's own output event is therefore
**forwarded**; delivered repeatedly.

Results: each delivery produces exactly one deeper embedded copy —
measured depths `[2, 3, 4]` over three deliveries, strictly growing,
unbounded in delivery count. The committed-root getter
(`isWatchPathIgnored` against the engine's actual root) drops the same
event. **The C1/C2 committed-root getter is a necessary S2 mechanism in
its own right — written-path delivery without it would self-feed.**

### EXP-6 — Candidate B prototype: host-side reconciliation

Sequence: a gated `EBUSY` on the main variant's template write makes a
full rebuild fail **after** baseline assignment (F4 build-phase shape):
main variant truncated (template and mod content absent — asserted), dev
variant rebuilt from the live tree, `errors` non-empty, baseline moved.
The user then performs **no further action** (no events exist). A
prototype reconciler — forward walk of each mod's source tree (with the
copyTree ignore semantics via the real `isSourcePathIncluded`), reverse
walk of the output for vanished sources, **excluding variant folders and
engine-generated files** — produces deltas; the engine applies them.

Results: pass 1 finds the stranded divergence (including the exact
`hello.lua` change) and heals both variants; passes 2 and 3 are **fixed
points** (zero deltas, zero writes — asserted). The naive variant
*without* the variant-folder exclusion re-embeds the engine's own output
every pass — measured `found: 8 → 14 → 27`, files `26 → 52 → 104`,
embedding depth strictly increasing — **divergence without a fixed point:
S2-fatal**. A reverse pass that proposes deleting engine-generated
`mod.info` oscillates against the engine's regeneration (observed during
development; the exclusion is load-bearing). **Reconciliation is a
terminating, bounded, no-new-events recovery mechanism — the only one
that satisfies S1c for F-stranded and detects F-race.**

### EXP-7 — new engine fact F23: listing-order-dependent self-embedding

The same case-6 build, twice, differing only in `fs.list` order:
alphabetical (NTFS-like) completes in bounded writes; **insertion-order
readdir recurses without bound** (write cap trips; each write extends the
path by a fixed suffix, so no fixed point exists). Mechanism (traced
op-by-op): the walk lists `<variant>/Contents` *live*; when the template
entry precedes the `mods` descent at each level, the mod copy's own writes
are re-listed and re-descended as source. F14's "bounded, one-generation"
self-embedding is an **accident of readdir order**, not a structural
property — an ext4-hash-order filesystem, or any template/entry naming
that surfaces the template copy before `mods`, makes a case-6 build
(plain `pzstudio build`, not just DevSync) recurse unboundedly. **Filed
here as fact F23; a separate engine defect outside this spike's
strict-S1 scope, but it must be fixed (or doctor-blocked) before any
case-6 hardening claims reliability.**

## 5. First obligation — verdict on the §14.17 written-path proposal

The proposal: each apply reports the paths it wrote; the host keeps the
**latest apply's** written-path set and, at decision time, delivers
(instead of dropping) any under-committed-root event whose path that apply
did not write. Adversarial scenarios, each executed or reduced to the
experiment that decides it:

| # | Scenario | Verdict | Decided by |
| :--- | :--- | :--- | :--- |
| A | Legitimate mutation under a future root after traversal; callback after successful commit | **True counterexample to territory; closed by written-path** | EXP-1 |
| B | Engine writes X, user edits X, both events late/coalesced; X legitimate? | X is legitimate source only in case-6. Outside variant folders the engine never writes X directly → delivered → converges. Inside variant folders the engine owns/destroys X (E1) — **out of achievable contract, not a mechanism defect**. Path-only sets additionally risk dropping a post-apply user edit of an engine-written path; content-checked sets close the surviving window (§8) | EXP-3a, EXP-4 |
| C | Late callback from an older apply vs a newer written set | Latest-only delivers it as spurious but **bounded** (one nested generation) and terminating; full-history retention is unbounded memory. **Not a counterexample to S1/S2; a cost** | EXP-4 |
| D | Rapid A→B→A alternation, nested roots, events delayed across assignments | Every decision is made against current committed root + current set; alternation produces bounded churn. The only unbounded shape is a filter root diverged from the committed root — the getter's job | EXP-5 |
| E | Change between source read and engine write | **True counterexample to every event-based mechanism** (delivery was complete); only reconciliation closes it | EXP-2 |
| F | Failed partial builds, then unrelated successful incremental batches | Incrementals never heal the truncation (asserted in EXP-6's pre-state); errors are observable (C10) but healing is user-action-dependent — violates S1c until reconciliation runs | EXP-6 |
| G | Source delete vs generated create at one path, both orders | In-contract: create incorporated by live-tree read; late delete dropped by territory (S1 violation), delivered+converged by written-path. Reverse order: late delete of a re-created dest removes valid output; a later event or reconciliation restores it (bounded oscillation, not loss) | EXP-3b |

**Verdict: the written-path shortcut is necessary but not sufficient.** It
closes the entire territory-loss class (S1b) for in-contract paths, at a
bounded cost (scenario C), and requires the committed-root getter for S2
(scenario D/EXP-5). It does **not** close scenario E (F-race) or scenario
F's S1c gap (no-event stranding) — both require content reconciliation —
and it cannot reach scenario B's variant-folder half (E1, impossible for
any mechanism). §14.17's own caveat ("still leaves the microscopic
read→write race") is confirmed and sharpened: the race is not microscopic,
it is the representative of the only class events can never cover.

## 6. New engine fact (registered)

**F23 — `copyTree` self-embedding is listing-order dependent.**
`copyTree` (packages/core/src/execute.ts:202-228) lists directories live
during execution and applies no destination exclusion. In case-6 layouts
the walk can re-enter its own freshly written output; whether it does
depends on the order `fs.list` returns. Bounded under alphabetical readdir
with the shipped template names; **unbounded recursion** under orderings
that surface the variant's template entries before `mods` at each
`Contents` level (reproduced deterministically; the memory harness's
insertion order is one such ordering, ext4 hash order is a real-world
candidate). Consequences: (a) F14's bound claim is conditional, (b) any
case-6 reliability claim — including this document's — inherits the
hazard, (c) the fix (a destination-subtree exclusion in `copyTree`, or a
pre-execution listing snapshot) is an engine change requiring its own
decision. **Not a strict-S1 blocker for the mechanism design** (it afflicts
`pzstudio build` equally today), but a mandatory sibling defect ticket.

## 7. Candidate evaluation

| Dimension | A — Engine write provenance | B — Content reconciliation | C — Source/output separation | D — Minimal hybrid (getter + written-path + bounded reconciliation + §14 C10/C11/C12) |
| :--- | :--- | :--- | :--- | :--- |
| Strict S1 (S1a/S1b) | Closes territory class; **not** F-race/F-stranded | Closes all detectable classes (content-level) incl. F-race; cannot resurrect destroyed content (E1) | Closes everything by construction | **Closes all in-contract classes** (proven per mechanism: EXP-1/3b, EXP-6) |
| S1c (no user-action dependence) | No — healing waits for events/users | **Yes** — heals with zero events (EXP-6) | Yes | **Yes** — reconciliation backstop with finite cadence |
| S2 termination | Needs the getter (EXP-5); latest-set echo bounded (EXP-4) | Naive form S2-fatal (EXP-6); excluded form fixed-point-proven | Trivial | **Proven**: getter bounds territory (EXP-5), written-set bounds echo (EXP-4), reconciliation fixed-point (EXP-6) |
| Delayed callbacks (F19) | Latest-only set: bounded spurious delivery (EXP-4) | Immune (no event dependence) | Immune | Bounded spurious delivery + immune backstop |
| Same-path collisions | Variant-folder half unreachable (E1); rest converges | Detects content divergence; cannot merge write-write (E1 again) | Eliminates | In-contract converges; E1 excluded by definition |
| Traversal/read/write races | Blind (EXP-2) | **Detects and heals** (EXP-2 shape = source≠dest) | Eliminates | Detected by reconciliation within cadence bound |
| Root migrations | Follows getter; written-set per apply | Follows fresh config per pass | N/A | Getter + per-apply set + fresh-config pass |
| Failure/recovery semantics | No recovery story of its own | **Is** the recovery story (bounded, terminating) | — | C10 observability + reconciliation recovery; C11/C12 as specified |
| Resource bounds | One path set (latest apply); O(engine writes) | One pass O(source files) per trigger/cadence; no history | — | Sum of three bounded mechanisms; no unbounded retention (EXP-4 rejects full-history) |
| Core/API surface change | Yes (result surface or fs-observer option) — DX-10's priced item | **None** (all exports exist today except two api re-exports, §10) | Rejection of supported layouts | Getter (DX-2) + provenance surface (DX-13) + api re-exports |
| CLI watch applicability | Same mechanism (result surface) | Same mechanism (host-side pass) | Same | Same; CLI parity is mechanism-level, not lifecycle-level (doc 13 §15.7) |
| VS Code integration | schedule()-time decision change | post-apply/cadence task | — | Filter decision + post-apply hook (both already exist as hooks in the shipped controller) |
| Compatibility | Narrows the territory drop set vs F18/A1-control expectations (case-6 only) | None beyond above | **Rejects case-6 layouts — product decision, not taken** | Same narrowing as A (must be owner-approved) |
| Required approvals | DX-2 + DX-13 | api re-export (trivial) | **Owner rejection of supported layouts — explicitly not this spike's to make** | DX-2 + DX-9-reversal (narrowed drop set) + DX-13 + DX-14 |

**Candidate C** is technically the cleanest (zero ambiguity) and
categorically different: it *removes the overlapping-territory problem*
instead of solving it. It is **not evaluated further as an
implementation option** because it requires rejecting or migrating
supported case-6 configurations — a compatibility/product decision the
brief forbids this spike from making. It is recorded as the only
zero-residual alternative (§9).

## 8. Preferred technical direction (proven to design depth)

**Candidate D — minimal hybrid.** Each mechanism has a demonstrated
necessity (the brief's requirement for hybrids):

1. **Committed-root getter (C1/C2, DX-2)** — the S2 boundary. Proven
   necessary by EXP-5 (without it, case-6 engine output self-feeds without
   bound) and sound by theorem T′ (doc 13 §14.3).
2. **Written-path delivery (provenance, DX-13)** — replaces the
   whole-outdir drop with *drop only engine-echo*: under the committed
   root, drop an event iff its path was written by the latest apply (a
   variant-folder path, an engine file, or a prefix of them) —
   deliver everything else. Closes the territory class (EXP-1, EXP-3b);
   echo bounded (EXP-4). The provenance set must carry **content identity
   (hash) per written path**: with path-only sets, a user edit of an
   engine-written path arriving before any newer apply is dropped as echo
   (scenario B's surviving window); hash comparison at decision time
   delivers it iff the content differs from what the engine wrote
   (equal-content drops are harmless by definition). The set is
   latest-apply-only — full history is rejected (unbounded retention,
   EXP-4).
3. **Bounded reconciliation (no new Core API)** — after every
   re-baseline-class apply (`fullRebuild` or `scoped.length > 0`) and on a
   finite max-staleness cadence for incremental applies: run the EXP-6
   comparator (forward source walk with real ignore semantics; reverse
   output walk for vanished sources; **variant folders and
   engine-generated files excluded**), apply the deltas, and require a
   zero-delta pass before declaring sync (fixed point; passes are
   idempotent). Closes F-stranded (S1c, EXP-6) and F-race (EXP-2's shape
   is exactly a source≠destination content mismatch the forward walk
   finds) within the cadence bound.
4. **C10/C11/C12 as already specified** (doc 13 §14.11/§14.13):
   observability (S6), no silent incomplete-root commits, order-safe
   re-delivery. Under D, C10's recovery role is subsumed by
   reconciliation, its observability role is not.

**Ownership boundaries.** Getter + written-set + result surface: Core
(DX-2/DX-13); filter decision + reconciliation driver + cadence: hosts
(extension controller and CLI watch — both already own a post-apply hook);
ignore semantics: Core's exported `isSourcePathIncluded` (no host
re-implementation).

**Invariants and proof obligations** (each already executed in scratch
form above): drop-decision soundness (T′ + EXP-4/5), echo termination
(EXP-4), reconciliation fixed point and the two mandatory exclusions
(EXP-6), in-contract collision convergence (EXP-3b), and the E1 boundary
(EXP-3a — asserted *as* the boundary, not as success).

**Counterexamples D closes:** A1/B1/C1 (getter), RG-29/§14.17 residual
(written-path), F-race and F-stranded (reconciliation), the §14.4.9
retroactive-capture loss for in-contract paths, P0-D's incomplete root
(reconciliation detects missing mods even if C11 were absent), P0-E
corruption (C12).

**Counterexamples D does NOT close:** E1 (variant-folder destruction —
impossible, §9); EXP-7/F23 (listing-order recursion — separate engine
defect); mutations the OS never reports **and** reconciliation cannot see
(e.g., content written then reverted to byte-identical state inside one
cadence window — indistinguishable from no mutation by information
theoretic argument, and *incorporation-relevant* only if the intermediate
state mattered, which no observable can establish).

## 9. Impossibility and indistinguishability boundaries

1. **PZ Studio API limitation (solvable).** No delivery-ordering or
   provenance exists in the public API today; T3 is unprovable (F19).
   Solvable by the DX-13 surface (§8 item 2) — a *new controlled
   capability*, not a workaround.
2. **Watcher event contract limitation (solvable only by
   reconciliation).** `(type, path)` events carry no content identity and
   no mutation timestamp; the coalesced single-event race (EXP-2) is
   undetectable from events. Solved by content comparison, not by any
   event-consuming mechanism.
3. **Overlapping source/output limitation (unsolvable within current
   engine semantics).** In case-6, variant-folder destinations are both
   classified source and destroyed by `removeDir` at adoption (EXP-3a).
   Per-mutation incorporation there requires either an engine semantic
   change (pre-adoption capture) or rejecting the layout (Candidate C) —
   both owner decisions. **This is the exact sense in which strict S1 is
   conditionally, not unconditionally, achievable.**
4. **Filesystem concurrency limitation (bounded, not eliminated).** A
   mutation landing between a reconciliation pass's read of source and
   destination is missed until the next pass — finite staleness (cadence
   bound), satisfying S1c; zero-staleness would require filesystem
   transactions no host provides.
5. **Byte-identical churn (unobservable, benign).** Write-then-revert
   within one observation window is indistinguishable from no mutation;
   the final state is nonetheless correct, so no S1 obligation is breached.

**No promise of perfect event delivery is made anywhere in this design**:
the S1 guarantee rests on reconciliation as the independent recovery
mechanism the brief demands, with events as the latency mechanism only.

## 10. Minimal API delta and compatibility consequences

| Item | Surface | Nature | Approval |
| :--- | :--- | :--- | :--- |
| Committed-baseline getter | `BuildSession.getBaselineOutDir()` | Additive member (doc 13 C1) | **DX-2 (already proposed)** |
| Written-path provenance with content hashes | Preferred: additive `writtenPaths?: Array<{path, hash}>` on `SessionApplyResult`, collected by `BuildSession` around its own writes. Alternative (no Core logic change): an optional fs-observer/`fs` override on `createDevSync` — **note the extension cannot inject an fs today** (`createDevSyncCore` constructs `NodeFileSystem` internally, verified), so this is also a new surface | Additive; frozen-API exception either way | **DX-13 (new decision)** |
| `isSourcePathIncluded`, `modIdForVariant` | Re-export from `@pzstudio/cli/api` (both already public at the `@pzstudio/core` boundary; the extension imports only the CLI api) | Additive re-export | DX-14 (trivial, bundled with DX-13) |
| Reconciliation driver, cadence, narrowed drop rule | Extension controller + CLI watch (host-internal) | Behavior change | **DX-9-reversal (new decision)**: the drop set narrows from whole-committed-outdir (F18, A1-control) to engine-written-paths-only. The stash's A1 *control* expectation (under-B-outside-variant events stay filtered) **reverses** under Contract A — its red assertion (failure-window delivery) becomes the norm. Non-case-6 layouts: unchanged behavior (nothing under outdir classifies as source) |
| C6/C11/C12 (engine) | As doc 13 §14 already specifies | Independent correctness fixes | DX-4/DX-7/DX-8 (unchanged) |
| F23 fix | `copyTree` destination exclusion or pre-listed snapshot | Engine defect fix | New decision (sibling ticket, not strict-S1) |

## 11. RED-first regression plan (for the implementation stage)

1. **Unstash A1/B1/C1** and re-target: the red assertions (failure-window
   delivery) must turn green under D; the A1 *control* assertion
   (post-commit under-B filtering outside variant folders) must be
   **inverted** to expect delivery-with-incorporation (owner-approved with
   DX-9-reversal).
2. **RG-29′** — EXP-1 as a permanent gate: late in-contract mutation
   delivered under written-path and incorporated; exact output-tree
   assertion `no copy of late.lua` → false after healing.
3. **Race gate** — EXP-2 as a permanent gate: post-cadence reconciliation
   detects source≠destination and converges within one pass.
4. **Collision gate** — EXP-3b: late delete converges both variants.
5. **Echo bound gate** — EXP-4: delayed engine echo produces at most one
   nested generation and terminates (depth assertion).
6. **Getter-necessity gate** — EXP-5: committed-root filtering drops the
   engine echo (S2 pin).
7. **Fixed-point gate** — EXP-6: reconciliation pass 2/3 produce zero
   deltas and zero writes; naive (unexcluded) walker forbidden by review.
8. **E1 boundary gate** — EXP-3a asserted as documented boundary behavior
   (destruction, zero errors) so any future engine semantic change fails
   loudly.
9. **F23 gate** — EXP-7's two-order harness: bounded under alphabetical
   **and** insertion order once the engine fix lands (red until then).
10. **C10/C11/C12 gates** — doc 13 §14.15 rows, unchanged.

## 12. STOP — verdict and handoff

**Verdict: `FEASIBLE_WITH_PROOF_OBLIGATIONS`.**

Strict S1 (S1a/S1b/S1c) is **provable for the defined in-contract mutation
set** — everything `classifyDelta` accepts except engine-owned variant
folders (E1) — by Candidate D, with every mechanism's necessity and
termination demonstrated deterministically against the real engine at
`3246eb8`. It is **not unconditionally achievable**: E1 is an
engine-semantics impossibility (EXP-3a), and F23 is an open engine defect
that undermines case-6 reliability independently of S1.

**Residual unproven obligations** (proof remains for the implementation
stage): (1) an end-to-end production design for hash-carrying provenance
under both hosts (the scratch proof used an observing fs; the shipped
surface choice — result field vs fs-observer option — affects only where
the set is collected, not the decision rule); (2) the reconciliation
cadence value and its interaction with S4's bounded-retry budgets; (3) F23
fix design; (4) load characterization of full-tree compare passes on large
mods (bounded, but priced). None of these threaten the mechanism proofs;
all must be specified before implementation.

**Exact next implementation decision required from the owner:** approve
**DX-13** (provenance surface shape) together with the **DX-9-reversal**
(narrowed drop set, reversing the F18/A1-control granularity) on top of
the already-proposed **DX-2**, and file the **F23** engine defect. No
implementation of any Core/API capability in this record is authorized;
implementation begins only on that explicit approval.

---

*Pointer: doc 13 §15 links here (UX-09 strict-S1 feasibility record,
Contract A).*
