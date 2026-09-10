# RinkRat FF1.33 Historical Replay Lease Guard

**Purpose:** prevent delayed Draft and league-automation delivery from taking
live-scoring authority after a disposable Draft is retained as Historical Replay

**Implementation state:** source candidate complete; staging evidence pending

**Protected contracts:** Production Scoring V4, Projection V11, six-game
ownership, Game 7 rollover, and exact-once transaction authority are unchanged

## Confirmed race

The existing live scorer checked Historical Replay only before scheduled and
queued runs. Forced `draft-complete`, `season-start`, and manual runs could still
claim the scoring lease. A delayed at-least-once Draft-completion event could
therefore arrive after the FF1 six-client fixture had been parked for replay,
replace the paused schedule, and create Cycle 1 after the evidence runner had
reported success.

A separate pre-read is not sufficient because replay authority can change
between that read and the lease transaction. The replay decision and lease
claim must share one Firestore transaction.

## Implemented source behavior

Every non-replay trigger now reads `historicalReplay/control` inside the same
transaction that claims `liveScoring/control`. Any strict `enabled: true`
replay control fails closed, including queued, advancing, ready, error,
incomplete, or malformed status/date combinations. The transaction does not
write a live-scoring lease. It atomically parks the league automation schedule
with `scoringEnabled: false`, `queueStatus: paused`, and
`pausedReason: historical-replay`.

The explicit `historical-replay` trigger remains the only bypass and continues
using the existing serialized replay worker. Its success, failure, and skip
outcomes all leave recurring live scoring disabled, paused for Historical
Replay, and without a next deadline. Queue-task entry now reads the task,
schedule, and replay control in one transaction before it can mark processing.
That transaction preserves terminal task evidence on duplicate delivery and
serializes replay activation ahead of processing-state writes. Queue-task
completion preserves the replay pause instead of converting it to a generic
skipped schedule. Post-completion aggregate telemetry is best-effort, and the
retry writer transaction refuses to resurrect a terminal task, reclaim a
schedule owned by a newer task, or change a schedule already parked for
Historical Replay.

Replay activation, worker claim, and worker state reassertion atomically pair
every raw `enabled: true` replay write with the same recurring-scoring pause.
Late live success/error/skip writers, canonical fan-out, queue claiming,
enqueue failure, task completion/retry, stale recovery, schedule bootstrap,
and manual Canary preparation all read raw replay authority in their own
transactions before writing a schedule. Replay wins each conflict, terminal
task evidence remains immutable, malformed task IDs are never used to build a
Firestore path, and ordinary non-replay retry/recovery behavior remains
unchanged.

The committed-pick reconciliation trigger also emits one bounded structured
marker containing its Eventarc event ID and a deterministic one-way hash of the
league/pick path. Success includes the resulting Draft status and whether it
scheduled the next deadline. Every reconciliation or deadline-scheduling
failure emits the same correlation fields plus only a bounded stage label,
then retries with a generic error. These new markers contain no raw league or
pick identifier or upstream error text. They add no write; they let the guarded
staging rehearsal correlate every synthetic pick with its exact trigger
delivery rather than accepting unrelated request-count traffic. Existing
diagnostic paths outside these markers are not changed by this slice.

## Acceptance criteria and edge cases

1. Delayed or duplicate `draft-complete` delivery cannot claim a scoring lease,
   create Cycle 1, publish a score, change a window, or unpause recurring
   scoring while replay is enabled.
2. Scheduled, queued, season-start, and manual paths fail closed under the same
   authority check, even when called with `force: true`.
3. Enabled replay with no simulated date or with `status: error` is still
   protected.
4. Missing, disabled, or non-boolean replay authority preserves existing live
   automation behavior.
5. The explicit Historical Replay worker can still claim the lease and retry
   safely.
6. A replay-blocked queue delivery clears only its owned task state and leaves
   the schedule paused.
