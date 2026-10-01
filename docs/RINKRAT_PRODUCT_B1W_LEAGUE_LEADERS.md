# Product B1W — League Leaders

## Purpose

League Leaders makes RinkRat scoring and Projection V11 rankings discoverable
without turning the global Dashboard into another data-heavy player directory.
The canonical page remains league scoped:

```text
/leagues/{leagueId}/leaders
```

League HQ includes **League Leaders** in its shared navigation. Every Dashboard
league card also has a route-only **Leaders** shortcut; the Dashboard does not
load leaderboard documents or projection assets.

The page is a deliberately reviewed adopter of RinkRat's shared `rr-card`,
`rr-button`, `rr-notice`, and `rr-state` visual primitives and is registered in
the source-controlled design-system migration allowlist.

## Views and meaning

### Current Matchup

Uses the current fantasy cycle's saved server slot windows. It is explicitly
labeled **Live / provisional** because live NHL facts and unsettled windows may
still change. The page keeps one realtime listener for only that current
cycle's compact per-team window documents. When overlapping active cycles
exist, it starts with the earliest unfinished cycle. Once every participating
team's window document is complete, the page archives that final snapshot,
cleans up the old listener, and moves the same single listener to the next
active cycle. Replayed callbacks from the old listener cannot advance twice.

### Season

Aggregates only windows whose stored status is `complete`. Active or scheduled
partial windows are excluded even when they already contain provisional
points. Historical points stay attributed to the owner recorded on each
immutable window. If an asset scored for more than one fantasy team, the row
lists every team and its contribution rather than assigning all points to the
asset's newest owner.

Historical cycle documents and team-window collections are bounded one-time
reads. The page does not create one listener per completed cycle.

### Projected Next 6

Loads only after the manager selects the projection view. It accepts a ready,
server-authored, integrity-verified Projection V11 snapshot whose scoring
version matches the league. The complete Draft-authority seal is required:
ranking version, non-emergency generation, nonempty canonical catalog, loaded
asset count, supported hash schema, root hash, and every expected chunk hash.
Emergency or partially sealed snapshots fail visibly and produce no projected
rows. Ordering uses the existing availability-adjusted next-six projection,
then existing projection fallbacks when present. Missing values display as
`—`; they are never converted to zero.

Current roster ownership is loaded as context only. Unowned assets are labeled
**Free agent**. This context does not alter Projection V11 ordering. Fantasy
goalies remain NHL **Team Goalie Units**, not individual goalie assets.

## Position and player navigation

Every view supports exact filters for `All`, `LW`, `C`, `RW`, `D`, and `Goalie
Units`. Rank numbers are recalculated inside the selected exact-position view.
Each player row opens the existing league-aware Player Intel route.

The mobile layout uses vertical, multi-line rows and preserves ownership,
games, points-per-game, projection range, and availability context instead of
hiding those fields at narrow widths. The first 50 rows render initially and
additional rows use inline progressive disclosure.

## Competitive authority

B1W is read-only. It changes no:

- Production Scoring V4 rule or stored score;
- Projection V11 formula, ranking, or published snapshot;
- six-game ownership or seventh-game rollover;
- Draft, roster, waiver, transaction, standings, or playoff authority;
- Firestore Rule, index, TTL, App Check, queue, or canonical scoring mode.

## Verification

Focused coverage lives at:

```text
test/batchb1w-league-leaders/league-leaders.test.mjs
```

Run it with:

```bash
npm run test:batchb1w:run
```

It verifies completed-window season isolation, provisional current scoring,
multi-owner attribution, exact-position ranks, missing projection handling,
goalie-unit semantics, rejection of emergency/incomplete projection seals,
overlapping-cycle listener handoff, bounded history, the single current
listener, lazy projection loading, and navigation entry points.

## Deployment and rollback

This is a Hosting-only feature. No Functions, Rules, indexes, TTL, or queue
configuration is added. Roll back by restoring the prior Hosting revision; no
data migration or competitive-state repair is required.
