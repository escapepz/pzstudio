# 18 — E1 Ownership Ledger & Cleanup Safety: Per-File Receipts, Digest Integrity, and the E1-B Decision Record (DR-E1-OB/PA)

**Status: decision record — Owner decisions recorded (O-series O-1…O-7;
design series D1–D12); documentation-only. Nothing here authorizes
implementation, and no capability, contract or source change is made or
approved. C11 remains frozen.**

Written at HEAD `44df635fb05d0cc082e4fe3de5dcb0ff9531b27b` (branch
`42.20.0-dev`). The working tree carries the six uncommitted Stage-1 files
(`packages/core/src/buildsession.ts`, `packages/core/src/mutation-guard.ts`,
four test files) and one untracked stray `$null`; all were left untouched —
Stage-1 remains **unapproved** and, per the standing operational rule,
excluded from commits. No source, test, harness, contract or configuration
file was modified for this record.

**Provenance.** The E1 ownership/path decisions below were taken through an
Owner review that produced draft decision records (v2→v4.1) **outside the
repository**; an independent read-only audit at this HEAD confirmed no
dedicated DR-E1-OB or DR-E1-PA file existed in the repository at its audit
point, and a fresh search at the time of writing confirms none exists. This
document is the **first in-repository record** of those decisions. Nothing
here is claimed to be recorded in Git history already; the decisions below
are recorded from the Owner's review instructions, not inferred from
implementation (none exists). A subsequent Owner review round approved the
design series D1–D12 (§2); those too are design-level decisions — the
implementation details each of them still leaves open are consolidated in
§10.

**Grounding audit facts (verified at this HEAD, read-only):** no per-file
ownership-evidence mechanism exists in production code (`copyTree` and
`executeFileOperations` return void — execute.ts:393, 506–595; the only
ownership record anywhere is the unapproved, volatile, subtree-granular
Stage-1 set, buildsession.ts:363); no rename/move or resolved-identity
capability exists in `ProjectFileSystem` (platform/src/index.ts:42–53);
`.pzstudio-rescue` exists only as design prose in doc 15; doctor has no
rescue or ownership diagnostic (doctor.ts:141–515). Everything in §2–§9
below is therefore **decided or proposed design, not implementation**.

---

## 1. Scope and relationship to prior records

- Doc 15 (`15-e1-output-adoption-safety.md`) remains the authoritative
  mechanism analysis: its §6 capture-then-adopt with provable-ownership
  preflight is the **selected design direction** (conversation option OB-C),
  with its §11 subordinate decisions now resolved as recorded in §2 — and,
  as reconciled by B2-B (§2), M2's automatic rescue-then-proceed execution
  is superseded: unowned findings abort (preserve, report), and rescue runs
  only as a user-initiated operation under O-6 and D8a.
- Doc 17 §11.4's alias-route scan (F23-WRITE P0) is implemented at this HEAD
  and untouched; doc 17's INV-D boundary — containment decides *where*,
  ownership decides *whether* — is preserved verbatim by this record.
- **Reconciliation with doc 15 §9/M3 (load-bearing):** doc 15 pins E1-E
  (user-modified engine-generated output is silently overwritten on rebuild)
  as accepted semantics. That acceptance is now **superseded for every file
  lacking valid ownership evidence**: a recorded file whose current digest
  differs must be preserved and reported (§3, I-DIGEST), and a receipt-less
  file is ownership-unknown and preserved in every flow including rebuild
  (§2 B1-A). A rebuild may regenerate only files whose evidence is valid
  (receipt with matching digest). A committed baseline is not substitute
  evidence, and handling legacy output requires a separately approved
  process that this record does not design.
- The rescue-folder base name selected here (§7) supersedes the provisional
  `.pzstudio-rescue` spelling in doc 15 §5-C, §6 M2 and the §9 table; doc 15
  carries pointer notes at §3, §5-A, §5-C, §6 M2, §8, §9 and §10 (§7 lists
  the sites). Doc 17 §11.3's Candidate D (staging) was never selected and is
  unaffected.
- The **D-series (§2, D1–D12)** records the second Owner decision round at
  design level. It extends — never replaces or weakens — the O-series and
  the invariants below.
- **M2 rescue vs I-UNOWNED (interplay of record):** doc 15 §6 M2's
  capture-then-adopt ("rescue, and the rebuild proceeds") and this record's
  I-UNOWNED (§4: non-empty output without valid ownership evidence is
  rejected before mutation) must be read together. I-UNOWNED forbids
  automatic *adoption, overwrite, cleaning, or recursive removal* of
  unowned content; the O-5/D8a rescue only ever *relocates and preserves*
  it under a verified-safe atomic rename, failing closed otherwise.
  Whether the relocation itself is permitted at first-time initialization
  of a non-empty, evidence-less output — or whether I-UNOWNED's
  "rejected before mutation" takes precedence there — is **decided by
  B2-B (§2)**: the rejection takes precedence. The pending batch aborts
  (preserve, report) and no automatic rescue relocation runs, at first
  initialization and everywhere else; §10 item 13 records the resolution.

## 2. Owner decisions (recorded)

Each item is **Owner-decided** unless marked otherwise. None authorizes
implementation.

### O-1 — Ownership evidence: per-file write receipts plus a content digest — DECIDED (A)

The future design must distinguish four states, and conflating any two of
them is a defect:

1. the **planned** list of files to be written;
2. files **actually written** successfully;
3. receipts **durably recorded** for successful writes;
4. current file content **verified against** its receipt.

A planned file list is not proof of ownership. A receipt must be associated
with an actual successful write operation. **SHA-256 is the proposed default
digest algorithm**, recorded explicitly in the receipt schema so future
versions can evolve without ambiguity.

Proposed receipt schema (design sketch, **not an implementation**): schema
version; project identity; output-root identity or other verified output
association; run ID; session ID where applicable; operation type (build,
watch, DevSync); canonical or safely resolved relative file path; content
size; digest algorithm and digest; write status and relevant completion
state.

