# Mobile Batch N1B — Saved Read-Only Matchups

**Runtime release:** Release Candidate 49

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surface:** Game Center

**Deployment:** Hosting only

## Purpose

N1B completes the first intentionally stale offline-data experience promised by roadmap item N1.3. After an authenticated manager successfully opens a Game Center matchup online, RinkRat may save a bounded presentation-only copy on that device. If the exact matchup is later opened while offline—or the live read fails—the manager can see that saved copy with an unmistakable timestamp and read-only warning.

This is not an offline competition mode. It never queues or submits a Draft pick, roster move, waiver claim, commissioner action, replay control, or testing action.

## What is saved

The snapshot contains only data already rendered in the authenticated Game Center view:

- account, league, cycle, and matchup identity needed for exact lookup;
- league, matchup, and team display names;
- current and projected team scores;
- team records and roster-game progress;
- matchup status, readiness, and finish labels;
- starter names, NHL team labels, positions, current points, and frozen projections;
- availability/return label when already visible;
- the six played, missed, live, upcoming, or unavailable markers;
- saved time and source release, scoring, and projection versions.

## What is excluded

The saved contract contains no:

- email address or invite code;
- private player note;
- waiver claim or transaction payload;
- pending-move destination;
- Draft queue or ranking;
- request or submission identity;
- commissioner reason or administrative control;
- raw NHL game ledger;
- Firestore path or write payload;
- authentication token.

## Storage bounds

RinkRat uses browser IndexedDB rather than Firestore or Cloud Storage.

```text
Database: rinkrat-offline-matchups
Maximum snapshots per account: 12
Maximum age: 7 days
Maximum serialized snapshot: 350 KB
Maximum position groups: 5
Maximum rows per position group: 4
```

Malformed, oversized, expired, or wrong-account records fail closed and are pruned. Saving the same unchanged presentation repeatedly within five minutes does not rewrite the record.

Logout removes that account's saved matchup copies from the shared device.

## Exact-route privacy

An explicit matchup route loads only the exact account/league/cycle/matchup context:

```text
account + league + cycle + matchup
```

A generic cycle route may load only the signed-in manager's saved matchup in that exact league and cycle. It never substitutes another matchup merely because it is newer, and it never crosses to a different league or cycle.

## Online save boundary

The Game Center snapshot is created only after the live page has enough data to render a real matchup:

- authenticated account and league are known;
- cycle and matchup exist;
- shared scoring exists;
- starter position groups contain rendered rows.

Saving is delayed briefly so rapid listener updates collapse into one write. IndexedDB failure is non-blocking and cannot interrupt the live application.

## Offline/read-only presentation

The saved page displays:

```text
Saved matchup
Read only
Saved <age>
Exact saved date/time
Source release
Scoring version
Projection version
```

It also states:

```text
No Draft, roster, waiver, commissioner, or testing action was queued.
```

The page contains no competitive action buttons. When the browser is online after a live-data failure, one **Reload live matchup** button retries the normal Game Center route.

## Service-worker boundary

The N1A worker remains GET-only and advances its shell version to RC49. It does not read or write the IndexedDB snapshot store, register Background Sync, intercept Firebase traffic, or queue a future action. N1B's saved matchup is loaded only by authenticated application code after route and account checks.

## Preserved authority

N1B changes no:

- Production Scoring V3 calculation;
- Projection V11 calculation;
- immutable six-game roster-slot window;
- seventh-game rollover;
- Draft, roster, scoring, waiver, or transaction authority;
- Firestore Rule, index, TTL policy, App Check setting, scoring-queue mode, or NHL-cache authority.

## One automated verification gate

```bash
npm run verify:batchn1b && echo "N1B VERIFICATION PASSED"
```

The release may continue only when the final success line appears.

## Targeted deployment

N1B has no Functions or Firestore deployment:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Mobile N1B saved read-only matchups Release Candidate 49"
```

## Site-first smoke test

1. While online and signed in, open the exact Game Center matchup and wait until its score and starters render.
2. Record the score and six-game markers.
3. Disconnect the device.
4. Reopen the exact matchup route.
5. Confirm the saved/read-only page appears with the expected score, starters, markers, and exact saved time.
6. Confirm no competitive action exists and no request says it will submit later.
7. Open a different matchup or cycle that was not saved; confirm RinkRat does not substitute another saved matchup.
8. Restore the connection and use **Reload live matchup**.
9. Confirm the live page replaces the saved copy.
10. Sign out, sign back in, disconnect, and confirm the prior account's saved copy is no longer available on that shared device.

## Rollback

A Hosting rollback removes the RC49 reader. The local IndexedDB data remains inert browser storage and is not competitive authority. Do not change Functions, Rules, indexes, TTL, App Check, scoring queue, or NHL-cache settings as part of an N1B rollback.
