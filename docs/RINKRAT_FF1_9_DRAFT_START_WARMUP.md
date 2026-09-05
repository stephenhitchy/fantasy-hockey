# FF1.25 — Bounded Draft-Start Warmup

Status: source implementation candidate; isolated staging timing evidence is
required before any Production release.

## Approved problem

The first FF1.24 exact-start rehearsal proved that verified readiness completed
more than seventeen minutes before zero and Cloud Tasks dispatched the start
request within a fraction of a second of its requested time. The
`processDraftClockDeadline` instance then cold-started and completed the
authoritative ready-to-live transition about 6.1 seconds after the saved start.
That misses the five-second Draft gate even though no browser preparation ran,
no early pick existed, and both tabs converged.

## Architecture recommendation

Wake the same deterministic server task shortly before zero instead of keeping
an instance permanently warm or increasing queue concurrency. The task may
absorb startup time before the Draft, but it must wait until the exact saved
server timestamp, reread the Draft, and use the existing readiness transaction
before opening. This keeps timing preparation separate from Draft authority.

## Implemented behavior

- The existing scheduled-start task is requested ten seconds before the saved
  start when the server discovers it in time.
- A late enqueue still dispatches after the existing 250-millisecond minimum
  delay rather than attempting to schedule into the past.
- An early handler waits only inside an eleven-second bounded window, rereads
  the Draft after the wait, and reclassifies the exact schedule before calling
  the existing ready-to-live transaction.
- A rescheduled, deleted, already-live, or otherwise stale Draft remains a
  no-op after that reread.
- Existing deterministic task identity, five-attempt retry, 60-second dispatch
  deadline, 120-second Function timeout, queue concurrency of ten, first-pick
  deadline creation, and minute-worker fallback remain unchanged.
- Structured logs now include requested dispatch time and effective warmup lead
  without recording manager, roster, player, or pick identities.

## Acceptance criteria

1. Verified readiness becomes `ready` before zero and remains bound to the
   exact schedule, availability revision, Projection V11 request, snapshot,
   and hash.
2. With an initially cold worker, authoritative `startedAt` and
   `pickStartedAt` occur from zero through five seconds after the saved start.
3. The task never opens a Draft before the saved server timestamp.
4. A schedule changed while the task waits makes the old delivery a no-op.
5. Duplicate delivery, the minute-worker race, commissioner activation, two
   tabs, and reconnect converge on one live transition, one first clock, and
   one first deadline task.
6. Pick count remains zero until a manager selects or the first authoritative
   deadline expires.
7. No lengthy post-zero “Server Preparing Draft Data” state appears when
   verified readiness was already complete.
8. No minimum instance, queue rate, worker concurrency, or dependency change is
   introduced.

## Edge cases

- If the exact task is created with less than ten seconds remaining, it runs
  after the normal 250-millisecond enqueue floor and waits only for the time
  still remaining.
- If it is created after zero, it runs promptly and the existing readiness
  transaction decides whether opening is allowed.
- A delivery more than eleven seconds early fails visibly and uses bounded
  retry instead of holding an unexpectedly long Function invocation.
- Timer wakeup is followed by a Firestore reread. Reschedule, deletion, an
  already-live Draft, or a changed timestamp cannot reuse the earlier read.
- Missing or changed readiness at zero stays scheduled and retryable; the
  minute worker remains the safe recovery path.
- A Function failure while waiting is safe because the task ID and
  ready-to-live transaction are idempotent.

## Tests

Focused tests cover normal warm dispatch, near-start and late enqueue,
malformed timing, wait/reread/reclassify ordering, stale protection,
deterministic task identity, unchanged retry/rate/timeout limits, documentation,
and inherited FF1.24 behavior. The inherited full gate, Functions and Angular
builds, diff check, and clean-source guard remain required from a clean commit.

Required staging evidence repeats the disposable 25-minute rehearsal with the
worker allowed to be cold. It records readiness lead, task dispatch time,
authoritative start latency, first-clock latency, pick count, first deadline,
two-tab convergence, and a reconnect in the final minute. Stop on an early
start, latency above five seconds, duplicate transition/deadline, pre-start
pick, or unverified readiness.

## Observability

The Draft document remains the authority for scheduled time, readiness,
`startedAt`, `pickStartedAt`, current turn, and clock state. Cloud Task and
Function logs distinguish requested warm dispatch, bounded waiting, stale
delivery, opening, retry, and deadline creation. Evidence is aggregate and
must not expose account, league, team, roster, player, or pick identifiers.

The warm wait occupies one of the existing ten concurrent task-dispatch slots
for at most the bounded lead window. That is acceptable only for the current
small pilot gate; clustered-start queue age and p95/p99 latency remain required
D1N load evidence before making a broader scale claim or changing any queue or
worker limit.

## Deployment resources

After independent review, a clean exact commit, successful full gate, and no
unresolved P0/P1 finding, deploy only these existing staging resources in
consumer-first order:

1. `functions:processDraftClockDeadline`
2. `functions:runScheduledDraftAutomation`
3. `functions:continueServerDraftAutomation`
4. the single site-pinned staging Hosting resource through
   `.d1n-staging.firebase.json` only, to publish an exact matching release
   manifest

The first Function must understand and wait on an early delivery before either
of the latter two producers can enqueue the changed task timing. No broad
deployment is permitted. No Rules, indexes, TTL,
App Check, scoring queue, canonical authority, or worker-limit deployment is
required.

## Rollback

First restore the two preceding producer revisions so no new early delivery can
be created, then restore the preceding consumer revision:

1. `functions:continueServerDraftAutomation`
2. `functions:runScheduledDraftAutomation`
3. `functions:processDraftClockDeadline`
4. the preceding Hosting release if its manifest was advanced

The unchanged deterministic identity makes retained deliveries safe under the
preceding handler. Preserve the failed and successful staging Draft, task, and
Function-log evidence; never repair it through direct Firestore edits.

## Protected contracts

This slice does not change Production Scoring V4, Projection V11 formulas or
hashes, six-game ownership, Game 7 rollover, immutable started windows,
add/drop, waiver, IR, transaction, standings, playoff, roster, or pick
authority. The existing server-owned transaction and exact-once behavior remain
authoritative. It changes no Firestore Rule, index, TTL policy, App Check mode,
scoring queue mode, canonical-authority mode, worker/pending-task limit, or
dependency.
