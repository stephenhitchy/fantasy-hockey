# RinkRat Codex Project Handoff

Last updated: 2026-09-09

## Repository

Local path:
`/Users/StephenH/Documents/Programming/fantasy-hockey`

GitHub:
`github.com/stephenhitchy/fantasy-hockey`

Firebase project:
`nhl-fantasy-app-ab673`

Production domain:
`rinkratfantasy.com`

Always verify the current local commit, working-tree state, live manifest, and
deployed Firebase state at the beginning of release work. Do not treat the
values in this document as a substitute for those checks.

## Stack

- Angular 22
- Firebase Authentication
- Firestore
- Cloud Functions for Firebase, second generation
- Cloud Tasks
- Firebase Hosting
- Node.js 22.23.1
- npm 11.17.0

## Competitive contracts

- Production Scoring V4
- Projection V11
- six NHL games for every active player
- independent player windows
- seventh-game rollover
- immutable started windows
- server-authoritative Draft, roster, waiver, IR, scoring, standings, and
  playoff operations
- team goalie units rather than individual fantasy goalies

## Current scoring architecture

RinkRat contains:

- the established direct NHL scoring path;
- a per-league idempotent Cloud Tasks queue;
- a centralized NHL change observer;
- canonical boxscore and play-by-play game facts;
- separate fantasy-event, TOI, game-state, and final-settlement hashes;
- TOI-only coalescing;
- an affected-league impact index;
- exact canonical source versions carried through queue tasks;
- explicit per-asset final-input completeness and retry evidence;
- deterministic canonical publication outbox records committed atomically with
  signal-worthy game-fact versions;
- direct-versus-canonical shadow parity;
- one-league canonical-read Canary controls;
- automatic direct fallback and a canonical circuit breaker;
- queue watchdog and measured-capacity evidence;
- a legacy scoring path retained for rollback.

The direct NHL path remains the proven fallback.

The D1L-B replay-only correction for traded skaters is merged and deployed:
source-season games carry their historical team into final-input validation,
missing source-team evidence fails closed, and legacy replay maps rebuild as
validated schema-2 maps. Its bounded staging fixture proved complete input,
stable duplicate delivery, and the expected score before the targeted
`processHistoricalReplayAdvance` Production release. Live scoring authority
was not changed.

## Current scoring-correction coverage

Already present:

- duplicate-source suppression;
- final settlement;
- additional post-final observations;
- direct-versus-canonical parity for controlled Canary work;
- direct fallback on mismatch, missing data, incomplete settlement, or version
  misalignment;
- circuit-breaker evidence;
- synthetic final-correction certification scenarios.
- final numeric-score reuse only after complete source-version evidence;
- exact task game/version parity scope, so unrelated active-window games are
  not classified as canonical-missing;
- durable, idempotent canonical-to-league notification with older-version
  supersession, stale-writer compare-and-set, and bounded cursor rotation;
- canonical parity fallback when the requested final fact lacks complete,
  exact-version input evidence.
- a platform-admin-only D1M-A detector that pages one exact league/cycle,
  distinguishes verified, candidate, and unverifiable finalized games, and
  performs no competitive writes. Its bounded staging admin/non-admin,
  repeat-delivery, latest-cycle, legitimate-zero, mismatch, unverifiable, and
  unchanged-state evidence passed. The exact read-only Function is ACTIVE in
  Production; an unauthenticated Production request was denied as expected.

Not fully finished:

- durable scheduling/checkpoint storage for a universal audit of every
  finalized stored RinkRat player/game score;
- archived-game source reacquisition where canonical settlement is absent;
- a safe replay mechanism for correcting already completed player windows;
- exact-once correction proof across transactions, standings, playoffs, and
  Game 7 ownership.
- a retention or cleanup policy for delivered canonical publication outbox
  evidence.

The first correction phase should detect and report discrepancies only. It
must not automatically rewrite production scores.

## Current verified release posture

- Production Hosting manifest: exact source
  `6fb443c5dac882f001a81adb93adf2fd205844f4`, Release Candidate 65,
  Production Scoring V4, Projection V11.
