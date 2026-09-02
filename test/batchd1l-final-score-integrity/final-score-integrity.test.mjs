import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test, { after, before, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  assessNhlFinalInputCompleteness,
  buildNhlFinalInputSourceVersion,
  classifyNhlFinalInputFailure,
  isReusableNhlFinalScore,
  normalizeNhlFinalInputCompletenessRecord,
  selectIncompleteFinalScoreFallback,
  validateNhlFinalCanonicalBoxscore,
  validateNhlFinalGoalieUnitBoxscore,
  validateNhlFinalPlayerGameLog,
  validateNhlFinalPlayByPlay,
  validateNhlFinalSkaterBoxscore,
} from '../../functions/src/shared/core/nhl/nhl-final-input-completeness.util.ts';
import { decideCanonicalRequestCompletion } from '../../functions/src/shared/core/live-scoring/canonical-request-completion.util.ts';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const sha256 = async (relativePath) => createHash('sha256')
  .update(await readFile(new URL(relativePath, ROOT)))
  .digest('hex');
const require = createRequire(import.meta.url);
const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const parity = require(`${ROOT_PATH}functions/lib/shared/core/nhl/nhl-canonical-scoring-parity.util.js`);
const authority = require(`${ROOT_PATH}functions/lib/shared/core/nhl/nhl-canonical-scoring-authority.util.js`);
const assetWindows = require(`${ROOT_PATH}functions/lib/shared/core/cycle/asset-cycle-window.service.js`);
const cadence = require(`${ROOT_PATH}functions/lib/shared/core/live-scoring/live-scoring-cadence.util.js`);
const cycleWindow = require(`${ROOT_PATH}functions/lib/shared/core/cycle/cycle-window-selection.util.js`);
const cycleScoring = require(`${ROOT_PATH}functions/lib/shared/core/cycle/cycle-scoring.service.js`);
const cycleService = require(`${ROOT_PATH}functions/lib/shared/core/cycle/cycle.service.js`);
const nhlApi = require(`${ROOT_PATH}functions/lib/shared/core/nhl/nhl-api.service.js`);
const outbox = require(`${ROOT_PATH}functions/lib/shared/core/nhl/nhl-canonical-publication-outbox.service.js`);
const playoffService = require(`${ROOT_PATH}functions/lib/shared/core/playoffs/playoff.service.js`);
const scoringRules = require(`${ROOT_PATH}functions/lib/shared/core/scoring/scoring-rules.js`);
const windowProjection = require(`${ROOT_PATH}functions/lib/shared/core/projection/window-projection.service.js`);
const { deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
const { getFirestore, Timestamp } = requireFunctions('firebase-admin/firestore');

const TEST_PROJECT_ID = 'demo-rinkrat-d1l';
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;
let adminApp;
let firestore;

const skaterAsset = {
  assetType: 'skater',
  assetKey: 'skater-7',
  position: 'C',
  player: {
    id: 7,
    fullName: 'Retry Skater',
    position: 'C',
    nhlTeamAbbreviation: 'SEA',
  },
};

function teamSchedule(gameCount) {
  return Array.from({ length: gameCount }, (_, index) => ({
    id: index + 1,
    gameDate: `2026-10-${String(index + 1).padStart(2, '0')}`,
    startTimeUTC: `2026-10-${String(index + 1).padStart(2, '0')}T02:00:00Z`,
    gameType: 2,
    gameState: 'FINAL',
    homeTeam: { abbrev: 'SEA', score: 2 },
    awayTeam: { abbrev: 'VAN', score: 1 },
  }));
}

function validSkaterLine(playerId = 7, overrides = {}) {
  return {
    playerId,
    name: { default: `Player ${playerId}` },
    position: 'C',
    goals: 0,
    assists: 0,
    points: 0,
    plusMinus: 0,
    hits: 0,
    powerPlayGoals: 0,
    sog: 0,
    toi: '12:00',
    blockedShots: 0,
    ...overrides,
  };
}

function validGoalieLine(playerId, overrides = {}) {
  return {
    playerId,
    name: { default: `Goalie ${playerId}` },
    position: 'G',
    goalsAgainst: 1,
    toi: '60:00',
    starter: true,
    shotsAgainst: 30,
    saves: 29,
    ...overrides,
  };
}

function validBoxscore({ appeared = true, skaterOverrides = {} } = {}) {
  return {
    homeTeam: { abbrev: 'SEA', score: 2 },
    awayTeam: { abbrev: 'VAN', score: 1 },
    playerByGameStats: {
      homeTeam: {
        forwards: appeared ? [validSkaterLine(7, skaterOverrides)] : [],
        defense: [],
        goalies: [validGoalieLine(70)],
      },
      awayTeam: {
        forwards: [validSkaterLine(8)],
        defense: [],
        goalies: [validGoalieLine(80, { goalsAgainst: 2, saves: 28 })],
      },
    },
  };
}

function validHistoricalTradeBoxscore({ appeared = true } = {}) {
  return {
    homeTeam: { abbrev: 'OTT', score: 3 },
    awayTeam: { abbrev: 'FLA', score: 2 },
    playerByGameStats: {
      homeTeam: {
        forwards: appeared
          ? [validSkaterLine(7, { goals: 1, points: 1, sog: 2 })]
          : [],
        defense: [],
        goalies: [validGoalieLine(70, { goalsAgainst: 2, saves: 28 })],
      },
      awayTeam: {
        forwards: [validSkaterLine(9)],
        defense: [],
        goalies: [validGoalieLine(90, { goalsAgainst: 3, saves: 27 })],
      },
    },
  };
}

function historicalTradeReplayGame() {
  return {
    id: 1,
    gameDate: '2026-10-01',
    startTimeUTC: '2026-10-01T23:00:00Z',
    gameType: 2,
    gameState: 'FINAL',
    homeTeam: { abbrev: 'FLA', score: 2 },
    awayTeam: { abbrev: 'TBL', score: 1 },
  };
}

function validPlayByPlay() {
  return {
    plays: [{
      eventId: 1,
      typeDescKey: 'goal',
      details: { scoringPlayerId: 8, homeScore: 0, awayScore: 1 },
    }],
  };
}

function validPlayerLogEntry(gameId, overrides = {}) {
  return {
    gameId,
    teamAbbrev: 'SEA',
    homeRoadFlag: 'H',
    gameDate: `2026-10-${String(gameId).padStart(2, '0')}`,
    goals: 0,
    assists: 0,
    points: 0,
    plusMinus: 0,
    powerPlayPoints: 0,
    gameWinningGoals: 0,
    otGoals: 0,
    shots: 0,
    shorthandedPoints: 0,
    toi: '12:00',
    opponentAbbrev: 'VAN',
    ...overrides,
  };
}

function scoringPick(asset = skaterAsset) {
  return {
    overallPick: 1,
    round: 1,
    pickInRound: 1,
    ownerId: 'owner-a',
    rosterSlotId: 'C-1',
    cycleWindowId: 'owner-a__C-1__cycle-1',
    snapshotCycleNumber: 1,
    asset,
  };
}

function mockDirectNhlSources(t, input = {}) {
  const schedules = input.schedule ?? teamSchedule(1);
  const boxscoreByGameId = input.boxscoreByGameId ?? new Map(
    schedules.map((game) => [game.id, validBoxscore({
      skaterOverrides: { goals: 1, points: 1, sog: 1 },
    })]),
  );
  const playByPlayByGameId = input.playByPlayByGameId ?? new Map(
    schedules.map((game) => [game.id, validPlayByPlay()]),
  );
  const gameLog = input.gameLog ?? schedules.map((game) =>
    validPlayerLogEntry(game.id, { goals: 1, points: 1, shots: 1 })
  );
  let failedBoxscoreGameId = input.failedBoxscoreGameId ?? null;

  t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async () => schedules);
  const boxscoreMock = t.mock.method(nhlApi, 'getGameBoxscore', async (gameId) => {
    if (gameId === failedBoxscoreGameId) {
      throw new Error('temporary final boxscore failure');
    }

    return boxscoreByGameId.get(gameId);
  });
  t.mock.method(nhlApi, 'getGamePlayByPlay', async (gameId) =>
    playByPlayByGameId.get(gameId)
  );
  t.mock.method(nhlApi, 'getRegularSeasonGameLog', async () => ({ gameLog }));

  return {
    boxscoreMock,
    recoverBoxscore: () => {
      failedBoxscoreGameId = null;
    },
  };
}

