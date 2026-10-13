import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test, { after, before, beforeEach } from 'node:test';

const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);
const projectId = 'demo-rinkrat-future-lineups';

process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;

const { manageFutureMatchupLineups } = requireFunctions(
  './lib/future-matchup-lineup.js',
);
const {
  advanceCompletedRegularSeasonAssetWindows,
  startNextCycle,
} = requireFunctions(
  './lib/shared/core/cycle/cycle.service.js',
);
const {
  createFutureMatchupLineupAssignmentHash,
} = requireFunctions(
  './lib/shared/core/team/future-matchup-lineup.util.js',
);
const nhlApi = requireFunctions(
  './lib/shared/core/nhl/nhl-api.service.js',
);
const firebaseAdminCompat = requireFunctions(
  './lib/shared/core/firebase-admin-compat.js',
);
const serverFirebase = requireFunctions('./lib/shared/core/firebase.js');
const { deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
const { getFirestore } = requireFunctions('firebase-admin/firestore');

const leagueId = 'league-future-lineups';
const ownerId = 'owner-future-lineups';
const opponentId = 'owner-opponent';
const leagueTeams = [
  { id: ownerId, ownerId, teamName: 'Future Team' },
  { id: opponentId, ownerId: opponentId, teamName: 'Opponent' },
];

let app;
let db;

async function resetEmulator() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  assert.ok(
    emulatorHost,
    'Future-lineup transaction tests require the Firestore emulator.',
  );
  const response = await fetch(
    `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(response.ok, true, await response.text());
}

function skater(id, position, rosterStatus = 'active') {
  return {
    assetKey: `skater-${id}`,
    assetType: 'skater',
    position,
    rosterStatus,
    player: {
      id,
      fullName: `Player ${id}`,
      position,
      nhlTeamAbbreviation: 'SEA',
    },
    cycleScore: { cycleNumber: 1, gamesCounted: 0, fantasyPoints: 0 },
  };
}

function goalie(id, rosterStatus = 'active') {
  return {
    assetKey: `goalie-unit-${id}`,
    assetType: 'team-goalie-unit',
    position: 'G',
    teamName: `Goalies ${id}`,
    teamAbbreviation: id,
    teamLogoUrl: null,
    rosterStatus,
    cycleScore: { cycleNumber: 1, gamesCounted: 0, fantasyPoints: 0 },
  };
}

function activeSlot(slotId, position, slotNumber, asset) {
  return {
    slotId,
    position,
    slotNumber,
    asset,
    pendingMove: null,
    openFromCycleNumber: null,
  };
}

function buildRoster() {
  return {
    schemaVersion: 2,
    activeSlots: [
      activeSlot('LW-1', 'LW', 1, skater(1, 'LW')),
      activeSlot('LW-2', 'LW', 2, skater(2, 'LW')),
      activeSlot('LW-3', 'LW', 3, skater(3, 'LW')),
      activeSlot('C-1', 'C', 1, skater(4, 'C')),
      activeSlot('C-2', 'C', 2, skater(5, 'C')),
      activeSlot('C-3', 'C', 3, skater(6, 'C')),
      activeSlot('RW-1', 'RW', 1, skater(7, 'RW')),
      activeSlot('RW-2', 'RW', 2, skater(8, 'RW')),
      activeSlot('RW-3', 'RW', 3, skater(9, 'RW')),
      activeSlot('D-1', 'D', 1, skater(10, 'D')),
      activeSlot('D-2', 'D', 2, skater(11, 'D')),
      activeSlot('D-3', 'D', 3, skater(12, 'D')),
      activeSlot('D-4', 'D', 4, skater(13, 'D')),
      activeSlot('G-1', 'G', 1, goalie('SEA')),
    ],
    benchSlots: [
      { slotId: 'B-1', slotNumber: 1, asset: skater(100, 'C', 'benched') },
      { slotId: 'B-2', slotNumber: 2, asset: skater(101, 'C', 'benched') },
      { slotId: 'B-3', slotNumber: 3, asset: skater(102, 'LW', 'benched') },
      { slotId: 'B-4', slotNumber: 4, asset: skater(103, 'RW', 'benched') },
      { slotId: 'B-5', slotNumber: 5, asset: skater(104, 'D', 'benched') },
    ],
    irSlots: [
      { slotId: 'IR-1', slotNumber: 1, asset: null },
      { slotId: 'IR-2', slotNumber: 2, asset: null },
      { slotId: 'IR-3', slotNumber: 3, asset: null },
    ],
  };
}

function requestedSlots(roster, replacements = {}) {
  return roster.activeSlots.map((slot) => ({
    rosterSlotId: slot.slotId,
    assetKey: replacements[slot.slotId] ?? slot.asset?.assetKey ?? null,
  }));
}

async function seedMaterializedGoalieSwap(t, options = {}) {
  const cycleNumber = options.cycleNumber ?? 2;
  const cycleId = `cycle-${cycleNumber}`;
  const roster = buildRoster();
  const outgoing = roster.activeSlots.find((slot) => slot.slotId === 'G-1').asset;
  const incoming = goalie('VAN', 'benched');
  roster.benchSlots[4] = {
    slotId: 'B-5',
    slotNumber: 5,
    asset: incoming,
  };
  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  ).set(roster);
  const futureGames = (team, firstId) => Array.from({ length: 6 }, (_, index) => ({
    id: firstId + index,
    gameDate: `2099-10-${String(index + 1).padStart(2, '0')}`,
    startTimeUTC: `2099-10-${String(index + 1).padStart(2, '0')}T20:00:00.000Z`,
    gameType: 2,
    gameState: 'FUT',
    homeTeam: { abbrev: team },
    awayTeam: { abbrev: team === 'SEA' ? 'VAN' : 'SEA' },
  }));
  const outgoingGames = futureGames('SEA', 101);
  const outgoingFrozenGameIds = options.outgoingGameIds ??
    [101, 102, 103, 104, 105, 106];
  const incomingFrozenGameIds = options.incomingGameIds ??
    [201, 202, 203, 204, 205, 206];
  if (options.outgoingStarted === true) {
    outgoingGames[0] = {
      ...outgoingGames[0],
      gameDate: '2026-10-11',
      startTimeUTC: '2026-10-11T20:00:00.000Z',
      gameState: 'FINAL',
    };
  }
  t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async (team) =>
    team.toUpperCase() === 'SEA'
      ? outgoingGames
      : futureGames('VAN', 201),
  );
  await Promise.all([
    db.doc(`leagues/${leagueId}/cycles/${cycleId}`).set({
      id: cycleId,
      cycleNumber,
      phase: 'regular_season',
      status: 'active',
      ...(options.omitCycleExpectedRosterSlotIds === true
        ? {}
        : {
            expectedRosterSlotIdsByOwner: {
              [ownerId]: options.cycleExpectedRosterSlotIds ?? ['G-1'],
            },
          }),
      sourceNhlTargetGameIdsByTeam: {
        SEA: outgoingFrozenGameIds,
        VAN: incomingFrozenGameIds,
      },
    }),
    db.doc(
      `leagues/${leagueId}/cycles/${cycleId}/rosterPicks/${ownerId}__G-1`,
    ).set({
      overallPick: 14,
      round: 1,
      pickInRound: 14,
      ownerId,
      rosterSlotId: 'G-1',
      cycleWindowId: `${ownerId}__G-1__${cycleId}`,
      snapshotCycleNumber: cycleNumber,
      sourceNhlBlockNumber: cycleNumber,
      sourceNhlTargetGameIds: outgoingFrozenGameIds,
      sourceNhlTargetGameIdsByTeam: {
        SEA: outgoingFrozenGameIds,
        VAN: incomingFrozenGameIds,
      },
      asset: outgoing,
      ...(options.pickInjuryReplacementWindow === undefined
        ? {}
        : {
            injuryReplacementWindow:
              options.pickInjuryReplacementWindow,
          }),
    }),
    db.doc(
      `leagues/${leagueId}/cycles/${cycleId}/teamWindows/${ownerId}`,
    ).set({
      id: ownerId,
      ownerId: options.teamWindowsOwnerId ?? ownerId,
      cycleNumber: options.teamWindowsCycleNumber ?? cycleNumber,
      ...(options.omitExpectedRosterSlotIds === true
        ? {}
        : {
            expectedRosterSlotIds:
              options.expectedRosterSlotIds ?? ['G-1'],
          }),
      windows: [{
        id: `${ownerId}__G-1__${cycleId}`,
        ownerId,
        rosterSlotId: 'G-1',
        cycleNumber,
        position: 'G',
        assetKey: 'goalie-unit-SEA',
        asset: outgoing,
        status: 'scheduled',
        scheduledGameIds: outgoingFrozenGameIds,
        scheduledGameDates: [],
        scheduledGameLabels: [],
        completedGameIds: [],
        liveGameIds: [],
        appearanceGameIds: [],
        incompleteFinalGameIds: [],
        gameScores: {},
        gameStates: {},
        gamesPlayed: 0,
        actualGamesPlayed: 0,
        fantasyPoints: 0,
        startedAt: null,
        completedAt: null,
      }, ...(options.additionalWindows ?? [])],
      completedWindowCount: 0,
      totalWindowCount: 1,
      status: 'scheduled',
    }),
  ]);

  return { outgoing, incoming };
}

async function assertMaterializedGoalieSwapUnchanged() {
  const [savedRoster, savedPick, savedWindows, savedPlan, mutationState, audit] =
    await Promise.all([
      db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
      db.doc(`leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__G-1`).get(),
      db.doc(`leagues/${leagueId}/cycles/cycle-2/teamWindows/${ownerId}`).get(),
      db.doc(`leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`).get(),
      db.doc(
        `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
      ).get(),
      db.collection(`leagues/${leagueId}/transactions`).get(),
    ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'G-1')
      .asset.assetKey,
    'goalie-unit-SEA',
  );
  assert.equal(
    savedRoster.data().benchSlots.find((slot) => slot.slotId === 'B-5')
      .asset.assetKey,
    'goalie-unit-VAN',
  );
  assert.equal(savedPick.data().asset.assetKey, 'goalie-unit-SEA');
  assert.equal(
    savedWindows.data().windows.find((window) => window.rosterSlotId === 'G-1')
      .assetKey,
    'goalie-unit-SEA',
  );
  assert.equal(savedPlan.exists, false);
  assert.equal(mutationState.exists, false);
  assert.equal(audit.empty, true);
}

async function seedEmptyActiveSlotPromotion(t, options = {}) {
  const roster = buildRoster();
  roster.activeSlots.find((slot) => slot.slotId === 'C-1').asset = null;
  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  ).set(roster);
  const frozenGameIds = options.incomingGameIds ??
    [301, 302, 303, 304, 305, 306];
  const schedule = frozenGameIds.map((gameId, index) => ({
    id: gameId,
    gameDate: `2099-11-${String(index + 1).padStart(2, '0')}`,
    startTimeUTC: `2099-11-${String(index + 1).padStart(2, '0')}T20:00:00.000Z`,
    gameType: 2,
    gameState: 'FUT',
    homeTeam: { abbrev: 'SEA' },
    awayTeam: { abbrev: 'VAN' },
  }));
  if (options.incomingStarted === true && schedule.length > 0) {
    schedule[0] = {
      ...schedule[0],
      gameDate: '2026-10-11',
      startTimeUTC: '2026-10-11T20:00:00.000Z',
      gameState: 'FINAL',
    };
  }
  t.mock.method(
    nhlApi,
    'getCurrentNhlPlayerTeamIdentity',
    async (playerId) => ({ playerId, teamAbbreviation: 'SEA' }),
  );
  t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async () => schedule);
  await db.doc(`leagues/${leagueId}/cycles/cycle-2`).set({
    id: 'cycle-2',
    cycleNumber: 2,
    phase: 'regular_season',
    status: 'active',
    sourceNhlTargetGameIdsByTeam: { SEA: frozenGameIds },
  });

  return roster;
}

