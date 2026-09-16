# FF1.35 — Sustained Draft Queue Ramp

Status: source implementation candidate. Independent review, clean merge,
exact staging deployment, and a fresh finalized D1N-C stage-100 pass are
required before acceptance.

## Evidence-driven problem

FF1.34's exact `9cc3dd01` stage-100 run improved clustered Draft p95/p99
deadline drift from 30,230/30,620 milliseconds to 10,426/10,826 milliseconds,
but still failed the fixed 2,000/5,000-millisecond gate. All 100 operations and
ten duplicates converged exactly once with zero errors, retries, recovered
contention, or protected-state changes.

Aggregate Cloud Run logs explain the remaining drift. Fifty T-60 warmups
completed at about one dispatch per second. Fifty T-10 warmups and the fifty
measured Draft tasks then completed at about five dispatches per second. The
queue was healthy and the handler itself completed measured work in roughly
180 milliseconds, but two isolated waves did not provide a sustained history
of successful dispatches. This matches Google Cloud Tasks' documented cold or
idle queue ramp behavior:
`https://docs.cloud.google.com/tasks/docs/manage-cloud-task-scaling` and
`https://docs.cloud.google.com/tasks/docs/common-pitfalls`.

## Narrow repair

Keep the existing queue, ten-dispatch concurrency, retry policy, Function
limits, and server-authoritative transactions. Replace the two isolated
warmups with one deterministic write-free warmup every ten seconds from T-180
through T-10. Each normal Draft schedule therefore owns eighteen bounded
warmup identities and one unchanged authority identity dispatched at exact zero.

The cadence gives clustered starts a sustained backlog and success history
without sleeping inside a worker, changing a queue limit, reading Firestore,
or writing competitive state. A warmup whose nominal dispatch time has already
passed is skipped. It is never dumped into the queue where it could compete
with an imminent authoritative start.

At D1N stage 100, fifty measured Draft operations create 900 warmups. The
warmups are included in task-drain, Cloud Monitoring, and settled Billing cost
evidence, but cannot create a result. `draftQueueWarmupTaskCount` must equal
nine times the selected operation stage. The fixed latency, queue-age,
concurrency, error, contention, invariant, and cost gates remain unchanged.

## Acceptance and edge cases

- Eighteen deterministic warmup identities and one exact start identity exist
  per schedule revision when all nominal times remain in the future.
- Duplicate producer delivery converges through task identity.
- Rescheduling creates new identities; stale warmups remain write-free and the
  existing exact task rereads schedule authority.
- Late scheduling skips elapsed warmups and retains the exact authority task.
- Malformed or unknown warmups are acknowledged without Firestore access.
- The preceding T-60/T-10 consumer and legacy FF1.25 early-task handler remain
  compatible throughout rollout and rollback.
- No threshold or queue/worker limit is relaxed.

## Exact staging boundary and rollback

After clean review and merge, deploy in consumer-first order:

1. `functions:processDraftClockDeadline`
2. archive-parity `functions:processLeagueAutomationTask`
3. `functions:runScheduledDraftAutomation`
4. `functions:continueServerDraftAutomation`
5. site-pinned staging Hosting through `.d1n-staging.firebase.json`

No Production deployment belongs to this repair. Roll back producers first
(`continueServerDraftAutomation`, then `runScheduledDraftAutomation`), followed
by `processDraftClockDeadline`, archive-parity
`processLeagueAutomationTask`, and the preceding staging Hosting release.
Preserve both failed stage-100 runs and all associated aggregate logs.

## Protected contracts

Production Scoring V4, Projection V11, six-game ownership, Game 7 rollover,
immutable started windows, Draft pick/clock transactions, roster and
transaction authority, standings, playoffs, Rules, indexes, TTL, App Check,
scoring queue/canonical modes, and every queue/worker limit remain unchanged.
