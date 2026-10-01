import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const require = createRequire(import.meta.url);
const { resolveLivePlayerTeamWindow } = require(
  `${ROOT_PATH}functions/lib/shared/core/cycle/live-player-team-window.util.js`,
);
const cycleScoring = require(`${ROOT_PATH}functions/lib/shared/core/cycle/cycle-scoring.service.js`);
const nhlApi = require(`${ROOT_PATH}functions/lib/shared/core/nhl/nhl-api.service.js`);
const scoringRules = require(`${ROOT_PATH}functions/lib/shared/core/scoring/scoring-rules.js`);

const PLAYER_ID = 8482720;

const tradedAsset = {
  assetType: 'skater',
  assetKey: `skater-${PLAYER_ID}`,
  position: 'LW',
  player: {
    id: PLAYER_ID,
    fullName: 'Trade Test Skater',
    position: 'LW',
    nhlTeamAbbreviation: 'TOR',
  },
};

function game({
  id,
  date,
  team,
  opponent,
  state,
}) {
  return {
    id,
    gameDate: date,
    startTimeUTC: `${date}T23:00:00Z`,
    gameType: 2,
    gameState: state,
    homeTeam: {
      abbrev: team,
      ...(state === 'FINAL' ? { score: 3 } : {}),
    },
    awayTeam: {
      abbrev: opponent,
      ...(state === 'FINAL' ? { score: 2 } : {}),
    },
  };
}

function schedule(team, firstId, states) {
  return states.map((state, index) => game({
    id: firstId + index,
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    team,
    opponent: team === 'TOR' ? 'MTL' : 'PIT',
    state,
  }));
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

function boxscoreForCurrentTeam() {
  return {
    homeTeam: { abbrev: 'CBJ', score: 1 },
    awayTeam: { abbrev: 'PIT', score: 0 },
    playerByGameStats: {
      homeTeam: {
        forwards: [{
          playerId: PLAYER_ID,
          name: { default: 'Trade Test Skater' },
          position: 'L',
          goals: 1,
          assists: 0,
          points: 1,
          plusMinus: 1,
          hits: 1,
          powerPlayGoals: 0,
          sog: 2,
          toi: '10:00',
          blockedShots: 0,
        }],
        defense: [],
        goalies: [],
      },
      awayTeam: {
        forwards: [],
        defense: [],
        goalies: [],
      },
    },
  };
}

test('a former-club game already in progress stays owned while the unsettled remainder moves', () => {
  const tor = schedule('TOR', 1, ['LIVE', 'FUT', 'FUT', 'FUT', 'FUT', 'FUT']);
  const cbj = schedule('CBJ', 101, ['FINAL', 'LIVE', 'FUT', 'FUT', 'FUT', 'FUT', 'FUT']);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: tor.map((entry) => entry.id),
      completedGameIds: [],
      appearanceGameIds: [],
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'CBJ',
  });

  assert.deepEqual(resolved.games.map((entry) => entry.id), [1, 102, 103, 104, 105, 106]);
  assert.equal(resolved.scheduleTeamAbbreviation, 'CBJ');
  assert.equal(resolved.teamIdentityChanged, true);
  assert.equal(resolved.sourceTeamAbbreviationByGameId['1'], 'TOR');
  assert.equal(resolved.sourceTeamAbbreviationByGameId['102'], 'CBJ');
});

test('completed and appeared games never move when a player changes teams', () => {
  const tor = schedule('TOR', 1, ['FINAL', 'LIVE', 'FUT', 'FUT', 'FUT', 'FUT']);
  const cbj = schedule('CBJ', 101, ['FINAL', 'LIVE', 'FUT', 'FUT', 'FUT', 'FUT']);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: { TOR: tor, CBJ: cbj },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: tor.map((entry) => entry.id),
      completedGameIds: [1],
      appearanceGameIds: [1, 2],
      scheduleTeamAbbreviation: 'TOR',
      sourceTeamAbbreviationByGameId: {
        1: 'TOR',
        2: 'TOR',
      },
    },
    currentTeamAbbreviation: 'CBJ',
  });

  assert.deepEqual(resolved.games.map((entry) => entry.id), [1, 2, 102, 103, 104, 105]);
  assert.equal(resolved.sourceTeamAbbreviationByGameId['1'], 'TOR');
  assert.equal(resolved.sourceTeamAbbreviationByGameId['2'], 'TOR');
  assert.equal(resolved.sourceTeamAbbreviationByGameId['102'], 'CBJ');
});

test('legacy windows keep the player club when the opponent schedule contains the same game', () => {
  const tor = schedule('TOR', 1, ['FINAL', 'FUT', 'FUT', 'FUT', 'FUT', 'FUT']);
  const mtl = tor.map((entry) => ({
    ...entry,
    homeTeam: entry.awayTeam,
    awayTeam: entry.homeTeam,
  }));
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: {
      MTL: mtl,
      TOR: tor,
      CBJ: schedule('CBJ', 101, ['LIVE', 'FUT', 'FUT', 'FUT', 'FUT', 'FUT']),
    },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: tor.map((entry) => entry.id),
      completedGameIds: [1],
      appearanceGameIds: [1],
    },
    currentTeamAbbreviation: 'CBJ',
  });

  assert.equal(resolved.sourceTeamAbbreviationByGameId['1'], 'TOR');
});