async function seedLeague() {
  const batch = db.batch();
  batch.set(db.doc(`leagues/${leagueId}`), { id: leagueId });
  batch.set(db.doc(`leagues/${leagueId}/teams/${ownerId}`), {
    id: ownerId,
    ownerId,
    teamName: 'Future Team',
  });
  batch.set(db.doc(`leagues/${leagueId}/teams/${opponentId}`), {
    id: opponentId,
    ownerId: opponentId,
    teamName: 'Opponent',
  });
  batch.set(db.doc(`leagues/${leagueId}/members/${ownerId}`), {
    userId: ownerId,
  });
  batch.set(db.doc(`leagues/${leagueId}/draft/current`), {
    status: 'complete',
    initialNhlBlockNumber: 1,
  });
  batch.set(db.doc(`leagues/${leagueId}/cycles/cycle-1`), {
    id: 'cycle-1',
    cycleNumber: 1,
    phase: 'regular_season',
    status: 'active',
  });
  batch.set(
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`),
    buildRoster(),
  );
  await batch.commit();
}

async function call(data) {
  return manageFutureMatchupLineups.run({
    auth: { uid: ownerId, token: {} },
    data,
  });
}

async function interceptNextCompatTransaction(beforeTransaction, action) {
  const originalRunTransaction = firebaseAdminCompat.runTransaction;
  let intercepted = false;
  firebaseAdminCompat.runTransaction = async (...args) => {
    if (!intercepted) {
      intercepted = true;
      firebaseAdminCompat.runTransaction = originalRunTransaction;
      await beforeTransaction();
    }
    return originalRunTransaction(...args);
  };

  try {
    return await action();
  } finally {
    firebaseAdminCompat.runTransaction = originalRunTransaction;
    assert.equal(intercepted, true, 'expected to intercept the rollover transaction');
  }
}

async function interceptNextFutureLineupTransaction(beforeTransaction, action) {
  const originalRunTransaction = serverFirebase.db.runTransaction;
  let intercepted = false;
  serverFirebase.db.runTransaction = async (...args) => {
    if (!intercepted) {
      intercepted = true;
      serverFirebase.db.runTransaction = originalRunTransaction;
      await beforeTransaction();
    }
    return originalRunTransaction.apply(serverFirebase.db, args);
  };

  try {
    return await action();
  } finally {
    serverFirebase.db.runTransaction = originalRunTransaction;
    assert.equal(intercepted, true, 'expected to intercept the lineup transaction');
  }
}

function completedWindowFixture(slotId, asset, overallPick = 1) {
  const cycleWindowId = `${ownerId}__${slotId}__cycle-1`;
  const currentPick = {
    overallPick,
    round: 1,
    pickInRound: overallPick,
    ownerId,
    rosterSlotId: slotId,
    cycleWindowId,
    snapshotCycleNumber: 1,
    sourceNhlBlockNumber: 1,
    snapshotOrder: overallPick,
    snapshottedAt: new Date('2026-10-01T00:00:00.000Z'),
    playerWindowContinuity: {
      schemaVersion: 1,
      continuityId: `${ownerId}::${slotId}::${asset.assetKey}::draft-${overallPick}`,
      ownerId,
      rosterSlotId: slotId,
      assetKey: asset.assetKey,
      priorAssignedGameIds: [],
      lastScheduleTeamAbbreviation: 'SEA',
    },
    asset,
  };
  const completedSummary = {
    assetKey: asset.assetKey,
    ownerId,
    rosterSlotId: slotId,
    windowId: cycleWindowId,
    sourceNhlBlockNumber: 1,
    currentScore: 12,
    gamesPlayed: 6,
    actualGamesPlayed: 6,
    scheduledGames: 6,
    gamesLeft: 0,
    scheduledGameIds: [1, 2, 3, 4, 5, 6],
    scheduledGameDates: [],
    scheduledGameLabels: [],
    scheduleTeamAbbreviation: 'SEA',
    completedGameIds: [1, 2, 3, 4, 5, 6],
    liveGameIds: [],
    appearanceGameIds: [1, 2, 3, 4, 5, 6],
    gameScores: {},
    gameStates: {},
    gameInputCompleteness: {},
    incompleteFinalGameIds: [],
    firstScheduledGameDate: '2026-10-01',
    lastScheduledGameDate: '2026-10-11',
    status: 'complete',
  };

  return {
    currentPick,
    scoring: {
      scoringSchemaVersion: 2,
      assetScores: { [asset.assetKey]: completedSummary },
      windowScores: { [cycleWindowId]: completedSummary },
      teamScores: { [ownerId]: 12 },
      teamGameCounts: { [ownerId]: 6 },
      teamCycleComplete: { [ownerId]: false },
      cycleHasScheduledGames: true,
      hasLiveGames: false,
      hasIncompleteFinalGames: false,
      nextScheduledGameStart: null,
      refreshedAt: '2026-10-12T00:00:00.000Z',
      dataFingerprint: `future-lineup-${slotId}-fixture`,
    },
    currentCycle: {
      id: 'cycle-1',
      cycleNumber: 1,
      sourceNhlBlockNumber: 1,
      status: 'active',
      phase: 'regular_season',
      matchupIds: ['matchup-1'],
      expectedRosterSlotIdsByOwner: { [ownerId]: [slotId] },
    },
  };
}

before(async () => {
  app = initializeApp({ projectId }, `future-lineups-${randomUUID()}`);
  db = getFirestore(app);
  await resetEmulator();
});

beforeEach(async () => {
  await resetEmulator();
  await seedLeague();
});

after(async () => {
  if (app) {
    await deleteApp(app);
  }
});

test('save/list/clear are private, revisioned, and idempotent', async () => {
  const roster = buildRoster();
  const request = {
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'save-cycle-2-request',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  };
  const first = await call(request);
  const retry = await call(request);

  assert.deepEqual(retry, first);
  assert.equal(first.operation, 'save');
  assert.equal(first.plan.revision, 1);
  assert.equal(first.plan.status, 'planned');
  assert.equal(first.plan.materializedSlotCount, 0);
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get()).exists,
    true,
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
    ).get()).data().receipts.length,
    1,
  );

  const listed = await call({ leagueId, operation: 'list' });
  assert.equal(listed.plans.length, 1);
  assert.equal(listed.plans[0].cycleNumber, 2);

  await assert.rejects(
    call({
      ...request,
      requestId: 'stale-revision-request',
      expectedRevision: 0,
    }),
    (error) =>
      error.code === 'aborted' &&
      error.details?.reason === 'revision-conflict' &&
      error.details?.currentRevision === 1,
  );

  const clearRequest = {
    leagueId,
    operation: 'clear',
    cycleNumber: 2,
    expectedRevision: 1,
    requestId: 'clear-cycle-2-request',
  };
  const cleared = await call(clearRequest);
  assert.deepEqual(await call(clearRequest), cleared);
  assert.equal(cleared.plan, null);
  assert.equal(cleared.revision, 2);
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
    ).get()).data().receipts.length,
    2,
  );
  assert.equal((await call({ leagueId, operation: 'list' })).plans.length, 0);
});

test('bulk save and clear remain unavailable for Matchup 1', async () => {
  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 1,
      expectedRevision: 0,
      requestId: 'bulk-save-matchup-one',
      slots: requestedSlots(buildRoster()),
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cycle-started',
  );
  await assert.rejects(
    call({
      leagueId,
      operation: 'clear',
      cycleNumber: 1,
      expectedRevision: 0,
      requestId: 'bulk-clear-matchup-one',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cycle-started',
  );
});

test('swap saves an unmaterialized selected matchup immediately and replays exactly', async () => {
  const request = {
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'C-1',
    benchSlotId: 'B-1',
    expectedRevision: 0,
    requestId: 'swap-unmaterialized-cycle-two',
    expectedOutgoingAssetKey: 'skater-4',
    expectedIncomingAssetKey: 'skater-100',
  };
  const first = await call(request);
  const replay = await call(request);

  assert.deepEqual(replay, first);
  assert.equal(first.operation, 'swap');
  assert.equal(first.mode, 'immediate');
  assert.equal(first.effectiveCycleNumber, 2);
  assert.equal(first.timingReason, 'selected-matchup-untouched');
  assert.equal(
    first.plan.slots.find((slot) => slot.rosterSlotId === 'C-1').assetKey,
    'skater-100',
  );
  assert.equal(
    first.plan.slots.find((slot) => slot.rosterSlotId === 'C-1').resolution,
    'planned',
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
    ).get()).data().receipts.length,
    1,
  );
});

test('swap promotes a bench player into an untouched empty active slot and replays exactly', async (t) => {
  await seedEmptyActiveSlotPromotion(t);
  const request = {
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'C-1',
    benchSlotId: 'B-1',
    expectedRevision: 0,
    requestId: 'swap-empty-active-slot-cycle-two',
    expectedOutgoingAssetKey: null,
    expectedIncomingAssetKey: 'skater-100',
  };
  const first = await call(request);
  const replay = await call(request);

  assert.deepEqual(replay, first);
  assert.equal(first.mode, 'immediate');
  assert.equal(first.effectiveCycleNumber, 2);
  assert.equal(first.timingReason, 'selected-matchup-untouched');
  assert.equal(
    first.plan.slots.find((slot) => slot.rosterSlotId === 'C-1').assetKey,
    'skater-100',
  );
  assert.equal(
    first.plan.slots.find((slot) => slot.rosterSlotId === 'C-1').resolution,
    'planned',
  );
  const [savedRoster, savedPick, savedPlan, mutationState] = await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
    ).get(),
  ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'C-1').asset,
    null,
  );
  assert.equal(
    savedRoster.data().benchSlots.find((slot) => slot.slotId === 'B-1')
      .asset.assetKey,
    'skater-100',
  );
  assert.equal(savedPick.exists, false);
  assert.equal(
    savedPlan.data().slots.find((slot) => slot.rosterSlotId === 'C-1')
      .resolution,
    'planned',
  );
  assert.equal(mutationState.data().receipts.length, 1);
});

test('empty-slot promotion delays when the incoming frozen block already started', async (t) => {
  await seedEmptyActiveSlotPromotion(t, { incomingStarted: true });
  const selectedRequest = {
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'C-1',
    benchSlotId: 'B-1',
    expectedRevision: 0,
    requestId: 'swap-empty-active-slot-started-selected',
    expectedOutgoingAssetKey: null,
    expectedIncomingAssetKey: 'skater-100',
  };

  await assert.rejects(
    call(selectedRequest),
    (error) =>
      error.code === 'aborted' &&
      error.details?.reason === 'swap-timing-conflict' &&
      error.details?.timingReason === 'incoming-started' &&
      error.details?.effectiveCycleNumber === 3 &&
      error.details?.startedGameIds?.includes(301),
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get()).exists,
    false,
  );

  const queuedRequest = {
    ...selectedRequest,
    expectedEffectiveCycleNumber: 3,
    requestId: 'swap-empty-active-slot-started-queued',
  };
  const queued = await call(queuedRequest);
  const replay = await call(queuedRequest);

  assert.deepEqual(replay, queued);
  assert.equal(queued.mode, 'queued');
  assert.equal(queued.timingReason, 'incoming-started');
  assert.equal(queued.effectiveCycleNumber, 3);
  assert.equal(
    queued.plan.slots.find((slot) => slot.rosterSlotId === 'C-1').assetKey,
    'skater-100',
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get()).exists,
    false,
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-3`,
    ).get()).exists,
    true,
  );
});

test('empty-slot promotion fails closed on incomplete incoming frozen evidence', async (t) => {
  await seedEmptyActiveSlotPromotion(t, {
    incomingGameIds: [301, 302, 303, 304, 305],
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'C-1',
      benchSlotId: 'B-1',
      expectedRevision: 0,
      requestId: 'swap-empty-active-slot-incomplete-frozen-block',
      expectedOutgoingAssetKey: null,
      expectedIncomingAssetKey: 'skater-100',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'incomplete-frozen-game-evidence' &&
      error.details?.assignment === 'incoming',
  );
  const [savedPlan, mutationState] = await Promise.all([
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
    ).get(),
  ]);
  assert.equal(savedPlan.exists, false);
  assert.equal(mutationState.exists, false);
});

