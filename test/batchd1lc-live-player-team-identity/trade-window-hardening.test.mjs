import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const require = createRequire(import.meta.url);
const { resolveLivePlayerTeamWindow } = require(
  `${ROOT_PATH}functions/lib/shared/core/cycle/live-player-team-window.util.js`,
);

const PLAYER_ID = 8482720;
const tradedAsset = {
  assetType: 'skater',
  assetKey: `skater-${PLAYER_ID}`,
  position: 'LW',
  player: {
    id: PLAYER_ID,
    fullName: 'Trade Window Test Skater',
    position: 'LW',
    nhlTeamAbbreviation: 'TOR',
  },
};

function schedule(team, firstId, count, finalGameCount = 0) {
  return Array.from({ length: count }, (_, index) => {
    const gameState = index < finalGameCount ? 'FINAL' : 'FUT';
    const day = String(index + 1).padStart(2, '0');

    return {
      id: firstId + index,
      gameDate: `2026-10-${day}`,
      startTimeUTC: `2026-10-${day}T23:00:00Z`,
      gameType: 2,
      gameState,
      homeTeam: {
        abbrev: team,
        ...(gameState === 'FINAL' ? { score: 3 } : {}),
      },
      awayTeam: {
        abbrev: 'PIT',
        ...(gameState === 'FINAL' ? { score: 2 } : {}),
      },
    };
  });
}

function block(gameIds, blockNumber, requiredGames = 6) {
  const start = (blockNumber - 1) * requiredGames;
  return gameIds.slice(start, start + requiredGames);
}

test('a frozen trade continuation excludes earlier ownership across consecutive windows', () => {
  const tor = schedule('TOR', 1, 24, 8);
  const cbj = schedule('CBJ', 101, 24, 9);
  const cbjPlan = cbj.map((game) => game.id);
  const firstWindow = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 2,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: [7, 8, 9, 10, 11, 12],
      completedGameIds: [7, 8],
      appearanceGameIds: [7, 8],
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'CBJ',
    sourceNhlTargetGameIds: block(cbjPlan, 2),
    sourceNhlGameIdPlan: cbjPlan,
    priorAssignedGameIds: [1, 2, 3, 4, 5, 6],
  });
  const firstWindowGameIds = firstWindow.games.map((game) => game.id);

  assert.deepEqual(firstWindowGameIds, [7, 8, 110, 111, 112, 113]);

  const secondWindow = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 3,
    requiredGamesPerCycle: 6,
    currentTeamAbbreviation: 'CBJ',
    sourceNhlTargetGameIds: block(cbjPlan, 3),
    sourceNhlGameIdPlan: cbjPlan,
    priorAssignedGameIds: [
      1,
      2,
      3,
      4,
      5,
      6,
      ...firstWindowGameIds,
    ],
  });
  const secondWindowGameIds = secondWindow.games.map((game) => game.id);

  assert.deepEqual(secondWindowGameIds, [114, 115, 116, 117, 118, 119]);
  assert.deepEqual(
    firstWindowGameIds.filter((gameId) => secondWindowGameIds.includes(gameId)),
    [],
  );
});

test('live, final, incomplete-final, and appearance ownership survives a trade', () => {
  const tor = schedule('TOR', 1, 12);
  tor[6].gameState = 'FINAL';
  tor[6].homeTeam.score = 3;
  tor[6].awayTeam.score = 2;
  tor[7].gameState = 'LIVE';
  const cbj = schedule('CBJ', 101, 24, 9);
  const cbjPlan = cbj.map((game) => game.id);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 2,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: [7, 8, 9, 10, 11, 12],
      incompleteFinalGameIds: [7],
      liveGameIds: [8],
      appearanceGameIds: [8],
      gameStates: {
        7: 'final',
        8: 'live',
      },
      scheduleTeamAbbreviation: 'TOR',
      sourceTeamAbbreviationByGameId: {
        7: 'TOR',
        8: 'TOR',
      },
    },
    currentTeamAbbreviation: 'CBJ',
    sourceNhlTargetGameIds: block(cbjPlan, 2),
    sourceNhlGameIdPlan: cbjPlan,
  });

  assert.deepEqual(
    resolved.games.map((game) => game.id),
    [7, 8, 110, 111, 112, 113],
  );
  assert.equal(resolved.sourceTeamAbbreviationByGameId['7'], 'TOR');
  assert.equal(resolved.sourceTeamAbbreviationByGameId['8'], 'TOR');
  assert.equal(resolved.sourceTeamAbbreviationByGameId['110'], 'CBJ');
});

test('an immutable game that conflicts with earlier ownership fails visibly', () => {
  const tor = schedule('TOR', 1, 12, 8);
  const cbj = schedule('CBJ', 101, 24, 9);

  assert.throws(
    () => resolveLivePlayerTeamWindow({
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
      sourceNhlTargetGameIds: block(cbj.map((game) => game.id), 2),
      sourceNhlGameIdPlan: cbj.map((game) => game.id),
      priorAssignedGameIds: [7],
    }),
    /immutable NHL window.*earlier ownership.*7/i,
  );
});

test('a frozen target without enough continuation evidence never creates a short window', () => {
  const tor = schedule('TOR', 1, 18);
  const cbj = schedule('CBJ', 101, 18);
  const cbjPlan = cbj.map((game) => game.id);

  assert.throws(
    () => resolveLivePlayerTeamWindow({
      asset: tradedAsset,
      schedulesByTeam: { TOR: tor, CBJ: cbj },
      cycleNumber: 3,
      requiredGamesPerCycle: 6,
      currentTeamAbbreviation: 'CBJ',
      sourceNhlTargetGameIds: block(cbjPlan, 3),
      sourceNhlGameIdPlan: cbjPlan,
      priorAssignedGameIds: [113],
    }),
    /exact 6-game NHL window.*Resolved 5 unique game/i,
  );
});

test('mismatched frozen block and full-plan evidence fails visibly', () => {
  const tor = schedule('TOR', 1, 24);
  const cbj = schedule('CBJ', 101, 24);

  assert.throws(
    () => resolveLivePlayerTeamWindow({
      asset: tradedAsset,
      schedulesByTeam: { TOR: tor, CBJ: cbj },
      cycleNumber: 2,
      requiredGamesPerCycle: 6,
      currentTeamAbbreviation: 'CBJ',
      sourceNhlTargetGameIds: [999, 108, 109, 110, 111, 112],
      sourceNhlGameIdPlan: cbj.map((game) => game.id),
    }),
    /target ids do not match source block 2/i,
  );
});

test('legacy leagues retain earliest-unsettled trade selection without new inputs', () => {
  const tor = schedule('TOR', 1, 6);
  const cbj = schedule('CBJ', 101, 7, 1);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'scheduled',
      scheduledGameIds: tor.map((game) => game.id),
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'CBJ',
  });

  assert.deepEqual(
    resolved.games.map((game) => game.id),
    [102, 103, 104, 105, 106, 107],
  );
});

