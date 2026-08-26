# RinkRat Data Infrastructure Batch D1G

**Candidate:** RC66 / D1G
**Purpose:** direct-versus-canonical scoring parity, centralized final-game settlement, and version-aligned Canary proof
**Competitive authority:** Direct NHL scoring remains authoritative; the direct schedule, boxscore, play-by-play, and player-log path stays competitive authority.
**Canonical mode:** shadow comparison only
**Rollout scope:** exact Internal Test Canary leagues only

## Why this batch exists

D1F centralized live NHL observation, separated meaningful fantasy changes from TOI-only churn, and routed only affected Canary leagues. D1F.2 added deterministic preseason certification and phase timing. The scorer still retrieves direct NHL inputs independently, so the next safe question is not whether canonical data can replace those reads. It is whether the saved canonical game facts produce the exact same game-level fantasy result.

D1G answers that question without changing competitive authority:

1. the NHL observer stores compact canonical boxscore and play-by-play facts;
2. final player bonuses are settled once into that shared game record;
3. the queue carries the exact game IDs and per-game source versions that created the task;
4. the existing scorer calculates and publishes the direct-source result;
5. a separate shadow calculator computes the canonical result;
6. point totals and appearance status are compared game by game and asset by asset;
7. mismatches or incomplete evidence are stored for administrators and block Primary promotion;
8. canonical points are never passed to score publication in D1G.

## Runtime flow

```text
NHL scoreboard
    ↓
leased pollCanonicalNhlImpactFeed
    ↓
boxscore + play-by-play once per relevant NHL game
    ↓
canonical game facts and per-game source version
    ↓
final-only shared player-log settlement at bounded checkpoints
    ↓
affected exact Internal Test Canary leagues
    ↓
version-aligned Cloud Task payload
    ↓
existing direct NHL runLeagueAutomation() result publishes normally
    ↓
canonical shadow result is calculated separately
    ↓
matched / mismatch / incomplete evidence
```

## Final-game fact settlement

The current direct scorer uses the final player game log to settle statistics that are not fully available in the live boxscore, including:

- power-play points;
- shorthanded points;
- game-winning goal;
- overtime goal;
- final TOI fallback;
- final goals, assists, shots, and plus/minus fallback when needed.

D1G stores those fields once per relevant player inside the canonical game record. The observer checks at three bounded stages:

1. immediately when the game is first observed as final;
2. at or after five minutes final;
3. at or after 28 minutes final, inside the existing 30-minute reconciliation window.

No more than six player game-log requests run concurrently. Failed or not-yet-published entries leave canonical evidence incomplete; they do not fabricate zeroes and do not alter the direct score.

## Exact version handshake

A league request may coalesce changes from several NHL games. D1G therefore stores both:

```text
canonicalPendingGameIds
canonicalPendingGameVersions
```

The aggregate league source version is deterministically rebuilt from that exact game/version set. The queued payload carries the same immutable set. A malformed, incomplete, or misaligned payload is rejected before scoring.

If a newer NHL version arrives while an older task is running:

- the older payload compares only its own version set;
- it cannot satisfy the newer pending version;
- task completion leaves the schedule in `pending-follow-up`;
- a later version-aligned task must complete the newest request.

This prevents an older successful task from accidentally proving or clearing newer NHL data.

## Shadow scoring comparison

For each canonical-requested game used by an active player window, D1G compares:

- direct points;
- canonical points;
- direct appearance status;
- canonical appearance status;
- source-version alignment.

Supported assets:

- LW, C, RW, and D skaters;
- Team Goalie Units with all active goalies aggregated exactly once.

Final skater comparison remains incomplete until the shared final-settlement entry exists. A missing canonical game or a newer overwritten game version also remains incomplete rather than being counted as a pass.

Evidence is written server-side to:

```text
leagueAutomationCanonicalParity/{leagueId}
appData/leagueAutomationCanonicalParity
appData/leagueAutomation
leagueAutomationSchedules/{leagueId}
```

