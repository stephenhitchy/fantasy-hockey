import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test, { after, before, beforeEach } from 'node:test';

import { getPreDraftLeagueCapacityBlockReason } from
  '../../functions/src/league-lifecycle-authority.util.ts';
import { getScheduledDraftCapacityReopenBlockReason } from
  '../../functions/src/league-lifecycle-authority.util.ts';
import { getScheduledDraftStartTaskState } from
  '../../functions/src/draft-readiness.util.ts';

const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const projectId = 'demo-rinkrat-l1b';
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;
const { executePreDraftLeagueCapacityUpdate } = requireFunctions('./lib/league-lifecycle-authority.js');
const { deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
const { getFirestore, Timestamp } = requireFunctions('firebase-admin/firestore');
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
let app;
let db;

async function reset() {
  assert.ok(emulatorHost, 'This suite must run only in the Firestore emulator.');
  const result = await fetch(
    `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(result.ok, true, await result.text());
}

async function seed(overrides = {}) {
  const leagueId = `capacity-${randomUUID()}`;
  const commissionerId = `commissioner-${randomUUID()}`;
  const memberId = `member-${randomUUID()}`;
  const thirdId = overrides.memberCount === 3 ? `member-${randomUUID()}` : null;
  const joinedCount = thirdId ? 3 : 2;
  const inviteCode = `C${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  const maxTeams = overrides.maxTeams ?? 2;
  const scheduledStartMilliseconds = overrides.scheduledStartMilliseconds ??
    Date.now() + 48 * 60 * 60 * 1000;
  const settingsSubmissionId = `settings-${randomUUID()}`;
  const expiresAt = Timestamp.fromMillis(
    Date.now() + (overrides.expired ? -60_000 : 86_400_000),
  );
  const batch = db.batch();
  batch.set(db.doc(`leagues/${leagueId}`), {
    id: leagueId, commissionerId, inviteCode, maxTeams, teamCount: joinedCount,
    joinStatus: overrides.scheduledDraft ? 'locked' : maxTeams === joinedCount ? 'full' : 'open',
    ...(overrides.scheduledDraft ? { joinLockedReason: 'draft-order-saved' } : {}),
    ...overrides.league,
  });
  batch.set(db.doc(`leagueInvites/${inviteCode}`), {
    leagueId, inviteCode, joinCount: joinedCount,
    active: !overrides.scheduledDraft && maxTeams > joinedCount && !overrides.expired,
    expiresAt,
    ...(overrides.scheduledDraft ? {
      lockedReason: maxTeams === joinedCount ? 'league-full' : 'draft-order-saved',
    } : {}),
    ...overrides.invite,
  });

  for (const ownerId of [commissionerId, memberId, thirdId].filter(Boolean)) {
    batch.set(db.doc(`leagues/${leagueId}/members/${ownerId}`), {
      uid: ownerId, leagueId, role: ownerId === commissionerId ? 'commissioner' : 'member',
    });
    batch.set(db.doc(`leagues/${leagueId}/teams/${ownerId}`), { id: ownerId, ownerId });
  }

  const scheduledDraft = overrides.scheduledDraft ? {
    status: 'scheduled',
    roundOneOrder: [commissionerId, memberId, thirdId].filter(Boolean),
    draftedAssetKeys: [], nextOverallPick: 1, clockStatus: 'stopped',
    pickStartedAt: null, startedAt: null, lastPickId: null,
    scheduledStartAt: Timestamp.fromMillis(scheduledStartMilliseconds),
    lastSettingsSubmissionId: settingsSubmissionId,
    projectionPreparationRequestId: 'old-request',
    serverDraftReadinessStatus: 'ready',
    serverDraftReadinessScheduledStartAt: Timestamp.fromMillis(scheduledStartMilliseconds),
    serverDraftReadinessProjectionRequestId: 'old-request',
    serverDraftReadinessProjectionSnapshotId: 'old-snapshot',
    serverDraftReadinessProjectionSnapshotHash: 'old-hash',
    ...overrides.draft,
  } : overrides.draft;

  if (scheduledDraft) {
    batch.set(db.doc(`leagues/${leagueId}/draft/current`), scheduledDraft);
  }

  await batch.commit();
  return { leagueId, commissionerId, memberId, inviteCode, maxTeams, joinedCount,
    scheduledStartMilliseconds, settingsSubmissionId };
}

function request(fixture, maxTeams, requestId = `capacity-${randomUUID()}`) {
  return {
    requestId, leagueId: fixture.leagueId, maxTeams,
    expectedMaxTeams: fixture.maxTeams, expectedTeamCount: fixture.joinedCount,
  };
}

function scheduledRequest(fixture, maxTeams, requestId) {
  return {
    ...request(fixture, maxTeams, requestId),
    reopenScheduledDraft: true,
    expectedScheduledStartMilliseconds: fixture.scheduledStartMilliseconds,
    expectedSettingsSubmissionId: fixture.settingsSubmissionId,
  };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

before(async () => {
  assert.ok(emulatorHost);
  process.env.GCLOUD_PROJECT = projectId;
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  app = initializeApp({ projectId }, `l1b-${randomUUID()}`);
  db = getFirestore(app);
  await reset();
});
beforeEach(reset);
after(async () => { if (app) await deleteApp(app); });

test('full existing league expands with the same invite and exact-once audit', async () => {
  const fixture = await seed();
  const payload = request(fixture, 4);
  const [first, duplicate] = await Promise.all([
    executePreDraftLeagueCapacityUpdate({ commissionerId: fixture.commissionerId, request: payload }),
    executePreDraftLeagueCapacityUpdate({ commissionerId: fixture.commissionerId, request: payload }),
  ]);
  assert.deepEqual([first.idempotentReplay, duplicate.idempotentReplay].sort(), [false, true]);
  assert.equal(first.auditId, duplicate.auditId);
  assert.equal(first.joinStatus, 'open');
  const league = (await db.doc(`leagues/${fixture.leagueId}`).get()).data();
  const invite = (await db.doc(`leagueInvites/${fixture.inviteCode}`).get()).data();
  const audits = await db.collection(`leagues/${fixture.leagueId}/audit`).get();
  assert.equal(league.maxTeams, 4);
  assert.equal(league.teamCount, 2);
  assert.equal(league.inviteCode, fixture.inviteCode);
  assert.equal(invite.active, true);
  assert.equal(invite.joinCount, 2);
  assert.equal(audits.size, 1);
  assert.equal((await db.collection(`leagues/${fixture.leagueId}/teams`).get()).size, 2);
});

test('shrinking to joined count closes the invite; below joined count cannot mutate', async () => {
  const fixture = await seed({ maxTeams: 4 });
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: fixture.commissionerId, request: request(fixture, 1),
  }), 'invalid-argument');
  const result = await executePreDraftLeagueCapacityUpdate({
    commissionerId: fixture.commissionerId, request: request(fixture, 2),
  });
  assert.equal(result.joinStatus, 'full');
  assert.equal((await db.doc(`leagueInvites/${fixture.inviteCode}`).get()).data().active, false);

  const threeJoined = await seed({ maxTeams: 4, memberCount: 3 });
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: threeJoined.commissionerId, request: request(threeJoined, 2),
  }), 'failed-precondition');
  assert.equal((await db.doc(`leagues/${threeJoined.leagueId}`).get()).data().maxTeams, 4);
});

