# RinkRat Data Batch D1D — Near-Live Scoring Canary

**Release family:** unfrozen RC66 successor candidate built on B1K.1
**Competitive models:** Production Scoring V4 · Projection V11
**Deployment scope:** targeted Functions plus Hosting
**Production-wide near-live scoring:** disabled

## Purpose

D1D is the first deliberately bounded step toward healthier near-live scoring. It does not shorten the legacy scorer for every league and it does not make the shared NHL Shadow cache authoritative. Instead, it lets a deliberately small cohort of exact internal Canaries use the existing idempotent per-league Cloud Tasks worker with a two-minute live-game target. The server and control center cap that measured cohort at four leagues, and the live proof procedure begins with one.

This provides real evidence about:

- manager-visible score freshness;
- per-league scoring duration;
- task queue age and retries;
- NHL request behavior;
- Firestore reads/writes and contention;
- cost per near-live league-hour;
- whether the queue returns to zero between bursts.

Every ordinary league remains on the proven standard cadence until the evidence supports a broader architecture.

## Included Training Camp wording refinement

The opening six-game lesson now uses player-first language consistently:

- **Six games for every active player**;
- **One active player. Six NHL games.**;
- **Each active player gets six NHL games**;
- Player A and Player B in the visual example.

The lesson also states that the Team Goalie Unit follows the same six-game rule. This is a wording-only improvement; the underlying independent roster-slot authority remains unchanged.

## Exact scoring behavior

### Shadow

- Queue Shadow remains observation-only.
- Every live league continues to use the legacy ten-minute scorer.
- No league receives the D1D cadence.

### Canary

Only a league that satisfies all four conditions receives the D1D cadence:

1. the scoring queue mode is `canary`;
2. the exact league ID is in the server-owned Canary allowlist; and
3. that same exact league is marked `Internal Test` in the server-owned configuration; and
4. the complete near-live Canary cohort contains no more than four leagues.

The server caps the D1D near-live cohort at **four** exact Internal Test leagues. A larger Canary configuration is rejected, and the cadence selector fails back to standard if an older or malformed configuration exceeds that cap.

For that exact league:

- the same `processLeagueAutomationTask` worker remains authoritative;
- a live NHL game or a completed window transition schedules the next check for two minutes later;
- no-live-game idle timing remains unchanged;
- next-game wake-up timing remains bounded by the existing schedule logic;
- scoring fingerprints, leases, task IDs, snapshots, transactions, standings, and window boundaries remain idempotent.

Every non-allowlisted friend league remains on legacy scoring. A malformed or older configuration containing more than four Canary IDs fails closed to the standard cadence.

### Primary

Primary remains on the standard cadence in D1D. Enabling the queue for every league must not silently multiply scoring frequency before shared NHL ingestion, staged load tests, and cost measurements are complete.


## Exact-Canary NHL freshness profile

The standard NHL request cache remains unchanged for every ordinary path:

```text
team schedule: 10 minutes
live boxscore/play-by-play: 2 minutes
```

Only an exact internal near-live Canary asks the existing process-local request coalescer for a fresher profile:

```text
team schedule: 30 seconds
live boxscore/play-by-play: 15 seconds
```

That does not mean those endpoints are polled every 15 or 30 seconds. The league worker still runs on the guarded two-minute target, and the in-flight request map still coalesces identical requests inside one Function instance. Final games already preserved in the prior scoring snapshot remain reusable and are not re-downloaded on every pass.

The reduced cache windows are intentionally limited to internal Canary evidence. They are not the final public-scale solution; shared server-owned NHL ingestion must replace per-instance freshness before near-live cadence expands broadly.

## Why this is safer than changing the ten-minute sweep to every minute

A faster global sweep would repeatedly scan and score many leagues together, including leagues whose NHL data did not change. D1D instead limits increased frequency to exact internal test leagues already protected by:

- deterministic Cloud Task identities;
- a per-league automation lease;
- idempotent scoring fingerprints;
- bounded four-task concurrency;
- a 24-task global pending/processing ceiling;
- stale-task recovery;
- one-click return to Shadow.

D1D does not claim to be the final high-scale architecture. The later target remains centralized NHL change ingestion followed by coalesced tasks only for affected leagues.

## Manager and administrator visibility

The Scoring Queue Control Center now shows:

- **Near-Live Canary** for the exact queued test path;
- a **2-minute live target** cadence label;
- the server-owned Canary interval and four-league cohort ceiling;
- the last cadence and delay recorded by each league schedule;
- explicit language that Primary remains standard.

This prevents a platform administrator from mistaking Canary proof for a production-wide live-scoring activation.

## Files changed

Runtime:

