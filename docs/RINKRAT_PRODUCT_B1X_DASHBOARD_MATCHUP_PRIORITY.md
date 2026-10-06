# Batch B1X — Dashboard Matchup Priority

## Purpose

Make the signed-in mobile Dashboard lead with the information managers check
most often: their current league scores, matchup progress, and live starters.
This is a Hosting-only presentation change.

## Dashboard behavior

- League cards appear before Coach's Briefing and Around the NHL.
- Leagues with a current matchup are ordered first without changing the saved
  league order or any competitive data.
- Each card presents the manager and opponent scores as the primary visual,
  followed by the existing separate games-played bars and live-starter chips.
- The league rail supports native touch swiping, Previous and Next buttons,
  Left and Right Arrow keys, visible position text, reduced motion, and drag
  suppression for the card-wide League HQ action.
- When more than one league is available, an accessible layout toggle switches
  between the swipe rail and a responsive all-matchups grid. The browser keeps
  the manager's choice locally without a profile write or additional read.
- Mobile grid stacking excludes the league rail, so the first and later
  matchup cards all retain the same full-width snap track instead of allowing
  the first card to collapse beside the rail's implicit tracks.
- Create and Join buttons are removed from the Dashboard, including the empty
  state. Those routes remain available in the authenticated top-right menu.

## Mobile navigation

The persistent signed-in bottom navigation is restored with the four destinations
managers use during the season: **Dashboard**, **Matchup**, **My Team**, and
**More**. Create League and Join League remain in the keyboard-safe More menu
instead of occupying permanent bottom-bar positions. The signed-out public
bottom navigation is unchanged.

Matchup and My Team follow the league currently visible in the Dashboard rail.
League routes also update this context from their URL. The Dashboard's existing
bounded summaries provide the exact Game Center route; no navigation listener,
league listener, matchup listener, or additional Firestore read is introduced.
If no league or current matchup exists, the corresponding control remains
visibly and accessibly unavailable instead of guessing a destination.

The signed-in layout reserves safe-area space for the restored bar, connection
notice, transaction workbench, footer, and More sheet.

## Data and authority boundaries

The rail reuses the Dashboard's existing bounded league summaries. No
Firestore listener, NHL request, browser write, Function, Rule, index, TTL,
queue setting, or canonical authority changes.

Production Scoring V4, Projection V11, six-game ownership, seventh-game
rollover, immutable started windows, roster authority, standings, playoffs,
and historical reconstruction are unchanged.

## Verification

```bash
npm run test:batchb1x:run
npm run verify:batchb1x
npm run build:all
git diff --check
```

Manual checks should cover a one-league account and a multi-league account at
390 px and desktop widths. Confirm touch swiping does not open League HQ, arrow
buttons stop at the ends, focus remains visible, the top-right menu exposes all
removed destinations, and each theme keeps readable score contrast.

## Deployment and rollback

Deploy only Hosting:

```text
hosting:app
```

Rollback by reverting the B1X browser, test, and documentation commit, running
the inherited clean release gate, and redeploying `hosting:app`. No production
data rollback or Function deployment is required.
