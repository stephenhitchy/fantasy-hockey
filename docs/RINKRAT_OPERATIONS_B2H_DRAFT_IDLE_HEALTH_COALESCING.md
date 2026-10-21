# B2H Draft Idle-Health Coalescing

Status: implementation candidate; not deployed

## Purpose

The scheduled Draft worker remains RinkRat's once-per-minute recovery path for
scheduled starts, membership finalization, exact clock-task recovery, paused
Drafts, and automatic picks. When no Draft is scheduled or live, the same
healthy empty summary was previously written to `appData/draftAutomation` and
logged every minute even though no state changed.

B2H coalesces only that exact idle output. It does not skip or delay a Draft
inventory query, league processing, task scheduling, recovery action, or
competitive decision.

## Persistence contract

An idle scan may suppress its aggregate write and completion log only when the
new observation and saved aggregate are both exactly:

- schema version 1;
- `status: success`;
- zero active Drafts;
- zero picks;
- zero failed Drafts; and
- an empty failure list.

The worker first completes the unchanged collection-group scan. It then reads
the aggregate health document only for that exact healthy empty observation.
An active Draft, a pick, any failure, a malformed or missing prior aggregate,
a state transition, an unreadable prior aggregate, or a due heartbeat writes
immediately.

The stored heartbeat becomes due after three minutes. The preserved
once-per-minute scan supplies one additional cadence interval, keeping expected
aggregate freshness at or below four minutes and inside the existing five-minute
Release Readiness threshold. A missed or delayed scheduler invocation is still
visible as stale health; coalescing does not fabricate a successful run.

## Verification

`test/batchb2h-cost-hardening/draft-idle-health.test.mjs` proves:

- fresh identical empty success is suppressed;
- a due heartbeat writes;
- active-to-empty transitions write immediately;
- repeated failures still write immediately; and
- active Drafts still write while the one-minute, single-instance recovery
  scan and process-before-health order remain unchanged.

The inherited Draft automation and release gates remain required before
release.

## Deployment and rollback

The only Firebase resource affected by this slice is:

- `functions:runScheduledDraftAutomation`

Rollback restores the preceding implementation of that Function. No data
migration is required; the aggregate schema remains version 1 and all existing
fields remain compatible.

## Protected contracts

Production Scoring V4, Projection V11, six-game ownership, seventh-game
rollover, immutable started windows, Draft selection and clock authority,
roster and transaction authority, Rules, indexes, TTLs, App Check, scoring
queue mode, worker limits, and canonical scoring authority are unchanged.