- Deployed Production Function inventory: 107 expected by the currently live
  source and 107 matched, with no missing,
  unexpected, duplicate, or region-mismatched exports after the D1M release.
  The Draft/Projection-critical set and D1M detector are ACTIVE; repeat this
  read-only evidence in the exact FF1 freeze record.
- `processHistoricalReplayAdvance`, `removeLeagueMemberSecure`, and
  `publishLeagueAuditActivity` are ACTIVE.
- Commissioner member removal is supported before Draft only. It uses
  fresh-auth/password and exact-team confirmation, server-owned transactional
  cleanup, audit publication, and idempotent retry behavior. Do not extend it
  into destructive post-Draft removal.
- The D1N no-op identity-write repair is merged and deployed. An authenticated
  staging sample reached the expected 20-listener/26-document Available
  Players envelope, returned to zero listeners on Support, and recorded zero
  `team:list` pending-write snapshots, listener errors, unknown counts, or
  awaiting-first-snapshot listeners.
- The D1M detect-only reconciler is merged and released. Production
  `getFinalScoreReconciliationPage` is ACTIVE on Node 22 with a bounded maximum
  of three instances; unauthenticated access fails closed. Authenticated
  platform-admin read-only smoke evidence remains part of the FF1 lifecycle
  rehearsal, and automatic correction remains out of scope.
- App Check remains Monitor, scoring queue rollout remains unchanged, canonical
  authority is not being expanded, and direct NHL scoring remains the fallback.

Inventory parity does not prove that every deployed Function revision contains
the exact current Git source. Capture the D1J exact-source season-freeze record
before authorizing a real Draft.

## Current capacity posture

The live scoring queue was intentionally introduced with conservative worker
and pending-task limits. These are rollout controls, not Firebase platform
limits.

Capacity decisions must use:

- real queue-task p50/p95/p99;
- retry and terminal-error rate;
- oldest queue age;
- backlog recovery;
- Firestore contention;
- NHL upstream request volume;
- source-to-visible freshness;
- cost per active league.

Do not increase concurrency based only on Historical Replay timing.

D1N currently provides privacy-safe route/listener envelopes in the separate
billed staging project, authenticated high-risk-route samples, repaired Draft
focus/same-page cleanup, pending-write attribution, and a deployed no-op
identity-write repair that removed the observed `team:list` pending write.
Controlled reconnect, multi-tab, physical-device evidence and the 100/500/
2,000/5,000 staging ramps remain open. The 2,000/5,000 ramps are public-scale
evidence, not a blocker for a controlled 2–4 league family-and-friends cohort.

D1N-C-A adds a read-only, Production-refusing load preflight and aggregate
physical-device evidence schema. It fixes the 100/500/2,000/5,000 sequence,
requires the immediately preceding stage to pass on the same revision, checks
the isolated billed project and exact staging manifest, and requires only the
two staging task workers. It does not generate traffic or deploy. The physical
iPhone/Android evidence and D1N-C-B task generator remain open.

## Current Draft-room UX posture

The compact Draft cards, bounded injury/return presentation, player
headshot-with-team-badge identity, and FF1.18 one-hour Draft lobby are merged.
Authenticated 319px and desktop presentation, keyboard focus, hard reload,
listener cleanup, and duplicate-tab private-queue convergence passed. Exact
390/430, all-theme, 200% zoom, controlled reconnect, and physical-device
coverage remain open.

The lobby is presentation-only until the authoritative scheduled start. Picks,
clock start/pause/resume, and Auto-Draft controls remain live-only; the existing
server-authoritative Draft checks still gate every pick. FF1.19 is merged and
its three targeted staging Functions remain ACTIVE. The exact `e0a69017`
staging Hosting manifest and FF1.20 guarded positive/duplicate evidence passed:
readiness reached `ready` before zero on attempt one without a browser,
duplicate delivery retained the same request/snapshot identity, the clock
stayed stopped, and no pick was created. FF1.21 adversarial evidence also
passed on exact staging source `0150ad98`: delayed input locked safely,
rescheduling superseded the prior request, changed availability rebuilt,
attempt-one failure produced a 60-second bounded retry that recovered on
attempt two, the clock stayed stopped, no pick was created, and the fixture
reset seven days ahead. The existing minute worker prepares during the
20-minute window and binds a
deterministic Projection V11 request to the exact schedule and hashed
availability input, and starts the clock only with the exact verified
request/snapshot/hash. The first no-browser execution correctly persisted
`waiting-injury` and kept the clock stopped when the synthetic fixture lacked
fresh daily injury evidence.