test('empty-slot promotion transaction rejects changed frozen game authority', async (t) => {
  await seedEmptyActiveSlotPromotion(t);
  const request = {
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'C-1',
    benchSlotId: 'B-1',
    expectedRevision: 0,
    requestId: 'swap-empty-active-slot-frozen-race',
    expectedOutgoingAssetKey: null,
    expectedIncomingAssetKey: 'skater-100',
  };

  await assert.rejects(
    interceptNextFutureLineupTransaction(
      () => db.doc(`leagues/${leagueId}/cycles/cycle-2`).update({
        'sourceNhlTargetGameIdsByTeam.SEA': [401, 402, 403, 404, 405, 406],
      }),
      () => call(request),
    ),
    (error) =>
      error.code === 'aborted' &&
      error.details?.reason === 'swap-timing-conflict',
  );
  const [savedPlan, mutationState] = await Promise.all([
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
    ).get(),
  ]);
  assert.equal(savedPlan.exists, false);
  assert.equal(mutationState.exists, false);
});

test('nullable outgoing authority fails closed unless the exact active slot is empty', async () => {
  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'C-1',
      benchSlotId: 'B-1',
      expectedRevision: 0,
      requestId: 'swap-null-outgoing-occupied-target',
      expectedOutgoingAssetKey: null,
      expectedIncomingAssetKey: 'skater-100',
    }),
    (error) =>
      error.code === 'aborted' &&
      error.details?.reason === 'roster-revision-conflict',
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get()).exists,
    false,
  );
});

test('nullable outgoing authority rejects a stale empty-slot view after a plan fills it', async (t) => {
  const roster = await seedEmptyActiveSlotPromotion(t);
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'fill-empty-slot-before-stale-promotion',
    slots: requestedSlots(roster, { 'C-1': 'skater-101' }),
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'C-1',
      benchSlotId: 'B-1',
      expectedRevision: 1,
      requestId: 'stale-null-outgoing-after-plan-fill',
      expectedOutgoingAssetKey: null,
      expectedIncomingAssetKey: 'skater-100',
    }),
    (error) =>
      error.code === 'aborted' &&
      error.details?.reason === 'roster-revision-conflict',
  );
  const savedPlan = (await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
  ).get()).data();
  assert.equal(savedPlan.revision, 1);
  assert.equal(
    savedPlan.slots.find((slot) => slot.rosterSlotId === 'C-1').assetKey,
    'skater-101',
  );
});

test('swap replaces an existing unmaterialized planned starter and replays exactly', async () => {
  const first = await call({
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'C-1',
    benchSlotId: 'B-1',
    expectedRevision: 0,
    requestId: 'swap-plan-a-to-b',
    expectedOutgoingAssetKey: 'skater-4',
    expectedIncomingAssetKey: 'skater-100',
  });
  assert.equal(first.plan.revision, 1);

  const replacementRequest = {
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'C-1',
    benchSlotId: 'B-2',
    expectedRevision: 1,
    requestId: 'swap-plan-b-to-c',
    expectedOutgoingAssetKey: 'skater-100',
    expectedIncomingAssetKey: 'skater-101',
  };
  const replacement = await call(replacementRequest);
  const replay = await call(replacementRequest);

  assert.deepEqual(replay, replacement);
  assert.equal(replacement.mode, 'immediate');
  assert.equal(replacement.plan.revision, 2);
  assert.equal(
    replacement.plan.slots.find((slot) => slot.rosterSlotId === 'C-1').assetKey,
    'skater-101',
  );
  const [savedRoster, mutationState] = await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
    ).get(),
  ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'C-1').asset.assetKey,
    'skater-4',
  );
  assert.equal(
    savedRoster.data().benchSlots.find((slot) => slot.slotId === 'B-1').asset.assetKey,
    'skater-100',
  );
  assert.equal(
    savedRoster.data().benchSlots.find((slot) => slot.slotId === 'B-2').asset.assetKey,
    'skater-101',
  );
  assert.equal(mutationState.data().receipts.length, 2);
});

test('swap can reverse an unmaterialized plan without moving physical roster ownership', async () => {
  const first = await call({
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'C-1',
    benchSlotId: 'B-1',
    expectedRevision: 0,
    requestId: 'swap-plan-before-reversal',
    expectedOutgoingAssetKey: 'skater-4',
    expectedIncomingAssetKey: 'skater-100',
  });
  assert.equal(first.plan.revision, 1);

  const reversalRequest = {
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'C-1',
    // The submitted physical bench slot still holds planned starter B while
    // conceptual bench player A remains physically active until materialization.
    benchSlotId: 'B-1',
    expectedRevision: 1,
    requestId: 'swap-plan-b-back-to-a',
    expectedOutgoingAssetKey: 'skater-100',
    expectedIncomingAssetKey: 'skater-4',
  };
  const reversal = await call(reversalRequest);
  const replay = await call(reversalRequest);

  assert.deepEqual(replay, reversal);
  assert.equal(reversal.mode, 'immediate');
  assert.equal(reversal.plan.revision, 2);
  assert.equal(
    reversal.plan.slots.find((slot) => slot.rosterSlotId === 'C-1').assetKey,
    'skater-4',
  );
  const savedRoster = await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  ).get();
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'C-1').asset.assetKey,
    'skater-4',
  );
  assert.equal(
    savedRoster.data().benchSlots.find((slot) => slot.slotId === 'B-1').asset.assetKey,
    'skater-100',
  );
});

test('swap rejects a no-op planned player selection', async () => {
  await call({
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'C-1',
    benchSlotId: 'B-1',
    expectedRevision: 0,
    requestId: 'swap-plan-before-no-op',
    expectedOutgoingAssetKey: 'skater-4',
    expectedIncomingAssetKey: 'skater-100',
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'C-1',
      benchSlotId: 'B-1',
      expectedRevision: 1,
      requestId: 'swap-plan-no-op',
      expectedOutgoingAssetKey: 'skater-100',
      expectedIncomingAssetKey: 'skater-100',
    }),
    (error) =>
      error.code === 'invalid-argument' &&
      error.details?.reason === 'same-asset-swap',
  );
});

test('swap queues the next fair matchup when the outgoing assignment started', async () => {
  const roster = buildRoster();
  const outgoing = roster.activeSlots.find((slot) => slot.slotId === 'C-1').asset;
  await Promise.all([
    db.doc(`leagues/${leagueId}/cycles/cycle-2`).set({
      id: 'cycle-2',
      cycleNumber: 2,
      phase: 'regular_season',
      status: 'active',
    }),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).set({
      ownerId,
      rosterSlotId: 'C-1',
      asset: outgoing,
    }),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/teamWindows/${ownerId}`,
    ).set({
      id: ownerId,
      ownerId,
      cycleNumber: 2,
      expectedRosterSlotIds: ['C-1'],
      windows: [{
        id: `${ownerId}__C-1__cycle-2`,
        ownerId,
        rosterSlotId: 'C-1',
        cycleNumber: 2,
        position: 'C',
        assetKey: 'skater-4',
        asset: outgoing,
        status: 'active',
        scheduledGameIds: [1, 2, 3, 4, 5, 6],
        completedGameIds: [1],
        liveGameIds: [],
        appearanceGameIds: [1],
        incompleteFinalGameIds: [],
        gameStates: { 1: 'final' },
        gamesPlayed: 1,
        actualGamesPlayed: 1,
        fantasyPoints: 4.2,
        startedAt: '2026-10-12T18:00:00.000Z',
        completedAt: null,
      }],
    }),
  ]);

  const result = await call({
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 3,
    activeSlotId: 'C-1',
    benchSlotId: 'B-1',
    expectedRevision: 0,
    requestId: 'swap-after-outgoing-started',
    expectedOutgoingAssetKey: 'skater-4',
    expectedIncomingAssetKey: 'skater-100',
  });

  assert.equal(result.mode, 'queued');
  assert.equal(result.timingReason, 'outgoing-started');
  assert.equal(result.effectiveCycleNumber, 3);
  assert.equal(result.plan.cycleNumber, 3);
  assert.equal(
    result.plan.slots.find((slot) => slot.rosterSlotId === 'C-1').assetKey,
    'skater-100',
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/roster/current`,
    ).get()).data().activeSlots.find((slot) => slot.slotId === 'C-1').asset.assetKey,
    'skater-4',
  );
});

test('swap preserves an overlapping selected assignment when the physical roster already advanced', async () => {
  const roster = buildRoster();
  const selectedOutgoing = roster.activeSlots.find(
    (slot) => slot.slotId === 'C-1',
  ).asset;
  roster.activeSlots.find((slot) => slot.slotId === 'C-1').asset = skater(105, 'C');
  await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).set(roster),
    db.doc(`leagues/${leagueId}/cycles/cycle-2`).set({
      id: 'cycle-2',
      cycleNumber: 2,
      phase: 'regular_season',
      status: 'active',
    }),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).set({
      ownerId,
      rosterSlotId: 'C-1',
      asset: selectedOutgoing,
    }),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/teamWindows/${ownerId}`,
    ).set({
      id: ownerId,
      ownerId,
      cycleNumber: 2,
      expectedRosterSlotIds: ['C-1'],
      windows: [{
        id: `${ownerId}__C-1__cycle-2`,
        ownerId,
        rosterSlotId: 'C-1',
        cycleNumber: 2,
        position: 'C',
        assetKey: 'skater-4',
        asset: selectedOutgoing,
        status: 'active',
        scheduledGameIds: [1, 2, 3, 4, 5, 6],
        completedGameIds: [1],
        liveGameIds: [],
        appearanceGameIds: [1],
        incompleteFinalGameIds: [],
        gameStates: { 1: 'final' },
        gamesPlayed: 1,
        actualGamesPlayed: 1,
        fantasyPoints: 4.2,
        startedAt: '2026-10-12T18:00:00.000Z',
        completedAt: null,
      }],
    }),
  ]);

  const result = await call({
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 3,
    activeSlotId: 'C-1',
    benchSlotId: 'B-1',
    expectedRevision: 0,
    requestId: 'swap-overlapping-selected-assignment',
    expectedOutgoingAssetKey: 'skater-4',
    expectedIncomingAssetKey: 'skater-100',
  });

  assert.equal(result.mode, 'queued');
  assert.equal(result.timingReason, 'outgoing-started');
  assert.equal(result.effectiveCycleNumber, 3);
  assert.equal(
    result.plan.slots.find((slot) => slot.rosterSlotId === 'C-1').assetKey,
    'skater-100',
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/roster/current`,
    ).get()).data().activeSlots.find((slot) => slot.slotId === 'C-1').asset.assetKey,
    'skater-105',
  );
});

