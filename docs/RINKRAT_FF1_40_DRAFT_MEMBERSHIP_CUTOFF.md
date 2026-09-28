# FF1.40 — Draft Membership Cutoff and Schedule Generations

Status: implementation candidate; not deployed

## Product contract

- A new or changed Draft schedule must be at least 40 minutes in the future.
- Saving Draft settings does not close league entry or freeze league capacity.
- At T-40, the server atomically freezes the current valid member/team set,
  closes the invite, and finalizes the round-one order.
- `maxTeams` is capacity, not a required participant count. A full league may
  increase capacity until T-40 without canceling its schedule.
- Randomized order is generated on the server once at T-40.
- A custom order preserves surviving relative positions and inserts managers
  who joined later at deterministic random positions.
- Rescheduling alone does not reroll a previously finalized order. A changed
  participant set creates a new order epoch at the next cutoff.
- There is no immediate-start mode or near-term readiness exception.
- A commissioner may cancel before T-40. After T-40, Postpone and Reopen
  requires recent authentication and is allowed only before picks or other
  competitive history exist.

## Authority and lifecycle

`functions/src/draft-authority.ts` owns schedule intent, optimistic settings
revision checks, cancellation, and explicit reopening. Ordinary commissioner
authority comes only from `leagues/{leagueId}.commissionerId`; platform-admin
claims provide no Draft bypass.

`functions/src/draft-automation.ts` schedules a deterministic T-40 task on the
existing `processDraftClockDeadline` queue. The task and the minute recovery
scan converge through one Firestore transaction that reads the Draft, league,
invite, members, and teams before writing the lock and immutable audit.

Every schedule change increments `scheduleGeneration`. Finalization, readiness,
queue warmups, and exact-start work carry the generation in addition to the
timestamp. Old tasks therefore no-op even if a later schedule reuses the same
clock time.

Both the scheduled background start and the existing commissioner-browser
fallback recheck the current team set, participant hash, finalized generation,
concrete order, readiness generation, and Projection V11 evidence. The browser
fallback still cannot activate before the scheduled time; it is not an
immediate-start mode. Missing or conflicting evidence leaves the clock stopped.

Draft Setup treats the client clock reaching T-40 as locally locked and performs
a bounded 15-second server refresh until it observes the authoritative cutoff
result. It does not add a Firestore listener.

## Compatibility

Legacy Drafts without `membershipLockStatus` retain the previous locked
interpretation. They are never silently reopened or assumed randomized. Their
orders normalize as `legacy-custom` and can be preserved through the explicit
Postpone and Reopen flow.

The T-25 availability and T-20 Projection V11 readiness windows remain
unchanged. Production Scoring V4, Projection V11 formulas and hashes, roster
requirements, six-game windows, seventh-game rollover, waivers, and queued
roster moves are unchanged.

## Verification

Focused coverage is installed as `npm run test:batchff1-40`. It proves:

- custom late-join insertion and preserved relative order;
- deterministic randomized finalization and exact participant coverage;
- legacy lock compatibility;
- generation-bound task identity and stale-task rejection;
- transactional T-40 locking and idempotent retry;
- generation-bound readiness writes;
- ordinary-commissioner scheduling/cancellation and stale-tab rejection;
- universal under-40 rejection and preservation of prior settings;
- guarded post-cutoff reopen plus no-reroll rescheduling;
- exact participant and schedule-generation start eligibility.

Inherited join, capacity, member-removal, exact-start, warmup, preparation, and
full release gates must also pass before release.

## Deployment and rollback

Expected targeted runtime resources are:

- `executeDraftCommand`
- `processDraftClockDeadline`
- `runScheduledDraftAutomation`
- `continueServerDraftAutomation`
- `processAutoDraftQueueChange`
- `joinLeagueSecure`
- `updateLeagueCapacitySecure`
- `removeLeagueMemberSecure`
- `hosting:app`

Deploy the task worker first, then every producer/observer listed above, then
Hosting. `processAutoDraftQueueChange` is included because enabling a queue can
invoke the shared scheduled-Draft processor before the Draft is live. No Rules,
index, TTL, queue configuration, scoring, or Projection Function deployment
belongs to this change.

Rollback is data-aware. Roll back Hosting and the writer callables first so no
new explicit-open schedules are created. Do not restore the old automation
revisions while any scheduled Draft still has `membershipLockStatus: open`;
first cancel those schedules through the current guarded action or let the new
worker finalize them. Then restore the prior automation revisions. Additive
fields are readable by older code, but an old automation revision does not
understand the new T-40 open state. Existing timestamp-only legacy tasks retain
their exact-time check; new generation-bound tasks fail closed when their
schedule no longer matches.
