import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildCanonicalNhlGameFacts,
  buildCanonicalNhlGameHashes,
  CANONICAL_NHL_FINAL_RECONCILIATION_MILLISECONDS,
  CANONICAL_NHL_TOI_SETTLEMENT_INTERVAL_MILLISECONDS,
  decideCanonicalNhlGameChange,
  parseNhlTimeOnIceSeconds,
} from '../../functions/src/shared/core/nhl/nhl-canonical-facts.util.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const sha256 = async (relativePath) => createHash('sha256')
  .update(await readFile(new URL(relativePath, ROOT)))
  .digest('hex');

function gameInput({
  toi = '12:30',
  assist1PlayerId = 101,
  assist2PlayerId = 102,
  gameState = 'LIVE',
  clockTimeRemaining = '08:15',
  clockRunning = true,
} = {}) {
  return {
    scoreboard: {
      gameId: 2026020001,
      gameState,
      gameScheduleState: 'OK',
      period: gameState === 'FINAL' ? 3 : 2,
      periodType: 'REG',
      clockTimeRemaining: gameState === 'FINAL' ? '00:00' : clockTimeRemaining,
      clockRunning: gameState === 'FINAL' ? false : clockRunning,
      inIntermission: false,
      gameDate: '2026-10-10',
      startTimeUTC: '2026-10-11T00:00:00Z',
    },
    boxscore: {
      homeTeam: { abbrev: 'MIN', score: 2 },
      awayTeam: { abbrev: 'WPG', score: 1 },
      playerByGameStats: {
        homeTeam: {
          forwards: [{
            playerId: 101,
            name: { default: 'Home Skater' },
            position: 'C',
            goals: 1,
            assists: 0,
            points: 1,
            plusMinus: 1,
            hits: 2,
            powerPlayGoals: 0,
            sog: 3,
            toi,
            blockedShots: 1,
          }],
          defense: [],
          goalies: [{
            playerId: 201,
            name: { default: 'Home Goalie' },
            position: 'G',
            goalsAgainst: 1,
            toi: '40:00',
            starter: true,
            decision: '',
            shotsAgainst: 22,
            saves: 21,
          }],
        },
        awayTeam: {
          forwards: [{
            playerId: 102,
            name: { default: 'Away Skater' },
            position: 'LW',
            goals: 0,
            assists: 1,
            points: 1,
            plusMinus: -1,
            hits: 1,
            powerPlayGoals: 0,
            sog: 2,
            toi: '11:00',
            blockedShots: 0,
          }],
          defense: [],
          goalies: [{
            playerId: 202,
            name: { default: 'Away Goalie' },
            position: 'G',
            goalsAgainst: 2,
            toi: '40:00',
            starter: true,
            decision: '',
            shotsAgainst: 24,
            saves: 22,
          }],
        },
      },
    },
    playByPlay: {
      plays: [{
        eventId: 45,
        typeDescKey: 'goal',
        periodDescriptor: { number: 2, periodType: 'REG' },
        timeInPeriod: '07:00',
        details: {
          scoringPlayerId: 101,
          assist1PlayerId,
          assist2PlayerId,
          situationCode: '1551',
          homeScore: 2,
          awayScore: 1,
        },
      }],
    },
  };
}

test('TOI parser preserves seconds and rejects malformed values', () => {
  assert.equal(parseNhlTimeOnIceSeconds('12:30'), 750);
  assert.equal(parseNhlTimeOnIceSeconds('00:59'), 59);
  assert.equal(parseNhlTimeOnIceSeconds('12:99'), 0);
  assert.equal(parseNhlTimeOnIceSeconds(undefined), 0);
});

test('canonical hashes separate TOI churn from fantasy events and assist order', () => {
  const first = buildCanonicalNhlGameHashes(
    buildCanonicalNhlGameFacts(gameInput({ toi: '12:30' })),
  );
  const toiOnly = buildCanonicalNhlGameHashes(
    buildCanonicalNhlGameFacts(gameInput({ toi: '13:30' })),
  );
  const assistOrderChanged = buildCanonicalNhlGameHashes(
    buildCanonicalNhlGameFacts(gameInput({
      toi: '13:30',
      assist1PlayerId: 102,
      assist2PlayerId: 101,
    })),
  );

  assert.equal(first.fantasyEventHash, toiOnly.fantasyEventHash);
  assert.notEqual(first.timeOnIceHash, toiOnly.timeOnIceHash);
  assert.notEqual(first.finalSettlementHash, toiOnly.finalSettlementHash);
  assert.notEqual(toiOnly.fantasyEventHash, assistOrderChanged.fantasyEventHash);
});

