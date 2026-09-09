# FF1.32 — Server-Owned Draft Preparation Staging Evidence

## Architecture recommendation

Automatic Draft preparation should be released only after staging proves the
two server-owned phases independently: strict player-availability preparation
at T-25 and the exact availability-bound Projection V11 request at T-20. The
evidence must not depend on a commissioner, an open browser, Projection Lab, or
a client write.

The safest deterministic retry exercise is an active server-lease scenario.
It proves the first deterministic task identity, duplicate enqueue
convergence, a bounded Cloud Tasks retry, and single refresh authority without
manufacturing NHL/ESPN traffic, adding a Production test hook, or weakening
the strict source contract. After a successful task is removed, the available
platform evidence can correlate its retry through the singleton queue,
deployed revision/hash, exact request-log sequence, and exact completion marker;
it cannot directly inspect the deleted task after success. Real upstream
timeout, 429, and malformed response handling remains hermetically covered by
the FF1.31 local/emulator suite.

Because `appData/playerAvailability` and its task queue are staging-wide shared
resources, this runner is a controlled maintenance operation, not an ordinary
fixture test. Its separate maintenance acknowledgement means the operator has
reserved an exclusive shared-availability window with no unrelated app or
Draft traffic for the duration of the run.

Natural Scheduler evidence and manual duplicate probes are distinct. Natural
T-25/T-20 observations must correlate to the minute job inside a window shorter
than 60 seconds. Any later manual probes run serially, and each probe must be
accepted only after its full `appData/draftAutomation` success marker advances.
The exact HTTP 200 request logs may arrive later; the runner then maps exactly
two logs to the two disjoint trigger-to-completion windows. Concurrent manual
invocations would make attribution ambiguous.

## Implemented tooling behavior

FF1.32.1 tightens only the staging runner and its tests/documentation. It
corrects the retry proof for Cloud Tasks control-plane lag, the successful task
HTTP status, Cloud Logging's two supported completion-marker encodings,
pre-extraction ZIP validation, duplicate-scan result validation, and Draft-start
safety deadlines. It does not change any deployed Function or Firebase
configuration.

- A guarded runner is hard-coded to the billed
  `rinkrat-staging-d1nc-2026` project and refuses Production and every Emulator
  Suite environment.
- It requires both the exact-run acknowledgement and the separate maintenance
  acknowledgement reserving exclusive use, a clean Git worktree synchronized
  with `origin/main`, an exact deployed runtime revision, and a staging
  manifest reporting that revision with Production Scoring V4 and Projection
  V11.
- It resolves `origin/main` from the remote immediately before evaluating Git
  state, then requires local `main`, its configured upstream, and that fresh
  remote commit to be identical. The declared deployed revision must be an
  ancestor of the freshly resolved remote commit.
- It independently describes all nine exact staging Functions. Each must be
  ACTIVE on Node 22, use the expected entry point and full resource identity,
  resolve to one generation-pinned source object, expose an immutable Cloud
  Run image digest, and route 100 percent of traffic through the matching ready
  Cloud Run service and revision.
- For every Function it downloads the exact generation-pinned source ZIP,
  parses and bounds its central directory before extraction, and rejects
  multi-disk, ZIP64, encrypted, unsupported-compression, duplicate, traversal,
  symlink, special-file, malformed UTF-8, or mismatched local-header entries,
  plus entries whose data falls outside the archive. Before `/usr/bin/unzip`
  runs, every stored entry must have equal compressed/expanded sizes and every
  deflated entry is expanded in memory with an output cap one byte above its
  clean-Git expected length; the resulting exact length and SHA-256 hash must
  match clean Git. This prevents forged ZIP size metadata or a compressed bomb
  from crossing the reviewed extraction envelope. It then compares the exact
  relative paths, byte lengths, and SHA-256 content hashes against a clean
  Functions build made from a Git archive of the declared deployed commit
  after an exact `functions/package-lock.json` install.
