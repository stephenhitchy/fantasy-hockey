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

During the original hotfix, once the index configuration finished applying,
the existing idempotent league-automation worker could publish the current
snapshot on its next retry. No score, six-game window, roster assignment, or
historical document was rewritten by that index deployment itself.

## Current Production state and recovery

A complete read-only Production audit on 2026-10-21 verified that the
`liveScoring.result` exemption is already active. No index deployment is needed
to retain this protection.

Do not rerun the historical `firestore:indexes` deployment merely for this
exemption. That selector reconciles the complete checked-in index and field-
override file. The same audit found that all ten protected TTL fields inherit
Collection-scope indexes in Production while the checked-in file specifies
Collection Group scope. Deploying the file would therefore change 30 unrelated
protected index-scope settings even though the scoring exemption is already
present.

If this incident appears again, first inspect Production read-only and confirm
that the exemption is actually absent before proposing any configuration
change. An index deployment is allowed only after the task explicitly covers
the full index/TTL surface and a complete live-to-source parity review proves
every resulting change is intended. Then allow the normal scoring worker to
retry or use the existing authorized commissioner refresh and confirm that:

1. `liveScoring/control.lastError` clears;
2. `liveScoring/cycle-{number}.refreshedAt` advances;
3. the player's saved score includes the valid NHL goal;
4. the detail page no longer needs a negative stale-snapshot reconciliation;
5. the same NHL game remains in the same six-game slot.

Rollback must restore a reviewed complete Production index/field-override
configuration, not remove one field in isolation. Do not re-enable indexing
below `liveScoring.result` while a league snapshot could exceed the old index-
entry limit, because that would restore the failed-write condition.

This exemption addresses the reported index-entry failure. Firestore's
independent document-size limit still applies, so snapshot byte size remains a
separate capacity metric even though it did not cause this incident.

## Preserved contracts

The original hotfix changed no scoring formula, Projection V11 math, six-game
ownership, seventh-game rollover, roster or Draft authority, Firestore Rules,
TTL policy, App Check mode, queue mode, or worker limit. It historically
changed one Firestore single-field index policy. Because that policy is now
active in Production, the current state requires no index deployment.
