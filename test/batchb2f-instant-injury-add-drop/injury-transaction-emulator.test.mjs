import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test, { after, before, beforeEach } from 'node:test';

const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);
const projectId = 'demo-rinkrat-b2f';

process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;

const rosterMoves = requireFunctions('./lib/roster-moves.js');
const nhlApi = requireFunctions('./lib/shared/core/nhl/nhl-api.service.js');
const nhlIdentity = requireFunctions(
  './lib/shared/core/nhl/nhl-player-team-identity.service.js',
);
const projectionSnapshots = requireFunctions(
  './lib/shared/core/projection/projection-snapshot.service.js',
);
const runtimeFirebase = requireFunctions('./lib/shared/core/firebase.js');
const { deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
const { getFirestore } = requireFunctions('firebase-admin/firestore');

const leagueId = 'league-b2f-emulator';
const ownerId = 'owner-b2f';
const activeSlotId = 'C-1';
const benchSlotId = 'B-1';
const cycleId = 'cycle-4';
const cycleNumber = 4;
const playoffBankId = 'window-1';
const outgoingGameIds = [101, 102, 103, 104, 105, 106];
const retainedGameIds = outgoingGameIds.slice(0, 4);

let app;
let db;

async function resetEmulator() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  assert.ok(emulatorHost, 'B2F transaction tests require the Firestore emulator.');
  const response = await fetch(
    `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(response.ok, true, await response.text());
}

before(async () => {
  app = initializeApp({ projectId }, `b2f-${randomUUID()}`);
  db = getFirestore(app);
  await resetEmulator();
});

beforeEach(resetEmulator);

after(async () => {
  if (app) {
    await deleteApp(app);
  }
});

function rosterSkater({
  id,
  team,
  availabilityStatus = 'active',
  rosterStatus = 'active',
  gamesCounted = 0,
  fantasyPoints = 0,
}) {
  return {
    assetKey: `skater-${id}`,
    assetType: 'skater',
    position: 'C',
    player: {
      id,
      fullName: `Player ${id}`,
      position: 'C',
      nhlTeamAbbreviation: team,
      teamLogoUrl: `https://assets.nhle.com/logos/nhl/svg/${team}_light.svg`,
    },
    availabilityStatus,
    projectedCyclePoints: 60,
    frozenCycleProjectionPoints: 58.8,
    frozenProjectionCycleNumber: cycleNumber,
    frozenProjectionSource: 'shared-snapshot',
    frozenProjectionVersion: 11,
    frozenProjectionSnapshotId: 'projection-cycle-4',
    frozenProjectionGeneratedAt: '2026-10-09T12:00:00.000Z',
    frozenProjectionFrozenAt: '2026-10-09T12:05:00.000Z',
    eligibleFromCycleNumber: 1,
    rosterStatus,
    cycleScore: {
      cycleNumber,
      gamesCounted,
      fantasyPoints,
    },
  };
}

function draftableAsset(asset) {
  const copy = structuredClone(asset);
  delete copy.rosterStatus;
  delete copy.cycleScore;
  return copy;
}

