# RinkRat Data D1L-C: Live Player Team Identity

## Problem

Live scoring previously chose every skater's NHL schedule from the mutable team
abbreviation copied into the Draft or roster asset. That copy was never updated
when the same stable NHL player id moved to another club. A traded skater could
therefore remain attached to the former club's six-game window.

This was not only a presentation defect. When the former club's game became
final, the NHL box score correctly omitted the traded skater and the player game
log correctly omitted that game. Those two facts looked like a valid
nonappearance, so the direct scorer could settle the former-club game as a
counted zero.

Matthew Knies (NHL player id `8482720`) exposed the issue on 2026-09-29. The
official current roster source placed that stable id on Columbus while the
stored RinkRat asset and active window still named Toronto.

## Authority and cache

`nhl-player-team-identity.service.ts` builds one server-owned, project-wide map
from the same approved NHL current-roster endpoints already used by Projection
V11's identity catalog. The map is keyed only by stable NHL player id and stores
the current NHL team abbreviation.

- The shared Firestore document is `appData/nhlPlayerTeamIdentity`.
- A complete snapshot must contain at least 300 unique supported skaters.
- Duplicate player ids assigned to different clubs reject the refresh.
- The aggregate source is fresh for five minutes.
- A Firestore lease prevents the four scoring workers from rebuilding it at the
  same time.
- Waiting workers make a bounded read-only wait for the claimed refresh.
- An active skater omitted from the NHL club-roster response can be recovered
  from that stable id's NHL player-landing response. Exact fallbacks are limited
  to 32 ids per refresh and loaded in paced batches of four.
- A fresh aggregate with missing coverage is supplemented without repeating the
  full 32-club read. Its original aggregate evidence timestamp is retained so
  the supplement cannot masquerade as a post-puck-drop refresh for other
  players.
- A stale aggregate or a puck-drop evidence boundary still requires a complete
  club refresh before exact player evidence is merged.
- If no complete fresh identity map is available, the scoring task fails and
  retains the last published scoring snapshot. It never falls back to settling
  an old-team absence as zero.
- Historical replay bypasses the live identity map and continues to use its
  source-season player/team timeline.

The NHL responses continue to flow through the existing retry, in-process
deduplication, and Shadow shared-cache observation path. This change does not
promote the Shadow NHL cache to scoring authority.

League automation waits until the exact active-cycle and playoff-bank skater
ids are known before requesting identity. It no longer performs an unscoped
identity refresh before roster picks are loaded.

Schedule loading also fails immediately with the affected club and original
provider cause when any requested team schedule is unavailable. A rejected NHL
request is never converted into a misleading frozen-game-missing diagnosis.
The server-scoring source checksum advances only for this fail-closed diagnostic
path; the shared Scoring V4 formulas and six-game selection utility remain
byte-for-byte unchanged.

## Six-game ownership policy

The live scorer now resolves a skater's current club from stable NHL player id
before selecting the schedule.

1. A completed six-game window is immutable.
2. Every finalized game already owned by an active window remains owned.
3. A live game where the skater has already appeared remains owned, even if the
   official roster changes during that game.
4. Unsettled former-club games are removed after a confirmed team change.
5. The remaining positions are filled, in order, from the new club's live and
   upcoming regular-season games.
6. Once that replacement window is published, its exact game ids remain fixed
   on retries and later refreshes.
7. A later second trade applies the same rule: completed/appeared games remain,
   while only the unsettled remainder follows the newest official club.

Each saved window now records `scheduleTeamAbbreviation` and a per-game
`sourceTeamAbbreviationByGameId`. The latter keeps opponent labels and final
box-score validation correct when one window legitimately contains games from
both the former and current club.

## Presentation

The Dashboard NHL-team grouping uses the saved window's resolved schedule team
when present. The player Game Film header also displays the resolved current
club and official club logo. Old documents remain compatible and fall back to
the roster asset's stored team abbreviation until the next server scoring pass.

Roster transactions are not an identity repair mechanism and are no longer
required to make a traded player's current-club games count.

## Protected contracts

This change does not alter Scoring V4 point values, Projection V11 formulas or
hashes, seventh-game rollover, finalized game ownership, roster/waiver/IR
authority, Firestore Rules, indexes, TTLs, App Check, canonical scoring mode, or
the scoring queue mode. It changes only which NHL team schedule owns an active
skater's still-unsettled window positions after server-confirmed team identity
changes.

## Deployment and rollback

The 2026-10-05 identity-coverage recovery requires the five live scoring
entrypoints plus both roster-action entrypoints that share the same identity
authority:

```bash
firebase deploy --project nhl-fantasy-app-ab673 \
  --only "functions:processLeagueAutomationTask,functions:runScheduledLeagueAutomation,functions:runSeasonStartAutomation,functions:initializeSeasonAfterDraft,functions:requestLeagueLiveScoringRefresh,functions:applyImmediateRosterMove,functions:executeSecureRosterAction"
```

The original D1L-C presentation also requires Hosting when it is not already
live:

```bash
firebase deploy --project nhl-fantasy-app-ab673 \
  --only hosting:app
```

No Hosting file changed in the 2026-10-05 recovery, so a new Hosting deployment
is not required for that repair. Do not deploy only Hosting for the full D1L-C
feature; that would change labels only after data exists and would not repair
scoring authority. No migration or production data rewrite is required. The
first live scoring task after deployment supplements the shared identity
document and republishes affected active windows.

Rollback is the prior clean source commit followed by the same targeted
Function selectors, plus Hosting only if Hosting was part of the release.
Existing identity documents and the additive window fields can remain in
Firestore; older code ignores them. Do not delete or rewrite completed windows.

## Verification

Focused verification is:

```bash
npm run test:batchd1lc:run
```

The release gate is:

```bash
npm run verify:batchd1lc
npm run build:all
git diff --check
npm run release:verify-clean-deploy-source
```

The focused suite covers zero-game remapping, partial windows, already-remapped
stability, completed-window immutability, stable-id live scoring, replay
isolation, fresh and stale exact-player fallback, bounded negative coverage,
fail-closed catalog behavior, schedule-provider error preservation, and the
Dashboard/Game Film display overlay.
