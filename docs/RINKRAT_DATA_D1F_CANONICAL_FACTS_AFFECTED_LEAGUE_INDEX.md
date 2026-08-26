# RinkRat Data Infrastructure Batch D1F

**Candidate:** RC66 / D1F
**Purpose:** TOI-aware canonical NHL game facts, affected-league targeting, and race-safe queued scoring requests
**Competitive authority:** Direct NHL scoring remains authoritative
**Rollout scope:** Exact Internal Test Canary leagues only

## Why this batch exists

D1D proved that an exact Internal Test league can use the existing per-league Cloud Tasks scorer on a faster cadence. It intentionally retained direct NHL reads and a conservative two-minute fallback.

D1F reduces the next major source of unnecessary work:

- one server process observes each live NHL game;
- boxscore and play-by-play data are normalized into compact canonical facts;
- fantasy events, time on ice, game state, and final settlement receive separate deterministic hashes;
- TOI-only movement is coalesced for up to five minutes rather than waking every league for every new shift;
- only leagues containing a player or Team Goalie Unit from the changed NHL game are requested;
- an incomplete impact index fails open to the bounded exact Canary cohort;
- the existing queued scorer remains the only fantasy-score publisher.

## Runtime flow

```text
NHL scoreboard
    ↓
One leased pollCanonicalNhlImpactFeed run
    ↓
Boxscore + play-by-play once per relevant NHL game
    ↓
Compact canonical game facts
    ↓
Separate SHA-256 hashes
    ├── fantasy events
    ├── time on ice
    ├── game state
    └── final settlement
    ↓
Server-owned player/team → Canary-league impact index
    ↓
Only affected exact Internal Test Canaries become due
    ↓
Existing deterministic Cloud Task
    ↓
Existing runLeagueAutomation() authority
```

## TOI policy

TOI remains part of the live score, but it is treated as provisional:

- a goal, assist-order change, shot, hit, block, plus/minus, goalie-stat, score, period, or final-state change signals immediately;
- ordinary clock countdown and brief clock-running/stoppage changes do not wake leagues;
- a TOI-only change becomes dirty without immediately creating another league task;
- dirty TOI settles no later than five minutes after the prior TOI settlement;
- any meaningful fantasy event also carries the latest TOI into the next score publication;
- final games settle the complete TOI immediately;
- final games remain eligible for bounded reconciliation for 30 minutes.

This preserves live score usefulness without treating every additional second of ice time as a reason to recalculate every affected league.

## Canonical records

### Game facts

```text
nhlCanonicalGameFacts/{gameId}
```

Each document contains:

- compact normalized skater, goalie, goal-event, game-state, and TOI facts;
- player IDs and the two participating NHL teams;
- raw-source, fantasy-event, TOI, game-state, final-settlement, and combined source hashes;
- current TOI dirty/settlement state;
- the most recent change classification;
- first-final observation and source-observation timestamps.

The payload is bounded to 650 KiB. Browser clients receive no direct access through this batch.

### Affected-league index

```text
leagueAutomationImpactIndex/{leagueId}
appData/leagueAutomationImpactIndex
```

For each exact Internal Test Canary, the server records:

- active-cycle or draft fallback player IDs;
- NHL team abbreviations for skaters and Team Goalie Units;
- source cycle numbers;
- a deterministic source hash;
- ready/fallback health evidence.

The D1F cohort remains capped by the existing four-league Canary safety limit. If one league index cannot be built, routing falls back to all exact Canaries rather than risking a missed score update.

### Feed health

```text
appData/nhlCanonicalImpactFeed
```

The health record includes:

- run status and lease;
- queue mode and exact Canary IDs;
- observed/signaled/failed game counts;
- requested and coalesced league counts;
- impact-index fallback evidence;
- TOI and final-reconciliation intervals;
- duration and consecutive failures.

## Lost-update protection

A canonical NHL version may arrive while an older league task is queued or processing.