FF1.22 is merged and deployed to exact staging source `fe5f68cc`. All five
targeted Functions are ACTIVE, both named staging origins receive their exact
`Access-Control-Allow-Origin`, an unrelated Firebase origin remains denied,
and supported Draft Setup produced an authenticated `POST`. Server authority
persisted the requested synthetic schedule while retaining `scheduled`, a
stopped clock, next pick 1, zero drafted assets, and zero pick documents.

That successful server commit exposed a separate client confirmation defect:
the browser detached Firestore `Timestamp.toDate` from its receiver, so the
method's internal `this.toMillis()` failed and displayed a false error until
reload. FF1.23 is the narrow client-only source candidate that preserves the
timestamp receiver and adds a realistic regression; it is merged at source
`16a3466c`.

An observed start rehearsal first showed the countdown reaching zero before a
long legacy browser ESPN/projection preparation path completed. FF1.24 removed
that browser path and added a deterministic exact-start task. Its first
25-minute staging rehearsal proved readiness more than seventeen minutes before
zero, zero picks, two-tab convergence, and Cloud Tasks dispatch within a
fraction of a second of schedule. It also exposed a cold `processDraftClockDeadline`
instance: the authoritative start completed about 6.1 seconds late and failed
the five-second gate. FF1.25 now dispatches the same task ten seconds early,
waits server-side until zero, rereads the Draft, and then uses the unchanged
readiness transaction. Production Hosting identifies exact source `7956b376`,
but a two-minute Production rehearsal subsequently exposed a different gate:
the schedule was accepted before exact readiness existed, a redundant browser
Projection build competed with server preparation, NHL requests received 429
responses, and the Draft correctly remained stopped after zero. FF1.26 is the
narrow source candidate that requires 25 minutes for a new/changed schedule,
allows a nearer unchanged time only with exact current availability-bound
Projection V11 evidence, removes the browser build, and preserves one
authoritative server request. No scoring/projection formula, queue rate,
minimum instance, concurrency, or worker limit changed. Exact staging
rejection, reuse, timing, duplicate, reconnect, and physical-device evidence
must pass before Draft GO.

FF1.26 is merged and staging Hosting identifies exact source `631d0310`.
Automated isolated evidence rejected an unprepared two-minute schedule without
mutation, accepted 25 minutes, reused one exact request/snapshot, rejected a
changed time and availability revision, recovered an injected failure after a
59-second backoff, became ready 1,051.129 seconds before zero, and opened the
Draft/first clock 3.218 seconds after zero with no pick. The fixture reset seven
days ahead, stopped and empty.

That evidence also observed natural NHL 429 responses. The shared Projection
loader omitted the rejected team schedules, used its neutral schedule fallback,
and still published `ready`. FF1.27 now requires every team-schedule response
for only `pre-draft` and `draft-start-fallback` generation before ready
snapshot/pointer publication. On exact staging source `2ada57ef`, two natural
attempts each failed visibly at 24/32 schedules, preserved the prior
`fixture-v11` pointer, restored availability, and left the Draft scheduled,
stopped, at next pick one, and zero picks.

Those two attempts also proved the existing eight-request burst can repeat the
same upstream limit instead of recovering. FF1.28 is merged and staging
Hosting identifies exact source `23dbf10a`. Only strict Draft-opening schedule
input is loaded one team at a time with a three-second interval and stops after
two terminal club failures. FF1.27's request error and readiness backoff remain
the only recovery owner. Guarded staging evidence loaded all 32 schedules,
recovered a bounded retry, reached readiness about fifteen minutes before zero,
and opened the Draft and first clock in 2.848 seconds with zero picks. Tolerant non-Draft generation,
Projection V11 formulas/hashes/rankings, queue concurrency, worker limits, and
the Draft-opening transaction are unchanged. High-scale shared NHL schedule
reuse remains a later independently reviewed D1N/canonical-fanout concern.

