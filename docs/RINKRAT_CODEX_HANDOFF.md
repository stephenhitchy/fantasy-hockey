# RinkRat Codex Project Handoff

Last updated: 2026-09-04

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
  `01e93ac522f99a090489fc3e7da1d6602937ffee`, Release Candidate 65,
  Production Scoring V4, Projection V11.
- Deployed Function inventory: 107 expected, 107 matched, with no missing,
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

A subsequent supported Commissioner Draft Setup rehearsal found a separate
staging integration blocker: the shared callable CORS allowlist omitted the
dedicated staging Hosting origins. Two authenticated tabs reproduced the same
failure, the authoritative seven-day schedule remained unchanged, the exact
preflight response omitted `Access-Control-Allow-Origin`, and Function request
logs contained only `OPTIONS`, not `POST`. FF1.22 is the narrow exact-origin
source candidate; it adds no wildcard and changes no authorization or Draft
logic. No queue or worker limit changed, and real Draft authorization remains
blocked on the evidence below.

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
- The inherited exact-source verification command through the FF1.22 staging
  origin repair is `npm run verify:batchff1-6`, followed by `npm run build:all`,
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

1. Independently review and merge FF1.22, deploy only its five named staging
   callables followed by staging Hosting, and prove exact-origin preflight plus
   authenticated `POST` through supported Draft Setup. FF1.20 and FF1.21 have
   already passed their positive, duplicate, delayed, supersession,
   changed-input, bounded-retry, zero-pick, and safe-reset paths.
2. Complete controlled reconnect, duplicate-tab, physical iPhone/Android, and
   rollback Draft evidence on the exact repaired staging build.
3. Complete aggregate physical iPhone/Android D1N evidence on the exact staging
   build, then build D1N-C-B separately and review the 100 ramp before 500.
4. Repeat the exact-build six-team lifecycle and Projection V11 Draft rehearsal
   on desktop and physical phones, including reconnect and stale multi-tab.
5. Record the no-post-Draft-replacement or account-transfer decision.
6. Generate and independently review the D1J season-freeze kit, exact tag,
   targeted rollback, incident plan, and formal invitation/Draft go-no-go.
7. Begin the observed 2–4 league, 10–30 manager season under the post-Draft
   competitive freeze.
8. Continue 2,000/5,000 staging ramps, canonical fanout, Draft recovery
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