- It verifies the exact enabled minute Scheduler job, UTC cadence, POST target,
  Function URI, OIDC audience and service account, deadline, retry policy, and
  healthy prior attempt. It separately verifies the exact resource identities,
  RUNNING state, dispatch rate, concurrency, and retry configuration for both
  `refreshDraftPlayerAvailabilityTask` and `processDraftClockDeadline`.
  The Draft-deadline queue must retain 500 dispatches per second, burst 100,
  concurrency 10, five attempts, two-second minimum backoff, 3,600-second
  maximum backoff, and 16 doublings; the availability queue retains its
  reviewed limit of one concurrent dispatch and bounded three-attempt policy.
  The Projection queue must separately remain RUNNING with two concurrent
  dispatches and its single-attempt policy.
- A tooling-only commit may be newer than the deployed runtime only when every
  intervening path is on the runner's fixed documentation/test/tooling
  allowlist. Runtime or deployment-input drift fails closed.
- Before any write, it verifies the exact ten-team D1N fixture, zero Draft
  picks, no commissioner availability override, an empty automatic
  availability, Projection, and Draft-deadline task queues, and a bounded
  staging-wide Draft inventory in which no non-fixture Draft is `scheduled` or
  `live`. The inventory and the zero-pick condition are rechecked while the
  maintenance lease is held. This full exclusion is required because a manual
  Scheduler scan can claim and release automation leases on every scheduled
  Draft, even when its start is outside the evidence horizon.
- The existing synthetic Draft must be `scheduled` and `stopped`, with null
  `startedAt`, `completedAt`, and `pickStartedAt`, next pick one, no drafted
  assets or pick documents, and an existing start at least two minutes away.
  Those Draft-document conditions and the two-minute margin are checked once
  before lock acquisition and again inside the atomic transaction that claims
  fixture ownership and applies the first evidence schedule.
- It refuses any pre-existing evidence lock, acquires one expiring evidence
  lock, renews it at maintenance checkpoints, and rechecks the write boundary
  before each shared-state phase.
- It requires an already successful strict schema-2 availability baseline.
  The baseline must bind the source-attempt ID to the refresh-attempt ID, carry
  a valid NHL roster identity hash, prove all 32 NHL teams, contain no blocking
  ESPN/identity defects, and remain fresh through the planned start.
- The retry phase changes availability control metadata only. It never changes
  the `records` array. A temporary active lease makes the first T-25 task
  delivery return `lease-active` and leaves one deterministic queue task.
- The first failed delivery is bound to that task's exact name and `createTime`
  plus its first observed `dispatchCount`, which may be zero or one while the
  queue description catches up. The authoritative delivery proof is one HTTP
  500 request log with the exact verified service, revision, source hash, task
  user agent, method, and strict latency, together with the Firestore
  `lease-active` timestamp falling inside that request. The runner intentionally
  does not require `firstAttempt`, `lastAttempt`, `responseCount`, or
  `scheduleTime` from the eventually consistent task description.
- After the task handler persists the `lease-active` marker, two duplicate
  Scheduler probes run serially inside a strict deadline that ends 15 seconds
  before the minimum retry interval. Each must complete a schema-1 `success`
  scan of the one isolated active Draft with zero failed Drafts, zero picks, an
  empty failure list, a bounded duration, and a monotonic in-window completion
  timestamp. Their exact two HTTP 200 logs are subsequently mapped to their
  disjoint trigger-to-completion windows. The queue must still contain the one
  original deterministic task; this is the live duplicate-enqueue convergence
  proof.
- Before any inventory or log wait, one transaction moves the Draft to a
  runner-owned seven-day safety schedule, clears schedule-bound readiness, and
  compare-and-set restores the exact strict availability baseline. Both the
  initial and parked schedule identities are registered conservatively before
  that transaction so an ambiguous commit remains cleanable. The deterministic
  singleton must then produce an exact `[500, 204]` Cloud Run request sequence
  for the same verified provenance. Retry delay is measured from the HTTP 500
  response end to the HTTP 204 request start and must be between 25 seconds and
  five minutes. Its completion marker must be exactly `already-current`,
  accepted only from the expected structured status field or the equivalent
  exact console-text encoding. The task must drain and leave the baseline
  attempt and success time unchanged. This is reported as
  `singleton-revision-correlated`; the runner does not claim that a deleted
  successful task remains directly inspectable. No second upstream fetch is
  authorized by this exercise.