- `functions/src/shared/core/live-scoring/live-scoring-cadence.util.ts`
- `functions/src/league-automation.ts`
- `functions/src/shared/core/cycle/cycle-scoring.service.ts`
- `functions/src/shared/core/nhl/nhl-api.service.ts`
- `src/app/core/admin/scoring-queue-control.service.ts`
- `src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.ts`
- `src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.html`
- `src/app/features/onboarding/training-camp/training-camp.data.ts`
- `src/app/features/onboarding/training-camp/training-camp.html`

Verification and documentation:

- `test/batchd1d-near-live-scoring-canary/near-live-scoring-canary.test.mjs`
- `test/batchb1i-progressive-training-camp/progressive-training-camp.test.mjs`
- `package.json`
- `README.md`
- both synchronized competitive roadmaps;
- this release note;
- scoring queue rollout and consolidated project documentation.

## Protected systems unchanged

D1D does not change:

- Production Scoring V4 values;
- legacy V3 reconstruction;
- Projection V11 calculations or hashes;
- roster construction or eligibility;
- six-game window ownership;
- seventh-game rollover;
- Draft, roster, waiver, IR, transaction, standings, or playoff authority;
- Firestore Rules;
- Firestore indexes;
- TTL policies;
- App Check mode;
- queue concurrency or pending-task ceilings;
- shared NHL cache Shadow status;
- shared NHL authoritative reads.

## Verification

Use the pinned toolchain:

```bash
nvm use 22.23.1
npm install -g npm@11.17.0

npm ci
npm --prefix functions ci

npm run test:documentation:run
npm run verify:batchd1d
npm run build:all
```

The focused D1D test proves:

- player-first Training Camp copy;
- exact allowlist plus Internal Test Canary selection and the four-league fail-closed ceiling;
- standard and near-live NHL cache profiles without changing ordinary callers;
- two-minute live Canary timing;
- unchanged ten-minute standard timing;
- unchanged idle timing;
- unchanged legacy sweep and queue concurrency;
- no broad near-live Primary control;
- synchronized roadmap and release documentation;
- protected scoring, projection, Rules, and shared-cache policy hashes.

## Targeted deployment

Deploy the task worker and server snapshot first, then Hosting:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy --only "functions:processLeagueAutomationTask,functions:dispatchDueLeagueAutomation,functions:getLeagueAutomationQueueControlCenter,functions:updateLeagueAutomationQueueConfig,functions:queueLeagueAutomationCanaryCheck,functions:requestLeagueLiveScoringRefresh" \
  -m "D1D near-live scoring Canary"

firebase deploy --only hosting:app \
  -m "D1D near-live Canary controls and Training Camp wording"
```

No Firestore Rule, index, TTL, or data migration deployment is required.

## Live proof procedure

1. Keep Production in Shadow immediately after deployment.
2. Confirm the dispatcher, schedule coverage, failures, and stale recovery are healthy.
3. Use one completed-draft internal live league with Historical Replay disabled.
4. Mark it **Internal Test** and **Route Through Canary**.
5. Switch to Canary with the existing guarded confirmation.
6. Use **Run Canary Now** once.
7. During a real live NHL game, verify the league schedule reports `near-live-canary` and a two-minute delay.
8. Observe at least three clean tasks, then continue through several NHL scoring changes.
9. Verify no duplicate points, snapshots, transactions, windows, or standings results.
10. Verify the backlog returns to zero and the legacy recovery sweep does not routinely rescue the Canary.
11. Return to Shadow immediately for any integrity error, repeated retry, growing backlog, upstream pressure, or unexpected cost.

## Rollback

The fastest operational rollback is **Return to Shadow** in the Scoring Queue Control Center. Already-created tasks remain safe to drain because they retain deterministic IDs, leases, and scoring fingerprints.

For a source rollback, revert the D1D commit and redeploy:

```bash
firebase deploy --only "functions:processLeagueAutomationTask,functions:dispatchDueLeagueAutomation,functions:getLeagueAutomationQueueControlCenter,functions:updateLeagueAutomationQueueConfig,functions:queueLeagueAutomationCanaryCheck,functions:requestLeagueLiveScoringRefresh" \
  -m "Rollback D1D near-live scoring Canary"

firebase deploy --only hosting:app \
  -m "Rollback D1D near-live Canary controls"
```

Do not alter scoring data, roster-window documents, Rules, indexes, TTL policies, or shared-cache authority during rollback.

## Next architecture gate

D1D is evidence gathering, not the final broad-scale design. The next healthy scoring infrastructure batch should:

1. fetch each live NHL game update once through shared server-owned ingestion;
2. compare validated content hashes and source timestamps;
3. identify changed games rather than polling every league blindly;
4. coalesce rapid changes into one task per affected league;
5. preserve a finalization and stat-correction pass;
6. stage at 100, 500, 2,000, and 5,000 clients before any public near-live Primary mode.
