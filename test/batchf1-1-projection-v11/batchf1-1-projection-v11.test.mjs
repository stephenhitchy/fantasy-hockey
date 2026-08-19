import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildProjectionV11GoalieRates,
  buildProjectionV11SkaterRates,
  calculateProjectionV11Range,
  getProjectionPrimaryAssistShare,
  PROJECTION_MODEL_VERSION,
} from '../../src/app/core/projection/projection-v11.util.ts';

function skaterSeason(gamesPlayed, perGame = {}) {
  const rate = {
    goals: 0.35,
    assists: 0.45,
    shotsOnGoal: 3.1,
    hits: 1.1,
    blockedShots: 0.45,
    plusMinus: 0.08,
    powerPlayPoints: 0.22,
    shortHandedPoints: 0.01,
    gameWinningGoals: 0.04,
    overtimeGoals: 0.01,
    averageTimeOnIceMinutes: 17.4,
    ...perGame,
  };

  return {
    gamesPlayed,
    goals: rate.goals * gamesPlayed,
    assists: rate.assists * gamesPlayed,
    shotsOnGoal: rate.shotsOnGoal * gamesPlayed,
    hits: rate.hits * gamesPlayed,
    blockedShots: rate.blockedShots * gamesPlayed,
    plusMinus: rate.plusMinus * gamesPlayed,
    powerPlayPoints: rate.powerPlayPoints * gamesPlayed,
    shortHandedPoints: rate.shortHandedPoints * gamesPlayed,
    gameWinningGoals: rate.gameWinningGoals * gamesPlayed,
    overtimeGoals: rate.overtimeGoals * gamesPlayed,
    averageTimeOnIceMinutes: rate.averageTimeOnIceMinutes,
  };
}

