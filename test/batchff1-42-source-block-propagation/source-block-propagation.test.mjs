import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const require = createRequire(import.meta.url);
const windowSelection = require(
  `${ROOT_PATH}functions/lib/shared/core/cycle/cycle-window-selection.util.js`,
);
const playoffFormat = require(
  `${ROOT_PATH}functions/lib/shared/core/playoffs/playoff-format.js`,
);
const cycleScoring = require(
  `${ROOT_PATH}functions/lib/shared/core/cycle/cycle-scoring.service.js`,
);
const windowProjection = require(
  `${ROOT_PATH}functions/lib/shared/core/projection/window-projection.service.js`,
);
const anchoredSeasonCapacity = require(
  `${ROOT_PATH}functions/lib/shared/core/draft/anchored-season-capacity.util.js`,
);
const scoringRules = require(
  `${ROOT_PATH}functions/lib/shared/core/scoring/scoring-rules.js`,
);

function schedule(count = 18) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    gameDate: `2026-10-${String(index + 1).padStart(2, '0')}`,
    startTimeUTC: `2026-10-${String(index + 1).padStart(2, '0')}T23:00:00Z`,
    gameType: 2,
    gameState: 'FUT',
    homeTeam: { abbrev: 'SEA' },
    awayTeam: { abbrev: 'VAN' },
  }));
}

function replayPick() {
  return {
    overallPick: 1,
    round: 1,
    pickInRound: 1,
    ownerId: 'owner-a',
    rosterSlotId: 'C-1',
    cycleWindowId: 'owner-a__C-1__cycle-1',
    snapshotCycleNumber: 1,
    sourceNhlBlockNumber: 2,
    // These live-season ids intentionally do not exist in replay evidence.
    sourceNhlTargetGameIds: [9001, 9002, 9003, 9004, 9005, 9006],
    asset: {
      assetType: 'skater',
      assetKey: 'skater-7',
      position: 'C',
      player: {
        id: 7,
        fullName: 'Replay Test Skater',
        position: 'C',
        nhlTeamAbbreviation: 'SEA',
      },
    },
  };
}

function capacityTeams(gameCount = 82) {
  return Array.from({ length: 32 }, (_, index) => ({
    teamAbbreviation: `T${String(index + 1).padStart(2, '0')}`,
    regularSeasonGameCount: gameCount,
  }));
}

test('legacy records use fantasy cycle as their NHL source block', () => {
  assert.equal(windowSelection.resolveSourceNhlBlockNumber(undefined, 3), 3);
  assert.equal(windowSelection.resolveSourceNhlBlockNumber(null, 2), 2);
  assert.equal(windowSelection.resolveSourceNhlBlockNumber(4, 1), 4);
});

test('source block 2 starts with NHL Game 7 and preserves six-game rollover', () => {
  const selected = windowSelection.selectCycleWindowGames(schedule(), 2, 6);

  assert.deepEqual(selected.map((game) => game.id), [7, 8, 9, 10, 11, 12]);
  assert.equal(selected[0].id, 7);
});

test('a frozen full-season plan prevents insertion gaps through playoff source block 13', () => {
  const regularSeasonGameIds = Array.from({ length: 78 }, (_, index) => index + 1);
  const sourcePlan = { SEA: regularSeasonGameIds };
  const blockTwo = windowSelection.buildSourceNhlTargetGameIdsByTeam(
    sourcePlan,
    2,
    6,
  );
  const blockThree = windowSelection.buildSourceNhlTargetGameIdsByTeam(
    sourcePlan,
    3,
    6,
  );
  const providerScheduleAfterInsertion = [
    { id: 9000 },
    ...regularSeasonGameIds.map((id) => ({ id })),
  ];
  const allRemainingFrozenIds = Array.from(
    { length: 12 },
    (_, offset) => windowSelection.buildSourceNhlTargetGameIdsByTeam(
      sourcePlan,
      offset + 2,
      6,
    ).SEA,
  ).flat();

  assert.deepEqual(blockTwo.SEA, [7, 8, 9, 10, 11, 12]);
  assert.deepEqual(blockThree.SEA, [13, 14, 15, 16, 17, 18]);
  assert.deepEqual(
    windowSelection.selectGamesByStableIds(
      providerScheduleAfterInsertion,
      blockThree.SEA,
    ).map((game) => game.id),
    [13, 14, 15, 16, 17, 18],
  );
  assert.deepEqual(allRemainingFrozenIds, regularSeasonGameIds.slice(6, 78));
  assert.equal(new Set(allRemainingFrozenIds).size, 72);
});

test('an anchored source plan fails visibly instead of weakening a later block', () => {
  assert.throws(
    () => windowSelection.buildSourceNhlTargetGameIdsByTeam(
      { SEA: Array.from({ length: 17 }, (_, index) => index + 1) },
      3,
      6,
    ),
    /incomplete for source block 3/i,
  );
  assert.deepEqual(
    windowSelection.buildSourceNhlTargetGameIdsByTeam(undefined, 3, 6),
    {},
  );
});

