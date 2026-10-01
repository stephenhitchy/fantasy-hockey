import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const require = createRequire(import.meta.url);
const { resolveLivePlayerTeamWindow: resolveLivePlayerTeamWindowBase } = require(
  `${ROOT_PATH}functions/lib/shared/core/cycle/live-player-team-window.util.js`,
);
const resolveLivePlayerTeamWindow = (input) =>
  resolveLivePlayerTeamWindowBase({
    scheduleDecisionAtMilliseconds: Date.parse('2026-09-30T00:00:00Z'),
    ...input,
  });
const cycleScoring = require(
  `${ROOT_PATH}functions/lib/shared/core/cycle/cycle-scoring.service.js`,
);
const nhlApi = require(
  `${ROOT_PATH}functions/lib/shared/core/nhl/nhl-api.service.js`,
);
const scoringRules = require(
  `${ROOT_PATH}functions/lib/shared/core/scoring/scoring-rules.js`,
);

const PLAYER_ID = 8482720;
const tradedAsset = {
  assetType: 'skater',
  assetKey: `skater-${PLAYER_ID}`,
  position: 'LW',
  player: {
    id: PLAYER_ID,
    fullName: 'Trade Continuity Test Skater',
    position: 'LW',
    nhlTeamAbbreviation: 'TOR',
  },
};

function game(id, team, state = 'FUT') {
  const day = ((id - 1) % 28) + 1;

  return {
    id,
    gameDate: `2026-10-${String(day).padStart(2, '0')}`,
    startTimeUTC: `2026-10-${String(day).padStart(2, '0')}T23:00:00Z`,
    gameType: 2,
    gameState: state,
    homeTeam: {
      abbrev: team,
      ...(state === 'FINAL' ? { score: 3 } : {}),
    },
    awayTeam: {
      abbrev: team === 'TOR' ? 'MTL' : 'PIT',
      ...(state === 'FINAL' ? { score: 2 } : {}),
    },
  };
}

function schedule(team, firstId, count, states = {}) {
  return Array.from({ length: count }, (_, index) => {
    const id = firstId + index;
    return game(id, team, states[id] ?? 'FUT');
  });
}

function ids(result) {
  return result.games.map((entry) => entry.id);
}

function scoringPick() {
  return {
    overallPick: 1,
    round: 1,
    pickInRound: 1,
    ownerId: 'owner-a',
    rosterSlotId: 'LW-1',
    cycleWindowId: 'owner-a__LW-1__cycle-1',
    snapshotCycleNumber: 1,
    asset: tradedAsset,
  };
}

function secondScoringPick() {
  const playerId = 8478402;

  return {
    overallPick: 2,
    round: 1,
    pickInRound: 2,
    ownerId: 'owner-b',
    rosterSlotId: 'C-1',
    cycleWindowId: 'owner-b__C-1__cycle-1',
    snapshotCycleNumber: 1,
    asset: {
      ...tradedAsset,
      assetKey: `skater-${playerId}`,
      position: 'C',
      player: {
        ...tradedAsset.player,
        id: playerId,
        fullName: 'Second Fingerprint Test Skater',
        position: 'C',
      },
    },
  };
}

test('current-affiliation appearance proof fails closed for an ambiguous same-day team change', () => {
  assert.throws(
    () => cycleScoring.getCurrentAffiliationAppearanceGameIds([
      { gameId: 9002, teamAbbrev: 'CBJ', gameDate: '2026-10-01' },
      { gameId: 9001, teamAbbrev: 'TOR', gameDate: '2026-10-01' },
    ], 'CBJ'),
    /multiple team affiliations.*does not provide exact game times/,
  );
});