D1F writes the newest source version onto the league schedule. Every newly enqueued task carries the version it is expected to satisfy. When a task completes:

- it marks the canonical request complete only when its version still matches the newest requested version;
- an older task cannot clear a newer request;
- a superseded task clears its own lease and makes the schedule immediately due for a post-version follow-up;
- canonical-change tasks bypass the ordinary time-based scoring guard but still use the existing server lease, idempotent scoring snapshots, and transaction protections.

The system intentionally accepts a conservative extra recalculation rather than risking a missing NHL update.

## Authority boundary

D1F does **not** allow canonical documents to calculate or publish fantasy points.

The existing direct-data path in `cycle-scoring.service.ts` still loads:

- NHL team schedules;
- GameCenter boxscores;
- GameCenter play-by-play;
- final player game logs where currently required.

The new feed may only request an eligible league schedule. It does not call `runLeagueAutomation()` directly and does not write cycle scores, matchups, standings, transactions, windows, or playoffs.

## Unchanged competitive contracts

D1F changes none of the following:

- Production Scoring V4 or retained legacy V3 reconstruction;
- Projection V11;
- immutable six-game player windows;
- seventh-game rollover;
- Draft, roster, waiver, IR, transaction, standings, or playoff authority;
- Firestore Rules;
- Firestore indexes;
- TTL policies;
- App Check mode;
- D1C shared-cache Shadow authority;
- automatic Primary promotion.

## Verification

```bash
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run test:documentation:run
npm run verify:batchd1f
npm run build:all
```

## Deployment

D1F is Functions-only when the cumulative D1D browser is already live:

```bash
firebase deploy \
  --only "functions:pollCanonicalNhlImpactFeed,functions:processLeagueAutomationTask,functions:dispatchDueLeagueAutomation,functions:queueLeagueAutomationCanaryCheck" \
  --project nhl-fantasy-app-ab673 \
  -m "D1F TOI-aware canonical facts and affected-league index Canary"
```

The targeted list contains:

- `pollCanonicalNhlImpactFeed` — new global observation and routing Function;
- `processLeagueAutomationTask` — version-aware task execution and completion handshake;
- `dispatchDueLeagueAutomation` — deploy the matching dispatcher source used to create version-carrying tasks;
- `queueLeagueAutomationCanaryCheck` — keep guarded manual Canary tasks on the same version-aware payload contract.

Do not deploy Rules, indexes, TTL, or every Function for this batch.

## Canary proof

Begin with one exact league that is both Canary and Internal Test. Verify:

1. the first observation establishes a baseline without duplicate scoring;
2. unchanged hashes create no league request;
3. TOI-only changes are deferred and then settle within the bounded interval;
4. meaningful game changes wake only impacted leagues;
5. missing index evidence falls back to the exact Canary set;
6. a newer source version arriving during an older task produces a follow-up;
7. points, six-game ownership, seventh-game rollover, transactions, standings, and playoffs remain correct;
8. leases clear and queue backlog returns to zero;
9. direct-source scoring remains authoritative;
10. no Primary cutover occurs during D1F.

Expand only after clean evidence:

```text
1 exact Internal Test league
→ at least 3 successful live changes
→ 1 complete NHL night
→ 3 complete NHL nights
→ second Internal Test league
→ maximum 4 during D1F
```

## Rollback

The fastest operational rollback is to return the scoring queue to Shadow. Existing tasks remain idempotent and may drain safely.

After reverting the Git commit, delete the new scheduled Function and redeploy the reverted queue worker and dispatcher:

```bash
firebase functions:delete pollCanonicalNhlImpactFeed \
  --region us-central1 \
  --project nhl-fantasy-app-ab673 \
  --force

firebase deploy \
  --only "functions:processLeagueAutomationTask,functions:dispatchDueLeagueAutomation,functions:queueLeagueAutomationCanaryCheck" \
  --project nhl-fantasy-app-ab673 \
  -m "Rollback D1F canonical facts and impact index"
```