test('swap atomically rewrites a materialized matchup only while both assignments are untouched', async (t) => {
  await seedMaterializedGoalieSwap(t);

  const request = {
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'G-1',
    benchSlotId: 'B-5',
    expectedRevision: 0,
    requestId: 'swap-materialized-untouched-goalies',
    expectedOutgoingAssetKey: 'goalie-unit-SEA',
    expectedIncomingAssetKey: 'goalie-unit-VAN',
  };
  const result = await call(request);
  const replay = await call(request);
  assert.deepEqual(replay, result);
  assert.equal(result.mode, 'immediate');
  assert.equal(
    result.plan.slots.find((slot) => slot.rosterSlotId === 'G-1').resolution,
    'applied',
  );

  const [savedRoster, savedPick, savedWindows, audit] = await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__G-1`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/teamWindows/${ownerId}`,
    ).get(),
    db.collection(`leagues/${leagueId}/transactions`).get(),
  ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'G-1').asset.assetKey,
    'goalie-unit-VAN',
  );
  assert.equal(
    savedRoster.data().benchSlots.find((slot) => slot.slotId === 'B-5').asset.assetKey,
    'goalie-unit-SEA',
  );
  assert.equal(savedPick.data().asset.assetKey, 'goalie-unit-VAN');
  assert.deepEqual(savedPick.data().sourceNhlTargetGameIds, [201, 202, 203, 204, 205, 206]);
  const savedWindow = savedWindows.data().windows.find(
    (window) => window.rosterSlotId === 'G-1',
  );
  assert.equal(savedWindow.assetKey, 'goalie-unit-VAN');
  assert.equal(savedWindow.status, 'scheduled');
  assert.deepEqual(savedWindow.scheduledGameIds, []);
  assert.equal(
    audit.docs.filter((document) =>
      Boolean(document.data().futureMatchupLineupRequestIdHash),
    ).length,
    1,
  );
});

test('swap atomically rewrites a materialized untouched Matchup 1', async (t) => {
  await seedMaterializedGoalieSwap(t, { cycleNumber: 1 });

  const request = {
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 1,
    expectedEffectiveCycleNumber: 1,
    activeSlotId: 'G-1',
    benchSlotId: 'B-5',
    expectedRevision: 0,
    requestId: 'swap-materialized-untouched-matchup-one',
    expectedOutgoingAssetKey: 'goalie-unit-SEA',
    expectedIncomingAssetKey: 'goalie-unit-VAN',
  };
  const result = await call(request);
  const replay = await call(request);

  assert.deepEqual(replay, result);
  assert.equal(result.mode, 'immediate');
  assert.equal(result.effectiveCycleNumber, 1);
  assert.equal(result.timingReason, 'selected-matchup-untouched');
  assert.equal(
    result.plan.slots.find((slot) => slot.rosterSlotId === 'G-1').resolution,
    'applied',
  );

  const [savedRoster, savedPick, savedWindows, mutationState, audit] = await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-1/rosterPicks/${ownerId}__G-1`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-1/teamWindows/${ownerId}`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-1`,
    ).get(),
    db.collection(`leagues/${leagueId}/transactions`).get(),
  ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'G-1')
      .asset.assetKey,
    'goalie-unit-VAN',
  );
  assert.equal(
    savedRoster.data().benchSlots.find((slot) => slot.slotId === 'B-5')
      .asset.assetKey,
    'goalie-unit-SEA',
  );
  assert.equal(savedPick.data().asset.assetKey, 'goalie-unit-VAN');
  assert.equal(
    savedWindows.data().windows.find((window) => window.rosterSlotId === 'G-1')
      .assetKey,
    'goalie-unit-VAN',
  );
  assert.equal(mutationState.data().receipts.length, 1);
  assert.equal(
    audit.docs.filter((document) =>
      Boolean(document.data().futureMatchupLineupRequestIdHash),
    ).length,
    1,
  );

  await assert.rejects(
    call({
      leagueId,
      operation: 'clear',
      cycleNumber: 1,
      expectedRevision: result.plan.revision,
      requestId: 'clear-applied-matchup-one-plan',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cycle-started',
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-1`,
    ).get()).exists,
    true,
  );
});

test('a Matchup 1 applied plan stays within the bounded full-season plan set', async (t) => {
  await seedMaterializedGoalieSwap(t, { cycleNumber: 1 });
  await call({
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 1,
    expectedEffectiveCycleNumber: 1,
    activeSlotId: 'G-1',
    benchSlotId: 'B-5',
    expectedRevision: 0,
    requestId: 'swap-matchup-one-before-plan-cap-check',
    expectedOutgoingAssetKey: 'goalie-unit-SEA',
    expectedIncomingAssetKey: 'goalie-unit-VAN',
  });
  const matchupOnePlan = (await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-1`,
  ).get()).data();
  const batch = db.batch();
  for (let cycleNumber = 2; cycleNumber <= 12; cycleNumber += 1) {
    batch.set(
      db.doc(
        `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-${cycleNumber}`,
      ),
      { ...matchupOnePlan, cycleNumber },
    );
  }
  await batch.commit();

  const listed = await call({ leagueId, operation: 'list' });
  assert.equal(listed.plans.length, 12);
  assert.deepEqual(
    listed.plans.map((plan) => plan.cycleNumber),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
});

test('swap keeps a started Matchup 1 assignment and queues Matchup 2', async (t) => {
  await seedMaterializedGoalieSwap(t, { cycleNumber: 1 });
  const windowsRef = db.doc(
    `leagues/${leagueId}/cycles/cycle-1/teamWindows/${ownerId}`,
  );
  const windowsSnapshot = await windowsRef.get();
  await windowsRef.update({
    status: 'active',
    windows: windowsSnapshot.data().windows.map((window) =>
      window.rosterSlotId === 'G-1'
        ? {
            ...window,
            status: 'active',
            completedGameIds: [101],
            appearanceGameIds: [101],
            gameStates: { 101: 'final' },
            gamesPlayed: 1,
            actualGamesPlayed: 1,
            fantasyPoints: 4.2,
            startedAt: '2026-10-11T20:00:00.000Z',
          }
        : window,
    ),
  });

  const result = await call({
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 1,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'G-1',
    benchSlotId: 'B-5',
    expectedRevision: 0,
    requestId: 'swap-started-matchup-one-queues-two',
    expectedOutgoingAssetKey: 'goalie-unit-SEA',
    expectedIncomingAssetKey: 'goalie-unit-VAN',
  });

  assert.equal(result.mode, 'queued');
  assert.equal(result.effectiveCycleNumber, 2);
  assert.equal(result.timingReason, 'outgoing-started');
  assert.equal(
    result.plan.slots.find((slot) => slot.rosterSlotId === 'G-1').assetKey,
    'goalie-unit-VAN',
  );
  const [
    savedRoster,
    savedPick,
    savedWindows,
    matchupOnePlan,
    matchupTwoPlan,
  ] = await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-1/rosterPicks/${ownerId}__G-1`,
    ).get(),
    windowsRef.get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-1`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get(),
  ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'G-1')
      .asset.assetKey,
    'goalie-unit-SEA',
  );
  assert.equal(savedPick.data().asset.assetKey, 'goalie-unit-SEA');
  const savedStartedWindow = savedWindows.data().windows.find(
    (window) => window.rosterSlotId === 'G-1',
  );
  assert.deepEqual(savedStartedWindow.completedGameIds, [101]);
  assert.equal(savedStartedWindow.fantasyPoints, 4.2);
  assert.equal(matchupOnePlan.exists, false);
  assert.equal(matchupTwoPlan.exists, true);
});

test('Matchup 1 swap fails closed until the matchup authority exists', async () => {
  await db.doc(`leagues/${leagueId}/cycles/cycle-1`).delete();

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 1,
      expectedEffectiveCycleNumber: 1,
      activeSlotId: 'C-1',
      benchSlotId: 'B-1',
      expectedRevision: 0,
      requestId: 'swap-unmaterialized-matchup-one',
      expectedOutgoingAssetKey: 'skater-4',
      expectedIncomingAssetKey: 'skater-100',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cycle-state-invalid' &&
      error.details?.cycleNumber === 1,
  );

  const [savedPlan, mutationState] = await Promise.all([
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-1`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-1`,
    ).get(),
  ]);
  assert.equal(savedPlan.exists, false);
  assert.equal(mutationState.exists, false);
});

test('materialized swap fails closed when expected roster-slot evidence is missing', async (t) => {
  await seedMaterializedGoalieSwap(t, {
    omitExpectedRosterSlotIds: true,
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'G-1',
      benchSlotId: 'B-5',
      expectedRevision: 0,
      requestId: 'swap-materialized-missing-expected-slots',
      expectedOutgoingAssetKey: 'goalie-unit-SEA',
      expectedIncomingAssetKey: 'goalie-unit-VAN',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'team-window-state-invalid',
  );
  await assertMaterializedGoalieSwapUnchanged();
});

test('materialized swap fails closed when cycle and team expected slots disagree', async (t) => {
  await seedMaterializedGoalieSwap(t, {
    cycleExpectedRosterSlotIds: ['G-1', 'C-1'],
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'G-1',
      benchSlotId: 'B-5',
      expectedRevision: 0,
      requestId: 'swap-materialized-cycle-team-slot-mismatch',
      expectedOutgoingAssetKey: 'goalie-unit-SEA',
      expectedIncomingAssetKey: 'goalie-unit-VAN',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'team-window-state-invalid',
  );
  await assertMaterializedGoalieSwapUnchanged();
});

test('materialized swap fails closed when team-window owner identity disagrees', async (t) => {
  await seedMaterializedGoalieSwap(t, {
    teamWindowsOwnerId: opponentId,
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'G-1',
      benchSlotId: 'B-5',
      expectedRevision: 0,
      requestId: 'swap-materialized-team-window-owner-mismatch',
      expectedOutgoingAssetKey: 'goalie-unit-SEA',
      expectedIncomingAssetKey: 'goalie-unit-VAN',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'team-window-state-invalid',
  );
  await assertMaterializedGoalieSwapUnchanged();
});

test('materialized swap fails closed when team-window cycle identity disagrees', async (t) => {
  await seedMaterializedGoalieSwap(t, {
    teamWindowsCycleNumber: 3,
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'G-1',
      benchSlotId: 'B-5',
      expectedRevision: 0,
      requestId: 'swap-materialized-team-window-cycle-mismatch',
      expectedOutgoingAssetKey: 'goalie-unit-SEA',
      expectedIncomingAssetKey: 'goalie-unit-VAN',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'team-window-state-invalid',
  );
  await assertMaterializedGoalieSwapUnchanged();
});

test('materialized swap fails closed on duplicate expected roster-slot evidence', async (t) => {
  await seedMaterializedGoalieSwap(t, {
    expectedRosterSlotIds: ['G-1', 'G-1'],
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'G-1',
      benchSlotId: 'B-5',
      expectedRevision: 0,
      requestId: 'swap-materialized-duplicate-expected-slots',
      expectedOutgoingAssetKey: 'goalie-unit-SEA',
      expectedIncomingAssetKey: 'goalie-unit-VAN',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'team-window-state-invalid',
  );
  await assertMaterializedGoalieSwapUnchanged();
});

test('materialized swap fails closed on duplicate sibling window slot evidence', async (t) => {
  const duplicateSiblingWindow = {
    ownerId,
    rosterSlotId: 'C-1',
    cycleNumber: 2,
    status: 'scheduled',
  };
  await seedMaterializedGoalieSwap(t, {
    expectedRosterSlotIds: ['G-1', 'C-1'],
    cycleExpectedRosterSlotIds: ['G-1', 'C-1'],
    additionalWindows: [
      duplicateSiblingWindow,
      { ...duplicateSiblingWindow },
    ],
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'G-1',
      benchSlotId: 'B-5',
      expectedRevision: 0,
      requestId: 'swap-materialized-duplicate-sibling-window',
      expectedOutgoingAssetKey: 'goalie-unit-SEA',
      expectedIncomingAssetKey: 'goalie-unit-VAN',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'team-window-state-invalid',
  );
  await assertMaterializedGoalieSwapUnchanged();
});

test('materialized swap fails closed on divergent pick injury ownership', async (t) => {
  await seedMaterializedGoalieSwap(t, {
    pickInjuryReplacementWindow: {
      schemaVersion: 1,
      ownerId,
      rosterSlotId: 'G-1',
      cycleNumber: 2,
      segments: [],
    },
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'G-1',
      benchSlotId: 'B-5',
      expectedRevision: 0,
      requestId: 'swap-materialized-divergent-pick-injury-window',
      expectedOutgoingAssetKey: 'goalie-unit-SEA',
      expectedIncomingAssetKey: 'goalie-unit-VAN',
    }),
    (error) =>
      error.code === 'aborted' &&
      error.details?.reason === 'swap-timing-conflict',
  );
  await assertMaterializedGoalieSwapUnchanged();
});

test('materialized swap rejects a missing incoming frozen game before any write', async (t) => {
  await seedMaterializedGoalieSwap(t, {
    incomingGameIds: [201, 202, 203, 204, 205],
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'G-1',
      benchSlotId: 'B-5',
      expectedRevision: 0,
      requestId: 'swap-materialized-missing-incoming-game',
      expectedOutgoingAssetKey: 'goalie-unit-SEA',
      expectedIncomingAssetKey: 'goalie-unit-VAN',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'incomplete-frozen-game-evidence' &&
      error.details?.assignment === 'incoming',
  );

  const [savedRoster, savedPick, savedWindows, savedPlan, mutationState, audit] =
    await Promise.all([
      db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
      db.doc(`leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__G-1`).get(),
      db.doc(`leagues/${leagueId}/cycles/cycle-2/teamWindows/${ownerId}`).get(),
      db.doc(`leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`).get(),
      db.doc(
        `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
      ).get(),
      db.collection(`leagues/${leagueId}/transactions`).get(),
    ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'G-1').asset.assetKey,
    'goalie-unit-SEA',
  );
  assert.equal(savedPick.data().asset.assetKey, 'goalie-unit-SEA');
  assert.equal(
    savedWindows.data().windows.find((window) => window.rosterSlotId === 'G-1').assetKey,
    'goalie-unit-SEA',
  );
  assert.equal(savedPlan.exists, false);
  assert.equal(mutationState.exists, false);
  assert.equal(audit.empty, true);
});