test('current-affiliation appearance proof keeps only games after an unambiguous team-change date', () => {
  assert.deepEqual(
    cycleScoring.getCurrentAffiliationAppearanceGameIds([
      { gameId: 12, teamAbbrev: 'CBJ', gameDate: '2026-10-04' },
      { gameId: 2, teamAbbrev: 'TOR', gameDate: '2026-10-02' },
      { gameId: 11, teamAbbrev: 'CBJ', gameDate: '2026-10-03' },
      { gameId: 1, teamAbbrev: 'TOR', gameDate: '2026-10-01' },
    ], 'CBJ'),
    [11, 12],
  );
});

test('a team change protects every started or settled ownership signal', () => {
  const tor = schedule('TOR', 1, 6, { 2: 'LIVE' });
  const cbj = schedule('CBJ', 101, 12);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: [1, 2, 3, 4, 5, 6],
      completedGameIds: [1],
      liveGameIds: [2],
      incompleteFinalGameIds: [3],
      appearanceGameIds: [4],
      gameStates: { 5: 'final' },
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
  });

  assert.deepEqual(ids(resolved), [1, 2, 3, 4, 5, 101]);
  assert.equal(resolved.sourceTeamAbbreviationByGameId['5'], 'TOR');
  assert.equal(resolved.sourceTeamAbbreviationByGameId['101'], 'CBJ');
});

test('a game that became live after the saved snapshot cannot be remapped away', () => {
  const tor = schedule('TOR', 1, 6, { 2: 'LIVE' });
  const cbj = schedule('CBJ', 101, 12);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'scheduled',
      scheduledGameIds: [1, 2, 3, 4, 5, 6],
      gameStates: {
        1: 'scheduled',
        2: 'scheduled',
        3: 'scheduled',
        4: 'scheduled',
        5: 'scheduled',
        6: 'scheduled',
      },
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
  });

  assert.deepEqual(ids(resolved), [2, 101, 102, 103, 104, 105]);
  assert.equal(resolved.sourceTeamAbbreviationByGameId['2'], 'TOR');
});

test('a stale FUT former-club game at puck drop cannot be remapped away', () => {
  const tor = schedule('TOR', 1, 6);
  const cbj = schedule('CBJ', 101, 12);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'scheduled',
      scheduledGameIds: tor.map((entry) => entry.id),
      gameStates: Object.fromEntries(
        tor.map((entry) => [String(entry.id), 'scheduled']),
      ),
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
    scheduleDecisionAtMilliseconds: Date.parse(tor[0].startTimeUTC),
  });

  assert.deepEqual(ids(resolved), [1, 101, 102, 103, 104, 105]);
  assert.equal(resolved.sourceTeamAbbreviationByGameId['1'], 'TOR');
});

test('a genuinely future former-club game remains eligible for transfer remapping', () => {
  const tor = schedule('TOR', 1, 6);
  const cbj = schedule('CBJ', 101, 12);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'scheduled',
      scheduledGameIds: tor.map((entry) => entry.id),
      gameStates: Object.fromEntries(
        tor.map((entry) => [String(entry.id), 'scheduled']),
      ),
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
    scheduleDecisionAtMilliseconds: Date.parse(tor[0].startTimeUTC) - 1,
  });

  assert.deepEqual(ids(resolved), [101, 102, 103, 104, 105, 106]);
});

test('a stale FUT destination game at puck drop fails closed during a transfer cutover', () => {
  const cbj = schedule('CBJ', 101, 12);

  assert.throws(
    () => resolveLivePlayerTeamWindow({
      asset: tradedAsset,
      schedulesByTeam: { CBJ: cbj },
      cycleNumber: 1,
      requiredGamesPerCycle: 6,
      currentTeamAbbreviation: 'CBJ',
      seasonSourceGameIds: cbj.map((entry) => entry.id),
      scheduleDecisionAtMilliseconds: Date.parse(cbj[0].startTimeUTC),
    }),
    /reached its scheduled start.*cannot prove the player-team identity cutover/,
  );
});