A digest match alone does not prove ownership. Ownership requires
trustworthy evidence linking the receipt to a successful application write,
plus current authorization and boundary verification. If a receipt is
missing, corrupt, contradictory, or unverifiable, **preserve the affected
content**.

### O-2 — Cleanup boundary scope: the currently configured output root only — DECIDED (A)

E1-B cleanup must not expand its destructive scope to arbitrary abandoned
output roots merely because a prior build may have used them. Old output
roots outside the current authorized boundary must remain untouched by
E1-B; they **may** be reported by Doctor or another diagnostic mechanism
(design idea, not implemented). Any future cleanup of abandoned roots
requires a separate design decision.

### O-3 — Ownership granularity: per file — DECIDED (A)

A subtree-level claim may organize a scan, but it must **never authorize
recursive deletion by itself**. Before deleting any file, verify that the
specific file has sufficient ownership evidence, that its current content
matches the applicable receipt, and that its target lies within the
canonical shared mutation boundary (§6). Unknown or modified files must be
preserved. Do not recursively delete a directory merely because its parent
was previously generated by PZ Studio.

### O-4 — Interrupted cleanup: durable, resumable, idempotent — DECIDED (A)

The future design must support safe recovery after interruption:

- re-verify each candidate against the current filesystem state before
  acting;
- never assume a previous scan or recorded status remains valid after a
  crash;
- preserve files for which ownership or safety cannot be re-established;
- ensure a repeated cleanup cannot broaden the deletion scope or delete
  unrelated content;
- record progress sufficiently to diagnose incomplete cleanup and resume
  safely.

A file written successfully **before** its receipt is durably recorded is
unverified and must be preserved until ownership can be established safely.

### O-5 — Rescue directory name: `_backup` — DECIDED

The reserved rescue-folder base name is **`_backup`** (recorded exactly).

- Never overwrite, merge with, or automatically delete existing content
  whose ownership cannot be verified.
- Use collision-safe naming when a destination already exists.
- Retain rescue content until the user explicitly handles it; do not
  automatically purge it.
- Doctor must detect and report pending rescue content and explain the next
  step.
- A successful rescue must report the resulting path and item count.
- The rescue folder and its manifest are **not**, by themselves, proof of
  ownership for destructive cleanup.

The previously selected **atomic-rename-only** strategy is retained: if
safe atomic-rename conditions cannot be verified, fail closed. Copy-and-
delete is **not** introduced as an automatic fallback. The exact collision
suffix format may be specified in the design; no existing implementation or
filesystem API is claimed.

**Design consequences of the name (recorded, not yet designed):** `_backup`
is not dot-prefixed, so doc 15's dot-prefix invisibility argument
(invisible to `copyTree`'s `ignoreDotFiles` and to `classifyDelta`'s
dot-entry rule) **does not apply**; the design must instead specify an
explicit reserved-name exclusion from every copy, walk, classification and
planning path (§10). `_backup` is also far more collision-prone than a
tool-prefixed name — foreign user content at that name is likely, which
makes the never-overwrite/collision-safe requirements load-bearing.

### O-6 — Cleanup trigger: user-initiated, with preview and confirmation — DECIDED (B)

1. The user explicitly invokes clean.
2. PZ Studio validates the current output root, ledger, ownership evidence,
   and mutation boundary.
3. PZ Studio previews the intended deletion set **and** the items that will
   be preserved, including reasons.
4. The user confirms the proposed operation.
5. The executor revalidates relevant filesystem state and performs only the
   authorized mutation.

Automatic nested-garbage cleanup after a successful build is **not**
authorized.

### O-7 — Filesystem API design scope: design both capabilities — DECIDED (B)

This record may specify the proposed API requirements and safety guarantees
for: atomic rename/move for rescue operations; and resolved filesystem
identity with alias-aware containment where required. This is permission to
**document and review the design only** — not permission to modify
`ProjectFileSystem`, `PlatformCapabilities`, or any other source/API
surface. If required safety guarantees cannot be verified with available
filesystem capabilities, the future operation must fail closed.

### D1 — Ownership ledger location — DECIDED

The ledger lives at `<project-root>/.pzstudio/ownership-ledger/`.

- It is project metadata — not source content, not build output.
- It must be protected from ordinary mutation and never copied into
  output; build, watch/DevSync and clean must never overwrite, modify or
  delete it as ordinary output.
- Protection holds even when the output root is the project root.
- Dot-prefixing is **not** the protection mechanism (the D5 policy is).
- A metadata directory that already exists but whose content or state
  cannot be safely verified is not automatically overwritten or merged
  (preserve; report).
- The ledger is bound to project/output identity (D3).
- The ledger directory is **not** ownership evidence for any other file.

Placing the ledger inside the project does not by itself protect it from
copy, planner or executor paths — only the D5 exclusion does.
DESIGN DIRECTION DECIDED — storage format/schema and protection
enforcement mechanics remain open (§10 item 1).

### D2 — Journal and receipt protocol: journal-before, receipt-after — DECIDED (B)

1. Durably record a journal entry describing the intended operation.
2. Perform the file write.
3. Verify the actual result on the filesystem.
4. Compute SHA-256 over the content actually written.
5. Finalize and durably record the corresponding receipt.
6. A receipt is valid ownership evidence only after this completes and the
   required links verify.

The journal supports recovery and diagnosis only — it proves nothing by
itself. A crash before a valid receipt is durably recorded leaves the file
ownership-unverified, and it must be preserved.
DESIGN DIRECTION DECIDED — journal schema, durable-write protocol and
recovery algorithm remain open (§10 item 2).

### D3 — Project/output identity — DECIDED (C)

