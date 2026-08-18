# Product Batch A1B — League Player Board and Player Intel

**Runtime release:** Release Candidate 40

**Competitive models:** Production Scoring V3 and Projection V11

**Primary routes:** League HQ → Players → Player Intel

## Purpose

A1B gives each league one searchable **Player Board** containing rostered players, free agents, active waivers, privately watched assets, and pending incoming assets shown only as reserved. Point Leaders remains a separate focused destination for finalized immutable six-game-window scoring history.

League navigation now uses:

```text
/leagues/{leagueId}/players
```

Selecting a row opens real Projection V11 Player Intel at:

```text
/leagues/{leagueId}/players/{assetKey}
```

## Player Board

The board combines the current verified shared Projection V11 snapshot with bounded league roster, public waiver, and private Watchlist state.

Each row can show:

- player or Team Goalie Unit;
- NHL team and exact position;
- rostered fantasy team plus active, bench, or IR area;
- free-agent, waiver, or reserved state;
- current-season fantasy points;
- overall season rank across every draftable position;
- exact-position season rank;
- next-six availability-adjusted projection;
- private watched state.

Search covers player, NHL team, fantasy team, and manager name. Filters cover position, rostered, available, waivers, reserved, and watched. Sorts cover season points, next-six projection, overall rank, position rank, rest-of-season projection, reliability, and name.

The first 50 rows render initially. **Show more** reveals the next 50 inline. A 30-second route cache lets a manager open Player Intel and return without immediately repeating every bounded roster read. Manual **Refresh** bypasses that cache.

## Ownership and pending-move privacy

Current roster ownership is already member-readable league information, so the board may show the fantasy team and active, bench, or IR area.

A pending incoming asset is competition-sensitive. The board labels it only as **Reserved by pending move**. It never identifies the destination manager, destination slot, outgoing asset, transaction document, or activation timing.

The Watchlist remains private and server-owned through the existing A1A callable authority.

## Player Intel

The default header keeps only the highest-value information visible:

- current-season fantasy points and fantasy points per game;
- overall rank across all positions;
- exact-position rank;
- next-six projection and likely range;
- roster, waiver, reserved, or free-agent status;
- Watchlist state.

Deeper information is separated into four inline, non-sticky sections.

### Overview

- recent 3, 5, 10, and 20 appearance fantasy pace;
- performance versus expected pace;
- rest-of-season and projected-final totals;
- age when available;
- recent and season time on ice;
- availability adjustment.

### Stats

- current-season category values;
- Production Scoring V3 fantasy-point contribution by category;
- season fantasy points per game and appearances.

### Projection

- next-six projected points and likely range;
- next-six overall and position ranks;
- reliability and model confidence;
- rest-of-season and projected-final totals.

### Schedule

- exact current six-game block when available;
- projected opponents otherwise;
- home/away split, back-to-backs, rest advantage, schedule adjustment, expected availability, and return date when present.

Unavailable fields display honestly as `—`; the browser does not invent missing stats.

## Connected surfaces

- League HQ, League Standings, and the mobile bottom navigation open **Players**.
- Player names in Free Agents and Waivers open Player Intel without another large card action.
- Point Leaders remains available as a separate scoring-history page.

## Data and performance

A1B is browser-only and uses bounded one-time reads:

- verified shared Projection V11 snapshot;
- league teams;
- one roster document per bounded league team;
- up to 100 public waiver projections;
- private account Watchlist.

It adds no permanent Firestore listener, Cloud Function, Rule, index, TTL policy, scheduled process, storage write, migration, or competitive mutation.

## Preserved systems

A1B changes no:

- Production Scoring V3 calculation;
- Projection V11 calculation or authority;
- independent immutable six-game roster-slot windows;
- seventh-game rollover;
- Draft, roster, scoring, transaction, or waiver authority;
- transaction and waiver privacy;
- App Check Monitor or exact-league/callable canary state;
- scoring queue Shadow or shared NHL cache Shadow authority;
- Firestore Rule, index, or TTL configuration.

## Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batcha1b && echo "A1B VERIFICATION PASSED"
```

## Deployment

A1B has no backend change. Build the exact committed source and deploy Hosting only:

```bash
npm run build

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1B Player Board Release Candidate 40"
```

Do not deploy Functions, Firestore Rules, indexes, TTL, App Check, scoring-queue, or NHL-cache configuration for A1B.

## Site-first smoke test

1. Open League HQ and select **Players**.
2. Confirm known active, bench, IR, free-agent, waiver, reserved, and watched assets show the correct state.
3. Search by player, NHL team, and fantasy-team name.
4. Sort by season points, overall rank, position rank, and next-six projection.
5. Open a rostered player and confirm the fantasy team and roster area are correct.
6. Confirm current-season fantasy points, overall rank, and position rank match the board.
7. Open Overview, Stats, Projection, and Schedule and confirm each section stays compact and uses real data.
8. Watch or unwatch the player and confirm the state persists in Players, Draft Room, and Free Agents.
9. Open a player directly from Free Agents or Waivers.
10. Confirm a reserved pending incoming asset does not reveal its destination manager or slot.
11. Check a Team Goalie Unit and confirm it remains clearly labeled as a unit.
12. Open Point Leaders and confirm it remains separate finalized six-game-window history rather than duplicating the current Player Board.
13. On a narrow phone, confirm filters stack, rows remain readable, **Show more** works, and the profile sections do not create a modal, overlay, or sticky obstruction.

When those visible checks pass, no routine Function logs, TTL inspection, NHL-cache inspection, or global deployment listing is required.

## Rollback

A1B is a Hosting-only presentation release with no data migration. Restoring the previous Hosting revision removes the Player Board and league-aware Player Intel. Existing projections, rosters, waivers, Watchlists, and competitive records remain unchanged.