test('explicit postponed or canceled evidence is not inferred as puck drop', () => {
  for (const gameScheduleState of ['PPD', 'CANCELLED']) {
    const tor = schedule('TOR', 1, 6);
    const cbj = schedule('CBJ', 101, 12);
    tor[0].gameScheduleState = gameScheduleState;
    const resolved = resolveLivePlayerTeamWindow({
      asset: tradedAsset,
      schedulesByTeam: { TOR: tor, CBJ: cbj },
      cycleNumber: 1,
      requiredGamesPerCycle: 6,
      previous: {
        status: 'scheduled',
        scheduledGameIds: tor.map((entry) => entry.id),
        scheduleTeamAbbreviation: 'TOR',
      },
      currentTeamAbbreviation: 'CBJ',
      seasonSourceGameIds: cbj.map((entry) => entry.id),
      scheduleDecisionAtMilliseconds: Date.parse(tor[0].startTimeUTC),
    });

    assert.deepEqual(
      ids(resolved),
      [101, 102, 103, 104, 105, 106],
      `${gameScheduleState} should preserve explicit deferred-game semantics`,
    );
  }
});

test('a fresh fantasy activation excludes destination games that already started', () => {
  const cbj = schedule('CBJ', 101, 12, {
    101: 'FINAL',
    102: 'LIVE',
  });
  const activationMilliseconds = Date.parse(cbj[2].startTimeUTC) - 1;
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
    assignmentNotBeforeMilliseconds: activationMilliseconds,
    confirmedCurrentTeamAppearanceGameIds: [101, 102],
  });

  assert.deepEqual(ids(resolved), [103, 104, 105, 106, 107, 108]);
});

test('a destination game already live when a trade is detected blocks an ambiguous cutover', () => {
  const cbj = schedule('CBJ', 101, 12, { 101: 'LIVE' });
  const detectedAt = Date.parse(cbj[0].startTimeUTC) + 60_000;

  assert.throws(
    () => resolveLivePlayerTeamWindow({
      asset: tradedAsset,
      schedulesByTeam: { CBJ: cbj },
      cycleNumber: 1,
      requiredGamesPerCycle: 6,
      currentTeamAbbreviation: 'CBJ',
      seasonSourceGameIds: cbj.map((entry) => entry.id),
      teamIdentityNotBeforeMilliseconds: detectedAt,
    }),
    /started before the player's current-team identity was confirmed/,
  );
});

test('live and final cutover games without exact startTimeUTC fail closed', () => {
  for (const state of ['LIVE', 'FINAL']) {
    const cbj = schedule('CBJ', 101, 12, { 101: state });
    delete cbj[0].startTimeUTC;

    assert.throws(
      () => resolveLivePlayerTeamWindow({
        asset: tradedAsset,
        schedulesByTeam: { CBJ: cbj },
        cycleNumber: 1,
        requiredGamesPerCycle: 6,
        currentTeamAbbreviation: 'CBJ',
        seasonSourceGameIds: cbj.map((entry) => entry.id),
        teamIdentityNotBeforeMilliseconds: Date.parse(
          '2026-10-01T22:00:00Z',
        ),
        confirmedCurrentTeamAppearanceGameIds: [101],
      }),
      /exact startTimeUTC is unavailable/,
      `${state} game without puck-drop time must not use a date-derived boundary`,
    );
  }
});

test('an already-owned cross-team game is excluded before live cutover ambiguity', () => {
  const sharedGame = game(1, 'TOR', 'LIVE');
  sharedGame.awayTeam = { abbrev: 'CBJ' };
  const tor = [sharedGame, ...schedule('TOR', 2, 5)];
  const cbj = [sharedGame, ...schedule('CBJ', 101, 11)];
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: tor.map((entry) => entry.id),
      liveGameIds: [sharedGame.id],
      scheduleTeamAbbreviation: 'TOR',
      sourceTeamAbbreviationByGameId: {
        [String(sharedGame.id)]: 'TOR',
      },
    },
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
    teamIdentityNotBeforeMilliseconds:
      Date.parse(sharedGame.startTimeUTC) + 60_000,
  });

  assert.deepEqual(ids(resolved), [1, 101, 102, 103, 104, 105]);
  assert.equal(resolved.sourceTeamAbbreviationByGameId['1'], 'TOR');
});

