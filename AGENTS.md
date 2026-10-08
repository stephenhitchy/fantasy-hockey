# RinkRat Engineering Instructions

## Product

RinkRat is an Angular 22 and Firebase/Firestore fantasy-hockey application.
Its defining competitive system gives every active player six NHL games per
fantasy matchup. Each player's seventh eligible NHL game belongs to that
player's next matchup.

Production Scoring V4 and Projection V11 are protected competitive contracts.

## Required startup procedure

Before modifying anything:

1. Read this file.
2. Read `docs/RINKRAT_CODEX_HANDOFF.md`.
3. Read `docs/RINKRAT_CODEBASE_GUIDE.md` for the current architecture and
   authority map.
4. Read the documentation closest to the subsystem being changed.
5. Run:
   - `git status --short`
   - `git branch --show-current`
   - `git log -1 --oneline`
6. Stop and report any unrelated or unexplained working-tree changes.
7. Never assume local source matches production. Treat the live release
   manifest and deployed Firebase evidence as separate states.

## Required toolchain

Use:

- Node.js 22.23.1
- npm 11.17.0

Load Node through nvm before running project commands.

Install exact dependencies with:

- `npm ci`
- `npm --prefix functions ci`

Never run:

- `npm audit fix --force`
- uncontrolled dependency upgrades
- broad package updates merely to remove a warning

## Protected competitive invariants

Do not change these unless the task explicitly requires it and includes
dedicated compatibility tests:

- Production Scoring V4 values
- Projection V11 formulas or hashes
- six-game player-window ownership
- seventh-game rollover
- immutable started windows
- injury-replacement segment ownership, including zero-game audit segments and
  current-segment-only regular/playoff rollover
- exact injury game-to-player and per-game source-team maps, monotonic
  activation boundaries, and preservation of every started/live/final game
- Draft authority
- add/drop, waiver, IR, and transaction authority
- standings or playoff authority
- historical scoring reconstruction
- Firestore Rules, indexes, or TTL policies
- App Check mode
- scoring queue mode
- worker or pending-task limits
- canonical scoring authority

Started games, earned points, and transaction boundaries must never move
because of a later stat correction.

## Change discipline

- Make the smallest coherent change that solves the task.
- Do not perform unrelated cleanup.
- Do not rewrite stable systems merely to simplify the implementation.
- Add regression tests for every corrected bug or edge case.
- Prefer pure utilities for complicated decision logic.
- Keep server-owned competitive decisions out of the browser.
- Preserve idempotency and safe retry behavior.
- Treat cycle-window, roster-pick, and assigned playoff-bank injury plans as
  one atomic authority. A missing/conflicting copy or protected-game mismatch
  must abort before any roster or scoring write.
- Never silently substitute missing competitive data with zero.
- Fail closed for writes and fail visibly for missing evidence.
- Preserve an explicit rollback path.

## Firebase safety

Do not deploy Firebase resources.

Do not execute:

- `firebase deploy`
- `firebase deploy --only functions`
- `firebase deploy --only firestore`
- `firebase functions:delete`
- queue-mode mutations
- production migrations
- production Firestore writes

Codex may prepare exact targeted deployment selectors in its final report,
but Stephen performs production deployment manually.

Never broaden a targeted deployment selector without explaining why each
additional resource changed.

## Scoring and NHL-data rules

Direct NHL scoring remains the proven fallback until canonical-source evidence
has passed the required live Canary gates.

For NHL ingestion and scoring work:

- never bypass the protected live-scoring predeploy guard; an intentional
  retry, throttle, or concurrency change requires matching regression tests and
  measured release evidence;
- never deploy from a revision that predates the protected release guards; the
  operator must see the clean-source, protected-roster, and protected
  live-scoring success lines in every Firebase predeploy log and stop if any
  marker is absent;
- fetch shared NHL facts once when possible;
- use deterministic source versions and hashes;
- distinguish live/provisional data from final settlement;
- suppress duplicate source versions;
- coalesce TOI-only changes;
- retain final and post-final correction checks;
- target only affected leagues when the impact index is complete;
- fail open only to the bounded approved Canary cohort;
- never let an older task clear a newer NHL source version.

For a scoring-correction system, implement detection and audit evidence before
automatic mutation. Any later correction must prove that it cannot duplicate
games, activate transactions again, move six-game ownership, or advance
standings/playoffs twice.

## Frontend rules

- Design mobile first.
- Preserve keyboard navigation, focus management, contrast, zoom, reduced
  motion, and screen-reader labeling.
- Do not add a Firestore listener when an existing bounded read or shared
  subscription can be reused.
- Every listener must have an explicit cleanup path.
- Every asynchronous action needs loading, success, failure, retry, stale-tab,
  and navigation-away behavior.
- Avoid information duplication and dense walls of explanatory text.
- Preserve all existing themes.

## Verification

Run the smallest relevant focused tests while developing.

Before declaring a change ready, run the current inherited release gate.
The current inherited gate is:

- `npm run verify:batchb2b`
- `npm run build:all`

Also run:

- `git diff --check`
- `git status --short`
- `npm run release:verify-clean-deploy-source`

If a newer source-controlled verification batch exists, use the newer batch.

Do not claim a test or build passed unless it actually ran successfully.

## Final response requirements

Report:

1. exact files changed;
2. behavior implemented;
3. tests and builds actually run;
4. anything not run and why;
5. unresolved risks;
6. exact targeted Firebase resources, if deployment is required;
7. rollback procedure;
8. whether scoring, Projection V11, Rules, indexes, TTLs, queue mode, or
   competitive authority changed.
