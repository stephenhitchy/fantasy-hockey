import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildFreeAgentStatComparisonRows,
  buildIncomingEligibilityComparisonGames,
  buildOutgoingWindowComparisonGames,
  resolveFreeAgentTransactionTiming,
} from '../../src/app/features/free-agents/free-agent-transaction-comparison.util.ts';
import {
  isFreeAgentOperationObserved,
  withFreeAgentOperationTimeout,
} from '../../src/app/features/free-agents/free-agent-operation-resolution.util.ts';
import {
  calculateRosterMoveAssetCycleEligibility,
} from '../../src/app/core/transactions/roster-move-eligibility.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function timingInput(overrides = {}) {
  return {
    incomingName: 'New Player',
    outgoingName: 'Current Player',
    rosterArea: 'active',
    isWaiver: false,
    seasonHasStarted: true,
    canApplyImmediately: false,
    effectiveCycleNumber: 3,
    slotNextCycleNumber: 3,
    outgoingCycleNumber: 2,
    outgoingWindowStatus: 'active',
    outgoingFinalGames: 4,
    outgoingLiveGames: 0,
    outgoingScheduledGames: 6,
    incomingCurrentCycleNumber: 2,
    incomingFinalGames: 0,
    incomingLiveGames: 0,
    incomingScheduledGames: 6,
    incomingHasStarted: false,
    incomingEarliestCycleNumber: 2,
    ...overrides,
  };
}

test('same-matchup players are identified clearly and an untouched assignment can change now', () => {
  const decision = resolveFreeAgentTransactionTiming(timingInput({
    canApplyImmediately: true,
    effectiveCycleNumber: 2,
    slotNextCycleNumber: 2,
    outgoingCycleNumber: 2,
    outgoingFinalGames: 0,
    incomingCurrentCycleNumber: 2,
    incomingFinalGames: 0,
  }));

  assert.equal(decision.relationship, 'same-matchup');
  assert.equal(decision.delaySource, 'none');
  assert.match(decision.relationshipLabel, /Both sides are currently aligned to Matchup 2/);
  assert.match(decision.headline, /No delay/);
  assert.equal(decision.startLabel, 'Starts Matchup 2');
});

test('an incoming player one matchup behind is never backfilled and starts in the selected next window', () => {
  const decision = resolveFreeAgentTransactionTiming(timingInput({
    effectiveCycleNumber: 3,
    slotNextCycleNumber: 3,
    outgoingCycleNumber: 3,
    outgoingFinalGames: 0,
    incomingCurrentCycleNumber: 2,
    incomingFinalGames: 6,
    incomingHasStarted: true,
    incomingEarliestCycleNumber: 3,
  }));

  assert.equal(decision.relationship, 'incoming-behind');
  assert.match(decision.relationshipLabel, /1 matchup behind/);
  assert.match(decision.relationshipLabel, /never backfills/i);
  assert.match(decision.detail, /next clean matchup window: Matchup 3/);
});

test('the incoming player is named as the delay when their NHL block is ahead or already started', () => {
  const decision = resolveFreeAgentTransactionTiming(timingInput({
    effectiveCycleNumber: 4,
    slotNextCycleNumber: 3,
    outgoingCycleNumber: 2,
    outgoingFinalGames: 6,
    outgoingWindowStatus: 'complete',
    incomingCurrentCycleNumber: 3,
    incomingFinalGames: 2,
    incomingHasStarted: true,
    incomingEarliestCycleNumber: 4,
  }));

  assert.equal(decision.delaySource, 'incoming-player');
  assert.match(decision.headline, /New Player is delaying/);
  assert.match(decision.detail, /2\/6 games/);
  assert.match(decision.detail, /Matchup 4/);
});

test('the current player is named as the delay while their immutable six-game window is active', () => {
  const decision = resolveFreeAgentTransactionTiming(timingInput({
    effectiveCycleNumber: 3,
    slotNextCycleNumber: 3,
    outgoingCycleNumber: 2,
    outgoingFinalGames: 4,
    incomingCurrentCycleNumber: 2,
    incomingFinalGames: 0,
    incomingHasStarted: false,
    incomingEarliestCycleNumber: 2,
  }));

  assert.equal(decision.delaySource, 'outgoing-player');
  assert.match(decision.headline, /Current Player is delaying/);
  assert.match(decision.detail, /4\/6 NHL team games final/);
  assert.match(decision.detail, /new player starts in Matchup 3/i);
});