test('scoring rejects live identity boundaries without exact puck-drop time', async (t) => {
  const tor = schedule('TOR', 1, 6);
  const cbj = schedule('CBJ', 101, 6, { 101: 'LIVE' });
  delete cbj[0].startTimeUTC;

  t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async (team) =>
    team === 'CBJ' ? cbj : tor
  );

  await assert.rejects(
    cycleScoring.calculateCycleScoring({
      picks: [scoringPick()],
      cycleNumber: 1,
      season: '20262027',
      requiredGamesPerCycle: 6,
      scoringRules: scoringRules.defaultScoringRules,
      currentTeamAbbreviationByPlayerId: new Map([[PLAYER_ID, 'CBJ']]),
      currentTeamConfirmedAtByPlayerId: new Map([
        [PLAYER_ID, '2026-10-01T22:00:00Z'],
      ]),
      currentTeamIdentityHash: 'missing-puck-drop-boundary-test',
      currentTeamIdentityGeneratedAt: '2026-10-01T23:30:00Z',
    }),
    /exact startTimeUTC is unavailable/,
  );
});

test('scoring refreshes identity evidence when cached FUT state is past puck drop', async (t) => {
  const tor = schedule('TOR', 1, 6).map((entry, index) => ({
    ...entry,
    gameDate: `2000-01-${String(index + 1).padStart(2, '0')}`,
    startTimeUTC: `2000-01-${String(index + 1).padStart(2, '0')}T23:00:00Z`,
  }));

  t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async () => tor);

  await assert.rejects(
    cycleScoring.calculateCycleScoring({
      picks: [scoringPick()],
      cycleNumber: 1,
      season: '20262027',
      requiredGamesPerCycle: 6,
      scoringRules: scoringRules.defaultScoringRules,
      currentTeamAbbreviationByPlayerId: new Map([[PLAYER_ID, 'TOR']]),
      currentTeamConfirmedAtByPlayerId: new Map([
        [PLAYER_ID, '1999-12-01T00:00:00Z'],
      ]),
      currentTeamIdentityHash: 'stale-fut-identity-boundary-test',
      currentTeamIdentityGeneratedAt: '1999-12-01T00:00:00Z',
    }),
    /predates a game that has now started/,
  );
});

