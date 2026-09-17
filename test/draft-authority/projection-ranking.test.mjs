import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  DRAFT_BENCH_DEMAND_PER_TEAM,
  DRAFT_RANKING_MODEL_VERSION,
  rankSharedProjectionAssets,
} = require('../../functions/lib/shared/core/projection/projection-ranking.util.js');

const FORWARD_POSITIONS = ['LW', 'C', 'RW'];

function skater(position, index, projection) {
  return {
    assetType: 'skater',
    assetKey: `${position.toLowerCase()}-${index}`,
    position,
    player: {
      id: Number(`${FORWARD_POSITIONS.indexOf(position) + 1}${index}`),
      fullName: `${position} Player ${index}`,
      firstName: position,
      lastName: `Player ${index}`,
      position,
      currentTeamAbbreviation: 'MIN',
    },
    projectionModelVersion: 11,
    draftFloorAdjustedCyclePoints: projection,
    draftProjectedCyclePoints: projection,
    floorAdjustedCyclePoints: projection,
    projectedCyclePoints: projection,
    draftReliabilityRating: 80,
    reliabilityRating: 80,
  };
}

function defender(index, projection) {
  return skater('D', index, projection);
}

function goalie(index, projection) {
  return {
    assetType: 'team-goalie-unit',
    assetKey: `goalie-${index}`,
    position: 'G',
    teamName: `Goalie Unit ${index}`,
    teamAbbreviation: `G${String(index).padStart(2, '0')}`,
    projectionModelVersion: 11,
    draftFloorAdjustedCyclePoints: projection,
    draftProjectedCyclePoints: projection,
    floorAdjustedCyclePoints: projection,
    projectedCyclePoints: projection,
    draftReliabilityRating: 90,
    reliabilityRating: 90,
  };
}

function playerPool() {
  const forwards = FORWARD_POSITIONS.flatMap((position, positionIndex) =>
    Array.from({ length: 50 }, (_, offset) =>
      skater(position, offset + 1, 100 - offset - positionIndex * 0.1),
    ),
  );
  const defenders = Array.from({ length: 60 }, (_, offset) =>
    defender(offset + 1, 100 - offset * 0.8),
  );
  const goalies = Array.from({ length: 32 }, (_, offset) =>
    goalie(offset + 1, 120 - offset),
  );

  return [...forwards, ...defenders, ...goalies];
}

describe('league-adjusted Draft Ranking V2', () => {
  test('models each team bench as two forwards, one defender, and no goalie unit', () => {
    assert.equal(DRAFT_RANKING_MODEL_VERSION, 2);
    assert.deepEqual(DRAFT_BENCH_DEMAND_PER_TEAM, { F: 2, D: 1, G: 0 });

    const ranked = rankSharedProjectionAssets(playerPool(), 10);
    const positiveValueCount = (positions) => ranked.filter((asset) =>
      positions.includes(asset.position) &&
      typeof asset.draftValueAboveReplacement === 'number' &&
      asset.draftValueAboveReplacement > 0
    ).length;

    assert.equal(positiveValueCount(FORWARD_POSITIONS), 110);
    assert.equal(positiveValueCount(['D']), 50);
    assert.equal(positiveValueCount(['G']), 10);
  });

  test('moves goalie units outside league starter demand below the drafted pool', () => {
    const teamCount = 10;
    const expectedDraftedAssetCount = teamCount * 17;
    const ranked = rankSharedProjectionAssets(playerPool(), teamCount);
    const draftedPool = ranked.filter(
      (asset) => (asset.draftRank ?? Number.MAX_SAFE_INTEGER) <= expectedDraftedAssetCount,
    );
    const reserveGoalies = ranked.filter((asset) =>
      asset.position === 'G' &&
      (asset.draftPositionRank ?? 0) > teamCount
    );

    assert.equal(draftedPool.length, expectedDraftedAssetCount);
    assert.equal(draftedPool.filter((asset) => asset.position === 'G').length, teamCount);
    assert.equal(reserveGoalies.length, 22);
    assert.ok(
      reserveGoalies.every((asset) => (asset.draftRank ?? 0) > expectedDraftedAssetCount),
    );
    assert.ok(
      reserveGoalies.every((asset) => (asset.draftScore ?? Number.POSITIVE_INFINITY) < 12),
    );
  });

  test('uses league size to decide whether a goalie unit is a starter or waiver option', () => {
    const pool = playerPool();
    const eightTeam = rankSharedProjectionAssets(pool, 8);
    const twelveTeam = rankSharedProjectionAssets(pool, 12);
    const eightTeamNinthGoalie = eightTeam.find((asset) => asset.assetKey === 'goalie-9');
    const twelveTeamNinthGoalie = twelveTeam.find((asset) => asset.assetKey === 'goalie-9');

    assert.ok(eightTeamNinthGoalie);
    assert.ok(twelveTeamNinthGoalie);
    assert.ok((eightTeamNinthGoalie.draftScore ?? 0) < 12);
    assert.ok(
      (twelveTeamNinthGoalie.draftScore ?? 0) >
        (eightTeamNinthGoalie.draftScore ?? 0) + 20,
    );
  });

  test('preserves Projection V11 outputs while versioning the separate draft ranking', () => {
    const pool = playerPool();
    const originalProjection = pool[0].draftProjectedCyclePoints;
    const ranked = rankSharedProjectionAssets(pool, 10);

    assert.equal(pool[0].draftRankingVersion, undefined);
    assert.equal(pool[0].draftProjectedCyclePoints, originalProjection);
    assert.ok(ranked.every((asset) => asset.projectionModelVersion === 11));
    assert.ok(ranked.every((asset) => asset.draftRankingVersion === 2));
  });

  test('browser and server ranking implementations remain byte-for-byte aligned', async () => {
    const [browser, server] = await Promise.all([
      readFile(
        new URL('../../src/app/core/projection/projection-ranking.util.ts', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL(
          '../../functions/src/shared/core/projection/projection-ranking.util.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    ]);

    assert.equal(browser, server);
  });
});