test('ordinary clock countdown does not create an immediate scoring change', () => {
  const previous = buildCanonicalNhlGameHashes(
    buildCanonicalNhlGameFacts(gameInput({ clockTimeRemaining: '08:15' })),
  );
  const current = buildCanonicalNhlGameHashes(
    buildCanonicalNhlGameFacts(gameInput({ clockTimeRemaining: '06:15' })),
  );
  const decision = decideCanonicalNhlGameChange({
    previous: {
      fantasyEventHash: previous.fantasyEventHash,
      timeOnIceHash: previous.timeOnIceHash,
      lastSignaledTimeOnIceHash: previous.timeOnIceHash,
      gameStateHash: previous.gameStateHash,
      finalSettlementHash: previous.finalSettlementHash,
      lastTimeOnIceSettledAtMilliseconds: 1_000_000,
    },
    current,
    currentGameState: 'live',
    nowMilliseconds: 1_120_000,
  });

  assert.equal(previous.gameStateHash, current.gameStateHash);
  assert.equal(decision.kind, 'unchanged');
  assert.equal(decision.shouldSignal, false);
});

test('TOI-only movement is deferred and then settled on a bounded heartbeat', () => {
  const previousFacts = buildCanonicalNhlGameFacts(gameInput({ toi: '12:30' }));
  const previous = buildCanonicalNhlGameHashes(previousFacts);
  const current = buildCanonicalNhlGameHashes(
    buildCanonicalNhlGameFacts(gameInput({ toi: '13:30' })),
  );
  const baseTime = 1_000_000;
  const previousState = {
    fantasyEventHash: previous.fantasyEventHash,
    timeOnIceHash: previous.timeOnIceHash,
    lastSignaledTimeOnIceHash: previous.timeOnIceHash,
    gameStateHash: previous.gameStateHash,
    finalSettlementHash: previous.finalSettlementHash,
    lastTimeOnIceSettledAtMilliseconds: baseTime,
  };

  const deferred = decideCanonicalNhlGameChange({
    previous: previousState,
    current,
    currentGameState: 'live',
    nowMilliseconds: baseTime + 2 * 60 * 1000,
  });
  const settled = decideCanonicalNhlGameChange({
    previous: previousState,
    current,
    currentGameState: 'live',
    nowMilliseconds:
      baseTime + CANONICAL_NHL_TOI_SETTLEMENT_INTERVAL_MILLISECONDS,
  });

  assert.equal(deferred.kind, 'toi-deferred');
  assert.equal(deferred.shouldSignal, false);
  assert.equal(deferred.timeOnIceDirty, true);
  assert.equal(settled.kind, 'toi-settlement');
  assert.equal(settled.shouldSignal, true);
});

test('final settlement and meaningful fantasy changes signal immediately', () => {
  const previousFacts = buildCanonicalNhlGameFacts(gameInput({ toi: '12:30' }));
  const previous = buildCanonicalNhlGameHashes(previousFacts);
  const final = buildCanonicalNhlGameHashes(
    buildCanonicalNhlGameFacts(gameInput({ toi: '20:00', gameState: 'FINAL' })),
  );
  const decision = decideCanonicalNhlGameChange({
    previous: {
      fantasyEventHash: previous.fantasyEventHash,
      timeOnIceHash: previous.timeOnIceHash,
      lastSignaledTimeOnIceHash: previous.timeOnIceHash,
      gameStateHash: previous.gameStateHash,
      finalSettlementHash: previous.finalSettlementHash,
      lastTimeOnIceSettledAtMilliseconds: 0,
    },
    current: final,
    currentGameState: 'final',
    nowMilliseconds: 10_000,
  });

  assert.equal(decision.kind, 'final-settlement');
  assert.equal(decision.shouldSignal, true);
  assert.equal(
    CANONICAL_NHL_FINAL_RECONCILIATION_MILLISECONDS,
    30 * 60 * 1000,
  );
});