test('both players are named when both six-game histories have started', () => {
  const decision = resolveFreeAgentTransactionTiming(timingInput({
    effectiveCycleNumber: 3,
    slotNextCycleNumber: 3,
    outgoingCycleNumber: 2,
    outgoingFinalGames: 2,
    incomingCurrentCycleNumber: 2,
    incomingFinalGames: 1,
    incomingHasStarted: true,
    incomingEarliestCycleNumber: 3,
  }));

  assert.equal(decision.delaySource, 'both-players');
  assert.match(decision.headline, /Both players/);
  assert.match(decision.detail, /Current Player/);
  assert.match(decision.detail, /New Player/);
});

test('outgoing comparison rows preserve exact game dates, opponents, appearances, misses, and fantasy points', () => {
  const rows = buildOutgoingWindowComparisonGames({
    id: 'window-2',
    ownerId: 'owner-a',
    rosterSlotId: 'D-1',
    cycleNumber: 2,
    position: 'D',
    assetKey: 'skater-8',
    asset: {},
    status: 'active',
    scheduledGameIds: [101, 102, 103, 104, 105, 106],
    scheduledGameDates: ['2026-11-01', '2026-11-03', '2026-11-05', '2026-11-07', '2026-11-09', '2026-11-11'],
    scheduledGameLabels: ['vs BOS', '@ NYR', 'vs BUF', '@ TOR', 'vs MTL', '@ OTT'],
    completedGameIds: [101, 102],
    liveGameIds: [103],
    appearanceGameIds: [101],
    gameScores: { '101': 18.25, '102': 0, '103': 3.04 },
    gameStates: { '101': 'final', '102': 'final', '103': 'live' },
    scheduledGames: 6,
    gamesPlayed: 2,
    actualGamesPlayed: 1,
    gamesLeft: 4,
    fantasyPoints: 21.29,
    frozenProjectionPoints: 70,
    frozenProjectionVersion: 11,
    frozenProjectionSource: 'shared-snapshot',
    frozenProjectionSnapshotId: 'snapshot',
    frozenProjectionGeneratedAt: null,
    frozenProjectionFrozenAt: null,
    frozenProjectionTargetGameIds: [],
    firstScheduledGameDate: '2026-11-01',
    lastScheduledGameDate: '2026-11-11',
  }, 6);

  assert.deepEqual(rows.slice(0, 3).map((row) => ({
    date: row.gameDate,
    opponent: row.opponentLabel,
    state: row.state,
    points: row.fantasyPoints,
  })), [
    { date: '2026-11-01', opponent: 'vs BOS', state: 'appeared', points: 18.3 },
    { date: '2026-11-03', opponent: '@ NYR', state: 'missed', points: 0 },
    { date: '2026-11-05', opponent: 'vs BUF', state: 'live', points: 3 },
  ]);
});

test('incoming comparison can show both the current block and the exact first legal matchup schedule', () => {
  const eligibility = {
    assetKey: 'skater-9',
    teamAbbreviation: 'CBJ',
    season: '20262027',
    gamesPerCycle: 6,
    currentCycleNumber: 2,
    completedGamesInCurrentCycle: 3,
    liveGamesInCurrentCycle: 0,
    scheduledGamesInCurrentCycle: 6,
    currentCycleHasStarted: true,
    currentCycleIsComplete: false,
    earliestEligibleCycleNumber: 3,
    checkedAt: '2026-11-07T00:00:00.000Z',
    currentCycleGames: [],
    gamesByCycleNumber: {
      2: [
        { gameId: 201, gameDate: '2026-11-01', opponentAbbreviation: 'DET', venue: 'home', state: 'final' },
      ],
      3: [
        { gameId: 301, gameDate: '2026-11-14', opponentAbbreviation: 'PIT', venue: 'away', state: 'scheduled' },
      ],
    },
  };

  const current = buildIncomingEligibilityComparisonGames(eligibility, 2, [
    { gameId: 201, gameDate: '2026-11-01', opponentAbbreviation: 'DET', venue: 'home', status: 'played' },
  ], 6);
  const start = buildIncomingEligibilityComparisonGames(eligibility, 3, [], 6);

  assert.equal(current[0].state, 'appeared');
  assert.equal(current[0].opponentLabel, 'vs DET');
  assert.equal(start[0].state, 'upcoming');
  assert.equal(start[0].opponentLabel, '@ PIT');
});

