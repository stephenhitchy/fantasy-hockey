# RinkRat High-Scale Automation Blueprint

**Purpose:** preserve the exact architectural work that should be completed before RinkRat is asked to support tens of thousands of simultaneously active managers.

**Important boundary:** this document is not a blocker for a small controlled invite beta. It is the source-controlled handoff for a later scale phase. Do not point a large load test at the production Firebase project.


## Batch P1F control and rollout layer implemented

Release Candidate 8 adds a platform-admin Scoring Queue Control Center on top of the P1E queue
foundation. It does not change worker capacity. It makes the future cutover safer by adding:

- searchable exact league identities and scoring-path labels;
- separate internal-test metadata and canary allowlisting;
- revision-checked, idempotent, audited configuration changes;
- server-side Canary eligibility validation;
- a manual single-league task that uses the exact Primary worker;
- a two-step Return to Shadow control;
- Primary promotion gates checked again inside the save transaction;
- a production-only, time-limited server approval requirement;
- a source-controlled rollout runbook.

Operational instructions are maintained in:

```text
docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md
```

The production posture remains Shadow through invite beta. Canary should begin with one fake live
league after real NHL games begin. Primary should be exercised first in a separate staging Firebase
project containing only disposable leagues.

## P1E foundation implemented

Release Candidate 7 now contains the first production-safe implementation layer from this
blueprint:

- server-owned `leagueAutomationSchedules/{leagueId}` due-time documents;
- hourly schedule-coverage bootstrap;
- a one-minute due-league dispatcher;
- deterministic `processLeagueAutomationTask` Cloud Tasks;
- the existing per-league scoring lease and scoring ledger retained as idempotency authority;
- bounded queue concurrency, a global active-lease pending-depth check, and retries;
- direct canary schedule lookup so a small test group cannot be hidden behind a large due backlog;
- exact-due task identifiers plus separate queued and processing leases;
- stale-task recovery;
- seven-day task-history retention and cleanup;
- Release Readiness backlog, coverage, failure, recovery, and mode reporting;
- explicit `shadow`, `canary`, and `primary` rollout modes.

The default mode is **shadow**. The existing ten-minute scoring sweep remains the primary
production path until staging canary results, schedule coverage, task duration, backlog age,
failure rate, and cost justify an intentional cutover. Therefore, the queue foundation is
implemented, but the large-scale scoring migration is not yet complete.

The optional Admin-SDK configuration document is:

```text
appData/leagueAutomationQueueConfig
```

Do not set it to `canary` or `primary` in production merely because the code is deployed.

## Current conclusion

RinkRat's browser application, Firebase Hosting delivery, per-league roster authority, exact draft-deadline task path, and P1E league-scoring queue foundation are a reasonable base for an invite beta and staged scale work. The largest remaining high-scale gap is proving the new scoring queue under staging load and intentionally moving production away from the centralized sweep.

At the current source settings:

- `runScheduledLeagueAutomation` still runs every 10 minutes and remains primary in the default shadow mode.
- `MAX_PARALLEL_LEAGUES` is `2` for that legacy path.
- P1E adds due-time schedule documents and deterministic per-league tasks, but it does not silently enable them for production scoring.
- The 100,000-manager balanced model estimates about 8,500 active scoring leagues.
- At an average of 5, 10, or 30 seconds per league, the system would need roughly 71, 142, or 425 concurrent league workers to finish within a ten-minute interval.

The draft system is more advanced than a simple scan. `functions/src/draft-automation.ts` already creates exact per-pick Cloud Tasks through `processDraftClockDeadline`, uses deterministic task IDs, checks the expected pick and start time, and retains `runScheduledDraftAutomation` as a recovery sweep. The remaining draft concern is recovery coverage and measured queue throughput, not the absence of a task queue.

## Area 1 — Scheduled league scoring

### Exact current code

File: `functions/src/league-automation.ts`

Relevant source areas:

- `const MAX_PARALLEL_LEAGUES = 2`
- `getCompletedDraftLeagueIds()`
- `mapWithConcurrency()`
- `runScheduledLeagueAutomation`
- `runLeagueAutomation()`
- the existing per-league automation lease and shared NHL scoring ledger
- `bootstrapLeagueAutomationSchedules`
- `dispatchDueLeagueAutomation`
- `processLeagueAutomationTask`
- `recoverStaleLeagueAutomationQueue`
- `cleanupLeagueAutomationTaskHistory`