test('scoring fingerprints only identity evidence for skaters in the current picks', async (t) => {
  t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async (team) =>
    schedule(team, team === 'TOR' ? 201 : 301, 6)
  );
  t.mock.method(nhlApi, 'getRegularSeasonGameLog', async () => ({
    gameLog: [],
  }));

  const calculate = ({
    catalogHash,
    generatedAt,
    teams,
    confirmations,
    picks = [secondScoringPick(), scoringPick()],
  }) => cycleScoring.calculateCycleScoring({
    picks,
    cycleNumber: 1,
    season: '20262027',
    requiredGamesPerCycle: 6,
    scoringRules: scoringRules.defaultScoringRules,
    currentTeamAbbreviationByPlayerId: new Map(teams),
    currentTeamConfirmedAtByPlayerId: new Map(confirmations),
    currentTeamIdentityHash: catalogHash,
    currentTeamIdentityGeneratedAt: generatedAt,
  });
  const baseline = await calculate({
    catalogHash: 'full-catalog-a',
    generatedAt: '2026-09-01T00:00:00.000Z',
    teams: [
      [PLAYER_ID, 'TOR'],
      [8478402, 'TOR'],
    ],
    confirmations: [
      [PLAYER_ID, '2026-08-01T00:00:00.000Z'],
      [8478402, '2026-07-01T00:00:00.000Z'],
    ],
  });
  const unrelatedCatalogChange = await calculate({
    catalogHash: 'full-catalog-b',
    generatedAt: '2026-09-02T00:00:00.000Z',
    teams: [
      [PLAYER_ID, ' tor '],
      [8471214, 'VAN'],
      [8478402, 'TOR'],
    ],
    confirmations: [
      [PLAYER_ID, '2026-08-01T00:00:00.000Z'],
      [8471214, '2026-09-02T00:00:00.000Z'],
      [8478402, '2026-07-01T00:00:00.000Z'],
    ],
  });

  assert.equal(
    unrelatedCatalogChange.dataFingerprint,
    baseline.dataFingerprint,
    'an unrelated catalog player, aggregate hash, and refresh time must not trigger a scoring rewrite',
  );
  assert.equal(unrelatedCatalogChange.nhlPlayerTeamIdentityHash, 'full-catalog-b');
  assert.equal(
    unrelatedCatalogChange.nhlPlayerTeamIdentityGeneratedAt,
    '2026-09-02T00:00:00.000Z',
  );
  assert.equal(baseline.dataFingerprint.includes('full-catalog-a'), false);
  const expectedSubsetDigest = createHash('sha256')
    .update(JSON.stringify([
      {
        playerId: 8478402,
        teamAbbreviation: 'TOR',
        teamConfirmedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        playerId: PLAYER_ID,
        teamAbbreviation: 'TOR',
        teamConfirmedAt: '2026-08-01T00:00:00.000Z',
      },
    ]))
    .digest('hex');
  assert.equal(
    baseline.dataFingerprint.split('|')[1],
    `nhl-player-team-identity-subset-v1:${expectedSubsetDigest}`,
  );

  const changedConfirmation = await calculate({
    catalogHash: 'full-catalog-c',
    generatedAt: '2026-09-03T00:00:00.000Z',
    teams: [
      [PLAYER_ID, 'TOR'],
      [8478402, 'TOR'],
    ],
    confirmations: [
      [PLAYER_ID, '2026-08-02T00:00:00.000Z'],
      [8478402, '2026-07-01T00:00:00.000Z'],
    ],
  });
  assert.notEqual(changedConfirmation.dataFingerprint, baseline.dataFingerprint);

  const changedTeam = await calculate({
    catalogHash: 'full-catalog-d',
    generatedAt: '2026-09-04T00:00:00.000Z',
    teams: [
      [PLAYER_ID, 'CBJ'],
      [8478402, 'TOR'],
    ],
    confirmations: [
      [PLAYER_ID, '2026-08-01T00:00:00.000Z'],
      [8478402, '2026-07-01T00:00:00.000Z'],
    ],
  });
  assert.notEqual(
    changedTeam.dataFingerprint.split('|')[1],
    baseline.dataFingerprint.split('|')[1],
    'a current-pick player team change must alter the identity subset digest',
  );
});

test('a proven destination appearance can bridge delayed trade detection', () => {
  const cbj = schedule('CBJ', 101, 12, { 101: 'FINAL' });
  const detectedAt = Date.parse(cbj[0].startTimeUTC) + 60_000;
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
    teamIdentityNotBeforeMilliseconds: detectedAt,
    confirmedCurrentTeamAppearanceGameIds: [101],
  });

  assert.deepEqual(ids(resolved), [101, 102, 103, 104, 105, 106]);
});

test('a post-confirmation scratch still consumes the destination team game', () => {
  const cbj = schedule('CBJ', 101, 12, { 101: 'FINAL' });
  const detectedAt = Date.parse(cbj[0].startTimeUTC) - 60_000;
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
    teamIdentityNotBeforeMilliseconds: detectedAt,
  });

  assert.deepEqual(ids(resolved), [101, 102, 103, 104, 105, 106]);
});

