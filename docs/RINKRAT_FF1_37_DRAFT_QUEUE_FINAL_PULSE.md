# FF1.37 — Draft Queue Final Pulse

Status: source implementation, focused regression coverage, the complete
inherited release gate, and both builds pass. Clean merge, exact staging
deployment, and a fresh finalized D1N-C stage-100 pass remain required before
acceptance.

## Evidence-driven problem

FF1.36 was merged and deployed on exact staging source `118f113b`. Its guarded
stage-100 run completed 100/100 operations and all ten planned duplicates with
zero terminal errors, retries, duplicate competitive results, recovered
contention, or protected-state changes. Scoring p95/p99 was 174/1,506
milliseconds, queue-age p95/p99 was 34,284/35,087 milliseconds, the corrected
post-eligibility drain was 5,745 milliseconds, and Draft p95/p99 was
2,416/2,521 milliseconds. The unchanged 2,000-millisecond p95 gate still failed
and stage 500 remains blocked.

Aggregate logs proved the T-10 authority primes succeeded. Their first ten
reads absorbed roughly 0.8–1.1 seconds of Firestore initialization and all
fifty primes completed about seven seconds before zero. Exact-zero Draft probe
transactions then took only about 0.18–0.28 seconds, but the queue dispatched
the fifty-task burst at roughly 20–22 tasks per second after that idle gap.
The remaining failure is dispatch continuity, not transaction contention or
authority-path initialization.

## Narrow repair

Retain the deterministic T-180-through-T-10 cadence, T-10 read-only authority
prime, exact zero authority task, retry policy, ten-dispatch concurrency,
Function limits, and every fixed threshold. Add one final write-free queue
pulse at T-5 for each scheduled Draft. It exercises only the already-existing
warmup handler and performs no Firestore read, write, transaction, clock
transition, or pick.

At stage 100 the synthetic harness therefore owns 950 warmups: 850 earlier
read-free tasks, fifty T-10 authority primes, and fifty T-5 read-free pulses.
The additional work remains visible in expected-task drain, Cloud Monitoring,
and settled Billing evidence. Queue drain still begins only when scheduled
work is eligible, and operation queue age and Draft drift remain measured from
their exact due time.

## Acceptance and edge cases

- The T-5 pulse is non-mutating and read-free.
- Only T-10 may perform the optional authority-path read.
- A schedule created less than five seconds before zero skips the elapsed
  pulse and retains the exact task's normal bounded behavior.
- Deterministic warmup identities keep duplicate scheduling idempotent.
- Stale warmups cannot affect Draft state; exact-zero authority rereads and
  validates the saved schedule.
- Existing FF1.34–FF1.36 task payloads remain compatible.
- Draft p95/p99 stays fixed at 2,000/5,000 milliseconds.
- Queue/worker limits and cost ceilings are unchanged.

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
Preserve the failed exact-`118f113b` raw evidence and aggregate logs.

## Protected contracts

Production Scoring V4, Projection V11, six-game ownership, Game 7 rollover,
immutable started windows, Draft pick/clock transactions, roster and
transaction authority, standings, playoffs, Rules, indexes, TTL, App Check,
scoring queue/canonical modes, and every queue/worker limit remain unchanged.
