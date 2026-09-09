# FF1.31 — Server-Owned Draft Input Preparation

## Architecture recommendation

Scheduled Draft preparation must not depend on a commissioner opening
Projection Lab, loading the Draft Room, or pressing a refresh button. The
server should prepare daily availability first, then build the exact
availability-bound Projection V11 snapshot for the scheduled Draft.

This change keeps those two authorities separate. A globally deduplicated,
server-only task refreshes the shared injury report beginning at T-25. The
existing Draft worker begins the exact Projection V11 build at T-20. The
five-minute input buffer is the minimum lead already required when a schedule
does not have exact readiness; it does not alter Projection V11 or allow an
unverified board to open a Draft.

## Implemented behavior

- The existing minute Draft worker and Draft-document trigger inspect
  scheduled Drafts without requiring a browser.
- At T-25 or later, unusable daily availability evidence queues one global
  server-owned refresh task per five-minute bucket.
- Multiple leagues and duplicate trigger delivery converge on the same task
  identifier. The shared injury-refresh transaction retains its lease and
  daily-success checks.
- The task has three bounded dispatch attempts and one concurrent dispatch. An
  active lease is retried without competing authority. Its 30-second-or-longer
  task backoff clears a private 25-second error guard, so a transient upstream
  failure receives three real attempts. Failures persist an exponential
  retry-after time across later five-minute task buckets, and a Draft still
  blocked one hour after zero stops requesting upstream work until the
  commissioner reschedules it. Normal user and scheduled refreshes retain the
  existing 15-minute cooldown.
- A same-day error is refreshed instead of being mistaken for healthy merely
  because an earlier success happened that day.
- Draft readiness accepts the refresh only after a separate source
  completeness attestation proves all 32 NHL roster requests succeeded, each
  team response contains both position arrays and a conservative minimum of
  12 valid skaters (at least six forwards and three defensemen), and the ESPN
  response is fresh, successful, structurally valid, and free of
  unrecognized or duplicate team groups. The number of injured teams or
  injury entries is never used as a completeness proxy; an explicit valid
  zero remains distinct from a missing or malformed array. Ambiguous roster
  identities and missing alias targets also block Draft readiness, while an
  exact name not present in the same current NHL roster source remains the
  existing visible D1B name-not-found advisory and is never guessed onto a
  draftable asset. A less strict refresh may still
  update non-competitive injury UI, but it cannot authorize a Draft board.
- A privacy-safe hash of player ID, normalized name, position, and NHL team
  binds that source attestation to the exact roster identity set loaded by
  Projection generation. Strict generation clears its six-hour roster cache
  before loading. A different roster set fails closed, compare-and-set
  invalidates only the matching old attestation, and causes the server to
  refresh availability before retrying; it cannot clear a newer attempt.
- The completeness attestation is bound to the exact refresh-attempt ID.
  A concurrently deployed older writer changing the report invalidates that
  attestation instead of inheriting a stale `true` value through merge writes.
- Freshness is evaluated through the scheduled start, not only at T-25 or
  T-20. Evidence that would cross its 24-hour limit before zero is refreshed
  early enough to preserve the preparation buffer.
- Once availability is complete, the existing T-20 path queues the exact
  schedule- and availability-bound Projection V11 request.
- The Projection worker revalidates the source attestation, success state,
  exact availability revision, bounded 24-hour age, and the daily key that
  belongs to the refresh's own success timestamp when it begins work. Crossing
  UTC midnight does not invalidate a still-fresh report; stale or mismatched
  evidence fails closed for a new server retry.
- The accompanying FF1.30 client commit observes that exact binding through
  the existing Draft listener and automatically displays the player pool.
- Any missing, stale, malformed, timed-out, or incomplete input leaves the
  Draft scheduled, stopped, and at zero picks.

This does not promise a populated board for the full T-60 early lobby. It
promises automatic preparation in the approved T-25/T-20 window. Moving the
work earlier requires measured generation p95/p99 and clustered-start capacity
evidence as a separate change.

## Acceptance criteria

- No commissioner, signed-in browser, Projection Lab visit, or client write is
  required for daily availability or pre-Draft Projection generation.
- Missing, stale, running, and error availability states cause a bounded
  server refresh at T-25 or later. Private task retries remain globally
  serialized and bounded; normal refresh callers retain their existing
  upstream-failure cooldown.
- Current successful attested evidence does not issue another refresh merely
  because UTC midnight passed; the same 24-hour maximum age remains enforced.
- Evidence that is current at T-25 but would expire before the scheduled start
  is refreshed instead of producing a board that becomes invalid at zero.
- Legacy success evidence without the strict source attestation, a partial NHL
  roster set or per-team position group, a stale or malformed ESPN response,
  an unknown/duplicate team group, or an ambiguous current-roster identity is
  never reusable for pre-Draft generation.
- Duplicate leagues, scheduler runs, Draft triggers, and task delivery do not
  create overlapping refresh authority.
- When availability becomes unusable, the prior exact request, snapshot, hash,
  and client preparation pointer are cleared before task enqueue. An enqueue
  failure is visible and retryable; an open lobby cannot keep presenting stale
  readiness while the server has rejected it.
- At T-20, one schedule and availability revision produce one authoritative
  pre-Draft Projection V11 request.
- An already-open lobby loads only the exact verified snapshot/hash when the
  server marks it ready.
- NHL timeout, 429, malformed data, incomplete team schedules, or task failure
  cannot publish a partial board or start the Draft clock.
