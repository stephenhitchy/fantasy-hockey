import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  areLeaderCycleTeamWindowsComplete,
  buildProjectedLeaderRows,
  buildScoringLeaderRows,
  filterAndRankLeaderRows,
  getVerifiedProjectionLeaderAssets,
  mergeLeaderWindows,
  resolveLeaderCycleCompletion,
  selectInitialLeaderCycleNumber,
} from '../../src/app/features/leaders/point-leaders/point-leaders.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function skater(assetKey, name, position, projection = 42) {
  return {
    assetType: 'skater',
    assetKey,
    position,
    player: {
      id: Number(assetKey.replace(/\D/g, '')) || 1,
      fullName: name,
      position,
      nhlTeamAbbreviation: 'VGK',
    },
    availabilityAdjustedCyclePoints: projection,
    projectionFloorPoints: projection - 8,
    projectionCeilingPoints: projection + 8,
    expectedGamesAvailable: 5.5,
    availabilityLabel: 'Active',
  };
}

function goalie(assetKey, projection = 36) {
  return {
    assetType: 'team-goalie-unit',
    assetKey,
    position: 'G',
    teamName: 'Vegas Golden Knights',
    teamAbbreviation: 'VGK',
    availabilityAdjustedCyclePoints: projection,
  };
}

function windowFor({ asset, ownerId, status, points, games = 6, appearances = games }) {
  return {
    id: `${ownerId}-${asset.assetKey}-${status}`,
    ownerId,
    rosterSlotId: `${asset.position}-1`,
    cycleNumber: 1,
    position: asset.position,
    assetKey: asset.assetKey,
    asset,
    status,
    scheduledGameIds: [],
    scheduledGameDates: [],
    scheduledGameLabels: [],
    completedGameIds: [],
    liveGameIds: [],
    appearanceGameIds: [],
    gameScores: {},
    gameStates: {},
    scheduledGames: games,
    gamesPlayed: games,
    actualGamesPlayed: appearances,
    gamesLeft: 0,
    fantasyPoints: points,
    frozenProjectionPoints: null,
    frozenProjectionVersion: null,
    frozenProjectionSource: null,
    frozenProjectionSnapshotId: null,
    frozenProjectionGeneratedAt: null,
    frozenProjectionFrozenAt: null,
    frozenProjectionTargetGameIds: [],
    firstScheduledGameDate: null,
    lastScheduledGameDate: null,
  };
}

const SHA_256 = 'a'.repeat(64);

function verifiedProjectionMetadata(overrides = {}) {
  return {
    snapshotId: 'snapshot-1',
    activeSnapshotId: 'snapshot-1',
    status: 'ready',
    projectionVersion: 11,
    draftRankingVersion: 3,
    scoringRulesVersion: 4,
    generatedAt: '2026-10-01T00:00:00.000Z',
    generatedBy: 'server',
    assetCount: 1,
    assetDocumentCount: 1,
    teamCount: 8,
    targetCycleNumber: 1,
    requiredGamesPerCycle: 6,
    generationReason: 'manual',
    draftReadyUntil: '2026-10-02T00:00:00.000Z',
    message: 'Ready',
    generatedByAuthority: 'server',
    authoritySchemaVersion: 2,
    catalogValidationStatus: 'validated',
    catalogSnapshotId: 'catalog-1',
    catalogHash: SHA_256,
    canonicalAssetCount: 1,
    snapshotHashSchemaVersion: 3,
    snapshotHashAlgorithm: 'sha256',
    snapshotIntegrityStatus: 'verified',
    snapshotContentHash: SHA_256,
    snapshotChunkHashes: [SHA_256],
    ...overrides,
  };
}

const projectionVerification = {
  expectedProjectionVersion: 11,
  expectedDraftRankingVersion: 3,
  expectedScoringRulesVersion: 4,
  expectedAuthoritySchemaVersion: 2,
  hashSchemaSupported: true,
};