function scheduleGame({ id, team, opponent, startMilliseconds, state }) {
  return {
    id,
    gameDate: new Date(startMilliseconds).toISOString().slice(0, 10),
    startTimeUTC: new Date(startMilliseconds).toISOString(),
    gameType: 2,
    gameState: state,
    gameScheduleState: 'OK',
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

function buildSchedule({
  team,
  opponent,
  firstGameId,
  nowMilliseconds,
  completedGameCount = 0,
}) {
  return Array.from({ length: 8 }, (_, index) => {
    const completed = index < completedGameCount;
    const offsetDays = completed
      ? -(completedGameCount - index)
      : index - completedGameCount + 1;

    return scheduleGame({
      id: firstGameId + index,
      team,
      opponent,
      startMilliseconds:
        nowMilliseconds + offsetDays * 24 * 60 * 60 * 1000,
      state: completed ? 'FINAL' : 'FUT',
    });
  });
}

function buildFixture(kind) {
  const nowMilliseconds = Date.now();
  const isPlayoff = kind === 'bench';
  const outgoing = rosterSkater({
    id: 1,
    team: 'CBJ',
    availabilityStatus: 'day-to-day',
    gamesCounted: 4,
    fantasyPoints: 41.9,
  });
  const incoming = rosterSkater({
    id: kind === 'bench' ? 2 : 3,
    team: kind === 'bench' ? 'ANA' : 'SJS',
    rosterStatus: kind === 'bench' ? 'benched' : 'new',
  });
  const incomingGameIds = kind === 'bench'
    ? [201, 202, 203, 204, 205, 206]
    : [301, 302, 303, 304, 305, 306];
  const pendingMoveId = `pending-${kind}-cycle-5`;
  const pendingMove = {
    id: pendingMoveId,
    moveType: 'add-drop',
    incomingAsset: incoming,
    outgoingAssetKey: outgoing.assetKey,
    sourceWaiverId: null,
    queuedByOwnerId: ownerId,
    queuedAt: '2026-10-09T18:58:45.718Z',
    requestedEffectiveCycleNumber: 5,
    requestedEffectiveLabel: 'Cycle 5',
    sourceBenchSlotId: kind === 'bench' ? benchSlotId : null,
    outgoingDestination: kind === 'bench' ? 'bench' : 'waivers',
  };
  const schedules = {
    CBJ: buildSchedule({
      team: 'CBJ',
      opponent: 'NYR',
      firstGameId: 101,
      nowMilliseconds,
      completedGameCount: 4,
    }),
    ANA: buildSchedule({
      team: 'ANA',
      opponent: 'LAK',
      firstGameId: 201,
      nowMilliseconds,
    }),
    SJS: buildSchedule({
      team: 'SJS',
      opponent: 'VGK',
      firstGameId: 301,
      nowMilliseconds,
    }),
  };
  const sourceNhlTargetGameIdsByTeam = {
    CBJ: outgoingGameIds,
    ANA: [201, 202, 203, 204, 205, 206],
    SJS: [301, 302, 303, 304, 305, 306],
  };
  const playerWindowContinuity = {
    schemaVersion: 1,
    continuityId:
      `${ownerId}::${activeSlotId}::${outgoing.assetKey}::draft-assignment`,
    ownerId,
    rosterSlotId: activeSlotId,
    assetKey: outgoing.assetKey,
    assignmentNotBeforeMilliseconds:
      nowMilliseconds - 30 * 24 * 60 * 60 * 1000,
    priorAssignedGameIds: [],
    lastScheduleTeamAbbreviation: 'CBJ',
  };
  const roster = {
    schemaVersion: 2,
    activeSlots: [{
      slotId: activeSlotId,
      position: 'C',
      slotNumber: 1,
      asset: outgoing,
      pendingMove,
      openFromCycleNumber: null,
    }],
    benchSlots: [{
      slotId: benchSlotId,
      slotNumber: 1,
      asset: kind === 'bench' ? incoming : null,
    }],
    irSlots: [],
  };
  const window = {
    id: `${ownerId}__${activeSlotId}__cycle-${cycleNumber}`,
    ownerId,
    rosterSlotId: activeSlotId,
    cycleNumber,
    position: 'C',
    assetKey: outgoing.assetKey,
    asset: draftableAsset(outgoing),
    status: 'active',
    scheduledGameIds: outgoingGameIds,
    scheduledGameDates: schedules.CBJ.slice(0, 6).map((game) => game.gameDate),
    scheduledGameLabels: schedules.CBJ.slice(0, 6).map(() => 'vs NYR'),
    scheduleTeamAbbreviation: 'CBJ',
    sourceTeamAbbreviationByGameId: Object.fromEntries(
      outgoingGameIds.map((gameId) => [String(gameId), 'CBJ']),
    ),
    teamIdentityChanged: false,
    completedGameIds: retainedGameIds,
    liveGameIds: [],
    appearanceGameIds: retainedGameIds,
    incompleteFinalGameIds: [],
    gameInputCompleteness: Object.fromEntries(
      retainedGameIds.map((gameId) => [String(gameId), { status: 'complete' }]),
    ),
    gameScores: {
      101: 10,
      102: 10,
      103: 10,
      104: 11.9,
    },
    gameStates: Object.fromEntries(
      retainedGameIds.map((gameId) => [String(gameId), 'final']),
    ),
    scheduledGames: 6,
    gamesPlayed: 4,
    actualGamesPlayed: 4,
    gamesLeft: 2,
    fantasyPoints: 41.9,
    frozenProjectionPoints: 58.8,
    frozenProjectionVersion: 11,
    frozenProjectionSource: 'shared-snapshot',
    frozenProjectionSnapshotId: 'projection-cycle-4',
    frozenProjectionGeneratedAt: '2026-10-09T12:00:00.000Z',
    frozenProjectionFrozenAt: '2026-10-09T12:05:00.000Z',
    frozenProjectionTargetGameIds: outgoingGameIds,
    playerWindowContinuity,
    firstScheduledGameDate: schedules.CBJ[0].gameDate,
    lastScheduledGameDate: schedules.CBJ[5].gameDate,
    startedAt: schedules.CBJ[0].startTimeUTC,
    completedAt: null,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-09T12:00:00.000Z',
  };

  return {
    kind,
    isPlayoff,
    nowMilliseconds,
    outgoing,
    incoming,
    incomingGameIds,
    pendingMove,
    pendingMoveId,
    schedules,
    sourceNhlTargetGameIdsByTeam,
    playerWindowContinuity,
    roster,
    window,
  };
}

async function seedFixture(fixture) {
  const batch = db.batch();
  const cyclePath = `leagues/${leagueId}/cycles/${cycleId}`;
  const initialRosterPick = {
    overallPick: 1,
    round: 1,
    pickInRound: 1,
    ownerId,
    asset: draftableAsset(fixture.outgoing),
    rosterArea: 'active',
    rosterSlotId: activeSlotId,
    cycleWindowId: fixture.window.id,
    snapshotCycleNumber: cycleNumber,
    snapshotOrder: 1,
    snapshotSource: 'cycle-start',
    sourceNhlTargetGameIds: outgoingGameIds,
    sourceNhlTargetGameIdsByTeam: fixture.sourceNhlTargetGameIdsByTeam,
    playerWindowContinuity: fixture.playerWindowContinuity,
    snapshottedAt: new Date(
      fixture.nowMilliseconds - 8 * 24 * 60 * 60 * 1000,
    ),
  };

  batch.set(db.doc(`leagues/${leagueId}`), {
    id: leagueId,
    scoringRules: { requiredGamesPerCycle: 6 },
  });
  batch.set(db.doc(`leagues/${leagueId}/members/${ownerId}`), {
    uid: ownerId,
    leagueId,
    role: 'member',
  });
  batch.set(db.doc(`leagues/${leagueId}/teams/${ownerId}`), {
    id: ownerId,
    ownerId,
  });
  batch.set(db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`), {
    ...fixture.roster,
    createdAt: new Date(fixture.nowMilliseconds - 30 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(fixture.nowMilliseconds - 60_000),
  });
  batch.set(db.doc(`leagues/${leagueId}/draft/current`), {
    status: 'complete',
    initialNhlBlockNumber: 1,
    seasonWindowAnchorStatus: 'building',
  });
  batch.set(db.doc('appData/playerAvailability'), {
    source: 'ESPN',
    status: 'success',
    draftReadinessSourceComplete: true,
    lastSuccessfulSyncAt: new Date(fixture.nowMilliseconds - 60_000),
    records: [{
      playerId: fixture.outgoing.player.id,
      status: 'day-to-day',
    }],
  });
  batch.set(db.doc(cyclePath), {
    id: cycleId,
    cycleNumber,
    status: 'active',
    phase: fixture.isPlayoff ? 'playoffs' : 'regular-season',
    expectedRosterSlotIdsByOwner: { [ownerId]: [activeSlotId] },
    sourceNhlTargetGameIdsByTeam: fixture.sourceNhlTargetGameIdsByTeam,
    totalExpectedWindowCount: 1,
    activeWindowCount: 1,
  });
  batch.set(db.doc(`${cyclePath}/teamWindows/${ownerId}`), {
    id: ownerId,
    ownerId,
    cycleNumber,
    expectedRosterSlotIds: [activeSlotId],
    windows: [fixture.window],
    completedWindowCount: 0,
    totalWindowCount: 1,
    status: 'active',
    completedAt: null,
    createdAt: new Date(fixture.nowMilliseconds - 8 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(fixture.nowMilliseconds - 60_000),
  });
  batch.set(
    db.doc(`${cyclePath}/rosterPicks/${ownerId}__${activeSlotId}`),
    initialRosterPick,
  );
  if (fixture.isPlayoff) {
    batch.set(
      db.doc(
        `leagues/${leagueId}/playoffWindowBanks/${ownerId}/windows/${playoffBankId}`,
      ),
      {
        id: playoffBankId,
        ownerId,
        windowNumber: 1,
        sourceCycleNumber: cycleNumber,
        sourceNhlBlockNumber: cycleNumber,
        sourceNhlTargetGameIdsByTeam: fixture.sourceNhlTargetGameIdsByTeam,
        status: 'active',
        assignmentStatus: 'assigned',
        assignedMatchupId: 'playoff-matchup-1',
        assignedRoundNumber: 1,
        expectedRosterSlotIds: [activeSlotId],
        playerWindowContinuitySchemaVersion: 1,
        picks: [{ ...initialRosterPick, playoffWindowNumber: 1 }],
        slotWindows: [fixture.window],
        teamScore: 41.9,
        completedWindowCount: 0,
        totalWindowCount: 1,
        completedAt: null,
        createdAt: new Date(
          fixture.nowMilliseconds - 8 * 24 * 60 * 60 * 1000,
        ),
        updatedAt: new Date(fixture.nowMilliseconds - 60_000),
      },
    );
  }

  await batch.commit();
}

function installExternalEvidenceMocks(t, fixture) {
  const teamByPlayerId = new Map([
    [fixture.outgoing.player.id, fixture.outgoing.player.nhlTeamAbbreviation],
    [fixture.incoming.player.id, fixture.incoming.player.nhlTeamAbbreviation],
  ]);
  const generatedAt = new Date(fixture.nowMilliseconds).toISOString();
  const projectionSnapshot = {
    metadata: {},
    assets: [
      draftableAsset(fixture.outgoing),
      draftableAsset(fixture.incoming),
    ],
  };

  t.mock.method(
    nhlApi,
    'getNhlTeamSeasonSchedule',
    async (teamAbbreviation) => {
      const schedule = fixture.schedules[String(teamAbbreviation).toUpperCase()];
      assert.ok(schedule, `Unexpected NHL schedule request for ${teamAbbreviation}.`);
      return structuredClone(schedule);
    },
  );
  t.mock.method(
    nhlApi,
    'getCurrentNhlPlayerTeamIdentity',
    async (playerId) => {
      const teamAbbreviation = teamByPlayerId.get(playerId);
      assert.ok(teamAbbreviation, `Unexpected NHL identity request for ${playerId}.`);
      return { playerId, teamAbbreviation };
    },
  );
  t.mock.method(
    nhlIdentity,
    'loadCurrentNhlPlayerTeamIdentity',
    async ({ requiredPlayerIds }) => {
      const requested = [...requiredPlayerIds];
      for (const playerId of requested) {
        assert.ok(
          teamByPlayerId.has(playerId),
          `Unexpected catalog identity request for ${playerId}.`,
        );
      }

      return {
        generatedAt,
        identityHash: `identity-${fixture.kind}`,
        playerCount: requested.length,
        byPlayerId: new Map(
          requested.map((playerId) => [playerId, teamByPlayerId.get(playerId)]),
        ),
        teamConfirmedAtByPlayerId: new Map(
          requested.map((playerId) => [playerId, generatedAt]),
        ),
      };
    },
  );
  t.mock.method(
    projectionSnapshots,
    'loadSharedProjectionSnapshot',
    async () => structuredClone(projectionSnapshot),
  );
  t.mock.method(
    projectionSnapshots,
    'loadSharedProjectionSnapshotForCycle',
    async () => structuredClone(projectionSnapshot),
  );
}

function buildAutomaticRequest(fixture) {
  const moveType = fixture.kind === 'bench'
    ? 'injury-active-bench-swap'
    : 'injury-add-drop-active';
  const pendingMoveFingerprint = fixture.kind === 'bench'
    ? rosterMoves.getQueuedBenchSwapInjuryPromotionFingerprint({
        pendingMove: fixture.pendingMove,
        ownerId,
        activeSlotId,
        benchSlotId,
        outgoingAssetKey: fixture.outgoing.assetKey,
        incomingAssetKey: fixture.incoming.assetKey,
      })
    : rosterMoves.getQueuedFreeAgentInjuryPromotionFingerprint({
        pendingMove: fixture.pendingMove,
        ownerId,
        activeSlotId,
        outgoingAssetKey: fixture.outgoing.assetKey,
        incomingAssetKey: fixture.incoming.assetKey,
      });

  assert.match(pendingMoveFingerprint, /^[a-f0-9]{64}$/);

  const request = {
    leagueId,
    ownerId,
    activeSlotId,
    moveType,
    benchSlotId: fixture.kind === 'bench' ? benchSlotId : null,
    incomingAssetKey: fixture.incoming.assetKey,
    expectedPendingMoveId: fixture.pendingMoveId,
    expectedPendingMoveFingerprint: pendingMoveFingerprint,
    source: 'scheduled-backstop',
  };
  const receipt = rosterMoves.createAutomaticInjuryReplacementReceiptIdentity({
    leagueId,
    ownerId,
    activeSlotId,
    moveType,
    benchSlotId: fixture.kind === 'bench' ? benchSlotId : '',
    incomingAssetKey:
      fixture.kind === 'free-agent' ? fixture.incoming.assetKey : null,
    pendingMoveId: fixture.pendingMoveId,
    pendingMoveFingerprint,
  });

  return { request, receipt };
}

async function readCommittedGraph(receiptTransactionId, fixture) {
  const cyclePath = `leagues/${leagueId}/cycles/${cycleId}`;
  const [
    rosterSnapshot,
    cycleSnapshot,
    teamWindowsSnapshot,
    rosterPickSnapshot,
    transactionSnapshot,
    outgoingWaiverSnapshot,
    incomingWaiverSnapshot,
    transactionCollection,
    playoffBankSnapshot,
  ] = await Promise.all([
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
    db.doc(cyclePath).get(),
    db.doc(`${cyclePath}/teamWindows/${ownerId}`).get(),
    db.doc(`${cyclePath}/rosterPicks/${ownerId}__${activeSlotId}`).get(),
    db.doc(`leagues/${leagueId}/transactions/${receiptTransactionId}`).get(),
    db.doc(`leagues/${leagueId}/waivers/${fixture.outgoing.assetKey}`).get(),
    db.doc(`leagues/${leagueId}/waivers/${fixture.incoming.assetKey}`).get(),
    db.collection(`leagues/${leagueId}/transactions`).get(),
    db.doc(
      `leagues/${leagueId}/playoffWindowBanks/${ownerId}/windows/${playoffBankId}`,
    ).get(),
  ]);

  assert.equal(rosterSnapshot.exists, true);
  assert.equal(cycleSnapshot.exists, true);
  assert.equal(teamWindowsSnapshot.exists, true);
  assert.equal(rosterPickSnapshot.exists, true);
  assert.equal(transactionSnapshot.exists, true);

  return {
    roster: rosterSnapshot.data(),
    cycle: cycleSnapshot.data(),
    teamWindows: teamWindowsSnapshot.data(),
    rosterPick: rosterPickSnapshot.data(),
    transaction: transactionSnapshot.data(),
    outgoingWaiverSnapshot,
    incomingWaiverSnapshot,
    transactionCollection,
    playoffBankSnapshot,
  };
}

function assertSharedAtomicGraph(graph, fixture, receipt) {
  const activeSlot = graph.roster.activeSlots.find(
    (slot) => slot.slotId === activeSlotId,
  );
  const committedWindow = graph.teamWindows.windows.find(
    (window) => window.rosterSlotId === activeSlotId,
  );
  const plan = committedWindow.injuryReplacementWindow;
  const outgoingSegment = plan.segments[0];
  const incomingSegment = plan.segments[1];
  const expectedIncomingGameIds = fixture.incomingGameIds.slice(0, 2);

  assert.equal(activeSlot.asset.assetKey, fixture.incoming.assetKey);
  assert.equal(activeSlot.asset.rosterStatus, 'active');
  assert.equal(activeSlot.pendingMove, null);
  assert.equal(activeSlot.openFromCycleNumber, null);
  assert.equal(graph.rosterPick.asset.assetKey, fixture.incoming.assetKey);
  assert.deepEqual(
    graph.rosterPick.injuryReplacementWindow,
    committedWindow.injuryReplacementWindow,
  );
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.latestTransactionId, receipt.transactionId);
  assert.equal(plan.replacementCount, 1);
  assert.equal(plan.requiredGames, 6);
  assert.equal(outgoingSegment.assetKey, fixture.outgoing.assetKey);
  assert.deepEqual(outgoingSegment.scheduledGameIds, retainedGameIds);
  assert.equal(incomingSegment.assetKey, fixture.incoming.assetKey);
  assert.deepEqual(incomingSegment.scheduledGameIds, expectedIncomingGameIds);
  assert.deepEqual(
    committedWindow.scheduledGameIds,
    [...retainedGameIds, ...expectedIncomingGameIds],
  );
  assert.deepEqual(committedWindow.completedGameIds, retainedGameIds);
  assert.deepEqual(committedWindow.appearanceGameIds, retainedGameIds);
  assert.deepEqual(committedWindow.gameScores, {
    101: 10,
    102: 10,
    103: 10,
    104: 11.9,
  });
  assert.equal(committedWindow.fantasyPoints, 41.9);
  assert.equal(committedWindow.gamesPlayed, 4);
  assert.equal(committedWindow.gamesLeft, 2);
  assert.deepEqual(committedWindow.scoringAssetKeyByGameId, {
    101: fixture.outgoing.assetKey,
    102: fixture.outgoing.assetKey,
    103: fixture.outgoing.assetKey,
    104: fixture.outgoing.assetKey,
    [String(expectedIncomingGameIds[0])]: fixture.incoming.assetKey,
    [String(expectedIncomingGameIds[1])]: fixture.incoming.assetKey,
  });
  assert.deepEqual(
    graph.rosterPick.sourceNhlTargetGameIds,
    expectedIncomingGameIds,
  );
  assert.deepEqual(graph.teamWindows.expectedRosterSlotIds, [activeSlotId]);
  assert.equal(graph.teamWindows.completedWindowCount, 0);
  assert.equal(graph.teamWindows.totalWindowCount, 1);
  assert.equal(graph.teamWindows.status, 'active');
  assert.deepEqual(
    graph.cycle.expectedRosterSlotIdsByOwner[ownerId],
    [activeSlotId],
  );
  assert.equal(graph.cycle.totalExpectedWindowCount, 1);
  assert.equal(graph.cycle.activeWindowCount, 1);
  if (fixture.isPlayoff) {
    assert.equal(graph.playoffBankSnapshot.exists, true);
    const bank = graph.playoffBankSnapshot.data();
    const bankPick = bank.picks.find(
      (pick) => pick.rosterSlotId === activeSlotId,
    );
    const bankWindow = bank.slotWindows.find(
      (window) => window.rosterSlotId === activeSlotId,
    );

    assert.equal(bank.assignmentStatus, 'assigned');
    assert.equal(bank.sourceCycleNumber, cycleNumber);
    assert.equal(bankPick.asset.assetKey, fixture.incoming.assetKey);
    assert.equal(bankPick.playoffWindowNumber, 1);
    assert.deepEqual(
      bankPick.sourceNhlTargetGameIds,
      expectedIncomingGameIds,
    );
    assert.deepEqual(bankPick.injuryReplacementWindow, plan);
    assert.equal(bankWindow.assetKey, fixture.incoming.assetKey);
    assert.deepEqual(bankWindow.injuryReplacementWindow, plan);
    assert.deepEqual(
      bankWindow.scheduledGameIds,
      [...retainedGameIds, ...expectedIncomingGameIds],
    );
    assert.deepEqual(bankWindow.completedGameIds, retainedGameIds);
    assert.deepEqual(bankWindow.appearanceGameIds, retainedGameIds);
    assert.deepEqual(bankWindow.gameScores, committedWindow.gameScores);
    assert.equal(bankWindow.fantasyPoints, 41.9);
    assert.equal(bankWindow.gamesPlayed, 4);
    assert.equal(bankWindow.gamesLeft, 2);
    assert.deepEqual(bank.expectedRosterSlotIds, [activeSlotId]);
    assert.equal(bank.playerWindowContinuitySchemaVersion, 1);
    assert.equal(bank.teamScore, 41.9);
    assert.equal(bank.completedWindowCount, 0);
    assert.equal(bank.totalWindowCount, 1);
    assert.equal(bank.status, 'active');
    assert.equal(bank.completedAt, null);
  } else {
    assert.equal(graph.playoffBankSnapshot.exists, false);
  }
  assert.equal(graph.transaction.effectiveCycleNumber, cycleNumber);
  assert.equal(graph.transaction.activeSlotId, activeSlotId);
  assert.equal(graph.transaction.availabilityStatus, 'day-to-day');
  assert.equal(graph.transaction.supersededQueuedMoveId, fixture.pendingMoveId);
  assert.equal(
    graph.transaction.injuryReplacementWindow.latestTransactionId,
    receipt.transactionId,
  );
  assert.equal(
    graph.transaction.rosterActionSubmission.submissionId,
    receipt.submissionId,
  );
  assert.equal(
    graph.transaction.rosterActionSubmission.requestFingerprint,
    receipt.requestFingerprint,
  );
  assert.equal(graph.transactionCollection.size, 1);
  assert.equal(graph.incomingWaiverSnapshot.exists, false);
}

function installConcurrentRosterReadBarrier(t, rosterPath) {
  const originalRunTransaction = runtimeFirebase.db.runTransaction.bind(
    runtimeFirebase.db,
  );
  const attemptsByInvocation = [];
  let invocationCount = 0;
  let firstAttemptRosterReadCount = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });

  t.mock.method(
    runtimeFirebase.db,
    'runTransaction',
    function instrumentedRunTransaction(updateFunction, options) {
      const invocationIndex = invocationCount;
      invocationCount += 1;
      attemptsByInvocation[invocationIndex] = 0;

      const wrappedUpdateFunction = async (transaction) => {
        attemptsByInvocation[invocationIndex] += 1;
        const shouldSynchronize =
          invocationIndex < 2 && attemptsByInvocation[invocationIndex] === 1;
        const transactionProxy = new Proxy(transaction, {
          get(target, property) {
            if (property === 'get') {
              return async (reference) => {
                const snapshot = await target.get(reference);

                if (shouldSynchronize && reference.path === rosterPath) {
                  firstAttemptRosterReadCount += 1;
                  if (firstAttemptRosterReadCount === 2) {
                    releaseBarrier();
                  }
                  await barrier;
                }

                return snapshot;
              };
            }

            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });

        return updateFunction(transactionProxy);
      };

      return options === undefined
        ? originalRunTransaction(wrappedUpdateFunction)
        : originalRunTransaction(wrappedUpdateFunction, options);
    },
  );

  return {
    getAttempts: () => [...attemptsByInvocation],
    getFirstAttemptRosterReadCount: () => firstAttemptRosterReadCount,
  };
}

test('real queued injury bench promotion atomically preserves started ownership and replays one receipt', async (t) => {
  const fixture = buildFixture('bench');
  await seedFixture(fixture);
  installExternalEvidenceMocks(t, fixture);
  const { request, receipt } = buildAutomaticRequest(fixture);

  const first = await rosterMoves.applyAutomaticQueuedInjuryReplacement(request);
  const replay = await rosterMoves.applyAutomaticQueuedInjuryReplacement(request);
  const graph = await readCommittedGraph(receipt.transactionId, fixture);

  assert.deepEqual(replay, first);
  assert.deepEqual(first, {
    applied: true,
    cycleNumber,
    activeSlotId,
    message: 'Injury transaction applied to the remaining games in Cycle 4.',
  });
  assertSharedAtomicGraph(graph, fixture, receipt);

  const benchSlot = graph.roster.benchSlots.find(
    (slot) => slot.slotId === benchSlotId,
  );
  assert.equal(benchSlot.asset.assetKey, fixture.outgoing.assetKey);
  assert.equal(benchSlot.asset.rosterStatus, 'benched');
  assert.equal(benchSlot.asset.cycleScore.gamesCounted, 4);
  assert.equal(benchSlot.asset.cycleScore.fantasyPoints, 41.9);
  assert.equal(graph.outgoingWaiverSnapshot.exists, false);
  assert.equal(graph.transaction.type, 'injury-active-bench-swap');
  assert.equal(graph.transaction.outgoingDestination, 'bench');
  assert.equal(graph.transaction.benchSlotId, benchSlotId);
  assert.equal(graph.transaction.movedAsset.assetKey, fixture.outgoing.assetKey);
  assert.equal(graph.transaction.activatedAsset.assetKey, fixture.incoming.assetKey);
  assert.equal(graph.transaction.droppedAsset, null);
});

test('real queued injury add/drop survives a concurrent duplicate transaction retry and commits one atomic graph', async (t) => {
  const fixture = buildFixture('free-agent');
  await seedFixture(fixture);
  installExternalEvidenceMocks(t, fixture);
  const { request, receipt } = buildAutomaticRequest(fixture);
  const contention = installConcurrentRosterReadBarrier(
    t,
    `leagues/${leagueId}/teams/${ownerId}/roster/current`,
  );

  const [first, duplicate] = await Promise.all([
    rosterMoves.applyAutomaticQueuedInjuryReplacement(request),
    rosterMoves.applyAutomaticQueuedInjuryReplacement(request),
  ]);
  const replay = await rosterMoves.applyAutomaticQueuedInjuryReplacement(request);
  const graph = await readCommittedGraph(receipt.transactionId, fixture);

  assert.deepEqual(duplicate, first);
  assert.deepEqual(replay, first);
  assert.equal(contention.getFirstAttemptRosterReadCount(), 2);
  assert.equal(
    contention.getAttempts().some((attemptCount) => attemptCount > 1),
    true,
    'the emulator should retry one transaction after both first attempts read the same roster version',
  );
  assertSharedAtomicGraph(graph, fixture, receipt);

  assert.equal(graph.outgoingWaiverSnapshot.exists, true);
  assert.equal(graph.outgoingWaiverSnapshot.data().status, 'active');
  assert.equal(
    graph.outgoingWaiverSnapshot.data().assetKey,
    fixture.outgoing.assetKey,
  );
  assert.equal(
    graph.outgoingWaiverSnapshot.data().droppedByOwnerId,
    ownerId,
  );
  assert.equal(graph.transaction.type, 'injury-add-drop-active');
  assert.equal(graph.transaction.outgoingDestination, 'waivers');
  assert.equal(graph.transaction.benchSlotId, null);
  assert.equal(graph.transaction.addedAsset.assetKey, fixture.incoming.assetKey);
  assert.equal(graph.transaction.droppedAsset.assetKey, fixture.outgoing.assetKey);
  assert.equal(graph.transaction.activatedAsset.assetKey, fixture.incoming.assetKey);
  assert.equal(graph.transaction.waiverId, fixture.outgoing.assetKey);
});
