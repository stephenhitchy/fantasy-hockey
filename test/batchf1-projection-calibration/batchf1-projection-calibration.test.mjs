import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assessDraftTrajectory,
  calculateTrajectoryAwareStableDraftProjection,
} from '../../src/app/core/projection/projection-trajectory.util.ts';
import {
  calculateMatchupFinishDate,
} from '../../src/app/features/cycles/cycle-one/cycle-matchup-finish-date.util.ts';

const noSampleCap = (projection) => projection;

function makeSupportedBreakout(overrides = {}) {
  return {
    position: 'LW',
    currentPace: null,
    currentGamesPlayed: 0,
    latestCompletedSeason: {
      pace: 82,
      gamesPlayed: 76,
      averageTimeOnIceMinutes: 17.25,
      shotsPerGame: 3.75,
      powerPlayPointsPerGame: 0.3,
    },
    previousCompletedSeason: {
      pace: 50,
      gamesPlayed: 82,
      averageTimeOnIceMinutes: 15,
      shotsPerGame: 2.5,
      powerPlayPointsPerGame: 0.17,
    },
    conservativeBaseline: 45,
    birthDate: '2004-01-20',
    projectionDate: new Date('2026-09-01T12:00:00Z'),
    capProjectionBySample: noSampleCap,
    ...overrides,
  };
}

function makeSchedule(team, dates) {
  return dates.map((gameDate, index) => ({
    id: 1000 + index,
    gameDate,
    gameType: 2,
    homeTeam: { abbrev: team },
    awayTeam: { abbrev: 'OPP' },
  }));
}

test('Projection V11 gives a supported young breakout more latest-season weight than V9', () => {
  const result = calculateTrajectoryAwareStableDraftProjection(makeSupportedBreakout());

  assert.equal(result.trajectoryLabel, 'breakout');
  assert.equal(result.latestSeasonWeight, 0.86);
  assert.ok(result.projectedSeasonPoints > result.stableSeasonPoints);
  assert.ok(result.trajectoryAdjustment > 0);
});

test('positive trajectory uplift remains bounded even for an extreme one-season jump', () => {
  const result = calculateTrajectoryAwareStableDraftProjection(
    makeSupportedBreakout({
      latestCompletedSeason: {
        pace: 180,
        gamesPlayed: 82,
        averageTimeOnIceMinutes: 23,
        shotsPerGame: 6,
        powerPlayPointsPerGame: 1,
      },
    }),
  );

  assert.ok(result.projectedSeasonPoints <= result.stableSeasonPoints * 1.100001);
});

test('a small sample hot streak does not become a breakout', () => {
  const assessment = assessDraftTrajectory({
    position: 'RW',
    latestCompletedSeason: {
      pace: 120,
      gamesPlayed: 22,
      averageTimeOnIceMinutes: 20,
      shotsPerGame: 5,
      powerPlayPointsPerGame: 0.8,
    },
    previousCompletedSeason: {
      pace: 45,
      gamesPlayed: 70,
      averageTimeOnIceMinutes: 14,
      shotsPerGame: 2,
      powerPlayPointsPerGame: 0.1,
    },
    birthDate: '2003-02-01',
    projectionDate: new Date('2026-09-01T12:00:00Z'),
  });

  assert.equal(assessment.label, 'insufficient-data');
  assert.equal(assessment.latestSeasonWeight, 0.7);
  assert.equal(assessment.maximumPositiveUpliftRate, 0);
});

test('a stable player keeps the established 70/20/10 completed-season weights', () => {
  const assessment = assessDraftTrajectory({
    position: 'C',
    latestCompletedSeason: {
      pace: 72,
      gamesPlayed: 78,
      averageTimeOnIceMinutes: 18.2,
      shotsPerGame: 3,
      powerPlayPointsPerGame: 0.28,
    },
    previousCompletedSeason: {
      pace: 69,
      gamesPlayed: 80,
      averageTimeOnIceMinutes: 18,
      shotsPerGame: 2.9,
      powerPlayPointsPerGame: 0.27,
    },
    birthDate: '1998-02-01',
    projectionDate: new Date('2026-09-01T12:00:00Z'),
  });

  assert.equal(assessment.label, 'stable');
  assert.equal(assessment.latestSeasonWeight, 0.7);
  assert.equal(assessment.previousSeasonWeight, 0.2);
  assert.equal(assessment.conservativeBaselineWeight, 0.1);
});