P1E status: the target task path now exists and defaults to shadow mode. The remaining work in
this area is measured canary parity, throughput tuning, primary-mode cutover, and eventual removal
of broad completed-draft discovery from the normal scoring path.

### Risk

One scheduled Function invocation discovers every completed-draft league and directly performs the work. A slow league consumes one of only two in-process worker slots. The ten-minute scheduler is also responsible for discovery, execution, retry visibility, and the final summary. At high league counts, a backlog can grow faster than the sweep can drain it.

### Recommended target design

Keep the existing `runLeagueAutomation()` logic as the per-league authority. Change only how work reaches it.

```text
Cloud Scheduler
    ↓
small due-league dispatcher
    ↓
Cloud Tasks queue
    ↓
one idempotent task per league and scoring-ledger version
    ↓
existing per-league lease
    ↓
runLeagueAutomation(leagueId)
    ↓
per-task status + aggregate backlog metrics
```

Create a task-queue Function such as:

```text
processLeagueAutomationTask
```

Suggested payload:

```ts
interface LeagueAutomationTaskPayload {
  leagueId: string;
  dueAtMilliseconds: number;
  ledgerVersion: string;
  reason: 'scheduled' | 'nhl-ledger-update' | 'recovery';
  taskSchemaVersion: 1;
}
```

Suggested deterministic idempotency key:

```text
sha256(leagueId + ledgerVersion + dueAtBucket + taskSchemaVersion)
```

The worker must remain idempotent because Cloud Tasks is an at-least-once system. A duplicate task should acquire or observe the existing lease, compare the scoring ledger and saved publication version, and exit without duplicating points, windows, transactions, or standings.

### Due-league discovery

Do not scan every completed league forever. Add a small indexed scheduling document per league, for example:

```text
leagues/{leagueId}/automation/schedule
```

Suggested fields:

```ts
{
  schemaVersion: 1,
  nextScoringAt: Timestamp,
  shard: number,                 // stable 0..N-1 hash of leagueId
  scoringEnabled: boolean,
  lastEnqueuedLedgerVersion: string | null,
  lastCompletedLedgerVersion: string | null,
  lastCompletedAt: Timestamp | null,
  lastDurationMilliseconds: number | null,
  consecutiveFailureCount: number,
  lastErrorCode: string | null,
  updatedAt: Timestamp,
}
```

The dispatcher should query only due documents, ordered by `nextScoringAt`, and paginate. A stable shard permits several dispatchers to run independently without querying the same key range.

### Queue controls

Start conservatively in staging:

- one queue in `us-central1`, matching the Functions and Firestore region;
- explicit `maxConcurrentDispatches`;
- explicit dispatch rate;
- retries with exponential backoff;
- a dead-letter or terminal-failure record after the configured retry limit;
- no user-facing request waits for this queue.

Increase queue throughput only after measuring average and p95 league-processing duration. Do not select a concurrency value from the 100K model alone.

### Migration sequence

1. Add the task worker and scheduling documents without changing the current sweep.
2. Run the new worker in **shadow mode** for test leagues. It should calculate eligibility and report what it would process, but not publish twice.
3. Compare the shadow result with the existing scheduled sweep.
4. Enable queued execution for one internal league.
5. Expand to 1%, 10%, and then 100% of staging leagues.
6. In production, keep the old sweep as a paginated recovery worker during the first release.
7. Once queue age and failure metrics are stable, make the queue primary and reduce the sweep to stale-league recovery only.

### Rollback

Use a per-league or global feature flag to stop new task enqueueing. Leave already-created tasks idempotent and safe to drain. Re-enable the existing sweep without changing score documents or roster-window schemas.

## Area 2 — Draft deadline automation

### Exact current code

File: `functions/src/draft-automation.ts`

Primary path already present:

- `scheduleDraftClockTask()`
- deterministic `buildDraftClockTaskId()`
- `processDraftClockDeadline`
- `continueServerDraftAutomation`
- `processAutoDraftQueueChange`
- per-league draft automation lease

Recovery path:

- `DRAFT_AUTOMATION_SCAN_LIMIT = 250`
- `getAutomatedDraftLeagueIds()`
- `runScheduledDraftAutomation`
- sequential recovery loop with `maxInstances: 1`

