# FF1.38 — Draft Queue Concurrency

Status: merged and deployed on exact isolated-staging source `cd6eede0`. Its
fresh stage-100 run preserved every correctness invariant but recorded Draft
p95/p99 drift of 5,120/5,324 milliseconds. Both unchanged gates failed, stage
500 remains blocked, and FF1.39 supersedes this queue-ceiling-only hypothesis.

## Evidence-driven problem

FF1.37 was merged and deployed on exact isolated-staging source `084f352c`.
Its guarded stage-100 run completed 100/100 operations and all ten planned
duplicates with zero terminal errors, retries, duplicate competitive results,
recovered contention, or protected-state changes. Scoring p95/p99 was
525/1,265 milliseconds, queue-age p95/p99 was 45,478/46,274 milliseconds, the
corrected post-eligibility drain was 4,338 milliseconds, and Draft p95/p99 was
2,422/2,523 milliseconds. The unchanged 2,000-millisecond p95 gate still failed
and stage 500 remains blocked.

Logs prove the T-10 authority primes and T-5 read-free pulses completed before
zero. Exact-zero transactions then took about 0.17–0.26 seconds, but only ten
Draft tasks could dispatch concurrently. Measured runtime concurrency was four
for scoring and six for Draft during the run. The remaining tail is therefore
the Draft Cloud Tasks dispatch ceiling, not Firestore contention, transaction
duration, Function instance capacity, readiness, or missing warmup work.

## Narrow repair

Raise only `processDraftClockDeadline`'s queue dispatch concurrency from ten to
twenty. Keep its 500-dispatch-per-second rate, burst size, five-attempt retry
policy, two-second minimum backoff, 120-second timeout, twenty-instance Function
ceiling, per-instance request concurrency, payloads, task identities, warmup
cadence, exact-zero transaction, and minute fallback unchanged.

This is the bounded concurrency-tuning step required by roadmap item SC1.10.
It does not relax the fixed Draft p95/p99 gate of 2,000/5,000 milliseconds.
The D1N-C evaluator instead records twenty as the maximum permitted Draft
worker concurrency so the deployed topology and evidence contract remain
identical. A fresh stage-100 run must still prove the actual observed maximum,
all task drain, Monitoring usage, settled Billing cost, and every invariant.

## Acceptance and edge cases

- Stage 100 remains blocked unless all 100 operations and ten duplicates
  converge exactly once with zero terminal errors or contention.
- Draft deadline-drift p95/p99 remains at most 2,000/5,000 milliseconds.
- Scoring concurrency remains capped at four and its queue is unchanged.
- Draft concurrency above twenty fails closed in preflight and final evidence.
- Duplicate task delivery retains deterministic result suppression.
- Stale or early scheduled-start work retains the existing schedule reread and
  cannot open a Draft or create a pick.
- More dispatch capacity cannot bypass the existing transactional Draft
  authority; competing calls still serialize on the same authoritative state.
- Stage 500 remains blocked until the new stage-100 run is finalized with Cloud
  Monitoring and settled Cloud Billing evidence and independently reviewed.

## Measured result

The exact `cd6eede0` run completed 100/100 operations and all ten duplicates
with zero terminal errors, retries, duplicate results, recovered contention,
or protected-state changes. Scoring p95/p99 was 400/982 milliseconds,
queue-age p95/p99 was 46,107/46,904 milliseconds, corrected drain was 9,380
milliseconds, and Draft p95/p99 was 5,120/5,324 milliseconds.

All 1,005 Draft-queue requests returned HTTP 204. Warmups reached twenty
concurrent requests, while measured transactions remained about 0.19–0.24
seconds. Cloud Tasks nevertheless smoothed the fifty-five exact-zero
deliveries across about 5.3 seconds at roughly ten per second. The configured
ceiling was not the remaining determinant; see
`docs/RINKRAT_FF1_39_DRAFT_START_RESERVATION.md`.

## Exact staging boundary and rollback

After clean review and merge, deploy in consumer-first order:

1. `functions:processDraftClockDeadline`
2. archive-parity `functions:processLeagueAutomationTask`
3. site-pinned staging Hosting through `.d1n-staging.firebase.json`

The scoring worker has no runtime behavior change; its deployment only keeps
the immutable common Functions source archive aligned with the clean commit
for strict preflight verification. No Draft producer changed in FF1.38.

No Production deployment belongs to this candidate. Roll back by restoring
the exact preceding `084f352c` revisions of `processDraftClockDeadline`, then
archive-parity `processLeagueAutomationTask`, followed by the preceding staging
Hosting release. Preserve the failed exact-`084f352c` raw evidence, run root,
Cloud logs, Monitoring window, and Billing window for audit.

## Protected contracts

Production Scoring V4, Projection V11, six-game ownership, Game 7 rollover,
immutable started windows, Draft pick/clock transactions, roster and
transaction authority, standings, playoffs, Rules, indexes, TTL, App Check,
scoring queue/canonical modes, scoring concurrency, Draft rate and retry policy,
Function instance/request concurrency, and every latency/cost threshold remain
unchanged. Only the isolated Draft task queue's maximum concurrent dispatches
changes from ten to twenty after staging measurements demonstrated the need.