test('frozen provider ids survive schedule reordering and fail visibly when missing', () => {
  const reordered = [schedule()[7], schedule()[5], schedule()[6]];

  assert.deepEqual(
    windowSelection.selectGamesByStableIds(reordered, [6, 7, 8]).map((game) => game.id),
    [6, 7, 8],
  );
  assert.throws(
    () => windowSelection.selectGamesByStableIds(reordered, [6, 7, 99]),
    /missing frozen game id\(s\): 99/i,
  );
});

test('late starts shorten regular season while preserving every playoff round', () => {
  assert.equal(playoffFormat.getAnchoredRegularSeasonCycleCount(2, 12), 1);
  assert.equal(playoffFormat.getAnchoredRegularSeasonCycleCount(4, 11), 1);
  assert.equal(playoffFormat.getAnchoredRegularSeasonCycleCount(8, 10), 1);

  assert.throws(
    () => playoffFormat.getAnchoredRegularSeasonCycleCount(2, 13),
    /starts too late/i,
  );
  assert.throws(
    () => playoffFormat.getAnchoredRegularSeasonCycleCount(4, 12),
    /starts too late/i,
  );
  assert.throws(
    () => playoffFormat.getAnchoredRegularSeasonCycleCount(8, 11),
    /starts too late/i,
  );
});

test('season capacity preserves participant-dependent playoffs through source block 13', () => {
  for (const [finalizedTeamCount, initialNhlBlockNumber, playoffRoundCount] of [
    [2, 12, 1],
    [4, 11, 2],
    [8, 10, 3],
  ]) {
    const result = anchoredSeasonCapacity.validateAnchoredSeasonCapacity({
      finalizedTeamCount,
      activeNhlTeamCount: 32,
      initialNhlBlockNumber,
      requiredGamesPerCycle: 6,
      teams: capacityTeams(),
    });

    assert.equal(result.regularSeasonCycleCount, 1);
    assert.equal(result.playoffRoundCount, playoffRoundCount);
    assert.equal(result.finalRequiredSourceBlock, 13);
    assert.equal(result.requiredThroughGameNumber, 78);
  }
});

test('season capacity enforces canonical six-game windows and complete game-78 evidence', () => {
  assert.throws(
    () => anchoredSeasonCapacity.validateAnchoredSeasonCapacity({
      finalizedTeamCount: 8,
      activeNhlTeamCount: 32,
      initialNhlBlockNumber: 10,
      requiredGamesPerCycle: 5,
      teams: capacityTeams(),
    }),
    /protected 6-game matchup format/i,
  );

  const teams = capacityTeams();
  teams[31] = { ...teams[31], regularSeasonGameCount: 77 };

  assert.throws(
    () => anchoredSeasonCapacity.validateAnchoredSeasonCapacity({
      finalizedTeamCount: 8,
      activeNhlTeamCount: 32,
      initialNhlBlockNumber: 10,
      requiredGamesPerCycle: 6,
      teams,
    }),
    /incomplete through game 78 for: T32/i,
  );
});

test('historical replay ignores live anchor ids and retains replay block alignment', async () => {
  const pick = replayPick();
  const result = await cycleScoring.calculateCycleScoring({
    picks: [pick],
    cycleNumber: 1,
    season: '20262027',
    requiredGamesPerCycle: 6,
    scoringRules: scoringRules.defaultScoringRules,
    replayGamesByAssetKey: {
      [pick.asset.assetKey]: schedule(12),
    },
  });
  const summary = result.windowScores[pick.cycleWindowId];

  assert.equal(summary.sourceNhlBlockNumber, 2);
  assert.deepEqual(summary.scheduledGameIds, [7, 8, 9, 10, 11, 12]);
});

test('a banked bye pick keeps its older source-block ids over the current cycle map', () => {
  const bankedPick = {
    ...replayPick(),
    sourceNhlBlockNumber: 11,
    sourceNhlTargetGameIds: [61, 62, 63, 64, 65, 66],
    sourceNhlTargetGameIdsByTeam: {
      SEA: [61, 62, 63, 64, 65, 66],
      VAN: [601, 602, 603, 604, 605, 606],
    },
  };
  const currentCycleBlockTwelve = {
    SEA: [67, 68, 69, 70, 71, 72],
    VAN: [607, 608, 609, 610, 611, 612],
  };

  assert.deepEqual(
    cycleScoring.resolveFrozenTargetGameIdsForPick(
      bankedPick,
      'SEA',
      currentCycleBlockTwelve,
    ),
    [61, 62, 63, 64, 65, 66],
  );
  assert.deepEqual(
    cycleScoring.resolveFrozenTargetGameIdsForPick(
      bankedPick,
      'VAN',
      currentCycleBlockTwelve,
    ),
    [601, 602, 603, 604, 605, 606],
  );
});