### Risk

The exact Cloud Tasks path is the correct primary architecture. The high-scale gaps are:

- only 10 concurrent task dispatches are configured;
- real task duration and deadline drift have not been measured at draft-night load;
- the fallback sweeper inspects only 250 active drafts and has no persisted cursor or shard;
- a broad queue incident could leave some leagues outside the one-minute recovery scan.

### Recommended solution

Do not replace the exact task path. Strengthen it.

1. Add queue-age, task-duration, retry, and deadline-drift metrics.
2. Test 100, 500, 2,000, and 5,000 simultaneous draft rooms in staging.
3. Tune `maxConcurrentDispatches` from measured task duration and Firestore contention, not from theoretical user count.
4. Add a `nextDraftAutomationAt` field to the draft document or a small automation schedule document.
5. Paginate the fallback worker by due time and stable shard instead of repeatedly taking an unqualified first 250.
6. Keep the existing expected-pick and expected-start-time checks so stale tasks remain harmless.
7. Preserve deterministic task IDs and the per-league lease.

Suggested recovery query shape:

```text
collectionGroup('draft')
  where status in ['scheduled', 'live']
  where nextAutomationAt <= now
  where recoveryShard == currentShard
  orderBy nextAutomationAt
  limit pageSize
```

## Area 3 — NHL API Proxy, data fanout, and shared caching

### Exact current code

File: `functions/src/index.ts`

Relevant source area:

- `nhlApiProxy`
- `maxInstances: 10`
- in-memory `nhlProxyResponseCache`
- stale-on-upstream-error behavior

Related competitive data foundation:

- shared NHL game-result ledger used by scoring
- server-side projection and replay services

### Risk

The in-memory cache is per Function instance. During a cold burst, several instances can request the same NHL resource before any one instance has warmed its cache. Browser pages should not cause one upstream NHL request per manager.

### Recommended solution

Use a server-owned ingestion and shared-cache path for all competitive NHL data:

```text
NHL API
  ↓
rate-limited ingestion worker
  ↓
shared Firestore or Cloud Storage cache + ETag/source timestamp
  ↓
NHL result ledger
  ↓
league automation tasks and read-only browser views
```

Required properties:

- request coalescing by NHL endpoint and data version;
- shared cache visible to every Function instance;
- explicit fresh and stale TTLs;
- conditional upstream requests where supported;
- one saved source timestamp and hash;
- stale-data serving during brief NHL API outages;
- upstream 429 and 5xx backoff;
- no competitive score publication from an unvalidated partial response.

Keep the public proxy for safe read-only views if needed, but do not make it the authoritative ingestion path for thousands of leagues.

## Area 4 — Firestore listeners and cold-start reads

### Current instrumentation

The P1A client-health work already records active Firestore listeners by route. Use that monitor to replace the capacity model's route assumptions with measured values.

### Risk

The 100K balanced estimate currently predicts about 630,000 simultaneous listeners and more than six million cold-start reads. Firestore can support very large real-time systems, but query shape, document fanout, reconnect storms, and billing matter.

### Recommended solution

1. Record listener counts and initial reads for Dashboard, Game Center, Draft Room, My Team, and Available Players on real devices.
2. Verify listeners are released after every route change.
3. Remove duplicate subscriptions to the same league, roster, draft, or profile document.
4. Prefer one shared league-level result document over repeated per-user NHL requests.
5. Cache stable public profile and team identity data.
6. Paginate large historical collections rather than attaching broad listeners.
7. Label cached/offline content as stale and read-only.
8. Test reconnect storms separately from ordinary steady traffic.
9. Ramp new collection traffic gradually rather than jumping directly to peak load.

## Area 5 — Automation observability

The current `appData/leagueAutomation` and `appData/draftAutomation` summaries are useful but insufficient for a large queue.

Add platform-admin metrics for:

- due leagues;
- enqueued tasks;
- oldest task age;
- p50, p95, and p99 task duration;
- queue retry count;
- terminal failures;
- scoring freshness by league;
- draft deadline drift;
- lease contention;
- upstream NHL response age;
- number of leagues outside the target scoring interval.

A release should alert when:

- oldest scoring task exceeds the live-score freshness target;
- the backlog grows for two consecutive intervals;
- terminal failures are nonzero;
- draft deadline p95 drift exceeds the accepted threshold;
- a league has not completed automation within two expected intervals.

