# Operations Batch B2E — Read-Loop Hardening

**Reviewed source base:** `6a6707ed61875a1263309fea8ceb7921f38a6a33`

**Protected contracts:** Production Scoring V4, Projection V11, independent
six-game windows, Game 7 rollover, Draft and roster authority

## Purpose

B2E removes two proven sources of unnecessary Firestore reads without changing
the cadence or eligibility of any scoring or Draft recovery worker.

The point-in-time Production audit on 2026-10-09 found:

- 67 terminal `projectionGenerationControls` documents whose expired lease was
  reread every five minutes;
- 37 `leagueAutomationSchedules` documents with no matching league root, 25 of
  which still carried a due timestamp and were reread every minute;
- seven completed live Drafts, all with Cycle 1 present; and
- no active league-automation task.

The first two groups account for roughly 55,000 avoidable reads per day under
that observed state. This estimate is operational evidence, not a billing
guarantee.

## Safety decisions

### Projection recovery

`recoverStaleProjectionGenerationRequests` keeps its existing five-minute
schedule, 15-minute stale grace, 100-document limit, single Function instance,
and Projection V11 authority. The single-field lease query now orders the
oldest expired leases first. Every candidate is reread in a transaction before
mutation.

A control is recovered only when it is still `queued` or `processing`, its
lease is still stale, and the same `activeRequestId` still owns it. A request
document is changed only when that exact request also remains active. Ready,
error, replaced, refreshed, malformed, and unknown evidence is never converted
into a new competitive result.

Ready/error controls no longer retain a queryable lease after their first
eligible bounded recovery sweep. Existing and future terminal controls lose
only that obsolete lease field; all other evidence remains unchanged. The
request and worker producer paths retain their prior terminal-write behavior,
so the targeted release changes only the recovery Function. Request retention
and TTL evidence are unchanged.

No composite index is required. The exact ordered single-field query was
validated read-only against Production before release preparation.

### Orphan automation schedules

The cleanup is an operator-run data hygiene action, not a deployed worker. It
is dry-run only unless every apply guard passes. It never edits a live league,
score, window, Draft, roster, transaction, standing, playoff, queue setting, or
worker limit.

The tool requires all of the following before an apply:

- exact Production project identity;
- queue mode `shadow` and the operator-supplied exact revision;
- a prior private dry-run artifact that is at least 15 minutes old;
- an unchanged candidate schedule, missing league root, missing Draft,
  missing Cycle 1, live-control evidence, replay-control evidence, and task
  evidence across that quiet period;
- no queued, processing, retrying, advancing, or unexpired work anywhere in
  the inspected automation surfaces;
- a second identical preflight immediately before the transaction; and
- the same evidence and document update times inside one Firestore transaction.

The 15-minute quiet period exceeds the nine-minute legacy scoring worker
timeout, preventing a worker that started before league deletion from
recreating an orphan schedule after cleanup. A mode, revision, lease, task,
document, or evidence change aborts before deletion. The transaction deletes
only verified missing-root schedule references with update-time preconditions.
A mode-`0600` rollback artifact containing the exact candidate data is written
before any delete.

Dry run:

```bash
npm run operations:orphan-schedule-cleanup
```

Wait at least 15 minutes, then use the artifact path and queue revision printed
by the dry run. Stephen performs the apply manually:

```bash
npm run operations:orphan-schedule-cleanup -- \
  --apply \
  --expected-queue-revision=<exact-revision> \
  --preflight-artifact=<absolute-private-artifact-path> \
  --ack=DELETE_VERIFIED_ORPHAN_SCHEDULES_IN_nhl-fantasy-app-ab673
```

Do not edit the artifact, shorten the quiet period, switch queue mode, or run
the apply while any scoring or replay work is active. A repeated apply is an
audited no-op when no candidates remain.

## Intentionally unchanged loops

`runSeasonStartAutomation` remains every minute. Its completed-Draft scan is
the independent recovery path for `initializeSeasonAfterDraft`, whose Eventarc
delivery does not retry. Replacing that scan safely requires an atomic pending
work record in every final-pick path, migration coverage, and staged
trigger-loss evidence. B2E does not weaken it merely to save reads.

`dispatchDueLeagueAutomation` also remains every minute with the same due
query, health evidence, queue mode, worker limit, and pending-task limit.
Removing the verified orphan records reduces its input without changing its
behavior for any valid league.

The permanent `deleteLeague` lifecycle fix is separate. Deleting the schedule
with a one-line post-delete call is unsafe because an in-flight scorer can
recreate it. A future change must park the schedule, block or await every live
lease, make all claim paths respect deletion, and prove that late completions
cannot recreate schedule or scoring control state.

## Verification

The focused B2E suite covers:

- stale/fresh, completed, replaced, and malformed projection races;
- exact request ownership and preservation of terminal request evidence;
- deterministic bounded lease draining and all terminal control transitions;
- dry-run-only behavior and private rollback evidence;
- wrong project, non-Shadow mode, revision drift, active work, unexpired
  leases, retained Draft/Cycle evidence, and document-update races;
- quiet-period, missing-artifact, and tampered-artifact rejection;
- one-transaction candidate-only deletion, idempotent repeat, and post-delete
  preservation of valid schedule identities.

Run:

```bash
npm run verify:batchb2e
npm run build:all
git diff --check
npm run release:verify-clean-deploy-source
```

The clean-source guard is expected to pass only after the reviewed changes are
committed.

## Deployment and rollback

Only the projection recovery Function requires deployment:

```bash
firebase deploy \
  --only "functions:recoverStaleProjectionGenerationRequests" \
  --project nhl-fantasy-app-ab673
```

No Hosting, Rules, indexes, TTL, App Check, queue-mode, scoring worker, Draft
worker, or data migration deployment belongs in B2E.

Function rollback is a targeted redeploy of the preceding approved
`recoverStaleProjectionGenerationRequests` revision. The removed terminal
control lease fields are not competitive data; any new active request writes a
fresh lease. Do not restore terminal control leases during rollback.

For schedule cleanup rollback, stop first and confirm queue mode is still
Shadow and no work is active. Preserve the exact private artifact created by
the successful apply and use it only through a separately reviewed,
update-time-guarded restoration procedure; B2E intentionally does not provide
an automatic restore command. Rerun the dry audit afterward. Never restore an
artifact over an existing schedule, and never restore a schedule whose league
root remains intentionally deleted unless investigation proves the cleanup
itself selected it incorrectly.

Production Scoring V4 values, Projection V11 formulas and hashes, player-window
ownership, Game 7 rollover, Draft authority, roster/waiver/IR authority,
standings, playoffs, Rules, indexes, TTLs, App Check, canonical scoring
authority, queue mode, worker limits, and scheduler cadence are unchanged.