test('full stat comparison keeps every category from either player in old-left/new-right order', () => {
  const rows = buildFreeAgentStatComparisonRows(
    [
      { key: 'shots', label: 'Shots', statValue: 100, statUnit: 'SOG', fantasyPoints: 100 },
      { key: 'blocks', label: 'Blocks', statValue: 30, statUnit: 'BLK', fantasyPoints: 22.5 },
    ],
    [
      { key: 'goals', label: 'Goals', statValue: 20, statUnit: 'G', fantasyPoints: 220 },
      { key: 'shots', label: 'Shots', statValue: 130, statUnit: 'SOG', fantasyPoints: 130 },
    ],
  );

  assert.deepEqual(rows.map((row) => row.key), ['goals', 'shots', 'blocks']);
  assert.equal(rows[0].outgoing, null);
  assert.equal(rows[1].outgoing.statValue, 100);
  assert.equal(rows[1].incoming.statValue, 130);
  assert.equal(rows[2].incoming, null);
});

test('a stalled NHL eligibility refresh unlocks instead of leaving the comparison busy forever', async () => {
  await assert.rejects(
    withFreeAgentOperationTimeout(new Promise(() => {}), 5, 'Schedule check timed out.'),
    /Schedule check timed out/,
  );

  assert.equal(
    await withFreeAgentOperationTimeout(Promise.resolve('ready'), 100, 'should not time out'),
    'ready',
  );
});

test('historical replay eligibility uses the simulated date instead of live FUT game states', () => {
  const asset = {
    assetKey: 'skater-9',
    assetType: 'skater',
    position: 'D',
    player: {
      id: 9,
      fullName: 'Replay Defenseman',
      nhlTeamAbbreviation: 'CBJ',
    },
  };
  const schedule = Array.from({ length: 12 }, (_, index) => ({
    id: 500 + index,
    gameDate: `2026-10-${String(1 + (index * 2)).padStart(2, '0')}`,
    gameType: 2,
    gameState: 'FUT',
    homeTeam: {
      abbrev: index % 2 === 0 ? 'CBJ' : 'BOS',
    },
    awayTeam: {
      abbrev: index % 2 === 0 ? 'BOS' : 'CBJ',
    },
  }));

  const liveEvaluation = calculateRosterMoveAssetCycleEligibility(
    asset,
    schedule,
    6,
    '20262027',
    new Date('2026-10-17T12:00:00Z'),
  );
  const replayEvaluation = calculateRosterMoveAssetCycleEligibility(
    asset,
    schedule,
    6,
    '20262027',
    new Date('2026-10-17T12:00:00Z'),
    '2026-10-17',
  );

  assert.equal(liveEvaluation.currentCycleNumber, 1);
  assert.equal(liveEvaluation.earliestEligibleCycleNumber, 1);
  assert.equal(liveEvaluation.evaluationMode, 'live');
  assert.equal(replayEvaluation.currentCycleNumber, 2);
  assert.equal(replayEvaluation.completedGamesInCurrentCycle, 3);
  assert.equal(replayEvaluation.earliestEligibleCycleNumber, 3);
  assert.equal(replayEvaluation.evaluationMode, 'historical-replay');
  assert.equal(replayEvaluation.completedThroughDate, '2026-10-17');
});

test('live roster confirmation accepts immediate, queued, boundary-activated, and bench results', () => {
  const observation = {
    activeSlots: [
      { slotId: 'LW-1', assetKey: 'skater-new', pendingIncomingAssetKey: null },
      { slotId: 'C-1', assetKey: 'skater-old', pendingIncomingAssetKey: 'skater-queued' },
    ],
    benchSlots: [
      { slotId: 'BENCH-1', assetKey: 'skater-bench', pendingIncomingAssetKey: null },
    ],
    waivers: [],
  };

  assert.equal(isFreeAgentOperationObserved({
    kind: 'roster-slot', rosterArea: 'active', slotId: 'LW-1', incomingAssetKey: 'skater-new',
  }, observation), true);
  assert.equal(isFreeAgentOperationObserved({
    kind: 'roster-slot', rosterArea: 'active', slotId: 'C-1', incomingAssetKey: 'skater-queued',
  }, observation), true);
  assert.equal(isFreeAgentOperationObserved({
    kind: 'roster-slot', rosterArea: 'bench', slotId: 'BENCH-1', incomingAssetKey: 'skater-bench',
  }, observation), true);
});

