# FF1.26 — Near-Term Draft Scheduling Gate

Status: source implementation candidate; isolated staging evidence is required
before any Production release or Draft GO decision.

## Approved problem

A commissioner can currently save a Draft only a few minutes in the future.
Draft Setup first requests a generic browser `draft-setup` Projection build,
while server readiness separately requests the exact `pre-draft` snapshot bound
to the scheduled start and availability revision. That duplicate NHL work can
receive upstream 429 responses and take longer than the remaining lead time.
The correct fail-closed behavior then leaves managers on Server Preparing Draft
Data after zero, even though the requested time appeared acceptable at save.

## Architecture recommendation

Keep the 20-minute server readiness window and add a 25-minute admission gate
for a schedule that has not already passed the exact readiness contract. Let
only the server create the authoritative availability-bound Projection V11
request. A near-term exception is safe only for an unchanged saved timestamp
whose current availability revision, request ID, snapshot ID, and content hash
are all reverified by the server.

## Implemented behavior

- Draft Setup displays the safe lead requirement and the saved schedule's
  waiting-injury, preparing-projection, retry, or exact-ready progress before
  the commissioner saves.
- A start at least 25 minutes away is accepted without browser projection work.
  The existing server automation begins one exact preparation inside its
  20-minute window.
- A nearer new or changed time is rejected with the earliest safe timestamp.
- An unchanged nearer time is accepted only after the server reloads the
  current availability evidence and verifies the exact Projection V11 request,
  snapshot, and hash already attached to that schedule.
- Preserved readiness remains bound to that unchanged timestamp. A reschedule
  clears it and requires a new deterministic server preparation.
- The browser no longer creates a generic `draft-setup` projection request.
  Duplicate triggers converge on the existing deterministic `pre-draft`
  request; bounded error retries remain separate audited attempts.
- During an NHL timeout, 429 response, missing evidence, changed evidence, or
  projection failure, the existing authority keeps the Draft `scheduled`, the
  clock `stopped`, `nextOverallPick` at one, and picks at zero.
- A lost-response retry uses its settings submission ID and compares only the
  commissioner-owned order, timestamp, and clock settings. Evolving server
  readiness cannot create a false duplicate conflict.

## Acceptance criteria

1. A new or changed start less than 25 minutes away fails before any Draft,
   invite, audit, roster, or pick mutation unless exact readiness is current.
2. The rejection shows an exact earliest safe start and leaves prior settings
   unchanged.
3. A start at the inclusive 25-minute boundary succeeds.
4. Near-term reuse requires the same schedule plus current availability
   revision, Projection V11 generation request, snapshot ID, and SHA-256 hash.
5. Any missing, malformed, changed, or stale binding rejects reuse.
6. One schedule/availability revision has one authoritative active server
   preparation request; duplicate delivery creates no parallel build.
7. NHL timeout, 429, terminal task error, and bounded retry never start the
   clock or create a pick.
8. Duplicate settings delivery is idempotent even if readiness advanced after
   the first committed response was lost.
9. The progress notice is readable at 320, 390, 430, desktop, 200% zoom, all
   four themes, and keyboard/screen-reader use.

## Edge cases

- The HTML date input records whole minutes, so the displayed earliest safe
  time rounds upward; the server still measures the exact 25-minute boundary.
- A schedule can cross into the near-term window while a lost-response retry
  is in flight. The same submission remains a no-op; a different submission
  must meet current readiness.
- A stored `ready` label without any one of the schedule, availability,
  request, snapshot, or hash bindings is not readiness.
- A current generic Projection pointer is not enough for the exception.
- An availability revision changing between save and zero remains protected by
  the existing activation recheck and keeps the clock closed.
- Older open browser tabs may have queued one legacy generic request during the
  short server-first/Hosting-second rollout window. The final exact Hosting
  build does not create that request, and the server ignores the legacy hint.

## Tests

Focused tests cover both 25-minute boundaries, minute rounding, exact-binding
reuse, changed schedules, missing hashes, server validation before mutation,
stopped/zero state, idempotent duplicate settings, removal of browser queueing,
deterministic server request identity, unchanged worker concurrency, docs, and
the inherited FF1.25 gate.

Before release, run `npm run verify:batchff1-10`, `npm run build:all`, `git diff
--check`, and the clean-source guard from a clean exact commit. Staging must
exercise an unprepared two-minute rejection, a 25-minute acceptance, exact-ready
near-term reuse, reschedule invalidation, duplicate save/trigger delivery, NHL
timeout/429/error retry, two tabs, reconnect, physical phones, and zero picks.

## Deployment resources

After independent review, a clean exact commit, successful full gate, and no
unresolved P0/P1 finding, deploy only these existing resources in order:

1. `functions:executeDraftCommand`
2. the site-pinned staging Hosting target, followed only after staging approval
   by `hosting:app`

The Function must enforce the gate before the new browser stops sending its
legacy preparation hint. `functions:processProjectionGenerationTask`, Draft
automation Functions, Firestore Rules, indexes, TTL, App Check, queue settings,
and worker limits are unchanged and must not be deployed for this slice.

## Observability

The Draft document remains authoritative for the saved timestamp, readiness,
availability revision, request, snapshot, hash, clock, next pick, and pick
count. Existing structured Projection task and Draft automation logs expose
queue state, 429/error retry, readiness, exact start, and stale delivery. The
client progress notice is presentation only and explicitly says the server
revalidates exact evidence.

Staging evidence should retain privacy-safe timestamps, statuses, latency,
request/snapshot equality, retry counts, and zero-pick results. Do not record
account, manager, league, team, roster, player, or queued-player identifiers.

## Rollback

Restore the preceding Hosting release first so clients again match the prior
callable contract, then restore the preceding `functions:executeDraftCommand`
revision. Preserve rejected and accepted schedule audit/log evidence. Do not
edit Draft, projection, request, or pick documents directly.

The previous server remains compatible with the new request shape during this
targeted rollback, but the pair must return to one exact reviewed source
revision before drawing a release conclusion.

## Protected contracts

This slice does not change Production Scoring V4, Projection V11 formulas or
hashes, six-game ownership, Game 7 rollover, immutable started windows,
add/drop, waiver, IR, transaction, standings, playoff, roster, or pick
authority. Existing exact-once Draft transactions remain authoritative. It
changes no Firestore Rule, index, TTL policy, App Check mode, scoring queue
mode, canonical authority, task concurrency, worker limit, dependency, or
Production data.
