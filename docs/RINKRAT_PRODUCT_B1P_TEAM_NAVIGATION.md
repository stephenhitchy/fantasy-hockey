# Product Batch B1P: League Team Navigation

## Scope

Batch B1P turns the League HQ team directory into a scouting entry point. Each
team card links to the selected club's current matchup and full roster without
changing the authenticated manager's ownership context.

## Explicit routes and modes

- `/leagues/:leagueId/team` remains the authenticated manager's My Team route.
- `/leagues/:leagueId/teams/:ownerId` loads an explicit league/team context and
  supports refresh, browser history, and new-tab navigation.
- When `ownerId` matches the signed-in manager, the normal authorized controls
  remain available. Any other valid league team is rendered in read-only mode.
- Spectator loads never create a roster and never subscribe to the private
  owner transaction ledger. Firestore continues to allow league-member roster
  reads while denying browser roster writes.

## Current-matchup selection

League HQ uses one league-wide listener for active cycles and the latest
completed fallback. For each team it selects the earliest unfinished matchup,
then its most recent completed matchup when no unfinished matchup remains.
Both participants therefore navigate to the same stored matchup document.

## Presentation

The Teams section is a club directory rather than a wall of stat tiles:

- avatar and team identity form the roster link;
- record is emphasized while PF, PA, differential, and win percentage remain;
- matchup and roster actions are separate accessible links;
- unavailable matchups are identified honestly;
- actions stack below 360 pixels instead of shrinking or overflowing.

## Competitive boundaries

This batch changes navigation and league-visible presentation only. It does not
change Scoring V4, Projection V11, six-game ownership, seventh-game rollover,
frozen projections, queued move timing, Firestore Rules, indexes, TTLs, App
Check, queue mode, or any competitive write authority.