test('materialized swap rejects duplicate outgoing frozen games before any write', async (t) => {
  await seedMaterializedGoalieSwap(t, {
    outgoingGameIds: [101, 102, 103, 104, 105, 105],
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'swap',
      requestedCycleNumber: 2,
      expectedEffectiveCycleNumber: 2,
      activeSlotId: 'G-1',
      benchSlotId: 'B-5',
      expectedRevision: 0,
      requestId: 'swap-materialized-duplicate-outgoing-game',
      expectedOutgoingAssetKey: 'goalie-unit-SEA',
      expectedIncomingAssetKey: 'goalie-unit-VAN',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'incomplete-frozen-game-evidence' &&
      error.details?.assignment === 'outgoing',
  );

  const [savedRoster, savedPick, savedWindows, savedPlan, mutationState, audit] =
    await Promise.all([
      db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
      db.doc(`leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__G-1`).get(),
      db.doc(`leagues/${leagueId}/cycles/cycle-2/teamWindows/${ownerId}`).get(),
      db.doc(`leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`).get(),
      db.doc(
        `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
      ).get(),
      db.collection(`leagues/${leagueId}/transactions`).get(),
    ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'G-1').asset.assetKey,
    'goalie-unit-SEA',
  );
  assert.equal(savedPick.data().asset.assetKey, 'goalie-unit-SEA');
  assert.equal(
    savedWindows.data().windows.find((window) => window.rosterSlotId === 'G-1').assetKey,
    'goalie-unit-SEA',
  );
  assert.equal(savedPlan.exists, false);
  assert.equal(mutationState.exists, false);
  assert.equal(audit.empty, true);
});

test('fresh NHL puck-drop evidence never rewrites a stale scheduled window', async (t) => {
  await seedMaterializedGoalieSwap(t, { outgoingStarted: true });
  const request = {
    leagueId,
    operation: 'swap',
    requestedCycleNumber: 2,
    expectedEffectiveCycleNumber: 2,
    activeSlotId: 'G-1',
    benchSlotId: 'B-5',
    expectedRevision: 0,
    requestId: 'swap-provider-started-goalie',
    expectedOutgoingAssetKey: 'goalie-unit-SEA',
    expectedIncomingAssetKey: 'goalie-unit-VAN',
  };

  await assert.rejects(
    call(request),
    (error) =>
      error.code === 'aborted' &&
      error.details?.reason === 'swap-timing-conflict' &&
      error.details?.timingReason === 'outgoing-started' &&
      error.details?.effectiveCycleNumber === 3 &&
      error.details?.startedGameIds?.includes(101),
  );

  const [savedRoster, savedPick, savedWindows, savedPlan] = await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
    db.doc(`leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__G-1`).get(),
    db.doc(`leagues/${leagueId}/cycles/cycle-2/teamWindows/${ownerId}`).get(),
    db.doc(`leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`).get(),
  ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'G-1').asset.assetKey,
    'goalie-unit-SEA',
  );
  assert.equal(savedPick.data().asset.assetKey, 'goalie-unit-SEA');
  assert.equal(
    savedWindows.data().windows.find((window) => window.rosterSlotId === 'G-1').assetKey,
    'goalie-unit-SEA',
  );
  assert.equal(savedPlan.exists, false);
});

test('cycle revisions remain monotonic across clear and recreate ABA sequences', async () => {
  const roster = buildRoster();
  const first = await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'aba-save-one',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  });
  assert.equal(first.plan.revision, 1);

  const cleared = await call({
    leagueId,
    operation: 'clear',
    cycleNumber: 2,
    expectedRevision: 1,
    requestId: 'aba-clear-two',
  });
  assert.equal(cleared.revision, 2);

  const recreated = await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'aba-save-three',
    slots: requestedSlots(roster, { 'C-1': 'skater-101' }),
  });
  assert.equal(recreated.plan.revision, 3);

  for (const staleRequest of [
    {
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 1,
      requestId: 'aba-stale-save',
      slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
    },
    {
      leagueId,
      operation: 'clear',
      cycleNumber: 2,
      expectedRevision: 1,
      requestId: 'aba-stale-clear',
    },
  ]) {
    await assert.rejects(
      call(staleRequest),
      (error) =>
        error.code === 'aborted' &&
        error.details?.reason === 'revision-conflict' &&
        error.details?.currentRevision === 3,
    );
  }

  const mutationState = (await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
  ).get()).data();
  assert.equal(mutationState.latestRevision, 3);
  assert.equal(mutationState.receipts.length, 3);
});

test('save rejects reused request IDs and cross-cycle cross-slot reservations', async () => {
  const roster = buildRoster();
  const cycleTwo = {
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'cycle-two-reservation',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  };
  await call(cycleTwo);

  await assert.rejects(
    call({
      ...cycleTwo,
      slots: requestedSlots(roster, { 'C-1': 'skater-101' }),
    }),
    (error) =>
      error.code === 'already-exists' &&
      error.details?.reason === 'request-id-reused',
  );

  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 3,
      expectedRevision: 0,
      requestId: 'cycle-three-cross-slot',
      slots: requestedSlots(roster, { 'C-2': 'skater-100' }),
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cross-cycle-asset-conflict',
  );

  const cycleTwoPlanRef = db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
  );
  const resolvedCycleTwoPlan = (await cycleTwoPlanRef.get()).data();
  resolvedCycleTwoPlan.slots = resolvedCycleTwoPlan.slots.map((slot) =>
    slot.rosterSlotId === 'C-1'
      ? {
          ...slot,
          resolution: 'applied',
          resolvedAssetKey: 'skater-100',
          resolvedAt: new Date(),
        }
      : slot,
  );
  await cycleTwoPlanRef.set(resolvedCycleTwoPlan);

  const releasedReservation = await call({
    leagueId,
    operation: 'save',
    cycleNumber: 3,
    expectedRevision: 0,
    requestId: 'cycle-three-released-reservation',
    slots: requestedSlots(roster, { 'C-2': 'skater-100' }),
  });
  assert.equal(
    releasedReservation.plan.slots.find((slot) => slot.rosterSlotId === 'C-2')
      .assetKey,
    'skater-100',
  );

  await call({
    leagueId,
    operation: 'clear',
    cycleNumber: 3,
    expectedRevision: 1,
    requestId: 'clear-cycle-three-released-reservation',
  });

  const sameSlot = await call({
    leagueId,
    operation: 'save',
    cycleNumber: 3,
    expectedRevision: 0,
    requestId: 'cycle-three-same-slot',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  });
  assert.equal(sameSlot.plan.revision, 3);
});

test('partial plans preserve locked slots while planned slots remain editable', async () => {
  const roster = buildRoster();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'partial-plan-create',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  });

  const planRef = db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
  );
  const plan = (await planRef.get()).data();
  plan.slots = plan.slots.map((slot) =>
    slot.rosterSlotId === 'C-1'
      ? {
          ...slot,
          resolution: 'conflict',
          resolvedAssetKey: 'skater-4',
          reason: 'desired-asset-unavailable',
          resolvedAt: new Date(),
        }
      : slot,
  );
  await planRef.set(plan);
  await db.doc(
    `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
  ).set({
    ownerId,
    rosterSlotId: 'C-1',
    asset: { assetKey: 'skater-4' },
  });
  const changedRoster = buildRoster();
  changedRoster.benchSlots[0].asset = null;
  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  ).set(changedRoster);

  const updated = await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 1,
    requestId: 'partial-plan-edit',
    slots: requestedSlots(changedRoster, {
      'C-1': 'skater-4',
      'C-2': 'skater-101',
    }),
  });
  const locked = updated.plan.slots.find((slot) => slot.rosterSlotId === 'C-1');
  const edited = updated.plan.slots.find((slot) => slot.rosterSlotId === 'C-2');
  assert.equal(locked.assetKey, 'skater-100');
  assert.equal(locked.resolvedAssetKey, 'skater-4');
  assert.equal(locked.resolution, 'conflict');
  assert.equal(edited.assetKey, 'skater-101');
  assert.equal(edited.resolution, 'planned');

  await assert.rejects(
    call({
      leagueId,
      operation: 'clear',
      cycleNumber: 2,
      expectedRevision: 2,
      requestId: 'partial-plan-clear',
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cycle-started',
  );
});

test('an older overlapping cycle remains editable only for unresolved slots', async () => {
  const roster = buildRoster();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'overlap-cycle-two-create',
    slots: requestedSlots(roster),
  });
  await Promise.all([
    db.doc(`leagues/${leagueId}/cycles/cycle-2`).set({
      id: 'cycle-2',
      cycleNumber: 2,
      phase: 'regular_season',
      status: 'active',
    }),
    db.doc(`leagues/${leagueId}/cycles/cycle-3`).set({
      id: 'cycle-3',
      cycleNumber: 3,
      phase: 'regular_season',
      status: 'active',
    }),
  ]);
  await db.doc(
    `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
  ).set({
    ownerId,
    rosterSlotId: 'C-1',
    asset: skater(4, 'C'),
  });

  const edited = await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 1,
    requestId: 'overlap-cycle-two-edit',
    slots: requestedSlots(roster, { 'C-2': 'skater-100' }),
  });
  assert.equal(
    edited.plan.slots.find((slot) => slot.rosterSlotId === 'C-1').resolution,
    'unchanged',
  );
  assert.equal(
    edited.plan.slots.find((slot) => slot.rosterSlotId === 'C-2').assetKey,
    'skater-100',
  );

  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 2,
      requestId: 'overlap-locked-slot-change',
      slots: requestedSlots(roster, {
        'C-1': 'skater-101',
        'C-2': 'skater-100',
      }),
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cycle-started' &&
      error.details?.lockedSlotIds?.includes('C-1'),
  );
});

test('save rejects a stale missing cycle without creating plan or mutation state', async () => {
  const roster = buildRoster();
  await db.doc(`leagues/${leagueId}/cycles/cycle-3`).set({
    id: 'cycle-3',
    cycleNumber: 3,
    phase: 'regular_season',
    status: 'active',
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 0,
      requestId: 'stale-missing-cycle-plan',
      slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cycle-started',
  );

  const [plan, mutationState] = await Promise.all([
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
    ).get(),
  ]);
  assert.equal(plan.exists, false);
  assert.equal(mutationState.exists, false);
});

test('save allows an absent cycle strictly after valid latest regular-season authority', async () => {
  const roster = buildRoster();
  await db.doc(`leagues/${leagueId}/cycles/cycle-2`).set({
    id: 'cycle-2',
    cycleNumber: 2,
    phase: 'regular_season',
    status: 'active',
  });

  const saved = await call({
    leagueId,
    operation: 'save',
    cycleNumber: 3,
    expectedRevision: 0,
    requestId: 'genuine-future-cycle-plan',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  });

  assert.equal(saved.plan.cycleNumber, 3);
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-3`,
    ).get()).exists,
    true,
  );
});

