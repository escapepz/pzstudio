# 17 — F23-WRITE Physical Mutation Boundary Safety: Write/Delete Redirection Through Filesystem Aliases

**Status: source-backed safety investigation (threat model + executed evidence +
gate design). Documentation-only; nothing here authorizes implementation, changes
any source-ownership semantics, touches the CLI executor, or relaxes any contract
recorded in docs 13–16.**

Written at HEAD `c3df6b4330018ecde6ea51e1526b8df23470130d` (branch `42.20.0-dev`,
tree clean). The UX-09 regression stash was identified by its descriptive message
("UX-09 red-first regression tests (A/B/C silent source-event loss, proven at
8967ada) - blocked on session-root contract", `stash@{0}`) and left untouched
throughout: never applied, never popped, never dropped, never renamed. Every
behavioral claim below was executed as a bounded, deterministic experiment against
the unmodified real Core engine (`planBuild` / `planModOperations` /
`planScopedModRebuild` / `executeFileOperations` / `BuildSession`) driven through
the real `NodeFileSystem` adapter on **real Windows NTFS directory junctions** in
per-test `os.tmpdir()` sandboxes (one fresh sandbox per experiment; junctions
created with `fs.promises.symlink(..., 'junction')` — no privilege required; Node
v22.22.2). A disposable recording adapter subclassed the real adapter to log the
**resolved physical landing** (`fs.realpath` at call time) of every write and
delete alongside the lexical plan-space path. The disposable experiment suite
(`tests/unit/f23-write-exp.test.ts`, 21 tests: A1–A7 including A3b, B1–B7
including B4-i…B4-iv, B-extra, B-native-baseline) ran green at this HEAD and was
deleted before this commit; both permanent F23 suites
(`copytree-destination-exclusion.test.ts`, `copytree-case-alias.test.ts`, 28
tests) ran green unchanged. Results are recorded verbatim.

**This document answers one question:** can Core build operations silently
overwrite or delete user-owned content **outside their intended physical output
territory** through symlinks, junctions, or other filesystem aliases — and what is
the smallest mechanism that prevents it. The executed answer is **yes, silently,
on every Core build path, up to wholesale deletion of the mod's own source tree**,
and the smallest sound mechanism is resolved-physical-path authorization at the
mutation sites, which requires the filesystem-identity capability already pending
in doc 16 §15.6 decision 1 — **no new API class beyond that pending decision**.

---

## 1. Physical write/delete threat model

### 1.1 Every mutating operation Core can issue (the exposure surface)

Derived from source at this HEAD. Each row is a place where the engine mutates the
filesystem at a **lexically computed plan-space path** with **no resolved-identity
check of any kind** on the target or its ancestor components.

| # | Site | Operation | Target path construction |
| :--- | :--- | :--- | :--- |
| M1 | `executeFileOperations` removeDir case (execute.ts:457–469) | `fs.delete(path, { recursive: true })` → `fs.rm(recursive, force, 5×200 ms)` | `removeDir` operation path verbatim (`outPath`, `outModsPath`) |
| M2 | `executeFileOperations` makeDir case (execute.ts:470–479) | write `.pzstudio-mkdir` sentinel + delete it | `joinPath(op.path, '.pzstudio-mkdir')` |
| M3 | `copyTree` file writes (execute.ts:404–407) | `fs.write` | **lexical plan-space join** `joinPath(destRoot, rel)` — `destRoot` is the plan's spelled destination; `rel` is walk-relative |
| M4 | `executeFileOperations` writeFile case (execute.ts:487–489) | `fs.write` | operation path verbatim (`mod.info`, `workshop.txt`) |
| M5 | `executeFileOperations` copyFile case (execute.ts:490–492) | `fs.write` | operation `to` path verbatim (`preview.png`) |
| M6 | `BuildSession.applyModFileIncremental` (buildsession.ts:642–648) | `fs.write` / `fs.delete(recursive)` | lexical join `outPath/Contents/mods/<id>/<relativePath>` per variant — **no walk, no exclusion, no ownership check** |
| M7 | `BuildSession.rewriteWorkshopText` (buildsession.ts:677–691) | `fs.write` | lexical join `<outPath>/workshop.txt` |
| M8 | `BuildSession.copyPreview` (buildsession.ts:704–710) | `fs.write` | lexical join `<outPath>/preview.png` |

`NodeFileSystem.write` (platform-node/src/node-file-system.ts:57–61) executes
`fs.mkdir(dirname, { recursive: true })` then `fs.writeFile` — **every path
component is resolved by the OS at call time**, so a junction at *any* component
between the configured outdir root and the file redirects the mutation. The web
adapter's `write` (`createDirectory(joinPath(target, '..'))` + `writeFile`) has
the same property on hosts that expose aliased directories.

### 1.2 Threat classes

