# RinkRat Codex Project Handoff

Last updated: 2026-08-31

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

Not fully finished:

- a universal audit of every finalized stored RinkRat player/game score;
- a detect-only discrepancy dashboard covering every eligible league;
- a safe replay mechanism for correcting already completed player windows;
- exact-once correction proof across transactions, standings, playoffs, and
  Game 7 ownership.
- a retention or cleanup policy for delivered canonical publication outbox
  evidence.

The first correction phase should detect and report discrepancies only. It
must not automatically rewrite production scores.

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

## Current priority order

1. Verify and stabilize the current clean release.
2. Collect live Canary scoring evidence.
3. Build a detect-only finalized-score reconciler.
4. Prove correction detection against archived and live NHL games.
5. Add safe exact-once correction only after detection is trusted.
6. Measure client listeners and route performance.
7. Run staged load tests in a separate Firebase project.
8. Increase worker concurrency only from measured evidence.

## Required update policy

After every merged release:

- update this document's current-state sections;
- add the new verification command;
- record new runtime authority or rollout state;
- record known limitations;
- remove statements that are no longer true;
- do not copy long historical release notes here.