FF1.29 adds a local, guarded six-client staging rehearsal for the case where
six human inboxes are unavailable. It provisions six fixed synthetic Auth
identities, authenticates six independent Firebase clients, and uses the
ordinary `executeDraftCommand`, `makeSecureDraftPick`, Rules-protected private
queue, and `removeLeagueMemberSecure` paths. The Admin SDK is restricted to
exact marker-bound fixture provisioning/reset, binding an already verified
server Projection V11 snapshot to the accelerated disposable Draft, read-only
assertions, and disabling the accounts. The rehearsal covers idempotent and
competing submissions, one queue timeout, empty-queue Auto-Draft, pause/resume
past an obsolete deadline, reconnect, snake reversal, 102 unique picks, six
complete rosters, and post-Draft removal rejection. It does not replace the
separate exact-start test or physical browser, focus, zoom, and mobile
evidence. No Firebase deployment is required for this tooling-only slice.

FF1.29 staging evidence passed on 2026-09-09 UTC against deployed source
`23dbf10a06315c696f9e00229dc361abb66f54e6` using clean tooling source
`5d870b9405bc7b67a6fb02df244c0bc6cec139d7`. Six authenticated clients and
listeners converged through 102 unique picks, six complete rosters, snake
reversal, idempotent replay, stale competing submissions, pause/resume,
reconnect, queued timeout, empty-queue Auto-Draft, and post-Draft removal
rejection. The first attempt failed closed at the former fifteen-minute
collector boundary and reached verified readiness immediately afterward; a
twenty-minute bounded rerun passed without bypassing Projection V11 readiness.
The evidence-tool default is therefore twenty minutes. This is a collector
timing correction only, not a Draft readiness or runtime change.

FF1.30 is the client-only automatic-readiness UX candidate. The server already
prepares the exact Projection V11 board inside T-20 without a browser or
commissioner action. The existing Draft listener now reloads an already-open
lobby when that exact snapshot/hash becomes ready, refuses an unrelated current
pointer while a scheduled Draft lacks exact readiness, and replaces the stale
manual-refresh instruction with an accessible automatic-preparation state. It
adds no listener or competitive write.

FF1.31 is the server-owned input-preparation candidate layered after FF1.30.
It closes the no-browser gap where T-20 readiness previously waited for stale,
missing, running, or failed daily injury evidence. Beginning at the existing
25-minute minimum safe lead, the Draft worker queues one globally deduplicated
server injury-refresh task per five-minute bucket. The new task retries three
dispatches with one concurrent dispatch; its private 25-second error guard lets
the 30-second-or-longer task backoff make real upstream retry attempts, while
persisted exponential backoff limits subsequent buckets and a one-hour overdue
horizon prevents an abandoned scheduled Draft from polling indefinitely.
Normal refresh callers preserve the existing 15-minute cooldown. Current
successful daily evidence is reused, while a same-day error is retried under
those bounded rules. Draft authorization additionally
requires a strict source attestation: every NHL roster request must succeed,
each team roster must include both position arrays and the documented
conservative skater floor, and
the ESPN injury response must be fresh, successful, structurally valid,
and free of malformed, unrecognized, or duplicate team groups. Valid low/zero
injury populations are not rejected merely for being small; ambiguous current-
roster identities or missing alias targets remain blocking, while source names
absent from the same NHL roster input retain the existing D1B advisory policy.
The attestation includes a privacy-safe hash of player ID, normalized name,
position, and NHL team. Strict Projection generation clears its roster cache,
requires that exact identity-set hash, and compare-and-set invalidates only the
matching old source attempt if the NHL roster changed. The Projection worker
revalidates that attestation, its exact refresh-attempt
binding, its 24-hour lifetime through the scheduled start, and the daily key
belonging to its own success timestamp before generating the exact T-20,
schedule- and availability-bound Projection V11 snapshot. Crossing UTC
midnight alone does not invalidate fresh evidence. Any incomplete input leaves
the Draft scheduled, stopped, and empty. This candidate adds one Function export,
so source expects 108 Functions while the currently deployed Production inventory
remains 107 until a targeted release. It does not guarantee a populated board for
the complete T-60 lobby; moving preparation earlier remains dependent on measured
p95/p99 and clustered-start capacity evidence.

