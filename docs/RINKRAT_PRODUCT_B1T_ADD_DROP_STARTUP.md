# Batch B1T — Add / Drop Startup and Roster-Read Recovery

## Scope

Batch B1T shortens the Add / Drop cold path and makes denied roster reads
recoverable without changing Projection V11, roster legality, waivers, or
competitive authority.

## Confirmed causes

1. The current projection pointer read and its live listener could race on a
   cold route. They used different cache keys, so both paths could download the
   same complete immutable Projection V11 chunk collection.
2. A league without a compatible current or Draft-pinned snapshot waited for
   the complete server generation job before the route left its top-level
   loading state.
3. `player-directory` recovery deliberately cleared the warm NHL stats and
   schedule caches used by the worker. Several new leagues prepared close
   together could therefore repeat the same upstream fact requests.
4. Available Players opens one roster stream per fantasy team. A denied stream
   used the roster service's generic console error path, had no bounded session
   recovery, and left ownership incomplete. The board could not truthfully
   distinguish free agents from rostered players in that state.

## Implemented behavior

- Projection chunk reads are keyed by the immutable active snapshot ID. The
  bounded current-pointer read and live-pointer listener now share the same
  in-flight request and 15-second read cache.
- The league shell, navigation, filters, and explicit loading state render as
  soon as the league is available. Projection loading and automatic recovery
  continue inside the player-directory state instead of blocking the route.
- Successful league creation queues a best-effort `player-directory` warm-up
  while the commissioner returns to Dashboard. Add / Drop still owns the same
  fallback if warm-up is unavailable.
- Only `player-directory` recovery reuses the worker's bounded NHL fact caches
  (5–15 minutes depending on the fact). Manual, Draft, cycle, and window
  generation retain their prior fresh-input behavior. Projection formulas,
  hashes, ranking, and snapshot sealing are unchanged.
- A permission-denied roster stream performs one forced Firebase credential
  refresh and recreates the bounded roster listeners once. A second failure is
  visible with a manual retry. The board fails closed and does not label any
  asset a free agent until every current team roster has returned either a
  roster or an explicit missing document.

## Deployment

Deploy the worker whose shared generation input policy changed, then Hosting:

```bash
firebase deploy --project nhl-fantasy-app-ab673 \
  --only functions:processProjectionGenerationTask

firebase deploy --project nhl-fantasy-app-ab673 --only hosting:app
```

No Rules, indexes, TTL, App Check, queue configuration, scoring worker, or
roster-authority deployment belongs to B1T.

## Rollback

Revert the B1T commit, deploy the preceding
`processProjectionGenerationTask` revision, and restore the preceding Hosting
release. Existing projections, rosters, transactions, and league documents
need no migration or data rollback.

## Protected contracts

Production Scoring V4 values, Projection V11 formulas/hashes/rankings,
six-game ownership, seventh-game rollover, immutable started windows, Draft
authority, roster/waiver/IR authority, Rules, indexes, TTLs, App Check mode,
queue limits, standings, playoffs, and canonical scoring authority are
unchanged.