Stored detail is bounded. It contains league-level technical evidence and asset/game identifiers needed to debug a mismatch; it does not become a browser scoring source.

## Cohort gate

Primary promotion now requires current parity evidence for **every exact Canary league**, not merely the last league that completed.

Evidence must:

- have been recorded after the current queue configuration was activated;
- be shadow-only;
- have authoritative canonical reads disabled;
- use an aligned task source version;
- include at least one comparison;
- contain zero mismatches;
- contain zero incomplete or missing comparisons.

Changing the Canary allowlist makes earlier cohort evidence stale. Primary remains locked until the new cohort proves parity.

## Direct authority remains unchanged

D1G does not use canonical points to:

- publish a cycle snapshot;
- change a matchup score;
- advance a six-game player window;
- assign Game 7;
- activate a transaction;
- update standings;
- advance playoffs.

The direct result returned by `calculateCycleScoring()` remains the input to `publishCycleSnapshot()` and all existing persistence logic. Canonical comparison is an observation callback only.

A later release may permit one exact Internal Test Canary to read canonical facts competitively, but only after D1G produces repeated exact parity and rollback evidence.

## Verification

Use the pinned toolchain:

```bash
nvm use 22.23.1
npm install -g npm@11.17.0

npm ci
npm --prefix functions ci

npm run test:documentation:run
npm run test:batchd1g:run
npm run verify:batchd1g
npm run build:all
```

The D1G suite verifies:

- canonical final settlement changes the deterministic final hash;
- canonical skater and Team Goalie Unit scores match the shared scoring engine;
- matched, mismatch, missing, and incomplete outcomes;
- final-settlement checkpoints and bounded concurrency;
- exact per-game source versions in coalesced queue payloads;
- newer-version follow-up protection;
- all-Canary cohort gating;
- shadow-only authority;
- unchanged Production Scoring V4, Projection V11, Rules, and indexes;
- synchronized documentation and roadmaps.

## Deployment

Deploy the six changed Functions first:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy \
  --only "functions:pollCanonicalNhlImpactFeed,functions:processLeagueAutomationTask,functions:dispatchDueLeagueAutomation,functions:queueLeagueAutomationCanaryCheck,functions:getLeagueAutomationQueueControlCenter,functions:updateLeagueAutomationQueueConfig" \
  --project nhl-fantasy-app-ab673 \
  -m "D1G canonical scoring shadow parity"
```

Then deploy Hosting for the parity panel:

```bash
firebase deploy \
  --only hosting:app \
  --project nhl-fantasy-app-ab673 \
  -m "D1G canonical scoring parity controls"
```

Do not deploy Firestore Rules, indexes, TTL policies, or a database migration for D1G.

## Live proof

1. Keep production in Shadow immediately after deployment.
2. Confirm the canonical feed and queue Functions start without errors.
3. Use one completed-Draft Internal Test league with Historical Replay disabled.
4. Enable that exact league in Canary mode.
5. Observe meaningful live changes and final settlement through the direct scorer.
6. Confirm the parity panel reports the current Canary cohort rather than only the last run.
7. Require zero mismatches and zero incomplete records after the final settlement window.
8. Confirm no canonical document is read as competitive scoring authority.
9. Confirm backlog returns to zero and the legacy recovery path is not routinely needed.
10. Repeat across at least three NHL nights before considering the next phase.

## Rollback

The fastest operational rollback is to return the queue to **Shadow** in the Scoring Queue Control Center. Existing tasks remain idempotent and may drain safely.

For source rollback, revert the D1G commit, run the D1F.2 verification/build gate, and redeploy the reverted six Functions followed by Hosting only if the parity panel was deployed.

Do not alter Production Scoring V4, Projection V11, Firestore Rules, indexes, TTL policies, App Check mode, or league data during rollback.

## Next gate

D1G is not the canonical-read cutover. The next phase should require repeated exact parity, explain every mismatch, and then allow one exact Internal Test Canary to consume canonical facts behind a reversible feature flag. Final score corrections and completed-window replay require their own explicit integrity proof before broader use.