- At zero with incomplete evidence, status remains scheduled, the clock stays
  stopped, next pick remains one, and pick count remains zero while bounded
  server retries continue. If recovery has not succeeded within one hour, the
  stopped Draft requires a new scheduled start and no longer polls NHL/ESPN.

## Edge cases

- A Draft scheduled exactly 25 minutes ahead enters input preparation; one
  scheduled farther away does not.
- An overdue but still scheduled Draft continues automatic input recovery for
  one hour. It then remains visibly stopped at zero picks and requires the
  commissioner to choose a new start instead of polling upstream forever.
- A task delivered after UTC midnight is ignored; the next minute pass creates
  a task for the new daily key.
- A Projection task queued before UTC midnight revalidates its input when it
  starts. It may use that report only while it is within the existing 24-hour
  maximum age and its stored key matches its own success timestamp.
- A legacy or concurrently updated report whose refresh-attempt ID does not
  match its source-attestation attempt fails closed.
- A roster change between availability refresh and Projection generation
  invalidates only the exact old source attempt; a newer attempt is preserved.
- An active injury-refresh lease causes bounded task retry rather than a
  competing upstream request.
- A prior success followed by an error on the same UTC day is not accepted as
  ready until a new successful refresh restores authoritative status.
- A missing, malformed, stale, or explicitly failed upstream response fails
  closed and preserves the preceding saved report. A fresh `success` response
  with a structurally valid empty injury array is a legitimate zero and may
  clear prior automatic records.
- Rescheduling invalidates the exact Draft binding; a current league-wide
  pointer is never substituted for the new scheduled input.

## Tests

The FF1.31 focused suite covers T-25 boundaries, overdue recovery, UTC daily
keys, five-minute task identity/deduplication, server-only task payload,
validity through the scheduled start, refresh-attempt binding, three real but
bounded upstream retry opportunities, persisted backoff, the one-hour overdue
recovery horizon, one-task concurrency, same-day error
recovery, partial NHL roster and position-
group failure, valid low/zero injury populations, stale/malformed ESPN evidence,
ambiguous identity blocking, exact roster-identity hashing and compare-and-set
invalidation, Projection-worker
revalidation, browser-independent enqueue, FF1.30 automatic pool convergence,
emulator-backed duplicate/stale readiness writes, protected source hashes,
and the targeted deployment/rollback boundary.

The inherited FF1 gate, Angular and Functions builds, whitespace check, and
clean-source guard remain required from the clean commit. Staging must then
prove the no-browser sequence with Projection Lab untouched, two open tabs,
reconnect, a forced input failure and retry, reschedule invalidation, and
physical iPhone/Android checks.

## Deployment resources

Do not begin this rollout while a Draft is live. Confirm that no Draft will
enter T-25 before the entire Function rollout can finish; operationally,
require no Draft scheduled to start within 30 minutes after the estimated rollout
completion. Recheck immediately before activating producer Functions 7-9.
Deploy Functions before Hosting in this exact narrow order so consumers
understand the new evidence before either automation producer can enqueue it:

1. `functions:refreshDraftPlayerAvailabilityTask`
2. `functions:refreshGlobalPlayerAvailabilityScheduled`
3. `functions:refreshDailyPlayerAvailability`
4. `functions:processProjectionGenerationTask`
5. `functions:executeDraftCommand`
6. `functions:processDraftClockDeadline`
7. `functions:processAutoDraftQueueChange`
8. `functions:continueServerDraftAutomation`
9. `functions:runScheduledDraftAutomation`
10. `hosting:app`

The Hosting target is required because this branch includes the separately
reviewable FF1.30 client change. No Rules, indexes, TTL, App Check, scoring
queue, existing worker-limit, or Firebase configuration deployment is needed.

## Observability

Use `appData/playerAvailability` and `appData/injuryAutomation` for bounded
daily key, trigger, status, lease, refresh/source-attempt binding, success,
source-completeness issue, privacy-safe roster identity hash, name-not-found
advisory count, consecutive failure count, retry-after time, and NHL/ESPN
coverage-count evidence. Use
the existing Draft readiness fields for scheduled start, availability
revision, request ID, retry time, snapshot ID/hash, and readiness status. Use
the Projection request/control documents for attempt, queue, 32/32 schedule
completeness, failure, and completion timing.

Staging evidence must record T-25 availability timing, T-20 request timing,
ready-before-zero margin, first-clock latency, duplicate convergence, and
zero-pick preservation. Do not record user, league, team, player, or game
identifiers in a public evidence report.

## Rollback

Stop new production first by restoring the preceding verified revision of
`runScheduledDraftAutomation`, followed by `continueServerDraftAutomation`.
Then restore `processAutoDraftQueueChange`, `processDraftClockDeadline`,
`executeDraftCommand`, `processProjectionGenerationTask`,
`refreshDailyPlayerAvailability`, and
`refreshGlobalPlayerAvailabilityScheduled`, in that order, followed by the
preceding Hosting release. The new task Function may remain
dormant after its enqueuers are restored; allow already accepted idempotent
refresh tasks to drain. Deleting that Function is a separate destructive
operation and is not required to restore prior behavior.

If merged source must be reverted, revert the FF1.31 server commit followed by
the FF1.30 client commit. Preserve Draft readiness, Projection request, and
availability evidence for audit.

## Protected contracts

Production Scoring V4, Projection V11 formulas and hashes, six-game ownership,
Game 7 rollover, exact-once Draft picks and transactions, immutable started
windows, roster and transaction authority, standings, playoffs, Rules,
indexes, TTL, App Check, scoring queue mode, existing worker limits, and
canonical authority are unchanged.
