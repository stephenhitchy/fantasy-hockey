# FF1.36 — Draft Authority-Path Prime

Status: source implementation and regression coverage complete. The inherited
release gate and both builds pass. Clean merge, exact staging deployment, and
a fresh finalized D1N-C stage-100 pass are required before acceptance.

## Evidence-driven problem

FF1.35's exact `7880747e` stage-100 run completed 100/100 operations and all
ten duplicate deliveries exactly once with zero errors, retries, recovered
contention, duplicate results, or protected-state changes. Draft p95/p99 drift
improved again, from 10,426/10,826 milliseconds to 3,536/3,736 milliseconds.
The p99 gate passed, but p95 still exceeded the unchanged 2,000-millisecond
limit.

Aggregate logs showed that the final fifty write-free warmups drained in about
2.3 seconds. At exact zero, however, the first authoritative operations spent
roughly 0.6–1.7 seconds initializing the Firestore authority path because the
warmup handler had never opened it. Later operations completed in roughly
0.2 seconds.

The same run exposed a measurement defect: `drainMilliseconds` began when
future tasks finished enqueueing, so it counted the intentional wait until
their shared exact deadline. The queue's measured work actually drained in
under four seconds, but the raw value was 170,209 milliseconds.

## Narrow repair

Keep FF1.35's deterministic T-180-through-T-10 cadence, exact-zero task,
ten-dispatch concurrency, retries, Function limits, and all fixed thresholds.
Only the final T-10 warmup performs one read-only get of that Draft's exact
authority document. Earlier warmups remain read-free. No warmup can write,
start a clock, make a pick, open a transaction, or alter readiness.

The D1N synthetic harness uses one bounded nonexistent league identity per
Draft probe, so its T-10 prime exercises the same Firestore client path without
reading a real league. All fifty reads remain visible in Cloud Monitoring and
settled cost evidence.

Measure queue drain from the later of producer completion and the instant
scheduled work becomes eligible. This preserves the existing two-minute gate
while excluding intentional future scheduling. Queue age and Draft deadline
drift remain measured from each operation's own scheduled time. The drain ends
only after the runner confirms that every expected Cloud Task identity is
absent, so a late warmup or retry remains visible.

## Acceptance and edge cases

- The T-10 prime is a single document read and never a write or transaction.
- Already-enqueued FF1.34/FF1.35 warmups without `leagueId` remain compatible
  and simply skip the optional authority read.
- Invalid optional league identities skip the read without exposing raw data.
- A transient prime-read failure is logged without retrying the optional
  warmup; the exact-zero task retains its normal authoritative read and retry.
- Stale schedule warmups may read but cannot mutate; the exact-zero task still
  rereads and validates current authority.
- Stage 100 still owns exactly 900 warmups, including fifty authority primes.
- Draft p95/p99 remains fixed at 2,000/5,000 milliseconds.
- Queue-drain timing is not invented or estimated; only its eligibility origin
  is corrected, and the retained FF1.35 raw file is never rewritten.

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
Preserve all three failed stage-100 runs and their aggregate logs.

## Protected contracts

Production Scoring V4, Projection V11, six-game ownership, Game 7 rollover,
immutable started windows, Draft pick/clock transactions, roster and
transaction authority, standings, playoffs, Rules, indexes, TTL, App Check,
scoring queue/canonical modes, and every queue/worker limit remain unchanged.