A stable project ID combined with resolved filesystem identity. Identity
required for a mutation must be verified according to the capability
actually available; if the required identity cannot be verified, fail
closed. The design distinguishes: project identity; output identity;
canonical path; resolved filesystem identity; and the provenance of the
output configuration. Canonical path alone never proves filesystem
identity, and resolved identity is not assumed to be determinable
uniformly on every platform.

### D4 — Rescue collision naming — DECIDED (C)

Reserved rescue destinations use `_backup-<timestamp>-<unique-suffix>`:
check for collision; if the name exists, try another by the collision-safe
rule; never overwrite, never merge, never automatically delete existing
content; a folder name is never ownership evidence. A rescue executes only
when the atomic-rename safety conditions are verified; otherwise fail
closed. Exact timestamp format, unique-suffix algorithm and retry bounds
are implementation details, not new invariants (§10 item 4).

### D5 — Reserved-path exclusion: centralized policy + exact scope, no registry — DECIDED

One centralized reserved-path exclusion policy. `copyTree`,
`classifyDelta`, the planner, authorization and every executor obey the
same policy; the executor re-checks before mutation and never relies
solely on the planner. The reserved scope is exact:

1. `<project-root>/.pzstudio/ownership-ledger/`
2. the reserved rescue destination `<output-root>/_backup/`
3. collision-safe rescue destinations within the defined reserved
   namespace.

No global `basename === "_backup"` rule: a non-reserved `_backup` folder
(for example `src/assets/_backup/`) is **not** excluded merely for sharing
the basename. No dot-prefix reliance. A reserved path is not ownership
evidence. Unverifiable path resolution or containment for the mutation at
hand fails closed. Because the Owner chose no registry, no database,
manifest registry or persistent registry may be added just to track
reserved paths. If a rescue destination cannot be recognized through the
decided path policy, ownership is not inferred — the content is preserved
and the limitation recorded. The reserved scope must not widen into a
blanket exclusion of user `_backup` folders.
DESIGN DIRECTION DECIDED — matching grammar and path-resolution edge cases
remain open (§10 item 5).

### D6 — Concurrency: hybrid lock + revalidation — DECIDED (C)

Conflicting mutations are coordinated by a lock, and ownership, digest,
identity, boundary and filesystem state are revalidated immediately before
the mutation. A lock proves no ownership and does not eliminate filesystem
change; when the state required for a safe mutation cannot be verified,
fail closed. DESIGN DIRECTION DECIDED — lock mechanism, scope and
stale-lock recovery remain open (§10 item 6).

### D7 — Doctor diagnostics: per-condition diagnostics — DECIDED (A)

Each condition gets its own diagnostic with: a stable diagnostic code; a
severity; the affected scope; the related path or resource where safe and
appropriate; the detection reason; and the permitted next action. At
minimum these conditions are distinguished: pending rescue; digest
mismatch; missing or unverifiable ownership evidence; missing, corrupt or
contradictory receipt; old output root; and filesystem or identity state
that cannot be safely verified. Doctor never automatically deletes rescue
content; reporting an old output root grants no mutation or cleanup
authority over it; and a diagnostic never claims ownership from a file's
name or location. DESIGN DIRECTION DECIDED — the diagnostic code catalog
and UX surfaces remain open (§10 item 7).

### D8a — Atomic rename: strict same-filesystem — DECIDED (A)

A rescue rename executes only when the same-filesystem condition and the
necessary atomic-rename conditions are verified. On `EXDEV` there is no
automatic fallback to copy + verify + delete. Unverifiable conditions
fail closed, and no substitute copy/delete procedure may be introduced.

### D8b — Resolved filesystem identity — DECIDED (B)

Resolved filesystem identity is used when the required capability is
available. Fallback applies only to non-destructive operations; a mutation
that needs unverified identity is refused. Confirmation never substitutes
for identity verification, and canonical path is never accepted as
identity evidence when identity is required. Capability and guarantee
verification per platform remains open (§10 item 8).

### D8c — Frozen API exceptions — DECIDED (B)

Each potential API exception is identified individually — the API, why the
change is needed, the safety guarantee it must achieve, and the impact on
callers — and each is approved separately before implementation. Describing
an exception in this record is not approval to implement it, and no frozen
API is changed by this record.

### D9 — Watch digest mismatch: read-only observation — DECIDED (C)

When Watch detects a file with a receipt whose current digest does not
match: (1) stop further mutations immediately; (2) notify the conflict;
(3) preserve the file; (4) continue observing and reporting in read-only
mode; (5) resume mutations only after an explicit user action and full
revalidation. Never automatically overwrite, restore or delete the
mismatched file. User confirmation does not substitute for ownership
verification, boundary enforcement or filesystem validation. The resume
protocol's details remain open (§10 item 9).

### D10 — Output-root migration — DECIDED (C)

No automatic receipt migration to a new output root. The old ledger is
kept for diagnostics; the new output root starts a separate scope;
receipts are not automatically transferred; the old output root is never
automatically cleaned up. Doctor may report the old output root, which
grants no mutation authority. Consistent with D3: receipts stay bound to
the matching project/output identity.

### D11a — Protected-path classification — DECIDED (C)

Protected paths are never inferred without a reliable source. A safety
decision that depends on a classification that cannot be verified fails
closed.

### D11b — Game-path classification — DECIDED (C)

Game paths are never inferred without a reliable source; no unverified
game path is hardcoded as if authoritative. A mutation that depends on
determining a game path that cannot be verified is refused.

### D11c — Output configuration authorization — DECIDED (C)

The sources of record are: `project.json`; workspace VS Code settings;
user settings; explicit global configuration; and the materialized
default `~/Zomboid/Workshop`. The design records the provenance of the
effective destination. Destinations from user/global/default sources — or
of unclear provenance — require extra user confirmation.
**Confirmation is not authorization**: after confirmation the independent
checks still apply (canonical mutation boundary; protected-path
classification; ownership evidence; receipt and digest; project/output
identity; filesystem state immediately before mutation), and any failure
still refuses the mutation. Confirmation never becomes a mechanism to
auto-adopt non-empty output.

