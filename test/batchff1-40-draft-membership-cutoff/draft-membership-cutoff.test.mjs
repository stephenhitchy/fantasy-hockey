import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test, { after, before, beforeEach } from 'node:test';

import {
  DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS,
  buildDraftFinalizationTaskId,
  createDraftParticipantHash,
  draftFinalizationMatchesParticipants,
  finalizeDraftOrder,
  isDraftMembershipCutoffReached,
  isDraftMembershipLocked,
} from '../../functions/src/draft-lifecycle.util.ts';
import {
  buildScheduledDraftStartTaskId,
  getScheduledDraftStartTaskState,
} from '../../functions/src/draft-readiness.util.ts';

const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const {
  getPreDraftLeagueCapacityBlockReason,
  getPreDraftMemberRemovalBlockReason,
  isDraftJoinLocked,
} = requireFunctions('./lib/league-lifecycle-authority.util.js');
const projectId = 'demo-rinkrat-ff1-40';
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;

const { finalizeScheduledDraftMembership } = requireFunctions('./lib/draft-automation.js');
const { cancelDraftSchedule, saveDraftSettings } = requireFunctions('./lib/draft-authority.js');
const {
  executePreDraftLeagueCapacityUpdate,
  joinLeagueSecure,
} = requireFunctions('./lib/league-lifecycle-authority.js');
const { updateScheduledDraftReadinessDocument } = requireFunctions(
  './lib/shared/core/draft/draft-readiness-write.service.js',
);
const { deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
const { getFirestore, Timestamp } = requireFunctions('firebase-admin/firestore');

let app;
let db;

async function reset() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  assert.ok(emulatorHost, 'This suite must run only in the Firestore emulator.');
  const result = await fetch(
    `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(result.ok, true, await result.text());
}

before(async () => {
  app = initializeApp({ projectId }, `ff1-40-${randomUUID()}`);
  db = getFirestore(app);
  await reset();
});
beforeEach(reset);
after(async () => { if (app) await deleteApp(app); });

test('custom finalization keeps existing relative order and inserts late joiners once', () => {
  const finalized = finalizeDraftOrder({
    orderMode: 'custom',
    currentOrder: ['owner-a', 'owner-b'],
    participantIds: ['owner-a', 'owner-b', 'owner-c'],
    randomizationSeed: 'fixed-custom-seed',
  });

  assert.deepEqual([...finalized.order].sort(), ['owner-a', 'owner-b', 'owner-c']);
  assert.ok(finalized.order.indexOf('owner-a') < finalized.order.indexOf('owner-b'));
  assert.equal(finalized.reusedPreservedOrder, false);

  const replay = finalizeDraftOrder({
    orderMode: 'custom',
    currentOrder: finalized.order,
    participantIds: ['owner-c', 'owner-b', 'owner-a'],
    randomizationSeed: 'a-different-seed-must-not-reroll',
    preservedParticipantHash: finalized.participantHash,
  });

  assert.equal(replay.reusedPreservedOrder, true);
  assert.deepEqual(replay.order, finalized.order);
});

test('randomized finalization is deterministic per seed and covers the exact final participants', () => {
  const participantIds = ['a', 'b', 'c', 'd', 'e', 'f'];
  const first = finalizeDraftOrder({
    orderMode: 'randomized',
    currentOrder: participantIds,
    participantIds,
    randomizationSeed: 'seed-one',
  });
  const duplicate = finalizeDraftOrder({
    orderMode: 'randomized',
    currentOrder: participantIds,
    participantIds,
    randomizationSeed: 'seed-one',
  });

  assert.deepEqual(first.order, duplicate.order);
  assert.deepEqual([...first.order].sort(), participantIds);
  assert.equal(first.participantHash, createDraftParticipantHash(participantIds));
});

test('explicit open state supersedes legacy saved-order locking', () => {
  assert.equal(isDraftMembershipLocked({
    status: 'scheduled', membershipLockStatus: 'open', roundOneOrder: ['a', 'b'],
  }), false);
  assert.equal(isDraftMembershipLocked({ status: 'scheduled', roundOneOrder: ['a', 'b'] }), true);
  assert.equal(isDraftMembershipLocked({
    status: 'scheduled', membershipLockStatus: 'locked', roundOneOrder: ['a', 'b'],
  }), true);
});

test('server time closes every membership mutation exactly at T-40', () => {
  const scheduledStartMilliseconds = 1_800_000_000_000;
  const cutoffMilliseconds =
    scheduledStartMilliseconds - DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS;
  const draftData = {
    status: 'scheduled',
    membershipLockStatus: 'open',
    scheduledStartAt: scheduledStartMilliseconds,
    roundOneOrder: ['owner-a', 'owner-b'],
    draftedAssetKeys: [],
    nextOverallPick: 1,
    clockStatus: 'stopped',
  };

  assert.equal(isDraftMembershipCutoffReached({
    draftStatus: 'scheduled',
    scheduledStartMilliseconds,
    nowMilliseconds: cutoffMilliseconds - 1_000,
  }), false);
  assert.equal(isDraftMembershipCutoffReached({
    draftStatus: 'scheduled',
    scheduledStartMilliseconds,
    nowMilliseconds: cutoffMilliseconds,
  }), true);
  assert.equal(isDraftMembershipCutoffReached({
    draftStatus: 'scheduled',
    scheduledStartMilliseconds,
    nowMilliseconds: cutoffMilliseconds + 1_000,
  }), true);

  assert.equal(isDraftJoinLocked(draftData, cutoffMilliseconds - 1_000), false);
  assert.equal(isDraftJoinLocked(draftData, cutoffMilliseconds), true);
  assert.equal(isDraftJoinLocked(draftData, cutoffMilliseconds + 1_000), true);
  assert.equal(getPreDraftLeagueCapacityBlockReason({
    joinStatus: 'open',
    draftData,
    nowMilliseconds: cutoffMilliseconds,
    cycleDocumentCount: 0,
    draftPickDocumentCount: 0,
    transactionDocumentCount: 0,
    waiverDocumentCount: 0,
  }), 'draft-locked');
  assert.equal(getPreDraftMemberRemovalBlockReason({
    leagueJoinStatus: 'open',
    draftData,
    nowMilliseconds: cutoffMilliseconds,
    cycleDocumentCount: 0,
    draftPickDocumentCount: 0,
    transactionDocumentCount: 0,
    waiverDocumentCount: 0,
    teamData: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 },
    rosterData: { activeSlots: [], benchSlots: [], irSlots: [] },
  }), 'draft-locked');

  assert.equal(isDraftJoinLocked({
    status: 'setup',
    membershipLockStatus: 'open',
    scheduledStartAt: null,
    roundOneOrder: draftData.roundOneOrder,
  }, cutoffMilliseconds + 1_000), false);
});

test('start eligibility requires the exact finalized participant set and schedule generation', () => {
  const participants = ['a', 'b'];
  const participantHash = createDraftParticipantHash(participants);

  assert.equal(draftFinalizationMatchesParticipants({
    status: 'scheduled',
    membershipLockStatus: 'locked',
    roundOneOrder: participants,
    scheduleGeneration: 3,
    finalizedScheduleGeneration: 3,
    orderParticipantHash: participantHash,
  }, participants), true);
  assert.equal(draftFinalizationMatchesParticipants({
    status: 'scheduled',
    membershipLockStatus: 'locked',
    roundOneOrder: participants,
    scheduleGeneration: 4,
    finalizedScheduleGeneration: 3,
    orderParticipantHash: participantHash,
  }, participants), false);
  assert.equal(draftFinalizationMatchesParticipants({
    status: 'scheduled',
    membershipLockStatus: 'locked',
    roundOneOrder: participants,
    scheduleGeneration: 3,
    finalizedScheduleGeneration: 3,
    orderParticipantHash: participantHash,
  }, [...participants, 'c']), false);
  assert.equal(draftFinalizationMatchesParticipants({
    status: 'scheduled',
    roundOneOrder: participants,
  }, participants), true);
});

test('schedule generation changes finalization and exact-start task identity and stales old work', () => {
  const input = {
    leagueId: 'league-one',
    scheduledStartMilliseconds: 1_800_000_000_000,
  };

  assert.notEqual(
    buildDraftFinalizationTaskId({ ...input, scheduleGeneration: 4 }),
    buildDraftFinalizationTaskId({ ...input, scheduleGeneration: 5 }),
  );
  assert.notEqual(
    buildScheduledDraftStartTaskId({ ...input, scheduleGeneration: 4 }),
    buildScheduledDraftStartTaskId({ ...input, scheduleGeneration: 5 }),
  );
  assert.equal(getScheduledDraftStartTaskState({
    draftStatus: 'scheduled',
    expectedScheduledStartMilliseconds: input.scheduledStartMilliseconds,
    actualScheduledStartMilliseconds: input.scheduledStartMilliseconds,
    expectedScheduleGeneration: 4,
    actualScheduleGeneration: 5,
    nowMilliseconds: input.scheduledStartMilliseconds,
  }), 'stale');
});

test('server cutoff atomically locks league, invite, participant hash, and custom order', async () => {
  const leagueId = `cutoff-${randomUUID()}`;
  const inviteCode = `F${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  const owners = ['owner-a', 'owner-b', 'owner-c'];
  const scheduledStartMilliseconds = Date.now() + 2 * 60 * 60 * 1000;
  const scheduleGeneration = 7;
  const batch = db.batch();

  batch.set(db.doc(`leagues/${leagueId}`), {
    id: leagueId,
    commissionerId: owners[0],
    inviteCode,
    maxTeams: 6,
    teamCount: owners.length,
    joinStatus: 'open',
  });
  batch.set(db.doc(`leagueInvites/${inviteCode}`), {
    leagueId,
    inviteCode,
    active: true,
    joinCount: owners.length,
    expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
  });
  owners.forEach((ownerId, index) => {
    batch.set(db.doc(`leagues/${leagueId}/members/${ownerId}`), {
      uid: ownerId,
      leagueId,
      role: index === 0 ? 'commissioner' : 'member',
    });
    batch.set(db.doc(`leagues/${leagueId}/teams/${ownerId}`), {
      id: ownerId,
      ownerId,
    });
  });
  batch.set(db.doc(`leagues/${leagueId}/draft/current`), {
    schemaVersion: 3,
    status: 'scheduled',
    format: 'snake',
    totalRounds: 17,
    rosterRequirements: { LW: 3, C: 3, RW: 3, D: 4, G: 1 },
    benchSlots: 3,
    roundOneOrder: owners.slice(0, 2),
    orderMode: 'custom',
    orderEpoch: 0,
    scheduleGeneration,
    membershipLockStatus: 'open',
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt: Timestamp.fromMillis(scheduledStartMilliseconds),
    pickSeconds: 60,
    clockStatus: 'stopped',
    pickStartedAt: null,
    currentPickSeconds: 60,
    pausedRemainingSeconds: null,
  });
  await batch.commit();

  const early = await finalizeScheduledDraftMembership(
    leagueId,
    scheduledStartMilliseconds,
    scheduleGeneration,
    scheduledStartMilliseconds - DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS - 1_000,
    'too-early-finalization-seed',
  );
  assert.equal(early, 'early');
  assert.equal((await db.doc(`leagues/${leagueId}/draft/current`).get()).data().membershipLockStatus, 'open');

  const first = await finalizeScheduledDraftMembership(
    leagueId,
    scheduledStartMilliseconds,
    scheduleGeneration,
    scheduledStartMilliseconds - DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS,
    'emulator-finalization-seed',
  );
  assert.equal(first, 'finalized');

  const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
  const firstDraft = (await draftRef.get()).data();
  const league = (await db.doc(`leagues/${leagueId}`).get()).data();
  const invite = (await db.doc(`leagueInvites/${inviteCode}`).get()).data();

  assert.equal(firstDraft.membershipLockStatus, 'locked');
  assert.equal(firstDraft.finalizedScheduleGeneration, scheduleGeneration);
  assert.equal(firstDraft.orderEpoch, 1);
  assert.equal(firstDraft.orderParticipantHash, createDraftParticipantHash(owners));
  assert.deepEqual([...firstDraft.roundOneOrder].sort(), owners);
  assert.ok(firstDraft.roundOneOrder.indexOf('owner-a') < firstDraft.roundOneOrder.indexOf('owner-b'));
  assert.equal(league.joinStatus, 'locked');
  assert.equal(league.joinLockedReason, 'draft-cutoff');
  assert.equal(invite.active, false);
  assert.equal(invite.lockedReason, 'draft-cutoff');

  const duplicate = await finalizeScheduledDraftMembership(
    leagueId,
    scheduledStartMilliseconds,
    scheduleGeneration,
    scheduledStartMilliseconds,
    'different-retry-seed',
  );
  const duplicateDraft = (await draftRef.get()).data();

  assert.equal(duplicate, 'already-finalized');
  assert.deepEqual(duplicateDraft.roundOneOrder, firstDraft.roundOneOrder);
  assert.equal(duplicateDraft.orderEpoch, firstDraft.orderEpoch);

  const stale = await finalizeScheduledDraftMembership(
    leagueId,
    scheduledStartMilliseconds,
    scheduleGeneration - 1,
    scheduledStartMilliseconds,
    'stale-seed',
  );
  assert.equal(stale, 'stale');

  const cancellationSubmissionId = `settings_${randomUUID().replaceAll('-', '')}`;
  await cancelDraftSchedule(leagueId, owners[0], {
    submissionId: cancellationSubmissionId,
    expectedSettingsSubmissionId: null,
  }, true);
  const reopenedDraft = (await draftRef.get()).data();
  assert.equal(reopenedDraft.membershipLockStatus, 'open');
  assert.equal(reopenedDraft.scheduleGeneration, scheduleGeneration + 1);
  assert.deepEqual(reopenedDraft.roundOneOrder, firstDraft.roundOneOrder);
  assert.equal(reopenedDraft.orderParticipantHash, firstDraft.orderParticipantHash);

  const replacementSubmissionId = `settings_${randomUUID().replaceAll('-', '')}`;
  const replacementStartMilliseconds = Date.now() + 3 * 60 * 60 * 1000;
  await saveDraftSettings(leagueId, owners[0], {
    submissionId: replacementSubmissionId,
    expectedSettingsSubmissionId: cancellationSubmissionId,
    roundOneOrder: firstDraft.roundOneOrder,
    orderMode: 'custom',
    scheduledStartAt: new Date(replacementStartMilliseconds).toISOString(),
    pickSeconds: 60,
  });
  const replacementDraft = (await draftRef.get()).data();
  const replacementGeneration = replacementDraft.scheduleGeneration;
  assert.equal(replacementGeneration, scheduleGeneration + 2);

  const replacementResult = await finalizeScheduledDraftMembership(
    leagueId,
    replacementStartMilliseconds,
    replacementGeneration,
    replacementStartMilliseconds - DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS,
    'a-new-seed-must-not-reroll-unchanged-participants',
  );
  const refinalizedDraft = (await draftRef.get()).data();
  assert.equal(replacementResult, 'finalized');
  assert.deepEqual(refinalizedDraft.roundOneOrder, firstDraft.roundOneOrder);
  assert.equal(refinalizedDraft.orderEpoch, firstDraft.orderEpoch);
  assert.equal(
    refinalizedDraft.orderRandomizationSeedHash,
    firstDraft.orderRandomizationSeedHash,
  );
});

test('readiness writes reject an old generation even when a schedule reuses the same timestamp', async () => {
  const leagueId = `generation-${randomUUID()}`;
  const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
  const scheduledStartMilliseconds = Date.now() + 60 * 60 * 1000;
  await draftRef.set({
    status: 'scheduled',
    scheduledStartAt: Timestamp.fromMillis(scheduledStartMilliseconds),
    scheduleGeneration: 9,
  });

  assert.equal(await updateScheduledDraftReadinessDocument(
    draftRef,
    scheduledStartMilliseconds,
    { serverDraftReadinessStatus: 'ready' },
    8,
  ), false);
  assert.equal(await updateScheduledDraftReadinessDocument(
    draftRef,
    scheduledStartMilliseconds,
    { serverDraftReadinessStatus: 'ready' },
    9,
  ), true);

  const draft = (await draftRef.get()).data();
  assert.equal(draft.serverDraftReadinessStatus, 'ready');
  assert.equal(draft.serverDraftReadinessScheduleGeneration, 9);
});

test('legacy readiness writes remain compatible when schedule generation is absent', async () => {
  const leagueId = `legacy-readiness-${randomUUID()}`;
  const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
  const scheduledStartMilliseconds = Date.now() + 60 * 60 * 1000;

  await draftRef.set({
    status: 'scheduled',
    scheduledStartAt: Timestamp.fromMillis(scheduledStartMilliseconds),
    roundOneOrder: ['owner-a', 'owner-b'],
  });

  const updated = await updateScheduledDraftReadinessDocument(
    draftRef,
    scheduledStartMilliseconds,
    { serverDraftReadinessStatus: 'ready' },
  );
  const draft = (await draftRef.get()).data();

  assert.equal(updated, true);
  assert.equal(draft.serverDraftReadinessStatus, 'ready');
  assert.equal(draft.serverDraftReadinessScheduleGeneration, undefined);
});

test('cutoff finalization wins against concurrent join and capacity mutations', async () => {
  const leagueId = `cutoff-race-${randomUUID()}`;
  const commissionerId = `owner-${randomUUID()}`;
  const memberId = `owner-${randomUUID()}`;
  const lateJoinerId = `owner-${randomUUID()}`;
  const inviteCode = `J${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  const scheduledStartMilliseconds = Date.now() +
    DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS - 1_000;
  const cutoffMilliseconds =
    scheduledStartMilliseconds - DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS;
  const scheduleGeneration = 12;
  const batch = db.batch();

  batch.set(db.doc(`leagues/${leagueId}`), {
    id: leagueId,
    commissionerId,
    inviteCode,
    maxTeams: 3,
    teamCount: 2,
    joinStatus: 'open',
  });
  batch.set(db.doc(`leagueInvites/${inviteCode}`), {
    leagueId,
    inviteCode,
    active: true,
    joinCount: 2,
    expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
  });
  for (const ownerId of [commissionerId, memberId]) {
    batch.set(db.doc(`leagues/${leagueId}/members/${ownerId}`), {
      uid: ownerId,
      leagueId,
      role: ownerId === commissionerId ? 'commissioner' : 'member',
    });
    batch.set(db.doc(`leagues/${leagueId}/teams/${ownerId}`), {
      id: ownerId,
      ownerId,
    });
  }
  batch.set(db.doc(`leagues/${leagueId}/draft/current`), {
    schemaVersion: 3,
    status: 'scheduled',
    format: 'snake',
    totalRounds: 17,
    rosterRequirements: { LW: 3, C: 3, RW: 3, D: 4, G: 1 },
    benchSlots: 3,
    roundOneOrder: [commissionerId, memberId],
    orderMode: 'randomized',
    orderEpoch: 0,
    scheduleGeneration,
    membershipLockStatus: 'open',
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt: Timestamp.fromMillis(scheduledStartMilliseconds),
    pickSeconds: 60,
    clockStatus: 'stopped',
    pickStartedAt: null,
    currentPickSeconds: 60,
    pausedRemainingSeconds: null,
  });
  await batch.commit();

  const [joinOutcome, capacityOutcome, finalizationOutcome] = await Promise.allSettled([
    joinLeagueSecure.run({
      auth: {
        uid: lateJoinerId,
        token: {
          email: 'late-joiner@example.test',
          email_verified: true,
        },
      },
      data: {
        requestId: `join_${randomUUID().replaceAll('-', '')}`,
        inviteCode,
        username: 'Late Joiner',
        profileIconId: 'emerald-visor',
      },
    }),
    executePreDraftLeagueCapacityUpdate({
      commissionerId,
      nowMilliseconds: cutoffMilliseconds,
      request: {
        requestId: `capacity-${randomUUID()}`,
        leagueId,
        maxTeams: 4,
        expectedMaxTeams: 3,
        expectedTeamCount: 2,
      },
    }),
    finalizeScheduledDraftMembership(
      leagueId,
      scheduledStartMilliseconds,
      scheduleGeneration,
      cutoffMilliseconds,
      'cutoff-race-seed',
    ),
  ]);

  assert.equal(joinOutcome.status, 'rejected');
  assert.equal(capacityOutcome.status, 'rejected');
  assert.equal(finalizationOutcome.status, 'fulfilled');
  assert.equal(finalizationOutcome.value, 'finalized');

  const draft = (await db.doc(`leagues/${leagueId}/draft/current`).get()).data();
  const league = (await db.doc(`leagues/${leagueId}`).get()).data();
  assert.equal((await db.doc(`leagues/${leagueId}/members/${lateJoinerId}`).get()).exists, false);
  assert.equal((await db.doc(`leagues/${leagueId}/teams/${lateJoinerId}`).get()).exists, false);
  assert.equal(league.maxTeams, 3);
  assert.equal(league.teamCount, 2);
  assert.deepEqual([...draft.roundOneOrder].sort(), [commissionerId, memberId].sort());
  assert.equal(new Set(draft.roundOneOrder).size, 2);
});

test('ordinary commissioner can schedule and cancel while stale tabs fail closed', async () => {
  const leagueId = `commissioner-${randomUUID()}`;
  const commissionerId = `owner-${randomUUID()}`;
  const memberId = `owner-${randomUUID()}`;
  const inviteCode = `C${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  const scheduledStartMilliseconds = Date.now() + 2 * 60 * 60 * 1000;
  const batch = db.batch();
  batch.set(db.doc(`leagues/${leagueId}`), {
    id: leagueId,
    commissionerId,
    inviteCode,
    maxTeams: 4,
    teamCount: 2,
    joinStatus: 'open',
  });
  batch.set(db.doc(`leagueInvites/${inviteCode}`), {
    leagueId,
    inviteCode,
    active: true,
    joinCount: 2,
    expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
  });
  for (const ownerId of [commissionerId, memberId]) {
    batch.set(db.doc(`leagues/${leagueId}/members/${ownerId}`), {
      uid: ownerId,
      leagueId,
      role: ownerId === commissionerId ? 'commissioner' : 'member',
    });
    batch.set(db.doc(`leagues/${leagueId}/teams/${ownerId}`), { id: ownerId, ownerId });
  }
  await batch.commit();

  const firstSubmissionId = `settings_${randomUUID().replaceAll('-', '')}`;
  await saveDraftSettings(leagueId, commissionerId, {
    submissionId: firstSubmissionId,
    expectedSettingsSubmissionId: null,
    roundOneOrder: [commissionerId, memberId],
    orderMode: 'custom',
    scheduledStartAt: new Date(scheduledStartMilliseconds).toISOString(),
    pickSeconds: 60,
  });

  const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
  const savedDraft = (await draftRef.get()).data();
  const savedLeague = (await db.doc(`leagues/${leagueId}`).get()).data();
  const savedInvite = (await db.doc(`leagueInvites/${inviteCode}`).get()).data();
  assert.equal(savedDraft.membershipLockStatus, 'open');
  assert.equal(savedDraft.scheduleGeneration, 1);
  assert.equal(savedLeague.joinStatus, 'open');
  assert.equal(savedInvite.active, true);

  for (const unauthorizedUserId of [memberId, 'owner-outsider', 'platform-admin-user']) {
    await assert.rejects(
      saveDraftSettings(leagueId, unauthorizedUserId, {
        submissionId: `settings_${randomUUID().replaceAll('-', '')}`,
        expectedSettingsSubmissionId: firstSubmissionId,
        roundOneOrder: [commissionerId, memberId],
        orderMode: 'custom',
        scheduledStartAt: new Date(scheduledStartMilliseconds).toISOString(),
        pickSeconds: 90,
      }),
      (error) => error?.code === 'permission-denied',
    );
  }

  const cutoffMilliseconds =
    scheduledStartMilliseconds - DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS;
  await assert.rejects(
    saveDraftSettings(leagueId, commissionerId, {
      submissionId: `settings_${randomUUID().replaceAll('-', '')}`,
      expectedSettingsSubmissionId: firstSubmissionId,
      roundOneOrder: [memberId, commissionerId],
      orderMode: 'custom',
      scheduledStartAt: new Date(scheduledStartMilliseconds).toISOString(),
      pickSeconds: 60,
    }, cutoffMilliseconds),
    (error) => error?.code === 'failed-precondition' &&
      error?.details?.reason === 'draft-membership-finalized',
  );
  assert.deepEqual((await draftRef.get()).data().roundOneOrder, [commissionerId, memberId]);

  await assert.rejects(
    saveDraftSettings(leagueId, commissionerId, {
      submissionId: `settings_${randomUUID().replaceAll('-', '')}`,
      expectedSettingsSubmissionId: firstSubmissionId,
      roundOneOrder: [commissionerId, memberId],
      orderMode: 'custom',
      scheduledStartAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      pickSeconds: 60,
    }),
    (error) => error?.code === 'failed-precondition',
  );
  assert.equal((await draftRef.get()).data().lastSettingsSubmissionId, firstSubmissionId);

  await assert.rejects(
    saveDraftSettings(leagueId, commissionerId, {
      submissionId: `settings_${randomUUID().replaceAll('-', '')}`,
      expectedSettingsSubmissionId: null,
      roundOneOrder: [memberId, commissionerId],
      orderMode: 'custom',
      scheduledStartAt: new Date(scheduledStartMilliseconds + 60 * 60 * 1000).toISOString(),
      pickSeconds: 60,
    }),
    (error) => error?.code === 'aborted',
  );

  const cancellationSubmissionId = `settings_${randomUUID().replaceAll('-', '')}`;
  await assert.rejects(
    cancelDraftSchedule(leagueId, commissionerId, {
      submissionId: `settings_${randomUUID().replaceAll('-', '')}`,
      expectedSettingsSubmissionId: firstSubmissionId,
    }, false, cutoffMilliseconds),
    (error) => error?.code === 'failed-precondition' &&
      error?.details?.reason === 'draft-membership-finalized',
  );
  await cancelDraftSchedule(leagueId, commissionerId, {
    submissionId: cancellationSubmissionId,
    expectedSettingsSubmissionId: firstSubmissionId,
  }, false);
  const canceledDraft = (await draftRef.get()).data();
  assert.equal(canceledDraft.status, 'setup');
  assert.equal(canceledDraft.scheduledStartAt, null);
  assert.equal(canceledDraft.membershipLockStatus, 'open');
  assert.equal(canceledDraft.scheduleGeneration, 2);
  assert.deepEqual(canceledDraft.roundOneOrder, [commissionerId, memberId]);

  assert.equal(await finalizeScheduledDraftMembership(
    leagueId,
    scheduledStartMilliseconds,
    1,
    scheduledStartMilliseconds,
    'canceled-schedule-seed',
  ), 'stale');
  assert.equal(getScheduledDraftStartTaskState({
    draftStatus: canceledDraft.status,
    expectedScheduledStartMilliseconds: scheduledStartMilliseconds,
    actualScheduledStartMilliseconds: null,
    expectedScheduleGeneration: 1,
    actualScheduleGeneration: canceledDraft.scheduleGeneration,
    nowMilliseconds: scheduledStartMilliseconds,
  }), 'stale');
});

test('settings authority leaves active and completed Drafts byte-for-byte unchanged', async () => {
  for (const status of ['live', 'complete']) {
    const leagueId = `${status}-${randomUUID()}`;
    const commissionerId = `owner-${randomUUID()}`;
    const memberId = `owner-${randomUUID()}`;
    const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
    const batch = db.batch();
    batch.set(db.doc(`leagues/${leagueId}`), {
      id: leagueId,
      commissionerId,
      maxTeams: 2,
      teamCount: 2,
      joinStatus: 'locked',
    });
    for (const ownerId of [commissionerId, memberId]) {
      batch.set(db.doc(`leagues/${leagueId}/teams/${ownerId}`), { id: ownerId, ownerId });
    }
    batch.set(draftRef, {
      status,
      membershipLockStatus: 'locked',
      roundOneOrder: [commissionerId, memberId],
      nextOverallPick: status === 'live' ? 2 : 35,
      draftedAssetKeys: ['skater:8478402'],
      scheduleGeneration: 3,
      lastSettingsSubmissionId: 'settings_existing',
      pickSeconds: 60,
      clockStatus: status === 'live' ? 'running' : 'stopped',
    });
    await batch.commit();
    const before = (await draftRef.get()).data();

    await assert.rejects(
      saveDraftSettings(leagueId, commissionerId, {
        submissionId: `settings_${randomUUID().replaceAll('-', '')}`,
        expectedSettingsSubmissionId: 'settings_existing',
        roundOneOrder: [commissionerId, memberId],
        orderMode: 'custom',
        scheduledStartAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        pickSeconds: 60,
      }),
      (error) => error?.code === 'failed-precondition',
    );

    assert.deepEqual((await draftRef.get()).data(), before);
  }
});