test('season leaders use completed immutable windows while current leaders remain provisional', () => {
  const completed = windowFor({
    asset: skater('skater-1', 'Completed Center', 'C'),
    ownerId: 'owner-a',
    status: 'complete',
    points: 38,
  });
  const live = windowFor({
    asset: skater('skater-2', 'Live Wing', 'LW'),
    ownerId: 'owner-b',
    status: 'active',
    points: 51,
    games: 4,
  });
  const unstarted = windowFor({
    asset: skater('skater-3', 'Scheduled Defense', 'D'),
    ownerId: 'owner-c',
    status: 'scheduled',
    points: 0,
    games: 0,
  });

  assert.deepEqual(
    buildScoringLeaderRows([completed, live, unstarted], { completedOnly: true }).map((row) => row.assetKey),
    ['skater-1'],
  );
  assert.deepEqual(
    filterAndRankLeaderRows(
      buildScoringLeaderRows([completed, live, unstarted], { completedOnly: false }),
      'ALL',
    ).map((row) => [row.assetKey, row.rank, row.value]),
    [
      ['skater-2', 1, 51],
      ['skater-1', 2, 38],
    ],
  );
});

test('scoring leaders default to points per appearance with total points available separately', () => {
  const oneGame = windowFor({
    asset: skater('skater-26', 'One Game Star', 'C'),
    ownerId: 'owner-a',
    status: 'active',
    points: 26,
    games: 1,
    appearances: 1,
  });
  const sixGames = windowFor({
    asset: skater('skater-60', 'Six Game Star', 'C'),
    ownerId: 'owner-b',
    status: 'active',
    points: 60,
    games: 6,
    appearances: 6,
  });
  const twoAppearances = windowFor({
    asset: skater('skater-24', 'Two Appearance Wing', 'RW'),
    ownerId: 'owner-c',
    status: 'active',
    points: 24,
    games: 6,
    appearances: 2,
  });
  const goalieUnit = windowFor({
    asset: goalie('goalie-unit-rate'),
    ownerId: 'owner-d',
    status: 'active',
    points: 30,
    games: 6,
    appearances: 1,
  });
  const rows = buildScoringLeaderRows(
    [oneGame, sixGames, twoAppearances, goalieUnit],
    { completedOnly: false },
  );

  assert.equal(rows.find((row) => row.assetKey === 'skater-24')?.pointsPerGame, 12);
  assert.equal(rows.find((row) => row.assetKey === 'goalie-unit-rate')?.pointsPerGame, 5);
  assert.deepEqual(
    filterAndRankLeaderRows(rows, 'ALL', 'points-per-game').map((row) => row.assetKey),
    ['skater-26', 'skater-24', 'skater-60', 'goalie-unit-rate'],
  );
  assert.deepEqual(
    filterAndRankLeaderRows(rows, 'ALL', 'total-points').map((row) => row.assetKey),
    ['skater-60', 'goalie-unit-rate', 'skater-26', 'skater-24'],
  );
});

test('historical scoring stays attributed to every fantasy team that earned it', () => {
  const asset = skater('skater-9', 'Moved Player', 'RW');
  const rows = buildScoringLeaderRows([
    windowFor({ asset, ownerId: 'owner-a', status: 'complete', points: 30 }),
    windowFor({ asset, ownerId: 'owner-b', status: 'complete', points: 44 }),
  ], { completedOnly: true });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 74);
  assert.deepEqual(rows[0].ownerContributions, [
    { ownerId: 'owner-b', totalPoints: 44, gamesPlayed: 6, appearances: 6, windowCount: 1 },
    { ownerId: 'owner-a', totalPoints: 30, gamesPlayed: 6, appearances: 6, windowCount: 1 },
  ]);
});

test('exact-position filtering ranks LW, C, RW, D, and goalie units independently', () => {
  const rows = buildScoringLeaderRows([
    windowFor({ asset: skater('skater-1', 'Left Wing', 'LW'), ownerId: 'a', status: 'complete', points: 20 }),
    windowFor({ asset: skater('skater-2', 'Center', 'C'), ownerId: 'a', status: 'complete', points: 50 }),
    windowFor({ asset: skater('skater-3', 'Right Wing', 'RW'), ownerId: 'a', status: 'complete', points: 30 }),
    windowFor({ asset: skater('skater-4', 'Defense', 'D'), ownerId: 'a', status: 'complete', points: 40 }),
    windowFor({ asset: goalie('goalie-unit-VGK'), ownerId: 'a', status: 'complete', points: 60 }),
  ], { completedOnly: true });

  for (const position of ['LW', 'C', 'RW', 'D', 'G']) {
    const filtered = filterAndRankLeaderRows(rows, position);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].position, position);
    assert.equal(filtered[0].rank, 1);
  }
  assert.equal(filterAndRankLeaderRows(rows, 'G')[0].asset.assetType, 'team-goalie-unit');
});