FF1.30/FF1.31 are merged at source `e5e133fb`. Isolated staging Hosting
identifies that exact source and all nine targeted Draft/availability/
Projection Functions are ACTIVE on Node 22. A guarded no-browser T-19 smoke
run automatically replaced legacy input with strict schema-2 availability,
proved a complete 32-team NHL source and bound refresh/source attempts,
prepared one exact Projection V11 request/snapshot, converged across duplicate
scheduler delivery, reached ready before zero, and kept the Draft stopped at
zero picks before resetting it seven days ahead. That useful smoke does not
separately certify the T-25 and T-20 boundaries or the availability-task retry
path.

FF1.32 is the tooling-only candidate for that remaining staging proof. Its
guarded runner requires both exact-run and exclusive shared-availability
maintenance acknowledgements, a freshly resolved remote `origin/main`, a clean
pushed tooling delta, and an existing strict baseline; it never changes injury
records. Before writes, it applies bounded adversarial ZIP validation and
compares all nine generation-pinned Function sources against a clean build of
the declared deployed Git commit by exact path, byte length, and SHA-256 hash.
Stored and deflated ZIP entries are expanded and hashed inside a hard
pre-extraction output cap, so forged size metadata cannot bypass that envelope.
It then proves the matching active Cloud Run revisions/images, exact Scheduler,
exact availability, Projection, and `processDraftClockDeadline` queue
configurations. The availability, Projection, and Draft-deadline queues must
all be initially empty, and no non-fixture staging Draft may be `scheduled` or
`live`. That exclusion is required because manual Scheduler scans can touch
automation leases for every scheduled Draft. It uses an
active metadata lease to observe one deterministic singleton Cloud Task failure
without manufacturing upstream failure. FF1.32.1 binds that first failure to
the exact task name and `createTime` with a first-observed `dispatchCount` of
zero or one, then requires one exact verified-revision/hash/user-agent/method
HTTP 500 with strict latency and the Firestore `lease-active` timestamp inside
that request. It intentionally does not depend on the eventually consistent
`firstAttempt`, `lastAttempt`, `responseCount`, or `scheduleTime` description
fields. After the `lease-active` marker, two serialized Scheduler probes run
inside a strict sub-retry deadline and must each persist a full schema-1
`success` marker for exactly one active Draft, zero failed Drafts, zero picks,
an empty failure list, and bounded duration. They must leave the same one
deterministic task; their exact two HTTP 200 logs are then mapped to their
disjoint accepted probe windows. Then one transaction moves the already
registered Draft
to a seven-day parked schedule while compare-and-set restoring availability
before any unbounded read. The retry must then produce exact `[500, 204]`
request logs, with 25 seconds to five
minutes measured from the first response end to the retry request start, plus
one exact `already-current` marker in either expected structured status or
exact console text. This remains `singleton-revision-correlated`, not exact
post-success task identity, because Cloud Tasks deletes a successful task.
Natural T-25/T-20 Scheduler evidence must correlate in less than 60 seconds;
manual duplicate probes are serialized by their full success markers and later
correlated one-to-one with their request logs.
The runner verifies exact Projection V11/schedule-input attestation, exact
attempt-one request identity, creation inside the natural T-20 window,
monotonic run/observation-bounded timestamps, a maximum 30-minute duration,
and evidence count bounds. Fixture ownership requires a scheduled, stopped,
empty Draft with null `startedAt`, `completedAt`, and `pickStartedAt` whose
existing start remains at least two minutes away, both before the lock and
inside the atomic ownership transaction. Cleanup
resets that Draft, drains and verifies only allowlisted clock work, then handles
Projection before using a nanosecond-preserving compare-and-set to restore and
drain runner-owned availability state; it never rewinds valid
generated Projection requests, snapshots, pointers, control, or counters.
The recovered T-20 phase stops evidence fifteen minutes before zero. It runs
its final maintenance check while invalid availability keeps the Draft closed,
then admits the one-attempt availability restore only while its complete
270-second ceiling fits before T-15. It uses deadline-bounded pre-T-20 reads
without another maintenance transaction. Success and ordinary failure share a
compare-and-set final park that accepts only the exact recovered or exact
already-parked schedule, uses `maxAttempts: 1`, reconciles before retry, and
must be authoritatively proven by T-5. Deadline-losing mutations stay handled
and tracked; unresolved outcomes or an unproven T-5 park return
`cleanup-required` and block both cleanup and evidence-lock release. The
cleanup reset is also single-attempt. While the near-term schedule remains
unproven, the runner also skips the cleanup-marker transaction and leaves its
existing lock untouched so it can return promptly. Clock-task cleanup recognizes
at most the four exact identities for the initial, parked, near-zero, and
recovered schedules.
Ambiguous commits/deletions are reconciled against remote state, and any
uncertain cleanup retains a non-releasable evidence lock, marked
`cleanup-required` whenever the marker itself is safe. Terminal failures
expose only the fixed error code, allowlisted checkpoint and cleanup state, and
one source-controlled, non-identifying `failureDetail`; unknown values become
`unclassified`, and raw error text or identifiers are never emitted. The first
guarded live staging runs failed closed at the `availability-boundary` and
completed cleanup; FF1.32.1 maps that bounded failure class to the fixed
allowlisted `failureDetail: availability-failure-log`. That proves containment
only, not passing T-25/T-20 evidence. FF1.32.2 subsequently removes the final
default-retry assumption from safety-critical Firestore transactions and adds
full-attempt admission plus tracked late-outcome handling. This tooling slice
changes no application or Functions runtime and no Firebase resource
configuration; it must not be deployed.