test('a trade cutover excludes old final candidates unless stable-id appearance is confirmed', () => {
  const tor = schedule('TOR', 1, 6);
  const cbj = schedule('CBJ', 101, 12, {
    101: 'FINAL',
    102: 'FINAL',
  });
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: [1, 2, 3, 4, 5, 6],
      completedGameIds: [1],
      appearanceGameIds: [1, 2],
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
    confirmedCurrentTeamAppearanceGameIds: [102],
  });

  assert.deepEqual(ids(resolved), [1, 2, 102, 103, 104, 105]);
  assert.equal(ids(resolved).includes(101), false);
});

test('an initial unpublished window preserves its exact frozen ids including finals', () => {
  const cbj = schedule('CBJ', 101, 12, { 101: 'FINAL' });
  const frozenIds = [101, 102, 103, 104, 105, 106];
  const currentClubAsset = {
    ...tradedAsset,
    player: {
      ...tradedAsset.player,
      nhlTeamAbbreviation: 'CBJ',
    },
  };
  const resolved = resolveLivePlayerTeamWindow({
    asset: currentClubAsset,
    schedulesByTeam: { CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    currentTeamAbbreviation: 'CBJ',
    sourceNhlTargetGameIds: frozenIds,
  });

  assert.deepEqual(ids(resolved), frozenIds);
});

test('an unpublished stale-team assignment skips unproven destination finals', () => {
  const cbj = schedule('CBJ', 101, 12, {
    101: 'FINAL',
    102: 'FINAL',
    103: 'LIVE',
  });
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    currentTeamAbbreviation: 'CBJ',
    sourceNhlTargetGameIds: [101, 102, 103, 104, 105, 106],
    seasonSourceGameIds: cbj.map((entry) => entry.id),
  });

  assert.deepEqual(ids(resolved), [103, 104, 105, 106, 107, 108]);
});

test('the next same-team window consumes remap spillover before its nominal block', () => {
  const cbj = schedule('CBJ', 101, 18);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { CBJ: cbj },
    cycleNumber: 2,
    requiredGamesPerCycle: 6,
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
    priorAssignedGameIds: [1, 2, 101, 102, 103, 104],
    continuityScheduleTeamAbbreviation: 'CBJ',
  });

  assert.deepEqual(ids(resolved), [105, 106, 107, 108, 109, 110]);
  assert.equal(ids(resolved).some((id) => [101, 102, 103, 104].includes(id)), false);
});

test('the next same-team window continues after spillover when the destination club was ahead', () => {
  const cbj = schedule('CBJ', 101, 18, {
    101: 'FINAL',
    102: 'FINAL',
    103: 'FINAL',
    104: 'FINAL',
    105: 'FINAL',
    106: 'FINAL',
    107: 'FINAL',
    108: 'FINAL',
    109: 'FINAL',
    110: 'FINAL',
    111: 'FINAL',
    112: 'FINAL',
  });
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { CBJ: cbj },
    cycleNumber: 2,
    requiredGamesPerCycle: 6,
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
    priorAssignedGameIds: [1, 2, 3, 110, 111, 112],
    continuityScheduleTeamAbbreviation: 'CBJ',
  });

  assert.deepEqual(ids(resolved), [113, 114, 115, 116, 117, 118]);
});

test('a second affiliation cutover does not backfill games played while absent', () => {
  const tor = schedule('TOR', 201, 18, {
    201: 'FINAL',
    202: 'FINAL',
    203: 'FINAL',
    204: 'FINAL',
    205: 'FINAL',
    206: 'FINAL',
    207: 'FINAL',
  });
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor },
    cycleNumber: 2,
    requiredGamesPerCycle: 6,
    currentTeamAbbreviation: 'TOR',
    seasonSourceGameIds: tor.map((entry) => entry.id),
    priorAssignedGameIds: [201, 202, 203, 204],
    continuityScheduleTeamAbbreviation: 'CBJ',
  });

  assert.deepEqual(ids(resolved), [208, 209, 210, 211, 212, 213]);
});