test('projected leaders preserve missing values and show current ownership separately', () => {
  const projected = skater('skater-1', 'Projected Center', 'C', 55);
  const missing = skater('skater-2', 'Missing Wing', 'LW', undefined);
  delete missing.availabilityAdjustedCyclePoints;
  const ownership = new Map([['skater-1', {
    assetKey: 'skater-1',
    ownerId: 'owner-a',
    teamName: 'Rink Raiders',
    managerName: 'Alex',
    area: 'active',
    rosterSlotId: 'C-1',
    slotLabel: 'C1',
  }]]);
  const rows = filterAndRankLeaderRows(
    buildProjectedLeaderRows([missing, projected], ownership),
    'ALL',
  );

  assert.equal(rows[0].assetKey, 'skater-1');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].currentOwnership?.teamName, 'Rink Raiders');
  assert.equal(rows[1].value, null);
  assert.equal(rows[1].rank, null);
  assert.equal(rows[1].currentOwnership, null);
});

test('projected leaders reject emergency and incompletely sealed snapshots without rows', () => {
  const asset = skater('skater-81', 'Verified Player', 'C', 61);
  const verified = {
    metadata: verifiedProjectionMetadata(),
    assets: [asset],
  };

  assert.deepEqual(
    getVerifiedProjectionLeaderAssets(verified, projectionVerification),
    [asset],
  );
  assert.equal(
    getVerifiedProjectionLeaderAssets({
      ...verified,
      metadata: verifiedProjectionMetadata({ generationReason: 'server-emergency' }),
    }, projectionVerification),
    null,
  );
  assert.equal(
    getVerifiedProjectionLeaderAssets({
      ...verified,
      metadata: verifiedProjectionMetadata({ snapshotChunkHashes: [] }),
    }, projectionVerification),
    null,
  );
  assert.equal(
    getVerifiedProjectionLeaderAssets({
      ...verified,
      metadata: verifiedProjectionMetadata({ canonicalAssetCount: 0 }),
    }, projectionVerification),
    null,
  );
  assert.equal(
    getVerifiedProjectionLeaderAssets({
      metadata: verifiedProjectionMetadata({ assetCount: 2, canonicalAssetCount: 2 }),
      assets: [asset],
    }, projectionVerification),
    null,
  );
});

test('overlapping active cycles advance one listener and keep season windows current', () => {
  const cycles = [
    { id: 'cycle-1', cycleNumber: 1, status: 'active' },
    { id: 'cycle-2', cycleNumber: 2, status: 'active' },
  ];
  const assetOne = skater('skater-1', 'Cycle One Player', 'LW');
  const assetTwo = skater('skater-2', 'Cycle Two Player', 'RW');
  const completedOne = windowFor({
    asset: assetOne,
    ownerId: 'owner-a',
    status: 'complete',
    points: 31,
  });
  const staleTwo = {
    ...windowFor({
      asset: assetTwo,
      ownerId: 'owner-b',
      status: 'complete',
      points: 10,
    }),
    id: 'owner-b-cycle-2',
    cycleNumber: 2,
  };
  const freshTwo = { ...staleTwo, fantasyPoints: 42 };

  assert.equal(selectInitialLeaderCycleNumber(cycles), 1);
  assert.equal(areLeaderCycleTeamWindowsComplete([
    { ownerId: 'owner-a', status: 'complete' },
    { ownerId: 'owner-b', status: 'complete' },
  ], ['owner-a', 'owner-b']), true);

  const transition = resolveLeaderCycleCompletion(cycles, 1, 1);
  assert.equal(transition.shouldSwapListener, true);
  assert.equal(transition.nextCycleNumber, 2);
  assert.equal(transition.cycles[0].status, 'complete');

  const replayedOldCallback = resolveLeaderCycleCompletion(
    transition.cycles,
    transition.nextCycleNumber,
    1,
  );
  assert.equal(replayedOldCallback.shouldSwapListener, false);
  assert.equal(replayedOldCallback.nextCycleNumber, 2);

  const seasonRows = filterAndRankLeaderRows(
    buildScoringLeaderRows(
      mergeLeaderWindows([completedOne, staleTwo], [freshTwo]),
      { completedOnly: true },
    ),
    'ALL',
  );
  assert.deepEqual(seasonRows.map((row) => [row.assetKey, row.value]), [
    ['skater-2', 42],
    ['skater-1', 31],
  ]);
});

