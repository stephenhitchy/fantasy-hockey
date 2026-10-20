# RinkRat Data Hotfix D1A.2 — Live-Scoring Index Capacity

## Incident

A full league score refresh reached Firestore's per-document index-entry limit
while publishing `leagues/{leagueId}/liveScoring/cycle-{number}`. The rejected
write left the prior shared score snapshot in place even though the current NHL
boxscore already contained the player's goal. Player detail could therefore
show the goal in its recalculated drivers and an equal negative **Saved server
scoring reconciliation** adjustment back to the stale saved total.

The bounded Firestore error was:

```text
INVALID_ARGUMENT: too many index entries for entity
```

## Fix

`firestore.indexes.json` now exempts the `result` map in the `liveScoring`
collection group from automatic single-field indexing. Cycle snapshots are
read by their exact document path; no production query filters or sorts on a
field below `result`. The exemption removes thousands of unused nested index
entries without changing the snapshot body, scoring calculation, or browser
read contract.

After the index configuration finishes applying, the existing idempotent
league-automation worker can publish the current snapshot on its next retry.
No score, six-game window, roster assignment, or historical document is
rewritten by the index deployment itself.

## Deployment and recovery

Deploy the exact index configuration before retrying the affected league:

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only firestore:indexes
```

Wait for the exemption to finish applying in Firestore, then allow the normal
scoring worker to retry or use the existing authorized commissioner refresh.
Confirm that:

1. `liveScoring/control.lastError` clears;
2. `liveScoring/cycle-{number}.refreshedAt` advances;
3. the player's saved score includes the valid NHL goal;
4. the detail page no longer needs a negative stale-snapshot reconciliation;
5. the same NHL game remains in the same six-game slot.

Rollback is removal of the exact `liveScoring.result` field override followed
by another index-only deployment. Do not roll back while a league snapshot is
large enough to exceed the old index-entry limit, because that would restore
the failed-write condition.

## Preserved contracts

This hotfix changes no scoring formula, Projection V11 math, six-game ownership,
seventh-game rollover, roster or Draft authority, Firestore Rules, TTL policy,
App Check mode, queue mode, or worker limit. It changes one Firestore
single-field index policy and therefore requires an index deployment; Hosting
or Functions alone cannot fix the incident.
