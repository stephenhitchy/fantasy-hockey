# FF1.34 — Draft Queue Ramp Warmup

Status: source implementation candidate. It requires independent review, a
clean merge, exact staging deployment, and a repeated D1N-C stage-100 ramp
before it can be accepted.

## Observed problem

The first completed D1N-C stage-100 run processed every one of its 100 unique
operations and all ten planned duplicate deliveries without a terminal error,
retry, duplicate result, or recovered Firestore contention. Protected
competitive documents did not change. Scoring p95/p99 was 149/1,160
milliseconds and total queue-age p95/p99 was 33,755/34,563 milliseconds.

The run still failed its fixed Draft timing gate. Fifty Draft operations were
scheduled as one cold burst. Their deadline-drift p95/p99 reached
30,230/30,620 milliseconds instead of the required 2,000/5,000 milliseconds.
Drift increased with operation ordinal while the existing ten-slot queue and
twenty-instance Function remained healthy. That shape is consistent with the
documented Cloud Tasks ramp behavior for an idle queue receiving many
simultaneously scheduled tasks. It is not evidence of a failed transaction or
an incorrect Draft result.

The failed raw evidence is retained outside Git. Its Monitoring and settled
Billing evidence must not be represented as a pass, and stage 500 remains
blocked.

## Architecture

Keep the existing queue, concurrency, retry, timeout, and server-authoritative
Draft transaction. For each saved Draft schedule, enqueue:

1. one deterministic, write-free queue warmup at T-60 seconds;
2. one deterministic, write-free queue warmup at T-10 seconds; and
3. the existing deterministic authoritative scheduled-start task at exact zero.

The warmups execute through `processDraftClockDeadline`, validate their
versioned bounded payload, emit aggregate timing only, and return. They perform
no Firestore read or write and cannot start a Draft, create a pick, change a
clock, or schedule a deadline. Their only purpose is to give the existing
queue and Function time to ramp before clustered exact-zero work arrives.

Already-enqueued FF1.25 start tasks remain safe during rollout and rollback.
The consumer retains the bounded early-delivery wait, then rereads the exact
Draft schedule and uses the unchanged readiness transaction. New producers
schedule authoritative start work at zero and use separate warmup identities.

## D1N-C measurement behavior

The load harness mirrors the production topology instead of bypassing it. At
stage 100 it schedules 50 T-60 warmups and 50 T-10 warmups on the real Draft
queue, followed by 50 measured Draft probes at one exact timestamp. Therefore
`draftQueueWarmupTaskCount` must equal the selected operation stage: 100, 500,
2,000, or 5,000. Warmups are included in the same Cloud Monitoring and settled
Billing window, in expected task-drain identities, and in cost. They are not
counted as additional synthetic competitive operations or successful results.

The fixed gates remain unchanged:

- Draft deadline-drift p95 no greater than 2 seconds;
- Draft deadline-drift p99 no greater than 5 seconds;
- queue-age p95/p99 no greater than 60/120 seconds;
- complete task drain within 120 seconds;
- zero terminal errors and duplicate results;
- retry and recovered-contention rates no greater than one percent;
- measured Draft concurrency no greater than ten; and
- stage-specific settled cost below its existing ceiling.

No threshold may be relaxed to make the repair pass. Stage 500 remains blocked
until a new stage-100 run is finalized with Monitoring and Billing evidence and
independently reviewed.

## Acceptance and edge cases

- A normal saved schedule creates one exact start identity and exactly two
  warmup identities for that schedule revision.
- Duplicate scheduler/trigger delivery converges through deterministic task
  identities.
- Rescheduling creates new identities. Old exact-start work remains a no-op
  after the existing schedule reread; old warmups remain harmless and
  write-free.
- A schedule discovered late dispatches each still-relevant warmup after the
  existing 250-millisecond enqueue floor and never schedules into the past.
- A malformed or unknown warmup payload is acknowledged without a write.
- Failure to enqueue the authoritative task or either warmup fails visibly so
  the minute worker can retry the deterministic schedule.
- A preceding-release early start task is still understood by the new
  consumer and cannot open before zero.
- The exact scheduled start continues to fail closed when Projection V11 or
  availability readiness is missing or changed.

## Tests

Focused coverage proves deterministic identities, T-60/T-10 dispatch,
exact-zero dispatch, late enqueue, malformed-payload refusal, a write-free
warmup handler, legacy early-task compatibility, unchanged queue limits,
stage-balanced harness waves, expected task drain, evidence completeness, and
fixed preflight thresholds. The Firestore Emulator D1N-C suite, Functions
TypeScript build, inherited release gate, Angular/Functions build, whitespace
check, and clean-source guard remain required before staging.

## Exact staging deployment boundary

Stephen deploys from the clean merged commit in consumer-first order:

1. `functions:processDraftClockDeadline` — understands new warmups and exact
   zero plus preceding early deliveries;
2. `functions:processLeagueAutomationTask` — runtime behavior is unchanged,
   but D1N-C requires its immutable common source archive to match the commit;
3. `functions:runScheduledDraftAutomation` — produces the new task set;
4. `functions:continueServerDraftAutomation` — produces the new task set after
   schedule writes; and
5. only the site-pinned staging Hosting target through
   `.d1n-staging.firebase.json`, so the release manifest identifies the exact
   source.

No Production deployment belongs to this evidence repair. Do not deploy
Rules, indexes, TTL, App Check, queue configuration, worker limits, scoring
queues, canonical workers, or unrelated Functions.

## Rollback

Stop new task production first by restoring the preceding reviewed revisions
of `continueServerDraftAutomation` and `runScheduledDraftAutomation`. Then
restore `processDraftClockDeadline` and the archive-parity
`processLeagueAutomationTask` revision, followed by the preceding staging
Hosting release. Retained warmups are safe under the new consumer; after the
old consumer is restored they are also safe because task-authenticated unknown
payloads fail before any valid league or Draft mutation path. Preserve the
failed and repeated stage-100 evidence, queue history, and aggregate logs.

## Protected contracts

This slice changes no Production Scoring V4 value, Projection V11 formula or
hash, six-game ownership, Game 7 rollover, immutable started window, pick or
clock transaction, roster/add-drop/waiver/IR authority, standings, playoffs,
Rules, indexes, TTL, App Check mode, scoring queue mode, canonical authority,
queue rate/concurrency, worker/pending-task limit, or dependency. Exact-once
competitive authority remains in the existing Firestore transactions.
