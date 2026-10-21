# Operations B2H — Legacy Scoring Skip Observation

## Purpose

The ten-minute legacy scoring sweep remains the proven Production scoring path
while the league queue is in Shadow. It is also the largest measured Functions
compute consumer. B2H adds observation evidence before considering any cost-
saving skip behavior.

This slice does **not** skip another league, change the schedule, change queue
mode, or replace the existing scoring lease. Every league selected by
`runScheduledLeagueAutomation` still reaches `runLeagueAutomation` exactly as
before.

## Conservative decision boundary

The observer classifies only the existing saved-state lease outcome. A league
is marked eligible only when the unchanged lease path already returned
`not-due` and supplied a valid saved `nextRefreshAt` later than the start of the
sweep. That classification describes a possible future pre-lease optimization;
it does not authorize one.

All other cases fail open and keep full scoring:

- a missing or stale refresh boundary;
- Historical Replay ownership;
- another active scoring worker;
- an unknown skip reason;
- any failed run;
- a run that published a snapshot or created/advanced a competition period;
  and
- a successful no-publication run without a durable pre-run NHL source/version
  proof.

The last case is intentional. Hindsight that a scoring run published nothing
cannot prove that the same run was safe to omit. A later enforcement design
must supply pre-run source evidence, pending-transaction evidence, final and
post-final reconciliation coverage, and a bounded full-recovery path before a
due league may be skipped.

## Evidence

The existing `appData/leagueAutomation` health document receives one bounded
`legacySkipObservation` map per sweep. It contains:

- schema and explicit `observe-only` mode;
- `enforcementEnabled: false`;
- analyzed, eligible, and ineligible league counts;
- completed deep-scoring and no-publication counts;
- failed-run count; and
- a fixed-key reason-count map.

The Function emits the same fixed aggregate summary once per sweep. It does
not log per-league candidate IDs, create per-league evidence documents, add a
listener, or perform another Firestore read.

## Verification

Run the focused test directly while B2H is being assembled:

```bash
node --no-warnings --experimental-strip-types --test --test-concurrency=1 \
  test/batchb2h-cost-hardening/scoring-shadow-observation.test.mjs
```

Then run the inherited B2H gate and full build before release:

```bash
npm run verify:batchb2h
npm run build:all
git diff --check
npm run release:verify-clean-deploy-source
```

The clean-source guard is expected to pass only from the reviewed committed
candidate.

## Deployment and rollback

If this Functions-only observation slice is released, the exact selector is:

```bash
firebase deploy \
  --only "functions:runScheduledLeagueAutomation" \
  --project nhl-fantasy-app-ab673
```

Stephen performs deployment manually. Roll back by targeted redeployment of
the preceding approved `runScheduledLeagueAutomation` revision. The nested
observation map is operational evidence only and may remain in Firestore; the
older Function will ignore it.

Production Scoring V4 values, Projection V11 formulas and hashes, six-game
ownership, Game 7 rollover, immutable started windows, Draft/roster/waiver/IR
authority, standings, playoffs, Rules, indexes, TTLs, App Check, canonical
authority, queue mode, worker limits, and scheduler cadence are unchanged.