### D11d — Safety checks: configuration-time and mutation-time — DECIDED (A)

Configuration-time checks provide early feedback; mutation-time checks are
mandatory. An old validation result never substitutes for revalidation.
Race conditions and TOCTOU are handled according to actual capability —
never claimed eliminated without evidence.

### D12 — Run-log retention and receipt protection — DECIDED (D)

Operational run logs and the ownership ledger have **separate storage
lifecycles**, and a **validation gate runs before any log rotation** to
guarantee that receipts still needed to verify existing files are not
deleted or lost. The five-run-log cap is retained, and receipts needed for
ownership verification are preserved independently of it. Two states are
distinct: (1) the *design* — lifecycle separation plus the rotation
validation gate — is approved; (2) the *enforcement mechanism* is not yet
designed or verified, so gate C-17 remains incomplete (§10 item 12). No
retention algorithm, ledger garbage-collection algorithm, or age-based
receipt deletion is chosen by this record.

### B1-A — Receipt-less files: ownership unknown, preserved — DECIDED

A file without a valid receipt — or other ownership evidence the Owner has
explicitly approved — is **ownership-unknown** and must be **preserved in
every mutation flow, including rebuild**. It is never automatically
overwritten, restored, deleted or rescued merely because it has an expected
name or sits in the output root. A build plan's file list is not ownership
evidence; a subtree claim never authorizes recursive deletion. A committed
baseline is **not** substitute ownership evidence — there is no default
exception for legacy or pre-ledger output. Handling legacy output (adopting
or migrating pre-ledger trees) requires a separately Owner-approved
process, which this record does not design. Consequence: doc 15 M3/E1-E
silent-overwrite semantics are superseded for **all** files lacking valid
evidence — a rebuild may regenerate only files whose ownership evidence is
valid (receipt with matching digest).

### B2-B — Preflight finding of unowned content: abort, preserve, report — DECIDED

When pre-mutation validation finds content without valid ownership
evidence: **abort the pending mutation batch before it starts, preserve the
content, and report the conflict and next steps**. Such content is never
automatically moved into `_backup` to bypass preflight; a successful rescue
never authorizes continuing the batch; a batch never continues merely
because content was rescued. Reports follow the D7 diagnostic schema
(path, reason, affected scope, permitted next action). This supersedes doc
15 §6 M2's automatic rescue-then-proceed execution everywhere — not only at
first initialization (resolving §10 item 13). User-initiated rescue remains
bound by O-6 and every current safety condition; B2-B grants no rescue
authority. Copy + manifest-verify + delete remains forbidden as a fallback
for unverified atomic rename (D8a). Digest-mismatch handling is unchanged
(I-DIGEST: notify, preserve, no automatic overwrite/restore/delete).

## 3. Invariant I-DIGEST: digest-integrity protection (mandatory)

Cross-cutting for build, watch/DevSync, and clean. If an existing output
file has a valid ownership receipt but its current digest differs from the
recorded digest:

1. notify the user immediately when the mismatch is detected;
2. identify the affected path and explain that its content differs from the
   recorded version;
3. do not automatically overwrite, restore, rewrite, or delete the
   mismatched file;
4. preserve that file for user review;
5. do not silently treat the mismatch as successful ownership verification;
6. do not update the receipt to the new digest merely to make the mismatch
   disappear.

A new digest may only be recorded after a separately authorized, successful
write operation, and only according to the approved receipt-update protocol
(protocol not yet designed — §10).

**Pre-mutation validation phase (mandatory):** the design must specify a
validation phase that runs before a mutation batch starts. If a mismatch or
unowned content is found during that phase, **abort the pending batch
before it starts** — do not partially modify the output and report the
conflict only afterward. Under B2-B (§2), an unowned-content finding aborts
the batch: the content is never automatically relocated to `_backup` to
bypass this phase, and a successful rescue never authorizes continuing the
batch.

**Running watch/DevSync sessions (D9 — read-only observation):** stop
further mutations immediately, notify the conflict, preserve the file, and
continue observing and reporting read-only; resume mutations only after an
explicit user action and full revalidation. Never automatically overwrite,
restore or delete the mismatched file; user confirmation is not a
substitute for ownership verification, boundary enforcement or filesystem
validation.

A digest match is **necessary** for a previously recorded file to pass the
content-integrity check, but **not sufficient** by itself to authorize
deletion or overwrite.

## 4. Invariant I-UNOWNED: reject unowned non-empty output (mandatory)

A non-empty output directory must not be treated as application-owned
merely because its path is configured as the output root or its file names
resemble expected build outputs.

**First-time output initialization**

- A missing or empty output directory may be considered for initialization
  only after path, identity, boundary, and filesystem safety checks pass.
- A non-empty output directory whose content lacks valid ownership evidence
  must be **rejected before mutation**; report the reason and affected
  paths where safe to do so.
- Do not automatically adopt, overwrite, clean, or recursively remove the
  existing content.
- Do not assume the directory belongs to PZ Studio because its name matches
  a project, mod, game, or output name.

This guard must protect against accidental targeting of: operating-system
files and directories; game installation files and directories; other
applications' files; user-created files; and files that merely share names
with the expected build output.

**Destination provenance (D11c):** the design must record which source
supplied the effective destination, and destinations from user/global/
default sources — or of unclear provenance — require extra user
confirmation. Confirmation is not authorization: after confirmation the
independent checks (canonical boundary; protected-path classification;
ownership evidence; receipt + digest; project/output identity; filesystem
state immediately before mutation) still apply, and a failure still
refuses the mutation. Confirmation never becomes a mechanism to auto-adopt
non-empty output.

**Existing output with a ledger**

