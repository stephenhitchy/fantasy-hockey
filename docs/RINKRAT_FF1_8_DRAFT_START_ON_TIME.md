# FF1.24 — Exact Scheduled Draft Start

Status: source implementation complete; the first isolated staging timing gate
failed because a cold task worker opened about 6.1 seconds late. FF1.25
supersedes only the task-dispatch timing before this gate is repeated.

## Approved problem

The FF1.19 server worker prepares verified Draft data during the 20-minute
pre-start window, but its once-per-minute scan cannot provide an exact zero
trigger. The Draft Room and League Home also retained an older browser fallback
that could start an ESPN availability refresh and Projection V11 rebuild after
the countdown reached zero. That work delayed the server activation request and
made the visible Draft appear stuck on preparation.

## Architecture recommendation

Keep preparation and opening separate. A once-per-minute worker remains useful
for readiness and recovery, while a deterministic Cloud Task should represent
the exact saved start time. The task must invoke the existing server authority,
not let a browser change Draft state. Browser clients may request the already
authorized transition when readiness is `ready`, but they must not rebuild the
authoritative board at zero.

## Implemented behavior

- The existing `processDraftClockDeadline` queue accepts a distinct
  `scheduled-start` payload in addition to unchanged pick-deadline payloads.
- During the existing 20-minute readiness window, the server creates one task
  whose ID is a SHA-256 derivative of league and exact scheduled timestamp.
  Duplicate minute scans converge on that task.
- A saved or changed near-term schedule wakes the existing Draft document
  trigger, so preparation and exact-task scheduling do not wait for a browser.
- At zero, the task first calls the existing exact-readiness open path. That
  path revalidates the schedule, availability revision, request ID, Projection
  V11 snapshot ID, and snapshot hash in the existing server transaction.
- A changed schedule makes the old task stale. A duplicate task or a race with
  commissioner activation can observe the already-live Draft but cannot start
  it twice.
- After the Draft opens, the existing first-pick deadline task is scheduled.
  If verified readiness is not complete, the start task retries within its
  existing bounded five-attempt policy and the minute worker remains the safe
  fallback.
- Draft Room and League Home no longer fetch ESPN data or build a Projection
  V11 snapshot during the countdown/start path. The commissioner can request
  immediate activation only after persisted server readiness is `ready`.

## Acceptance criteria

1. With readiness `ready` before zero, the authoritative `startedAt` and first
   `pickStartedAt` are recorded no more than five seconds after the scheduled
   timestamp in isolated staging.
2. No commissioner browser is required for the Draft to open.
3. The countdown reaching zero never starts a client-side NHL refresh or
   projection build.
4. Missing, stale, changed, or incomplete readiness keeps the Draft scheduled,
   its clock stopped, and its pick count at zero.
5. Duplicate task delivery, duplicate tabs, and a task/callable race produce
   one live transition, one first clock, and one first deadline task.
6. Rescheduling makes the old start task a no-op and only the new exact
   timestamp may open the Draft.
7. A schedule saved inside the 20-minute window wakes server preparation; a
   schedule saved earlier is picked up by the unchanged minute worker at T-20.
8. Opening and first-deadline scheduling remain server-owned and retryable.
9. Existing live-Draft pause/resume, snake order, Auto-Draft, queue ownership,
   and pick-deadline behavior remain unchanged.

## Edge cases

- An early delivery waits at most five seconds and then retries rather than
  opening before the saved timestamp.
- A start task retained after rescheduling compares the exact timestamp and
  exits without touching the new Draft.
- A minute worker already holding the league lease cannot block the exact task
  from using the transactionally safe ready-to-live transition.
- If readiness finishes just after zero, bounded task retry can open it; after
  task exhaustion, the minute worker continues recovery.
- If the exact start queue is temporarily unavailable, readiness still runs
  and the minute worker remains available. The queue failure is emitted as a
  structured Function error for staging investigation.
- A Draft already opened by the commissioner or another delivery is treated as
  converged state, and the first deadline is ensured idempotently.
- A Draft that is not `scheduled`, has no valid timestamp, or no longer exists
  is ignored.

## First staging result

The disposable 25-minute staging rehearsal proved verified readiness more than
seventeen minutes before zero, zero pre-start picks, two-tab convergence after
a final-minute reconnect, and prompt Cloud Tasks dispatch. A cold
`processDraftClockDeadline` instance then caused the authoritative transition
to miss the five-second gate by about 1.1 seconds. Production was not changed.
See `RINKRAT_FF1_9_DRAFT_START_WARMUP.md` for the bounded repair and repeat
evidence requirements.

## Tests

Focused tests cover deterministic task identity, changed-schedule identity,
early/zero/stale classification, enqueue-before-readiness ordering, duplicate
enqueue behavior, direct ready-to-live opening, bounded retry, first-deadline
scheduling, schedule-change wakeup, and removal of both browser preparation
paths. The inherited FF1.23 gate, Functions build, Angular build, diff check,
and clean-source guard remain required from a clean commit.

Required isolated staging evidence includes:

- ready at least 60 seconds before zero, no browser open, and start latency;
- commissioner/non-commissioner tabs open at zero;
- duplicate task delivery and duplicate tabs;
- schedule change after the old task is queued;
- reconnect immediately before and after zero;
- missing/changed readiness at zero, followed by successful retry;
- first pick deadline, pause/resume, and one Auto-Draft turn;
- physical iPhone Safari and Android Chrome.

## Observability

Existing Draft fields show the exact scheduled timestamp, readiness status,
request/snapshot/hash, authoritative `startedAt`, clock status, and
`pickStartedAt`. Structured Function logs distinguish scheduled, duplicate,
stale, early, opened, retrying, and failed exact-start tasks. The existing
`appData/draftAutomation` record remains the aggregate minute-worker fallback
health source. Staging evidence must record scheduled-to-start latency and
must stop on more than five seconds, any pick before start, any duplicate
transition, or any unverified start.

## Deployment resources

After independent review, a clean exact commit, successful full gate, and
isolated staging proof, deploy only these existing resources in producer-first
order:

1. `functions:runScheduledDraftAutomation`
2. `functions:continueServerDraftAutomation`
3. `functions:processDraftClockDeadline`
4. `hosting:app`

No broad Firebase deployment is permitted. No Rules, indexes, TTL, App Check,
scoring queue, canonical authority, worker concurrency, or task rate-limit
change is required.

## Rollback

Restore the preceding verified revisions in reverse consumer order:

1. `functions:processDraftClockDeadline`
2. `functions:continueServerDraftAutomation`
3. `functions:runScheduledDraftAutomation`
4. `hosting:app`

Old scheduled-start tasks become harmless because the preceding task handler
ignores payloads that do not match its pick-deadline schema. Preserve Draft,
projection, task, and Function log evidence; do not edit competitive Firestore
records directly.

## Protected contracts

This slice does not change Production Scoring V4, Projection V11 formulas or
hashes, six-game ownership, Game 7 rollover, immutable started windows,
add/drop, waiver, IR, transaction, standings, playoff, roster, or pick
authority. It retains server authority and exact-once transactional behavior.
It changes no Firestore Rule, index, TTL policy, App Check mode, scoring queue
mode, canonical-authority mode, worker/pending-task limit, or dependency.