7. Replay success, failure, and skip outcomes cannot re-enable recurring live
   scoring or recreate its deadline.
8. Redelivery cannot overwrite completed, skipped, stale-recovered, or
   enqueue-error task evidence, and replay activation cannot race behind a
   non-transactional processing write.
9. Repeated blocking is idempotent and produces no competitive mutation.
10. Each successful or failed committed-pick reconciliation has a privacy-safe
    path-bound structured marker suitable for exact staging correlation.
11. A telemetry failure or uncertain completion response cannot turn a paused
    schedule back into processing; ordinary failures retain bounded retry.
12. Replay activation and every later raw replay-control reassertion commit the
    replay authority and schedule pause together.
13. A late outcome, enqueue failure, retry, stale recovery, canonical request,
    bootstrap, or Canary request cannot recreate a live deadline after replay
    activation.
14. Terminal or newer task evidence survives duplicate and out-of-order
    delivery; malformed stale task IDs are parked without being dereferenced.

A live-scoring transaction that commits immediately before replay is enabled
may finish its already-owned lease. Historical Replay already handles that
bounded overlap by retrying the same saved date. This slice closes the opposite
case: once replay authority is present, no later live trigger may claim. The
FF1.33 retained-fixture handoff waits for the existing lease ceiling plus grace
before enabling its replay guard.

## Verification

The focused batch runs against the Firestore Emulator and covers the full
trigger/replay-state matrix, the live write path, a concurrent replay/lease
transaction conflict, replay success/failure/skip outcomes, terminal duplicate
delivery, transactional queue-task start, queue-pause preservation through
duplicate retry and an injected downstream failure, the success/failure
committed-pick markers, and protected source hashes:

```bash
npm run test:batchff1-17
npm run verify:batchff1-17
npm run build:all
git diff --check
npm run release:verify-clean-deploy-source
```

The clean-source guard is expected to reject an uncommitted worktree and must
pass only after the reviewed candidate is committed and clean.

## Staging evidence and observability

Before running FF1.33, deploy the exact source-controlled Function set required
by that runner and site-pinned staging Hosting from one clean commit. The runner
must additionally prove its declared deployed revision contains this guard and
that every deployed Function archive exactly matches it.

Observe only bounded evidence:

- skipped server-scoring outcome and `historical-replay` reason;
- paused league-automation schedule with no next-scoring deadline;
- unchanged replay control, Cycle 1, windows, matchups, and stored scores;
- exact structured pick-handoff markers correlated by event and the expected
  one-way league/pick path hash;
- duplicate delivery with unchanged authoritative state.

Do not use Production or a family league for this proof. Do not deploy Rules,
indexes, TTL policies, App Check, queue configuration, worker limits, scoring
configuration, or canonical authority.

The 2026-09-10 post-deployment audit confirmed that staging Hosting and all 19
generation-pinned Function archives contain exact runtime source
`48ebbefe3d94af6b7db2be9e758ed1e396a22ac4`. Updating five existing uncapped
second-generation Functions materialized a 20-instance ceiling in the Cloud
Functions control plane. The corresponding four Production Functions already
use that ceiling, and each affected task worker remains bounded more tightly by
its unchanged Cloud Tasks dispatch limit. FF1.33 records the observed 20 as the
protected staging topology for `advanceHistoricalReplayDay`,
`processAutoDraftQueueChange`, `processHistoricalReplayAdvance`,
`processLeagueAutomationTask`, and `refreshDraftPlayerAvailabilityTask`.
This evidence correction does not deploy or change a runtime, queue, or worker
configuration. A missing or different ceiling still fails before fixture
creation.

## Targeted deployment boundary and rollback

The exact behavior-affected Functions are:

```text
functions:initializeSeasonAfterDraft
functions:runSeasonStartAutomation
functions:runScheduledLeagueAutomation
functions:processLeagueAutomationTask
functions:requestLeagueLiveScoringRefresh
functions:advanceHistoricalReplayDay
functions:processHistoricalReplayAdvance
functions:dispatchDueLeagueAutomation
functions:bootstrapLeagueAutomationSchedules
functions:recoverStaleLeagueAutomationQueue
functions:queueLeagueAutomationCanaryCheck
functions:pollCanonicalNhlImpactFeed
functions:reconcileDraftTurnAfterCommittedPick
```

`processHistoricalReplayAdvance` retains its explicit allowed path, but its
replay state reassertions now use the same atomic control/schedule boundary.
`pollCanonicalNhlImpactFeed` is included because it is the only deployed caller
of the changed canonical schedule-request helper. The Canary, bootstrap,
dispatcher, and stale-recovery Functions are included because their schedule
writes now serialize behind replay authority. The Draft-pick trigger is
included only for its privacy-safe correlation marker.

FF1.33 staging provenance requires the exact 16 Functions exercised by the
six-client rehearsal plus three pre-existing replay/automation guard
prerequisites: `processLeagueAutomationTask`,
`processHistoricalReplayAdvance`, and `advanceHistoricalReplayDay`. Both task
queues must be proven empty and must retain their protected dispatch/retry
topology before the two workers are updated first. Every one of those 19
Functions then verifies the same common source archive. The other eight
behavior-affected entry points listed above must remain absent from this
isolated staging project. This is an evidence requirement, not authorization
for a broad Functions deployment. Production deployment remains a separate
decision after staging evidence and independent review.

This is a mixed-revision rollout, so first prove that no replay request is
queued/processing, both relevant task queues are empty, and no live-scoring
lease is active. Do not advance Historical Replay during deployment. Stage the
five required behavior-affected Functions in this exact order, with each
worker ahead of its producer:

```text
functions:processLeagueAutomationTask
functions:processHistoricalReplayAdvance
functions:initializeSeasonAfterDraft
functions:reconcileDraftTurnAfterCommittedPick
functions:advanceHistoricalReplayDay
```

Keep these eight behavior-affected entry points absent during the rehearsal:

```text
functions:runSeasonStartAutomation
functions:runScheduledLeagueAutomation
functions:requestLeagueLiveScoringRefresh
functions:dispatchDueLeagueAutomation
functions:bootstrapLeagueAutomationSchedules
functions:recoverStaleLeagueAutomationQueue
functions:queueLeagueAutomationCanaryCheck
functions:pollCanonicalNhlImpactFeed
```

Stop on any failed revision, do not advance replay, and forward-repair any
guard-bearing Function that has already been updated. Independently verify
every deployed revision before creating rehearsal data.

A full revision rollback is permitted only after a source-controlled,
read-only audit proves all three conditions across every league in the target
project:

- no replay request is queued or processing;
- no live-scoring lease is active; and
- no raw `historicalReplay/control.enabled === true` value exists, regardless
  of the control status or whether its request identifier is valid.

Only after all three conditions pass may preceding verified revisions be
restored in reverse consumer order. If any raw enabled replay control remains,
do **not** restore an unguarded consumer revision: retain the FF1.33
guard-bearing consumers, block new replay requests, preserve the enabled
control and all evidence, and ship a reviewed forward repair. The existing
retained D1L staging fixture already has raw replay authority enabled, so a
pre-guard rollback of `processLeagueAutomationTask`,
`processHistoricalReplayAdvance`, `initializeSeasonAfterDraft`, or
`advanceHistoricalReplayDay` is unavailable as soon as its guarded revision is
staged. The FF1.33 v2 fixture preserves the same restriction. A full rollback
remains unavailable until a separately reviewed, supported disable path exists;
zero active requests and leases alone are not sufficient. Hosting and
non-guard rehearsal authorities may still be restored independently when their
own rollback gates pass.

No stored schema migration is required. Preserve replay controls, automation
schedules, Draft picks, logs, Cycle data, and evidence for audit; do not delete
or manually rewrite them.