async function calculateTestCycle(overrides = {}) {
  return cycleScoring.calculateCycleScoring({
    picks: [scoringPick()],
    cycleNumber: 1,
    season: '20262027',
    requiredGamesPerCycle: 6,
    scoringRules: scoringRules.defaultScoringRules,
    ...overrides,
  });
}

function fantasyTeam(ownerId, standings = {}) {
  return {
    id: ownerId,
    ownerId,
    teamName: `Team ${ownerId}`,
    logo: '',
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    waiverPriority: 1,
    draftPosition: null,
    ...standings,
  };
}

function rosterSkater(playerId, assetKey, rosterStatus) {
  return {
    assetType: 'skater',
    assetKey,
    position: 'C',
    player: {
      id: playerId,
      fullName: `Player ${playerId}`,
      position: 'C',
      nhlTeamAbbreviation: 'SEA',
    },
    cycleScore: { cycleNumber: 1, gamesCounted: 0, fantasyPoints: 0 },
    rosterStatus,
  };
}

function completedTeamWindows(ownerId, fantasyPoints) {
  return {
    id: ownerId,
    ownerId,
    cycleNumber: 1,
    expectedRosterSlotIds: ['C-1'],
    windows: [{
      id: `${ownerId}__C-1__cycle-1`,
      ownerId,
      rosterSlotId: 'C-1',
      cycleNumber: 1,
      position: 'C',
      assetKey: `skater-${ownerId}`,
      status: 'complete',
      fantasyPoints,
    }],
    completedWindowCount: 1,
    totalWindowCount: 1,
    status: 'complete',
  };
}

function sourceState(availability, detail) {
  return detail ? { availability, detail } : { availability };
}

function assessSkater(overrides = {}) {
  return assessNhlFinalInputCompleteness({
    assetType: 'skater',
    boxscore: sourceState('available'),
    playByPlay: sourceState('available'),
    playerLog: sourceState('available'),
    sourceVersion: buildNhlFinalInputSourceVersion({ gameId: 1, version: 1 }),
    ...overrides,
  });
}

