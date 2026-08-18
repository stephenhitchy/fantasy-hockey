# Product Batch A1C — Unified Add / Drop and Replay-Fresh Player Data

**Runtime release:** Release Candidate 41

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surface:** League Add / Drop and Player Intel

**Competitive authority:** Existing server roster-action, waiver, historical-replay, and projection-generation authorities

## Purpose

A1C removes the duplicate player-directory experience. The route previously used for Player Board becomes the only Add / Drop surface, while the old `/free-agents` route redirects to it. Managers browse the entire league player pool, inspect Player Intel, and begin a secure roster move without changing visual systems or opening a modal.

A1C also closes the historical-replay freshness gap. A replay day that releases NHL games queues a Projection V11 rebuild after scoring completes. The unified page follows the exact current projection pointer and refreshes season totals, ranks, availability, projections, and six-game markers when the new verified snapshot publishes.

## Unified route

```text
/leagues/{leagueId}/players          Add / Drop
/leagues/{leagueId}/players/{asset}  Player Intel
/leagues/{leagueId}/free-agents      redirects to Add / Drop
```

The former standalone `league-player-board` route component is removed. Point Leaders remains a separate page for finalized immutable six-game-window history.

## Default player view

The page opens with:

```text
Show: Free agents
Sort: Next 6 projection
Position: All positions
Rows: 50
```

Managers may switch to All, Rostered, Waivers, Unavailable, Watched, or exact-position views. Search includes player, NHL team, fantasy team, and manager names. Another 50 rows appear through inline progressive disclosure.

## Player row

Every row preserves the Player Board presentation and includes:

- player or goalie-unit identity;
- NHL team and position;
- league ownership or availability;
- visible injury status and return date, or `Return date TBD` when no reliable date exists;
- current Matchup number;
- six numbered game markers in two rows of three;
- season fantasy points;
- overall rank;
- exact-position rank;
- next-six Projection V11 points;
- private Watchlist control;
- Add or Claim when the asset is legally actionable.

The marker colors retain their established meaning: played, missed, upcoming, or unavailable. The page does not add another explanatory paragraph beside the tracker.

## Add, claim, and drop flow

Selecting **Add** or **Claim** opens an inline second step using the same row layout.

The incoming player remains selectable for Player Intel. The roster list contains only the signed-in manager's valid choices:

- legal same-position active players;
- valid bench players;
- compatible open active slots;
- open bench slots;
- no slot already reserved by a pending move.

Each outgoing player remains selectable for Player Intel. A separate **Select to drop** or **Use slot** button makes the competitive choice unambiguous. The final confirmation retains exact six-game timing and distinguishes immediate, scheduled, and waiver-contingent outcomes.

A1C does not create a new transaction writer. It continues using the existing server-authoritative add/drop, open-slot, waiver-claim, waiver-processing, and queued-move callables.

## Pending-move privacy

League members may see that an asset is **Unavailable**, but the unified directory does not reveal the destination manager, destination slot, outgoing asset, request identifier, or planned activation Matchup. Canonical transaction and claim records remain private under the existing C1B boundary.

## Historical replay freshness

After `performHistoricalReplayAdvance` releases one or more NHL games:

1. authoritative replay scoring completes;
2. the replay worker queues a Projection V11 refresh through the existing projection task system;
3. scoring success remains valid even if queueing or generation later fails;
4. the projection task publishes a new verified current pointer;
5. the unified Add / Drop page receives that exact pointer update and reloads the new snapshot.

If a second replay day moves ahead while a projection build is already active, the completed projection task compares its `projectionAsOfDate` with the latest replay context. When it is behind, it queues one deterministic catch-up request for the newer replay date. This prevents rapid manual advancement from leaving Player Board season points and ranks permanently one day behind.

The browser listens only to the exact `projectionSnapshots/current` pointer. It does not listen to all player documents. Asset chunks are fetched only when the authoritative snapshot ID changes.

## Mobile experience

- No transaction modal or fuzzy backdrop.
- The player row becomes a two-line mobile grid.
- Matchup and six markers remain immediately left of the numeric metrics.
- Watch and Add/Claim actions use 44-pixel targets.
- The roster-selection step uses the same layout as the player pool.
- Player Intel opens as a normal route and the selection state is restored when the manager returns.
- The page retains vertical scrolling and no new sticky region.

## Preserved systems

A1C changes no:

- Production Scoring V3 formula;
- Projection V11 algorithm;
- immutable six-game roster-slot window;
- seventh-game rollover;
- Draft authority;
- roster-action or waiver authority;
- transaction and claim privacy;
- Firestore Rule or index;
- TTL policy;
- App Check Monitor or selected-callable canary state;
- scoring queue Shadow or shared NHL cache Shadow authority.

## Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batcha1c && echo "A1C VERIFICATION PASSED"
```

The release proceeds only when the final success line appears.

## Deployment

Deploy the two changed workers before Hosting:

```bash
firebase deploy \
  --only functions:processHistoricalReplayAdvance,functions:processProjectionGenerationTask \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1C replay-fresh player data"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1C unified Add Drop Release Candidate 41"
```

No Rules, indexes, TTL, App Check, scoring-queue, or NHL-cache deployment belongs to A1C.

## Site-first proof

1. Open Add / Drop and confirm Free agents plus Next 6 projection are the defaults.
2. Confirm All and Rostered views include owned assets and link to Player Intel.
3. Confirm Matchup number and six markers appear immediately left of Season Points.
4. Confirm an injured player shows status and return context.
5. Add a free agent and verify the second step contains only legal roster players or open slots.
6. Open an outgoing player's Intel, return, and confirm the transaction choice remains recoverable.
7. Complete one immediate or queued move through the existing authority.
8. Advance one historical replay day that releases NHL games.
9. Keep Add / Drop open or return to it; confirm a new snapshot updates season points and ranks without manually regenerating Projection V11.
10. Advance rapidly across another game date and confirm the eventual snapshot catches up to the latest replay date.
11. Confirm Point Leaders, My Team, Watchlist, and waiver privacy still behave normally.
12. Repeat the primary flow on a narrow phone viewport.

## Fallback diagnostics

Only when replay scoring succeeds but player data never refreshes:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only processHistoricalReplayAdvance,processProjectionGenerationTask
```

## Rollback

Restore the prior RC40 Hosting revision to separate Player Board and Add / Drop again. If the replay refresh workers must also be rolled back, deploy their prior known-good revisions. Existing completed scoring, projection snapshots, rosters, transactions, waivers, and Watchlists require no migration rollback.