- The runner observes the natural minute scheduler rather than manually
  triggering the first T-25 or T-20 boundary. It rejects an early refresh or
  early Projection request and correlates each natural Scheduler attempt and
  exact-revision request log in less than 60 seconds. Later explicit Scheduler
  runs are duplicate-delivery probes only. Each accepted probe must produce a
  full successful zero-pick automation marker; probes run serially in a window
  that ends before the next natural minute, and their later exact-revision HTTP
  200 logs must map one-to-one into the disjoint accepted probe windows.
- At T-20 it requires one schedule- and availability-bound `pre-draft`
  request, a server-authoritative Projection V11 snapshot, complete team
  schedule input, verified snapshot integrity, and exact request/snapshot/hash
  convergence on the Draft. The request document ID must equal its declared
  request ID, its deterministic attempt-one identity must match the exact
  league/schedule/availability revision, and its created, started, and
  completed timestamps must be present, monotonic, and inside the bounded run
  and observation interval. Creation must fall inside the natural T-20
  correlation window, and reported duration must be no more than 30 minutes
  and consistent with the server timestamps. An evidence scan capped at 100
  documents must find exactly one matching `pre-draft` request; that is an
  evidence bound, not a new runtime retention contract.
- The exact attempt-one Projection identity follows the deployed protocol:
  its base is `draft-readiness-` plus the first 40 hexadecimal characters of
  `sha256([leagueId, String(startMs), availabilityRevision].join(':'))`, and
  `requestKey` is that base plus `-a1`. Its document ID is
  `projection-draft-` plus the first 32 hexadecimal characters of
  `sha256([leagueId, requestKey, '1'].join(':') + ':' +
  availabilityRevision)`. The runner recomputes both rather than trusting
  stored identifiers.
- Duplicate scheduler delivery after readiness must preserve request,
  snapshot, hash, attempt count, stopped clock, and zero-pick state.
- Every T-20-through-readiness polling budget and manual command is clamped to
  an absolute deadline fifteen minutes before zero. The runner completes its
  lock/inventory check while invalid availability still keeps the Draft closed,
  rechecks the deadline, and gives the post-restore read the same hard deadline.
  Later pre-T-20 Draft reads use that deadline without another maintenance
  transaction after valid availability is restored.
  Success parks the Draft again
  before any later maintenance read; the failure path attempts the same park
  before ownership reconciliation. A normally running process therefore never
  leaves the fixture close enough to open while evidence or cleanup waits.
- A bounded near-zero phase makes the same fixture's input temporarily
  unusable, proves the Draft remains scheduled and stopped with next pick one
  and zero picks at zero, then reschedules it and requires exact readiness for
  the new start. Old schedule-bound evidence may not authorize the new start.
- Cleanup never rewinds Projection state. Valid generated Projection requests,
  snapshots, pointers, control, and counters are retained as server-owned audit
  evidence. Cleanup instead runs independent stages: reset the Draft seven
  days ahead; reconcile, drain, and verify the Draft-deadline queue, including
  one serialized correlated Scheduler probe; await the owned Projection
  request's terminal state; drain the Projection queue; restore only the two
  runner-owned availability metadata fields through compare-and-set; drain the
  availability queue; reverify the bounded Draft inventory; and only then
  release the evidence lock. Draft-deadline cleanup begins only after the safe
  reset, removes only allowlisted deterministic tasks for the initial, parked,
  near-zero, and recovered schedules (at most four exact IDs), and never
  performs a broad queue purge.