test('live waiver listener confirmation releases the UI even when the callable response is delayed', () => {
  assert.equal(isFreeAgentOperationObserved({
    kind: 'waiver-claim', waiverId: 'waiver-1',
  }, {
    activeSlots: [],
    benchSlots: [],
    waivers: [{ waiverId: 'waiver-1', hasOwnerClaim: true }],
  }), true);
});

test('the transaction workbench keeps confirmation at the top, introduces the incoming player first, and preserves exact timelines', async () => {
  const template = await read('src/app/features/free-agents/free-agents.html');

  assert.match(template, /action-sheet-top-actions[\s\S]*top-confirm-move-button/);
  assert.match(template, /\[wide\]="true"/);
  assert.ok(template.indexOf('incoming-scout-card') < template.indexOf('replacement-card-list'));
  assert.match(template, /selected-final-copy[\s\S]*Final Move Summary/);
  assert.match(template, /getCandidateComparisonGames\(candidate\)/);
  assert.match(template, /incomingCurrentComparisonGames\(\)/);
  assert.match(template, /incomingStartComparisonGames\(\)/);
  assert.match(template, /Season Point Formula/);
  assert.match(template, /getTransactionDelayLabel\(\)/);
});

test('the add/drop page refreshes exact eligibility from the historical replay control', async () => {
  const [source, template, replayContext] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/core/transactions/roster-move-replay-context.util.ts'),
  ]);

  assert.match(source, /listenToHistoricalReplayControl/);
  assert.match(source, /historicalReplayControl = signal<HistoricalReplayControl \| null>/);
  assert.match(source, /historicalReplayControlLoaded = signal\(false\)/);
  assert.match(source, /checking whether historical replay is active/i);
  assert.match(source, /resolveRosterMoveReplayContext/);
  assert.match(source, /seasonOverride:\s*replayContext\.seasonOverride/);
  assert.match(source, /completedThroughDate:\s*replayContext\.completedThroughDate/);
  assert.match(replayContext, /Historical replay is advancing to the next day/);
  assert.match(replayContext, /safePregameRecovery/);
  assert.match(source, /evaluationMode === 'historical-replay'/);
  assert.match(template, /getEligibilityEvaluationLabel\(\)/);
  assert.match(template, /transaction-replay-evaluation-note/);
});

test('the add/drop operation no longer hides its sheet behind a fuzzy full-screen shield', async () => {
  const [source, template, globalStyles] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/rinkrat-mobile-roster-v1.css'),
  ]);

  assert.match(source, /shouldShowRosterActionShield\(\): boolean[\s\S]*flowStep\(\) !== 'roster-slot'/);
  assert.match(source, /awaitRosterActionConfirmation/);
  assert.match(source, /live-roster confirmation/);
  assert.match(source, /20_000/);
  assert.match(source, /15_000/);
  assert.match(source, /withFreeAgentOperationTimeout/);
  assert.match(source, /waitForUiUnlockFrame/);
  assert.match(template, /@if \(shouldShowRosterActionShield\(\)\)/);
  assert.match(globalStyles, /\.roster-action-shield[\s\S]*backdrop-filter:\s*none/);
  assert.match(globalStyles, /\.transaction-player-pair[\s\S]*grid-template-columns:\s*repeat\(2/);
});

test('action sheet supports a wider comparison surface and a fixed top-action row', async () => {
  const [source, template, styles] = await Promise.all([
    read('src/app/shared/action-sheet/action-sheet.ts'),
    read('src/app/shared/action-sheet/action-sheet.html'),
    read('src/app/shared/action-sheet/action-sheet.css'),
  ]);

  assert.match(source, /@Input\(\) wide = false/);
  assert.match(template, /rr-action-sheet--wide/);
  assert.match(template, /action-sheet-top-actions/);
  assert.match(styles, /grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.rr-action-sheet--wide[\s\S]*68rem/);
});