test('saved Draft order, history, stale tab, and noncommissioner fail closed', async () => {
  const fixture = await seed({
    draft: { status: 'setup', roundOneOrder: ['owner'], draftedAssetKeys: [], nextOverallPick: 1 },
  });
  const payload = request(fixture, 4);
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: fixture.commissionerId, request: payload,
  }), 'failed-precondition');
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: fixture.memberId, request: payload,
  }), 'permission-denied');
  assert.equal((await db.doc(`leagues/${fixture.leagueId}`).get()).data().maxTeams, 2);
  assert.equal((await db.collection(`leagues/${fixture.leagueId}/audit`).get()).size, 0);

  const open = await seed({ maxTeams: 4 });
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: open.commissionerId,
    request: { ...request(open, 3), expectedMaxTeams: 2 },
  }), 'aborted');
  await db.doc(`leagues/${open.leagueId}/cycles/one`).set({ number: 1 });
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: open.commissionerId, request: request(open, 3),
  }), 'failed-precondition');

  const mismatched = await seed({ maxTeams: 3 });
  await db.doc(`leagues/${mismatched.leagueId}/teams/${mismatched.memberId}`)
    .update({ ownerId: 'different-owner' });
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: mismatched.commissionerId, request: request(mismatched, 4),
  }), 'failed-precondition');
  assert.equal((await db.collection(`leagues/${mismatched.leagueId}/audit`).get()).size, 0);
});

