# RinkRat Codex Project Handoff

Last updated: 2026-09-03

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
- a locally implemented, platform-admin-only D1M-A detector that pages one
  exact league/cycle, distinguishes verified, candidate, and unverifiable
  finalized games, and performs no competitive writes. It is not deployed or
  production-proven.

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
  `1754f80736e9abef46b08cccef7142c021cdf3a8`, Release Candidate 65,
  Production Scoring V4, Projection V11.
- Deployed Function inventory: 106 expected, 106 matched, no missing,
  unexpected, duplicate, or region-mismatched exports.
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
- The D1M detect-only reconciler remains on a separate, unmerged branch.
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
- The inherited exact-source verification command at this release is
  `npm run verify:batchl1a`, followed by `npm run build:all`,
  `git diff --check`, and `npm run release:verify-clean-deploy-source` from a
  clean commit.

## 2026–27 private-season freeze

Invitation and Draft authorization are separate gates. League preparation may
use disposable identities now. Send real invitations only after the exact
current Production invitation/removal matrix passes. Do not conduct a real
Draft until the exact-build six-team lifecycle, physical-device Draft
rehearsal, D1M detect-only release, D1N reconnect/100/500 evidence, and D1J
freeze/tag/rollback record pass with no unresolved P0/P1 integrity finding.

After the first real Draft, freeze competitive feature work. Preserve league,
membership, team, roster, Draft, player-window, transaction, standings, and
playoff identities. Normal releases must not require reinvites or Draft
recreation. Permit only narrow, tested, observable, reversible P0/P1 integrity,
security, availability, accessibility, or objectively incorrect-result fixes.

Use `docs/RINKRAT_FF1_INVITATION_GATE_RUNBOOK.md` for the disposable Production
matrix. It keeps Production writes with Stephen, uses bounded evidence aliases,
and defines the invitation-only exit decision and stop conditions.

## Current priority order

1. Run the exact current-Production disposable invitation and commissioner
   pre-Draft removal/reinvite matrix; authorize the real family-and-friends
   invitations only if it passes.
2. Rebase, independently review, stage, and release D1M detect-only finalized-
   score reconciliation. Do not add automatic correction.
3. Repeat the exact-build six-team lifecycle and Projection V11 Draft rehearsal
   on desktop and physical phones, including reconnect and stale multi-tab.
4. Finish D1N controlled reconnect, cleanup, pending-write, physical-device,
   and staging-only 100/500 operation evidence before Draft.
5. Generate and independently review the D1J season-freeze kit, exact tag,
   targeted rollback, incident plan, and formal invitation/Draft go-no-go.
6. Begin the observed 2–4 league, 10–30 manager season under the post-Draft
   competitive freeze.
7. Continue 2,000/5,000 staging ramps, canonical fanout, Draft recovery
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