## Area 6 — App Check and abuse controls

The web client already contains App Check initialization support. Before enforcement:

1. register the production web app with reCAPTCHA Enterprise;
2. deploy the public site key;
3. monitor verified, outdated, invalid, and unknown-origin traffic;
4. test login, draft, roster, scoring, feedback, and deletion from supported browsers;
5. enable enforcement only after legitimate traffic is verified;
6. keep Authentication, server authorization, rate limits, and idempotency—App Check is complementary, not a replacement.

## Staged load-test plan

Use a separate billed Firebase staging project with synthetic accounts and leagues.

| Stage | Concurrent clients | Purpose |
|---|---:|---|
| 1 | 100 | Correctness, metrics, and cost baseline |
| 2 | 500 | Listener cleanup and Function contention |
| 3 | 2,000 | Draft task queue and league-scoring queue |
| 4 | 5,000 | Reconnect storms, game-night fanout, and backlog recovery |
| 5 | 20,000 | Sharding, queue tuning, p95/p99, and cost projection |
| 6 | 100,000 | Distributed peak exercise after all earlier gates pass |

Run separate scenarios:

- read-only Game Center traffic;
- all leagues drafting;
- live score fanout;
- add/drop and waiver bursts;
- cold application launch;
- network reconnect storm;
- upstream NHL slowdown or outage.

## Minimum pass criteria

Define exact numbers before each test. Recommended initial gates:

- no duplicate draft picks;
- no duplicate fantasy scoring;
- no skipped seventh-game rollover;
- no lost or prematurely activated scheduled transaction;
- no two active workers publishing the same league version;
- less than 1% protected-action failure rate;
- queue backlog returns to zero after the test spike;
- p95 scoring freshness within the intended live interval;
- draft deadline drift within the accepted clock tolerance;
- Firestore listeners return to route baseline after navigation;
- predictable reads, writes, Function time, and cost per active manager-hour.

## Exact implementation order when scale work resumes

1. Continue measuring real listener and automation durations from the invite beta.
2. **Completed in P1E:** add per-league automation scheduling documents and due-time health.
3. **Completed in P1E:** create `processLeagueAutomationTask` using the existing
   `runLeagueAutomation()` logic.
4. **Completed in P1E:** add deterministic task IDs, bounded queue rate limits, retries,
   stale-task recovery, and retained task status.
5. Run the deployed foundation in shadow mode and confirm 100% schedule coverage.
6. In staging, canary one internal league, then 1%, 10%, and 100% of staging.
7. Make queued scoring primary only after parity and throughput gates pass, retaining the sweep as
   recovery.
8. Paginate and shard the draft recovery sweep.
9. Move competitive NHL ingestion behind a shared cache and ledger.
10. Run staged load tests through 20,000 before considering 100,000.

## Official platform references

- Firebase task queue Functions: https://firebase.google.com/docs/functions/task-functions
- Cloud Tasks behavior, retries, rate limits, and idempotency: https://cloud.google.com/tasks/docs/dual-overview
- Cloud Functions scaling, concurrency, and instance limits: https://firebase.google.com/docs/functions/manage-functions
- Firestore real-time queries at scale: https://firebase.google.com/docs/firestore/real-time_queries_at_scale
- Firestore gradual traffic ramp guidance: https://firebase.google.com/docs/firestore/best-practices
- Firebase App Check monitoring: https://firebase.google.com/docs/app-check/monitor-metrics

**Last reviewed:** August 2026

## D1C shared NHL cache Shadow foundation

Data Infrastructure Batch D1C adds the first cross-instance storage layer for server-owned NHL responses. The foundation uses deterministic canonical URL hashes, JSON content hashes, route-specific freshness, bounded 700 KiB payloads, duplicate suppression, TTL, and health counters. It is deliberately Shadow-only: direct upstream/process-local responses remain authoritative and cached documents are marked ineligible for authoritative reads.

This does not remove the existing capacity warning yet. Before promotion, RinkRat must add oversized-response storage, compare direct and shared hashes in staging, model stat-correction replacement, measure Firestore read/write cost, define shared-data freshness SLOs, and prove an exact rollback to direct upstream reads. Only then may the shared layer move through canary and Primary ingestion modes.