test('two competing size changes cannot both commit from the same old limit', async () => {
  const fixture = await seed();
  const outcomes = await Promise.allSettled([
    executePreDraftLeagueCapacityUpdate({
      commissionerId: fixture.commissionerId, request: request(fixture, 3),
    }),
    executePreDraftLeagueCapacityUpdate({
      commissionerId: fixture.commissionerId, request: request(fixture, 4),
    }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'aborted');
  assert.equal((await db.collection(`leagues/${fixture.leagueId}/audit`).get()).size, 1);
});

test('expired invite stays inactive and request-ID payload reuse is rejected', async () => {
  const fixture = await seed({ maxTeams: 3, expired: true, invite: { active: true } });
  const payload = request(fixture, 4);
  await executePreDraftLeagueCapacityUpdate({ commissionerId: fixture.commissionerId, request: payload });
  assert.equal((await db.doc(`leagueInvites/${fixture.inviteCode}`).get()).data().active, false);
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: fixture.commissionerId,
    request: { ...payload, maxTeams: 3 },
  }), 'already-exists');
});

test('pre-Draft guard rejects malformed or active Draft and competitive history', () => {
  const safe = {
    joinStatus: 'open', draftData: null, cycleDocumentCount: 0,
    draftPickDocumentCount: 0, transactionDocumentCount: 0, waiverDocumentCount: 0,
  };
  assert.equal(getPreDraftLeagueCapacityBlockReason(safe), null);
  assert.equal(getPreDraftLeagueCapacityBlockReason({ ...safe, joinStatus: 'locked' }), 'membership-locked');
  assert.equal(getPreDraftLeagueCapacityBlockReason({ ...safe, draftData: { status: 'scheduled' } }), 'draft-locked');
  assert.equal(getPreDraftLeagueCapacityBlockReason({ ...safe, draftData: {
    status: 'setup', roundOneOrder: [], draftedAssetKeys: [], nextOverallPick: 1,
  } }), null);
  assert.equal(getPreDraftLeagueCapacityBlockReason({ ...safe, draftPickDocumentCount: 1 }), 'draft-picks-exist');
  assert.equal(getPreDraftLeagueCapacityBlockReason({ ...safe, transactionDocumentCount: 1 }), 'transactions-exist');
  assert.equal(getPreDraftLeagueCapacityBlockReason({ ...safe, waiverDocumentCount: 1 }), 'waivers-exist');
});

