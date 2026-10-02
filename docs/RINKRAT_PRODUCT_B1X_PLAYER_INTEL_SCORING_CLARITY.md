# Batch B1X — Player Intel Scoring Clarity

## Scope

This Hosting-only presentation batch separates live matchup scoring from
Projection V11 season and historical context on league-aware Player Intel. It
does not calculate, publish, or mutate competitive scores.

## Data truth

Player Intel receives two intentionally different scoring sources:

- the active immutable six-game roster-slot window supplies the current
  matchup total, counted NHL team games, and player appearances;
- the verified Projection V11 snapshot supplies current-season production,
  rankings, projections, category contributions, and the historical sample
  used by the projection model.

Early in a season, Projection V11 can legitimately use prior-season history.
That sample must not be labeled as current-season appearances or points. A
missing current-season total remains visibly unavailable while the current
matchup total continues to show the saved authoritative window score.

## Presentation

- Current matchup points and current-season points are separate primary cards.
- The current matchup card links to the existing Game Film score-driver view,
  including goal, assist, shot, ice-time, and other category bars.
- Current-season category contributions use the same compact positive/negative
  bar treatment on Stats when snapshot detail exists.
- Projection form names its source season and appearance sample.
- A sample smaller than a requested recent window uses the true sample label;
  duplicate windows collapse. One appearance therefore renders once as
  **Last game**, never as Last 3, Last 5, Last 10, and Last 20 simultaneously.
- Missing current-season category data says that it is updating instead of
  substituting prior-season values.

## Verification

Focused coverage lives in `test/batcha1b-player-board` because this remains the
same bounded Player Intel surface. It includes the exact one-game regression,
prior-season labels, current-window score wiring, score-driver navigation,
contribution bars, and mobile-safe presentation contracts.

## Deployment and rollback

Only Firebase Hosting is required:

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only hosting:app
```

Rollback is a Hosting rollback to the immediately preceding approved release.
No Functions, Firestore Rules, indexes, TTL policies, App Check settings,
queue modes, Production Scoring V4 values, Projection V11 formulas, six-game
ownership, or competitive authority change.