test('a destination club behind the former club starts with its next game instead of skipping to the nominal ordinal', () => {
  const tor = schedule('TOR', 1, 12, {
    1: 'FINAL',
    2: 'FINAL',
    3: 'FINAL',
    4: 'FINAL',
    5: 'FINAL',
    6: 'FINAL',
    7: 'FINAL',
    8: 'LIVE',
  });
  const cbj = schedule('CBJ', 101, 12, {
    101: 'FINAL',
    102: 'FINAL',
    103: 'FINAL',
    104: 'FINAL',
    105: 'LIVE',
  });
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 2,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: [7, 8, 9, 10, 11, 12],
      completedGameIds: [7],
      liveGameIds: [8],
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
  });

  assert.deepEqual(ids(resolved), [7, 8, 105, 106, 107, 108]);
});

test('a delayed trade detection keeps a proven new-team appearance before the nominal block', () => {
  const tor = schedule('TOR', 1, 12, {
    7: 'FINAL',
    8: 'FINAL',
  });
  const cbj = schedule('CBJ', 101, 12, {
    101: 'FINAL',
    102: 'FINAL',
    103: 'FINAL',
    104: 'FINAL',
    105: 'FINAL',
  });
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 2,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: [7, 8, 9, 10, 11, 12],
      completedGameIds: [7, 8],
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'CBJ',
    seasonSourceGameIds: cbj.map((entry) => entry.id),
    confirmedCurrentTeamAppearanceGameIds: [105],
  });

  assert.deepEqual(ids(resolved), [7, 8, 105, 106, 107, 108]);
});