test('the feed is one leased global poll with exact Internal Test Canary targeting', async () => {
  const source = await read('functions/src/nhl-canonical-impact-feed.ts');

  assert.match(source, /schedule: 'every 2 minutes'/);
  assert.match(source, /maxInstances: 1/);
  assert.match(source, /claimFeedLease/);
  assert.match(source, /getLeagueAutomationCanonicalCanaryScope/);
  assert.match(source, /buildCanaryImpactIndex/);
  assert.match(source, /impactIndexComplete/);
  assert.match(source, /return \[\.\.\.input\.exactCanaryLeagueIds\]/);
  assert.match(source, /requestLeagueAutomationForCanonicalChange/);
  assert.doesNotMatch(source, /runLeagueAutomation\(/);
  assert.match(source, /getGameBoxscore\(input\.game\.id, 'near-live-canary'\)/);
  assert.match(source, /getGamePlayByPlay\(input\.game\.id, 'near-live-canary'\)/);
});

test('the impact index records both player and NHL-team ownership', async () => {
  const source = await read('functions/src/nhl-canonical-impact-feed.ts');

  assert.match(source, /leagueAutomationImpactIndex/);
  assert.match(source, /playerIds/);
  assert.match(source, /teamAbbreviations/);
  assert.match(source, /sourceCycleNumbers/);
  assert.match(source, /pick\.asset\.player\.nhlTeamAbbreviation/);
  assert.match(source, /pick\.asset\.teamAbbreviation/);
  assert.match(source, /failedLeagueIds/);
  assert.match(source, /status: failedLeagueIds\.length === 0 \? 'ready' : 'fallback'/);
});

test('canonical source versions cannot be lost behind an older in-flight task', async () => {
  const source = await read('functions/src/league-automation.ts');

  assert.match(source, /canonicalRequestedSourceVersion/);
  assert.match(source, /activeTaskCanonicalSourceVersion/);
  assert.match(source, /canonicalNeedsFollowUp/);
  assert.match(source, /canonicalRequestStatus.*'pending-follow-up'/s);
  assert.match(source, /canonicalCompletedSourceVersion/);
  assert.match(
    source,
    /canonicalRequestedSourceVersion'.*FieldValue\.delete\(\)/s,
  );
  assert.match(source, /payload\.reason === 'canary-manual' \|\|[\s\S]*Boolean\(payloadCanonicalSourceVersion\)/);
  assert.match(source, /taskCanonicalSourceVersion !== latestCanonicalSourceVersion/);
  assert.match(source, /nextScoringAt.*Timestamp\.fromMillis\(Date\.now\(\)\)/s);
  assert.match(
    source,
    /const schedule: DueLeagueAutomationSchedule = \{[\s\S]*canonicalSourceVersion: ''[\s\S]*canonicalRequestedAtMilliseconds: 0[\s\S]*\};/,
  );
});

test('direct NHL scoring remains authoritative during D1F', async () => {
  const [scoring, feed, policy] = await Promise.all([
    read('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
    read('functions/src/nhl-canonical-impact-feed.ts'),
    read('config/nhl-shared-cache-policy.json'),
  ]);
  const cachePolicy = JSON.parse(policy);

  assert.match(scoring, /getGameBoxscore\(gameId, refreshProfile\)/);
  assert.match(scoring, /getGamePlayByPlay\(gameId, refreshProfile\)/);
  assert.match(scoring, /getRegularSeasonGameLog/);
  assert.doesNotMatch(scoring, /nhlCanonicalGameFacts/);
  assert.doesNotMatch(feed, /updateCycleMatchupScores|completeCycle|startNextCycle/);
  assert.equal(cachePolicy.mode, 'shadow');
  assert.equal(cachePolicy.authoritativeReadsEnabled, false);
});

test('D1F preserves competitive formulas, Projection V11, and Firestore Rules', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    PROTECTED_SOURCE_HASHES.scoringRules,
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    PROTECTED_SOURCE_HASHES.scoringEngine,
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    PROTECTED_SOURCE_HASHES.projectionV11,
  );
  assert.equal(
    await sha256('firestore.rules'),
    PROTECTED_SOURCE_HASHES.firestoreRules,
  );
});

test('D1F release scripts and documentation stay synchronized', async () => {
  const [packageSource, readme, releaseNotes, rootRoadmap, docsRoadmap] =
    await Promise.all([
      read('package.json'),
      read('README.md'),
      read('docs/RINKRAT_DATA_D1F_CANONICAL_FACTS_AFFECTED_LEAGUE_INDEX.md'),
      read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
      read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(packageJson.scripts['verify:batchd1f:core'], /verify:batchd1d:core/);
  assert.match(packageJson.scripts['verify:batchd1f'], /toolchain:verify/);
  assert.match(readme, /D1F .*Canonical Game Facts and Affected-League Index/);
  assert.match(releaseNotes, /TOI-only/i);
  assert.match(releaseNotes, /affected league/i);
  assert.match(releaseNotes, /direct NHL scoring remains authoritative/i);
  assert.match(rootRoadmap, /LOG\.87 2026-08-26/);
});