- The deadline-task allowlist is recomputed for each runner-owned schedule as
  the first 40 hexadecimal characters of the SHA-256 hash of
  `scheduled-draft-start:<leagueId>:<scheduledStartMilliseconds>`. Every queue
  resource must equal the exact staging project, region, queue, and derived
  task path before deletion.
- Availability ownership and restoration use a canonical document hash that
  preserves Firestore Timestamp seconds and nanoseconds. A millisecond-equal
  but nanosecond-different value is a conflict, not a successful restoration.
- The evidence lock is deleted only after every cleanup stage succeeds. Any
  uncertain or failed stage leaves a `cleanup-required` lock so another run
  cannot silently overwrite shared state. If the Draft cannot first be moved
  safely away from its start, availability remains unavailable and therefore
  fails closed.
- A transaction or task-deletion error may have committed remotely even when
  the client receives an error. Before a mutation, the runner records cleanup
  intent and its known lease state. After an ambiguous result, it reconciles
  the exact lock owner, Draft schedule/state, availability compare-and-set
  state, and allowlisted task identity before deciding whether cleanup can
  continue. It does not blindly repeat an ambiguous destructive operation;
  unresolved commit state retains the `cleanup-required` lock.
- Terminal output contains aggregate booleans, counts, timings, safe cleanup
  state, and Git revisions only. All failures cross a fixed public error
  boundary with one source-controlled, allowlisted `failureDetail` code.
  Unknown or untrusted failures map to `unclassified`; raw errors and account,
  league, team, player, task, request, snapshot, hash, or record identities are
  not printed and never populate that field.

## Acceptance criteria

- The runner cannot target `nhl-fantasy-app-ab673`, an arbitrary Firebase
  project, or an emulator.
- Source is clean and pushed, local `main` equals freshly resolved remote
  `origin/main`, the deployed revision is its ancestor, and their delta
  contains no runtime or deployment input.
- The nine exact Draft, availability, and Projection Functions are ACTIVE in
  `us-central1` on Node 22; their generation-pinned source archives match the
  clean deployed Git build by path, byte length, and SHA-256 hash; and each
  active Cloud Run service/revision/image matches its Function provenance.
- Every source ZIP passes bounded central-directory/local-header validation and
  pre-extraction content proof; stored/deflated bytes must expand to the exact
  clean-Git length and SHA-256 within the hard output cap. Unsupported formats,
  forged sizes, compressed bombs, entry types, paths, compression, encryption,
  or content fail closed.
- The exact minute Scheduler target, URI, OIDC identity, deadline, retry
  policy, and health match the reviewed configuration. The automatic
  availability queue remains RUNNING with one concurrent dispatch and the
  bounded three-attempt backoff policy, while the Projection queue remains
  RUNNING with two concurrent dispatches and its single-attempt policy. The
  Draft-deadline queue remains RUNNING at 500 dispatches per second, burst 100,
  concurrency 10, five attempts, backoff from two through 3,600 seconds, and 16
  doublings.
- The operator explicitly reserves an exclusive shared-availability
  maintenance window. Any existing evidence lock or non-fixture Draft in
  `scheduled` or `live` state blocks the run.
- Before the lock and again inside the ownership transaction, the synthetic
  fixture is scheduled and stopped; `startedAt`, `completedAt`, and
  `pickStartedAt` are null; it has no drafted assets; next pick remains one;
  and its then-current start is at least two minutes away. Its pick
  subcollection is empty before locking.
- No non-fixture staging Draft is `scheduled` or `live` at any maintenance
  checkpoint, and the automatic availability, Projection, and Draft-deadline
  queues are empty before shared metadata changes.
- No availability attempt or Projection request occurs before its T-25 or
  T-20 boundary, allowing only a small documented clock-skew tolerance. Each
  natural Scheduler attempt and exact-revision request log correlates in less
  than 60 seconds. Manual duplicate probes are serialized by a full successful
  zero-pick automation marker; the exact two request logs subsequently map to
  the two disjoint accepted probe windows before the next natural minute.