test('age alone cannot create a breakout and goalie units retain their stable baseline', () => {
  const youngFlat = assessDraftTrajectory({
    position: 'LW',
    latestCompletedSeason: { pace: 51, gamesPlayed: 80 },
    previousCompletedSeason: { pace: 50, gamesPlayed: 80 },
    birthDate: '2005-01-01',
    projectionDate: new Date('2026-09-01T12:00:00Z'),
  });
  const goalie = assessDraftTrajectory({
    position: 'G',
    latestCompletedSeason: { pace: 110, gamesPlayed: 82 },
    previousCompletedSeason: { pace: 60, gamesPlayed: 82 },
  });

  assert.equal(youngFlat.label, 'stable');
  assert.equal(goalie.label, 'insufficient-data');
  assert.equal(goalie.latestSeasonWeight, 0.7);
});

test('matchup finish date is the latest sixth-game date across independent roster slots', () => {
  const result = calculateMatchupFinishDate({
    requiredGamesPerWindow: 6,
    schedulesByTeam: {},
    slots: [
      {
        ownerId: 'a',
        rosterSlotId: 'LW-1',
        teamAbbreviation: 'AAA',
        currentScheduledGameDates: [
          '2026-10-01',
          '2026-10-03',
          '2026-10-05',
          '2026-10-07',
          '2026-10-09',
          '2026-10-11',
        ],
      },
      {
        ownerId: 'b',
        rosterSlotId: 'C-1',
        teamAbbreviation: 'BBB',
        currentScheduledGameDates: [
          '2026-10-02',
          '2026-10-04',
          '2026-10-08',
          '2026-10-10',
          '2026-10-12',
          '2026-10-14',
        ],
      },
    ],
  });

  assert.equal(result.finishDate, '2026-10-14');
  assert.equal(result.confidence, 'scheduled');
  assert.equal(result.resolvedSlotCount, 2);
});

test('an untouched future slot derives its finish from the prior boundary and incoming player schedule', () => {
  const result = calculateMatchupFinishDate({
    requiredGamesPerWindow: 6,
    schedulesByTeam: {
      ANA: makeSchedule('ANA', [
        '2026-10-02',
        '2026-10-05',
        '2026-10-07',
        '2026-10-09',
        '2026-10-11',
        '2026-10-14',
        '2026-10-16',
      ]),
    },
    slots: [
      {
        ownerId: 'a',
        rosterSlotId: 'LW-1',
        teamAbbreviation: 'ANA',
        currentScheduledGameDates: [],
        previousLastScheduledGameDate: '2026-10-03',
      },
    ],
  });

  assert.equal(result.finishDate, '2026-10-16');
  assert.equal(result.confidence, 'projected');
  assert.equal(result.projectedSlotCount, 1);
});

test('an unresolved roster slot prevents a partial date from being presented as definitive', () => {
  const result = calculateMatchupFinishDate({
    requiredGamesPerWindow: 6,
    schedulesByTeam: {},
    slots: [
      {
        ownerId: 'a',
        rosterSlotId: 'LW-1',
        teamAbbreviation: 'AAA',
        currentScheduledGameDates: [
          '2026-10-01',
          '2026-10-03',
          '2026-10-05',
          '2026-10-07',
          '2026-10-09',
          '2026-10-11',
        ],
      },
      {
        ownerId: 'b',
        rosterSlotId: 'C-1',
        teamAbbreviation: 'MISSING',
      },
    ],
  });

  assert.equal(result.confidence, 'partial');
  assert.equal(result.resolvedSlotCount, 1);
  assert.equal(result.unresolvedSlotCount, 1);
});