test('cycle scoring forwards a proven destination appearance before the frozen nominal block', async (t) => {
  const now = Date.now();
  const buildRelativeGame = (id, team, startMilliseconds, state = 'FUT') => ({
    id,
    gameDate: new Date(startMilliseconds).toISOString().slice(0, 10),
    startTimeUTC: new Date(startMilliseconds).toISOString(),
    gameType: 2,
    gameState: state,
    homeTeam: {
      abbrev: team,
      ...(state === 'FINAL' ? { score: 3 } : {}),
    },
    awayTeam: {
      abbrev: team === 'TOR' ? 'MTL' : 'PIT',
      ...(state === 'FINAL' ? { score: 2 } : {}),
    },
  });
  const tor = Array.from({ length: 12 }, (_, index) =>
    buildRelativeGame(1 + index, 'TOR', now + (index + 1) * 86_400_000)
  );
  const cbj = Array.from({ length: 12 }, (_, index) => {
    const id = 101 + index;
    const isProvenAppearance = id === 105;
    const isEarlierFinal = id < 105;
    const startMilliseconds = isProvenAppearance
      ? now - 2 * 60 * 60 * 1000
      : isEarlierFinal
        ? now - (6 - index) * 86_400_000
        : now + (index - 3) * 86_400_000;

    return buildRelativeGame(
      id,
      'CBJ',
      startMilliseconds,
      isProvenAppearance || isEarlierFinal ? 'FINAL' : 'FUT',
    );
  });
  const appearance = cbj.find((entry) => entry.id === 105);
  const gameLogEntry = {
    gameId: 105,
    teamAbbrev: 'CBJ',
    homeRoadFlag: 'H',
    gameDate: appearance.gameDate,
    goals: 1,
    assists: 0,
    points: 1,
    plusMinus: 1,
    powerPlayPoints: 0,
    gameWinningGoals: 0,
    otGoals: 0,
    shots: 2,
    shorthandedPoints: 0,
    toi: '10:00',
    opponentAbbrev: 'PIT',
  };

  t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async (team) =>
    team === 'CBJ' ? cbj : tor
  );
  t.mock.method(nhlApi, 'getRegularSeasonGameLog', async () => ({
    gameLog: [gameLogEntry],
  }));
  t.mock.method(nhlApi, 'getGameBoxscore', async (gameId) => {
    assert.equal(gameId, 105);
    return {
      homeTeam: { abbrev: 'CBJ', score: 3 },
      awayTeam: { abbrev: 'PIT', score: 2 },
      playerByGameStats: {
        homeTeam: {
          forwards: [{
            playerId: PLAYER_ID,
            name: { default: 'Trade Continuity Test Skater' },
            position: 'L',
            goals: 1,
            assists: 0,
            points: 1,
            plusMinus: 1,
            hits: 0,
            powerPlayGoals: 0,
            sog: 2,
            toi: '10:00',
            blockedShots: 0,
          }],
          defense: [],
          goalies: [],
        },
        awayTeam: { forwards: [], defense: [], goalies: [] },
      },
    };
  });
  t.mock.method(nhlApi, 'getGamePlayByPlay', async () => ({
    plays: [{
      eventId: 1,
      typeDescKey: 'goal',
      details: {
        scoringPlayerId: PLAYER_ID,
        homeScore: 1,
        awayScore: 0,
      },
    }],
  }));

  const pick = {
    ...scoringPick(),
    cycleWindowId: 'owner-a__LW-1__cycle-2',
    snapshotCycleNumber: 2,
    sourceNhlBlockNumber: 2,
    sourceNhlTargetGameIds: [7, 8, 9, 10, 11, 12],
    sourceNhlTargetGameIdsByTeam: {
      TOR: [7, 8, 9, 10, 11, 12],
      CBJ: [107, 108, 109, 110, 111, 112],
    },
    playerWindowContinuity: {
      schemaVersion: 1,
      continuityId: 'owner-a::LW-1::skater-8482720::draft-1',
      ownerId: 'owner-a',
      rosterSlotId: 'LW-1',
      assetKey: 'skater-8482720',
      priorAssignedGameIds: [1, 2, 3, 4, 5, 6],
      lastScheduleTeamAbbreviation: 'TOR',
    },
  };
  const result = await cycleScoring.calculateCycleScoring({
    picks: [pick],
    cycleNumber: 2,
    season: '20262027',
    requiredGamesPerCycle: 6,
    scoringRules: scoringRules.defaultScoringRules,
    currentTeamAbbreviationByPlayerId: new Map([[PLAYER_ID, 'CBJ']]),
    currentTeamConfirmedAtByPlayerId: new Map([
      [PLAYER_ID, new Date(now - 60 * 60 * 1000).toISOString()],
    ]),
    currentTeamIdentityHash: 'pre-nominal-appearance-test',
    currentTeamIdentityGeneratedAt: new Date(now - 30 * 60 * 1000).toISOString(),
    sourceNhlTargetGameIdsByTeam: {
      TOR: [7, 8, 9, 10, 11, 12],
      CBJ: [107, 108, 109, 110, 111, 112],
    },
    seasonSourceGameIdsByTeam: {
      TOR: tor.map((entry) => entry.id),
      CBJ: cbj.map((entry) => entry.id),
    },
  });

  assert.deepEqual(
    result.windowScores[pick.cycleWindowId].scheduledGameIds,
    [105, 106, 107, 108, 109, 110],
  );
});

test('new assignments fail visibly when six unique eligible games are unavailable', () => {
  const cbj = schedule('CBJ', 101, 5);

  assert.throws(
    () => resolveLivePlayerTeamWindow({
      asset: tradedAsset,
      schedulesByTeam: { CBJ: cbj },
      cycleNumber: 1,
      requiredGamesPerCycle: 6,
      currentTeamAbbreviation: 'CBJ',
      sourceNhlTargetGameIds: cbj.map((entry) => entry.id),
    }),
    /Unable to assign exactly 6 unique NHL games/,
  );
});

test('an already published short legacy window remains immutable', () => {
  const tor = schedule('TOR', 1, 5);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: [1, 2, 3, 4, 5],
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'TOR',
  });

  assert.deepEqual(ids(resolved), [1, 2, 3, 4, 5]);
});