test('save fails closed when a completed draft has no valid latest cycle authority', async () => {
  const roster = buildRoster();
  await db.doc(`leagues/${leagueId}/cycles/cycle-1`).delete();

  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 0,
      requestId: 'missing-latest-cycle-authority',
      slots: requestedSlots(roster),
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cycle-state-invalid',
  );

  await db.doc(`leagues/${leagueId}/cycles/not-cycle-1`).set({
    cycleNumber: 1,
    phase: 'regular_season',
    status: 'active',
  });
  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 0,
      requestId: 'malformed-latest-cycle-authority',
      slots: requestedSlots(roster),
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cycle-state-invalid',
  );

  await Promise.all([
    db.doc(`leagues/${leagueId}/cycles/not-cycle-1`).delete(),
    db.doc(`leagues/${leagueId}/cycles/cycle-1`).set({
      id: 'cycle-1',
      cycleNumber: 1,
      phase: 'regular_season',
      status: 'pending',
    }),
  ]);
  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 0,
      requestId: 'invalid-latest-cycle-status',
      slots: requestedSlots(roster),
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cycle-state-invalid',
  );
});

test('save rejects an already-open target after its predecessor can no longer consume plans', async () => {
  const roster = buildRoster();
  await Promise.all([
    db.doc(`leagues/${leagueId}/cycles/cycle-1`).update({ status: 'complete' }),
    db.doc(`leagues/${leagueId}/cycles/cycle-2`).set({
      id: 'cycle-2',
      cycleNumber: 2,
      phase: 'regular_season',
      status: 'active',
    }),
  ]);

  const request = {
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'already-open-without-consumer',
    slots: requestedSlots(roster),
  };
  await assert.rejects(
    call(request),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'cycle-started',
  );

  await db.doc(`leagues/${leagueId}/cycles/cycle-1`).update({ status: 'active' });
  const saved = await call({
    ...request,
    requestId: 'open-overlap-still-has-consumer',
  });
  assert.equal(saved.plan.cycleNumber, 2);
});

test('pending moves, replay, and playoff targets fail closed', async () => {
  const roster = buildRoster();
  roster.activeSlots[0].pendingMove = {
    id: 'pending-lineup-change',
    incomingAsset: skater(102, 'LW', 'benched'),
  };
  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  ).set(roster);

  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 0,
      requestId: 'pending-plan-request',
      slots: requestedSlots(roster),
    }),
    (error) => error.details?.reason === 'pending-roster-move',
  );

  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  ).set(buildRoster());
  await db.doc(`leagues/${leagueId}/historicalReplay/control`).set({ enabled: true });
  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 0,
      requestId: 'replay-plan-request',
      slots: requestedSlots(buildRoster()),
    }),
    (error) => error.details?.reason === 'historical-replay-active',
  );

  await db.doc(`leagues/${leagueId}/historicalReplay/control`).set({ enabled: false });
  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 99,
      expectedRevision: 0,
      requestId: 'playoff-plan-request',
      slots: requestedSlots(buildRoster()),
    }),
    (error) => error.details?.reason === 'playoffs-not-supported',
  );
});

test('save enforces bench eligibility against the requested cycle', async () => {
  const roster = buildRoster();
  roster.benchSlots[0].asset.eligibleFromCycleNumber = 3;
  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  ).set(roster);

  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 0,
      requestId: 'ineligible-bench-cycle-two',
      slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
    }),
    (error) =>
      error.code === 'aborted' &&
      error.details?.reason === 'roster-revision-conflict' &&
      /not eligible until Cycle 3/.test(error.details?.message ?? ''),
  );

  const saved = await call({
    leagueId,
    operation: 'save',
    cycleNumber: 3,
    expectedRevision: 0,
    requestId: 'eligible-bench-cycle-three',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  });
  assert.equal(saved.plan.cycleNumber, 3);
});

test('save bounds requested slots before constructing target-pick reads', async () => {
  const roster = buildRoster();
  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 0,
      requestId: 'oversized-slot-request',
      slots: [
        ...requestedSlots(roster),
        { rosterSlotId: 'EXTRA-1', assetKey: null },
      ],
    }),
    (error) =>
      error.code === 'invalid-argument' &&
      /at most 14 active slots/.test(error.message),
  );

  const duplicateSlotAssignment = requestedSlots(roster);
  duplicateSlotAssignment[duplicateSlotAssignment.length - 1] = {
    ...duplicateSlotAssignment[0],
  };
  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 0,
      requestId: 'duplicate-slot-request',
      slots: duplicateSlotAssignment,
    }),
    (error) =>
      error.code === 'invalid-argument' &&
      error.details?.reason === 'invalid-lineup-slots',
  );
});

test('list rejects a persisted plan whose owner evidence crosses teams', async () => {
  const roster = buildRoster();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'owner-evidence-plan',
    slots: requestedSlots(roster),
  });
  const planRef = db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
  );
  await planRef.update({ ownerId: opponentId });

  await assert.rejects(
    call({ leagueId, operation: 'list' }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'plan-state-invalid',
  );
});

test('malformed current and sibling plans fail closed instead of being omitted or overwritten', async () => {
  const roster = buildRoster();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'malformed-current-create',
    slots: requestedSlots(roster),
  });
  const currentPlanRef = db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
  );
  await currentPlanRef.update({ assignmentHash: '0'.repeat(64) });

  for (const request of [
    { leagueId, operation: 'list' },
    {
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 1,
      requestId: 'malformed-current-overwrite',
      slots: requestedSlots(roster),
    },
  ]) {
    await assert.rejects(
      call(request),
      (error) =>
        error.code === 'failed-precondition' &&
        error.details?.reason === 'plan-state-invalid',
    );
  }

  await currentPlanRef.delete();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 3,
    expectedRevision: 0,
    requestId: 'malformed-sibling-create',
    slots: requestedSlots(roster),
  });
  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-3`,
  ).update({ cycleNumber: 2 });

  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 0,
      requestId: 'malformed-sibling-bypass',
      slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'plan-state-invalid',
  );
});

test('an existing target pick must contain valid immutable slot evidence', async () => {
  const roster = buildRoster();
  await db.doc(
    `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
  ).set({
    ownerId,
    rosterSlotId: 'C-1',
    asset: {},
  });

  await assert.rejects(
    call({
      leagueId,
      operation: 'save',
      cycleNumber: 2,
      expectedRevision: 0,
      requestId: 'malformed-target-pick',
      slots: requestedSlots(roster),
    }),
    (error) =>
      error.code === 'failed-precondition' &&
      error.details?.reason === 'target-pick-state-invalid',
  );
});

test('full-cycle opening fails closed on malformed saved plan evidence', async () => {
  const roster = buildRoster();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'malformed-full-cycle-plan',
    slots: requestedSlots(roster),
  });
  await Promise.all([
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).update({ assignmentHash: '0'.repeat(64) }),
    db.doc(`leagues/${leagueId}/cycles/cycle-1`).update({
      status: 'complete',
      sourceNhlBlockNumber: 1,
      playerWindowContinuitySchemaVersion: 1,
    }),
  ]);

  await assert.rejects(
    startNextCycle(leagueId, leagueTeams, 1, {
      projectionRefreshPolicy: 'saved-only',
      consumeFutureLineupPlans: true,
    }),
    /Future lineup plan .* is malformed or has mismatched identity/,
  );
  assert.equal(
    (await db.doc(`leagues/${leagueId}/cycles/cycle-2`).get()).exists,
    false,
  );
});

test('asynchronous rollover fails closed on malformed saved plan evidence', async () => {
  const roster = buildRoster();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'malformed-async-plan',
    slots: requestedSlots(roster),
  });
  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
  ).update({ ownerId: opponentId });
  const fixture = completedWindowFixture('C-1', skater(4, 'C'), 4);

  await assert.rejects(
    advanceCompletedRegularSeasonAssetWindows(
      leagueId,
      leagueTeams,
      fixture.currentCycle,
      [fixture.currentPick],
      fixture.scoring,
      {
        projectionRefreshPolicy: 'saved-only',
        consumeFutureLineupPlans: true,
      },
    ),
    /Future lineup plan .* is malformed or has mismatched identity/,
  );
  assert.equal(
    (await db.doc(`leagues/${leagueId}/cycles/cycle-2`).get()).exists,
    false,
  );
});

test('full-cycle opening aborts instead of committing a pick after its roster preflight changes', async () => {
  const roster = buildRoster();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'full-cycle-race-plan',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  });
  await db.doc(`leagues/${leagueId}/cycles/cycle-1`).update({
    status: 'complete',
    sourceNhlBlockNumber: 1,
    playerWindowContinuitySchemaVersion: 1,
  });

  const concurrentlyChangedRoster = buildRoster();
  concurrentlyChangedRoster.activeSlots.find(
    (slot) => slot.slotId === 'C-1',
  ).asset = skater(101, 'C');
  concurrentlyChangedRoster.benchSlots.find(
    (slot) => slot.slotId === 'B-2',
  ).asset = skater(4, 'C', 'benched');

  await assert.rejects(
    interceptNextCompatTransaction(
      () => db.doc(
        `leagues/${leagueId}/teams/${ownerId}/roster/current`,
      ).set(concurrentlyChangedRoster),
      () => startNextCycle(leagueId, leagueTeams, 1, {
        projectionRefreshPolicy: 'saved-only',
        consumeFutureLineupPlans: true,
      }),
    ),
    /Roster slot .*C-1 changed while the next matchup period was opening/,
  );

  assert.equal(
    (await db.doc(`leagues/${leagueId}/cycles/cycle-2`).get()).exists,
    false,
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get()).exists,
    false,
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get()).data().slots.find((slot) => slot.rosterSlotId === 'C-1')
      .resolution,
    'planned',
  );
});

test('full-cycle opening retries a newer whole-plan revision instead of conflicting an unchanged slot', async () => {
  const roster = buildRoster();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'full-cycle-plan-revision-one',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  });
  await db.doc(`leagues/${leagueId}/cycles/cycle-1`).update({
    status: 'complete',
    sourceNhlBlockNumber: 1,
    playerWindowContinuitySchemaVersion: 1,
  });

  const planRef = db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
  );
  const mutationStateRef = db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-2`,
  );
  await assert.rejects(
    interceptNextCompatTransaction(
      async () => {
        const planSnapshot = await planRef.get();
        const revisedSlots = planSnapshot.data().slots.map((slot) =>
          slot.rosterSlotId === 'C-2'
            ? { ...slot, assetKey: 'skater-101' }
            : slot,
        );
        const batch = db.batch();
        batch.update(planRef, {
          revision: 2,
          assignmentHash: createFutureMatchupLineupAssignmentHash(
            revisedSlots.map(({ rosterSlotId, assetKey }) => ({
              rosterSlotId,
              assetKey,
            })),
          ),
          slots: revisedSlots,
          updatedAt: new Date(),
        });
        batch.update(mutationStateRef, {
          latestRevision: 2,
          updatedAt: new Date(),
        });
        await batch.commit();
      },
      () => startNextCycle(leagueId, leagueTeams, 1, {
        projectionRefreshPolicy: 'saved-only',
        consumeFutureLineupPlans: true,
      }),
    ),
    /Future lineup plan .* changed while the next matchup period was opening/,
  );

  assert.equal(
    (await db.doc(`leagues/${leagueId}/cycles/cycle-2`).get()).exists,
    false,
  );
  const racedPlan = (await planRef.get()).data();
  assert.equal(racedPlan.revision, 2);
  assert.equal(
    racedPlan.slots.find((slot) => slot.rosterSlotId === 'C-1').resolution,
    'planned',
  );

  await startNextCycle(leagueId, leagueTeams, 1, {
    projectionRefreshPolicy: 'saved-only',
    consumeFutureLineupPlans: true,
  });
  const [c1Pick, c2Pick, appliedPlan] = await Promise.all([
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-2`,
    ).get(),
    planRef.get(),
  ]);
  assert.equal(c1Pick.data().asset.assetKey, 'skater-100');
  assert.equal(c2Pick.data().asset.assetKey, 'skater-101');
  assert.equal(appliedPlan.data().revision, 2);
  assert.equal(
    appliedPlan.data().slots.find((slot) => slot.rosterSlotId === 'C-1')
      .resolution,
    'applied',
  );
});

