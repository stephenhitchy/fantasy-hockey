# FF1.19 — Server Draft Readiness Before Zero

Status: merged and deployed to the isolated staging project on exact source
`aa59ac7b02e98b40467268d4a56972780d646873`; staging evidence is in progress.

## Problem

The Draft Room already attempts to refresh the shared injury report and
Projection V11 from a commissioner's browser before a scheduled Draft. The
minute-by-minute server automation, however, previously waited until the
scheduled start before checking whether a verified projection existed. If the
browser preparation did not run or was still processing, the visible countdown
reached zero while the Draft remained scheduled.

## Implemented behavior

- The existing `runScheduledDraftAutomation` worker begins durable readiness
  work during the inclusive 20-minute pre-Draft window. This does not require
  any browser to remain open.
- The input is bound to the exact scheduled-start timestamp and a SHA-256
  revision of the saved global-plus-commissioner player-availability records.
  The hash is evidence only; no account, league member, roster, or player
  identifier is added to shared operational telemetry.
- Missing, unreadable, running, failed, future-dated, previous-UTC-day, or
  more-than-24-hour-old availability evidence produces `waiting-injury`. A
  failed commissioner-override read never silently becomes an empty override
  set or all-healthy input.
- The existing Projection V11 task queue receives a deterministic `pre-draft`
  request. A changed schedule or availability revision creates a different
  request; duplicate scheduled delivery reuses the same request.
- Projection generation fails closed if availability changes between queueing
  and execution. The Draft worker records an error, applies bounded retry
  backoff, and creates a new deterministic attempt without starting the clock.
- A ready state records the exact request ID, snapshot ID, content hash,
  availability revision, and scheduled start. Both the scheduled worker and
  commissioner activation command revalidate that evidence before changing
  the Draft to `live`.
- The Draft Room displays server-owned waiting, preparing, ready, and retry
  states. Existing browser preparation remains a convenience, not authority.

## Acceptance criteria

1. At 20:00 before the saved start, the server begins preparation; at 20:00:01
   it does not.
2. A current successful injury input and completed Projection V11 request reach
   `ready` before zero without an open commissioner browser.
3. Missing, stale, delayed, or changed availability evidence keeps the Draft
   scheduled and the clock stopped.
4. The exact queued request must produce the exact verified snapshot ID/hash
   and carry the same availability revision.
5. Rescheduling invalidates all earlier readiness fields.
6. Duplicate minute scans and duplicate task delivery do not create duplicate
   Draft starts, picks, queues, or projection work.
7. A transient projection failure remains visible and automatically retryable
   with bounded backoff.
8. The server transition to `live`, first `pickStartedAt`, and pinned projection
   remain one transaction and are rechecked against the latest Draft document.
9. Reconnect and stale tabs display the persisted server state; no new client
   listener is added.

## Edge cases

- A reschedule during preparation causes the old result to be ignored.
- An injury refresh completing during projection generation causes that task to
  fail rather than publish readiness for mixed inputs.
- An unrelated active projection request temporarily blocks the Draft request;
  the next minute scan retries without treating the unrelated request as ready.
- Existing historical-replay projection request IDs retain their exact legacy
  identity; the availability suffix applies only to new Draft-readiness work.
- A failed or stale projection task is retried with a new attempt identity, so
  Cloud Tasks' completed-task-name retention cannot suppress the retry.
- A live Draft with a stopped clock continues to use its already pinned and
  verified projection. Pre-Draft readiness cannot replace a live Draft board.
- A legacy scheduled Draft without the new fields remains readable and safely
  scheduled until the worker creates current readiness evidence.

## Verification plan

Source and emulator/fixture coverage must prove:

- 20-minute boundary, zero boundary, invalid schedule, and non-scheduled state;
- current-UTC-day/24-hour availability boundaries, missing evidence, future
  evidence, and changed revisions;
- deterministic request identity, duplicate worker delivery, active unrelated
  request, task failure, bounded retry, reschedule, and exact snapshot/hash;
- manual activation and scheduled activation both fail closed without matching
  readiness;
- first clock start occurs once and no pick is created by preparation;
- reconnect and duplicate tabs converge on the same persisted readiness;
- the existing six-manager Draft, Auto-Draft, pause/resume, clock-deadline, and
  completion rehearsal still passes.

The inherited gate is `npm run verify:batchff1-3`, followed by `npm run
build:all`, `git diff --check`, and the clean-source guard from a clean commit.

## Staging evidence to date

- The live staging manifest exactly matched
  `aa59ac7b02e98b40467268d4a56972780d646873`. All three targeted Functions were
  independently confirmed ACTIVE after the clean, targeted deployment; exact
  source attribution relies on that deployment's clean-source guard and log.
- A no-browser minute-worker execution found the scheduled synthetic Draft and
  persisted `waiting-injury` while leaving the Draft scheduled and its clock
  stopped. This proves the missing-freshness path fails closed.
- The shared D1N fixture now emits the exact current-UTC-day success evidence
  (`lastSuccessfulSyncAt` and `lastDailySyncKey`) required to exercise the
  positive readiness path. On exact staging source `e0a69017`, FF1.20 reached
  ready before zero on attempt one without a browser, retained one
  request/snapshot identity under duplicate delivery, kept the clock stopped,
  created no pick, and reset safely. Changed-input, retry, reschedule,
  reconnect, rollback, and six-manager evidence remain open under FF1.21 and
  the later lifecycle rehearsal.

## Staging release boundary

The staging implementation release used only:

- `functions:processProjectionGenerationTask`
- `functions:runScheduledDraftAutomation`
- `functions:executeDraftCommand`
- `hosting:app`

Deploy the three Functions first, then Hosting, and verify the staging Hosting
manifest exactly matches the clean commit. Do not deploy broadly. No Rules,
indexes, TTL, App Check, queue configuration, worker concurrency, pending-task
limit, scoring queue, or canonical-authority resource changes are required.

## Observability

Each Draft document records bounded league-local readiness status, message,
scheduled start, attempt count, retry time, availability revision, request ID,
snapshot ID, and snapshot hash. Existing projection request/control records
show queued, processing, ready, and error states. Existing aggregate Draft and
projection automation documents continue to record duration and failures; no
new high-frequency global document is introduced.

## Rollback

Restore the preceding verified revisions in this order:

1. `functions:executeDraftCommand`
2. `functions:runScheduledDraftAutomation`
3. `functions:processProjectionGenerationTask`
4. the preceding verified `hosting:app` release

The new Draft fields are additive and optional, so older code ignores them.
Queued readiness requests may finish after rollback, but older Draft authority
does not consume the new readiness fields. Preserve Draft and projection
request/control documents for audit; do not delete or edit them manually.

## Protected contracts and non-goals

This slice does not change Production Scoring V4, Projection V11 formulas or
version, six-game ownership, Game 7 rollover, immutable started windows,
add/drop, waiver, IR, transaction, standings, playoff, or scoring authority.
It does not change Firestore Rules, indexes, TTL, App Check, scoring queue mode,
canonical authority, worker limits, or projection task concurrency. It does not
authorize real Drafts; the disposable six-manager rehearsal, physical-device
evidence, D1N 100/500 gates, rollback rehearsal, and formal FF1.16 GO remain
separate requirements.
