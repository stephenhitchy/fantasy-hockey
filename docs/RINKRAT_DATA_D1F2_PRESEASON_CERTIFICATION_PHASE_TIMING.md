# RinkRat Data Infrastructure Batch D1F.2

**Candidate:** RC66 / D1F.2
**Purpose:** preseason near-live scoring certification and bounded phase-duration evidence
**Competitive authority:** unchanged direct NHL scoring through `runLeagueAutomation()`
**Rollout state:** Shadow first, then one exact Internal Test Canary

## Why this batch exists

A ten-run historical replay sample completed near seven seconds nine times and near seventy seconds once. Total duration alone could not identify whether the outlier came from NHL schedules, boxscore/play-by-play retrieval, player game logs, scoring calculation, six-game window transitions, score publication, or follow-on competition progression.

D1F.2 adds server-owned phase timing and a deterministic preseason certification harness. It does not create another scoring engine and it does not publish fantasy points from fixtures.

## Phase timing

Each league-automation attempt may now record bounded duration for:

- lease and prerequisite checks;
- league and team loading;
- Cycle 1 bootstrap;
- historical replay data preparation;
- active-cycle discovery;
- pending roster-move reconciliation;
- roster-pick loading;
- previous-snapshot loading;
- NHL schedule loading;
- boxscore and play-by-play loading;
- final player-game-log settlement;
- fantasy scoring calculation;
- scoring-snapshot publication;
- window and competition persistence;
- post-transition cycle refresh;
- live-scoring control publication;
- queue and observability publication.

The saved evidence includes total duration, measured duration, unmeasured duration, the longest phase, and the longest-phase duration. It is written to existing server-owned control, schedule, task, historical replay, and privacy-limited daily evidence records.

## Preseason scoring certification

Run:

```bash
npm run certify:preseason-scoring
```

The deterministic report covers sixteen scenarios:

1. identical snapshot suppression;
2. ordinary clock-only suppression;
3. TOI-only deferral;
4. bounded TOI settlement;
5. shot change;
6. hit change;
7. blocked-shot change;
8. score change;
9. assist-order change;
10. period transition;
11. final settlement;
12. post-final correction;
13. affected-league targeting;
14. incomplete-index fail-open behavior;
15. duplicate source-version suppression;
16. newer-version follow-up requirement.

The harness calls the production canonical change-decision utility. It does not connect to production Firebase and it cannot alter a real score.

## Evidence locations

Existing server-owned documents receive bounded evidence such as:

```text
leagues/{leagueId}/liveScoring/control
leagueAutomationSchedules/{leagueId}
leagueAutomationTasks/{taskId}
historicalReplayRequests/{requestId}
leagues/{leagueId}/historicalReplay/control
betaOperationsDaily/{date-shard}
```

No raw manager identity, roster contents, fantasy score, invite code, email address, or raw NHL response is added to the daily phase aggregate.

## Safety contract

D1F.2 does not change:

- Production Scoring V4;
- legacy V3 reconstruction;
- Projection V11;
- six-game player-window ownership;
- seventh-game rollover;
- Draft, add/drop, waiver, IR, standings, or playoff authority;
- Firestore Rules;
- Firestore indexes;
- TTL policies;
- App Check mode;
- shared NHL cache authority;
- queue worker ceilings;
- the current Shadow/Canary/Primary setting.

No Firestore Rule, index, TTL, or data migration deployment is required. D1F.2 never automatically enables Primary.

## Verification

Use the pinned toolchain:

```bash
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run test:documentation:run
npm run certify:preseason-scoring
npm run test:batchd1f2:run
npm run verify:batchd1f2
npm run build:all
```

## Deployment

Deploy only the Functions whose source changed after the complete gate passes. Keep production in Shadow while validating phase evidence. Hosting, Firestore Rules, indexes, and TTL policies are outside this batch.

## Acceptance sequence

```text
Shadow evidence
→ one Internal Test Canary
→ at least three meaningful live changes
→ one complete preseason game
→ one complete NHL night
→ three complete NHL nights
→ second Internal Test Canary
```

Rollback immediately for any incorrect fantasy point, duplicated snapshot, duplicated transaction, incorrect six-game ownership, wrong seventh-game rollover, terminal queue failure, or growing unrecovered backlog.