test('Projection V11 keeps missed appearances and live availability as separate concepts', async () => {
  const source = await readFile(
    new URL('../../src/app/core/draft/draft-player-pool.service.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /healthy production pace as zero-point games/i);
  assert.match(source, /recentMissedGamesPenalty/);
  assert.match(source, /liveAvailabilityPenalty/);
  assert.match(source, /ignoreAvailability/);
  assert.doesNotMatch(source, /missedRecentTeamGames\s*\*\s*0/);
});

test('server window-boundary projection generation is live, V11, and replay-date aware', async () => {
  const source = await readFile(
    new URL(
      '../../functions/src/shared/core/projection/projection-snapshot.service.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(source, /SHARED_PROJECTION_VERSION\s*=\s*11/);
  assert.match(source, /await loadDraftPlayerPool\(/);
  assert.match(source, /target-cycle-\$\{targetCycleNumber\}/);
  assert.match(source, /projectionContext:\s*'historical-replay'/);
  assert.match(source, /ignoreAvailability:\s*true/);
  assert.match(source, /projectionAsOfDate:\s*replay\.simulatedDate/);
  assert.match(source, /getExpectedProjectionSnapshotContext/);
  assert.doesNotMatch(source, /throw new Error\([^)]*not available[^)]*\)/i);
});

test('replay freshness compares the simulated as-of date instead of only wall-clock age', async () => {
  const [snapshotSource, windowSource] = await Promise.all([
    readFile(
      new URL(
        '../../functions/src/shared/core/projection/projection-snapshot.service.ts',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(
      new URL(
        '../../functions/src/shared/core/projection/window-projection.service.ts',
        import.meta.url,
      ),
      'utf8',
    ),
  ]);

  assert.match(snapshotSource, /metadata\.projectionAsOfDate !== input\.expectedProjectionAsOfDate/);
  assert.match(snapshotSource, /projectionContext: 'historical-replay'/);
  assert.match(windowSource, /expectedProjectionAsOfDate: expectedContext\.projectionAsOfDate/);
  assert.match(windowSource, /expectedProjectionContext: expectedContext\.projectionContext/);
});

test('F1 historical scoring calibration is read-only and uses the production scoring engine', async () => {
  const source = await readFile(
    new URL(
      '../../src/app/core/scoring/historical-scoring-calibration.service.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(source, /calculateSkaterGamePoints/);
  assert.match(source, /calculateGoalieGamePoints/);
  assert.match(source, /requiredGamesPerMatchup/);
  assert.match(source, /current-v4/);
  assert.match(source, /legacy-v3/);
  assert.match(source, /star-separation/);
  assert.doesNotMatch(source, /lower-goalie-ceiling/);
  assert.match(source, /productionRulesChanged:\s*false/);
  assert.doesNotMatch(source, /firebase\/firestore/);
  assert.doesNotMatch(source, /setDoc\(|updateDoc\(|writeBatch\(/);
});

test('the versioned production scoring engine and rules remain pinned to the approved V4A baseline', async () => {
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

test('Game Center exposes the exact matchup timeline in both desktop and mobile score surfaces', async () => {
  const [page, mobile, presenter] = await Promise.all([
    readFile(
      new URL('../../src/app/features/cycles/cycle-one/cycle-one.html', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL(
        '../../src/app/features/cycles/cycle-one/components/cycle-mobile-scorebar/cycle-mobile-scorebar.html',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(
      new URL('../../src/app/features/cycles/cycle-one/cycle-one.ts', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(page, /app-cycle-matchup-finish-card/);
  assert.match(mobile, /getMobileMatchupFinishLabel/);
  assert.match(presenter, /calculateDisplayedMatchupFinishDate/);
  assert.match(presenter, /final starting roster slot completes its sixth scheduled NHL team game/);
});

test('Projection Lab identifies V11 trajectory adjustments without merging them with availability', async () => {
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
  assert.match(page, /Development Trajectory/);
  assert.match(page, /<th>Development<\/th>/);
  assert.match(page, /Missed Games/);
  assert.match(presenter, /draftTrajectoryLabel/);
  assert.match(presenter, /getTrajectoryDescription/);
});
