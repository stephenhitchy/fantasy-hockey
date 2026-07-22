# Historical Season Replay V1

## Purpose

Adds a commissioner-only **Advance One NHL Day** control to the matchup-page Dev Controls. The control advances a league-scoped simulated 2026–27 calendar and releases corresponding 2025–26 historical performances through the same server scoring and immutable roster-window workflow used by live leagues.

## Core behavior

- The button advances one calendar day, not one game for every player.
- Only assets whose current NHL team is scheduled on the simulated date advance.
- Every roster slot retains its own six-game window and cycle number.
- Current 2026–27 team Game N maps to an ordered 2025–26 historical source game.
- Skater mappings include historical team-schedule gaps so a team game can count while the player receives zero for not appearing.
- Goalie units use the same franchise's ordered 2025–26 team games.
- Historical data is scored with the league's current scoring rules.

## Production paths exercised

Each advance runs the server-authoritative league automation and updates:

- Shared scoring snapshots
- Independent team/slot cycle windows
- Player-card game circles
- Matchup totals
- Queued roster-move boundaries
- Newly opened overlapping windows
- Matchup and cycle completion
- Standings
- Playoff window banks and advancement
- Point-leader totals

Commissioner browser live-scoring refresh is paused while replay mode is active so live NHL data cannot overwrite the simulated ledger.

## Firestore documents

- `leagues/{leagueId}/historicalReplay/control`
- `leagues/{leagueId}/historicalReplayAssets/{assetKey}`

The first replay advance builds and caches historical asset mappings. That first run may take longer than later advances.

## Safety

Use this in a dedicated test league. Replay advances write genuine cycle, matchup, roster-window, standings, transaction-boundary, and playoff state. V1 intentionally does not provide a one-click destructive reset.

Historical ESPN injury timelines are not reconstructed. Current shared injury data and commissioner overrides remain separate from the historical game replay.

## Deployment

```bash
npm run build
npm --prefix functions install --include=dev
npm --prefix functions run build

firebase deploy --only functions:advanceHistoricalReplayDay,functions:runScheduledLeagueAutomation,functions:initializeSeasonAfterDraft,firestore:rules,hosting:app \
  -m "Add asynchronous historical season replay"
```