test('cycle and projection services keep fantasy identity separate from NHL source block', async () => {
  const [cycleService, serverProjection, browserProjection] = await Promise.all([
    read('functions/src/shared/core/cycle/cycle.service.ts'),
    read('functions/src/shared/core/projection/window-projection.service.ts'),
    read('src/app/core/projection/window-projection.service.ts'),
  ]);

  assert.match(
    cycleService,
    /loadWindowProjectionAssetsByKey\([\s\S]*?cycleNumber,[\s\S]*?sourceNhlBlockNumber/,
  );
  assert.match(cycleService, /frozenProjectionCycleNumber:[\s\S]*?cycleNumber|createFrozenWindowProjectionFields\(baseAsset, cycleNumber/);
  for (const source of [serverProjection, browserProjection]) {
    assert.match(source, /targetSourceBlockNumber\?: number/);
    assert.match(source, /targetGameIdsByTeam\?/);
    assert.match(source, /targetCycleNumber,/);
    assert.match(source, /targetSourceBlockNumber,/);
    assert.match(source, /targetSnapshotMatchesSource/);
  }
  assert.match(serverProjection, /targetGameIdsByTeam: input\.targetGameIdsByTeam/);
});

test('a Matchup 1 source-block-1 snapshot cannot backfill Matchup 1 source block 2', () => {
  const sourceBlockOneSnapshot = {
    metadata: {
      targetCycleNumber: 1,
      targetSourceBlockNumber: 1,
    },
    assets: [{ assetKey: 'skater-7' }],
  };
  const sourceBlockTwoSnapshot = {
    metadata: {
      targetCycleNumber: 1,
      targetSourceBlockNumber: 2,
      seasonWindowAnchorEvidenceHash: 'anchor-b',
    },
    assets: [{ assetKey: 'skater-7' }],
  };
  const legacyMatchupTwoSnapshot = {
    metadata: {
      targetCycleNumber: 2,
    },
    assets: [{ assetKey: 'skater-7' }],
  };

  assert.equal(
    windowProjection.doesWindowProjectionSnapshotMatchSource(sourceBlockOneSnapshot, 2),
    false,
  );
  assert.equal(
    windowProjection.doesWindowProjectionSnapshotMatchSource(sourceBlockTwoSnapshot, 2),
    true,
  );
  assert.equal(
    windowProjection.doesWindowProjectionSnapshotMatchSource(
      sourceBlockTwoSnapshot,
      2,
      'anchor-b',
    ),
    true,
  );
  assert.equal(
    windowProjection.doesWindowProjectionSnapshotMatchSource(
      sourceBlockTwoSnapshot,
      2,
      'different-anchor',
    ),
    false,
  );
  assert.equal(
    windowProjection.doesWindowProjectionSnapshotMatchSource(legacyMatchupTwoSnapshot, 2),
    true,
  );
});

test('playoff banks increment NHL source blocks without renumbering fantasy cycles', async () => {
  const [serverBank, browserBank] = await Promise.all([
    read('functions/src/shared/core/playoffs/playoff-window-bank.service.ts'),
    read('src/app/core/playoffs/playoff-window-bank.service.ts'),
  ]);

  for (const source of [serverBank, browserBank]) {
    assert.match(source, /sourceCycleNumber = playoffs\.regularSeasonCycleCount \+ windowNumber/);
    assert.match(
      source,
      /resolveSourceNhlBlockNumber\([\s\S]*?bank\.sourceNhlBlockNumber,[\s\S]*?bank\.sourceCycleNumber,[\s\S]*?\) \+ 1/,
    );
    assert.match(source, /targetCycleNumber: sourceCycleNumber/);
    assert.match(source, /targetSourceBlockNumber: sourceNhlBlockNumber/);
    assert.match(source, /targetGameIdsByTeam: sourceNhlTargetGameIdsByTeam/);
    assert.match(source, /snapshotCycleNumber: sourceCycleNumber/);
    assert.match(source, /sourceNhlBlockNumber,/);
    assert.match(source, /getDoc\(getDraftRef\(leagueId\)\)/);
    assert.match(source, /sourceNhlTargetGameIdsByTeam: \{ \.\.\.sourceNhlTargetGameIdsByTeam \}/);
  }
});

test('browser matchup views label the anchored NHL game range', async () => {
  const [schedulePreview, matchupOverview, cyclePage, assetDetail] = await Promise.all([
    read('src/app/features/cycles/schedule-preview/cycle-schedule-preview.ts'),
    read('src/app/features/cycles/matchup-overview/cycle-matchup-overview.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    read('src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.ts'),
  ]);

  assert.match(schedulePreview, /initialNhlBlockNumber\(\) \+ cycleNumber - 1/);
  assert.match(matchupOverview, /NHL games \$\{firstGameNumber\}–\$\{firstGameNumber \+ 5\} by club/);
  assert.match(cyclePage, /sourceNhlBlockNumber[\s\S]*?requiredGamesPerCycle/);
  assert.match(assetDetail, /selectGamesByStableIds\(schedule, frozenTargetGameIds\)/);
});