The presence of a ledger does not establish ownership of every item in the
output root. The implementation design must define a complete pre-mutation
inventory classifying every item as exactly one of:

- valid receipt and matching digest;
- valid receipt but mismatched digest;
- missing or invalid receipt;
- unknown or contradictory ownership;
- rescue content;
- unsafe or unclassifiable path.

Unknown, unowned, or unverifiable content must never be silently claimed by
a broad output-root marker or subtree-level record. If the entire output
root cannot be inventoried safely, **fail closed**.

This invariant applies consistently to CLI build, watch/DevSync, clean, the
VS Code extension, and direct public Core executor callers
(`executeFileOperations` is public API — core/src/index.ts:14). **A UI
confirmation or a session-level guard is not a substitute for enforcement
at the shared mutation boundary and executor.** (Verified at this HEAD:
none of these entry points currently enforces anything like this — CLI
build/clean and executor-direct callers have no ownership concept at all.)

The ledger and the reserved rescue paths (D1, D5) are protected by the
same executor-level enforcement even when they lie inside the output root
or the project root: build, watch/DevSync and clean must never overwrite,
modify, delete or copy them as ordinary output.

**Legacy files (B1-A):** a file that predates the ledger and has no valid
receipt — for example a pre-existing `Workshop/poster.png` at a path a new
build expects — is ownership-unknown: it must not be automatically
overwritten, and the batch fails closed under the applicable preflight rule
(abort, preserve, report). This does not assume legacy output can never be
handled — handling it requires a separately Owner-approved process, which
this record does not design.

## 5. Shared ledger and run-log retention

**Ledger location (D1 — DECIDED):**
`<project-root>/.pzstudio/ownership-ledger/`. Project metadata — not
source content, not build output. Protected from ordinary mutation, never
copied into output, never overwritten/modified/deleted by build,
watch/DevSync or clean as ordinary output — including when the output root
is the project root. Dot-prefixing is not the protection mechanism (D5 is).
A pre-existing metadata directory whose content or state cannot be safely
verified is not automatically overwritten or merged (preserve; report).
Bound to project/output identity (D3); the ledger directory itself is not
ownership evidence for any other file. Placement inside the project does
not by itself protect it — only the D5 exclusion does.

**Journal and receipt lifecycle (D2 — DECIDED):** journal-before,
receipt-after — (1) durably record a journal entry describing the intended
operation; (2) perform the file write; (3) verify the actual filesystem
result; (4) compute SHA-256 over the content actually written; (5) finalize
and durably record the corresponding receipt; (6) a receipt is valid
ownership evidence only after this completes and the required links
verify. The journal supports recovery and diagnosis only — it proves
nothing by itself. A crash before a valid receipt is durably recorded
leaves the file ownership-unverified, and it must be preserved.

**Run logs** (operational): retain at most the latest **five** run logs per
a documented retention policy. Logs may summarize build/watch activity,
failures, and file counts.

**Retention architecture (D12 — DECIDED at design level):** operational
run logs and the ownership ledger have **separate storage lifecycles**, and
a **validation gate runs before any log rotation** to guarantee that
receipts still needed to verify existing files are not deleted or lost.
Receipts needed for ownership verification are preserved independently of
the five-log cap. Two states are distinct: (1) the *design* — lifecycle
separation plus the rotation validation gate — is approved; (2) the
*enforcement mechanism* is not yet designed or verified, so gate C-17
remains incomplete (§10 item 12). No retention algorithm, ledger
garbage-collection algorithm, or age-based receipt deletion is chosen by
this record.

**Ownership ledger** (durable evidence):

- shared by build, watch/DevSync, and clean;
- supports evidence across multiple runs and sessions;
- tracks per-file write receipts **independently of the five-log retention
  limit**;
- preserves evidence needed to evaluate files that still exist and may be
  candidates for cleanup;
- includes a safe lifecycle for stale receipts, deleted files, changed
  output roots (D10: no automatic migration — old ledger kept for
  diagnostics, new root a separate scope), interrupted writes, and
  concurrent runs (D6).

If evidence expires or is intentionally removed, the affected content
becomes **unverified** and must be preserved unless ownership can be
re-established through another approved mechanism.

**Metadata exclusion:** the ledger lives inside the project tree (D1), so
the D5 reserved-path exclusion policy must keep it out of every copy,
walk, classification and planning path — and that exclusion must be
specified and tested (§10 item 5). Metadata is never copied from source
into output.

## 6. Canonical shared mutation boundary

OB and PA use **one canonical mutation-boundary definition** across:
planning; authorization; executor enforcement; the CLI; VS Code commands
and task-provider flows; direct public Core executor callers; and build,
watch/DevSync, and clean. Ownership fields in a plan are **assertions of
intended scope, not ownership proof**; the executor must independently
verify evidence and authorization.

The boundary's enforcement supplements (all defined in §2): the
**centralized reserved-path exclusion policy** (D5 — one policy obeyed by
`copyTree`, `classifyDelta`, the planner, authorization and every
executor, which re-checks before mutation); **pre-mutation revalidation**
(D6 — ownership, digest, identity, boundary and filesystem state
reverified immediately before the mutation); and **resolved-identity
verification** (D8b — a mutation requiring unverified identity is
refused; canonical path is never accepted as identity evidence).

Settled constraints preserved verbatim in substance:

- Case-6 layouts remain supported; source and output do not need to be
  disjoint directory trees.
- Do not infer game-specific protected paths without an authoritative
  source of truth.
- Unclassifiable paths must be handled explicitly and conservatively.
- Symlink/alias, resolved identity, path traversal, TOCTOU, filesystem
  roots, and system paths must be addressed with honest, bounded safety
  guarantees.
- Rescue content is excluded from automatic cleanup.
- Unknown content is preserved.

Current code is **not** claimed to satisfy any of these; at this HEAD only
the alias-route containment (doc 17 §11.4 P0) is implemented, and the
unapproved Stage-1 guard covers session paths only.