- The first automatic availability task is observed as `lease-active`, two
  scheduler deliveries converge on one deterministic daily/bucket task, and
  the first queue observation proves its exact name and `createTime` with
  `dispatchCount` zero or one. The verified Function revision must emit exactly
  one provenance-bound HTTP 500 with strict latency, and the Firestore
  `lease-active` timestamp must fall inside that request within the documented
  two-second clock-skew tolerance. Before the retry and any unbounded read,
  two sub-retry duplicate probes must leave the same singleton, then the Draft
  must atomically park seven days ahead while availability returns to the exact
  baseline. The same provenance must show exact `[500, 204]`
  request logs with 25 seconds to five minutes from the first response end to
  the retry request start, plus one exact `already-current` completion marker
  before the task drains. `firstAttempt`, `lastAttempt`, `responseCount`, and
  `scheduleTime` are not required. The source attempt and successful-sync
  timestamp remain unchanged, and the report labels the proof
  `singleton-revision-correlated` rather than claiming deleted task identity.
- Strict source completeness proves schema 2, attempt binding, 32 NHL teams, a
  privacy-safe roster hash, and zero blocking malformed, duplicate, ambiguous,
  or missing-alias counts. A valid zero-injury result remains allowed.
- The Projection request is `pre-draft`, targets Matchup 1, requires six games,
  and is bound to the exact availability revision. Its document ID and
  deterministic attempt-one identity are exact; created, started, and
  completed timestamps are monotonic and bounded by the run and observation;
  creation is inside the natural T-20 window; duration is at most 30 minutes
  and agrees with those timestamps; and an evidence scan capped at 100
  documents finds exactly one matching request.
- The resulting snapshot is Projection V11 under Scoring V4, server generated,
  integrity verified, and carries complete strict Draft schedule evidence. A
  reviewed evidence-only cap bounds the snapshot read; document count equals
  the ceiling of asset count divided by 25, and request/snapshot chunk counts
  and hash arrays converge exactly.
- Readiness occurs before zero. Duplicate delivery and rescheduling cannot
  duplicate authority or retain a stale schedule binding. The final phase
  stops no later than fifteen minutes before zero and parks the Draft before later
  maintenance work on both its success and ordinary failure paths.
- During unavailable input at zero, status is still `scheduled`, the clock is
  `stopped`, next pick is one, and pick count is zero.
- Cleanup completes in the documented stages, retains all valid Projection
  audit state, resets the Draft before draining/verifying the allowlisted clock
  work, then handles Projection before restoring and draining availability.
  The final inventory passes before lock release, and no late task can
  overwrite the nanosecond-exact restored metadata. Otherwise the evidence
  lock remains `cleanup-required`.
- Deadline-task reconciliation permits only the four deterministic identities
  for the initial, intermediate parked, near-zero, and recovered schedules;
  any fifth or unrelated task blocks deletion and success.
- Every ambiguous transaction or task-deletion result is reconciled against
  exact remote state. An outcome that cannot be reconciled retains the
  `cleanup-required` lock and cannot be reported as a successful run.
- A failure report contains only the fixed error code, checkpoint, cleanup
  state, and an allowlisted non-identifying `failureDetail`. Dynamic error text
  or identifiers cannot enter the public record.

## Edge cases and stop conditions

- Refuse a synthetic Draft that is not scheduled, stopped, entirely unstarted,
  empty, and at least two minutes from its existing start. Refuse if those
  Draft-document conditions change before the atomic ownership transaction.
- Refuse a baseline that is missing, stale through the planned start, legacy,
  partially attested, attempt-mismatched, or structurally incomplete.
- Refuse more Draft documents than the bounded inventory scan can prove.
- Refuse any non-fixture Draft in `scheduled` or `live` state, regardless of
  how far its start is from the evidence window.
- Refuse a run that would cross UTC midnight because the automatic task identity
  and daily key intentionally change there.
- Refuse every existing evidence lock, including an expired or
  `cleanup-required` lock. Time alone does not grant permission to overwrite
  unknown shared state; that condition requires manual read-only diagnosis.
