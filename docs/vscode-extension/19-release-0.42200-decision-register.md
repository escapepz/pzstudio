# 19 — Release `0.42200.x` Decision Register (DR-REL-0.42200)

**Status: decision record — Owner decisions DEC-1…DEC-10 recorded
(2026-11-07). DEC-1…DEC-5 carry their own implementation records (Stage-1
landing commit, Doc 14 note, Doc 18 §10 item 15 note); DEC-6a, DEC-7b,
DEC-8a, DEC-9a and DEC-10 are recorded here. Nothing here authorizes
implementation beyond the decisions named below; C11 remains frozen.**

## Decisions

| ID | Question | Verdict | Implementation record |
| :--- | :--- | :--- | :--- |
| DEC-1 | Stage-1 fate | **(a)** approve the fail-closed ownership guard | Landed at the Stage-1 commit (scoped per DEC-2; `packages/core/src/buildsession.ts`, `mutation-guard.ts`) |
| DEC-2 | Stage-1 scope | **(c)** fail-closed only for destinations inside the mod source tree (incl. the case-6 nested layout); external output roots keep HEAD adoption behavior as a recorded deviation from B1-A until the full receipt ledger lands | Stage-1 landing commit + Doc 18 §10 item 15 note |
| DEC-3 | DevSync variant-folder contract | **(a)** in-contract — DevSync may mutate variant folders through the guard | Stage-1 landing commit |
| DEC-4 | B.5a stale baseline | **(a)** keep the engine-on-A behavior on plain deltas; residual documented, DX-9-reversal stays a separate change request | Doc 14 note |
| DEC-5 | Release scope | single `0.42200.x` release — vehicle resolved during preparation: `@pzstudio/cli` 0.42200.1 was already published (2026-10-05, dist-tags `latest`+`next`), so the release vehicle is **CLI 0.42200.2 + extension 0.42200.1** (versions immutable once published, per RELEASE.md) | release notes `docs/releases/0.42200.2.md` + version bumps prepared |
| DEC-6 | `pzstudio clean` guard + DevSync error visibility | **(a)** both | `cleanOutputPath` guard in `packages/cli/src/lib/commands/clean.ts` (clean tier of the F23-WRITE P0 guard, parity with the build executor); extension `devsync.ts`: `result.errors` surface through the error notification (count + Show Details) while per-error detail stays in the channel, and a rejected `flush()` is reported instead of dying as an unhandled rejection |
| DEC-7 | C-17 run-log retention | **(b)** deferred with disclosure — release notes must state that logs are retained indefinitely in this version; retention is not advertised; no manual-cleanup path may touch protected ownership evidence | release notes, pending |
| DEC-8 | Frozen-API exceptions | **(a)** the exception list stays empty: no `resolveIdentity(uri)`, no `PlatformCapabilities.resolvedIdentity`, no rename/move capability (D8c), no planner ownership field | none needed; reopening requires the Doc 16/18 exception process |
| DEC-9 | strict-S1 + drop observability | **(a)** strict-S1 unchanged — relaxing it requires a change request + Owner approval; filtered watcher events are reported as one aggregate line per batch at verbose level, never a per-event warning | extension `devsync.ts` filtered-event counter |
| DEC-10 | Post-release workstreams | formally parked with their own gates, scope and Owners (below) | this register |

### Marketplace migration note (DEC-5 release operations)

Version **0.42200.1** is published to **both** marketplace listings: the old
`escapepz.pzstudio` (which carries a migration notice pointing at the new
listing) and the new `escapepz.pzstudio42`. The notice lives in
`packages/vscode-extension/README.md` directly above `🚀 Features` (marked
with an HTML comment for removal). Starting with the **next version after
0.42200.1**: remove the notice from the README and stop updating the old
listing — it becomes a frozen redirect page. Until then, every README
change must be published to both listings or the two listings' rendered
pages drift.

## Post-release workstreams (parked, DEC-10)

Each starts only after the `0.42200.x` release ships and its own gate
(scope + acceptance criteria + Owner) is approved:

1. **Project Cockpit / Active Project** (Doc 12 — interaction spec v1,
   migration matrix UX-R0…UX-R4).
2. **Persistent DevSync + UX-15 + UX-18** (per-project sync identity and
   status surface; `loadProject`-based project reads).
3. **Full ownership ledger** (Doc 18 — receipts, digest checks, `_backup`
   rescue, cleanup, doctor diagnostics; §10 items 1–13).
4. **Full strict-S1** (Doc 14 — reconciliation cadence, written-path
   provenance, DX-2/DX-13).

### UX-09 red-first regression recovery note

The doc 14 red-first regression tests (A1/B1/C1 silent source-event loss)
were recorded as lost with the vanished git stash (Doc 14 note). The content
survives as an untracked recovery copy at
`.tmp/extUtilDevSyncSafetyGates.test.ts` (written at an earlier HEAD, with
expected verdicts pinned in its header). It is the strict-S1 workstream's
starting regression set and must be re-homed under `tests/unit/` with
re-verified RED/GREEN verdicts at the then-current HEAD before that
workstream begins. The scratch file is not part of the test suite and its
`any`-typed stubs fail lint as-is — re-homing includes typing them like the
shipped suites.

## Governing constraints carried forward

- **C11 remains FROZEN**; no promotion code exists (verified at the Stage-1
  landing).
- **No frozen-API exception is granted** (DEC-8); proposals go through the
  Doc 16 §15.6 / Doc 18 D8c process individually.
- **C-17 stays incomplete** until designed, implemented and verified (Doc 18
  §10 item 12); deferred by DEC-7 with release-notes disclosure.
- **strict-S1 relaxation requires a change request + Owner approval**
  (DEC-9); the aggregate filtered-event line does not change the delivery
  contract.