test('deferred cycle handoff retains a newer completed listener snapshot before teardown', async () => {
  const asset = skater('skater-17', 'Late Corrected Player', 'C');
  const snapshotA = windowFor({
    asset,
    ownerId: 'owner-a',
    status: 'complete',
    points: 24,
  });
  const historyWhileSuccessorRefreshWaits = mergeLeaderWindows([], [snapshotA]);
  const snapshotB = { ...snapshotA, fantasyPoints: 29 };
  const retainedBeforeTeardown = mergeLeaderWindows(
    historyWhileSuccessorRefreshWaits,
    [snapshotA],
    [snapshotB],
  );

  assert.equal(retainedBeforeTeardown.length, 1);
  assert.equal(retainedBeforeTeardown[0].fantasyPoints, 29);

  const component = await read('src/app/features/leaders/point-leaders/point-leaders.ts');
  const latestSnapshotIndex = component.indexOf(
    'const latestCompletedWindows = this.currentWindows();',
  );
  const listenerTeardownIndex = component.indexOf(
    'this.stopCurrentWindowListener?.();',
    latestSnapshotIndex,
  );

  assert.notEqual(latestSnapshotIndex, -1);
  assert.ok(listenerTeardownIndex > latestSnapshotIndex);
  assert.match(
    component.slice(latestSnapshotIndex, listenerTeardownIndex),
    /mergeLeaderWindows\([\s\S]*completedWindows,[\s\S]*latestCompletedWindows/,
  );
});

test('League Leaders uses bounded history, one current listener, lazy projections, and route-only shortcuts', async () => {
  const [
    component,
    template,
    styles,
    cycleService,
    quickNavigation,
    dashboard,
    designSystemTest,
    productDoc,
  ] = await Promise.all([
    read('src/app/features/leaders/point-leaders/point-leaders.ts'),
    read('src/app/features/leaders/point-leaders/point-leaders.html'),
    read('src/app/features/leaders/point-leaders/point-leaders.css'),
    read('src/app/core/cycle/cycle.service.ts'),
    read('src/app/shared/league-quick-navigation/league-quick-navigation.html'),
    read('src/app/features/dashboard/dashboard.html'),
    read('test/design-system/design-system-foundation.test.mjs'),
    read('docs/RINKRAT_PRODUCT_B1W_LEAGUE_LEADERS.md'),
  ]);

  assert.match(component, /getLeagueCycles/);
  assert.match(component, /getCycleTeamWindows/);
  assert.equal((component.match(/listenToCycleTeamWindows\(/g) ?? []).length, 1);
  assert.match(component, /scope === 'projected'[\s\S]*?loadProjectionLeaders/);
  assert.match(component, /getVerifiedProjectionLeaderAssets/);
  assert.match(component, /complete, verified Projection V11 snapshot/);
  assert.match(component, /advanceCompletedCurrentCycle/);
  assert.match(component, /currentWindowListenerGeneration/);
  assert.match(cycleService, /export async function getLeagueCycles/);
  assert.match(template, /Current Matchup/);
  assert.match(template, /Season/);
  assert.match(template, /Projected Next 6/);
  assert.match(component, /selectedScoringMetric = signal<PointLeaderSortMetric>\('points-per-game'\)/);
  assert.match(component, /selectedScope\(\) === 'projected'[\s\S]*?'total-points'/);
  assert.match(template, />Points \/ game<\/button>/);
  assert.match(template, />Total points<\/button>/);
  assert.match(template, /getPrimaryValueLabel\(row\)/);
  assert.match(template, /Scored for/);
  assert.match(template, /Open Player Intel/);
  assert.match(component, /return 'Goalie Units'/);
  assert.match(styles, /@media \(max-width: 390px\)/);
  assert.doesNotMatch(styles, /\.leader-owner[^}]*display:\s*none/);
  assert.match(quickNavigation, /\['\/leagues', leagueId, 'leaders'\][\s\S]*?icon-leaders[\s\S]*?League Leaders/);
  assert.match(dashboard, /class="leaders-shortcut[\s\S]*?\['\/leagues', league\.leagueId, 'leaders'\][\s\S]*?icon-leaders/);
  assert.match(
    designSystemTest,
    /src\/app\/features\/leaders\/point-leaders\/point-leaders\.html/,
  );
  assert.match(productDoc, /deliberately reviewed adopter[\s\S]*design-system migration allowlist/);
  assert.match(productDoc, /points per appearance[\s\S]*total-points option/);
});