test('the matchup finish-date build hotfix avoids the TypeScript string-versus-never comparison', async () => {
  const source = await readFile(
    new URL(
      '../../src/app/features/cycles/cycle-one/cycle-matchup-finish-date.util.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(source, /function getLaterIsoDate\(/);
  assert.match(source, /candidateDate\.localeCompare\(currentDate\)/);
  assert.match(source, /finishDate = getLaterIsoDate\(finishDate, resolved\.finishDate\)/);
  assert.doesNotMatch(source, /resolved\.finishDate\s*>\s*finishDate/);
});

test('Projection V11 identifies itself as a new shared model generation', () => {
  assert.equal(PROJECTION_MODEL_VERSION, 11);
});

test('missed team games do not become zero-production appearances', () => {
  const sixtyGameSeason = buildProjectionV11SkaterRates({
    position: 'LW',
    latestCompletedStats: skaterSeason(60),
    previousCompletedStats: skaterSeason(82),
    latestSeasonWeight: 0.8,
    previousSeasonWeight: 0.15,
  });
  const eightyTwoGameSeason = buildProjectionV11SkaterRates({
    position: 'LW',
    latestCompletedStats: skaterSeason(82),
    previousCompletedStats: skaterSeason(82),
    latestSeasonWeight: 0.8,
    previousSeasonWeight: 0.15,
  });

  const sixtyGameShotRate = sixtyGameSeason.expectedStatsPer82.shotsOnGoal / 82;
  const fullSeasonShotRate = eightyTwoGameSeason.expectedStatsPer82.shotsOnGoal / 82;

  assert.ok(Math.abs(sixtyGameShotRate - fullSeasonShotRate) < 0.08);
  assert.ok(sixtyGameSeason.expectedStatsPer82.goals > 25);
});

test('an unsustainable current shooting spike is pulled toward shot volume and history', () => {
  const result = buildProjectionV11SkaterRates({
    position: 'RW',
    currentStats: skaterSeason(20, {
      goals: 1,
      shotsOnGoal: 3,
      assists: 0.35,
      averageTimeOnIceMinutes: 17.5,
    }),
    latestCompletedStats: skaterSeason(82, {
      goals: 0.3,
      shotsOnGoal: 3,
      assists: 0.4,
    }),
    previousCompletedStats: skaterSeason(78, {
      goals: 0.28,
      shotsOnGoal: 2.9,
      assists: 0.39,
    }),
  });

  assert.ok(result.shootingPercentage < 0.2);
  assert.ok(result.shootingRegressionAdjustmentGoalsPer82 < 0);
  assert.ok(result.expectedStatsPer82.goals < 55);
});

test('repeatable opportunity responds faster than finishing results', () => {
  const baseline = buildProjectionV11SkaterRates({
    position: 'C',
    currentStats: skaterSeason(12, {
      shotsOnGoal: 2.4,
      goals: 0.22,
      averageTimeOnIceMinutes: 15.5,
    }),
    latestCompletedStats: skaterSeason(82, {
      shotsOnGoal: 2.5,
      goals: 0.23,
      averageTimeOnIceMinutes: 15.8,
    }),
  });
  const roleGrowth = buildProjectionV11SkaterRates({
    position: 'C',
    currentStats: skaterSeason(12, {
      shotsOnGoal: 4.3,
      goals: 0.22,
      averageTimeOnIceMinutes: 21,
    }),
    latestCompletedStats: skaterSeason(82, {
      shotsOnGoal: 2.5,
      goals: 0.23,
      averageTimeOnIceMinutes: 15.8,
    }),
  });

  const shotIncrease =
    roleGrowth.expectedStatsPer82.shotsOnGoal - baseline.expectedStatsPer82.shotsOnGoal;
  const goalIncrease =
    roleGrowth.expectedStatsPer82.goals - baseline.expectedStatsPer82.goals;

  assert.ok(shotIncrease > 30);
  assert.ok(goalIncrease > 0);
  assert.ok(goalIncrease < shotIncrease * 0.2);
  assert.ok(
    roleGrowth.expectedStatsPer82.averageTimeOnIceMinutes >
      baseline.expectedStatsPer82.averageTimeOnIceMinutes,
  );
});

test('assist valuation no longer assumes that only 40 percent of assists are primary', () => {
  assert.equal(getProjectionPrimaryAssistShare('LW'), 0.56);
  assert.equal(getProjectionPrimaryAssistShare('C'), 0.56);
  assert.equal(getProjectionPrimaryAssistShare('D'), 0.53);
});

test('goalie save percentage and rare outcomes are sample-size regressed', () => {
  const result = buildProjectionV11GoalieRates({
    currentStats: {
      gamesPlayed: 10,
      shotsAgainst: 320,
      saves: 304,
      wins: 9,
      shutouts: 4,
    },
    latestCompletedStats: {
      gamesPlayed: 82,
      shotsAgainst: 2460,
      saves: 2214,
      wins: 40,
      shutouts: 5,
    },
    previousCompletedStats: {
      gamesPlayed: 82,
      shotsAgainst: 2380,
      saves: 2142,
      wins: 38,
      shutouts: 4,
    },
  });

  assert.ok(result.savePercentage < 0.925);
  assert.ok(result.savePercentage > 0.895);
  assert.ok(result.winRate < 0.7);
  assert.ok(result.shutoutRate < 0.12);
});

test('the likely matchup range expands for volatile low-confidence players', () => {
  const stable = calculateProjectionV11Range({
    mean: 70,
    recentGameStandardDeviation: 4,
    recentSampleSize: 20,
    expectedGames: 6,
    reliabilityRating: 90,
    position: 'LW',
  });
  const volatile = calculateProjectionV11Range({
    mean: 70,
    recentGameStandardDeviation: 13,
    recentSampleSize: 20,
    expectedGames: 6,
    reliabilityRating: 50,
    position: 'LW',
  });

  assert.ok(volatile.uncertainty > stable.uncertainty);
  assert.ok(volatile.floor < stable.floor);
  assert.ok(volatile.ceiling > stable.ceiling);
});

test('browser and Cloud Functions use the same Projection V11 implementation and snapshot version', async () => {
  const [browserUtility, serverUtility, browserSnapshot, serverSnapshot] = await Promise.all([
    readFile(
      new URL('../../src/app/core/projection/projection-v11.util.ts', import.meta.url),
    ),
    readFile(
      new URL(
        '../../functions/src/shared/core/projection/projection-v11.util.ts',
        import.meta.url,
      ),
    ),
    readFile(
      new URL('../../src/app/core/projection/projection-snapshot.service.ts', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL(
        '../../functions/src/shared/core/projection/projection-snapshot.service.ts',
        import.meta.url,
      ),
      'utf8',
    ),
  ]);

  assert.deepEqual(browserUtility, serverUtility);
  assert.match(browserSnapshot, /SHARED_PROJECTION_VERSION\s*=\s*11/);
  assert.match(serverSnapshot, /SHARED_PROJECTION_VERSION\s*=\s*11/);
});

test('Projection V11 integrates component rates, sustainable form, availability, and range diagnostics', async () => {
  const source = await readFile(
    new URL('../../src/app/core/draft/draft-player-pool.service.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /buildProjectionV11SkaterRates\(/);
  assert.match(source, /buildProjectionV11GoalieRates\(/);
  assert.match(source, /getCycleSustainableFormAdjustment\(/);
  assert.match(source, /calculateProjectionV11Range\(/);
  assert.match(source, /healthy production pace as zero-point games/i);
  assert.match(source, /liveAvailabilityPenalty/);
  assert.match(source, /projectionModelVersion:\s*PROJECTION_MODEL_VERSION/);
});

test('Projection Lab exposes model confidence, luck regression, and likely range without changing scoring', async () => {
  const [page, presenter] = await Promise.all([
    readFile(
      new URL('../../src/app/features/projections/projection-lab/projection-lab.html', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../../src/app/features/projections/projection-lab/projection-lab.ts', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(page, /Projection Lab V11/);
  assert.match(page, /Component Ensemble/);
  assert.match(page, /Luck Regression/);
  assert.match(page, /Likely Matchup Range/);
  assert.match(page, /<th>V11 Model<\/th>/);
  assert.match(presenter, /getProjectionModelDescription/);
  assert.match(presenter, /getProjectionRangeDescription/);
  assert.match(presenter, /getLuckRegressionDescription/);
});

test('production scoring rules and scoring engine remain unchanged', async () => {
  const expected = new Map([
    ['../../src/app/core/scoring/scoring-rules.ts', '74107aa688b4a3825c52fe14003cd824485197fd3559822fab4134bff940e2da'],
    ['../../src/app/core/scoring/scoring-engine.ts', '6f36cf76c72f8199c6a3891692844c9c830103ed618be50497b5270e259da3d3'],
  ]);

  for (const [relativePath, expectedHash] of expected) {
    const contents = await readFile(new URL(relativePath, import.meta.url));
    const actualHash = createHash('sha256').update(contents).digest('hex');
    assert.equal(actualHash, expectedHash, relativePath);
  }
});
