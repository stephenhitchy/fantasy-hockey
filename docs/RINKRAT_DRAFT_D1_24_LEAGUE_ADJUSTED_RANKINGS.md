# Draft Batch D1.24 — League-Adjusted Rankings and Auto-Draft Bench Depth

**Candidate:** RC65 / D1.24
**Competitive models:** Production Scoring V4, Projection V11, Draft Ranking V2

## Purpose

D1.24 removes the late-draft wall of Team Goalie Units without changing their
projected fantasy production. Raw Projection V11 remains independent of league
size. A separately versioned Draft Ranking V2 converts those projections into
league-specific draft value using the number of fantasy teams, fixed starting
requirements, expected bench demand, and replacement quality.

## League-adjusted demand

For each fantasy team, the ranking model expects:

```text
Starters: 3 LW, 3 C, 3 RW, 4 D, 1 Team Goalie Unit
Bench:    2 forwards, 1 defenseman, 0 Team Goalie Units
```

The two forward bench positions are assigned to the best remaining LW, C, or
RW projections instead of imposing an artificial exact-position split. The
first player or goalie unit outside the expected drafted count becomes that
position's replacement baseline.

The team count therefore changes the board deterministically. In a 10-team
league, ten Team Goalie Units retain starter demand and the 11th is the first
waiver replacement. In a 12-team league, units 11 and 12 regain starter demand.
Assets outside expected draft demand remain ordered, but are placed after the
17-round drafted pool so high raw projections cannot create a late positional
wall.

## Goalie-unit curve

Starter-demand goalie units blend projected talent, value above the first
waiver replacement, and their slot within the league's required starter count.
Once a goalie unit is outside that count, its raw projected points receive only
a small waiver-order weight. This preserves the order of available goalie
units while recognizing that Team Goalie Units cannot be injured and do not
need default bench coverage.

Projection V11 rate calculations, season projections, six-game projections,
snapshot hash schema and algorithm, and scoring values are not recalibrated.
New snapshot contents carry `draftRankingVersion: 2`; older ranking snapshots
are not reused as if they contained the new curve.

## Auto-Draft

Server-authoritative Auto-Draft continues to fill all starting slots before
the bench. Its three bench targets are now:

```text
2 forwards
1 defenseman
0 reserve Team Goalie Units
```

Queued goalie units are skipped after the starting goalie slot is filled.
Manual drafting remains unrestricted. The existing protection that prevents a
bench pick from consuming the last asset required for another manager's
starting slot remains in place.

The Draft Room also removes remaining Team Goalie Units from a manager's
default player pool immediately after that manager's first goalie-unit pick is
confirmed. This is presentation-only and manager-specific. The Goalie Units
position filter or the explicit `Show Extra Goalie Units` control restores
them for deliberate manual comparison or selection.

The live Draft order keeps the fantasy team name on completed selections as
well as upcoming picks. Its mobile cards provide more room for team names, and
each card opens that manager's roster in the existing Rosters panel. The panel
defaults to the signed-in manager and can switch among every Draft team using
the already-loaded team and pick data; it adds no Firestore read or listener.
On mobile, the player-card selection control identifies bench-bound choices,
and the wider confirmation action keeps `Draft to Bench` visible before the
manager commits the pick.

The Draft Room also shows the signed-in manager's exact number of picks until
their next snake-order turn. The compact count remains in the mobile command
bar. The experimental browser-generated turn sound and its controls were
removed after inconsistent mobile playback. The visual counter and on-clock
state remain the authoritative turn indicators.

When that transition occurs on mobile, the Draft Room returns an idle manager
to Available Players and scrolls the search control into view without stealing
keyboard focus. If the manager scouts a roster again while still on the clock,
the sticky clock exposes a `Players` recovery action that returns to the pool
and focuses search. An active pick submission or confirmation is never
interrupted.

The Draft Room keeps healthy background state quiet: the decorative medical
ticker is removed, and a confirmed connection no longer renders a banner or
mobile status label. Connecting, reconnecting, stale, and offline states still
surface the existing warning and retry controls. Injury preparation and its
server-owned readiness gates remain unchanged.

## Verification

Focused verification:

```bash
npm --prefix functions run build
npm run test:draft-authority:run
npm test -- --watch=false --include src/app/core/draft/auto-draft-strategy.spec.ts
npm test -- --watch=false --include src/app/features/draft/draft-room/draft-goalie-visibility.util.spec.ts
npm test -- --watch=false --include src/app/features/draft/draft-room/draft-roster-scouting.util.spec.ts
npm test -- --watch=false --include src/app/features/draft/draft-room/draft-mobile-selection.util.spec.ts
npm test -- --watch=false --include src/app/features/draft/draft-room/draft-turn-awareness.util.spec.ts
npm run test:batchb1l:run
```

The Draft Ranking V2 fixtures prove:

- 10-team demand produces 110 forward, 50 defense, and 10 goalie-unit values
  above replacement;
- all goalie units outside the 10 required starters fall below the 170-pick
  draft pool;
- increasing league size from eight to twelve promotes the ninth goalie unit
  from waiver depth to starter demand;
- Projection V11 fields are unchanged while the rank layer is versioned;
- browser and Functions ranking utilities remain byte-for-byte aligned;
- Auto-Draft produces two forward bench selections and one defense selection,
  and skips a queued reserve goalie unit;
- one manager's first goalie-unit pick hides only that manager's extra goalies
  by default while preserving explicit manual access.
- the snake-order counter handles ordinary picks and round-turn double picks;
- only a new live-turn transition triggers the mobile return to Available
  Players; the removed audio experiment has no remaining control or playback path.
- an idle manager returns to Available Players on a new turn, while an active
  pick confirmation is preserved and a sticky recovery action remains available.
- healthy injury and connection state add no passive notice, while degraded
  connection states retain visible recovery controls.

Current inherited release verification:

```bash
npm run verify:batchd1ncb
npm run build:all
git diff --check
npm run release:verify-clean-deploy-source
```

The clean-deploy-source check is expected only after commit because dirty
source must never be deployed.

## Targeted deployment

Stephen performs deployment manually. Deploy Functions before Hosting and do
not deploy during an active Draft:

```bash
firebase deploy \
  --only functions:requestProjectionSnapshotGeneration,functions:processProjectionGenerationTask,functions:recoverStaleProjectionGenerationRequests,functions:manageProjectionSnapshotIntegrity,functions:runScheduledDraftAutomation,functions:processDraftClockDeadline,functions:reconcileDraftTurnAfterCommittedPick,functions:continueServerDraftAutomation,functions:processAutoDraftQueueChange \
  --project=nhl-fantasy-app-ab673 \
  -m "D1.24 league-adjusted Draft Ranking V2 and Auto-Draft bench depth"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "D1.24 Draft Ranking V2 client compatibility"
```

After deployment, generate a fresh pre-Draft snapshot for each league that may
draft. The old Draft Ranking V1 snapshot is deliberately not considered fresh
under the new compatibility check.

No Firestore Rules, indexes, TTL policies, App Check setting, scoring queue
mode, worker limit, or production data migration belongs in this release.

## Rollback

Redeploy the previous approved revisions of the nine listed Functions and
Hosting. The previous code accepts Projection V11 snapshots without the new
ranking-version requirement. If a Draft has not started, restore or regenerate
the prior verified Projection V11 snapshot before reopening the room. No
scoring, roster, matchup, standings, transaction, Rules, index, TTL, or queue
rollback is required.
