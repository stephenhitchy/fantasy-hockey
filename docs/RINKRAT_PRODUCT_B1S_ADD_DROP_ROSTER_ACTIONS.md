# Batch B1S — Automatic Add / Drop Pool and Roster-Action Clarity

## Scope

Batch B1S restores the verified Add / Drop player directory automatically,
repairs the final lineup-swap button contrast, and adds an active-player-first
bench-swap path. It preserves Projection V11, roster eligibility, transaction
timing, waivers, six-game ownership, and server roster authority.

## Confirmed causes

1. Add / Drop read only the current projection pointer. When that pointer was
   absent or rejected by the current version/integrity contract, the page
   discarded the pool and instructed the commissioner to use Projection Lab.
   It did not try the verified snapshot pinned to a completed Draft and did not
   have a member-safe automatic recovery reason.
2. The semantic `rr-button--commit` palette was overridden by the generic
   favorite-team confirmation selector and a component rule targeting every
   `ir-activation-confirm`. Dark team colors could therefore produce a nearly
   invisible final lineup action.
3. The roster-manager action builder offered the bench-to-active flow only
   when the manager began from the bench player. An active player exposed Add /
   Drop replacement and waiver actions but no way to choose a bench swap.

## Implemented behavior

- Add / Drop first reads the current compatible snapshot, then the exact
  server snapshot pinned to the completed Draft. If neither can be verified,
  it queues one server-owned `player-directory` Projection V11 generation.
- Any league member may request that bounded recovery, but manual, Draft Setup,
  cycle-refresh, and window-boundary rebuilds remain commissioner/admin only.
  Existing six-hour reuse plus request/control deduplication prevent a page
  visit from repeatedly rebuilding a fresh directory.
- The browser never invents a projection or accepts incompatible metadata.
  Loading and failure states remain explicit, and the page no longer tells a
  manager that Projection Lab is required.
- The final lineup-swap control retains RinkRat's theme-independent gold commit
  palette instead of inheriting a favorite-team color. Disabled, keyboard
  focus, hover, and ready states continue through the shared button primitive.
- Every eligible active roster player now shows **Swap with a Bench Player**.
  Its next sheet lists only unreserved bench assets with the same fantasy
  position. Selecting one opens the existing secure swap confirmation locked
  to the active slot the manager started from.
- If no matching bench player exists, the sheet still opens and explains the
  empty state without changing the roster. Pending active moves remain locked
  to their existing review/cancel path.

## Deployment

Deploy the request consumer and task worker from the same clean commit, then
Hosting:

```bash
firebase deploy --project nhl-fantasy-app-ab673 \
  --only functions:requestProjectionSnapshotGeneration,functions:processProjectionGenerationTask

firebase deploy --project nhl-fantasy-app-ab673 --only hosting:app
```

No Rules, indexes, TTL, App Check, queue configuration, scoring worker, or
roster-authority deployment belongs to B1S.

## Rollback

Revert the B1S commit, rebuild both targets, deploy the preceding revisions of
the two named Functions, then restore the preceding Hosting release. Existing
projection snapshots and roster transactions require no migration or data
rollback.

## Protected contracts

Production Scoring V4 values, Projection V11 formulas/hashes/rankings,
six-game ownership, seventh-game rollover, immutable started windows, Draft
authority, roster/waiver/IR authority, Rules, indexes, TTLs, App Check mode,
queue limits, standings, playoffs, and canonical scoring authority are
unchanged.