The first post-FF1.32.2 run failed closed with
`failureDetail: availability-scheduler-proof` and completed cleanup. Read-only
logs proved the exact natural Scheduler HTTP 200, waiting-state/task creation,
intentional active-lease HTTP 500, and bounded HTTP 204 retry. FF1.32.3 fixes
the runner-only race without putting eventual control-plane reads on the
ten-second retry-critical path. On the initial T-25 path, deterministic
task/lease capture, the two bounded duplicate probes, and atomic Draft
park/availability restore precede log waits; exactly one natural Scheduler 200
must fall in a disjoint verified-revision/hash window ending before probe one.
FF1.32.3 polls the later natural T-25 and T-20 `lastAttemptTime` inside the
existing strict sub-minute window before any manual probe can overwrite it.
FF1.32.4 below supersedes that approach for the time-constrained T-20 endgame.
Stale, late, or ambiguous evidence still fails closed. No runtime deployment
is required for FF1.32.3.

The first post-FF1.32.3 guarded run failed closed at `projection-boundary`
with `failureDetail: projection-snapshot-validation` and completed cleanup.
Read-only diagnosis proved the natural T-20 Scheduler HTTP 200, one exact
Projection request, a ready Projection V11/Scoring V4 snapshot containing
1,179 assets in 48 chunks, and a scheduled/stopped/zero-pick safety reset. The
request needed about 235 seconds and became ready only 37 seconds before the
T-15 evidence cutoff. The runner then spent that remaining interval waiting
for mutable Scheduler metadata and eventually consistent request logs; the
label therefore misclassified timing exhaustion as snapshot validation.
FF1.32.4 keeps only two serialized success-marker probes and exact
ready/duplicate/zero-pick assertions before the absolute cutoff, immediately
performs the existing one-attempt T-5 safety park, and defers Scheduler logs,
request-history uniqueness, and deep snapshot reads until after that park.
The deferred audit correlates three disjoint immutable log windows and imports
the two manual probes to their immutable Cloud Audit `RunJob` requests while
requiring no such request in the claimed natural T-20 window. A full two-second
clock-skew gap separates each prior marker from the next trigger. The runner
also imports the authoritative Projection snapshot verifier directly from
source to recompute every ordered chunk hash and the schema-2 root hash.
Canonical chunk IDs, contiguous indexes, and the 25-asset writer layout are
also required. No runtime deployment is required for FF1.32.4.

