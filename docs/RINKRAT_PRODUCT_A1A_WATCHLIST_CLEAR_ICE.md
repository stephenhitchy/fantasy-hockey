# Product Batch A1A — Player Watchlist and Clear Ice

**Runtime release:** Release Candidate 39

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surfaces:** Draft Room, Free Agents, Waivers, and everyday manager pages

## Purpose

A1A starts the manager decision-tools phase with one account-wide player watchlist while reducing information overload across the product. It deliberately avoids adding another dashboard panel or another persistent Firestore listener.

The interface pass is called **Clear Ice**: obvious controls stand on their own, optional hockey guidance follows the saved Hockey Familiarity setting, and safety-critical timing, privacy, eligibility, and destructive-action copy remains visible.

## Account-wide watchlist

The watchlist is independent of every league Draft queue. A verified manager can watch up to 100 skaters or Team Goalie Units and see the same list in any league.

Server-owned document:

```text
managerWatchlists/{userId}
```

Browser API:

```text
getPlayerWatchlist
setPlayerWatchlistEntry
```

The callable derives the owner from Firebase Authentication, validates each bounded asset key, and updates the list transactionally. The browser cannot provide another owner ID, write the document directly, or turn a watched player into a Draft pick, waiver claim, or roster move.

Permanent account deletion also removes the manager watchlist.

## Draft Room

Draft Room adds a compact star action beside the existing Queue action. The two systems remain separate:

- **Watch** saves the player across the account.
- **Queue** changes only the private queue for that exact league Draft.
- **Watched** filters the available Draft pool without changing rank, legality, or automatic selection.

The page loads the watchlist once through the callable. It adds no Firestore listener.

Current-season presentation note (FF1.1): Draft Room no longer renders the star or
watched-only filter so the time-sensitive player cards can stay compact. Saved
watchlists remain account-wide and available on the unified player/Add-Drop board;
the Draft queue remains private and continues to be the only list used by Auto-Draft.

## Free Agents and Waivers

Available Players and Waivers use the same watchlist and the same watched-only filter. Watching a player has no competitive effect and does not submit a claim, reserve a player, or change six-game timing.

The existing Add/Drop workbench, waiver privacy projections, server-authoritative roster actions, and exact six-game timing remain unchanged.

## Clear Ice copy-density pass

Seventeen manager-facing templates were reviewed, including Dashboard, League HQ, Draft Room, Draft Setup, Free Agents, Team Settings, Account Settings, League Wire, Playoffs, Point Leaders, Player Detail, onboarding, support, and league creation/joining.

The pass removes or conditionally hides descriptions that merely repeat a heading or button. It preserves copy that explains:

- six-game fairness and delayed roster timing;
- Injured Reserve eligibility;
- waiver and transaction privacy;
- Draft entry lock;
- secure competitive-action confirmation;
- permanent league and account deletion.

The source-controlled copy-density audit prevents the reviewed default experience from silently returning to a wall of explanatory text:

```bash
npm run audit:product-copy-density
```

Hockey Familiarity remains cosmetic and explanatory only. It never changes scoring, projections, roster rules, or league settings.

## Protected systems

A1A changes no:

- Production Scoring V3 calculation;
- Projection V11 calculation;
- independent immutable six-game roster-slot window;
- seventh-game rollover;
- Draft, roster, scoring, transaction, or waiver authority;
- transaction and waiver privacy;
- Firestore Rules or indexes;
- TTL policy;
- App Check Monitor or exact-callable canary setting;
- scoring queue Shadow or shared NHL cache Shadow authority.

## Verification

The one release gate is:

```bash
npm run verify:batcha1a && echo "A1A VERIFICATION PASSED"
```

## Functions-first deployment

Deploy the two watchlist callables and the account-deletion cleanup before Hosting:

```bash
firebase deploy \
  --only functions:getPlayerWatchlist,functions:setPlayerWatchlistEntry,functions:deleteMyAccount \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1A account player watchlist"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1A Clear Ice Release Candidate 39"
```

No Rules, indexes, TTL, App Check, scoring queue, or NHL-cache deployment belongs to A1A.

## Site-first proof

1. Watch a player in Draft Room and confirm the star changes without adding the player to My Queue.
2. Turn on **Watched** and confirm the Draft pool filters to watched undrafted assets.
3. Open another league’s Free Agents page and confirm the same watched player is recognized when present.
4. Watch or unwatch a player from Available Players and Waivers; refresh and confirm persistence.
5. Confirm Watch never submits a claim or roster move.
6. Review Dashboard, League HQ, Draft Setup, Team Settings, Account Settings, League Wire, Playoffs, and Create/Join on desktop and mobile. Headings and controls should stand on their own without repeated descriptions.
7. Confirm six-game timing, Injured Reserve eligibility, Draft entry lock, secure-operation status, and permanent-deletion warnings remain visible.

Routine TTL, NHL-cache, and global Function inspections are unnecessary when this visible workflow passes.

## Rollback

A Hosting rollback removes the Watch controls and restores the prior copy. Existing server-owned watchlist documents are inert when the older browser does not call them. A targeted Function rollback removes the callable API but does not affect Draft queues, rosters, waivers, scores, or league data.

Do not change Firestore Rules, indexes, TTL, scoring, projections, App Check, scoring queue, or NHL-cache settings as part of an A1A rollback.