## 7. Rescue folder `_backup` and name supersession

The reserved base name is `_backup` (O-5). This supersedes the provisional
`.pzstudio-rescue` spelling and the dot-prefix exclusion argument wherever
they appear in doc 15 — §5-C (Candidate C), §6 M2, §9 (compatibility
bullets and failure table), and §10 gate E1-R8 (updated in place to the
reserved-name exclusion). Doc 15 carries pointer notes at §3, §5-A, §5-C,
§6 M2, §8, §9 and §10; the dot-prefix-invisibility arguments there are
**retired**. An explicit reserved-name exclusion mechanism is required
instead (O-5's design consequences), and it must cover `copyTree` walks,
`classifyDelta`, planner inclusion, and the CLI executor's
`scaffoldProject`/`cpSync` path (none of which currently special-cases any
reserved name — verified).

**Collision naming (D4 — DECIDED):** reserved rescue destinations use
`_backup-<timestamp>-<unique-suffix>`: check for collision; if the name
exists, try another by the collision-safe rule; never overwrite, never
merge, never automatically delete existing content; a folder name is never
ownership evidence. The exact timestamp format, unique-suffix algorithm
and retry bounds are implementation details, not new invariants (§10
item 4).

**Rename strictness (D8a — DECIDED):** a rescue rename executes only when
the same-filesystem condition and the necessary atomic-rename conditions
are verified. On `EXDEV` there is **no** automatic fallback to
copy + verify + delete; unverifiable conditions fail closed, and no
substitute copy/delete procedure may be introduced.

## 8. Decision → consequence → acceptance mapping

| Item | Consequence (summary) | Checklist |
| :--- | :--- | :--- |
| O-1 receipts + digest | Per-file evidence; four-way state distinction; SHA-256 default recorded in schema | C-4, C-5, C-6, C-11 |
| O-2 current root only | Abandoned roots untouched by E1-B; Doctor may report them | C-15 |
| O-3 per-file granularity | No recursive deletion from subtree claims; unknown/modified preserved | C-3, C-7, C-9 |
| O-4 resumable idempotent cleanup | Crash-safe re-verification; write-before-receipt ⇒ preserved | C-11, C-12 |
| O-5 `_backup` | Reserved name; collision-safe; never auto-purged; rename-only, fail-closed | C-16 |
| O-6 user-initiated + preview | No automatic post-build cleanup; confirm before mutation | C-9 |
| O-7 capability designs | Rename/move + resolved-identity documented as designs only; fail closed when unverifiable | C-14 |
| I-DIGEST (§3) | Mismatch ⇒ notify, preserve, abort batch pre-start; watch halts; no silent receipt rewrite | C-5, C-10, C-13 |
| I-UNOWNED (§4) | Non-empty output without evidence rejected pre-mutation across all entry points | C-1, C-2, C-3, C-8 |
| Ledger/logs (§5) | Five-log cap never drops receipts; shared cross-run evidence; lifecycle defined | C-13, C-17, C-20 |
| Boundary (§6) | One definition everywhere; plan fields are intent, executor verifies | C-14, C-18, C-19 |
| D1 ledger location | `.pzstudio/ownership-ledger/` project metadata; protected, never copied | C-20, E-01, E-02 |
| D2 journal-then-receipt | Crash before receipt ⇒ unverified ⇒ preserved | C-11 |
| D3 identity model | Stable project ID + resolved identity; fail closed when unverifiable | C-14 |
| D4 collision naming | `_backup-<timestamp>-<unique-suffix>`; never overwrite/merge/delete | C-16, E-05 |
| D5 reserved-path policy | Centralized exact-scope exclusion; no basename blanket; no registry | C-19, C-20, E-03, E-06 |
| D6 concurrency | Hybrid lock + pre-mutation revalidation | C-13 |
| D7 doctor diagnostics | Six condition classes; never deletes rescue; no ownership claims | C-10, C-16 |
| D8a/b/c capabilities | Strict same-fs rename (EXDEV ⇒ fail closed); identity or refuse; per-exception approval | C-14, C-16 |
| D9 watch mismatch | Stop + read-only observation; resume after user action + revalidation | C-10, E-09 |
| D10 root migration | Old root out of scope; ledger kept; new root separate scope | C-15, E-10 |
| D11a–d PA | No inference without source; provenance + confirmation (never authorization); checks at config + mutation time | C-2, C-8, E-12 |
| D12 retention | Separate lifecycles + pre-rotation validation gate; five-log cap kept | C-17, E-11 |

## 9. Acceptance checklist (design criteria — to become RED-first gates at the implementation stage)

No tests were run or written for this record. Each row: setup → expected
behavior → invariant protected → status (**design requirement** = already
authorized by the decisions above; **needs Owner decision** = a §10 item
gates it).

| ID | Setup | Expected behavior | Invariant | Status |
| :--- | :--- | :--- | :--- | :--- |
| C-1 | First build into an empty, validated output directory | Initialization proceeds only after path/identity/boundary/safety checks pass; receipts recorded for successful writes | I-UNOWNED, O-1 | Design requirement |
| C-2 | First build into a non-empty directory with no valid ownership evidence | Rejected before any mutation; reason and paths reported | I-UNOWNED | Design requirement |
| C-3 | Output mixes valid owned files and unowned files | No silent adoption or deletion of unowned files | I-UNOWNED, O-3 | Design requirement |
| C-4 | Receipt exists and digest matches | Passes content-integrity check; deletion/overwrite still requires boundary + authorization (match ≠ ownership) | O-1, §6 | Design requirement |
| C-5 | Receipt exists and digest differs | Immediate notification; file preserved; batch aborted pre-start; no receipt rewrite | I-DIGEST | Design requirement |
| C-6 | Receipt absent, corrupt, stale, or contradictory | Affected content preserved | O-1 | Design requirement |
| C-7 | User-modified nested output content (receipt-covered or receipt-less) | Preserved and reported — supersedes doc 15 M3/E1-E silent overwrite for **every** file lacking valid evidence (mismatch per §3; receipt-less per §2 B1-A) | I-DIGEST, B1-A, O-3 | Design requirement |
| C-8 | File name matches a game/system/other-application file; ownership unproven | Not claimed; preserved; no name-based inference | I-UNOWNED | Design requirement |
| C-9 | `clean` with a mixture of eligible and ineligible candidates | Preview shows deletion set and preserved set with reasons; only confirmed set deleted after revalidation | O-6, O-3 | Design requirement |
| C-10 | Watch/DevSync detects a mismatch while running | Immediate notification; further mutations stopped; no auto-retry against the conflicting file | I-DIGEST | Design requirement |
| C-11 | Write interrupted before receipt persistence | File treated as unverified and preserved | O-4, O-1 | Design requirement |
| C-12 | Cleanup interrupted; safe retry | Idempotent resume; re-verification against current state; scope never broadens | O-4 | Design requirement |
| C-13 | Concurrent build/watch/clean operations | Ledger integrity maintained; no evidence loss or cross-run corruption (specific locking protocol unresolved) | §5 | Design requirement; protocol §10 |
| C-14 | Symlink/alias and path-identity ambiguity | Explicit refusal or conservative preservation; honest disclosure; fail closed when identity unverifiable | §6, O-7 | Design requirement; capability design §10 |
| C-15 | Current output root vs abandoned roots after configuration change | Cleanup touches current root only; abandoned roots untouched and reportable | O-2 | Design requirement |
| C-16 | Rescue folder `_backup`, including collision with existing foreign content | Foreign content never overwritten/merged/deleted; collision-safe naming; path + count reported; Doctor reports pending rescue | O-5 | Design requirement; suffix format §10 |
| C-17 | Five-run log rotation while receipts remain necessary | Rotation removes only run logs; receipts survive | §5 | Design requirement; D12 design approved, enforcement unverified — not completable until §10 item 12's mechanism is designed and verified |
| C-18 | CLI, VS Code command, task-provider, and direct Core executor paths | Identical boundary and ownership enforcement on every path (no bypass) | §6, I-UNOWNED | Design requirement |
| C-19 | Case-6 layouts | Remain supported; no disjointness imposed; regressions pinned against the F23/E1a suites | §6 | Design requirement |
| C-20 | Ledger metadata present during source-to-output copying | Never copied/walked/classified (mandatory tested exclusion) | §5 | Design requirement; exclusion mechanics gated by §10 item 5 (location decided by D1) |
| C-21 | Legacy file without a receipt at a path the build expects (e.g. `Workshop/poster.png`) | Not overwritten; batch fails closed — abort, preserve, report (§2 B2-B); ownership unknown (§2 B1-A); retry only after resolution and revalidation | B1-A, B2-B, I-UNOWNED | Design requirement |

### 9.1 Worked examples (design illustrations)

Each example separates the five concepts that must never be conflated:
**reserved path** (location policy), **ownership evidence** (receipt +
digest), **mutation authorization** (boundary + checks), **filesystem
identity** (resolved, capability-verified), and **user confirmation**
(interaction — never proof).

| ID | Scenario | What the design requires |
| :--- | :--- | :--- |
| E-01 | Ledger inside the project (`<project>/.pzstudio/ownership-ledger/`) | Reserved path (D1/D5): excluded from every copy/walk/classification; the executor refuses mutations into it even mid-build (ownership evidence is a separate question) |
| E-02 | Output root equals the project root | Reserved paths (ledger, `_backup`) still protected (§4, D1); the I-UNOWNED inventory still runs; nothing auto-adopts the project tree |
| E-03 | Legitimate source folder `src/assets/_backup/` | NOT reserved scope (D5 exact-scope rule; no basename blanket): ordinary source, copied and classified normally |
| E-04 | Reserved rescue folder at the output root (`<out>/_backup/`) | Reserved path; never copied into output; never auto-deleted; Doctor reports pending rescue and next steps (D7) |
| E-05 | Collision at `_backup` (foreign content already present) | Collision-safe `_backup-<timestamp>-<unique-suffix>` naming; foreign content preserved — never overwritten or merged (D4, O-5); the name is not ownership evidence |
| E-06 | Planner wrongly emits a mutation into a reserved path | The executor re-checks and refuses (D5): planner fields are intent, never proof (§6) |
| E-07 | Symlink/path alias makes identity or containment unverifiable | Mutation refused — identity unverified (D8b); user confirmation cannot substitute |
| E-08 | Crash before the receipt is durably recorded | File is ownership-unverified → preserved (D2, O-4); the journal aids diagnosis only |
| E-09 | Digest mismatch detected during Watch | Mutations stop; read-only observation continues; resume only after explicit user action + full revalidation (D9, I-DIGEST) |
| E-10 | Output root changed in configuration | Old root out of cleanup scope; old ledger kept for diagnostics; new root starts a separate scope (D10, O-2) |
| E-11 | Log rotation while receipts are still needed | The pre-rotation validation gate blocks receipt loss; the five-log cap applies to run logs only (D12) |
| E-12 | Destination supplied by user/global/default configuration | Extra confirmation required (provenance recorded) — then all safety gates still apply independently (D11c); confirmation grants no ownership |
| E-13 | Pre-ledger `Workshop/poster.png` at a path the new build expects | Ownership unknown (B1-A): preserved, batch aborted and reported (B2-B); never silently overwritten; future handling needs a separately approved process |

## 10. Open design and implementation questions (no answers invented)

Each item states what the Owner has already decided (design direction) and
what remains open. **DESIGN DIRECTION DECIDED — IMPLEMENTATION DETAILS
UNRESOLVED** marks exactly that split; plain **DECIDED** closes the topic
at design level.

1. **Ledger storage format** — location DECIDED (D1). The internal storage
   format/schema and the enforcement of its protection are open. DESIGN
   DIRECTION DECIDED — IMPLEMENTATION DETAILS UNRESOLVED.
2. **Journal schema, durable-write protocol, recovery algorithm** —
   lifecycle DECIDED (D2: journal-before, receipt-after); the schema,
   durable-write protocol and crash-recovery algorithm are open (including
   the receipt-update protocol I-DIGEST requires). DESIGN DIRECTION
   DECIDED — IMPLEMENTATION DETAILS UNRESOLVED.
3. **Project/output identity schema** — model DECIDED (D3: stable project
   ID + resolved filesystem identity, capability-verified, fail closed);
   the concrete schema and per-platform identity verification are open.
   DESIGN DIRECTION DECIDED — IMPLEMENTATION DETAILS UNRESOLVED.
4. **Collision naming details** — format DECIDED (D4); exact timestamp
   format, unique-suffix algorithm and retry bounds are open. DESIGN
   DIRECTION DECIDED — IMPLEMENTATION DETAILS UNRESOLVED.
5. **Reserved-path matching grammar** — policy DECIDED (D5: centralized,
   exact reserved scope, no registry, no basename blanket, no
   dot-prefix); the matching grammar and path-resolution edge cases are
   open. DESIGN DIRECTION DECIDED — IMPLEMENTATION DETAILS UNRESOLVED.
6. **Lock mechanism, scope, stale-lock recovery** — model DECIDED (D6:
   hybrid lock + pre-mutation revalidation); the concrete mechanism, scope
   and stale-lock protocol are open. DESIGN DIRECTION DECIDED —
   IMPLEMENTATION DETAILS UNRESOLVED.
7. **Doctor diagnostic code catalog and UX surfaces** — shape DECIDED
   (D7); the concrete catalog and surfaces are open. DESIGN DIRECTION
   DECIDED — IMPLEMENTATION DETAILS UNRESOLVED.
8. **Per-platform capability verification and frozen-API approvals** —
   directions DECIDED (D8a strict same-filesystem rename with EXDEV
   fail-closed; D8b identity-or-refuse; D8c per-exception approval
   process); per-platform guarantee verification and each API exception's
   approval remain outstanding and separately gated. DESIGN DIRECTION
   DECIDED — IMPLEMENTATION DETAILS UNRESOLVED (approvals not granted).
9. **Watch resume protocol** — behavior DECIDED (D9: read-only observation
   until explicit user action + full revalidation); the resume protocol
   details are open. DESIGN DIRECTION DECIDED — IMPLEMENTATION DETAILS
   UNRESOLVED.
10. **Output-root migration** — DECIDED (D10). No open implementation
    detail beyond D3's identity work.
11. **PA protected-path taxonomy and authoritative data source** —
    approach DECIDED (D11a/b: no inference without a reliable source, fail
    closed when classification is unverifiable; D11c: provenance recorded
    plus extra confirmation for user/global/default sources — never
    authorization; D11d: checks at both configuration time and mutation
    time). The authoritative data source and the concrete taxonomy list
    remain open. DESIGN DIRECTION DECIDED — IMPLEMENTATION DETAILS
    UNRESOLVED.
12. **Run-log rotation enforcement** — architecture DECIDED (D12); the
    enforcement mechanism is not yet designed or verified, so C-17
    remains incomplete. DESIGN DIRECTION DECIDED — IMPLEMENTATION DETAILS
    UNRESOLVED.
13. **First-initialization rescue precedence** — DECIDED by B2-B (§2):
    I-UNOWNED's rejection takes precedence. The pending batch aborts
    (preserve, report) and no automatic rescue relocation runs, at first
    initialization and everywhere else; doc 15 §6 M2's automatic
    rescue-then-proceed execution is superseded (§1).
14. **Planner-level ownership field (Owner decision required).** §6 of
    this record fixes only the *meaning* of plan ownership fields —
    assertions of intent, never proof. Whether to adopt a planner-level
    ownership field as part of the planner contract — and if so, its scope,
    its semantics, and the conditions of its frozen-API approval — is not
    decided. Doc 15 §8 row 2 / §11 item 4 record the historical proposal;
    D8c is the approval process, not an approval. No option is chosen here.
15. **DevSync variant-folder mutation contract scope (open).** Carried
    from doc 15 §11 item 2: whether variant-folder mutations are
    in-contract for DevSync remains separate and undecided (the destruction
    half of that item is superseded by B1-A/B2-B).

## 11. Verdict and STOP

**`DECISIONS_RECORDED__DESIGN_AND_IMPLEMENTATION_PENDING`.** The Owner
decisions O-1…O-7 and D1–D12 and the invariants I-DIGEST and I-UNOWNED are
recorded; the schemas, capability designs, and the open parts of every
§10 item remain design work; nothing is implemented. Implementation of any part of this record
requires a separate, explicit Owner authorization, a RED-first gate set
derived from §9, and the separate frozen-API approvals for any capability
it needs.

**STOP — this record authorizes none of:** any production source, test,
harness, contract or configuration change (none was made); any
`ProjectFileSystem`/`PlatformCapabilities` modification; any ledger,
receipt, digest, rescue or cleanup implementation; any change to Stage-1's
six uncommitted files or the `$null` stray; any unfreezing of C11; any
claim that current code satisfies §3–§7.

---

*Pointer: doc 15 §6 (capture-then-adopt, selected) and §11 (subordinate
decisions, resolved here as O-1…O-7); doc 17 §11.4 (implemented alias-route
containment, preserved) and §11.5 (pending capabilities, designed under
O-7); doc 16 §15.6 (identity capability decision, subsumed by O-7's design
scope); docs 13 §14.7 / DX-7 (C11) untouched.*
