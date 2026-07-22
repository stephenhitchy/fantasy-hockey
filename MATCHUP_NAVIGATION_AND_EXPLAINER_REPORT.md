# Matchup Navigation and Cycle Explainer Update

## Changed behavior

- Added a **My Team** button to the matchup page header.
- Kept the required cycle summary visible at all times.
- Moved the four-step cycle lesson and example into a collapsed native details panel.
- Kept the circle-marker instructions and legend visible below the expandable panel.
- Updated League Home and My Team matchup buttons to select the user's earliest unfinished matchup across every active asynchronous cycle.
- If no unfinished matchup remains, navigation falls back to the user's most recent completed matchup.

## Architecture safety

The navigation selector explicitly supports multiple active cycle numbers. It does not assume one league-wide active cycle timestamp and does not modify scoring, roster windows, projections, standings, or playoff data.

## Deployment

This is an Angular-only update. Run `npm run build`, then deploy `hosting:app`. No Functions, Firestore rules, or indexes changed.