async function resetFirestoreEmulator() {
  assert.ok(FIRESTORE_EMULATOR_HOST, 'D1L tests require the Firestore emulator.');
  const response = await fetch(
    `http://${FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${TEST_PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.ok(response.ok, `Firestore emulator reset failed: ${response.status}`);
}

before(async () => {
  assert.ok(FIRESTORE_EMULATOR_HOST, 'D1L tests must run through npm run test:batchd1l.');
  adminApp = initializeApp({ projectId: TEST_PROJECT_ID }, `d1l-${randomUUID()}`);
  firestore = getFirestore(adminApp);
  await resetFirestoreEmulator();
});

beforeEach(async () => {
  await resetFirestoreEmulator();
});

after(async () => {
  if (adminApp) {
    await deleteApp(adminApp);
  }
});

test('missing final boxscore is explicit, retryable, and not reusable', () => {
  const evidence = assessSkater({
    boxscore: sourceState('temporarily-unavailable', 'boxscore timeout'),
  });

  assert.equal(evidence.status, 'incomplete-boxscore');
  assert.equal(evidence.complete, false);
  assert.ok(evidence.failures.every((failure) => failure.retryable));
  assert.equal(isReusableNhlFinalScore({ assetType: 'skater', gameState: 'final', score: 0, completeness: evidence }), false);
});

test('missing final play-by-play is not silently converted to zero assists', () => {
  const evidence = assessSkater({
    playByPlay: sourceState('temporarily-unavailable', 'play-by-play unavailable'),
  });

  assert.equal(evidence.status, 'incomplete-play-by-play');
  assert.ok(evidence.failures.some((failure) => failure.source === 'play-by-play'));
});

test('missing final player log remains incomplete and retryable', () => {
  const evidence = assessSkater({
    playerLog: sourceState('temporarily-unavailable', 'game missing from final log'),
  });

  assert.equal(evidence.status, 'incomplete-player-log');
  assert.equal(evidence.reusableFinal, false);
});

test('malformed NHL payloads are distinguishable from transient failures', () => {
  assert.equal(classifyNhlFinalInputFailure(new SyntaxError('invalid JSON')).availability, 'malformed');
  assert.equal(classifyNhlFinalInputFailure(new Error('upstream timeout')).availability, 'temporarily-unavailable');
});

test('fulfilled malformed final source payloads fail closed before scoring', () => {
  const malformedSkaterBoxscore = validBoxscore({
    skaterOverrides: { goals: undefined },
  });
  const malformedGoalieBoxscore = validBoxscore();
  malformedGoalieBoxscore.playerByGameStats.homeTeam.goalies[0].saves = undefined;
  const malformedPlayByPlay = {
    plays: [{ typeDescKey: 'goal', details: { scoringPlayerId: '7' } }],
  };
  const malformedPlayerLog = [
    { ...validPlayerLogEntry(1), powerPlayPoints: undefined },
  ];

  assert.equal(validateNhlFinalSkaterBoxscore({
    boxscore: malformedSkaterBoxscore,
    teamAbbreviation: 'SEA',
    playerId: 7,
  }).availability, 'malformed');
  assert.equal(validateNhlFinalGoalieUnitBoxscore({
    boxscore: malformedGoalieBoxscore,
    teamAbbreviation: 'SEA',
  }).availability, 'malformed');
  assert.equal(validateNhlFinalCanonicalBoxscore(malformedGoalieBoxscore).availability, 'malformed');
  assert.equal(validateNhlFinalPlayByPlay(malformedPlayByPlay).availability, 'malformed');
  assert.equal(validateNhlFinalPlayerGameLog({
    gameLog: malformedPlayerLog,
    gameId: 1,
    appeared: true,
  }).sourceState.availability, 'malformed');
});

test('proven skater nonappearance remains complete while an appeared missing log retries', () => {
  const absent = validateNhlFinalPlayerGameLog({
    gameLog: [],
    gameId: 1,
    appeared: false,
  });
  const appearedMissing = validateNhlFinalPlayerGameLog({
    gameLog: [],
    gameId: 1,
    appeared: true,
  });

  assert.equal(absent.sourceState.availability, 'available');
  assert.equal(absent.gameLogEntry, undefined);
  assert.equal(appearedMissing.sourceState.availability, 'temporarily-unavailable');
});

test('a legitimate zero-point final is reusable only with complete source evidence', () => {
  const evidence = assessSkater();

  assert.equal(evidence.status, 'complete');
  assert.equal(isReusableNhlFinalScore({ assetType: 'skater', gameState: 'final', score: 0, completeness: evidence }), true);
});

test('legacy numeric final scores without completeness evidence are never reused', () => {
  assert.equal(isReusableNhlFinalScore({ assetType: 'skater', gameState: 'final', score: 8.2, completeness: undefined }), false);
  assert.equal(isReusableNhlFinalScore({ assetType: 'skater', gameState: 'live', score: 8.2, completeness: assessSkater() }), false);
});

test('a successful retry changes the same game from incomplete to reusable', () => {
  const firstAttempt = assessSkater({
    playerLog: sourceState('temporarily-unavailable', 'not published yet'),
  });
  const retry = assessSkater({
    sourceVersion: buildNhlFinalInputSourceVersion({ gameId: 1, version: 2 }),
  });

  assert.equal(firstAttempt.complete, false);
  assert.equal(retry.complete, true);
  assert.equal(isReusableNhlFinalScore({ assetType: 'skater', gameState: 'final', score: 4.5, completeness: retry }), true);
});

test('the real scorer retries Game 6 once and keeps Game 7 in the next window', async (t) => {
  const schedule = teamSchedule(7);
  const mocks = mockDirectNhlSources(t, {
    schedule,
    failedBoxscoreGameId: 6,
  });
  const first = await calculateTestCycle();
  const firstWindow = first.windowScores['owner-a__C-1__cycle-1'];

  assert.equal(firstWindow.gamesPlayed, 5);
  assert.deepEqual(firstWindow.completedGameIds, [1, 2, 3, 4, 5]);
  assert.deepEqual(firstWindow.incompleteFinalGameIds, [6]);
  assert.equal(firstWindow.gameScores['6'], undefined);

  mocks.recoverBoxscore();
  const retry = await calculateTestCycle({ previousResult: first });
  const retryWindow = retry.windowScores['owner-a__C-1__cycle-1'];
  const boxscoreCallsAfterRetry = mocks.boxscoreMock.mock.callCount();

  assert.equal(retryWindow.gamesPlayed, 6);
  assert.equal(retryWindow.actualGamesPlayed, 6);
  assert.ok(retryWindow.currentScore > firstWindow.currentScore);
  assert.deepEqual(retryWindow.completedGameIds, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(retryWindow.incompleteFinalGameIds, []);
  assert.equal(retryWindow.gameInputCompleteness['6'].complete, true);

  const duplicateRetry = await calculateTestCycle({ previousResult: retry });
  const duplicateWindow = duplicateRetry.windowScores['owner-a__C-1__cycle-1'];

  assert.equal(mocks.boxscoreMock.mock.callCount(), boxscoreCallsAfterRetry);
  assert.equal(duplicateWindow.currentScore, retryWindow.currentScore);
  assert.deepEqual(duplicateWindow.completedGameIds, retryWindow.completedGameIds);

  const cycleTwoPick = {
    ...scoringPick(),
    cycleWindowId: 'owner-a__C-1__cycle-2',
    snapshotCycleNumber: 2,
  };
  const cycleTwo = await calculateTestCycle({
    picks: [cycleTwoPick],
    cycleNumber: 2,
    previousResult: null,
  });

  assert.deepEqual(
    cycleTwo.windowScores['owner-a__C-1__cycle-2'].scheduledGameIds,
    [7],
  );
});

test('the real scorer settles a proven nonappearance as a reusable zero', async (t) => {
  const schedule = teamSchedule(1);
  mockDirectNhlSources(t, {
    schedule,
    boxscoreByGameId: new Map([[1, validBoxscore({ appeared: false })]]),
    gameLog: [],
  });
  const result = await calculateTestCycle();
  const window = result.windowScores['owner-a__C-1__cycle-1'];

  assert.equal(window.gamesPlayed, 1);
  assert.equal(window.actualGamesPlayed, 0);
  assert.equal(window.gameScores['1'], 0);
  assert.deepEqual(window.appearanceGameIds, []);
  assert.equal(window.gameInputCompleteness['1'].complete, true);
  assert.equal(window.gameInputCompleteness['1'].reusableFinal, true);
});

test('historical replay validates a traded skater against the source-season team and retries exactly once', async (t) => {
  const tradedAsset = {
    ...skaterAsset,
    player: {
      ...skaterAsset.player,
      nhlTeamAbbreviation: 'FLA',
    },
  };
  const replayGamesByAssetKey = {
    [tradedAsset.assetKey]: [historicalTradeReplayGame()],
  };
  const mocks = mockDirectNhlSources(t, {
    boxscoreByGameId: new Map([[1, validHistoricalTradeBoxscore()]]),
    gameLog: [validPlayerLogEntry(1, {
      teamAbbrev: 'OTT',
      goals: 1,
      points: 1,
      shots: 2,
      opponentAbbrev: 'FLA',
    })],
  });

  const missingSourceTeam = await calculateTestCycle({
    picks: [scoringPick(tradedAsset)],
    replayGamesByAssetKey,
    gameLogSeason: '20252026',
  });
  const incompleteWindow = missingSourceTeam.windowScores['owner-a__C-1__cycle-1'];

  assert.equal(incompleteWindow.gamesPlayed, 0);
  assert.deepEqual(incompleteWindow.incompleteFinalGameIds, [1]);
  assert.equal(incompleteWindow.gameScores['1'], undefined);
  assert.match(
    incompleteWindow.gameInputCompleteness['1'].failures[0].detail,
    /source-team identity is unavailable/i,
  );

  const recovered = await calculateTestCycle({
    picks: [scoringPick(tradedAsset)],
    replayGamesByAssetKey,
    replaySourceTeamAbbreviationByAssetGameId: {
      [tradedAsset.assetKey]: { 1: 'OTT' },
    },
    gameLogSeason: '20252026',
    previousResult: missingSourceTeam,
  });
  const recoveredWindow = recovered.windowScores['owner-a__C-1__cycle-1'];
  const boxscoreCallsAfterRecovery = mocks.boxscoreMock.mock.callCount();

  assert.equal(recoveredWindow.gamesPlayed, 1);
  assert.equal(recoveredWindow.actualGamesPlayed, 1);
  assert.ok(recoveredWindow.currentScore > 0);
  assert.deepEqual(recoveredWindow.completedGameIds, [1]);
  assert.deepEqual(recoveredWindow.incompleteFinalGameIds, []);
  assert.equal(recoveredWindow.gameInputCompleteness['1'].complete, true);

  const duplicateRetry = await calculateTestCycle({
    picks: [scoringPick(tradedAsset)],
    replayGamesByAssetKey,
    replaySourceTeamAbbreviationByAssetGameId: {
      [tradedAsset.assetKey]: { 1: 'OTT' },
    },
    gameLogSeason: '20252026',
    previousResult: recovered,
  });
  const duplicateWindow = duplicateRetry.windowScores['owner-a__C-1__cycle-1'];

  assert.equal(mocks.boxscoreMock.mock.callCount(), boxscoreCallsAfterRecovery);
  assert.equal(duplicateWindow.currentScore, recoveredWindow.currentScore);
  assert.deepEqual(duplicateWindow.completedGameIds, [1]);
});

test('historical replay preserves a proven source-team nonappearance as a reusable zero', async (t) => {
  const tradedAsset = {
    ...skaterAsset,
    player: {
      ...skaterAsset.player,
      nhlTeamAbbreviation: 'FLA',
    },
  };
  mockDirectNhlSources(t, {
    boxscoreByGameId: new Map([[1, validHistoricalTradeBoxscore({ appeared: false })]]),
    gameLog: [],
  });

  const result = await calculateTestCycle({
    picks: [scoringPick(tradedAsset)],
    replayGamesByAssetKey: {
      [tradedAsset.assetKey]: [historicalTradeReplayGame()],
    },
    replaySourceTeamAbbreviationByAssetGameId: {
      [tradedAsset.assetKey]: { 1: 'OTT' },
    },
    gameLogSeason: '20252026',
  });
  const window = result.windowScores['owner-a__C-1__cycle-1'];

  assert.equal(window.gamesPlayed, 1);
  assert.equal(window.actualGamesPlayed, 0);
  assert.equal(window.gameScores['1'], 0);
  assert.equal(window.gameInputCompleteness['1'].complete, true);
  assert.equal(window.gameInputCompleteness['1'].reusableFinal, true);
});

test('the real scorer rejects a fulfilled malformed player log instead of storing zero', async (t) => {
  const schedule = teamSchedule(1);
  mockDirectNhlSources(t, {
    schedule,
    gameLog: [{ ...validPlayerLogEntry(1), powerPlayPoints: undefined }],
  });
  const result = await calculateTestCycle();
  const window = result.windowScores['owner-a__C-1__cycle-1'];

  assert.equal(window.gamesPlayed, 0);
  assert.deepEqual(window.incompleteFinalGameIds, [1]);
  assert.equal(window.gameScores['1'], undefined);
  assert.equal(window.gameInputCompleteness['1'].status, 'malformed');
});

test('incomplete final input never invents a new score', () => {
  const fallback = selectIncompleteFinalScoreFallback({
    previousScore: undefined,
    previousAppeared: false,
  });

  assert.deepEqual(fallback, { score: null, appeared: false, preservedPrevious: false });
});

test('an existing provisional score is preserved but not marked authoritative', () => {
  const fallback = selectIncompleteFinalScoreFallback({
    previousScore: 3.26,
    previousAppeared: true,
  });

  assert.deepEqual(fallback, { score: 3.3, appeared: true, preservedPrevious: true });
});

test('persisted completeness normalization fails closed on invalid evidence', () => {
  const normalized = normalizeNhlFinalInputCompletenessRecord({
    1: { status: 'complete', complete: true, reusableFinal: true, sourceVersion: 'bad' },
    2: assessSkater(),
    3: {
      status: 'complete', complete: true, reusableFinal: true,
      sourceVersion: 'f'.repeat(64), requiredSources: [], failures: [],
    },
  });

  assert.equal(normalized['1'].complete, false);
  assert.equal(normalized['1'].status, 'incomplete-source-version');
  assert.equal(normalized['2'].complete, true);
  assert.equal(normalized['3'].complete, false);
  assert.equal(normalized['3'].status, 'malformed');
  assert.ok(normalized['3'].failures.length > 0);
  assert.equal(isReusableNhlFinalScore({
    assetType: 'skater', gameState: 'final', score: 1, completeness: normalized['3'],
  }), false);
});

test('canonical parity is scoped to the exact requested game ID set', () => {
  const requestedGameIds = new Set([1001, 1003]);

  assert.equal(parity.shouldCompareCanonicalScoringParityGame({ requestedGameIds, gameId: 1001 }), true);
  assert.equal(parity.shouldCompareCanonicalScoringParityGame({ requestedGameIds, gameId: 1002 }), false);
  assert.equal(parity.shouldCompareCanonicalScoringParityGame({ requestedGameIds: undefined, gameId: 1001 }), false);
});

test('requested missing canonical data remains canonical-missing', () => {
  const observation = parity.compareDirectAndCanonicalGameScore({
    gameId: 1001,
    asset: {
      assetType: 'skater', assetKey: 'skater:7', position: 'C',
      player: { id: 7, fullName: 'Test Skater', position: 'C', nhlTeamAbbreviation: 'SEA' },
    },
    canonicalGame: undefined,
    gameIsFinal: true,
    scoringRules: {},
    directPoints: 0,
    directAppeared: false,
  });

  assert.equal(observation.status, 'canonical-missing');
});

test('direct-source incompleteness is parity-incomplete rather than a zero mismatch', () => {
  const observation = parity.compareDirectAndCanonicalGameScore({
    gameId: 1001,
    asset: {
      assetType: 'skater', assetKey: 'skater:7', position: 'C',
      player: { id: 7, fullName: 'Test Skater', position: 'C', nhlTeamAbbreviation: 'SEA' },
    },
    canonicalGame: { sourceVersion: 'a'.repeat(64), facts: {} },
    gameIsFinal: true,
    scoringRules: {},
    directPoints: 0,
    directAppeared: false,
    directInputComplete: false,
    directIncompleteReason: 'incomplete-player-log',
  });

  assert.equal(observation.status, 'incomplete');
  assert.equal(observation.canonicalPoints, null);
  assert.equal(observation.reason, 'direct-incomplete-player-log');
});

test('canonical final-input incompleteness cannot be treated as a parity match', () => {
  const sourceVersion = 'a'.repeat(64);
  const observation = parity.compareDirectAndCanonicalGameScore({
    gameId: 1001,
    asset: {
      assetType: 'skater', assetKey: 'skater:7', position: 'C',
      player: { id: 7, fullName: 'Test Skater', position: 'C', nhlTeamAbbreviation: 'SEA' },
    },
    canonicalGame: {
      sourceVersion,
      facts: {},
      finalInputCompletenessByAssetType: {
        skater: {
          status: 'malformed', complete: false, reusableFinal: false,
          sourceVersion: '', requiredSources: [], failures: [],
        },
      },
    },
    gameIsFinal: true,
    scoringRules: {},
    directPoints: 0,
    directAppeared: false,
  });

  assert.equal(observation.status, 'incomplete');
  assert.equal(observation.canonicalPoints, null);
  assert.equal(observation.reason, 'canonical-malformed');
});

test('canonical incompleteness retains direct fallback and trips the existing circuit breaker', () => {
  const decision = authority.decideCanonicalScoringAuthority({
    configured: true,
    taskVersionAligned: true,
    observation: {
      gameId: 1001,
      assetKey: 'skater:7',
      assetType: 'skater',
      sourceVersion: 'a'.repeat(64),
      status: 'incomplete',
      directPoints: 2.5,
      canonicalPoints: null,
      pointDelta: null,
      directAppeared: true,
      canonicalAppeared: null,
      reason: 'direct-incomplete-player-log',
    },
  });

  assert.equal(decision.selection, 'direct-fallback');
  assert.equal(decision.selectedPoints, 2.5);
  assert.equal(decision.tripCircuitBreaker, true);
});

test('incomplete finals retain bounded retry cadence', () => {
  assert.equal(
    cadence.getLiveScoringRefreshDelay(
      [{ hasLiveGames: false, hasIncompleteFinalGames: true, nextScheduledGameStart: null }],
      false,
      Date.now(),
      'standard',
    ),
    cadence.STANDARD_LIVE_REFRESH_INTERVAL_MILLISECONDS,
  );
});

test('six-game ownership and seventh-game rollover remain stable across retries', () => {
  const schedule = Array.from({ length: 12 }, (_, index) => ({ id: index + 1 }));
  const firstAttempt = cycleWindow.selectCycleWindowGames(schedule, 1, 6).map((game) => game.id);
  const retry = cycleWindow.selectCycleWindowGames(schedule, 1, 6).map((game) => game.id);
  const nextWindow = cycleWindow.selectCycleWindowGames(schedule, 2, 6).map((game) => game.id);

  assert.deepEqual(firstAttempt, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(retry, firstAttempt);
  assert.deepEqual(nextWindow, [7, 8, 9, 10, 11, 12]);
});

test('an older canonical task cannot clear a newer requested version', () => {
  const decision = decideCanonicalRequestCompletion({
    resultStatus: 'success',
    taskSourceVersion: 'old-version',
    latestRequestedSourceVersion: 'new-version',
  });

  assert.deepEqual(decision, {
    needsFollowUp: true,
    satisfied: false,
    completionState: 'superseded',
  });
});

test('canonical publication and its downstream outbox record commit atomically', async () => {
  const gameId = 2026020001;
  const sourceVersion = 'a'.repeat(64);
  const result = await outbox.persistCanonicalPublicationWithOutbox({
    firestore,
    gameId,
    sourceVersion,
    changeKind: 'fantasy-event-change',
    shouldSignal: true,
    affectedPlayerIds: [7],
    affectedTeamAbbreviations: ['SEA'],
    observedAtMilliseconds: 1_800_000_000_000,
    canonicalPayload: { gameId, sourceVersion, marker: 'canonical' },
  });
  const [canonicalSnapshot, outboxSnapshot] = await Promise.all([
    firestore.doc(`nhlCanonicalGameFacts/${gameId}`).get(),
    firestore.doc(`${outbox.CANONICAL_PUBLICATION_OUTBOX_COLLECTION}/${result.outboxId}`).get(),
  ]);

  assert.equal(result.outboxCreated, true);
  assert.equal(canonicalSnapshot.data().sourceVersion, sourceVersion);
  assert.equal(outboxSnapshot.data().status, 'pending');
});

test('duplicate publication delivery does not create duplicate durable work', async () => {
  const gameId = 2026020002;
  const sourceVersion = 'b'.repeat(64);
  const input = {
    firestore,
    gameId,
    sourceVersion,
    changeKind: 'final-settlement-change',
    shouldSignal: true,
    affectedPlayerIds: [8, 8],
    affectedTeamAbbreviations: ['MIN', 'MIN'],
    observedAtMilliseconds: 1_800_000_000_100,
    canonicalPayload: { gameId, sourceVersion },
  };
  const first = await outbox.persistCanonicalPublicationWithOutbox(input);
  const { entries } = await outbox.loadPendingCanonicalPublicationOutbox({ firestore, limit: 10 });
  await outbox.markCanonicalPublicationOutboxDelivered({
    firestore,
    entry: entries[0],
    leagueIds: ['league-a'],
    outcome: 'delivered',
  });
  const duplicate = await outbox.persistCanonicalPublicationWithOutbox(input);
  const staleFailureRecorded = await outbox.recordCanonicalPublicationOutboxFailure({
    firestore,
    entry: entries[0],
    error: new Error('late duplicate worker failure'),
  });
  const collection = await firestore.collection(outbox.CANONICAL_PUBLICATION_OUTBOX_COLLECTION).get();
  const stored = await firestore.doc(`${outbox.CANONICAL_PUBLICATION_OUTBOX_COLLECTION}/${first.outboxId}`).get();

  assert.equal(duplicate.outboxId, first.outboxId);
  assert.equal(duplicate.outboxCreated, false);
  assert.equal(staleFailureRecorded, false);
  assert.equal(collection.size, 1);
  assert.equal(stored.data().status, 'delivered');
});

test('failed downstream delivery stays pending with bounded retry evidence', async () => {
  const gameId = 2026020003;
  const sourceVersion = 'c'.repeat(64);
  const created = await outbox.persistCanonicalPublicationWithOutbox({
    firestore,
    gameId,
    sourceVersion,
    changeKind: 'game-state-change',
    shouldSignal: true,
    affectedPlayerIds: [],
    affectedTeamAbbreviations: ['WPG'],
    observedAtMilliseconds: 1_800_000_000_200,
    canonicalPayload: { gameId, sourceVersion },
  });
  const { entries: [entry] } = await outbox.loadPendingCanonicalPublicationOutbox({
    firestore,
    limit: 10,
  });
  await outbox.recordCanonicalPublicationOutboxFailure({
    firestore,
    entry,
    error: new Error(`upstream ${'x'.repeat(200)}`),
  });
  const stored = await firestore.doc(`${outbox.CANONICAL_PUBLICATION_OUTBOX_COLLECTION}/${created.outboxId}`).get();

  assert.equal(stored.data().status, 'pending');
  assert.equal(stored.data().attemptCount, 1);
  assert.ok(stored.data().lastErrorCode.length <= 100);
});

test('new and old source versions have independent outbox identities', async () => {
  const gameId = 2026020004;
  const oldVersion = 'd'.repeat(64);
  const newVersion = 'e'.repeat(64);
  const base = {
    firestore,
    gameId,
    changeKind: 'fantasy-event-change',
    shouldSignal: true,
    affectedPlayerIds: [9],
    affectedTeamAbbreviations: ['VGK'],
    observedAtMilliseconds: 1_800_000_000_300,
  };
  const oldResult = await outbox.persistCanonicalPublicationWithOutbox({
    ...base,
    sourceVersion: oldVersion,
    canonicalPayload: { gameId, sourceVersion: oldVersion },
  });
  const newResult = await outbox.persistCanonicalPublicationWithOutbox({
    ...base,
    sourceVersion: newVersion,
    expectedSourceVersion: oldVersion,
    canonicalPayload: { gameId, sourceVersion: newVersion },
  });
  const { entries } = await outbox.loadPendingCanonicalPublicationOutbox({ firestore, limit: 10 });
  const oldEntry = entries.find((entry) => entry.sourceVersion === oldVersion);
  assert.ok(oldEntry);
  await outbox.markCanonicalPublicationOutboxDelivered({
    firestore,
    entry: oldEntry,
    leagueIds: [],
    outcome: 'superseded',
  });
  const [canonicalSnapshot, oldSnapshot, newSnapshot] = await Promise.all([
    firestore.doc(`nhlCanonicalGameFacts/${gameId}`).get(),
    firestore.doc(`${outbox.CANONICAL_PUBLICATION_OUTBOX_COLLECTION}/${oldResult.outboxId}`).get(),
    firestore.doc(`${outbox.CANONICAL_PUBLICATION_OUTBOX_COLLECTION}/${newResult.outboxId}`).get(),
  ]);

  assert.equal(canonicalSnapshot.data().sourceVersion, newVersion);
  assert.equal(oldSnapshot.data().status, 'superseded');
  assert.equal(newSnapshot.data().status, 'pending');
});

test('a stale canonical publisher cannot overwrite the current version or enqueue stale work', async () => {
  const gameId = 2026020005;
  const firstVersion = '1'.repeat(64);
  const currentVersion = '2'.repeat(64);
  const staleVersion = '3'.repeat(64);
  const base = {
    firestore,
    gameId,
    changeKind: 'fantasy-event-change',
    shouldSignal: true,
    affectedPlayerIds: [10],
    affectedTeamAbbreviations: ['SEA'],
    observedAtMilliseconds: 1_800_000_000_400,
  };

  await outbox.persistCanonicalPublicationWithOutbox({
    ...base,
    sourceVersion: firstVersion,
    canonicalPayload: { gameId, sourceVersion: firstVersion },
  });
  await outbox.persistCanonicalPublicationWithOutbox({
    ...base,
    sourceVersion: currentVersion,
    expectedSourceVersion: firstVersion,
    canonicalPayload: { gameId, sourceVersion: currentVersion },
  });
  const stale = await outbox.persistCanonicalPublicationWithOutbox({
    ...base,
    sourceVersion: staleVersion,
    expectedSourceVersion: firstVersion,
    canonicalPayload: { gameId, sourceVersion: staleVersion },
  });
  const [canonicalSnapshot, staleOutboxSnapshot] = await Promise.all([
    firestore.doc(`nhlCanonicalGameFacts/${gameId}`).get(),
    firestore.doc(
      `${outbox.CANONICAL_PUBLICATION_OUTBOX_COLLECTION}/${gameId}_${staleVersion}`,
    ).get(),
  ]);

  assert.equal(stale.publicationApplied, false);
  assert.equal(stale.publicationOutcome, 'stale');
  assert.equal(canonicalSnapshot.data().sourceVersion, currentVersion);
  assert.equal(staleOutboxSnapshot.exists, false);
});

test('the durable outbox cursor rotates beyond a stable failing first page', async () => {
  const publications = Array.from({ length: 45 }, (_, index) => ({
    gameId: 2026030000 + index,
    sourceVersion: index.toString(16).padStart(64, '0'),
  }));

  await Promise.all(publications.map(({ gameId, sourceVersion }) =>
    outbox.persistCanonicalPublicationWithOutbox({
      firestore,
      gameId,
      sourceVersion,
      changeKind: 'fantasy-event-change',
      shouldSignal: true,
      affectedPlayerIds: [],
      affectedTeamAbbreviations: [],
      observedAtMilliseconds: 1_800_000_001_000 + gameId,
      canonicalPayload: { gameId, sourceVersion },
    })
  ));
  const firstPage = await outbox.loadPendingCanonicalPublicationOutbox({
    firestore,
    limit: 40,
  });
  const secondPage = await outbox.loadPendingCanonicalPublicationOutbox({
    firestore,
    limit: 40,
    afterId: firstPage.nextCursorId,
  });
  const firstIds = new Set(firstPage.entries.map((entry) => entry.id));
  const unseenSecondPageIds = secondPage.entries
    .map((entry) => entry.id)
    .filter((id) => !firstIds.has(id));

  assert.equal(firstPage.entries.length, 40);
  assert.equal(secondPage.entries.length, 40);
  assert.equal(unseenSecondPageIds.length, 5);
  assert.equal(
    new Set([...firstPage.entries, ...secondPage.entries].map((entry) => entry.id)).size,
    45,
  );
});

test('duplicate matchup reconciliation applies standings exactly once', async () => {
  const leagueId = `standings-${randomUUID()}`;
  const cycleRef = firestore.doc(`leagues/${leagueId}/cycles/cycle-1`);
  const matchupRef = cycleRef.collection('matchups').doc('matchup-1');

  await Promise.all([
    cycleRef.set({
      id: 'cycle-1',
      cycleNumber: 1,
      status: 'active',
      phase: 'regular_season',
      matchupIds: ['matchup-1'],
      expectedRosterSlotIdsByOwner: {
        'owner-a': ['C-1'],
        'owner-b': ['C-1'],
      },
      completedMatchupCount: 0,
      standingsAppliedAt: null,
    }),
    matchupRef.set({
      id: 'matchup-1',
      cycleNumber: 1,
      phase: 'regular_season',
      teamAOwnerId: 'owner-a',
      teamBOwnerId: 'owner-b',
      teamAScore: 0,
      teamBScore: 0,
      winnerOwnerId: null,
      status: 'active',
    }),
    firestore.doc(`leagues/${leagueId}/teams/owner-a`).set(fantasyTeam('owner-a')),
    firestore.doc(`leagues/${leagueId}/teams/owner-b`).set(fantasyTeam('owner-b')),
    cycleRef.collection('teamWindows').doc('owner-a').set(
      completedTeamWindows('owner-a', 5),
    ),
    cycleRef.collection('teamWindows').doc('owner-b').set(
      completedTeamWindows('owner-b', 2),
    ),
  ]);

  const first = await cycleService.reconcileRegularSeasonCycleMatchupCompletion(leagueId, 1);
  const duplicate = await cycleService.reconcileRegularSeasonCycleMatchupCompletion(leagueId, 1);
  const [teamA, teamB, cycle, matchup] = await Promise.all([
    firestore.doc(`leagues/${leagueId}/teams/owner-a`).get(),
    firestore.doc(`leagues/${leagueId}/teams/owner-b`).get(),
    cycleRef.get(),
    matchupRef.get(),
  ]);

  assert.deepEqual(first.newlyCompletedMatchupIds, ['matchup-1']);
  assert.deepEqual(duplicate.newlyCompletedMatchupIds, []);
  assert.equal(teamA.data().wins, 1);
  assert.equal(teamA.data().pointsFor, 5);
  assert.equal(teamA.data().pointsAgainst, 2);
  assert.equal(teamB.data().losses, 1);
  assert.equal(teamB.data().pointsFor, 2);
  assert.equal(teamB.data().pointsAgainst, 5);
  assert.equal(cycle.data().status, 'complete');
  assert.ok(cycle.data().standingsAppliedAt);
  assert.equal(matchup.data().winnerOwnerId, 'owner-a');
});

test('an older incomplete scorer result cannot downgrade a completed slot window', async () => {
  const leagueId = `window-cas-${randomUUID()}`;
  const cycleRef = firestore.doc(`leagues/${leagueId}/cycles/cycle-1`);
  const teamWindowsRef = cycleRef.collection('teamWindows').doc('owner-a');
  const settledWindow = {
    ...completedTeamWindows('owner-a', 6),
    windows: [{
      ...completedTeamWindows('owner-a', 6).windows[0],
      assetKey: skaterAsset.assetKey,
      asset: skaterAsset,
      scheduledGameIds: [1],
      completedGameIds: [1],
      gameScores: { 1: 6 },
      gameStates: { 1: 'final' },
      gameInputCompleteness: { 1: assessSkater() },
      incompleteFinalGameIds: [],
      scheduledGames: 1,
      gamesPlayed: 1,
      actualGamesPlayed: 1,
      gamesLeft: 0,
    }],
  };
  await teamWindowsRef.set(settledWindow);

  const staleSummary = {
    assetKey: skaterAsset.assetKey,
    ownerId: 'owner-a',
    rosterSlotId: 'C-1',
    windowId: 'owner-a__C-1__cycle-1',
    currentScore: 0,
    gamesPlayed: 0,
    actualGamesPlayed: 0,
    scheduledGames: 1,
    gamesLeft: 1,
    scheduledGameIds: [1],
    scheduledGameDates: ['2026-10-01'],
    scheduledGameLabels: ['vs VAN'],
    completedGameIds: [],
    incompleteFinalGameIds: [1],
    liveGameIds: [],
    appearanceGameIds: [],
    gameScores: {},
    gameStates: { 1: 'final' },
    gameInputCompleteness: {
      1: assessSkater({
        boxscore: sourceState('temporarily-unavailable', 'stale worker failure'),
      }),
    },
    firstScheduledGameDate: '2026-10-01',
    lastScheduledGameDate: '2026-10-01',
    status: 'active',
  };

  await assetWindows.syncCycleTeamWindows(
    leagueId,
    {
      id: 'cycle-1', cycleNumber: 1, status: 'active', phase: 'regular_season',
      matchupIds: [], expectedRosterSlotIdsByOwner: { 'owner-a': ['C-1'] },
    },
    [scoringPick()],
    {
      scoringSchemaVersion: 2,
      assetScores: { [skaterAsset.assetKey]: staleSummary },
      windowScores: { 'owner-a__C-1__cycle-1': staleSummary },
      teamScores: { 'owner-a': 0 },
      teamGameCounts: { SEA: 1 },
      teamCycleComplete: { 'owner-a': false },
      cycleHasScheduledGames: true,
      hasLiveGames: false,
      hasIncompleteFinalGames: true,
      nextScheduledGameStart: null,
      refreshedAt: new Date().toISOString(),
      dataFingerprint: 'stale-incomplete',
    },
  );
  const saved = await teamWindowsRef.get();
  const savedWindow = saved.data().windows[0];

  assert.equal(saved.data().status, 'complete');
  assert.equal(savedWindow.status, 'complete');
  assert.equal(savedWindow.fantasyPoints, 6);
  assert.deepEqual(savedWindow.completedGameIds, [1]);
  assert.deepEqual(savedWindow.incompleteFinalGameIds, []);
});

test('duplicate roster-move reconciliation activates once and writes one transaction', async (t) => {
  const leagueId = `roster-${randomUUID()}`;
  const outgoingAsset = rosterSkater(11, 'skater-11', 'active');
  const incomingAsset = rosterSkater(12, 'skater-12', 'new');
  const queuedAt = '2026-10-01T00:00:00.000Z';
  const pickRef = firestore.doc(
    `leagues/${leagueId}/cycles/cycle-2/rosterPicks/owner-a__C-1`,
  );
  const rosterRef = firestore.doc(`leagues/${leagueId}/teams/owner-a/roster/current`);
  const cycle = {
    id: 'cycle-2',
    cycleNumber: 2,
    status: 'active',
    phase: 'regular_season',
    matchupIds: [],
  };
  const team = fantasyTeam('owner-a');
  const projectedIncomingAsset = {
    ...skaterAsset,
    assetKey: 'skater-12',
    player: incomingAsset.player,
    projectedCyclePoints: 4,
    targetProjectionCycleNumber: 2,
  };

  t.mock.method(windowProjection, 'ensureWindowProjectionBundle', async () => ({
    metadata: null,
    assetsByKey: new Map([['skater-12', projectedIncomingAsset]]),
    source: 'fresh-target',
    refreshed: false,
    usedFallback: false,
    errorMessage: '',
  }));
  await Promise.all([
    pickRef.set({
      overallPick: 1,
      round: 1,
      pickInRound: 1,
      ownerId: 'owner-a',
      rosterSlotId: 'C-1',
      cycleWindowId: 'owner-a__C-1__cycle-2',
      snapshotCycleNumber: 2,
      snapshottedAt: Timestamp.fromDate(new Date('2026-10-02T00:00:00.000Z')),
      asset: {
        ...skaterAsset,
        assetKey: 'skater-11',
        player: outgoingAsset.player,
      },
    }),
    rosterRef.set({
      schemaVersion: 1,
      activeSlots: [{
        slotId: 'C-1',
        position: 'C',
        slotNumber: 1,
        asset: outgoingAsset,
        pendingMove: {
          id: 'queued-move-1',
          moveType: 'add-drop',
          incomingAsset,
          outgoingAssetKey: 'skater-11',
          sourceWaiverId: null,
          queuedByOwnerId: 'owner-a',
          queuedAt,
          requestedEffectiveCycleNumber: 2,
          requestedEffectiveLabel: 'Cycle 2',
        },
        openFromCycleNumber: null,
      }],
      benchSlots: [],
      irSlots: [],
    }),
  ]);

  const first = await cycleService.reconcilePendingRosterMovesForRegularSeasonCycle(
    leagueId,
    [team],
    cycle,
  );
  const duplicate = await cycleService.reconcilePendingRosterMovesForRegularSeasonCycle(
    leagueId,
    [team],
    cycle,
  );
  const [savedRoster, savedPick, transactions] = await Promise.all([
    rosterRef.get(),
    pickRef.get(),
    firestore.collection(`leagues/${leagueId}/transactions`).get(),
  ]);

  assert.equal(first.activatedMoveCount, 1);
  assert.equal(duplicate.activatedMoveCount, 0);
  assert.equal(savedRoster.data().activeSlots[0].asset.assetKey, 'skater-12');
  assert.equal(savedRoster.data().activeSlots[0].pendingMove, null);
  assert.equal(savedPick.data().asset.assetKey, 'skater-12');
  assert.equal(savedPick.data().snapshotSource, 'queued-slot-move-reconciled');
  assert.equal(transactions.size, 1);
  assert.equal(transactions.docs[0].data().queuedMoveId, 'queued-move-1');
});

test('duplicate playoff results cannot advance the bracket twice', () => {
  const teams = [
    fantasyTeam('owner-a', { wins: 4, pointsFor: 40 }),
    fantasyTeam('owner-b', { wins: 3, pointsFor: 30 }),
    fantasyTeam('owner-c', { wins: 2, pointsFor: 20 }),
    fantasyTeam('owner-d', { wins: 1, pointsFor: 10 }),
  ];
  const playoffs = playoffService.createStandardFantasyPlayoffs(teams, 11);
  const firstRoundMatchups = playoffService.getPlayoffRoundMatchups(playoffs, 1);
  const results = firstRoundMatchups.map((matchup) => ({
    matchupId: matchup.id,
    teamAScore: 5,
    teamBScore: 2,
    winnerOwnerId: matchup.teamAOwnerId,
    loserOwnerId: matchup.teamBOwnerId,
    tieBrokenByHigherSeed: false,
  }));
  const first = playoffService.applyPlayoffRoundResults(playoffs, 1, results);
  const duplicate = playoffService.applyPlayoffRoundResults(first, 1, results);
  const summarizeNextRound = (value) => playoffService
    .getPlayoffRoundMatchups(value, 2)
    .map((matchup) => [matchup.id, matchup.teamAOwnerId, matchup.teamBOwnerId]);

  assert.equal(first.currentRoundNumber, 2);
  assert.equal(duplicate.currentRoundNumber, 2);
  assert.deepEqual(summarizeNextRound(duplicate), summarizeNextRound(first));
  assert.deepEqual(duplicate.placements, first.placements);
});

test('write paths preserve transaction, standings, playoff, and completed-matchup guards', async () => {
  const [automation, cycleService, assetWindows, playoffWindows] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('functions/src/shared/core/cycle/cycle.service.ts'),
    read('functions/src/shared/core/cycle/asset-cycle-window.service.ts'),
    read('functions/src/shared/core/playoffs/playoff-window-bank.service.ts'),
  ]);

  assert.match(automation, /reconcilePendingRosterMoves/);
  assert.match(automation, /decideCanonicalRequestCompletion/);
  assert.match(cycleService, /if \(!cycle\.standingsAppliedAt\)/);
  assert.match(cycleService, /if \(matchup\.status === 'complete'\)/);
  assert.match(cycleService, /playoffs have already been completed/);
  assert.match(assetWindows, /completedAt: value\.completedAt \?\? null/);
  assert.match(playoffWindows, /previousResult/);
});

test('the scorer retains settled failures and gates final reuse on complete evidence', async () => {
  const scorer = await read('functions/src/shared/core/cycle/cycle-scoring.service.ts');

  assert.match(scorer, /Promise\.allSettled/);
  assert.match(scorer, /classifyNhlFinalInputFailure/);
  assert.match(scorer, /isReusableNhlFinalScore/);
  assert.match(scorer, /validateNhlFinalSkaterBoxscore/);
  assert.match(scorer, /validateNhlFinalGoalieUnitBoxscore/);
  assert.match(scorer, /incompleteFinalGameIds\.push\(game\.id\)/);
  assert.match(scorer, /if \(!completeness\.complete\)/);
  assert.match(scorer, /continue;\s*}\s*gameInputCompleteness\[gameIdKey\] = completeness/s);
});

test('replay source-team evidence is wired through regular and playoff scoring paths', async () => {
  const [automation, scorer, playoffWindows] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
    read('functions/src/shared/core/playoffs/playoff-window-bank.service.ts'),
  ]);

  assert.match(automation, /schemaVersion:\s*2/);
  assert.match(automation, /normalizeHistoricalReplayAssetMap/);
  assert.match(automation, /sourceTeamAbbreviationByAssetGameId/);
  assert.match(automation, /replaySourceTeamAbbreviationByAssetGameId/);
  assert.match(scorer, /requireSourceTeamAbbreviation:\s*Boolean\(input\.replayGamesByAssetKey\)/);
  assert.match(scorer, /Historical replay source-team identity is unavailable/);
  assert.match(playoffWindows, /replaySourceTeamAbbreviationByAssetGameId/);
});

test('canonical writes and durable work share a transaction and exact version identity', async () => {
  const [feed, service, automation] = await Promise.all([
    read('functions/src/nhl-canonical-impact-feed.ts'),
    read('functions/src/shared/core/nhl/nhl-canonical-publication-outbox.service.ts'),
    read('functions/src/league-automation.ts'),
  ]);

  assert.match(service, /runTransaction/);
  assert.match(service, /transaction\.set\(canonicalRef/);
  assert.match(service, /transaction\.set\(outboxRef/);
  assert.match(service, /buildCanonicalPublicationOutboxId/);
  assert.match(feed, /currentSourceVersion !== entry\.sourceVersion/);
  assert.match(feed, /outcome: 'superseded'/);
  assert.match(
    automation,
    /canonicalParityRequestedGameIds:\s*canonicalParityLoad\s*\?\s*new Set\(canonicalParityLoad\.requestedGameIds\)/,
  );
  assert.match(automation, /sourceVersion !== expectedSourceVersion/);
});

test('D1L leaves protected scoring, Projection V11, Rules, and indexes unchanged', async () => {
  const protectedPaths = [
    ['src/app/core/scoring/scoring-rules.ts', 'scoringRules'],
    ['functions/src/shared/core/scoring/scoring-rules.ts', 'scoringRules'],
    ['src/app/core/scoring/scoring-engine.ts', 'scoringEngine'],
    ['functions/src/shared/core/scoring/scoring-engine.ts', 'scoringEngine'],
    ['src/app/core/projection/projection-v11.util.ts', 'projectionV11'],
    ['functions/src/shared/core/projection/projection-v11.util.ts', 'projectionV11'],
    ['firestore.rules', 'firestoreRules'],
    ['firestore.indexes.json', 'firestoreIndexes'],
  ];

  for (const [relativePath, hashKey] of protectedPaths) {
    assert.equal(await sha256(relativePath), PROTECTED_SOURCE_HASHES[hashKey]);
  }
});

test('D1L focused commands and operational documentation are present', async () => {
  const [packageJson, handoff, design, runbook] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_CODEX_HANDOFF.md'),
    read('docs/RINKRAT_DATA_D1L_FINAL_SCORE_INPUT_INTEGRITY.md'),
    read('docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md'),
  ]);
  const scripts = JSON.parse(packageJson).scripts;

  assert.match(scripts['test:batchd1l'], /emulators:exec/);
  assert.match(scripts['verify:batchd1l:core'], /verify:batchd1j2:core/);
  assert.match(handoff, /final-input completeness/);
  assert.match(design, /Architecture recommendations not implemented/);
  assert.match(design, /pollCanonicalNhlImpactFeed/);
  assert.match(runbook, /nhlCanonicalPublicationOutbox/);
});