test('scheduled Draft can be reopened once before T-24 without losing members or invite', async () => {
  const fixture = await seed({ scheduledDraft: true });
  const payload = scheduledRequest(fixture, 4);
  const [first, duplicate] = await Promise.all([
    executePreDraftLeagueCapacityUpdate({ commissionerId: fixture.commissionerId, request: payload }),
    executePreDraftLeagueCapacityUpdate({ commissionerId: fixture.commissionerId, request: payload }),
  ]);
  assert.deepEqual([first.idempotentReplay, duplicate.idempotentReplay].sort(), [false, true]);
  assert.equal(first.rescheduleRequired, true);
  assert.equal(first.auditId, duplicate.auditId);

  const league = (await db.doc(`leagues/${fixture.leagueId}`).get()).data();
  const invite = (await db.doc(`leagueInvites/${fixture.inviteCode}`).get()).data();
  const draft = (await db.doc(`leagues/${fixture.leagueId}/draft/current`).get()).data();
  const audits = await db.collection(`leagues/${fixture.leagueId}/audit`).get();
  assert.equal(league.maxTeams, 4);
  assert.equal(league.teamCount, 2);
  assert.equal(league.joinStatus, 'open');
  assert.equal(league.inviteCode, fixture.inviteCode);
  assert.equal(invite.active, true);
  assert.equal(invite.joinCount, 2);
  assert.equal(draft.status, 'setup');
  assert.deepEqual(draft.roundOneOrder, []);
  assert.equal(draft.scheduledStartAt, null);
  assert.equal(getScheduledDraftStartTaskState({
    draftStatus: draft.status,
    expectedScheduledStartMilliseconds: fixture.scheduledStartMilliseconds,
    actualScheduledStartMilliseconds: null,
    nowMilliseconds: fixture.scheduledStartMilliseconds,
  }), 'stale');
  assert.equal(draft.projectionPreparationRequestId, null);
  assert.equal(draft.serverDraftReadinessStatus, null);
  assert.equal(draft.serverDraftReadinessProjectionSnapshotId, null);
  assert.equal(draft.clockStatus, 'stopped');
  assert.equal(draft.nextOverallPick, 1);
  assert.deepEqual(draft.draftedAssetKeys, []);
  assert.equal((await db.collection(`leagues/${fixture.leagueId}/members`).get()).size, 2);
  assert.equal((await db.collection(`leagues/${fixture.leagueId}/teams`).get()).size, 2);
  assert.equal(audits.size, 1);
  assert.equal(audits.docs[0].data().values.rescheduleRequired, true);
});

test('scheduled Draft reopen requires explicit current schedule and remains closed at T-24', async () => {
  const fixture = await seed({ scheduledDraft: true });
  const ordinary = request(fixture, 4);
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: fixture.commissionerId, request: ordinary,
  }), 'failed-precondition');
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: fixture.commissionerId,
    request: { ...scheduledRequest(fixture, 4), expectedScheduledStartMilliseconds:
      fixture.scheduledStartMilliseconds + 60_000 },
  }), 'failed-precondition');
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: fixture.commissionerId,
    request: { ...scheduledRequest(fixture, 4), expectedSettingsSubmissionId: 'settings-other-request-12345' },
  }), 'failed-precondition');
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: fixture.commissionerId,
    request: scheduledRequest(fixture, 4),
    nowMilliseconds: fixture.scheduledStartMilliseconds - 24 * 60 * 60 * 1000,
  }), 'failed-precondition');
  assert.equal((await db.doc(`leagues/${fixture.leagueId}`).get()).data().joinStatus, 'locked');
  assert.equal((await db.doc(`leagues/${fixture.leagueId}/draft/current`).get()).data().status, 'scheduled');
  assert.equal((await db.collection(`leagues/${fixture.leagueId}/audit`).get()).size, 0);
});

test('scheduled reset accepts a previously open invite lock but rejects unrelated locks', async () => {
  const openBeforeSetup = await seed({ scheduledDraft: true, maxTeams: 4 });
  assert.equal((await db.doc(`leagueInvites/${openBeforeSetup.inviteCode}`).get())
    .data().lockedReason, 'draft-order-saved');
  const result = await executePreDraftLeagueCapacityUpdate({
    commissionerId: openBeforeSetup.commissionerId,
    request: scheduledRequest(openBeforeSetup, 3),
  });
  assert.equal(result.rescheduleRequired, true);
  assert.equal((await db.doc(`leagueInvites/${openBeforeSetup.inviteCode}`).get())
    .data().active, true);

  const unrelatedLock = await seed({
    scheduledDraft: true, invite: { lockedReason: 'manual-security-lock' },
  });
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: unrelatedLock.commissionerId,
    request: scheduledRequest(unrelatedLock, 4),
  }), 'failed-precondition');
  assert.equal((await db.doc(`leagues/${unrelatedLock.leagueId}/draft/current`).get())
    .data().status, 'scheduled');
});