test('full-cycle future goalie promotion persists an authoritative commit boundary', async () => {
  const roster = buildRoster();
  roster.benchSlots.find((slot) => slot.slotId === 'B-5').asset =
    goalie('VAN', 'benched');
  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  ).set(roster);
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'full-cycle-goalie-plan',
    slots: requestedSlots(roster, { 'G-1': 'goalie-unit-VAN' }),
  });
  await db.doc(`leagues/${leagueId}/cycles/cycle-1`).update({
    status: 'complete',
    sourceNhlBlockNumber: 1,
    playerWindowContinuitySchemaVersion: 1,
  });

  await startNextCycle(leagueId, leagueTeams, 1, {
    projectionRefreshPolicy: 'saved-only',
    consumeFutureLineupPlans: true,
  });
  const [savedPick, audits] = await Promise.all([
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__G-1`,
    ).get(),
    db.collection(`leagues/${leagueId}/transactions`)
      .where('authority', '==', 'future-matchup-lineup-plan')
      .get(),
  ]);

  assert.equal(savedPick.data().asset.assetKey, 'goalie-unit-VAN');
  assert.equal(savedPick.data().snapshotSource, 'future-lineup-plan');
  assert.equal(savedPick.data().playerWindowContinuity, undefined);
  assert.equal(audits.size, 1);
  assert.equal(
    savedPick.data().snapshottedAt.toMillis(),
    audits.docs[0].data().createdAt.toMillis(),
  );
});

test('full-cycle opening retries a plan created after preflight, including an empty active slot', async () => {
  const roster = buildRoster();
  roster.activeSlots.find((slot) => slot.slotId === 'C-1').asset = null;
  roster.benchSlots.find((slot) => slot.slotId === 'B-2').asset =
    skater(4, 'C', 'benched');
  await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).set(roster),
    db.doc(`leagues/${leagueId}/cycles/cycle-1`).update({
      status: 'complete',
      sourceNhlBlockNumber: 1,
      playerWindowContinuitySchemaVersion: 1,
    }),
  ]);

  await assert.rejects(
    interceptNextCompatTransaction(
      () => call({
        leagueId,
        operation: 'save',
        cycleNumber: 2,
        expectedRevision: 0,
        requestId: 'late-full-cycle-plan',
        slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
      }),
      () => startNextCycle(leagueId, leagueTeams, 1, {
        projectionRefreshPolicy: 'saved-only',
        consumeFutureLineupPlans: true,
      }),
    ),
    /Future lineup plan .* changed while the next matchup period was opening/,
  );
  assert.equal(
    (await db.doc(`leagues/${leagueId}/cycles/cycle-2`).get()).exists,
    false,
  );

  const cycle = await startNextCycle(leagueId, leagueTeams, 1, {
    projectionRefreshPolicy: 'saved-only',
    consumeFutureLineupPlans: true,
  });
  assert.equal(cycle?.cycleNumber, 2);

  const [savedRoster, savedPick, savedPlan, savedCycle] = await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get(),
    db.doc(`leagues/${leagueId}/cycles/cycle-2`).get(),
  ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'C-1')
      .asset.assetKey,
    'skater-100',
  );
  assert.equal(savedPick.data().asset.assetKey, 'skater-100');
  assert.equal(savedPick.data().snapshotSource, 'future-lineup-plan');
  assert.equal(
    savedPick.data().playerWindowContinuity.assignmentNotBeforeMilliseconds
      .toMillis(),
    savedPick.data().snapshottedAt.toMillis(),
  );
  assert.equal(
    savedPlan.data().slots.find((slot) => slot.rosterSlotId === 'C-1')
      .resolution,
    'applied',
  );
  assert.equal(
    savedCycle.data().expectedRosterSlotIdsByOwner[ownerId].includes('C-1'),
    true,
  );
});

test('asynchronous rollover retries a late plan and counts its promoted empty slot as expected', async () => {
  const roster = buildRoster();
  roster.activeSlots.find((slot) => slot.slotId === 'C-1').asset = null;
  roster.benchSlots.find((slot) => slot.slotId === 'B-2').asset =
    skater(4, 'C', 'benched');
  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  ).set(roster);
  const fixture = completedWindowFixture('LW-1', skater(1, 'LW'));
  fixture.currentCycle.expectedRosterSlotIdsByOwner = {
    [ownerId]: ['LW-1'],
  };
  const runRollover = () => advanceCompletedRegularSeasonAssetWindows(
    leagueId,
    leagueTeams,
    fixture.currentCycle,
    [fixture.currentPick],
    fixture.scoring,
    {
      projectionRefreshPolicy: 'saved-only',
      consumeFutureLineupPlans: true,
    },
  );

  await assert.rejects(
    interceptNextCompatTransaction(
      () => call({
        leagueId,
        operation: 'save',
        cycleNumber: 2,
        expectedRevision: 0,
        requestId: 'late-async-plan',
        slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
      }),
      runRollover,
    ),
    /Future lineup plan .* changed while overlapping windows were opening/,
  );
  assert.equal(
    (await db.doc(`leagues/${leagueId}/cycles/cycle-2`).get()).exists,
    false,
  );

  const cycle = await runRollover();
  assert.equal(cycle?.cycleNumber, 2);
  const [savedRoster, savedPick, savedPlan, savedCycle] = await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get(),
    db.doc(`leagues/${leagueId}/cycles/cycle-2`).get(),
  ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'C-1')
      .asset.assetKey,
    'skater-100',
  );
  assert.equal(savedPick.data().asset.assetKey, 'skater-100');
  assert.equal(
    savedPlan.data().slots.find((slot) => slot.rosterSlotId === 'C-1')
      .resolution,
    'applied',
  );
  assert.deepEqual(
    savedCycle.data().expectedRosterSlotIdsByOwner[ownerId],
    ['C-1', 'LW-1'],
  );
  assert.equal(savedCycle.data().totalExpectedWindowCount, 2);
});

test('asynchronous empty-slot rollover retries a newer plan before resolving it', async () => {
  const roster = buildRoster();
  roster.activeSlots.find((slot) => slot.slotId === 'C-1').asset = null;
  roster.benchSlots.find((slot) => slot.slotId === 'B-2').asset =
    skater(4, 'C', 'benched');
  const opponentRoster = buildRoster();
  await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).set(roster),
    db.doc(`leagues/${leagueId}/teams/${opponentId}/roster/current`)
      .set(opponentRoster),
  ]);
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'empty-slot-null-plan-one',
    slots: requestedSlots(roster),
  });

  const fixture = completedWindowFixture('LW-1', skater(1, 'LW'));
  fixture.currentPick.ownerId = opponentId;
  fixture.currentPick.cycleWindowId =
    `${opponentId}__LW-1__cycle-1`;
  delete fixture.currentPick.playerWindowContinuity;
  fixture.scoring.windowScores = {
    [fixture.currentPick.cycleWindowId]: {
      ...Object.values(fixture.scoring.windowScores)[0],
      ownerId: opponentId,
      windowId: fixture.currentPick.cycleWindowId,
    },
  };
  fixture.scoring.teamScores = { [opponentId]: 12 };
  fixture.scoring.teamGameCounts = { [opponentId]: 6 };
  fixture.scoring.teamCycleComplete = { [opponentId]: false };
  fixture.currentCycle.expectedRosterSlotIdsByOwner = {
    [opponentId]: ['LW-1'],
  };
  const runRollover = () => advanceCompletedRegularSeasonAssetWindows(
    leagueId,
    leagueTeams,
    fixture.currentCycle,
    [fixture.currentPick],
    fixture.scoring,
    {
      projectionRefreshPolicy: 'saved-only',
      consumeFutureLineupPlans: true,
    },
  );

  await assert.rejects(
    interceptNextCompatTransaction(
      () => call({
        leagueId,
        operation: 'save',
        cycleNumber: 2,
        expectedRevision: 1,
        requestId: 'empty-slot-promotion-plan-two',
        slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
      }),
      runRollover,
    ),
    /Future lineup plan .*C-1 changed while overlapping windows were opening/,
  );
  assert.equal(
    (await db.doc(`leagues/${leagueId}/cycles/cycle-2`).get()).exists,
    false,
  );
  const planRef = db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
  );
  const racedPlan = (await planRef.get()).data();
  assert.equal(racedPlan.revision, 2);
  assert.equal(
    racedPlan.slots.find((slot) => slot.rosterSlotId === 'C-1').resolution,
    'planned',
  );

  await runRollover();
  const [savedPick, appliedPlan] = await Promise.all([
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get(),
    planRef.get(),
  ]);
  assert.equal(savedPick.data().asset.assetKey, 'skater-100');
  assert.equal(
    appliedPlan.data().slots.find((slot) => slot.rosterSlotId === 'C-1')
      .resolution,
    'applied',
  );
});

test('asynchronous rollover never commits an orphan expectation when an empty-slot plan races', async () => {
  const roster = buildRoster();
  roster.activeSlots.find((slot) => slot.slotId === 'C-1').asset = null;
  roster.benchSlots.find((slot) => slot.slotId === 'B-2').asset =
    skater(4, 'C', 'benched');
  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  ).set(roster);
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'empty-slot-race-plan',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  });

  const fixture = completedWindowFixture('LW-1', skater(1, 'LW'));
  fixture.currentCycle.expectedRosterSlotIdsByOwner = {
    [ownerId]: ['LW-1'],
  };
  const runRollover = () => advanceCompletedRegularSeasonAssetWindows(
    leagueId,
    leagueTeams,
    fixture.currentCycle,
    [fixture.currentPick],
    fixture.scoring,
    {
      projectionRefreshPolicy: 'saved-only',
      consumeFutureLineupPlans: true,
    },
  );

  const racedRoster = structuredClone(roster);
  racedRoster.benchSlots.find((slot) => slot.slotId === 'B-1').asset = null;
  await assert.rejects(
    interceptNextCompatTransaction(
      () => db.doc(
        `leagues/${leagueId}/teams/${ownerId}/roster/current`,
      ).set(racedRoster),
      runRollover,
    ),
    /Roster slot .*C-1 changed while overlapping windows were opening/,
  );
  assert.equal(
    (await db.doc(`leagues/${leagueId}/cycles/cycle-2`).get()).exists,
    false,
  );
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get()).data().slots.find((slot) => slot.rosterSlotId === 'C-1')
      .resolution,
    'planned',
  );

  await runRollover();
  const [savedCycle, savedPick, savedPlan] = await Promise.all([
    db.doc(`leagues/${leagueId}/cycles/cycle-2`).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get(),
  ]);
  assert.equal(savedPick.exists, false);
  assert.deepEqual(
    savedCycle.data().expectedRosterSlotIdsByOwner[ownerId],
    ['LW-1'],
  );
  assert.equal(savedCycle.data().totalExpectedWindowCount, 1);
  assert.equal(
    savedPlan.data().slots.find((slot) => slot.rosterSlotId === 'C-1')
      .resolution,
    'conflict',
  );
});

test('asynchronous rollover retries a newer whole-plan revision without conflicting its ready slot', async () => {
  const roster = buildRoster();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'async-plan-revision-one',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  });
  const fixture = completedWindowFixture('C-1', skater(4, 'C'), 4);
  const runRollover = () => advanceCompletedRegularSeasonAssetWindows(
    leagueId,
    leagueTeams,
    fixture.currentCycle,
    [fixture.currentPick],
    fixture.scoring,
    {
      projectionRefreshPolicy: 'saved-only',
      consumeFutureLineupPlans: true,
    },
  );

  await assert.rejects(
    interceptNextCompatTransaction(
      () => call({
        leagueId,
        operation: 'save',
        cycleNumber: 2,
        expectedRevision: 1,
        requestId: 'async-plan-revision-two',
        slots: requestedSlots(roster, {
          'C-1': 'skater-100',
          'C-2': 'skater-101',
        }),
      }),
      runRollover,
    ),
    /Future lineup plan .*C-1 changed while overlapping windows were opening/,
  );

  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get()).exists,
    false,
  );
  const planRef = db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
  );
  const racedPlan = (await planRef.get()).data();
  assert.equal(racedPlan.revision, 2);
  assert.equal(
    racedPlan.slots.find((slot) => slot.rosterSlotId === 'C-1').resolution,
    'planned',
  );

  await runRollover();
  const [savedPick, appliedPlan] = await Promise.all([
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get(),
    planRef.get(),
  ]);
  assert.equal(savedPick.data().asset.assetKey, 'skater-100');
  assert.equal(appliedPlan.data().revision, 2);
  assert.equal(
    appliedPlan.data().slots.find((slot) => slot.rosterSlotId === 'C-1')
      .resolution,
    'applied',
  );
  assert.equal(
    appliedPlan.data().slots.find((slot) => slot.rosterSlotId === 'C-2')
      .resolution,
    'planned',
  );
});

test('asynchronous slot rollover commits the roster, pick, plan, and audit idempotently', async () => {
  const roster = buildRoster();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'rollover-plan',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  });

  const currentAsset = skater(4, 'C');
  const cycleWindowId = `${ownerId}__C-1__cycle-1`;
  const currentPick = {
    overallPick: 4,
    round: 1,
    pickInRound: 4,
    ownerId,
    rosterSlotId: 'C-1',
    cycleWindowId,
    snapshotCycleNumber: 1,
    sourceNhlBlockNumber: 1,
    snapshotOrder: 4,
    snapshottedAt: new Date('2026-10-01T00:00:00.000Z'),
    playerWindowContinuity: {
      schemaVersion: 1,
      continuityId: `${ownerId}::C-1::skater-4::draft-4`,
      ownerId,
      rosterSlotId: 'C-1',
      assetKey: 'skater-4',
      priorAssignedGameIds: [],
      lastScheduleTeamAbbreviation: 'SEA',
    },
    asset: currentAsset,
  };
  const completedSummary = {
    assetKey: 'skater-4',
    ownerId,
    rosterSlotId: 'C-1',
    windowId: cycleWindowId,
    sourceNhlBlockNumber: 1,
    currentScore: 12,
    gamesPlayed: 6,
    actualGamesPlayed: 6,
    scheduledGames: 6,
    gamesLeft: 0,
    scheduledGameIds: [1, 2, 3, 4, 5, 6],
    scheduledGameDates: [],
    scheduledGameLabels: [],
    scheduleTeamAbbreviation: 'SEA',
    completedGameIds: [1, 2, 3, 4, 5, 6],
    liveGameIds: [],
    appearanceGameIds: [1, 2, 3, 4, 5, 6],
    gameScores: {},
    gameStates: {},
    gameInputCompleteness: {},
    incompleteFinalGameIds: [],
    firstScheduledGameDate: '2026-10-01',
    lastScheduledGameDate: '2026-10-11',
    status: 'complete',
  };
  const scoring = {
    scoringSchemaVersion: 2,
    assetScores: { 'skater-4': completedSummary },
    windowScores: { [cycleWindowId]: completedSummary },
    teamScores: { [ownerId]: 12 },
    teamGameCounts: { [ownerId]: 6 },
    teamCycleComplete: { [ownerId]: false },
    cycleHasScheduledGames: true,
    hasLiveGames: false,
    hasIncompleteFinalGames: false,
    nextScheduledGameStart: null,
    refreshedAt: '2026-10-12T00:00:00.000Z',
    dataFingerprint: 'future-lineup-rollover-fixture',
  };
  const teams = [
    { id: ownerId, ownerId, teamName: 'Future Team' },
    { id: opponentId, ownerId: opponentId, teamName: 'Opponent' },
  ];
  const currentCycle = {
    id: 'cycle-1',
    cycleNumber: 1,
    sourceNhlBlockNumber: 1,
    status: 'active',
    phase: 'regular_season',
    matchupIds: ['matchup-1'],
    expectedRosterSlotIdsByOwner: { [ownerId]: ['C-1'] },
  };
  const runRollover = () => advanceCompletedRegularSeasonAssetWindows(
    leagueId,
    teams,
    currentCycle,
    [currentPick],
    scoring,
    {
      projectionRefreshPolicy: 'saved-only',
      consumeFutureLineupPlans: true,
    },
  );

  const first = await runRollover();
  assert.equal(first?.cycleNumber, 2);

  const [savedRoster, savedPick, savedPlan, audits] = await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get(),
    db.collection(`leagues/${leagueId}/transactions`)
      .where('authority', '==', 'future-matchup-lineup-plan')
      .get(),
  ]);
  assert.equal(
    savedRoster.data().activeSlots.find((slot) => slot.slotId === 'C-1')
      .asset.assetKey,
    'skater-100',
  );
  assert.equal(
    savedRoster.data().benchSlots.find((slot) => slot.slotId === 'B-1')
      .asset.assetKey,
    'skater-4',
  );
  assert.equal(savedPick.data().asset.assetKey, 'skater-100');
  assert.equal(savedPick.data().snapshotSource, 'future-lineup-plan');
  assert.equal(
    savedPick.data().playerWindowContinuity.assignmentNotBeforeMilliseconds
      .toMillis(),
    savedPick.data().snapshottedAt.toMillis(),
  );
  assert.equal(
    savedPlan.data().slots.find((slot) => slot.rosterSlotId === 'C-1')
      .resolution,
    'applied',
  );
  assert.equal(audits.size, 1);

  await runRollover();
  const retryAudits = await db.collection(`leagues/${leagueId}/transactions`)
    .where('authority', '==', 'future-matchup-lineup-plan')
    .get();
  assert.equal(retryAudits.size, 1);
  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get()).data().asset.assetKey,
    'skater-100',
  );
});

test('a conflicted slot exposes its resolved target while another slot remains immediately editable', async () => {
  const roster = buildRoster();
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'partial-conflict-plan',
    slots: requestedSlots(roster, { 'C-1': 'skater-100' }),
  });
  const fixture = completedWindowFixture('C-1', skater(4, 'C'), 4);
  const runRollover = () => advanceCompletedRegularSeasonAssetWindows(
    leagueId,
    leagueTeams,
    fixture.currentCycle,
    [fixture.currentPick],
    fixture.scoring,
    {
      projectionRefreshPolicy: 'saved-only',
      consumeFutureLineupPlans: true,
    },
  );
  const racedRoster = buildRoster();
  racedRoster.benchSlots.find((slot) => slot.slotId === 'B-1').asset = null;

  await interceptNextCompatTransaction(
    () => db.doc(
      `leagues/${leagueId}/teams/${ownerId}/roster/current`,
    ).set(racedRoster),
    runRollover,
  );

  const [listed, savedPick, targetWindows] = await Promise.all([
    call({ leagueId, operation: 'list' }),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__C-1`,
    ).get(),
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/teamWindows/${ownerId}`,
    ).get(),
  ]);
  const conflicted = listed.plans[0].slots.find(
    (slot) => slot.rosterSlotId === 'C-1',
  );
  assert.equal(conflicted.assetKey, 'skater-100');
  assert.equal(conflicted.resolvedAssetKey, 'skater-4');
  assert.equal(conflicted.resolution, 'conflict');
  assert.equal(savedPick.data().asset.assetKey, 'skater-4');
  assert.equal(targetWindows.exists, false);

  const updated = await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 1,
    requestId: 'partial-conflict-second-save',
    slots: requestedSlots(racedRoster, {
      'C-1': conflicted.resolvedAssetKey,
      'C-2': 'skater-101',
    }),
  });
  const locked = updated.plan.slots.find(
    (slot) => slot.rosterSlotId === 'C-1',
  );
  const edited = updated.plan.slots.find(
    (slot) => slot.rosterSlotId === 'C-2',
  );
  assert.equal(updated.plan.revision, 2);
  assert.equal(locked.assetKey, 'skater-100');
  assert.equal(locked.resolvedAssetKey, 'skater-4');
  assert.equal(locked.resolution, 'conflict');
  assert.equal(edited.assetKey, 'skater-101');
  assert.equal(edited.resolution, 'planned');

  const persistedPlan = (await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
  ).get()).data();
  assert.equal(
    persistedPlan.assignmentHash,
    createFutureMatchupLineupAssignmentHash(
      persistedPlan.slots.map(({ rosterSlotId, assetKey }) => ({
        rosterSlotId,
        assetKey,
      })),
    ),
  );
});

test('asynchronous future goalie promotion persists an authoritative commit boundary', async () => {
  const roster = buildRoster();
  roster.benchSlots.find((slot) => slot.slotId === 'B-5').asset =
    goalie('VAN', 'benched');
  await db.doc(
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  ).set(roster);
  await call({
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'async-goalie-plan',
    slots: requestedSlots(roster, { 'G-1': 'goalie-unit-VAN' }),
  });
  const fixture = completedWindowFixture('G-1', goalie('SEA'), 14);
  delete fixture.currentPick.playerWindowContinuity;

  await advanceCompletedRegularSeasonAssetWindows(
    leagueId,
    leagueTeams,
    fixture.currentCycle,
    [fixture.currentPick],
    fixture.scoring,
    {
      projectionRefreshPolicy: 'saved-only',
      consumeFutureLineupPlans: true,
    },
  );
  const [savedPick, audits] = await Promise.all([
    db.doc(
      `leagues/${leagueId}/cycles/cycle-2/rosterPicks/${ownerId}__G-1`,
    ).get(),
    db.collection(`leagues/${leagueId}/transactions`)
      .where('authority', '==', 'future-matchup-lineup-plan')
      .get(),
  ]);

  assert.equal(savedPick.data().asset.assetKey, 'goalie-unit-VAN');
  assert.equal(savedPick.data().snapshotSource, 'future-lineup-plan');
  assert.equal(savedPick.data().playerWindowContinuity, undefined);
  assert.equal(audits.size, 1);
  assert.equal(
    savedPick.data().snapshottedAt.toMillis(),
    audits.docs[0].data().createdAt.toMillis(),
  );
});

test('a removed member cannot list, save, clear, or replay a saved request', async () => {
  const roster = buildRoster();
  const saveRequest = {
    leagueId,
    operation: 'save',
    cycleNumber: 2,
    expectedRevision: 0,
    requestId: 'removed-member-save-request',
    slots: requestedSlots(roster),
  };
  await call(saveRequest);
  await db.doc(`leagues/${leagueId}/members/${ownerId}`).delete();

  for (const request of [
    { leagueId, operation: 'list' },
    saveRequest,
    {
      leagueId,
      operation: 'clear',
      cycleNumber: 2,
      expectedRevision: 1,
      requestId: 'removed-member-clear-request',
    },
  ]) {
    await assert.rejects(
      call(request),
      (error) => error.code === 'permission-denied',
    );
  }

  assert.equal(
    (await db.doc(
      `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-2`,
    ).get()).exists,
    true,
  );
});
