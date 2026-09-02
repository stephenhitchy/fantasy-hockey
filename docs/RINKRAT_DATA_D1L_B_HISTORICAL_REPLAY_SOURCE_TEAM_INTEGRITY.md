# RinkRat D1L-B Historical Replay Source-Team Integrity

**Purpose:** prevent historical replay from treating a source-season trade as missing final NHL data

**Implementation state:** feature-branch implementation and local verification only; not merged or deployed

**Competitive authority:** direct NHL scoring remains authoritative; this changes only historical replay input attribution

## Confirmed defect

Historical replay maps source-season NHL games onto target-season dates. The saved replay asset map already carried a source-team abbreviation for each mapped game, but scoring validated each final boxscore against the player's current NHL team instead.

For a player who changed teams, a valid source-season boxscore could therefore be classified as malformed. D1L-A correctly failed that game closed, so the replay showed zero current points and did not advance the game marker. A particularly dangerous edge occurred when the player's current team was the opponent in the source game: current-team validation could pass accidentally even though it was validating the wrong side.

This is a historical replay mapping defect. The investigation did not establish a Production Scoring V4 formula defect. Live scoring continues to use the asset's current NHL team because it does not supply replay mappings.

## Acceptance criteria

1. Every mapped replay game carries the exact source-season team for the corresponding skater segment.
2. Missed games between appearances retain the source team from the active trade segment.
3. A replay final cannot fall back to the current team when source-team evidence is absent or invalid.
4. Missing replay source-team evidence remains explicitly incomplete and retryable; it cannot become an authoritative zero.
5. A valid source-team nonappearance remains a complete, reusable zero.
6. A successful retry settles the game once and reuses the proven result on duplicate delivery.
7. Schema-1 replay maps rebuild automatically. Schema-2 maps are reusable only when asset key, asset type, player identity, current team, source season, game IDs, dates, and aligned source teams pass validation.
8. Rebuild and retry cannot duplicate points, completed game IDs, transactions, standings, playoff progression, six-game ownership, or Game 7 rollover.
9. Completed matchups are not automatically corrected.
10. Production Scoring V4 values, Projection V11, Rules, indexes, TTL, App Check, queue mode, worker limits, and canonical authority remain unchanged.

## Implemented behavior

The shared replay timeline builder now returns each source game together with its source-team abbreviation. Trade segments assign the same source team to both appearances and intervening missed team games. Historical replay asset maps advance to schema 2 and persist aligned arrays of source game IDs, game dates, and source teams.

The replay run context converts that evidence into an asset-and-game lookup and passes it through regular-season and playoff scoring. Final boxscore completeness validates a replay skater against that source team. If a replay game lacks a valid source-team entry, scoring records the final as temporarily unavailable and retries rather than consulting the current team.

The map normalizer rejects legacy schema, blank or malformed identity, invalid player/type combinations, invalid seasons, empty or overlong schedules, unequal array lengths, duplicate game IDs, invalid dates, and invalid team abbreviations. Rejected or identity-mismatched maps are rebuilt from the source player log and team schedules.

Live and non-replay scoring do not set the replay-only input and retain their existing current-team validation path.

## Edge cases and tests

Focused coverage proves:

- source-team identity across a two-team trade timeline, including missed games;
- schema-1, unequal-length, duplicate-ID, and invalid asset maps fail closed;
- a source OTT player currently on FLA settles against OTT even when FLA is the source-game opponent;
- an absent source-team lookup stays incomplete instead of accidentally validating FLA;
- retry changes the same incomplete game to one completed game and a duplicate retry performs no additional boxscore fetch or scoring;
- a proven source-team nonappearance settles to reusable zero;
- the replay source-team lookup reaches both regular-season and playoff scoring;
- the inherited D1L suite continues to cover Game 6/Game 7 ownership, transactions, standings, playoffs, and durable canonical exact-once behavior.

Run with Node.js 22.23.1 and npm 11.17.0:

```bash
npm ci
npm --prefix functions ci
node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batcha1d-replay-player-notes/*.test.mjs
npm run test:batchd1l
npm run verify:batchd1n-staging
npm run build:all
git diff --check
npm run release:verify-clean-deploy-source
```

The clean-source guard is expected to reject the uncommitted implementation. It must pass after the exact release candidate is committed and the tree is clean.

## Staging evidence gate

Before Production, use only the separate billed non-production project and a synthetic replay league:

1. Deploy the exact clean commit's `processHistoricalReplayAdvance` Function only.
2. Confirm the deployed Function revision completed successfully; a Hosting manifest alone does not prove Function source.
3. Seed or reset a synthetic traded skater with source-team appearances, missed games, a legitimate zero, and a six-to-seven boundary.
4. Advance one replay day and confirm schema-2 maps were written, incomplete games recovered, points and markers changed once, and Game 7 remained in the next window.
5. Repeat or redeliver the task and confirm points, window ownership, transactions, standings, and playoffs do not duplicate.
6. Inspect Function errors, retry counts, task age, Firestore write contention, and the saved `gameInputCompleteness` / `incompleteFinalGameIds` evidence.

Do not combine this proof with D1N-C load ramps. Correctness comes first; load testing remains a separate staging-only slice.

## Targeted release boundary

After the staging gate passes, the only Function whose behavior changes is:

```text
functions:processHistoricalReplayAdvance
```

Deploy that Function before Hosting. A targeted `hosting:app` deployment is then appropriate only to publish a live release manifest matching the exact clean commit; it contains no replay UI change. Do not deploy Rules, indexes, TTL policies, App Check, scoring queue configuration, worker limits, canonical authority, or any additional Function.

## Observability and rollback

Inspect replay request/control status, `historicalReplayAssets` schema and aligned source-team counts, cycle/window `gameInputCompleteness`, `incompleteFinalGameIds`, score totals, six-game markers, and worker logs. Compare the deployed Function revision separately from the Hosting release manifest.

Rollback by restoring the preceding verified `processHistoricalReplayAdvance` revision first, then restoring the preceding Hosting release only if the manifest was advanced with this release. Preserve replay controls, snapshots, asset maps, and request history for audit. Schema-2 maps are backward-compatible stored evidence; do not delete them. A prior worker will ignore the extra source-team metadata and can rebuild its older map format when needed.

## Not implemented

- automatic correction of an already completed matchup;
- the universal Final Score Reconciler;
- manager-facing correction controls;
- canonical Primary or Canary expansion;
- worker-concurrency or pending-task-limit changes;
- any Firebase deployment from this implementation branch.
