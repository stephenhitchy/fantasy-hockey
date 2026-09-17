# FF1.39 — Bounded Draft-start Reservation

Status: source implementation, focused regression coverage, the complete
inherited gate, both builds, final diff review, exact isolated-staging
deployment, and one finalized stage-100 pass are complete at `a462006d`.
Later client-only releases advanced `main` and staging Hosting, so the retained
pass cannot satisfy the same-revision prerequisite for stage 500. A fresh
stage-100 pass on the exact current revision remains required. Stage 500 is
blocked.

## Evidence-driven problem

FF1.38 was merged and deployed on exact isolated-staging source `cd6eede0`.
Its guarded stage-100 run again completed 100/100 operations and all ten
planned duplicates exactly once with zero terminal errors, retries, duplicate
results, recovered contention, or protected-state changes. Scoring p95/p99 was
400/982 milliseconds. Draft p95/p99 regressed to 5,120/5,324 milliseconds and
failed both unchanged 2,000/5,000-millisecond gates.

Cloud Run logs showed 1,005/1,005 Draft-queue requests returned HTTP 204. The
queue reached its configured twenty concurrent dispatches during warmups and
the exact transactions remained roughly 0.19–0.24 seconds, but the fifty-five
measured deliveries were smoothed across about 5.3 seconds at roughly ten per
second. This matches Cloud Tasks' documented behavior for idle queues and
large groups scheduled for the same instant. Raising a concurrency ceiling is
therefore insufficient to guarantee an exact start.

## Narrow repair

Dispatch the one deterministic scheduled-start authority task five seconds
before its saved server deadline. The existing handler may hold it only inside
the bounded ten-second early-arrival window. It rereads the Draft after the
wait, rejects stale or rescheduled authority, and cannot open the Draft, start
the clock, or create a pick before zero.

Raise only the Draft queue's concurrent-dispatch ceiling from twenty to sixty
so stage 100 can reserve its fifty primary Draft starts plus five intentional
duplicate deliveries without blocking later reservations. Retain the
500-dispatch-per-second rate, five-attempt retry policy, two-second minimum
backoff, 120-second timeout, twenty-instance Function ceiling, per-instance
request concurrency, and exact transactional authority.

The reserved start replaces FF1.37's read-free T-5 pulse. The eighteen
T-180-through-T-10 warmups remain, including the one read-only T-10 authority
prime. Stage 100 therefore records 900 warmups rather than 950. The D1N-C probe
uses the same five-second reservation, waits without touching Firestore, and
begins deadline-drift and transaction timing only at zero. All held execution
time remains visible to Cloud Run, Cloud Monitoring, and settled Billing cost
evidence.

## Acceptance and edge cases

- No reserved task can mutate Draft state before the saved deadline.
- The handler rereads authority after waiting; cancellation or rescheduling
  makes the old task stale.
- A task arriving more than the existing ten-second bound fails and retries
  rather than holding arbitrary worker capacity.
- A schedule saved inside five seconds reserves as soon as safely possible;
  a past-due schedule uses the existing immediate bounded fallback.
- Deterministic task identity preserves duplicate producer convergence.
- Already-enqueued FF1.37/FF1.38 T-5 pulse tasks are acknowledged without a
  read or write. A rollback consumer already supports the new task's bounded
  early wait, so producer-first rollback remains compatible.
- Stage 100 must still complete 100 operations and ten planned duplicates with
  zero terminal errors, duplicate competitive results, or protected-state
  changes.
- Draft p95/p99 remains fixed at 2,000/5,000 milliseconds. No threshold is
  relaxed.
- Draft concurrency above sixty fails closed in preflight and final evidence.
- Stage 500 remains blocked until the new stage-100 run is finalized with
  Cloud Monitoring usage, settled Cloud Billing cost, and independent review.

## Finalized `a462006d` stage-100 evidence

The exact staging rollout and repeat completed 100/100 operations and all ten
planned duplicate deliveries exactly once. It recorded zero terminal errors,
retries, duplicate competitive results, recovered contention, terminal
Firestore aborts, or protected-state changes. Scoring p95/p99 was 521/1,116
milliseconds; Draft deadline-drift p95/p99 was 121/819 milliseconds;
queue-age p95/p99 was 35,888/36,698 milliseconds; corrected drain was 5,519
milliseconds; and observed scoring/Draft concurrency was 3/48 beneath the
fixed 4/60 ceilings. Cloud Monitoring recorded 1,900 reads and 541 writes. The
settled, staging-filtered Cloud Billing export recorded zero net incremental
billed USD for the enclosing window.

The evidence is finalized and ready for independent review, with physical
device evidence explicitly deferred. It therefore proves the backend gate for
that exact revision only and does not authorize a real Draft or public scale.
Because `main` and staging Hosting later advanced through client-only commits,
the source-controlled same-revision gate correctly refuses to use this file as
the prerequisite for stage 500. Preserve it without relabeling and repeat
stage 100 after the current clean `main` is bound to site-pinned staging
Hosting and both worker archives pass byte verification again.

## Exact staging boundary and rollback

After clean review and merge, deploy in consumer-first order:

1. `functions:processDraftClockDeadline`
2. archive-parity `functions:processLeagueAutomationTask`
3. `functions:runScheduledDraftAutomation`
4. `functions:continueServerDraftAutomation`
5. site-pinned staging Hosting through `.d1n-staging.firebase.json`

No Production deployment belongs to this candidate. Roll back producers first
(`continueServerDraftAutomation`, then `runScheduledDraftAutomation`), followed
by the exact preceding `cd6eede0` revisions of `processDraftClockDeadline`,
archive-parity `processLeagueAutomationTask`, and the preceding staging Hosting
release. Preserve the failed exact-`cd6eede0` run root, raw evidence, aggregate
logs, Monitoring window, and Billing window.

## Protected contracts

Production Scoring V4, Projection V11, six-game ownership, Game 7 rollover,
immutable started windows, Draft pick/clock transactions, roster and
transaction authority, standings, playoffs, Rules, indexes, TTL, App Check,
scoring queue/canonical modes, scoring concurrency, Function instance/request
concurrency, and every latency/cost threshold remain unchanged. This candidate
changes only scheduled-start dispatch timing, removes the superseded read-free
T-5 pulse, and raises the isolated Draft queue ceiling to sixty for measured
staging validation.