test('a published remapped window is stable even after its games become final', () => {
  const cbj = schedule('CBJ', 101, ['FINAL', 'FINAL', 'FUT', 'FUT', 'FUT', 'FUT']);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: {
      TOR: schedule('TOR', 1, ['FINAL', 'FINAL', 'FUT', 'FUT', 'FUT', 'FUT']),
      CBJ: cbj,
    },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'active',
      scheduledGameIds: cbj.map((entry) => entry.id),
      completedGameIds: [101],
      appearanceGameIds: [101],
      scheduleTeamAbbreviation: 'CBJ',
      sourceTeamAbbreviationByGameId: Object.fromEntries(
        cbj.map((entry) => [String(entry.id), 'CBJ']),
      ),
    },
    currentTeamAbbreviation: 'CBJ',
  });

  assert.deepEqual(resolved.games.map((entry) => entry.id), cbj.map((entry) => entry.id));
});

test('a complete window remains immutable after a later NHL trade', () => {
  const tor = schedule('TOR', 1, ['FINAL', 'FINAL', 'FINAL', 'FINAL', 'FINAL', 'FINAL']);
  const resolved = resolveLivePlayerTeamWindow({
    asset: tradedAsset,
    schedulesByTeam: {
      TOR: tor,
      CBJ: schedule('CBJ', 101, ['FUT', 'FUT', 'FUT', 'FUT', 'FUT', 'FUT']),
    },
    cycleNumber: 1,
    requiredGamesPerCycle: 6,
    previous: {
      status: 'complete',
      scheduledGameIds: tor.map((entry) => entry.id),
      completedGameIds: tor.map((entry) => entry.id),
      appearanceGameIds: tor.map((entry) => entry.id),
      scheduleTeamAbbreviation: 'TOR',
    },
    currentTeamAbbreviation: 'CBJ',
  });

  assert.deepEqual(resolved.games.map((entry) => entry.id), tor.map((entry) => entry.id));
  assert.equal(resolved.scheduleTeamAbbreviation, 'TOR');
});

test('live scoring uses the current-team game and stable player id, not the stale team game', async (t) => {
  const tor = schedule('TOR', 1, ['LIVE', 'FUT', 'FUT', 'FUT', 'FUT', 'FUT']);
  const cbj = schedule('CBJ', 101, ['LIVE', 'FUT', 'FUT', 'FUT', 'FUT', 'FUT']);

  t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async (team) =>
    team === 'CBJ' ? cbj : tor
  );
  t.mock.method(nhlApi, 'getGameBoxscore', async (gameId) => {
    assert.equal(gameId, 101);
    return boxscoreForCurrentTeam();
  });
  t.mock.method(nhlApi, 'getGamePlayByPlay', async () => ({ plays: [] }));
  t.mock.method(nhlApi, 'getRegularSeasonGameLog', async () => ({ gameLog: [] }));

  const result = await cycleScoring.calculateCycleScoring({
    picks: [scoringPick()],
    cycleNumber: 1,
    season: '20262027',
    requiredGamesPerCycle: 6,
    scoringRules: scoringRules.defaultScoringRules,
    currentTeamAbbreviationByPlayerId: new Map([[PLAYER_ID, 'CBJ']]),
    currentTeamConfirmedAtByPlayerId: new Map([
      [PLAYER_ID, '2026-10-01T22:00:00Z'],
    ]),
    currentTeamIdentityHash: 'test-current-team-identity',
    currentTeamIdentityGeneratedAt: '2026-10-01T23:01:00Z',
  });
  const summary = result.windowScores['owner-a__LW-1__cycle-1'];

  assert.deepEqual(summary.scheduledGameIds, cbj.map((entry) => entry.id));
  assert.deepEqual(summary.liveGameIds, [101]);
  assert.equal(summary.gameScores['101'] > 0, true);
  assert.equal(summary.gameScores['1'], undefined);
  assert.equal(summary.scheduleTeamAbbreviation, 'CBJ');
  assert.equal(summary.sourceTeamAbbreviationByGameId['101'], 'CBJ');
  assert.equal(summary.teamIdentityChanged, true);
});

test('server scoring loads one shared current-team catalog and historical replay bypasses it', async () => {
  const [automation, scorer, identityService, dashboard, detail] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
    read('functions/src/shared/core/nhl/nhl-player-team-identity.service.ts'),
    read('src/app/core/league/dashboard-league-activity.util.ts'),
    read('src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.ts'),
  ]);

  assert.match(automation, /replayControl\s*\?\s*null\s*:\s*await phaseTimer\.measure\([\s\S]*?loadCurrentNhlPlayerTeamIdentity/);
  assert.match(automation, /currentTeamAbbreviationByPlayerId:\s*livePlayerTeamIdentity\?\.byPlayerId/);
  assert.match(automation, /currentTeamConfirmedAtByPlayerId:\s*livePlayerTeamIdentity\?\.teamConfirmedAtByPlayerId/);
  assert.match(scorer, /sourceTeamAbbreviationByGameId/);
  assert.match(identityService, /Scoring was left unchanged and will retry/);
  assert.match(identityService, /getCurrentNhlDraftSkaters\(true\)/);
  assert.match(dashboard, /assetWindow\?\.scheduleTeamAbbreviation/);
  assert.match(detail, /this\.scoreSummary\(\)\?\.scheduleTeamAbbreviation/);
});
