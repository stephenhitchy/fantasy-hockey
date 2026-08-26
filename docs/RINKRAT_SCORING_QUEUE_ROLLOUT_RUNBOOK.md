# RinkRat Scoring Queue Rollout Runbook

**Current queue foundation:** Release Candidate 9 / Batch P1F.1
**Current cadence extension:** Data Batch D1D near-live exact Canary

**Production default:** Shadow mode

**Primary purpose:** move live league scoring from the legacy two-league sweep to deterministic per-league Cloud Tasks without risking real leagues.


## P1F.1 Functions build correction

The control-center league loader intentionally combines `QueryDocumentSnapshot` values from the
newest-leagues query with ordinary `DocumentSnapshot` values returned by `db.getAll()` for exact
configured league IDs outside that first page. The local collection is explicitly typed as
`DocumentSnapshot<DocumentData, DocumentData>[]`; do not narrow it back to an inferred
`QueryDocumentSnapshot[]`, or the Functions build will fail with `TS2345`. This is a compile-time
hotfix only and does not change rollout behavior.

## The one-sentence model

- **Shadow** watches the new queue but scores no live league.
- **Canary** routes only exact selected league IDs through the queued scorer.
- **Primary** routes every eligible live league through the queued scorer.
- Canary and Primary use the **same idempotent worker**. D1D changes only the next live-game schedule for exact Canary leagues: two minutes for Canary versus the standard cadence for Primary and every non-Canary league.

The mode does not change queue capacity. The worker ceiling remains four concurrent scoring tasks, the global queued/processing ceiling remains 24, and no more than four Internal Test leagues may enter the near-live Canary cohort. D1D deliberately tests freshness without increasing concurrency. Those limits must be tuned later from measured task duration, Firestore contention, queue age, retries, NHL-data behavior, and cost.

## Where to manage it

Open a league for which the platform administrator is also a member, then open:

```text
League HQ → Release Readiness → Scoring Queue Control Center
```

The client never writes the queue configuration directly. Every change is sent to a platform-admin-only callable, revision-checked, validated against the live league documents, and written with an audit record.

Server-owned documents:

```text
appData/leagueAutomationQueueConfig
appData/leagueAutomation
appData/leagueAutomationPrimaryApproval
leagueAutomationConfigAudit/{requestId}
leagueAutomationSchedules/{leagueId}
leagueAutomationTasks/{taskId}
```

The Firestore browser rules remain unchanged. These records are written through Admin SDK Functions.

## Recommended league layout

Maintain two different internal leagues:

### Historical Regression League

Use it for:

- Advance One NHL Day;
- sixth-to-seventh-game rollover;
- scheduled transactions;
- waivers and Injured Reserve;
- playoffs and bracket backfill;
- repeated scoring regression.

Historical replay leagues are intentionally excluded from live queued scoring. They use the serialized R1E replay queue.

### Live Canary League

Use it for the real live-scoring queue test:

- completed draft;
- ordinary live NHL scoring;
- historical replay disabled;
- internal managers only at first;
- clearly named, for example `RinkRat Live Canary`.

Mark it **Internal Test**, then add it to **Route Through Canary**.

## Shadow procedure

Keep Production in Shadow during invite-beta setup.

Verify on Release Readiness:

1. Environment is Production and the project ID is `nhl-fantasy-app-ab673`.
2. Dispatcher heartbeat remains newer than five minutes.
3. Schedule coverage reaches the completed-draft league count.
4. Active queued tasks remain zero in Shadow.
5. Enqueue failures and stale recoveries remain zero.
6. Historical replay leagues show `Historical Replay`, not queued scoring.
7. Live leagues show `Legacy Scorer`.

Shadow is a monitoring state, not a lower-user pricing tier. Do not wait for the legacy scorer to fail before testing Canary.

## First Canary procedure

1. Complete the fake live canary league’s draft.
2. Confirm historical replay is disabled.
3. Wait for its `leagueAutomationSchedules/{leagueId}` document to exist.
4. In the control center, mark it **Internal Test**.
5. Mark it **Route Through Canary**.
6. Choose **Canary**.
7. Enter a clear change reason.
8. Type `ENABLE CANARY` exactly.
9. Save.
10. Refresh and verify only the exact canary shows `Queued Canary`.
11. Use **Run Canary Now** and confirm the second inline warning.
12. Watch Game Center, the league schedule row, queue health, and Function logs.

The manual canary action forces one safe scoring pass through `processLeagueAutomationTask`. It uses the same scoring worker as Primary, but it does not route any other league through the queue.

### D1D near-live Canary cadence

After the D1D Functions are deployed, an exact league uses the two-minute target only when it is present in both the server-owned Canary and Internal Test allowlists and its scoring result reports a live NHL game or a completed-window transition. The schedule then records:

```text
lastRefreshCadence: near-live-canary
lastRefreshDelayMilliseconds: 120000
```

Shadow leagues, non-allowlisted leagues, Canary selections missing the Internal Test safety label, legacy recovery, Historical Replay, and Primary remain on the standard cadence. Primary is intentionally not faster in D1D because broad frequency must wait for shared NHL ingestion, queue-cost evidence, and staged load tests.

Selecting **Route Through Canary** in the Control Center automatically selects **Internal Test**. Removing the Internal Test label removes the league from Canary, and the server callable rejects any mismatched saved configuration.

The control center shows the cadence per league and the server-owned Canary interval. Returning to Shadow immediately removes the near-live path without deleting any score, window, transaction, or task history.

## Canary acceptance checks

