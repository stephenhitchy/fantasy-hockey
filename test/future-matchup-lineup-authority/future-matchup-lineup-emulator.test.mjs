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
const firebaseAdminCompat = requireFunctions(
  './lib/shared/core/firebase-admin-compat.js',
);
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
