# 16 — F23 Path-Identity Safety: Symlink Aliases, Cycles, and the Resolved-Identity Requirement

**Status: source-backed correctness investigation (design + evidence). Documentation-only;
nothing here authorizes implementation, changes source-ownership semantics, touches the
CLI executor, or relaxes any contract recorded in docs 13–15.**

Written at HEAD `2cacb4ebb9a6ba35e34351478c89a5657064addd` (branch `42.20.0-dev`, tree
clean). The UX-09 regression stash was identified by its descriptive message ("UX-09
red-first regression tests (A/B/C silent source-event loss, proven at 8967ada) - blocked
on session-root contract", `stash@{0}`) and left untouched throughout: never applied,
never popped, never dropped, never renamed. No production source, test, manifest or
dependency was modified for this record. Every behavioral claim in §3 was executed as a
deterministic, budgeted experiment against the unmodified real Core executor
(`executeFileOperations` → `copyTree`) on emulated filesystems, and — where OS permissions
allowed — against the real `NodeFileSystem` adapter on real Windows NTFS junctions in a
temporary directory, plus the real CLI executor surface (`scaffoldProject`/`cpSync`).
All disposable experiment files were deleted before this commit; the results are recorded
here verbatim.

**F23 is NOT globally resolved by this document.** The case-variant escape closed by
`2cacb4e` is fixed within its verified coverage. The alias classes investigated here —
symlink/junction directory aliases and source cycles — remain OPEN, and the
still-unproven classes (Windows 8.3 short names, other normalization aliases) remain
open with no executed evidence either way (§9).

---

## 1. Source and adapter contract (the mechanism's raw material)

### 1.1 Core traversal semantics (`packages/core/src/execute.ts`)

`copyTree` (execute.ts:377–413) walks the source live: each directory is listed via
`fs.list` at the moment the walk reaches it, and entries are classified by
`resolveEntryType` (execute.ts:415–429), which **dereferences symbolic links** — a
`symbolicLink` entry is `stat`-ed through the injected contract and becomes whatever the
target is ('file' → copied as content, 'directory' → **recursed into under the link's own
name**, 'unknown'/failure → skipped silently). This dereference semantic is documented in
the executor's docstring since the original BuildSession commit (`525960b`) and is pinned
as current behavior by the `F23-E1a-SYM` block of
`tests/unit/copytree-case-alias.test.ts`.

Self-destination protection is `resolveDestinationChain` + `isInsideDestination`
(execute.ts:275–354): the destination chain is probed **lexically** — plan-spelled
segments against on-disk names, with the `2cacb4e` case-variant refinement — and the walk
skips entries whose walk-relative path matches the chain. The docstring records the
boundary itself: *"It does NOT see symlink or short-name (8.3) aliases: containment
remains lexical by name … closing it needs resolved-path identity, which the contract
does not expose."* Two scope facts the fix's own docstring establishes:

- When the destination is **not** lexically inside the source root, `segmentsBelow`
  returns null and there is **no destination exclusion at all** (`destinationChain` is
  null) — S8a below executes this gap.
- The exclusion compares **names**, so any alias that reaches the destination subtree
  under a different name is invisible to it.

### 1.2 The filesystem contract (`packages/platform/src/index.ts`)

`ProjectFileSystem` is exactly `read` / `write` / `delete` / `stat` / `list` over opaque
URIs. `FileStat` carries `type` / `ctime` / `mtime` / `size` — **no inode, no device, no
canonical path, no link target**. There is no `realpath`, no `lstat`, no `readlink`.
`list` returns adapter-constructed URIs for the **walk path** (the link's own path, never
the target's resolved location). `stat` follows links (node adapter: `fs.stat`); nothing
in the contract yields an identifier that two different spellings of the same physical
directory would agree on. **Canonical directory identity is not derivable from the
existing contract.** `PlatformCapabilities.symlinks` (platform/src/index.ts:67) gates
link *creation* hosts; it says nothing about identity resolution and no adapter exposes
any.

### 1.3 Adapters

- `NodeFileSystem` (platform-node): `fs.promises` throughout; `list` flags junctions and
  symlinks as `symbolicLink` via `readdir(withFileTypes)`; `stat` follows. `fs.realpath`
  exists natively and is simply not exposed.
- `WorkspaceFileSystem` (platform-web, vscode.dev): `vscode.workspace.fs` only. That API
  has **no realpath and no inode access** — a mandatory identity method would be
  unimplementable on the web host (this drives the *optional-capability* shape of §6).

### 1.4 May a supported mod legitimately contain symlinked directories?

Yes, by every piece of source evidence:

- Nothing in `validateProject`, the doctor, or the ignore rules forbids symlinks/junctions
  inside a mod source tree; the walk dereferences them **by documented design**
  (§1.1); S1/S5 below prove their targets' content is incorporated today.
- Studio-scaffolded junctions (`useSymlinks`, CLI `new` → `scaffoldTemplateFolder`,
  templateManager.ts:826–853) are dot-prefixed project-root folders (`.template-mod`,
  `.template-language`, `.libraries`) — **outside** mod copy roots, so they are not
  themselves source links; but nothing prevents a user from junctioning shared asset
  folders *into* their mod source, and the executor's documented behavior is to copy
  their content. Configuration `useSymlinks` is a **scaffolding-time** option (junction
  creation for shared template folders) and is unrelated to build-time traversal
  policy — no conclusion about traversal may be drawn from it (and none is).

Consequently **Option A (do not follow directory symlinks) is rejected as a
compatibility fix**: it would silently omit legitimate source content under documented,
executed-current semantics (§4-A).

## 2. Canonical-identity requirements (what any fix must know)

Executed evidence (§3) drives five requirements on the mechanism:

1. **Resolved directory identity.** For any directory URI the walk can reach — source
   entries, link targets, destination levels — the engine must be able to ask the adapter
   for an **opaque canonical identifier** such that two paths to the same physical
   directory yield the *same* identifier, and two distinct directories never do. On
   Node this is `fs.realpath` (or dev/ino); on vscode-vfs it may be unobtainable (§6).
2. **Exact, case-preserving comparison.** Identifiers compare by strict equality as the
   adapter returned them. The engine must never case-fold an identifier: on a
   case-sensitive filesystem `GEN` and `gen` are distinct identities (obligation 3 — no
   over-exclusion; the POSIX counterexample of doc 15 §7's E1a-C gate), and on a
   case-insensitive one the *adapter's* identifier already collapses spellings (that
   collapse is what subsumes the `2cacb4e` case-variant fix rather than regressing it).
   Whether `fs.realpath` on Windows returns stored or requested case must be verified at
   implementation time; the mechanism is correct precisely because it does not care —
   the adapter owns case semantics, the engine compares opaquely.
3. **Active ancestor stack, not a global visited set.** The cycle test is against the
   **current descent path only**. Two independent links to the same non-cyclic directory
   must both be followed (S5 proves the requirement; a global visited set would
   suppress the second branch — obligation 6).
4. **Destination identity set.** The forbidden set is: identities on the active ancestor
   stack (true cycles) **plus** the resolved identities of the operation's destination
   root, its destination chain, **and every existing ancestor of the destination below
   the walk root**. The ancestor extension is not gold-plating: S8a and S8b executed a
   link pointing at a destination *ancestor* (the variant root; the junctioned outdir
   root) — inside neither the destination subtree nor any source cycle — and both
   re-entered the destination. The brief's proposed invariant ("active ancestor stack, or
   the actual destination subtree") is therefore **necessary but not sufficient**; the
   executed refinement is the ancestor-or-self set of the resolved destination chain.
   Per-operation state only: root migrations A→B→A (pinned bounded by E1a-D) are
   unaffected because no identity state crosses operations.
5. **Explicit unresolvable-identity behavior.** Dangling links, EACCES-shaped stat
   failures, and ELOOP-shaped resolution failures currently skip **silently**
   (execute.ts:426–428; S4-alphabetical and S6 below executed the silent omission of
   source content). When identity cannot be resolved the mechanism must say so —
   minimum an `OperationLogger` warn naming the link and the limitation; a fail-closed
   variant is an owner decision (obligation 7).

TOCTOU cannot be fully closed on this contract (§8): identity is observed, then
traversed; a concurrent retarget invalidates any observation. All-schedules correctness
under concurrent alias mutation is **not claimed** (obligation 10).

## 3. Reproduced alias/cycle failures (executed evidence)

Method: the real `executeFileOperations`/`copyTree` on the in-repo emulated filesystems
(`SymlinkFs`/`CaseInsensitiveFs`/`F23Fs` — link map side-table, links reported as
`symbolicLink` entries, stat/read/list resolve through them, budgets and listing orders
from the F23 harness), with explicit write/list budgets on every potentially-unbounded
scenario. Native evidence: real NTFS junctions (no privilege required; the Windows
directory-alias norm) through the real `NodeFileSystem`, budgets via a counting wrapper;
real-OS file symlinks and POSIX were **not** exercised natively (symlink creation needs
developer mode/admin; junctions are the representative directory alias on this host —
this is an evidence limitation, recorded as such; the emulated semantics match POSIX
symlink traversal).

| # | Scenario | Executed result at `2cacb4e` |
| :--- | :--- | :--- |
| S1 | Source link → valid external dir, no cycle (outdir outside) | **Incorporated, bounded**: target content copied under the link's name; 3 writes; no error. Current semantics to preserve |
| S2a | Self-referential link (`media/zzz-cycle → media`), outdir outside | **Unbounded recursion** — walk re-lists `media` at every depth through the link; emulated: list budget 400 tripped at 440 with write depth 18 and still growing (would not terminate); the trip is the test harness's, not the engine's |
| S2b | Direct link→link cycle (`la → lb → la`) | **Bounded by ELOOP, silently**: both hops are links, `stat` never reaches a directory, the emulator (mirroring SYMLOOP_MAX) throws ELOOP, `resolveEntryType` maps it to 'unknown', the pair is **silently dropped** — no error, no report |
| S3 | Case-6 source link into the active copy destination (`zzz-outlink → gen/Sync Project`) | **Destination re-entry**: the walk copied the freshly written destination back into itself under the link's name (`…/my_mod/zzz-outlink/Contents/mods/my_mod/media/hello.lua` exists in the output); the lexical exclusion never saw it. Bounded at one garbage generation under snapshot listings in this fixture — the shipped output is still corrupted (output consumed as source), and generations compound with the number of such links |
| S4 | Two-hop chain (`chain1 → chain2 → gen/Sync Project`) into the active destination | **Order-dependent**: alphabetical listing → links `stat`'d while the destination is still empty → ENOENT → links **silently skipped** (legitimate source silently omitted — S6's disease, incidentally); insertion order (file entries before link entries) → destination already holds content → **re-entry**, 4 copy writes with the nested `chain1/Contents/mods/my_mod/media` generation. Same source tree, opposite outcomes: the alias behavior is not even deterministic across hosts' readdir orders |
| S5 | Two independent links to the same non-cyclic dir | **Both incorporated** (3 writes) — pins obligation 6: any global visited-set mechanism is refuted |
| S6a | Dangling link | Silently skipped (1 write; no error, no report) |
| S6b | Link whose `stat` fails (EACCES-shaped) | Silently skipped (1 write) — the target's content is silently absent from the output |
| S7 | Link target swapped between `stat` and traversal (TOCTOU probe) | **Stale observation honored**: type check saw the innocent target, the swap landed before `list`, the walk descended into the replacement target and copied its content — the check-to-traverse window is real even in a single-threaded emulation |
| S8a | External destination + source link into it | **No exclusion exists at all**: `segmentsBelow` returns null, `destinationChain` is null, and the link fed the live output back in as source (`…/my_mod/via-out/Contents/mods/my_mod/media/hello.lua` written into the output). The `47abe28` fix's protection does not even apply to this layout class |
| S8b | Destination root itself a junction (`gen → /elsewhere`) + second link (`shared → /elsewhere`) | Lexical exclusion held for the **plan spelling** (nothing materialized below `gen/…`), writes physically landed in `/elsewhere/Sync Project/...`, and the `shared` alias **re-entered the freshly written destination subtree** under an unmatchable relative name. Lexical containment disagreed with filesystem identity exactly as §2.4 predicts |

Native NTFS (real junctions, real `NodeFileSystem` unless noted):

| # | Scenario | Executed result |
| :--- | :--- | :--- |
| N1 | Junction ancestor cycle (S2a native) | **Terminated silently by MAX_PATH**: 32 writes, 31 nested `zzz-cycle` generations embedded in the output, no error of any kind. The OS path limit — not the engine — stopped the recursion, and it stopped it *silently*, leaving bounded garbage. The engine's own traversal is unbounded (S2a); on POSIX or long-path-enabled Windows nothing bounds it |
| N2 | Junction into the active destination (S3 native) | **Re-entry confirmed native**: destination content copied back under the junction's name; 2 writes |
| N3 | Junction to external dir (S1 native) | Incorporated, bounded — native confirmation of the preserve-class behavior |
| N4 | CLI executor surface (`scaffoldProject`/`cpSync`, templateManager.ts:766–820) on junction sources | **Fails loudly, differently**: `cpSync` (dereference defaults false) tries to *recreate* the link at the destination and gets `EPERM: operation not permitted, symlink …` — the build aborts mid-way with a confusing error (output dir left partially built). No silent wrongness, but also no exclusion, no dereference parity with Core, and a hard build failure on any link-bearing source (§10) |

Evidence limitations: junctions are directory aliases only (no native file-symlink or
Unix exercise); the emulated S7 TOCTOU is a deterministic single-threaded
demonstration, not a concurrent-schedule proof; N1's exact cutoff depth is
host/path-length dependent.

## 4. Candidate comparison

### Option A — do not follow directory symlinks

**Rejected as a compatibility-preserving fix.** Dereference is documented executor
semantics since `525960b` (§1.1); nothing in validation or doctor forbids source links
(§1.4); S1/S5/N3 executed proof that legitimate content is incorporated through links
today. Skipping directory links would silently omit that content — the exact
legitimate-source-loss class every F23 correction was ordered not to introduce. It could
only return as an *explicit policy change* (skip + warn, or a validated project opt-in),
which is a source-semantics decision above this record's authority; not recommended.

### Option B — active-stack canonical identity (the proposed Core invariant)

Per `copyTree` operation: resolve the destination chain's existing levels to canonical
identities; maintain the active ancestor stack during the walk; before entering any
directory entry (including through a symbolicLink), resolve its target's identity and
refuse entry when it is on the stack **or** in the destination identity set (destination
root, chain, and existing ancestors — §2.4's executed refinement). Unresolvable identity
→ explicit warn (or fail-closed, owner's choice). Honest characterization: this is the
only candidate that closes every executed escape class (S2 cycles, S3/S4/S8
destination re-entry) *without* suppressing independent branches (S5), *without*
case-fold over-exclusion (E1a-C's POSIX counterexample — identifiers compare exactly),
and *without* changing what is incorporated on alias-free trees (destination-chain
identities coincide with today's lexical exclusions; every other path is untouched).

What it cannot do: see identities the contract does not expose (requires §6's
capability), survive concurrent alias retargeting (§8), or prove anything about the
CLI executor (§10).

### Option C — adapter-level cycle prevention

Cycle detection living entirely in the Node adapter (dev/ino-based) **without changing
Core**: portability fails immediately (vscode.workspace.fs exposes no identity — the web
host gets nothing), and the coverage is strictly weaker than B's: S3/S4/S8a/S8b are
**not cycles** — in each, every physical directory is visited at most once per
generation; the walk takes a DAG path into the destination, which ancestor-repeat
detection cannot see. It also cannot share its identity observations with Core's
destination exclusion, splitting one safety proof across two layers, and the Core
regression suite (memory filesystems) could not test the protection at all. Recorded as
a possible *adapter-side hardening complement* after a Core mechanism exists; rejected
as the mechanism.

### Option D — bounded fail-closed traversal

A per-operation fs-operation budget in the executor that throws an explicit error naming
the operation when exceeded. Executed mechanics: the F23 harness demonstrates budgets
convert unbounded recursion into a deterministic, diagnosable failure (S2a/N1 would have
been disk fill or a hang otherwise). But a budget **stops resource exhaustion; it does
not prove correct incorporation**: too low false-fails legitimately large trees, too
high fills the disk first, and every budget trip leaves truncated output (N1 shows the
silent-truncation cousin). A hard directory-depth limit is **not selected**: PZ mod
trees are shallow in practice (Contents/mods/<id>/media/…, observed < 10 levels) but no
contract guarantees it, and no compatibility data exists for workshop templates' worst
case — inventing a depth policy without that data is exactly the unexamined-compatibility
move the brief forbids. D is retained **only as an optional defense-in-depth companion**
with exact failure semantics (explicit error naming the copyTree operation, no silent
truncation), subordinate to whichever of B/C-class mechanism is approved; it is not the
fix.

**Comparison table**

| Obligation (brief §5) | A (no-follow) | B (identity stack) | C (adapter cycles) | D (budget) |
| :--- | :--- | :--- | :--- | :--- |
| 1 no unbounded alias traversal | yes (by omission) | **yes** | S2 only | trip-wires it |
| 2 no silent omission of legitimate links | **violated** | preserved | preserved | preserved |
| 3 no case-sensitive over-exclusion | n/a | **holds** (exact ID compare) | n/a | n/a |
| 4 no `2cacb4e` regression | n/a | **subsumes it** (adapter collapses case) | n/a | n/a |
| 5 no staging/collide.lua or stale-root regression | n/a | **holds** (identity set is per-destination; stale roots are not destination ancestors) | n/a | n/a |
| 6 no global visited-set suppression | n/a | **holds** (active stack only; S5) | n/a | n/a |
| 7 explicit unresolvable-identity behavior | n/a | **specified** (warn/fail-closed) | silent | explicit budget error |
| 8 resource bounds stated | n/a | O(1) realpath per entry/target | n/a | the point, but incomplete |
| 9 proven vs best-effort separation | n/a | proven under stable-fs assumption; TOCTOU best-effort (§8) | best-effort | best-effort |
| 10 capability compatibility analysis | none needed | **required** (§6) | Node-only | none |

## 5. API-free versus API-requiring approaches

**No API-free mechanism meets the obligations.** What the current contract permits:

- Detecting that an entry *is* a link (`list` reports `symbolicLink`) — available.
- Following links (`stat`/`read` resolve) — available, and the hazard.
- Knowing *where a link resolves* as an identity — **unavailable**. `FileStat` has no
  inode/device/canonical path; `list` URIs are walk-path spellings; `stat` follows but
  returns no identity. A lexical guess at the target's identity is precisely the class
  of reasoning this document refutes (S8b: the plan spelling and the physical location
  disagreed; do not assume a lexical path or an ordinary `stat` proves canonical
  identity).

Without identity, the only API-free behaviors are: skip links (Option A — rejected),
warn about links (honesty without protection), or budget the walk (Option D —
mitigation). All three leave at least one executed escape open. Therefore the
source-preserving fix is **API-requiring**; the API-free set is exactly the recorded
best-effort fallback (§6).

## 6. Minimal API delta (requires approval; nothing implemented)

**One optional capability method on `ProjectFileSystem`**, plus a capabilities flag:

- `resolveIdentity?(uri: string): Promise<string>` — an opaque canonical identifier for
  the *resolved* target (adapter-defined format; engines compare opaquely). Absent =
  capability not offered.
- `PlatformCapabilities.resolvedIdentity: boolean` (mirrors the existing `symlinks`
  flag's role) so hosts can surface the limitation.

Why optional rather than mandatory: `vscode.workspace.fs` has **no realpath** — a
required method is unimplementable on the vscode.dev host (§1.3) and would break a
supported adapter. Node implements it with `fs.realpath` (one line); the memory test
filesystems implement it trivially (canonical key; `CaseInsensitiveFs` returns the
stored spelling, which is exactly what makes the case-variant collapse work without any
engine-side case logic).

**Core fallback when the capability is absent (specified, not implemented):** traversal
semantics are unchanged (no new silent omission — §5-A), and the walk emits an explicit
`OperationLogger` warn on every `symbolicLink` directory entry it dereferences, naming
the link and stating that alias-cycle/destination protection is unavailable on this
host. This converts today's silent exposure into an actionable one at zero semantic
cost. A fail-closed variant (refuse the copy) is the stricter alternative and is an
owner decision, not a recommendation of this record.

**Cost analysis for obligation 8:** one `resolveIdentity` call per directory entered and
per link target examined — O(tree size), no new recursion vector, no caching required
(per-operation lifetime). Budgets remain a test-harness device; no production budget is
selected by this record.

## 7. TOCTOU and filesystem-concurrency limitations

Every identity observation is a `resolveIdentity` (or `stat`) at one instant, and the
traversal happens later:

- **Link retarget window (executed, S7):** a link swapped between the identity check and
  the descent invalidates the observation. Hardening available within the contract:
  re-verify the entered directory's identity immediately after `list` and compare
  against the stack (catches the S7 shape at the next observation); **not** closable:
  the same race then moves between that verification and the child descents. Full
  closure needs atomic open-by-directory-handle semantics the contract does not have
  and `vscode.workspace.fs` cannot express.
- **Destination mutation window:** the destination identity set is computed at probe
  time; a concurrent replacement of a destination ancestor invalidates it. Same class,
  same residual.
- **Not claimable:** all-schedules correctness under concurrent alias mutation. The
  proven statement is: *under the stable-filesystem assumption (no concurrent alias
  retargeting during the operation), all executed escape classes close; under
  concurrency, the mechanism degrades to best-effort with an explicit unresolvable-
  identity path* — the same honesty split doc 14 §16.2 applies to its A1–A4 assumptions,
  and the reason obligation 10 is answered "conditional", not "proven".

## 8. Source-preservation requirements (what must keep working)

Pinned by existing permanent suites and this document's executed gates; any
implementation must keep all of them green:

1. `tests/unit/copytree-destination-exclusion.test.ts` — F23-R1 adoption bounds,
   F23-R2 exact trees/order-independence, F23-R3 exclusion precision
   (`staging/collide.lua`, prefix siblings, stale roots), F23-R4 all build paths,
   F23-R5 E1 boundary.
2. `tests/unit/copytree-case-alias.test.ts` — the full E1a-A…G matrix, including the
   case-sensitive distinct-path semantics (E1a-C) and the exact case-variant output
   trees (E1a-G). The `F23-E1a-SYM` block pins today's OPEN symlink behavior and
   must **fail loudly when a resolved-identity fix lands** (its own stated contract).
3. S5 semantics: two independent links to one directory both incorporated (no global
   suppression).
4. S1/S3-of-record semantics: links to external content incorporated, bounded.
5. E1-G / F23-R5: stale roots and adopted-root non-variant content still incorporated —
   the destination identity set must be per-operation and ancestor-scoped, never a
   blanket output-root mask (doc 14 §16.3's G3 correction 1 stands).

## 9. Residual unproven alias classes (F23 remains open)

- **Windows 8.3 short names** (`SYNCPR~1`): can alias any directory whose short names
  are enabled (per-volume configurable; default on for the system volume). Not
  executed — requires `fsutil 8dot3name` probing and a short-name-alias fixture;
  classified *unproven*, same hazard class as symlinks (identity-based containment
  would close it as a side effect, since the short name resolves to the same
  canonical target).
- **Other normalization aliases:** Unicode NFC/NFD divergence (macOS), Windows
  trailing-dot/space component quirks. Unproven, unexecuted; same disposition.
- **Concurrent alias mutation:** §7 — mechanism-relative residual, not a fixture gap.

This document does **not** mark F23 resolved: it establishes the identity requirements
the remaining classes share and the one capability that closes the executed set.

## 10. Independent CLI executor boundary

The CLI's `executeBuildPlan` (packages/cli/src/lib/commands/build.ts:50–80) routes
`copyTree` to `scaffoldProject` → `cpSync` (templateManager.ts:766–820): **no
destination exclusion at all** (doc 15 §4's recorded exposure), and — native evidence
N4 — **no dereference either**: `cpSync`'s default `dereference: false` recreates links,
which on Windows without symlink privilege is a loud mid-build `EPERM` failure with the
output left truncated. Consequences: (a) Core's destination exclusion and the CLI's
behavior are not merely different protections — they are different *semantics* for the
same source tree (Core: follow-and-embed; CLI: fail-EPERM or recreate-the-link); (b) any
Core identity mechanism does not reach this executor; CLI parity is its own gated
decision (doc 15 §11.5 already files the CLI-side F23 exposure as a sibling defect).
**No CLI executor change is authorized or proposed by this record.**

## 11. Permanent RED-first regression plan (for the implementation stage)

Every row names the gate to be written against the *post-fix* expectation (RED at
today's HEAD where marked), the harness, and the scenario it pins. The emulated suites
reuse `SymlinkFs`/`CaseInsensitiveFs`/`F23Fs` as-is; the native suite is guarded
(`describe.skipIf(!win32)`; skipped without junction privilege — recorded, not hidden).

| ID | Gate | Today | Green condition |
| :--- | :--- | :--- | :--- |
| F23-ID-R1 | S1/S5 preservation: links to external content incorporated through one and two independent links; bounded; no error | GREEN (pins current semantics) | stays green |
| F23-ID-R2 | S2a cycle: ancestor-cycle walk terminates with an explicit outcome (cycle tail not re-entered) and the non-cyclic content intact | RED (unbounded; budget-trip only via harness) | bounded without the test budget; cycle reported or skipped per approved policy |
| F23-ID-R3 | S3/S4/S8a/S8b destination re-entry: no destination content in the output beyond the plan, through any link/chain/junction-root alias, any listing order | RED (re-entry executed in all four) | no re-entry; exclusion via identity |
| F23-ID-R4 | S6/S4-alphabetical explicitness: dangling, EACCES and ELOOP links produce an explicit warn (or approved fail-closed error), never silent omission | RED (silent skips executed) | warn/error surfaces with the link named |
| F23-ID-R5 | S7 hardening: post-`list` identity re-verification detects a swap observed at check time | RED (stale observation honored) | swap detected at descent; residual window documented, not hidden |
| F23-ID-R6 | Case-variant non-regression: the full E1a-A…G matrix stays green; identity compare never case-folds | GREEN | stays green |
| F23-ID-R7 | Source preservation: F23-R3/R5, E1-G, `staging/collide.lua`, stale roots, prefix siblings | GREEN | stays green |
| F23-ID-R8 | Native guarded suite (real junctions × real `NodeFileSystem`): N1 bounded-with-report (not silent MAX_PATH truncation), N2 no re-entry, N3 incorporation | RED for N1/N2 | matches emulated R2/R3 on real NTFS |
| F23-ID-R9 | Capability absence: web-shaped fs (no `resolveIdentity`) keeps semantics and emits the explicit link warn | n/a (new surface) | fallback honest, no silent exposure |

## 12. Exact approvals required before any implementation

1. **Frozen-API exception (doc 13 §15 class):** the optional `resolveIdentity`
   capability + `PlatformCapabilities.resolvedIdentity` flag (§6) — the only surface
   delta this mechanism needs.
2. **Unresolvable-identity policy:** warn (recommended minimum) vs fail-closed (§2.5,
   §6).
3. **Cycle-tail semantics:** on refusing a cycle re-entry, the refused subtree is
   skipped with a warn — confirming this is a source-semantics statement (content
   behind a cycle is not incorporated), which only the owner can grant (it is the
   first sanctioned non-incorporation of reachable content).
4. **Defense-in-depth budget (optional):** whether an explicit-failure operation budget
   ships with the fix or never (§4-D).
5. **CLI parity** (§10): a separate defect decision; not part of any Core fix approval.

## 13. Implementation STOP decision

This record stops at the requirements boundary: **no Core, CLI, extension, harness or
contract change is made.** The harness additions used for the executed evidence were
disposable and are deleted before this commit. Implementation of anything in §6–§12
requires the §12 approvals and is a separate, owner-gated task.

## 14. Verdict

**`REQUIRES_FILESYSTEM_CAPABILITY_DECISION`.**

The smallest sound Core mechanism is Option B — a per-operation active-ancestor-stack
keyed by canonical directory identity, with the destination identity set extended to
ancestor-or-self of the resolved destination chain (executed refinement, S8a/S8b). It
is sound only if the filesystem contract exposes resolved directory identity, which it
today does not; the minimal delta is one optional capability method (§6) gated as a
frozen-API exception. Without that approval, the only available behaviors are
Option-A-shaped semantics changes (rejected: silent omission), adapter-local cycle
guards (insufficient: S3/S4/S8 are not cycles), and budget trip-wires (mitigation, not
correctness). All executed escape classes and the full evidence/limitation record are
in §3; the red-first path to implementation is §11.

---

*Pointer: doc 15 §7 records the case-variant escape and its fix boundary — its escape
attribution is refined, not rewritten, by the correction note appended there; doc 14
§16.3 remains the F23 classification of record.*