Run at least three successful tasks after the current canary allowlist is activated before Primary can unlock. Changing the canary allowlist resets this proof counter. More evidence is recommended.

For every canary run verify:

- no duplicated fantasy points;
- no duplicated scoring snapshot;
- no duplicated transaction activation;
- no skipped roster-slot game;
- independent Game 6-to-7 rollover remains correct;
- queued add/drop activates exactly once at the correct slot boundary;
- standings and playoff transitions remain correct;
- task lease clears after completion;
- queue status returns to idle;
- retry count remains low;
- oldest due age stays inside the scoring freshness target;
- the legacy recovery sweep is not routinely rescuing the canary;
- the queue backlog returns to zero.

Recommended expansion:

```text
1 fake live canary
→ 2 internal leagues
→ all of the owner’s internal leagues
→ controlled staging percentage tests
```

Friend-created leagues can remain on the legacy scorer while exact internal league IDs are tested in Canary.

## Testing Primary

### Production

Do not enable Production Primary merely to test one league. Canary already exercises the same worker on one league.

Production Primary is protected by all of the following:

- current mode must be Canary;
- at least one canary must be configured;
- at least three queued tasks must have completed successfully;
- schedule coverage must be complete;
- dispatcher heartbeat must be fresh;
- latest enqueue failures must be zero;
- latest stale recovery count must be zero;
- no queued or processing task may be active during the mode change;
- the project environment must be identified;
- a separate time-limited server-only approval must be valid;
- the exact phrase `ENABLE PRIMARY IN PRODUCTION` must be typed.

The separate approval document shape is:

```ts
appData/leagueAutomationPrimaryApproval
{
  enabled: true,
  projectId: 'nhl-fantasy-app-ab673',
  expiresAt: Timestamp, // short-lived planned cutover window
  note: string,
}
```

Do not create this approval during ordinary beta testing. It exists to prevent an accidental browser-only production cutover.

### Staging

Create a separate billed Firebase staging project with only synthetic users and fake leagues. In staging:

1. Deploy the same Functions and Hosting build.
2. Start in Shadow.
3. Run one canary.
4. Expand canaries.
5. Pass all promotion gates.
6. Type `ENABLE PRIMARY IN STAGING`.
7. Enable Primary while every league in that project is disposable.
8. Test queue spikes, retries, stale-worker recovery, reconnect storms, scoring fanout, and rollback.

## Immediate rollback

If Canary or Primary behaves unexpectedly:

1. Open Scoring Queue Control Center.
2. Press **Return to Shadow**.
3. Read the warning.
4. Press **Confirm Return to Shadow**.
5. Refresh and verify the server mode is Shadow.
6. Verify non-replay live leagues show `Legacy Scorer`.
7. Allow already-running idempotent tasks to finish or become stale safely.
8. Inspect queue tasks, schedule records, scoring fingerprints, and Game Center before retrying.

Returning to Shadow does not delete scores, roster windows, transactions, or task history. It prevents new ordinary queued-scoring admissions and restores the legacy scorer as the primary path.

The control center also includes **Copy Current Rollback**, which copies the exact project ID, revision, mode, allowlists, and dispatcher admission setting before a change.

## Audit and concurrency safety

Every configuration mutation has:

- a unique request ID;
- expected revision;
- before/after mode;
- before/after canary IDs;
- before/after internal test IDs;
- before/after dispatcher admission limit;
- platform-admin ID;
- environment and project ID;
- reason;
- server timestamp.

A stale tab receives an aborted response and must refresh. Retrying the exact request ID cannot apply the same change twice.

## What the control center intentionally does not do

It does not:

- increase the four-worker concurrency limit;
- increase the 24-task pending ceiling;
- certify 100,000 simultaneous users;
- make Historical Replay use live scoring;
- alter Production Scoring V3;
- alter Projection V11;
- edit roster windows, standings, transactions, waivers, or playoffs;
- bypass per-league leases or scoring ledgers;
- automatically promote modes when traffic grows.

Capacity tuning requires a Functions code change, redeployment, and staged load measurement. D1D changes cadence for exact Canaries only; it does not raise worker concurrency or certify broad near-live traffic. Rollout modes should be promoted before overload, not after failures begin.

## Function deployment for Batch P1F

Deploy the server controls and updated task worker before Hosting:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy --only functions:getLeagueAutomationQueueControlCenter,functions:updateLeagueAutomationQueueConfig,functions:queueLeagueAutomationCanaryCheck,functions:processLeagueAutomationTask -m "Batch P1F scoring queue control center"

firebase deploy --only hosting:app -m "Batch P1F safe canary rollout controls"
```

No Firestore rules, indexes, or data migration are required.

## Targeted deployment for D1D

After the original P1F queue foundation is live, deploy the D1D worker/snapshot changes and Hosting:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy --only "functions:processLeagueAutomationTask,functions:dispatchDueLeagueAutomation,functions:getLeagueAutomationQueueControlCenter,functions:updateLeagueAutomationQueueConfig,functions:queueLeagueAutomationCanaryCheck,functions:requestLeagueLiveScoringRefresh" \
  -m "D1D near-live scoring Canary"

firebase deploy --only hosting:app \
  -m "D1D near-live Canary controls and Training Camp player wording"
```

No Firestore Rule, index, TTL, or data migration deployment is required.

## Production posture after P1F and D1D

For the invite beta:

```text
Production mode: Shadow
Historical regression league: Serialized replay queue
Fake live test league: Exact near-live Canary after real NHL games begin
Friend leagues: Legacy scorer until exact Canary evidence is clean
Near-live Primary: Disabled
Production Primary: Locked
```

**Last reviewed:** August 2026