- Stop if the expected task is not the only pending availability task, if it
  does not retry and drain, or if the availability attempt/success identity
  changes during the no-upstream retry proof.
- Stop if either sub-retry duplicate scan reports anything other than one
  active fixture, schema 1, `success`, zero failed Drafts, zero picks, an empty
  failure list, and a bounded monotonic completion marker. Park and restore
  atomically before any later read even when a probe fails.
- Do not require `firstAttempt`, `lastAttempt`, `responseCount`, or
  `scheduleTime` from the task description. Do fail if its exact name,
  `createTime`, or first-observed zero/one `dispatchCount` is invalid, or if the
  provenance-bound HTTP 500, strict latency, in-request `lease-active`
  timestamp, response-end-based retry interval, exact `[500, 204]` sequence,
  or exact `already-current` completion evidence is absent.
- Stop before writes if the Draft-deadline queue is not initially empty. During
  cleanup, refuse to delete any deadline task whose complete resource identity
  is not one of the deterministic runner-owned schedule IDs.
- Stop if any readiness/request/snapshot value belongs to another schedule or
  availability revision.
- Stop if the Projection request was created outside the natural T-20 window,
  if any request timestamp falls outside the bounded run/observation interval,
  or if duration exceeds 30 minutes or conflicts with those timestamps.
- Stop and enter cleanup at least fifteen minutes before the recovered start if
  Projection or duplicate evidence has not completed. The failure path must
  attempt the registered safe park before ownership reconciliation.
- Treat every ambiguous transaction commit or task deletion as unknown until
  exact remote reconciliation succeeds. Retain the evidence lock whenever the
  run's ownership or final state remains uncertain.
- On any assertion failure, attempt each independent cleanup stage. Reset the
  Draft before restoring availability, never replace a concurrently newer
  value, never rewind Projection state, and retain the evidence lock when safe
  cleanup cannot be proven.

## Tests

The focused FF1.32 suite covers project and maintenance acknowledgements,
emulator, revision, fresh remote-main proof, tooling delta, UTC window,
adversarially bounded Function ZIP validation, exact Cloud Run/Scheduler/queue
provenance, fixture and bounded Draft inventory safety, strict attestation,
pre-extraction stored/deflated content verification and a forged-size
compressed-bomb fixture, sub-60-second natural Scheduler correlation,
serialized manual probes with full success-marker and disjoint-log checks,
deterministic task name/create-time with zero/one first-observed dispatch,
provenance-bound strict-latency HTTP 500, response-end-based exact `[500, 204]`
retry logs, structured/console `already-current` markers, exact Projection
request identity/timestamps/count bounds, nanosecond-preserving compare-and-set,
retained Projection audit state, allowlisted deadline-task cleanup, ambiguous
commit reconciliation, allowlisted privacy-safe failure details, staged
cleanup/`cleanup-required` locking, absolute pre-open deadline/fallback parking,
and no-deployment/no-Production-source guards.

The focused tests run through `npm run test:batchff1-16:run`. The current
composite gate is `npm run verify:batchff1-16`, which inherits
`verify:batchff1-15`; Angular and Functions builds, `git diff --check`, and the
clean-source guard remain required from the clean commit. The live staging
runner is evidence collection and is not part of the offline verification
batch.

## Staging command

Run only after independently confirming the deployed staging runtime revision
and Function inventory:

```bash
FF132_STAGING_PROJECT_ID=rinkrat-staging-d1nc-2026 \
FF132_STAGING_ACK=exercise-ff132-server-preparation-in-rinkrat-staging-d1nc-2026 \
FF132_STAGING_MAINTENANCE_ACK=reserve-exclusive-shared-availability-window-in-rinkrat-staging-d1nc-2026 \
FF132_DEPLOYED_RELEASE_REVISION=<full-40-character-staging-runtime-commit> \
npm run staging:ff1:exercise-server-preparation
```

