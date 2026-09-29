# Batch B1R — NHL Game Fantasy Points

## Scope

Batch B1R adds a read-only RinkRat fantasy-point calculation to the NHL
single-game experience. Each skater row in the player box score receives a
compact **RinkRat FP** value, and the linked exact-game player detail exposes
the same total with an expandable category breakdown.

Within each NHL team tab, scored skaters are ordered from highest to lowest
exact-game RinkRat FP. Equal totals preserve the provider's box-score order,
and skaters whose calculation is unavailable remain visible at the end rather
than disappearing.

The number applies the existing Production Scoring V4 engine to that exact NHL
game. It is not a fantasy matchup total, does not apply a six-game or cycle
bonus, and does not claim that the performance occupied one of a roster slot's
six games. The existing Dashboard roster badge remains the source for whether
a saved league matchup counted that game.

## Evidence and honest unavailable states

The adapter reuses the already-loaded NHL box score and play-by-play. It maps
goals, primary and secondary assists, shots, hits, blocks, plus/minus, special-
teams points, game-winning and overtime goals, and time on ice into the shared
Scoring V4 engine. It creates no per-player NHL requests.

Live values use the same provisional boundary as current live scoring: power-
play goals are available immediately, while short-handed, game-winning, and
overtime settlement bonuses wait for final evidence. Live totals are labeled
as estimates.

If the box score and play-by-play disagree, a required situation code is
missing, the game has not started, or the scoring summary failed, the UI shows
the value as unavailable rather than substituting zero. Final values remain a
presentation calculation from the current provider response; saved server
league scores remain authoritative for competitive state and later stat
corrections.

RinkRat does not display fantasy points beside individual NHL goalies. Fantasy
rosters own an NHL team's combined goalie unit, so assigning the unit score to
one goalie would be misleading. The individual-goalie detail explains that
boundary.

## Competitive and deployment boundaries

Production Scoring V4 is unchanged; this batch imports and calls the existing
engine without changing any value or formula. Projection V11, six-game window
ownership, seventh-game rollover, started-window immutability, roster and
Draft authority, standings, playoffs, App Check, and queue mode are unchanged.

This is a Hosting-only presentation change. No Functions, Firestore Rules,
indexes, or TTLs require deployment.

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only hosting:app
```

Rollback is a Git revert of the B1R commit followed by a Hosting-only rebuild
and deployment.
