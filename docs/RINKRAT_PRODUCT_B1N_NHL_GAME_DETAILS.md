# Batch B1N — Dashboard NHL Game Details

## Scope

This Hosting-only presentation batch makes the main area of each Dashboard NHL
scoreboard card open a read-only view for that card's stable NHL game id. The
view is an NHL single-game surface. It does not calculate or mutate RinkRat
matchup scores, six-game windows, projections, rosters, Draft state, or any
other competitive record.

## Data and lifecycle

- The view reuses the approved `nhlApiProxy` routes already supported for
  `/v1/gamecenter/{gameId}/boxscore` and
  `/v1/gamecenter/{gameId}/play-by-play`.
- Both resources load on demand after navigation. The shared browser NHL cache
  deduplicates in-flight requests by URL and caches game data for two minutes.
- Live/critical games refresh every 30 seconds. Final, scheduled, postponed,
  and canceled games do not poll. Route changes and component destruction
  invalidate late responses and clear the timer.
- Partial provider failure keeps successful data visible, identifies the
  missing section, and offers Retry. Missing values render as unavailable
  rather than numeric zero.
- Dashboard date and horizontal rail offset are retained in bounded,
  session-only state for 30 minutes and consumed when the manager returns.
- A pointer movement greater than 10 pixels suppresses card navigation, so
  horizontal scoreboard swiping remains separate from a deliberate tap.
  Existing roster badges remain independent sibling controls above the card
  entry surface.

## Available provider fields

The approved box-score feed currently provides game state, clock, period,
date/time, venue, teams, logos, score, shots on goal, and individual skater and
goalie lines. Skater lines support goals, assists, points, shots, TOI,
plus/minus, hits, blocks, penalty minutes, faceoff percentage, and power-play
goals. Individual goalie lines support saves, shots against, goals against,
save percentage, TOI, starter status, and decision when present.

The play-by-play feed provides chronological goals, scorer and credited assist
ids, period/time, score after a goal, team ownership, manpower situation,
roster names/headshots, overtime, shootout attempts, and penalty events. B1N
uses that evidence for the scoring summary and derives only labels that the
manpower code proves (power play, shorthanded, or empty net).

The current provider response does not supply official game stars or reliable
power-play opportunity totals. The UI therefore says **Statistical leaders —
Not official NHL stars**, uses a deterministic game-only ordering, and shows
power-play goals without inventing opportunity counts. Six-game bonuses and
cycle totals remain absent. Batch B1R later adds a clearly labeled read-only
Scoring V4 exact-game skater calculation without changing that boundary.

## Player links

Goal scorers, assists, leaders, skaters, and individual goalies link through
the existing `/players/:playerId` route with the exact NHL game id. The legacy
demo-player behavior remains intact for its fixture ids. For a real NHL player,
the route now resolves that exact game's approved box-score and play-by-play
data and shows a raw single-game stat card. Batch B1R also shows the skater's
exact-game RinkRat calculation and category breakdown. It does not present an
individual NHL goalie as a RinkRat team-goalie unit.

## Verification

Focused commands:

```bash
npm run test:batchb1n:run
npm run test:dashboard-scoreboard:run
npm run build
```

The B1N suite covers stable-id validation, scheduled/live/intermission/final/
overtime/shootout formatting, chronological event ordering, supported goal
labels, shootout totals, missing-versus-zero comparison values, deterministic
non-official leaders, exact route wiring, swipe suppression, session restore,
request deduplication, polling cleanup, fantasy isolation, real-player detail
resolution, and mobile layout contracts.

Browser verification used real NHL final, pregame, and shootout payloads. It
checked keyboard team filtering, exact-card navigation, browser Back/date/rail
restoration, real-player navigation, and page overflow at 320, 375, 390, 430,
768, and 1280 pixels. Desktop/browser emulation does not replace a physical
iPhone Safari pass for browser chrome and safe-area behavior.

## Deployment and rollback

No Firebase deployment is performed by this batch. When approved, only Hosting
is required:

```bash
firebase deploy --only hosting:app
```

Rollback is a Hosting rollback to the immediately preceding approved release.
No Functions, Firestore Rules, indexes, TTLs, App Check settings, queue modes,
Production Scoring V4 values, Projection V11 formulas, six-game ownership, or
competitive authority change.
