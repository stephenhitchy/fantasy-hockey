import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeOfflineMatchupSnapshot } from '../../src/app/core/pwa/offline-matchup-snapshot.util.ts';
import { getMobileGameMarkerExplanation } from '../../src/app/features/cycles/cycle-one/cycle-mobile-matchup.util.ts';
import { resolveCycleWindowGameMarkerState } from '../../src/app/features/cycles/cycle-one/cycle-window-game-marker.util.ts';
import {
  getNhlGameRuntimeState,
  resolveNhlGameRuntimeState,
} from '../../functions/src/shared/core/nhl/nhl-game-runtime-state.util.ts';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const require = createRequire(import.meta.url);
const cycleScoring = require(
  `${ROOT_PATH}functions/lib/shared/core/cycle/cycle-scoring.service.js`,
);
const nhlApi = require(
  `${ROOT_PATH}functions/lib/shared/core/nhl/nhl-api.service.js`,
);
const scoringRules = require(
  `${ROOT_PATH}functions/lib/shared/core/scoring/scoring-rules.js`,
);

function markerState(overrides = {}) {
  return resolveCycleWindowGameMarkerState({
    gameId: 100,
    completedGameIds: [],
    appearanceGameIds: [],
    liveGameIds: [],
    gameStates: {},
    actualGamesPlayed: 0,
    ...overrides,
  });
}

test('six-game markers distinguish scheduled live final played and missed evidence', () => {
  assert.equal(markerState().status, 'upcoming');
  assert.equal(markerState({ gameStates: { 100: 'live' } }).status, 'live');
  assert.equal(markerState({ liveGameIds: [100] }).status, 'live');
  assert.deepEqual(markerState({ gameStates: { 100: 'final' } }), {
    status: 'played',
    statusLabel: 'Final',
  });
  assert.equal(markerState({
    completedGameIds: [100],
    appearanceGameIds: [100],
    gameStates: { 100: 'final' },
    actualGamesPlayed: 1,
  }).status, 'played');
  assert.equal(markerState({
    completedGameIds: [100],
    gameStates: { 100: 'final' },
  }).status, 'missed');
  assert.equal(markerState({ gameId: null }).status, 'unavailable');
});

test('a final game turns green without manufacturing server-owned completion evidence', () => {
  const completedGameIds = [];
  const appearanceGameIds = [];
  const state = markerState({
    gameStates: { 100: 'final' },
    completedGameIds,
    appearanceGameIds,
  });

  assert.equal(state.status, 'played');
  assert.equal(state.statusLabel, 'Final');
  assert.deepEqual(completedGameIds, []);
  assert.deepEqual(appearanceGameIds, []);

  const explanation = getMobileGameMarkerExplanation({
    index: 1,
    gameId: 100,
    gameDate: '2026-10-01',
    gameLabel: 'SEA vs VAN',
    status: state.status,
    statusLabel: state.statusLabel,
    title: 'Game 1: SEA vs VAN · Final',
  }, 4.5, 'final');

  assert.equal(explanation.heading, 'Game 1 is final');
  assert.doesNotMatch(explanation.detail, /confirming|finalizing/i);
});

test('fresh game detail can promote only the one-way live-to-final transition', () => {
  const liveSchedule = {
    gameState: 'LIVE',
    homeTeam: {},
    awayTeam: {},
  };
  const finalBoxscore = {
    gameState: 'OFF',
    homeTeam: { score: 3 },
    awayTeam: { score: 2 },
  };

  assert.equal(getNhlGameRuntimeState(liveSchedule), 'live');
  assert.equal(resolveNhlGameRuntimeState({
    schedule: liveSchedule,
    boxscore: finalBoxscore,
  }), 'final');
  assert.equal(resolveNhlGameRuntimeState({
    schedule: liveSchedule,
    boxscore: {
      homeTeam: { score: 3 },
      awayTeam: { score: 2 },
    },
  }), 'live');
  assert.equal(resolveNhlGameRuntimeState({
    schedule: { ...liveSchedule, gameState: 'FUT' },
    boxscore: finalBoxscore,
  }), 'scheduled');
  assert.equal(resolveNhlGameRuntimeState({
    schedule: { ...liveSchedule, gameState: 'FINAL' },
    boxscore: { ...finalBoxscore, gameState: 'LIVE' },
  }), 'final');
});

test('the real scorer settles a completed game from a fresh final boxscore when the schedule is stale live', async (t) => {
  const schedule = [
    {
      id: 1,
      gameDate: '2026-10-01',
      startTimeUTC: '2026-10-01T23:00:00Z',
      gameType: 2,
      gameState: 'LIVE',
      homeTeam: { abbrev: 'SEA', score: 2 },
      awayTeam: { abbrev: 'VAN', score: 1 },
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: index + 2,
      gameDate: `2026-10-${String(index + 2).padStart(2, '0')}`,
      startTimeUTC: `2026-10-${String(index + 2).padStart(2, '0')}T23:00:00Z`,
      gameType: 2,
      gameState: 'FUT',
      homeTeam: { abbrev: 'SEA' },
      awayTeam: { abbrev: 'VAN' },
    })),
  ];
  let gameLogLoads = 0;

  t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async () => schedule);
  t.mock.method(nhlApi, 'getGameBoxscore', async () => ({
    gameState: 'FINAL',
    homeTeam: { abbrev: 'SEA', score: 2 },
    awayTeam: { abbrev: 'VAN', score: 1 },
    playerByGameStats: {
      homeTeam: { forwards: [], defense: [], goalies: [] },
      awayTeam: { forwards: [], defense: [], goalies: [] },
    },
  }));
  t.mock.method(nhlApi, 'getGamePlayByPlay', async () => ({
    plays: [{ eventId: 1, typeDescKey: 'period-end' }],
  }));
  t.mock.method(nhlApi, 'getRegularSeasonGameLog', async () => {
    gameLogLoads += 1;
    return { gameLog: [] };
  });

  const result = await cycleScoring.calculateCycleScoring({
    picks: [{
      overallPick: 1,
      round: 1,
      pickInRound: 1,
      ownerId: 'owner-a',
      rosterSlotId: 'C-1',
      asset: {
        assetType: 'skater',
        assetKey: 'skater-7',
        position: 'C',
        player: {
          id: 7,
          fullName: 'Unavailable Skater',
          position: 'C',
          nhlTeamAbbreviation: 'SEA',
        },
      },
    }],
    cycleNumber: 1,
    season: '20262027',
    requiredGamesPerCycle: 6,
    scoringRules: scoringRules.defaultScoringRules,
  });
  const summary = result.windowScores['owner-a__C-1__cycle-1'];

  assert.equal(gameLogLoads, 1);
  assert.deepEqual(summary.completedGameIds, [1]);
  assert.deepEqual(summary.appearanceGameIds, []);
  assert.equal(summary.gameStates['1'], 'final');
  assert.equal(summary.gameScores['1'], 0);
  assert.equal(result.hasIncompleteFinalGames, false);
});

