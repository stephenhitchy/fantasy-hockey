# Batch B1U — Roster Swap Matchup Timing

## Scope

Batch B1U adds selection-specific timing to the My Team active/bench swap
confirmation. It does not change roster eligibility, move timing, six-game
ownership, waivers, scoring, or server roster authority.

## Behavior

- Choosing an active destination begins a bounded read-only timing preview.
- The confirmation states the exact currently predicted matchup and whether
  the swap can happen immediately or must wait.
- When one side is farther ahead, the explanation names that player and shows
  the relevant current matchup progress.
- Separate explanations cover the active player, bench player, both players,
  and a completed window waiting only for the next roster boundary.
- The confirmation remains unavailable until timing evidence is present.
  Loading, failure, retry, selection changes, dialog dismissal, and late
  responses all have explicit states.
- The secure roster action repeats every eligibility and timing check when the
  manager confirms. The preview is never write authority, and the copy says so.

## Implementation boundary

The existing browser swap path already loads the bench asset's NHL block and
the selected active slot's persisted six-game window immediately before the
server request. B1U adds a separate read-only preview service that mirrors
those existing reads without changing the protected submission path. A pure
utility classifies the current evidence without writing anything. The
Functions implementation and every competitive data contract remain
unchanged.

## Deployment and rollback

Only Hosting is required:

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only hosting:app
```

Rollback by restoring the preceding Hosting release or reverting the B1U
commit and rebuilding. No document migration or server rollback is required.

## Protected contracts

Production Scoring V4, Projection V11, six-game ownership, seventh-game
rollover, immutable started windows, Draft authority, roster/waiver/IR
authority, Rules, indexes, TTLs, App Check mode, queue limits, standings,
playoffs, and canonical scoring authority are unchanged.