No password is required. The command uses Application Default Credentials and
performs bounded writes to the isolated staging Draft, the fixed evidence lock,
and the staging-wide availability metadata exercised under the explicitly
reserved maintenance window. Do not run it while unrelated staging clients or
Drafts may use shared availability state.

## Deployment resources

This slice contains documentation, tests, and a local staging runner only. It
changes no Hosting or Functions runtime bytes and requires no Firebase
deployment. In particular, do not deploy Functions, Hosting, Rules, indexes,
TTL, App Check, queues, or workers for this tooling-only commit.
Queue and Scheduler configuration checks are read-only. The runner invokes the
existing Scheduler and removes only allowlisted staging fixture task instances
during cleanup; it never updates Scheduler, queue, Function, or Hosting
configuration.

The FF1.30/FF1.31 Production rollout remains separately blocked until this
evidence, supported two-tab/reconnect and physical-device checks, D1N capacity
evidence, and the final Draft freeze gate pass.

## Observability

Use the fixed evidence-lock document, bounded Cloud Tasks queue state,
`appData/playerAvailability`, `appData/injuryAutomation`, Draft readiness
fields, retained Projection request/control/pointer/snapshot metadata, exact
Function source generations, active Cloud Run revisions and image digests, the
exact Scheduler job, all three initially empty task queues, and Cloud Run
request/application logs correlated by revision and hash. Public evidence
records only boundary latencies, retry delay, bounded counts, source/snapshot
contract versions, convergence booleans, provenance booleans, and cleanup
outcome.

The initial and recovered Draft schedules are temporary staging evidence. The
runner registers one reusable seven-day parked schedule and four maximum
deterministic Draft-start task identities (initial, parked, near-zero, and
recovered). A graceful failure begins parking at least fifteen minutes before
zero. Maintenance runs under the invalid availability lease; after restoration,
only the bounded restore and safety-park transactions can remain, leaving more
than their combined Firestore retry ceilings before exact-start work. As with
any local staging mutator, an abrupt host/process termination can bypass local
`finally`; in that case the evidence lock and registered ownership require
immediate read-only diagnosis and reset-first cleanup before waiting for the
scheduled time or rerunning the tool.

The initial guarded live staging runs failed closed at the
`availability-boundary` checkpoint and reported `cleanupState: complete`.
FF1.32.1 represents that bounded failure class with the fixed allowlisted
`failureDetail: availability-failure-log`. Those runs demonstrate containment
and completed cleanup only. They are not passing T-25/T-20 evidence and do not
authorize a Draft release.

Do not publish raw records, errors, account IDs, league IDs, player or team
identities, availability attempts, task IDs, request IDs, snapshot IDs, or
hashes.

## Rollback

No runtime rollback is required because this slice has no deployed runtime.
Git rollback is a reviewed revert of the FF1.32 tooling commit.

If an evidence run stops unexpectedly, do not start another run blindly.
Inspect the exact fixture, evidence lock, availability marker, task queues, and
retained Projection request/snapshot/pointer/control state read-only. Reset the
synthetic Draft seven days ahead first, then reconcile, delete, drain, and
verify only its at-most-four allowlisted Draft-deadline tasks for the initial,
parked, near-zero, and recovered schedules. After that, await any owned
Projection request's terminal state and drain Projection work; use the runner's
nanosecond-preserving compare-and-set ownership rules to restore only the two
availability metadata fields still owned by that run, then drain availability
and reverify the Draft inventory before releasing the lock.
Preserve newer server state and every valid server-generated Projection
artifact. Remove a `cleanup-required` lock only after manual read-only diagnosis
and ambiguous-commit reconciliation prove all cleanup stages complete.

## Protected contracts

Production Scoring V4, Projection V11 formulas and hashes, six-game ownership,
Game 7 rollover, exact-once Draft picks and transactions, immutable started
windows, roster and transaction authority, standings, playoffs, historical
scoring, Rules, indexes, TTL, App Check, scoring queue mode, worker limits, and
canonical authority are unchanged.