| Class | Alias position | Who plants it | Race needed? | Executed by |
| :--- | :--- | :--- | :--- | :--- |
| T1 | Strictly **below** the configured outdir root, inside output territory | Any local process, prior tooling, user confusion | Full build: only in the post-`removeDir` window (T4). Scoped rebuild / incremental sync / executor-direct flows: **no race at all** | A1, A2, A3, A4b, A5, A6, A7, B5, B4-iii, B4-iv |
| T2 | **At or above** the configured outdir root (the user's own namespace) | The user (a legitimately junctioned outdir) | No | A4a, B7 |
| T3 | Below the outdir root, **pointing into the mod source tree** | Same as T1 | No (scoped/incremental) | A1, B4-ii, B4-iii |
| T4 | Alias **retargeted or inserted between an observation and a mutation** | Concurrent process | — (this is the race) | A6 (insertion), B6 (retarget) |
| T5 | Dangling alias (target missing) | Interruption, deletion | No | A3b, B-extra |

Class T2 is **not automatically an attack**: a user who configures
`outdir` at a junction has pointed the engine at a physical location and the
engine faithfully resolving it is *harmless alias resolution* (§4.2). The
unauthorized class is T1/T3: aliases the engine's plan never spelled, sitting
inside output territory, which move mutations **outside the resolved configured
root** or **into the source tree**.

### 1.3 Consequences

Every escape below executed with `errors: []` (or a completed build) and **no
warning** — silent unauthorized mutation of user-owned content, up to and
including deletion of the entire mod source folder (B4-ii). The only recovery is
external backup. This is a distinct hazard class from the read-side traversal
question (doc 16): source-traversal identity and destination-write authorization
are **different decisions at different sites** (§5, Gate C).

## 2. Deterministic reproduction matrix (executed evidence)

Method as in the header. Every fixture: fresh `mkdtemp` sandbox, standard case-6
layout (`proj/my_mod` source, outdir `proj/my_mod/gen`, variant folder
`Sync Project`, mod destination `…/Sync Project/Contents/mods/my_mod` = `D`),
source files `media/lua/hello.lua` = `hello-v1` (8 B) and `media/other.lua` =
`other-v1` (8 B), template `tpl/Contents/template-file.txt` = `tpl`. "physical"
paths are the `fs.realpath` landings the recording adapter logged at call time.
All landings are abbreviated `…` = `<sandbox>\`.

### Gate A — write redirection (real executor, real junctions)

| # | Scenario (fixture) | Executed result (verbatim) |
| :--- | :--- | :--- |
| A1 | Junction `D/media → <mod>/victimdir` (victim dir inside the mod source, user file `userfile.lua` = `USER-DATA`), `planModOperations` copyTree onto the pre-existing destination (no reset — the adoption/incremental shape) | **Source overwritten silently.** 7 writes. Lexical `D/media/lua/hello.lua` physically landed at `…\proj\my_mod\victimdir\lua\hello.lua` (8 B); lexical `D/media/other.lua` → `…\victimdir\other.lua` (8 B). `userfile.lua` = `USER-DATA` before and after (invaded, not overwritten — its overwrite is A5's shape). `mod.info` (40 B) landed at the real lexical destination. The junction **consumes the `media` segment**: everything written "under media" materializes in the target's root. `errors`: none — the executor completed |
| A2 | Junction `<outPath>/Contents/mods → <sandbox>/ext-victim` (outside the project; sentinel `keep.txt` = `EXT-KEEP`), `planModOperations` | **Entire mod tree materialized outside the output root, silently.** 5 writes, all landing under `…\ext-victim\my_mod\…` (`mod.info`, `media/lua/hello.lua`, `media/other.lua`, `modinfo-src.txt`, and the case-6 embedded `gen/...` copy). Lexical `Contents/mods` shape = `junction -> …\ext-victim`. Sentinel `EXT-KEEP` untouched |
| A3 | Junction `D/media → <dev variant's> my_mod_dev/media` (target pre-created), `planModOperations` (main) | **Main-variant writes landed in the development variant's territory, silently.** `…\my_mod_dev\media\lua\hello.lua` = `hello-v1`, `…\my_mod_dev\media\other.lua` = `other-v1`; main's own `mod.info` landed at the real main destination. Cross-territory pollution **inside** the same resolved outdir root — a resolved-outdir-root containment does NOT catch this class (§5-W1 territory decision) |
| A3b | Same junction shape with a **missing target** (`nowhere/at-all`) | **Writes fail loudly but cryptically**: first write through the alias throws `ENOTDIR: not a directory, mkdir '…\Contents\mods\my_mod\media'`; `executeFileOperations` aborts with 0 completed writes. On a full build the abort lands mid-plan (post-`removeDir`): truncated output + a message naming a path the user never typed. Contrast with deletion (B-extra): **deletes through dangling aliases are silent no-ops** — asymmetric failure behavior |
| A4a | Outdir root itself a junction: `gen → <sandbox>/gen-target`, target pre-contains `Sync Project/Contents/mods/legacy/userfile.lua` = `LEGACY-USER`; **full `planBuild`** | **Pre-existing target content destroyed; whole build landed in the target.** `removeDir('…/gen/Sync Project')` physically deleted `…\gen-target\Sync Project` (`LEGACY-USER` → `(absent)`); then 8 writes (mkdir sentinel, template, embedded copy, media, `mod.info`, `workshop.txt`) all landed under `…\gen-target\Sync Project\…`. `errors`: none. This is the E1 variant-folder reset applied at the alias-resolved location — faithful resolution of a user-configured junction outdir (T2), not a redirect outside the configured root |
| A4b | Junction `D/media → <outPath>` (destination ancestor), `planModOperations` | **Ancestor-level writes landed at the variant root, silently**: lexical `D/media/lua/hello.lua` → `…\Sync Project\lua\hello.lua`; `other.lua` → `…\Sync Project\other.lua`; `mod.info`/`modinfo-src.txt` at the real lexical destination. (Doc 16 ND6 re-confirmed with byte-level landings.) |
| A5 | Junction `D/media → <sandbox>/ext-victim5`, victim pre-contains `lua/hello.lua` = `USER-ORIGINAL-BYTES`, `planModOperations` | **User-owned file overwritten silently**: `…\ext-victim5\lua\hello.lua` = `USER-ORIGINAL-BYTES` → `hello-v1`. No error, no report |
| A6 | **Concurrent-insertion window**: full plan computed first; `removeDir`+`makeDir` executed; junction `D/media → <sandbox>/victim6` (contains `keep.txt` = `A6-KEEP`) planted **after** the reset, before the copy ops; rest of plan executed | **Redirection through the mid-plan insertion, silently.** Lexical `D/media/lua/hello.lua` → `…\victim6\lua\hello.lua`; `D/media/other.lua` → `…\victim6\other.lua`; template, embedded copy, `mod.info`, `workshop.txt` landed at the real lexical destination. `keep.txt` survived (invaded, not overwritten). The plan's own `removeDir` logged `(missing at delete time)` — a fresh build's reset is a silent no-op (`force: true`) |
| A7 | **Scoped rebuild through an existing ancestor alias**: junction `<outPath>/Contents/mods → <sandbox>/victim7` (pre-contains `my_mod/media/keep.lua` = `SCOPED-KEEP`); `planScopedModRebuild` = `makeDir(outPath)` + `removeDir(D)` + copyTree — **no intervening full-root deletion** | **Deletion through the ancestor alias + re-materialization inside the victim, silently.** `removeDir(D)` physically deleted `…\victim7\my_mod` (`SCOPED-KEEP` → `(absent)`); the rebuild then re-materialized the mod tree inside the victim (`…\victim7\my_mod\media\lua\hello.lua` = `hello-v1`, `mod.info`, …). `errors`: none |

### Gate B — recursive deletion through alias ancestors (real adapter, real `removeDir`)

| # | Scenario | Executed result (verbatim) |
| :--- | :--- | :--- |
| B1 | `removeDir` target **is** a junction (`b1-link → b1-target`, sentinel `B1-TARGET-KEEP`); plus a junction **child** inside a removed real tree (`b1b-real/junc → b1b-target`) | **Link-safe**: the junction is removed as a link (`shape: missing`); both targets and their sentinels byte-intact. Confirms doc 16 ND2/ND3 at raw-`fs.rm` level too (B-native-baseline: identical results) |
| B2 | `removeDir` target a normal directory whose **parent** is a junction (`b2-alias/child` where `b2-alias → b2-real`, `data.txt` = `B2-DATA`) | **Target-side content deleted**: recorded delete physical `…\b2-real\child`; `data.txt` → `(absent)` |
| B3 | **Higher ancestor** (two levels) of the destination is a junction, incl. **chained aliases** (`b3-alias2 → b3-alias → b3-real`): remove `b3-alias2/a/b/dest` | **Deep subtree deleted behind the alias chain**: recorded physical `…\b3-real\a\b\dest`; `deep.txt` → `(absent)`; sibling `dest2/deep2.txt` byte-intact |
| B4-i | Junction **inside** the removed tree pointing into the mod source (`D/media → <mod>/media`), remove `D` | **Source survives** (link-safe remove): the junction was removed as a link with its parent; `…\proj\my_mod\media\lua\hello.lua` intact. The destructive counterpart is B4-ii/B4-iii |
| B4-ii | Junction **ancestor** pointing at the project: `<outPath>/Contents/mods → <sandbox>/proj`; `removeDir(D)` — the scoped/full rebuild's reset target | **The entire mod source folder deleted.** `D` resolves to `…\proj\my_mod`; after: `media` shape `missing`, `hello.lua`/`other.lua` `(absent)`. Silent (`force: true` swallows nothing here — the deletion simply succeeds). The maximum-damage case: one junction at `Contents/mods` pointing at the project root turns every subsequent build's reset into source destruction |
| B4-iii | **Incremental sync delete through a planted alias**: real `BuildSession.start(['main'])` (clean build), then the real media dir replaced by a junction `D/media → <mod>/media` (the only way an alias can exist there — creation over an existing dir fails `EEXIST`), then `apply([{type:'delete', path:'…\\my_mod\\media\\lua\\hello.lua'}])` | **Source file deleted, `errors: []`.** Result `{"incremental":1,"scoped":[],"fullRebuild":false,"ignored":0,"errors":[]}`; `…\proj\my_mod\media\lua\hello.lua` → `(absent)`. The M6 delete path resolved the destination through the junction and removed the mod's own source file |
| B4-iv | **Incremental sync change through a junction to an external victim**: junction `D/media → <sandbox>/ext-victim-iv` (pre-contains `lua/hello.lua` = `VICTIM-BYTES`); `apply([{type:'change', path:'…\\my_mod\\media\\lua\\hello.lua'}])` | **Victim bytes overwritten, `errors: []`.** Result identical shape to B4-iii; `…\ext-victim-iv\lua\hello.lua` = `VICTIM-BYTES` → `hello-v1`. The M6 write path redirected build content onto user-owned external bytes |
| B5 | Junction to an **unrelated directory**: `<outPath>/Contents/mods → <sandbox>/b5-victim` (top-level `TOP-SENTINEL.txt` = `B5-TOP`; `b5-victim/my_mod/SENTINEL.txt` = `B5-SUB`); `planScopedModRebuild` | **Corresponding subtree removed; top-level sentinel survives; garbage written back inside the victim.** `removeDir(D)` physically deleted `…\b5-victim\my_mod` (`B5-SUB` → `(absent)`); `TOP-SENTINEL.txt` survived; the rebuild re-materialized the mod tree inside the victim. **Additional read-side-through-alias finding:** the copyTree walk listed `…/Contents/mods` (a case-6 destination *ancestor* the source contains) **through the same junction**, saw the victim's top-level content as source, and wrote `TOP-SENTINEL.txt` back inside the victim at `…\b5-victim\my_mod\gen\Sync Project\Contents\mods\TOP-SENTINEL.txt` — bounded at one generation by the lexical destination-chain exclusion (only walk-rel `…/Contents/mods/my_mod` matches the chain). Doc 16 §16.5 residual (b) executed with byte-level detail |
| B6 | **Alias replaced between ownership inspection and deletion**: list `b6-alias/child` (observed `["data.txt"]` — the OLD target), then retarget `b6-alias → b6-new` (contains `child/VICTIM.txt`), then `removeDir(b6-alias/child)` | **The NEW target is deleted.** Recorded physical `…\b6-new\child`; `VICTIM.txt` → `(absent)`; the observed OLD target byte-intact. Any decide-then-act guard — ownership scan, preflight, containment probe — is invalidated by replacement between its check and the mutation. Note: today there is **no** inspection at all (M1–M8); B6 demonstrates the race any future guard inherits |
| B7 | **Main and development variants sequentially, different alias states**: junction `gen → b7-target1` (pre-contains `Sync Project/Contents/mods/legacy/userfile.lua` = `B7-LEGACY`); full main build; junction retargeted `gen → b7-target2` (empty); full dev build | **Two physical territories from one config; legacy content destroyed.** Main: `removeDir('…/gen/Sync Project')` physically deleted `…\b7-target1\Sync Project` (`B7-LEGACY` → `(absent)`); all main writes landed in `b7-target1`. Dev: `removeDir` logged `(missing at delete time)` (silent); all dev writes landed in `b7-target2` (`workshop.txt` = dev_branch text). The alias state between sequential variant builds is unobserved by the engine |
| B-extra | `fs.rm` `force: true` through an ancestor alias at a **missing** target path (`bx-alias/not-there`) | **Silent no-op.** `(missing at delete time)`; target content intact. Deletion through a broken alias never fails — the exact asymmetry with A3b's loud write failure |
| B-native-baseline | Raw `fs.rm(recursive, force)` semantics pin, no adapter: (1) junction as rm target; (2) junction child inside removed tree; (3) through-alias ancestor | (1) link removed, target intact. (2) link removed with tree, target intact. (3) content behind alias deleted. The adapter executes exactly these OS semantics — M1's safety properties are Node's, not the engine's |

### Reachability map (which flow needs which exposure)

| Core flow | T1 (alias below outPath) | T2 (alias at/above outPath) | T4 (insertion window) |
| :--- | :--- | :--- | :--- |
| Full build (`planBuild`) | **Self-healing** — the plan's leading `removeDir(outPath)` removes planted links inside the variant folder (B1) before any write | **Exposed, no race** (A4a, B7) | **Exposed** — alias inserted after `removeDir`+`makeDir`, before the copy ops (A6) |
| Scoped rebuild (`planScopedModRebuild`) | **Exposed, no race** — `makeDir(outPath)` removes nothing; `removeDir(outModsPath)` follows any ancestor alias of the mod destination (A7, B5, B4-ii shape) | Exposed (resolves through) | Exposed |
| Incremental sync (`BuildSession.apply` M6–M8) | **Exposed, no race** — no removal anywhere on the path (B4-iii, B4-iv) | Exposed | Exposed |
| Executor-direct / adoption (`executeFileOperations` without reset) | **Exposed, no race** (A1, A2, A3, A4b, A5) | Exposed | Exposed |

## 3. Native evidence and its limits

- **What is native:** real NTFS directory junctions (the Windows directory-alias
  norm, creatable without privilege), the real `NodeFileSystem` adapter, the real
  Core planner/executor/session, per-call `fs.realpath` landings, byte-exact
  before/after reads at resolved physical paths, `lstat`/`readlink` shape probes.
- **Limits, recorded as such** (same honesty split as doc 16 §3):
  - Junctions are **directory aliases only**. Native file symlinks and POSIX
    were not exercised (symlink creation needs developer mode/admin on this
    host). A file symlink at a write-target component or a POSIX bind mount
    above it resolves by the same OS mechanics; the emulated equivalence is
    asserted, not executed. 8.3 short names remain unexecuted (doc 16 §9) —
    a short-name alias at an ancestor component resolves identically through
    the OS and defeats lexical containment by the same mechanism.
  - The A6 insertion and B6 retargeting are **deterministic interleavings**, not
    concurrent-schedule proofs. They demonstrate the window exists and is
    exploitable in principle; no all-schedules claim is made (doc 15 §7, doc 16
    §7 honesty split).
  - The recorded physical landing is the OS's resolution **for that call**
    (`realpath` taken immediately at the mutation); a concurrent retarget after
    the log entry is out of scope of the recording, as everywhere.
  - The **CLI executor was not re-executed** for this record. Its deletion
    (`removeDirRecursive`, helper.ts:243–266) is `rmSync(recursive, force, 5×200
    ms)` — the same OS call family the Node adapter wraps (B-native-baseline
    pins the raw semantics), so the B-class applies to `pzstudio build`
    verbatim; its copy path (`cpSync`, `dereference: false`) has different
    traversal semantics (doc 16 §3 N4: fails with EPERM on link-bearing
    sources) but the same ancestor-resolution properties for its writes. CLI
    parity is a separate gated decision (doc 15 §4, doc 16 §10); nothing here
    changes the CLI.

## 4. Ownership and path-identity distinctions

### 4.1 The five things that must not be confused (brief §6, instantiated)

1. **Lexical path selected by the build plan** — what M1–M8 compute
   (`joinPath`-space, config spellings, sanitized titles). The engine reasons
   exclusively in this space today.
2. **Resolved physical write/delete target** — what the OS actually touches
   after resolving every component (junctions, symlinks, short names). Executed
   divergence between (1) and (2) is the mechanism of every Gate A/B escape.
3. **Engine-owned generated territory** — content the engine wrote into variant
   folders of a committed output root (doc 15 §1 class 2); the E1-E overwrite
   semantics apply to it by accepted contract.
4. **Previously existing unowned content** — anything inside a claimed territory
   the engine cannot prove it wrote (doc 15 §1 class 3; E1's unproven class —
   A4a's `LEGACY-USER`, A7's `SCOPED-KEEP`, B5's sentinels).
5. **Mutations by concurrent external processes** — insertion/retargeting between
   observation and use (A6, B6). Priced, not closable, on today's contract.

**Filesystem containment is not a substitute for the E1 ownership policy.**
Containment (§5-W1) decides *where* a mutation may physically land; ownership
(doc 15 M1/M2) decides *whether* pre-existing content may be replaced at all.
A4a executed the difference precisely: the mutation stayed inside the resolved
configured root (containment-satisfied) and still destroyed unowned content
(`LEGACY-USER`) under today's delete-anything semantics. Neither mechanism
covers the other's failure class, and neither retroactively declares user
content engine-owned (doc 15 §1 boundary statements stand verbatim).

### 4.2 Harmless alias resolution vs unauthorized mutation — the boundary

- **Harmless (must keep working):** the user configures `outdir` at a path that
  happens to be a junction. The engine resolves it once, faithfully, and all
  territory semantics (variant-folder reset, E1-E overwrites) apply at the
  resolved location exactly as they would at the spelled location. Refusing
  such builds would violate "do not assume that every explicitly configured
  symlinked outdir is invalid". A4a/B7 executed this class; their *destruction*
  component is E1's problem (§4.1 item 4), not the alias's.
- **Unauthorized:** an alias **below** the configured outdir root that the plan
  never spelled, which moves any mutation outside the resolved configured root
  (A1, A2, A4b, A5, A6, A7, B5) or into the source tree (B4-ii, B4-iii), or
  across variant territories inside the root (A3). The authorized physical
  territory of an operation is **the resolved physical subtree of the
  configured outdir root** (permissive bound — T2 stays legal), with the
  **per-operation destination subtree** as the strict bound that additionally
  catches A3 (§5-W1, owner decision).

### 4.3 Operations targeting the alias itself vs descendants through an alias ancestor

Executed separation (the load-bearing asymmetry of `fs.rm`):

- **Alias as the deletion target or as a child of the removed tree** (B1, B4-i,
  B-native-baseline 1–2): the junction is removed **as a link**; target content
  is untouched. `fs.rm`'s own lstat-based link check covers exactly these two
  shapes.
- **Alias as an ancestor of the deletion target** (B2, B3, B4-ii, A4a, A7, B5,
  B7): `lstat` follows every component except the last, so the target **is** the
  real directory behind the alias and the recursive removal deletes through it.
  No engine-level or adapter-level check exists anywhere on this path.

Writes have no such split: `writeFile`/`mkdir` resolve every component through
every alias (M1–M8 all redirect). The doc 16 ND2/ND3 junction-self-delete results
therefore **cannot** be extended to dismiss ancestor-alias deletion — B2–B7
execute the difference.

## 5. Candidate mechanisms and counterexamples

Evaluation frame: each candidate states what it protects, what it does not,
its stable-filesystem assumptions, concurrent-retargeting behavior, crash/partial-
build effects, error visibility through `BuildSession`, Core vs CLI applicability,
required API changes, and false-failure risk on supported layouts.

### W1 — Resolved physical destination containment (the smallest sound mechanism)

**Mechanism.** Once per mutating operation (and per variant build), pin
`idOut = resolveIdentity(configured outdir root)` (lazy-pinned when the root is
fresh — the same lazy-pin rule doc 16 §15.2 specifies for the read side). Before
every mutating contract call (M1–M8), resolve the target's identity and require
it to be **equal to or canonically below** `idOut` at a component boundary
(Tier-2 ancestry test, doc 16 §15.4's path-form identity). Per-operation strict
mode: for M3/M4/M5/M6 the authorized root is the operation's own destination
subtree (`destRoot` / `outModsPath`), which additionally catches A3.

- **Protects:** every executed T1/T3 escape — A1, A2, A3 (strict), A4b, A5, A6
  (post-insertion writes resolve outside), A7, B4-ii, B4-iii, B4-iv, B5. The
  deletion half of A4a/B7 stays governed by E1 (§4.1).
- **Does not protect:** the T2 variant-folder reset at the resolved location
  (that is E1's M1/M2 territory); TOCTOU retargeting between authorization and
  mutation (§6); anything on hosts without the identity capability.
- **Stable-fs assumption:** identities are stable for the duration of one
  operation (doc 16 D1/D3: repeated calls stable; child writes do not change a
  directory's identity — executed in the read-side gates).
- **Concurrent retargeting:** authorized-at-call-time; a retarget after the
  check and before the OS call is the §6 residual. Narrowing (re-verify inside
  the adapter immediately before the native call) shrinks the window; nothing
  closes it without handle semantics (W6).
- **Crash/partial-build:** a refusal fires before the mutation → no partial
  destruction from the gate itself; the build aborts mid-plan exactly like
  today's lock errors (post-`removeDir` aborts are the existing failure shape).
- **Error visibility:** must surface an explicit error naming the operation, the
  lexical path, the resolved physical path and the policy reason — through the
  thrown error (→ `SessionApplyResult.errors` / CLI stderr), never a silent
  success. **A solution must not hide data loss behind successful `errors: []`
  results** — today every executed escape did exactly that.
- **Core vs CLI:** the checks live in `executeFileOperations` + `BuildSession`
  (Core). The CLI executor needs its own application of the same rule (or
  planner-carried territory data, doc 15 §8 row 2) — separate gated decision.
- **Required API changes:** **none beyond doc 16 §15.6 decision 1** — the same
  optional ancestry-comparable `resolveIdentity` + `PlatformCapabilities.
  resolvedIdentity` flag already pending for the read side. The new content is
  the check *sites* (the mutation loop and the incremental paths), not a new
  capability. On capability-less hosts (vscode.dev), the gate degrades per
  doc 16 §15.3/§16.4's executed fallback analysis — degradation is honesty
  (warn), not protection.
- **False failures:** none on alias-free trees (identity = lexical; every
  executed permanent-suite shape resolves inside its territory). Configured
  junction outdirs build normally under the permissive bound. Case-sensitive
  twins keep distinct identities (adapter-owned case semantics, doc 16 A4c).
  The strict per-operation bound must not be applied to the **embedding
  policy's** legitimate case-6 writes (`destRoot/gen/...` walk-rel paths) —
  those resolve inside the operation's own destination by construction
  (executed: the B5 embedding landed inside the alias target only because the
  *alias* moved it; without aliases the embedding resolves under `destRoot`).

### W2 — Pre-operation path authorization (plan-time scan/refusal)

Scan the planned territory for `symbolicLink` entries (`list` reports them) and
refuse or warn before executing.

- **Protects:** nothing beyond honest signaling. **Counterexample B6**: any
  scan-then-act guard is invalidated by replacement between scan and mutation;
  A6 defeats it by inserting after the scan. Scan-based refusal also
  false-fails legitimate alias-bearing layouts (doc 16 Option-A class) and
  cannot see aliases created inside the window.
- **Verdict:** at most a *reporting* complement (warn naming the link); never
  the mechanism. If shipped, enforcement must sit in the operation loop, not
  inside a contract method whose failures `resolveEntryType` maps to silent
  skips (doc 16 §16.4 caveat 2).

### W3 — Per-write destination-parent revalidation

Pin the resolved identity of each destination directory at first write;
re-verify before each subsequent write into it.

- **Protects:** mid-operation retargeting of an *already-used* directory (the
  doc 16 S7/D5 shape applied to writes).
- **Does not protect:** first use (A6's junction exists before any write through
  it — there is no prior observation), the between-check-and-use window
  (structural, §6), or any T1/T3 escape on its own (needs W1's containment to
  decide "outside").
- **Verdict:** a narrowing complement to W1, not a mechanism.

### W4 — Fail-closed unresolved destination identity

A mutation whose target identity cannot be resolved (dangling alias, EACCES,
ELOOP) refuses explicitly instead of today's asymmetric behavior (A3b's cryptic
`ENOTDIR` abort for writes; B-extra's silent no-op for deletes).

- **Protects:** converts both asymmetric failure modes into explicit, actionable
  errors naming the alias; closes the "silent no-op delete" hole (B-extra).
- **Does not protect:** anything that resolves (all of Gate A/B).
- **Verdict:** mandatory hygiene component of any approved gate; also the
  natural policy for the read side's unresolvable-identity decision (doc 16
  §15.6.3) — one decision, both sides.

### W5 — Operation-specific ownership checks (E1 M1/M2 composition)

Doc 15's capture-then-adopt with provable-ownership preflight.

- **Protects:** pre-existing unowned content from *deletion by `removeDir`* —
  and, as an incidental side effect only in the copy-form capture, content
  reached *through* an ancestor alias is copied out before deletion (the
  capture reads through the same alias), reducing A7/B5-class damage to
  relocation.
- **Does not protect:** write redirection (A1/A2/A3/A4b/A5/A6 — overwrites are
  not `removeDir` and have no capture); single-file incremental deletes
  (B4-iii — M1/M2 are removeDir-shaped); the mod-source deletion's *write* half;
  anything on the M6–M8 paths.
- **Verdict:** orthogonal and composable — W1 decides where, M1/M2 decide
  whether. Neither substitutes for the other; approving one is not approving
  the other.

### W6 — Directory-handle-based operations (openat-style)

Authorize once by opening the authorized territory root as a handle; perform all
mutations relative to the handle so ancestor retargeting between check and use is
impossible by construction.

- **Protects:** the complete TOCTOU class — the only candidate that does.
- **Feasibility:** **not implementable on today's contract** (`ProjectFileSystem`
  is path-string-only) and not expressible through `vscode.workspace.fs` (no
  handle primitives); Node's `fs.promises` exposes no openat-family surface the
  adapter could wrap without dropping the contract's URI opacity. Requires a
  new capability that does not exist today and is out of scope of every pending
  decision (doc 16 §15.6). Recorded as the *complete* closure so the residual of
  W1+W3+W4 is stated precisely, not as a proposal.

**Comparison:**

| Property | W1 containment | W2 scan | W3 revalidation | W4 fail-closed | W5 ownership (E1) | W6 handles |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Closes A1/A2/A4b/A5/A7/B5 redirects | yes | no (racy/false-fail) | no | no | no | yes |
| Closes A3 (in-root cross-variant) | strict mode only | no | no | no | no | yes |
| Closes B4-ii/B4-iii/B4-iv | yes | no | no | no | B4-iii: no | yes |
| Closes A6 window | yes (at write time) | no | partially | no | no | yes |
| Closes B6 retarget race | no — narrows only | no | narrows | no | no | **yes** |
| Silent loss possible | no (must error loudly) | yes | yes | no | capture-form: no | no |
| Needs new capability | doc 16 §15.6.1 only (pending) | none | doc 16 §15.6.1 | none | doc 15 §8 (pending) | **new, not specified anywhere** |
| False-fails supported layouts | no (permissive bound) | yes | no | no | no | no |

**Smallest mechanism statement:** W1 (permissive resolved-outdir containment,
strict per-operation for copy destinations) + W4 (fail-closed unresolved) +
W3 (revalidation narrowing) is the minimal set that converts every executed
silent escape into an explicit, actionable failure without breaking any
supported layout — and it requires **no filesystem API beyond the already-pending
doc 16 §15.6 decision 1**. The §6 race residual and the vscode.dev degradation
are disclosed, not hidden.

## 6. Check-to-mutation races (executed)

- **No preflight check eliminates concurrent alias replacement.** B6 executed
  the generic shape: a `list`-based inspection observed the old target
  (`["data.txt"]`); a retarget before the deletion made the deletion destroy the
  new target's content while the inspection's target stayed intact. Any
  decide-then-act guard — ownership scan (doc 15 §5-A), marker verification
  (doc 15 §5-B), containment probe (W1), revalidation (W3) — inherits exactly
  this window between its last observation and the OS call.
- **The insertion window is the same race from the other side** (A6): the
  destination is verified-empty by the plan's own `removeDir`, then an alias is
  inserted before the writes. W1 catches it *at write time* (the redirected
  write resolves outside); no *pre-write scan* can.
- **What narrows:** re-verification at the mutation site (W3), or adapter-local
  resolution immediately before the native call, shrink the window to the
  inter-call gap; repeated narrowing shifts the race rather than closing it
  (doc 16 §7/D5's honesty split, now executed for writes/deletes).
- **What closes:** handle-relative operations (W6) — unavailable on the current
  contract and on `vscode.workspace.fs`. Until then, **no all-schedules
  correctness claim is made for any candidate**, including W1; the proven
  statement is *authorized-at-the-moment-of-resolution*, with the residual
  disclosed in user-facing failure semantics.

## 7. Interaction with E1 (doc 15)

- **Independent obligations, composable mechanisms.** E1's M1/M2 decide whether
  pre-existing content inside a claimed variant folder may be replaced; the
  W1 boundary decides where any replacement may physically land. Executed
  decomposition of A4a: the alias moved the territory (alias problem) AND the
  reset destroyed unproven content inside it (E1 problem). Fixing either alone
  leaves the other's half destructive.
- **E1-M2's incidental alias mitigation, stated with its limits:** in the copy
  form, a capture-then-adopt rescue executed through an ancestor alias reads
  and preserves the victim's content before deletion (relocation, not loss) —
  but only for `removeDir` flows, only in capture form, and never for write
  redirection (A5 class) or single-file incremental deletes (B4-iii). E1
  approval must not be justified by this side effect.
- **No ownership redefinition.** Nothing here classifies user content as
  engine-owned (doc 15 §1 boundary statements), extends the E1 exclusion, or
  touches strict-S1/UX-09. The T2 boundary decision (§5-W1 permissive vs
  strict) is a filesystem-territory decision and does not presage the E1
  prevent/accept/scope-out decision (doc 15 §11.1), which remains open.
- **Doc 16 §16.5's residual (b) is now executed** (A1/A6/B5 with byte-level
  landings) and its "write-side gate is its own design and approval task"
  statement is honored by this document's STOP boundary (§10).

## 8. Minimal permanent RED-first gates (for the implementation stage)

Each gate is written against the post-fix expectation and fails at today's HEAD
where marked. Harness: the disposable recording-adapter pattern of this record
(real junctions, real adapter) or an emulated `resolveIdentity` over the F23
harnesses for CI portability (the emulated and native classes must agree, as in
doc 16 §16).

| ID | Gate | Today | Green condition |
| :--- | :--- | :--- | :--- |
| F23-WB-R1 | Copy redirect outside the resolved outdir: planted destination alias (A1/A2/A4b/A5/A6 fixtures) — the executor fails explicitly naming the operation, lexical path and resolved physical path; victim bytes byte-identical | RED (silent redirect; `errors: []`) | explicit error; no victim mutation |
| F23-WB-R2 | Cross-variant redirect (A3 fixture) refused under the owner-approved territory bound | RED (silent) | per §9 decision 2 |
| F23-WB-R3 | Scoped rebuild through an ancestor alias below the outdir (A7/B5 fixtures) — explicit failure; `keep.lua`/sentinel bytes intact; no re-materialization inside the victim | RED (silent deletion + re-materialization) | explicit error; victim untouched |
| F23-WB-R4 | Incremental delete through a planted alias (B4-iii fixture) — source file survives; explicit error or reported no-op | RED (source deleted, `errors: []`) | source intact; failure visible in `SessionApplyResult.errors` |
| F23-WB-R5 | Incremental write through a planted alias (B4-iv fixture) — victim bytes intact; explicit error | RED (victim overwritten, `errors: []`) | victim intact; failure visible |
| F23-WB-R6 | Full build with a **configured junction outdir** (A4a fixture, permissive bound) — build succeeds, resolves faithfully; the variant-folder reset at the resolved location follows the E1 decision (today: deletes — pinned as documented boundary until E1 is approved) | GREEN today (must stay green under the permissive bound) | unchanged behavior; strict-bound variant is decision-gated (§9.2) |
| F23-WB-R7 | Dangling alias: deletes are explicit reported no-ops (never silent, B-extra); writes fail with an actionable message naming the alias (A3b's `ENOTDIR` message is replaced) | RED (silent no-op / cryptic message) | explicit, actionable, alias named |
| F23-WB-R8 | Race disclosure: a retarget between authorization and mutation is detected by the re-validation narrowing (W3) and reported when observed; the residual window is documented in the failure semantics, never claimed closed | RED (no observation exists) | detected-when-observable + documented residual |
| F23-WB-R9 | Preservation matrix: alias-free case-6 builds byte-identical (both permanent suites), `staging/collide.lua` incorporation, stale roots, E1a-C case-sensitive twins, S1/S5-style legitimate source links — all unchanged by the write gate | GREEN (28 permanent tests) | stays green; no new false failures |
| F23-WB-R10 | Capability absence (vscode.dev shape): mutations proceed with an explicit host-limitation warning per the approved fallback policy; no silent exposure added | n/a (new surface) | honest degradation per doc 16 §15.3/§16.4 as corrected |

## 9. Required owner decisions

1. **Adopt the write-boundary gate (W1+W3+W4) as a Core safety requirement.**
   This record does not implement or pre-approve it. The gate reuses the
   **pending** doc 16 §15.6 decision 1 capability (ancestry-comparable optional
   `resolveIdentity` + `PlatformCapabilities.resolvedIdentity`) — **no new API
   class**; the frozen-API exception remains the one already queued.
2. **Authorized-territory bound** (changes A3/R2 outcomes): permissive
   (resolved configured outdir root — configured junction outdirs keep working;
   cross-variant A3 stays legal) vs strict per-operation destination subtree
   (catches A3; must then carve out the embedding policy's legitimate case-6
   writes, which resolve inside the operation destination by construction) vs
   **hybrid (recommended): outdir-root bound for reset operations, per-operation
   bound for copy/write destinations**.
3. **The T2 class** (alias at/above the configured root): confirm that faithful
   resolution is the accepted semantics (recommended — refusing configured
   junction outdirs would break supported setups) and that the *destruction*
   inside the resolved location remains governed exclusively by the E1 decision
   (doc 15 §11.1), not by this gate.
4. **Unresolved-identity policy at mutation sites** (W4): fail-closed error
   naming the alias (recommended; deletes must never silently no-op through
   broken aliases) vs warn-and-proceed. Should be decided **together with**
   doc 16 §15.6.3 (read-side unresolvable identity) as one policy.
5. **TOCTOU posture:** accept the authorize-at-resolution residual with
   documented, user-visible failure semantics (recommended; W6 is out of scope
   of every pending decision) or defer the gate until handle semantics exist.
   No all-schedules claim either way.
6. **CLI parity** (helper.ts `removeDirRecursive` / `scaffoldProject`): the B-class
   applies to `pzstudio build` through the same OS semantics; a CLI-side gate is
   a separate defect decision (doc 15 §4/§11.5, doc 16 §10 disposition stands).
7. **Whether any API-free stopgap ships before the capability decision**
   (scan-and-warn in the operation loop, W2-shaped): recommended only as an
   explicit host-limitation warning, never as protection, and never inside a
   contract method whose failures the engine maps to silent skips (doc 16
   §16.4 caveat 2).

## 10. Exact implementation authorization boundary

**This record is documentation-only.** No production source, contract, harness
or test file was modified; the disposable experiment suite and all sandboxes were
deleted before this commit. Any future implementation requires, at minimum:

- the §9.1 approval of the gate itself and the §9.2–9.4 policy decisions;
- the (independently pending) doc 16 §15.6.1 frozen-API exception for
  `resolveIdentity` — approving this document approves **no API change**;
- explicit confirmation that the check sites are the executor mutation loop
  (`executeFileOperations`: M1–M5) and the session mutation paths
  (`BuildSession`: M6–M8), with error surfacing through the existing
  `OperationLogger` + `SessionApplyResult.errors` / CLI stderr channels;
- the preservation matrix (F23-WB-R9) green before and after;
- a separate, explicit decision for CLI executor parity (§9.6).

Explicitly **not** authorized or proposed by this record: any F23 read-side
implementation (doc 16 §15.6 decisions remain open on their own), any E1
quarantine/capture implementation, any ownership redefinition, any
`resolveIdentity` API addition, any DX-13/reconciliation work, any Contract A
change, any UX-09 filtering change, and any change to the CLI executor.

---

## Verdict

**`WRITE_BOUNDARY_DESTRUCTIVE_ESCAPE_CONFIRMED`.**

Core build operations silently overwrite and delete user-owned content outside
their intended physical output territory through directory junctions, on every
Core path (full build, scoped rebuild, incremental sync, executor-direct), with
`errors: []` and no diagnostic — executed with byte-level before/after evidence
at resolved physical paths (§2). The executed maximum: a single junction at
`<outPath>/Contents/mods` pointing at the project root converts every build's
reset into **deletion of the entire mod source folder** (B4-ii); an outdir-root
junction converts a full rebuild into deletion of pre-existing target content
(A4a, B7); a planted media junction turns incremental sync into source-file
deletion and external-overwrite (B4-iii/B4-iv). The escapes are independent of
the read-side proof: assuming a perfectly protected (Tier 2) source walker
prevents none of them — `copyTree`'s writes, the executor's `removeDir`, and the
session's incremental mutations authorize **lexical** paths while the OS resolves
**physical** ones, and no identity check exists at any mutation site (Gate C:
the two proof obligations are independent). The smallest sound mechanism is
resolved-physical containment at the mutation sites plus fail-closed unresolved
identity (W1+W4, W3 as narrowing), which requires **no filesystem capability
beyond the already-pending doc 16 §15.6 decision 1**; the check-to-mutation race
and the capability-less host degradation are disclosed residuals (§6), closable
in full only by handle-relative operations that no current contract can express
(W6). The write-boundary protection itself is an owner decision (§9) — nothing
in this record implements it.

## 11. Follow-up: the physical mutation authorization contract — decision package

**Status: documentation-only architecture-decision record appended to the
write-boundary investigation. Nothing here implements, pre-approves
implementation, changes any API surface, or touches the CLI executor.** Written
at HEAD `7ed2998a5a67ff304928b3eb1613d95e9f2367ef` (branch `42.20.0-dev`, tree
clean apart from this appendix). The UX-09 regression stash was identified by
its descriptive message (`stash@{0}`, as in the header) and left untouched:
never applied, popped, dropped or renamed. The 21 executed F23-WRITE
experiments of §2 are preserved verbatim and were **not** repeated — every
behavioral claim below cites §2's record or the sources as they stand at this
HEAD, where all eight mutation sites were re-verified in place (M1
execute.ts:457–469, M2 470–479, M3 404–407, M4 487–489, M5 490–492; M6
buildsession.ts:630–653, M7 662–695, M8 697–716; `NodeFileSystem.write`
node-file-system.ts:57–61, `delete` 63–73; web `write`
workspace-file-system.ts:35–41, `delete` 43–48). Exactly one new bounded probe
was executed, for a fact no prior record pins and one decision below depends
on: Node v22.22.2's `fs.readdir(dir, { withFileTypes: true })` reports a real
NTFS directory junction as `isSymbolicLink: true` / `isDirectory: false`
(while `stat` follows it, `isDirectory: true`) — so the Node adapter's `list`
surfaces junctions as `symbolicLink` entries (the adapter maps
`entry.isSymbolicLink()` → `type: 'symbolicLink'`, node-file-system.ts:91).
The probe sandbox and script were deleted after the run.

The question this package answers: **what physical authorization invariant
must Core's mutating operations satisfy, which candidate mechanism implements
it at which cost, what is the smallest interim protection available without
any API change, and what must the owner decide before any of it is
implemented.**

### 11.1 The physical mutation authorization invariant

The invariant is stated over five classes the design must never conflate (the
§4.1 five-way split, made normative):

**INV-A — the configured output root and its resolved physical target.** The
territory anchor is the configured outdir root as spelled (`R_lex =
config.outdir`, resolved per variant by `resolveBuildOutputPath`). Resolution
of `R_lex` itself through an alias at or above it is **accepted semantics**
(T2, §4.2): the resolved physical location `R_phys` is where every territory
semantics (variant-folder reset, E1-E regeneration) applies, exactly as it
would at the spelled location. Authorization never inspects `R_lex` itself or
any component at or above it: **a user-configured junction outdir is
intentional alias resolution and must not be classified as an escape.** What
the reset then destroys inside `R_phys` (A4a's `LEGACY-USER`, B7's
`B7-LEGACY`) is ownership territory (INV-D) — never an authorization question.

**INV-B — the generated territory an operation is authorized to mutate.** A
mutating operation is authorized iff, at its last observation before the OS
call:

1. **Ancestor condition.** Every path component **strictly below** `R_lex` on
   the operation's lexical target path (for deletes: excluding the target
   itself) exists — or is created fresh by this very operation — as a
   **non-alias** entry: no component resolves through a `symbolicLink`-typed
   entry of its parent directory (lookup per the `resolveDestinationChain`
   witness rule: exact name match wins; a unique case-insensitive match counts
   only where a `stat` of the plan spelling succeeds, execute.ts:296–318).
2. **Leaf condition (operation-specific).** For writes, the final component
   either does not exist (fresh creation inside an authorized parent —
   in-territory **by construction**) or exists as a non-alias entry inside
   territory. **For deletes, the leaf may be an alias entry** — removing the
   link is leaf-local and link-safe (B1, B4-i, B-native-baseline 1–2).

Under these two conditions the OS cannot resolve the mutation outside the
lexical subtree of `R_lex`: case-insensitive folding maps a name onto another
name **in the same directory**, 8.3 short names alias only within the same
parent, and every out-of-subtree resolution mechanism executed in §2 is an
alias entry in some parent listing. This is the **permissive bound**
(resolved-outdir-root containment, §5-W1); the strict per-operation
destination-subtree bound remains the §9.2 owner option. Note that these scan
semantics are **stronger than W1-permissive on one class**: any alias route
below the root is refused even when its landing would stay inside the root
(A3), because the invariant authorizes **routes**, not only landings.

**INV-C — legitimate source content inside supported overlapping layouts.**
The invariant governs only where mutations **land**. What the copyTree walk
**reads** remains governed by the accepted inclusion policy and the
destination-subtree exclusion (execute.ts:275–354): `staging/collide.lua`
incorporation (F23-R3/E1a-F), stale-root preservation (F23-R1), case twins
(E1a-C), dual alias routes (S5) and the embedding policy are untouched. None
of the supported classes requires an alias on a **mutation path**: the
legitimate source-link class (S1/S5) lives in the source tree, which the
invariant never inspects. The invariant introduces **no source-ownership
statement of any kind** — it must not be implemented as a widening of the
destination exclusion (no implicit Contract B / E1-exclusion), and it must not
filter or reclassify source.

**INV-D — pre-existing content with unknown ownership.** **Containment is
necessary but not sufficient.** A mutation landing inside `R_lex`'s subtree
satisfies INV-B and still has no bearing on whether pre-existing content there
may be replaced: ownership remains exclusively doc 15 M1/M2's decision (§4.1
item 4 and §7, verbatim). This invariant must not be read as declaring unknown
content engine-owned, and no implementation of it may authorize E1-style
destructive adoption (A4a) by redefining that content as generated output. The
E1 destruction class inside the resolved root remains open regardless of this
contract (§11.7).

**INV-E — concurrent external modifications.** Authorization is valid **at the
moment of its last observation**. Alias insertion (A6) or retargeting (B6)
between that observation and the OS call is a structural residual no
decide-then-act guard closes (§6); narrowing shifts the window, only
handle-relative operations close it (W6 — unavailable on both hosts' contract
surfaces). No all-schedules guarantee is claimed or implied by any candidate
below.

### 11.2 Mutation-specific semantics (the operation decision table)

The brief's rule is proven, not assumed: **one generic
`realpath(target)`-containment rule does not match the mutation semantics** —
it false-fails the link-safe delete shapes (class 2: the resolved leaf
identity is the junction target, yet removing the link touches nothing behind
it — B1, B4-i) and it cannot handle fresh creation (class 4's common shape:
the target does not exist and resolution rejects — D2/D3). The contract
therefore mandates the per-operation ruleset of INV-B. "Today" is the executed
§2 behavior at this HEAD; the leaf-file-symlink forms of classes 5/6 inherit
§3's honesty split (junction forms executed; file-symlink equivalence asserted
by the same OS mechanism, not executed).

| # | Class (site) | Lexical path → physical target | Exists? | Parent identity | Leaf semantics | Authorized territory | Ownership | Today (executed) | Required behavior |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Delete a normal directory (M1, M6-delete) | Plan path verbatim; OS resolves every ancestor | Either (missing = self-healing) | Must satisfy INV-B.1 | Subtree removed; junction children inside are removed as links (B1, B4-i) | Resolved subtree of R_lex (permissive bound) | Engine territory; E1's M1/M2 decide replaceability | In-territory deletes succeed; through an alias ancestor the target's content behind it is deleted (B2, B3, B4-ii) | Refuse unless INV-B.1 holds; missing leaf on a clean chain stays a silent no-op (legitimate self-healing, A6/B7 shape) |
| 2 | Delete a junction/symlink at the final component (M1) | Plan path; physical = the LINK (not followed) | Exists (as alias) | INV-B.1 | **Link removed**; target bytes untouched (B1, native-baseline 1) | In-territory link removal | None touched | Link-safe today; a generic realpath rule would refuse this safe operation | **Allowed** when INV-B.1 holds (the delete leaf is exempt from the alias refusal) |
| 3 | Delete a descendant through a junction ancestor (M1, M6-delete) | Plan path; physical = behind the alias (lstat follows every component but the last) | Exists behind the alias | **Violates INV-B.1** (an ancestor is an alias) | Subtree behind the alias removed (B2, B3, B4-ii) | None — outside any authorized territory | Unknown/foreign (B4-ii's source, B5's sentinel) | **Silent destructive escape** (maximum damage: source folder deleted, B4-ii) | **Refuse explicitly before the delete**, naming the alias component (A7/B5/B4-ii die at the M1 gate; B-extra's dangling-ancestor silent no-op becomes the same explicit refusal) |
| 4 | Overwrite an existing normal file (M3–M8) | Plan path; physical = the same file | Exists, non-alias | INV-B.1 | Followed (same file) | In-territory overwrite | Engine territory (E1-E accepted; user-modified output per doc 15 §1 class 5) | In-territory overwrite, `errors: []` | Allowed when INV-B.1 and a non-alias leaf hold; ownership untouched (E1) |
| 5 | Overwrite a file symlink whose physical target is outside the authorized output (M3–M8 leaf) | Plan path; physical = the symlink target | Exists (as alias) | INV-B.1 holds | **Followed by write** — bytes land at the target | Outside territory | Foreign (A5's `USER-ORIGINAL-BYTES`) | Executed in its ancestor-junction form (A5, B4-iv): **silent overwrite escape** | **Refuse**: the leaf lookup finds a `symbolicLink` entry → explicit error naming the route; never write through an alias leaf |
| 6 | Create a new file through a junction ancestor (M2–M8) | Plan path; physical = behind the alias | Leaf missing; alias ancestor exists | **Violates INV-B.1** | Created behind the alias | Outside territory | Foreign (A1/A2/A4b/A6 victims) | **Silent redirection** (A1, A2, A4b, A6; ND5) | **Refuse** on INV-B.1 before the adapter's own `mkdir`+`write` (the adapter mkdir resolves aliases identically, node-file-system.ts:57–61) |
| 7 | Create missing parent directories through an alias (M2, adapter-internal mkdir) | `joinPath(op.path, '.pzstudio-mkdir')`; `mkdir` recursive resolves every component | Ancestors exist or are created | INV-B.1 covers op.path's chain | Sentinel created then deleted (execute.ts:470–479) | Territory of the resolved chain | Foreign when an alias is in the chain | Redirected like any write (A4a's sentinel landed inside the junction target) | Refuse on INV-B.1; on a clean chain the makeDir is authorized fresh creation |
| 8 | Copy into a destination whose physical root changes during execution (M3 + concurrent retarget) | Plan destRoot; the physical root is retargeted mid-operation (B6-class) | — (race) | Held at check time, violated at mutation time | Per-write resolution at call time | Undefined between observations | Foreign | **Silent redirection/destruction** (B6 executed for deletes; the write analogue is A6's window) | Not closable (INV-E): revalidation narrows; the residual is disclosed in the failure semantics — never claimed closed |
| 9 | Incremental/scoped rebuild without a full-root reset (M6–M8; planScopedModRebuild's `makeDir`+`removeDir`) | Per-delta lexical joins (buildsession.ts:630–648) or the scoped plan | Alias pre-exists; **no race needed** | INV-B.1 on every per-delta path | Per-delta leaf rules (write = classes 4/5, delete = classes 1/2) | Scoped territory per variant | Foreign when aliased (B4-iii source, B4-iv victim) | **Silent source deletion (B4-iii) and victim overwrite (B4-iv)** with `errors: []`; scoped `removeDir` deletes through ancestor aliases (A7, B5) | Refuse per delta on INV-B.1; failures land in `SessionApplyResult.errors` (never silent); the scoped `removeDir` is gated like class 3 |
| 10 | Sequential main/dev variant execution (planBuild ×2; B7) | Same R_lex, per-variant outPath; the outdir-root alias state may change between variants | Root alias retargeted between variants | Root not inspected (INV-A) | Per-variant reset + writes at the resolved location | Each variant authorized independently at its own resolution (no cross-variant caching) | `B7-LEGACY` = unowned → E1 | Both variants execute faithfully at two physical roots; legacy content destroyed | **Allowed and unchanged** (T2, INV-A); authorization is re-established per variant execution, never cached across variants; destruction stays E1-pinned |

Two asymmetries carry the table (both executed, neither assumable): the
delete/write leaf split (classes 2 vs 5 — `fs.rm` lstat-checks the leaf and
removes links as links; `fs.writeFile` follows the leaf link), and the
delete's missing-leaf semantics (class 1: a missing in-territory leaf is the
legitimate self-healing no-op of every reset flow, while a missing leaf behind
an alias ancestor is B-extra's silence — which INV-B.1 converts into an
explicit refusal because the refusal fires at the ancestor, before the
missing-leaf question can arise).

### 11.3 Implementation candidates (evaluated to owner-decision depth)

**Candidate A — resolve-and-validate (the §5-W1 mechanism, sharpened).**
Resolve the existing physical identity of the target's parent chain
(`resolveIdentity`, pending doc 16 §15.6.1), require containment, then mutate.

- Prevents, statically: every executed alias-route escape whose alias exists
  at resolution time — A1, A2, A4b, A5, A6 (caught **at write time**, the
  post-insertion resolution), A7, B4-ii, B4-iii, B4-iv, B5; A3 under either
  the route-based refusal (INV-B) or the §9.2 strict bound.
- Missing paths: `resolveIdentity(target)` rejects (D2) — fresh creation, the
  common first-build shape, must authorize **via the parent** with the §15.2
  lazy-pin re-attempt; a snapshot-only design leaves fresh-destination builds
  unprotected (D3). The delete-leaf exemption (class 2) must be carried into
  the resolution ruleset: authorize the parent chain, then apply the leaf
  semantics — the generic single-resolution rule is refuted above.
- TOCTOU: **unresolved, recorded as such** — B6 executes the generic
  invalidation; no all-schedules protection is claimed; W3-style
  re-verification at the mutation site narrows only (§6).
- Not available today: requires the pending §15.6.1 capability; capability-less
  hosts degrade (honesty, not protection — the §15.3/§16.4 verdicts carry
  over).

**Candidate B — fail-closed authorization.** Refuse any mutating operation
whose physical destination cannot be **proved** inside authorized territory.

- Missing paths: fail-closed is satisfiable only **parent-relative** — the
  leaf's absence is provably fresh creation when the parent chain is proved;
  refusing the leaf itself would fail every first build (D3).
- Adapters without identity resolution: cannot prove anything → either total
  refusal (breaks the host; rejected) or **explicit host-limitation
  degradation** (a warning naming the limitation; never silent, never a
  doctor warning substituted for authorization — adopted verbatim as the
  brief's constraint).
- Configured junction outputs: keep working iff the pin is the **resolved**
  root (INV-A); fail-closed against the spelled path would break T2.
- Timing: the failure occurs **at mutation time, not before destructive
  planning** — a plan-time preflight is W2-class (racy, false-failing; the
  §5-W2 verdict stands). The first refusal aborts the remaining plan
  (`executeFileOperations` throws); **partial output from earlier operations
  can remain** — the existing mid-plan abort shape (post-`removeDir`
  aborts), disclosed, never silent.
- Exposure through the existing pipes: `start()` rejects via
  `buildVariants`' error aggregation (buildsession.ts:408–437); `apply()`
  collects into `SessionApplyResult.errors` (per-action try/catch already
  wraps M6–M8); executor-direct callers receive the throw. Sources are never
  silently omitted and success is never reported for an unauthorized
  mutation.

**Candidate C — atomic or handle-relative operations.** The minimum capability
that binds validation to the actual mutation target.

- Node: `fs.promises` exposes **no openat/dirfd family** (W6 recorded);
  `O_NOFOLLOW` is POSIX-only in Node and binds only the leaf — ancestor
  components remain kernel-resolved at call time. **Node's ordinary
  `realpath` + `fs.writeFile` are two separate OS traversals and do not
  constitute an atomic operation.** The exact guarantee that cannot be
  provided on Node: *the mutation instant is bound to the authorization
  observation*.
- Web (`vscode.workspace.fs`): no realpath, no inode access, no handles —
  not even post-hoc physical validation is expressible. The additional
  guarantee that cannot be provided on the web host: *any resolved-physical
  fact at all*. Only the contract-only scan of §11.4 (where `list` reports
  link types faithfully) or explicit degradation exists.
- Verdict: the complete TOCTOU closure; requires a new capability class
  specified nowhere; **out of scope of every pending decision** — recorded so
  the residual of A+B is stated precisely, not as a proposal.

**Candidate D — isolated staging and controlled publication.** Build inside a
newly created, engine-controlled directory; publish only after successful
validation.

- Structurally eliminates the **write-phase** exposure: a fresh
  engine-created stage directory contains no pre-existing aliases, and every
  component between `R_lex` and the stage name is created by the engine
  (INV-B holds by construction for the build phase; the T2 root resolution
  applies unchanged).
- **Does not prevent E1 data loss**: the publication target may hold
  pre-existing content (user files, planted aliases) — the
  replace-or-refuse-or-capture decision at publication **is** E1's M1/M2
  decision (doc 15 §11.1); staging changes nothing about it.
- Rename/replace semantics: a clean publication needs the rename capability
  (doc 15 §8 row 1 — a pending frozen-API exception). On today's contract
  (no move), publication = copy+delete, and the delete half re-enters the
  class-3/6 hazards at the destination — **gated by the same INV-B scan**;
  staging without the scan adds little on today's contract.
- Cross-volume: rename fails EXDEV → the copy+delete fallback applies (and
  its scan gate with it).
- Crash recovery: an orphaned stage directory is dot-prefixed — invisible to
  copyTree walks and to `classifyDelta` (doc 15 Candidate C's dot-prefix
  argument) — inert but persistent; retention/cleanup is a new
  output-contract decision.
- Concurrent target substitution: publication is itself a mutation through
  the destination's ancestor chain; a junction planted after the last
  observation redirects the publication. Staging narrows thousands of
  write-windows to one publication window — **a reduction, not a closure**
  (INV-E).
- Main/dev consistency: per-variant stage directories inherit B7 verbatim —
  the alias state between sequential variants is unobserved by staging as by
  everything else.
- Verdict: a real risk-reduction **component** for a future mechanism, not a
  P0 and not a substitute for INV-B; owner option, separately gated.

### 11.4 The interim P0 containment decision (no API change)

**Decision: a narrowly scoped, contract-only interim containment is possible
and is specified here — the alias-route scan.** It stops every executed
static escape, fails explicitly when authorization cannot be established,
and preserves every green behavior of record. It is an **interim mitigation
against the escape class**, not the complete safety guarantee (§11.6
separates the two).

**Mechanism (INV-B implemented on today's contract, using only `list`'s
existing type reports — the header-quoted probe):**

1. **Per-mutation ancestor scan (all of M1–M8).** Before the mutating
   contract call, walk the operation path's components strictly below
   `R_lex` (deletes: excluding the leaf); look each up in its parent's
   `list` (exact, else unique-CI + `stat` witness, execute.ts:296–318); a
   `symbolicLink`-typed match → **refuse** with an explicit error naming the
   operation, the lexical path, the alias component and the policy reason.
2. **copyTree destination-entry guard (M3).** Once per operation, scan
   `destRoot`'s ancestor chain (rule 1); additionally, at each source
   directory descent, `list` the corresponding destination directory (when
   it exists) and refuse when any name the walk is about to write onto or
   descend through matches a `symbolicLink` entry of that directory (A1, A3,
   A4b, A5 die here — the junction is a destination entry, not an ancestor).
   The match is per-entry-name only: unrelated user links in an adopted
   destination that the walk never touches cause no refusal (no blanket
   "no links in the destination" rule — that would false-fail).
3. **Per-write leaf lookup (M4/M5/M6/M7/M8).** The leaf, when it exists,
   must not be a `symbolicLink` entry of its parent listing (class 5).
4. **Failure semantics.** Refusals throw inside `executeFileOperations`
   (→ `start()` rejection / full-rebuild errors / embedded-CLI stderr) and
   sit inside M6–M8's existing per-action try/catch (→ `result.errors`);
   partial output from earlier operations remains (disclosed); no silent
   partial success, no doctor-warning substitution.

**Executed-escape closure check** (each row = the §2 experiment): A1, A3,
A4b, A5 — rule 2 (destination entry); A2, A7, B4-ii, B5 — rule 1 on the
mutation path, with A7/B5/B4-ii refused **before** the destructive
`removeDir`; A6's executed ordering — rule 2 at walk start (the junction is
planted before the copyTree begins); B4-iii, B4-iv — rule 1 per delta;
B-extra — rule 1 (the dangling alias is an ancestor entry → explicit
refusal, ending the silent no-op); A3b — rule 2 replaces the cryptic
`ENOTDIR` abort with an alias-naming error. **Green-behavior preservation:**
B1, B4-i (link-as-leaf/child removal allowed — the delete-leaf exemption);
A4a, B7 (the outdir-root junction is never inspected — INV-A); every
permanent-suite shape (alias-free or case-variant destinations, no alias
mutation paths — the scan passes vacuously); F23-R3/E1a-F incorporation
(reads are never gated).

**What the P0 does NOT stop (disclosed, load-bearing):**

- **The TOCTOU family** — alias insertion after the last observation of its
  component (A6's arbitrary-schedule form, B6): narrowed by scan placement,
  not closed (INV-E).
- **Hard-linked files at write leaves** — invisible to every listing *and*
  to realpath (two names, one inode; no reparse point): an overwrite through
  an in-territory hard link mutates the shared bytes outside territory.
  Neither the scan nor the pending W1 catches this; deletion is unaffected
  (removing one name leaves the other intact). Inherent residual for every
  candidate, recorded because no prior record mentions it.
- **8.3 short names** — invisible to `list`; they alias only within the same
  parent, so the permissive bound survives them, but **any strict
  per-operation bound does not** (a short-name component can land a write in
  a sibling territory inside the root — the A3 class). Disclosed against the
  §9.2 option.
- **Hosts whose `list` cannot report link types faithfully** (remote vfs):
  the scan cannot authorize → explicit degradation per the owner policy
  (§11.10 Q3) — never silent.
- **E1 destruction inside the resolved root** (A4a, B7): by design (INV-D) —
  owned by doc 15's pending decision, not by this containment.

**Rejection-criterion check (brief §6).** Under its stated conditions — a
stable filesystem during the operation (no concurrent alias
insertion/retargeting) and faithful link-type reporting — the P0 permits no
demonstrated silent destruction of the escape class: every §2 experiment
whose alias pre-exists its mutation is refused explicitly. The two
experiments it still permits (A4a, B7) are territory-internal E1 destruction
at an intentionally configured root — the class the brief itself carries as
separately unresolved (gate P11). The P0 therefore qualifies as a P0 closure
of the escape class while honestly excluding the ownership class.

**Cost.** O(chain depth) `list` calls per mutating operation; one extra
`list` per source-directory descent in copyTree; per-delta depth lists for
M6–M8. Permanent-suite list budgets may need recalibration when the gate
lands — calibration of harness caps only: the write budgets and every
behavioral assertion must not move (§11.9).

### 11.5 Filesystem capability requirements and the API-sufficiency verdict

The brief's challenge — is `ProjectFileSystem.resolveIdentity?(uri)` alone
enough? — **no, not alone; but no new API class is needed either.** The final
design requires:

| Requirement | Needed by | Exact semantics and host support | Status |
| :--- | :--- | :--- | :--- |
| Ancestry-comparable resolved identity (`resolveIdentity`: path-form, adapter-canonical `/` separators, equality, unresolvability, post-creation resolvability — doc 16 §15.4) | W1-stage containment (Candidates A/B); the strict bound; Tier-2 read-side closure | Optional method returning a canonical identity string; implementable on the Node adapter (`fs.promises.realpath`, D1–D4); **not expressible on `vscode.workspace.fs`** — hence the optional-method shape plus `PlatformCapabilities.resolvedIdentity` (false on `WEB_CAPABILITIES` today) | **Pending** doc 16 §15.6 decision 1 — the one queued frozen-API exception; approving this package approves **no** API change |
| Resolved-parent identity as the call pattern | Deletes (authorize the chain, exempt the leaf — classes 2/3); fresh-creation writes (the D3 lazy pin) | The same single method called on the parent — a ruleset requirement, not a new API; the generic target-resolution rule is refuted (§11.2) | Same pending method |
| Operation-specific physical containment | Every mutation class (§11.2) | A ruleset over the same method (ancestor condition + per-class leaf condition) | Ruleset, no API |
| Link-entry visibility in listings | The P0 scan (§11.4) | `DirectoryEntry.type: 'symbolicLink'` — already in the contract; faithful on Node (the header probe); host-dependent on remote vfs | **Exists today** — no API change |
| No-follow metadata inspection (lstat-equivalent) | Cost optimization only (per-component checks without parent listings) | A no-follow stat variant; correctness needs only `list`'s type field on hosts that report it | **Not required** |
| Handle-relative mutation | The complete TOCTOU closure | Directory-handle-relative create/write/delete; not expressible on `ProjectFileSystem` (path-string-only) nor `vscode.workspace.fs` | **New capability class, specified nowhere**; out of scope (W6) |
| Atomic directory replacement (rename/move) | Candidate D publication; E1's capture-then-adopt | `ProjectFileSystem.move(from, to)` + `PlatformCapabilities.rename` (doc 15 §8 row 1) | **Pending** doc 15 §8 exception — separately gated; **not required** by this contract's P0 or W1 stage |
| Ownership/provenance capability | E1's M1/M2 only | Doc 15 Candidate B territory | **Explicitly out of scope** (§11.7); proposing it here is forbidden scope creep |

The frozen API-v2 contract is not modified by this record, and the P0
requires **no API change at all**.

### 11.6 Guarantee statements: stable filesystem vs concurrent mutation

**Stable-filesystem guarantee** (no concurrent alias insertion/retargeting
during the operation). Under the P0 scan: every mutation whose route contains
an alias below `R_lex` is refused explicitly; no mutation can land outside
`R_lex`'s resolved subtree (folding and short-name aliasing cannot leave a
parent directory; every executed out-of-subtree mechanism is a
listing-visible alias); in-territory mutation behavior is today's behavior
byte-for-byte. Residual: hard-linked file leaves (§11.4) — inherent, shared
by every candidate including W1. Under the W1 stage (when the capability
lands): the same statements at Tier-2 strength plus the strict-bound option;
the scan's route-based refusal and W1's landing-based containment compose —
the route refusal catches alias routes inside the root (A3) that a permissive
landing bound alone would accept.

**Concurrent-filesystem guarantee: none, on any candidate.** The window
between the last observation and the OS call is structural (B6; A6 from the
insertion side); re-validation narrows and shifts it (D5, §6); only
handle-relative operations close it, and no current contract can express them
(§11.5). Every candidate's user-facing failure semantics must disclose this
residual; no all-schedules correctness claim may be made for any
implementation of this contract.

### 11.7 E1 independence

Verbatim carried and re-affirmed: containment decides **where**, ownership
decides **whether** (§4.1, §7). Nothing in this package classifies user
content as engine-owned, extends or approves the E1 exclusion, touches strict
S1/UX-09, or presages doc 15 §11.1's prevent/accept/scope-out decision. The
P0's permitted A4a/B7 destruction is exactly the boundary F23-R5 already
documents as unresolved. E1-M2's incidental alias mitigation (capture reads
through the alias) is unaffected by and irrelevant to the scan. Approving
this package approves nothing in doc 15.

### 11.8 Core versus CLI applicability

Every check site in this contract is Core (`executeFileOperations` M1–M5,
`BuildSession` M6–M8). The CLI executor (`removeDirRecursive`
helper.ts:243–266; `scaffoldProject`'s `cpSync`) executes the same OS
semantics (B-native-baseline) and inherits the B-class verbatim, but it has
no `ProjectFileSystem` contract to hang a scan on and no F23 fix of record —
CLI parity remains the separate defect decision of doc 15 §4/§11.5, doc 16
§10 and §9.6. Nothing here changes the CLI.

### 11.9 Permanent RED-first implementation gate (P-series)

Written against post-gate expectations; RED rows fail at today's HEAD, GREEN
rows pin behavior that must survive the gate unchanged. Harness: the
permanent suites' emulated filesystems (`F23Fs`, `CaseInsensitiveFs`,
`SymlinkFs` — link maps over the existing budgets and listing orders) for CI
portability, plus an optional native-junction tier (real `NodeFileSystem`,
real NTFS junctions, `fs.realpath` landings; skipped off-Windows). Every
escape row asserts byte-exact sentinels **at resolved physical stored paths**
(emulated: the stored key is the landing; native: the logged `fs.realpath`).
Existing F23 tests are not weakened or deleted; the only permitted harness
change is list-budget recalibration for the scan's added listings — write
caps and every behavioral assertion unchanged.

| ID | Gate (fixture) | At today's HEAD | Green condition |
| :--- | :--- | :--- | :--- |
| F23-WB-P1 | Source-folder deletion through a junction ancestor (B4-ii) | **RED** (source deleted, `errors: []`) | Explicit refusal before the `removeDir`, naming the alias component; source tree byte-identical |
| F23-WB-P2 | Incremental sync through a planted alias, no race (B4-iii delete + B4-iv overwrite) | **RED** (source deleted / victim overwritten, `errors: []`) | Refusal in `SessionApplyResult.errors`; source/victim bytes intact; `incremental` counts only authorized mutations |
| F23-WB-P3 | External existing-file overwrite through a destination alias (A5; emulated + native tier) | **RED** (victim bytes replaced) | Victim bytes intact; explicit error naming the route |
| F23-WB-P4 | Target absent at authorization time — fresh creation on a clean chain (every first build) | GREEN (must stay green) | Build succeeds byte-identically; the parent-anchored rule adds no false failure (the anti-false-failure gate for Candidate B) |
| F23-WB-P5 | Retarget between authorization and mutation (B6 shape; the write analogue of A6's arbitrary-schedule form) | **RED** (no observation exists at all) | Detected when observable (revalidation narrowing reports it); the residual window is asserted **documented**, never claimed closed |
| F23-WB-P6 | Outdir-root junction intentionally configured by the user (A4a, permissive bound) | GREEN (must stay green) | Build proceeds at the resolved root unchanged; the E1 destruction component stays pinned as the unresolved boundary (with P11) |
| F23-WB-P7 | Main/dev variants resolving to different physical roots (B7) | GREEN (must stay green) | Each variant authorizes independently at its own resolution — no cross-variant authorization caching; sequential-alias behavior unchanged; destruction stays E1-pinned |
| F23-WB-P8 | Failure propagation and partial-output state | **RED** (silent success today) | A refusal mid-plan surfaces through `start()` rejection / `result.errors` / executor-direct throw; operations executed before the refusal remain (asserted explicitly); no silent partial success |
| F23-WB-P9 | Preservation matrix: case-6 exact key sets, stale roots, `staging/collide.lua` incorporation (R3/E1a-F), case twins (E1a-C), S1/S5 source links, both permanent suites (28 tests) | GREEN | All unchanged by the gate — no new false failures anywhere |
| F23-WB-P10 | Web / no-faithful-type-reporting fallback (an adapter whose `list` cannot report link types) | n/a (new surface) | The approved §11.10-Q3 policy (warn-and-proceed **or** fail-closed) executes explicitly — the degradation is never silent |
| F23-WB-P11 | E1 unowned-destination protection remains unresolved (A4a's `LEGACY-USER`) | GREEN (documents the boundary, like F23-R5) | The destruction at the resolved configured root still occurs pending doc 15 §11.1 — the P0 must not be misread as having closed it |

Expected RED set at today's HEAD: P1, P2, P3, P5, P8 (plus §8's R1–R5, R7
when the same stage lands). GREEN-preserving: P4, P6, P7, P9, P11 (P10 is a
new surface). The §8 R-series and this P-series are one implementation
stage's gate set: R1–R5/R7 assert the escape closures from the executor's
perspective; P1–P3 re-express the highest-damage ones at the session level;
P4–P11 pin what must not change and what stays open.

### 11.10 Owner approval questions

The §9 decisions (1–7) all remain open; this package adds and sharpens:

1. **P0 approval (new).** Approve the contract-only alias-route scan (§11.4)
   as an immediate containment, **separate from and not instead of** the W1
   capability decision? (The scan needs no API; W1 upgrades the same check
   sites when §15.6.1 lands.)
2. **Bound semantics (sharpens §9.2).** The P0 implements the permissive
   bound **plus route-based alias refusal** — which already catches A3
   without the strict bound's embedding carve-out problem. Confirm this
   posture, or require the strict per-operation landing bound for the W1
   stage (which the 8.3 residual then weakens, §11.4).
3. **Degradation policy on hosts without faithful link-type reporting (new;
   sharpens §9.7).** Proceed with an explicit host-limitation warning
   (recommended — honest degradation, zero false failures) or fail-closed
   (refuse to build where authorization is impossible)? Either way the
   output is never silent (P10 pins it).
4. **Missing-leaf delete semantics (new).** Keep today's self-healing silent
   no-op for in-territory missing leaves (recommended — A6/B7's legitimate
   shape; the alias-ancestor dangling case is already converted to an
   explicit refusal by the scan) or make every no-op delete reported?
5. **W4/unresolved-identity policy** — carried verbatim (decide jointly with
   doc 16 §15.6.3); the scan converts the B-extra shape regardless.
6. **TOCTOU posture, T2 confirmation, CLI parity, W1 adoption** — §9.3, §9.5,
   §9.6, §9.1 carried verbatim; nothing in this package pre-answers them.

### 11.11 Implementation scope and STOP conditions

**Authorized by an owner approval of this package (and only that):** the P0
scan at the M1–M8 check sites per §11.4, with the §11.9 P-series gate set,
the INV-B ruleset and the disclosed residuals — as a RED-first
implementation stage. The W1 upgrade (same sites, resolved-identity ruleset)
additionally requires the pending doc 16 §15.6.1 exception; the strict bound
requires §11.10-Q2; CLI parity is a separate defect decision (§11.8);
staging (Candidate D), rename, provenance and handle-relative work are
**not** part of this contract.

**STOP — this record authorizes none of:** any production source, contract,
harness or test modification (none was made); any `resolveIdentity` or other
API addition; any CLI executor change; any E1 quarantine/capture or
ownership redefinition; any DX-13/reconciliation work; any Contract A/B
change; any UX-09 filtering change; any change to strict S1 or the supported
case-6 layouts; any rewrite of §1–§10's measurements or verdict.

**Decision status: `MUTATION_AUTHORIZATION_READY_FOR_OWNER_DECISION`.** All
eight readiness criteria hold: a concrete physical invariant (§11.1);
operation-specific leaf/ancestor semantics with the generic-rule refutation
proved (§11.2); explicit missing-destination treatment (§11.2 classes 1/4/7,
§11.3-B); a defined static-escape protection (§11.4, with the
executed-escape closure check); honest TOCTOU boundaries (§11.4, §11.6); a
policy for hosts lacking identity capabilities (§11.4, §11.10-Q3, P10);
clear separation from E1 ownership (§11.7); and a bounded permanent
RED-first plan (§11.9).

---

*Pointer: doc 16 §16.5 records the first write-side aliases and names the
separate-hazard-class boundary this document executes and adjudicates; doc 15
§6's M1/M2 remain the ownership half of the composed mechanism (§7); doc 14
§16.3 remains the F23 classification of record.*