FF1.32.4 passed on 2026-09-09 UTC against exact staging runtime `e5e133fb`
using clean pushed tooling `1d7dfd02`. The natural T-25 availability path,
bounded task retry, natural T-20 Projection request, duplicate convergence,
authoritative Projection hash chain, scheduled/stopped/zero-pick state, safe
reschedule, empty queues, and lock release all passed. This closes the
no-browser preparation proof but not the supported-UI, physical-device,
scheduled-start, full Draft, lifecycle, capacity, or freeze gates.

FF1.33's first runtime prerequisite is committed at `48ebbefe` with staging evidence
pending. The league-scoring lease transaction reads raw Historical Replay
authority before any write and rejects every non-replay trigger whenever the
replay control is enabled. This closes the late duplicate `draft-complete` and
`season-start` race that could otherwise create Cycle 1 after the six-client
fixture was parked. Replay activation and later worker reassertions park the
recurring schedule atomically; outcome, canonical, enqueue, retry, stale
recovery, bootstrap, Canary, and completion writers also serialize behind the
same authority without replacing terminal or newer task evidence. The explicit
serialized replay worker remains eligible. Committed Draft-pick handoff emits
a bounded structured event plus a one-way league/pick path hash without raw
league or pick identifiers.

The separate FF1.33 tooling hardening is required before rerunning the
six-client rehearsal on the current strict schema-2 source. The older collector
stopped safely before picks because it required exactly 20 legacy D1N
availability records; the current server-owned result legitimately uses a
different bounded record count. The hardened runner never writes shared
availability. It shares FF1.32's exclusive lock, requires `48ebbefe` to be an
ancestor of the declared deployed runtime, verifies the reviewed guard-source
hashes and every exercised Function archive/revision, and requires one exact
structured committed-pick marker for each of the 102 expected one-way hashes.
It recomputes the current availability revision and Projection V11 chunk/root
hashes inside one run-owned activation transaction, strengthens off-clock,
deadline, queue-skip, duplicate-tab, exact roster, six-game window, lifecycle,
Rules-provenance, activity-publication, and completion checks, and permits only
the exact seven-file tooling delta.

The runner requires an empty one-shot v2 namespace, never deletes or replaces a
prior fixture, waits through server-worker, Draft-trigger, and scheduled-worker
quiet periods, and deletes the deterministic future start task only after
verifying its full target, OIDC identity, payload, timing, and non-executing
state. Any uncertain fixture, account, authenticated-client, lifecycle, or
queue cleanup retains `cleanup-required`. Immediately before lock release the
runner repeats the complete retained-v1 byte comparison and proves both shared
guarded task queues and the queued/processing Historical Replay request set are
empty. A changed boundary can therefore never become a later run's accepted
baseline. The tooling commit changes no Firebase runtime and must not be
deployed, but the rehearsal still requires all 16 runtime authorities it
exercises plus three replay/automation guard prerequisites:
`processLeagueAutomationTask`, `processHistoricalReplayAdvance`, and
`advanceHistoricalReplayDay`. All 19 must exist in isolated staging at the same
guarded revision and use the exact reviewed runtime, build, Eventarc, Scheduler,
and task OIDC service identity. A read-only 2026-09-09 preflight found 12 of the
16 exercised authorities present: four were absent and three present Functions
had older source archives; all three guard prerequisites were present on older,
unguarded revisions. Deploy site-pinned staging Hosting and exactly those 19
Functions from the same clean guarded commit, with both task workers ahead of
their producers. Do not deploy Rules, indexes, TTL, or any of the eight
behavior-affected entry points required to remain absent. The two included
scheduled Functions retain their reviewed topology; no Scheduler job is added.
The excluded scheduled-worker set must remain absent because the retained
FF1.29 v1 audit fixture has no replay control and is intentionally complete
without Cycle 1. The runner proves that boundary remains byte-stable and that
the pre-existing league-automation and Historical Replay task queues stay
empty without cleaning or changing them. The retained D1L fixture already has
raw Replay authority enabled, so guard-bearing Functions require forward repair
rather than a pre-guard rollback. This does not replace supported-UI or
physical-device evidence.

