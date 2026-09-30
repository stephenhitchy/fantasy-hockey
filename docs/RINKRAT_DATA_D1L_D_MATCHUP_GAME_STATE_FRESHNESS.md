# RinkRat Data Batch D1L-D — Matchup Game-State Freshness

## Purpose

Make the six-game dots in Game Center communicate the NHL game state clearly,
and remove an avoidable extra scoring interval when a recently completed NHL
game remains `LIVE` in the longer-lived team-schedule cache.

## User-visible states

- Yellow: the NHL game is upcoming.
- Cyan: the NHL game is live. Fantasy points remain provisional.
- Green: the NHL game is final. RinkRat continues final player-appearance and
  scoring reconciliation in the background without an intermediate dot state.
- Red: the final team game is complete and the player did not appear.
- Gray: no game has been scheduled for that marker yet.

Server-owned completion evidence still decides whether the settled marker
remains green for an appearance or becomes red for a missed team game. The
immediate green state is presentation-only and never advances a six-game
window, score, transaction boundary, standing, or playoff.

Current injury or suspension status does not by itself turn a game red. A red
missed-game marker still requires the server-owned final and appearance
evidence, so a day-to-day designation cannot rewrite game history.

## Final-transition correction

The direct scorer already loads a short-lived game boxscore for every live
game. D1L-D uses that fresher boxscore for only the safe, one-way `live` to
`final` transition when the team-season schedule cache still says `LIVE`.
When that promotion occurs, the scorer loads the same required fresh player
game log used by the normal final path before settling played versus missed.

This removes the avoidable second ten-minute wait without shortening the
production scoring cadence or weakening D1L final-input completeness. A
scheduled game cannot be started from boxscore data, a final game cannot be
reopened, and incomplete final evidence remains visible and retryable.

## Protected contracts

D1L-D does not change Production Scoring V4 values, Projection V11 formulas or
hashes, six-game ownership, seventh-game rollover, immutable started windows,
Draft or roster authority, Firestore Rules, indexes, TTLs, App Check mode,
queue mode, worker limits, or canonical authority. It adds no listener and no
browser write.

## Verification

```bash
npm run test:batchd1ld:run
npm run verify:batchd1ld
npm run build:all
git diff --check
```

The focused regression suite verifies marker precedence, immediate-green final
presentation, legacy offline-snapshot compatibility,
the one-way live-to-final promotion, required late player-log loading, all
three responsive marker surfaces, and the rule that injury status is not
historical appearance evidence.

## Deployment boundary

This batch requires the server scorer consumers plus Hosting:

```text
functions:processLeagueAutomationTask
functions:runScheduledLeagueAutomation
functions:runSeasonStartAutomation
functions:initializeSeasonAfterDraft
functions:requestLeagueLiveScoringRefresh
functions:processHistoricalReplayAdvance
hosting:app
```

No Rules, indexes, TTL policies, migration, data rewrite, queue-mode change, or
canonical-authority rollout is required.

The later green-on-final presentation follow-up changes only browser source and
therefore requires only `hosting:app`; the D1L-D scorer Functions above remain
unchanged.

## Rollback

Revert the D1L-D source commit, run the inherited clean release gate, and
redeploy the same targeted Functions followed by Hosting. Existing scoring and
window documents remain valid and must not be deleted or rewritten.

To roll back only the later green-on-final presentation follow-up, revert its
browser, test, and documentation changes and redeploy only `hosting:app`. Do
not roll back or redeploy the unchanged D1L-D scorer Functions for that UI-only
rollback.
