# RinkRat Data Infrastructure Batch D1H

**Candidate:** RC66 / D1H
**Purpose:** one exact canonical-read Canary with same-task verification, automatic direct-source fallback, and an automatic circuit breaker
**Competitive authority:** direct NHL scoring remains available in every D1H task and is selected automatically whenever canonical evidence is not an exact match
**Rollout scope:** one exact Internal Test league while queue mode is Canary
**Primary status:** globally locked while the authority experiment is active

## Why this batch is vital before the season

D1G proves canonical game facts beside the existing direct NHL scorer. The next risk is not whether the two calculations can match in a test. It is whether RinkRat can attempt the authority handoff without allowing one missing record, late final settlement, version race, or provider discrepancy to damage a live league.

D1H creates the smallest reversible cutover:

1. one already-proven Internal Test Canary may be selected;
2. the task still calculates the existing direct result;
3. canonical points may be selected only after the same task verifies an exact point and appearance match;
4. any mismatch, missing game, incomplete final settlement, or version misalignment selects the direct result;
5. that fallback automatically removes canonical authority for the league while leaving queued Canary scoring active;
6. a fresh shadow-parity run is required before an administrator can deliberately enable the experiment again.

This is not a broad public cutover. It is a season-safety proof that the new source can be introduced without removing the known-good source.

## Runtime decision

```text
Canonical-versioned queue task
        ↓
Load exact canonical NHL game/version set
        ↓
Calculate existing direct-source score
        ↓
Calculate canonical score for the same asset and game
        ↓
Exact points + exact appearance + exact task version?
        ├── Yes → publish verified canonical value
        └── No  → publish direct value
                    ↓
              open circuit breaker
                    ↓
       remove canonical authority automatically
                    ↓
       keep queued Canary scoring on direct data
```

The selected canonical value is numerically identical to the verified direct value. D1H therefore proves the authority-selection and rollback path without asking managers to absorb an unverified scoring difference.

## Activation gates

Canonical authority cannot be enabled in the same configuration change that creates or changes the Canary cohort. The exact league must already be:

- a completed live league;
- Historical Replay disabled;
- included in the current Canary allowlist;
- marked Internal Test;
- the only canonical-read league;
- backed by three consecutive current version-aligned perfect shadow-parity runs recorded after the current queue configuration and after any prior circuit-breaker event;
- at zero mismatch, zero incomplete, and zero canonical-missing comparisons;
- supported by at least three successful queued Canary tasks;
- free of a stale dispatcher, stale canonical feed, growing backlog, enqueue failure, or incomplete schedule coverage warning;
- changed only while the global queue is idle.

The platform administrator must type:

```text
ENABLE CANONICAL READ CANARY
```

## Automatic direct-source fallback

The current task always retains the direct result. Canonical authority is not allowed to guess, substitute zero, or wait indefinitely.

The direct result is selected when:

- the canonical task version is misaligned;
- a canonical game record is missing;
- a final player settlement is incomplete;
- points differ;
- appearance status differs.

The circuit breaker then:

- records the source version and bounded failure reason;
- records canonical uses and direct fallbacks;
- changes the authority state to `open`;
- removes the league from `canonicalAuthorityLeagueIds`;
- increments the audited queue-configuration revision;
- writes a server audit entry named `canonical-authority-circuit-opened`;
- leaves queue mode, the Canary allowlist, and the Internal Test label unchanged.

The league therefore continues through the queued scorer using direct NHL data. The circuit breaker does not pause scoring and does not return every league to legacy scoring.

## Control Center evidence

The Scoring Queue Control Center now shows:

- Direct NHL scoring authority, Verified canonical-read Canary, or Direct fallback active;
- the configured authority league;
- circuit state;
- last decision;
- cumulative canonical uses;
- cumulative direct fallbacks;
- last fallback reason;
- per-league eligibility and explanation;
- server audit records for enable, disable, and automatic circuit opening;
- a preseason safety signal that surfaces stale dispatcher/feed heartbeats, backlog age, schedule gaps, enqueue failures, recovery activity, parity gaps, and circuit-breaker events.

Primary remains blocked while the single-league authority experiment is active. D1H must be disabled before any global Primary decision.

## Season launch checklist

Do not begin the regular season with canonical authority enabled unless all of the following are true:

- the exact deployed source revision matches the tested release manifest;
- the full-season simulator and D1F.2 sixteen-scenario certification pass;
- the dispatcher heartbeat is newer than five minutes;
- completed-Draft schedule coverage is complete;
- enqueue failures and stale recoveries are zero or individually explained;
- queue backlog returns to zero after every normal burst;
- at least three current shadow-parity tasks pass for the exact league;
- mismatch, incomplete, and canonical-missing counts are zero;
- the first canonical-read task reports at least one verified canonical use and zero direct fallback;
- no duplicate score, snapshot, transaction, six-game ownership, Game 7, standings, or playoff result occurs;
- the Return to Shadow control and source rollback commands have been rehearsed.

For the initial season, use this progression:

```text
Shadow observation
→ one exact queued Canary
→ three clean shadow-parity tasks
→ one canonical-read Canary
→ one complete preseason game
→ one complete NHL night
→ three complete NHL nights
→ disable canonical authority or keep only that one proven league
```

Do not enable global Primary merely to save time before the season.

## Verification

Use the pinned toolchain:

```bash
nvm use 22.23.1
npm install -g npm@11.17.0

npm ci
npm --prefix functions ci

npm run test:documentation:run
npm run test:batchd1g:run
npm run test:batchd1h:run
npm run certify:preseason-scoring
npm run verify:batchd1h
npm run build:all
```

The D1H suite verifies:

- canonical selection only after an exact same-task match;
- direct fallback for mismatch, missing, incomplete, and misaligned evidence;
- automatic circuit opening and authority removal;
- one-league, Canary, Internal Test, parity, successful-task, and idle-queue gates;
- global Primary lock while the authority experiment is active;
- manager-visible authority and fallback state;
- unchanged Production Scoring V4, Projection V11, Firestore Rules, and indexes;
- synchronized documentation and roadmaps.

## Targeted deployment

Deploy the four changed Functions:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy \
  --only "functions:processLeagueAutomationTask,functions:getLeagueAutomationQueueControlCenter,functions:updateLeagueAutomationQueueConfig,functions:queueLeagueAutomationCanaryCheck" \
  --project nhl-fantasy-app-ab673 \
  -m "D1H season-safe canonical-read Canary and circuit breaker"
```

Deploy Hosting for the authority controls:

```bash
firebase deploy \
  --only hosting:app \
  --project nhl-fantasy-app-ab673 \
  -m "D1H canonical authority safety controls"
```

No Firestore Rule, index, TTL, or database migration deployment is required.

## Immediate rollback

The fastest broad rollback remains:

```text
Scoring Queue Control Center
→ Return to Shadow
→ confirm the rollback
```

For only the canonical-read experiment, clear the Verified canonical-read Canary selection and save. A circuit-breaker event already performs that narrower rollback automatically.

For source rollback, revert the D1H commit, run the D1G verification/build gate, and redeploy the reverted four Functions plus Hosting. Do not alter Production Scoring V4, Projection V11, Rules, indexes, TTL policies, App Check, or league data.

## What remains

D1H proves a reversible authority handoff while continuing to calculate direct data. A later optimization may stop repeated direct NHL reads for a proven league, but only after live D1H evidence shows:

- repeated canonical use;
- zero fallback and zero circuit events;
- final corrections remain exact;
- phase timing and cost improve as expected;
- the direct source remains available for immediate recovery.