## Release and deployment rules

- Start every implementation from a clean Git worktree.
- Use branches or Codex worktrees.
- Never deploy from dirty source.
- Never use broad Firebase deploy commands.
- Build and test after committing so release manifests contain the committed
  revision.
- Stephen performs production deployment manually.
- Deploy Functions before Hosting when both changed.
- Deploy Rules, indexes, or TTL policies only when the task explicitly changes
  them.
- Verify the live release manifest after Hosting deployment.
- Preserve targeted rollback commands.
- FF1.29 inherits the FF1.28 `npm run verify:batchff1-12` gate. The current
  exact-source command is `npm run verify:batchff1-17`, followed by `npm run build:all`,
  `git diff --check`, and `npm run release:verify-clean-deploy-source` from a
  clean commit.

## 2026–27 private-season freeze

Invitation and Draft authorization are separate gates. The owner reports the
current invitation/removal paths passing on desktop Safari/Chrome and physical
iPhone Safari and has accepted the missing Android invitation sample for the
small observed cohort. Do not conduct a real Draft until the exact-build
six-team lifecycle, physical iPhone and Android Draft rehearsal, D1N
reconnect/100/500 evidence, and D1J freeze/tag/rollback record pass with no
unresolved P0/P1 integrity finding.

After the first real Draft, freeze competitive feature work. Preserve league,
membership, team, roster, Draft, player-window, transaction, standings, and
playoff identities. Normal releases must not require reinvites or Draft
recreation. Permit only narrow, tested, observable, reversible P0/P1 integrity,
security, availability, accessibility, or objectively incorrect-result fixes.

Use `docs/RINKRAT_FF1_INVITATION_GATE_RUNBOOK.md` for the disposable Production
matrix. It keeps Production writes with Stephen, uses bounded evidence aliases,
and defines the invitation-only exit decision and stop conditions.

Use `docs/RINKRAT_FF1_DRAFT_GATE_RUNBOOK.md` for the separate exact-release
Draft/lifecycle matrix. Its preflight is read-only and authorizes evidence
collection only; the final FF1.16 Draft go/no remains mandatory.

## Current priority order

1. Merge the reviewed `48ebbefe` replay-lease runtime guard, then independently
   review and merge its separate seven-file six-client tooling commit.
2. Deploy only the exact 16 exercised staging Functions plus the three
   replay/automation guard prerequisites and site-pinned Hosting from the guarded
   runtime commit. Confirm two Scheduler jobs and five task queues match
   protected topology, then run the hardened rehearsal against that exact
   manifest revision.
3. Complete the owner's two-manager supported-UI Draft rehearsal and record
   desktop/iPhone evidence plus the explicitly accepted missing Android risk,
   if Android remains unavailable.
4. Complete aggregate physical iPhone/Android D1N evidence on the exact staging
   build, then build D1N-C-B separately and review the 100 ramp before 500.
5. Complete the Historical Replay lifecycle evidence separately; the automated
   six-client Draft rehearsal does not cover add/drop, waivers, IR, scoring,
   six-game ownership, Game 7, standings, or playoffs.
6. Record the no-post-Draft-replacement or account-transfer decision.
7. Generate and independently review the D1J season-freeze kit, exact tag,
   targeted rollback, incident plan, and formal invitation/Draft go-no-go.
8. Begin the observed 2–4 league, 10–30 manager season under the post-Draft
   competitive freeze.
9. Continue 2,000/5,000 staging ramps, canonical fanout, Draft recovery
   pagination/starvation protection, and App Check/abuse/queue-promotion proof
   as separate reviewable work without changing Production rollout modes.

## Required update policy

After every merged release:

- update this document's current-state sections;
- add the new verification command;
- record new runtime authority or rollout state;
- record known limitations;
- remove statements that are no longer true;
- do not copy long historical release notes here.