test('the scorer loads final player evidence after a fresher boxscore promotes stale live state', async () => {
  const scoring = await read('functions/src/shared/core/cycle/cycle-scoring.service.ts');

  assert.match(scoring, /getEffectiveGameRuntimeState\(game, gameDataById\.get\(game\.id\)\) === 'final'/);
  assert.match(scoring, /skatersNeedingPromotedFinalLogs/);
  assert.match(scoring, /loadSkaterGameLogs\(\s*skatersNeedingPromotedFinalLogs/);
  assert.match(scoring, /const state = getEffectiveGameRuntimeState\(game, gameData\)/);
});

test('desktop mobile and offline matchup markers have no purple finalizing state', async () => {
  const [
    desktopTemplate,
    desktopStyles,
    mobileStyles,
    offlineTemplate,
    offlineStyles,
    markerModels,
    offlineModels,
  ] = await Promise.all([
    read('src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html'),
    read('src/app/features/cycles/cycle-one/cycle-one.css'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.css'),
    read('src/app/features/cycles/cycle-one/components/offline-matchup-snapshot/offline-matchup-snapshot.html'),
    read('src/app/features/cycles/cycle-one/components/offline-matchup-snapshot/offline-matchup-snapshot.css'),
    read('src/app/features/cycles/cycle-one/cycle-one.models.ts'),
    read('src/app/core/pwa/offline-matchup-snapshot.models.ts'),
  ]);

  assert.equal((desktopTemplate.match(/\[class\.marker-live\]/g) ?? []).length, 3);
  assert.match(desktopStyles, /\.g \.marker-live[\s\S]*background: #79d9ff/);
  assert.match(mobileStyles, /\.mobile-window-marker-live[\s\S]*background: var\(--rr-info\)/);

  for (const source of [
    desktopTemplate,
    desktopStyles,
    mobileStyles,
    offlineTemplate,
    offlineStyles,
    markerModels,
    offlineModels,
  ]) {
    assert.doesNotMatch(source, /finalizing|#cbbaff|#b9a7f7|#9c83f6/i);
  }
});

test('legacy offline purple markers normalize to green final markers', () => {
  const snapshot = normalizeOfflineMatchupSnapshot({
    schemaVersion: 1,
    accountId: 'account-1',
    leagueId: 'league-1',
    leagueName: 'Test League',
    cycleNumber: 1,
    cycleLabel: 'Matchup 1',
    matchupId: 'matchup-1',
    matchupLabel: 'Team A vs Team B',
    matchupStatus: 'active',
    readinessLabel: 'In progress',
    finishLabel: 'Six-game windows',
    savedAt: '2026-10-01T12:00:00.000Z',
    sourceReleaseLabel: 'legacy-purple-release',
    sourceScoringVersion: 4,
    sourceProjectionVersion: 11,
    teamA: {
      teamName: 'Team A',
      record: '0-0-0',
      currentScore: 4.5,
      projectedScore: 50,
      gamesPlayed: 0,
      gamesTotal: 6,
      resultLabel: null,
      viewerTeam: true,
    },
    teamB: null,
    positionGroups: [{
      position: 'C',
      label: 'Centers',
      rows: [{
        slotLabel: 'C1',
        teamAPlayer: {
          playerName: 'Test Player',
          teamLabel: 'SEA',
          position: 'C',
          currentPoints: 4.5,
          projectedPoints: 8,
          availabilityLabel: null,
          markers: Array.from({ length: 6 }, (_, index) => ({
            index: index + 1,
            status: index === 0 ? 'finalizing' : 'upcoming',
            label: index === 0
              ? 'Game 1: SEA vs VAN · Final · confirming appearance · NHL game 100'
              : `Game ${index + 1}: Upcoming`,
          })),
        },
        teamBPlayer: null,
      }],
    }],
  });

  assert.ok(snapshot);
  const marker = snapshot.positionGroups[0].rows[0].teamAPlayer.markers[0];
  assert.equal(marker.status, 'played');
  assert.equal(marker.label, 'Game 1: SEA vs VAN · Final · NHL game 100');
  assert.doesNotMatch(marker.label, /confirming|finalizing/i);
});

test('injury status is not used as historical appearance evidence', async () => {
  const markerResolver = await read(
    'src/app/features/cycles/cycle-one/cycle-window-game-marker.util.ts',
  );

  assert.doesNotMatch(markerResolver, /injur|availability|suspend/i);
  assert.match(markerResolver, /completedGameIds/);
  assert.match(markerResolver, /appearanceGameIds/);
});