test('scheduled Draft reopen fails closed for started state, history, mismatched order, and expiry', async () => {
  const started = await seed({ scheduledDraft: true, draft: { pickStartedAt: Timestamp.now() } });
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: started.commissionerId, request: scheduledRequest(started, 4),
  }), 'failed-precondition');

  const mismatched = await seed({ scheduledDraft: true, draft: { roundOneOrder: ['missing-team'] } });
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: mismatched.commissionerId, request: scheduledRequest(mismatched, 4),
  }), 'failed-precondition');

  const history = await seed({ scheduledDraft: true });
  await db.doc(`leagues/${history.leagueId}/draft/current/picks/first`).set({ overallPick: 1 });
  await rejectsWith(executePreDraftLeagueCapacityUpdate({
    commissionerId: history.commissionerId, request: scheduledRequest(history, 4),
  }), 'failed-precondition');

  const expired = await seed({ scheduledDraft: true, expired: true });
  const result = await executePreDraftLeagueCapacityUpdate({
    commissionerId: expired.commissionerId, request: scheduledRequest(expired, 4),
  });
  assert.equal(result.rescheduleRequired, true);
  assert.equal((await db.doc(`leagueInvites/${expired.inviteCode}`).get()).data().active, false);
});

test('competing scheduled-Draft size changes and old submissions do not reset twice', async () => {
  const fixture = await seed({ scheduledDraft: true });
  const outcomes = await Promise.allSettled([
    executePreDraftLeagueCapacityUpdate({
      commissionerId: fixture.commissionerId, request: scheduledRequest(fixture, 3),
    }),
    executePreDraftLeagueCapacityUpdate({
      commissionerId: fixture.commissionerId, request: scheduledRequest(fixture, 4),
    }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await db.collection(`leagues/${fixture.leagueId}/audit`).get()).size, 1);
  assert.equal((await db.doc(`leagues/${fixture.leagueId}/draft/current`).get()).data().status, 'setup');
});

test('scheduled reset guard requires stopped, exact, pre-competition Draft', () => {
  const now = Date.now();
  const safe = {
    joinStatus: 'locked', joinLockedReason: 'draft-order-saved',
    scheduledStartMilliseconds: now + 48 * 60 * 60 * 1000,
    expectedScheduledStartMilliseconds: now + 48 * 60 * 60 * 1000,
    expectedSettingsSubmissionId: 'settings-valid-request-12345', nowMilliseconds: now,
    draftData: {
      status: 'scheduled', clockStatus: 'stopped', nextOverallPick: 1,
      roundOneOrder: ['a', 'b'], draftedAssetKeys: [], pickStartedAt: null,
      lastSettingsSubmissionId: 'settings-valid-request-12345',
    },
    cycleDocumentCount: 0, draftPickDocumentCount: 0,
    transactionDocumentCount: 0, waiverDocumentCount: 0,
  };
  assert.equal(getScheduledDraftCapacityReopenBlockReason(safe), null);
  assert.equal(getScheduledDraftCapacityReopenBlockReason({ ...safe, joinStatus: 'open' }), 'membership-locked');
  assert.equal(getScheduledDraftCapacityReopenBlockReason({ ...safe, draftData: {
    ...safe.draftData, clockStatus: 'running',
  } }), 'draft-locked');
  assert.equal(getScheduledDraftCapacityReopenBlockReason({ ...safe,
    transactionDocumentCount: 1 }), 'transactions-exist');
  assert.equal(getScheduledDraftCapacityReopenBlockReason({ ...safe,
    scheduledStartMilliseconds: now + 24 * 60 * 60 * 1000,
    expectedScheduledStartMilliseconds: now + 24 * 60 * 60 * 1000,
  }), 'draft-start-too-close');
});
