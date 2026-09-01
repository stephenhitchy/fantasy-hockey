import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test, { after, before, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  getPreDraftMemberRemovalBlockReason,
} from '../../functions/src/league-lifecycle-authority.util.ts';
import {
  buildAuditLeagueActivity,
} from '../../functions/src/shared/core/league/league-activity.util.ts';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const require = createRequire(import.meta.url);
const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);
const TEST_PROJECT_ID = 'demo-rinkrat-l1a';
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;

process.env.GCLOUD_PROJECT = TEST_PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = TEST_PROJECT_ID;

const {
  executePreDraftLeagueMemberRemoval,
} = require(`${ROOT_PATH}functions/lib/league-lifecycle-authority.js`);
const { deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
const {
  getFirestore,
  Timestamp,
} = requireFunctions('firebase-admin/firestore');

let adminApp;
let firestore;

function emptyRoster() {
  return {
    schemaVersion: 2,
    activeSlots: [{
      slotId: 'C-1',
      position: 'C',
      slotNumber: 1,
      asset: null,
      pendingMove: null,
      openFromCycleNumber: null,
    }],
    benchSlots: [{ slotId: 'B-1', slotNumber: 1, asset: null }],
    irSlots: [{ slotId: 'IR-1', slotNumber: 1, asset: null }],
  };
}

function team(ownerId, teamName, overrides = {}) {
  return {
    schemaVersion: 1,
    id: ownerId,
    ownerId,
    teamName,
    managerName: `${teamName} Manager`,
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    ...overrides,
  };
}

function member(uid, role = 'member') {
  return {
    schemaVersion: 1,
    uid,
    leagueId: '',
    username: `${uid} Manager`,
    role,
    authority: 'cloud-function',
  };
}

async function resetFirestoreEmulator() {
  assert.ok(
    FIRESTORE_EMULATOR_HOST,
    'The L1A suite must run only inside the Firestore emulator.',
  );

  const response = await fetch(
    `http://${FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${TEST_PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );

  assert.equal(response.ok, true, await response.text());
}

async function seedLeague(overrides = {}) {
  const leagueId = overrides.leagueId ?? `league-${randomUUID()}`;
  const commissionerId = overrides.commissionerId ?? `commissioner-${randomUUID()}`;
  const targetOwnerId = overrides.targetOwnerId ?? `member-${randomUUID()}`;
  const targetTeamName = overrides.targetTeamName ?? 'Remove Me Rats';
  const inviteCode = overrides.inviteCode ?? 'L1ATEST';
  const batch = firestore.batch();

  batch.set(firestore.doc(`leagues/${leagueId}`), {
    id: leagueId,
    name: 'L1A Test League',
    commissionerId,
    inviteCode,
    maxTeams: 2,
    teamCount: 2,
    joinStatus: 'full',
    ...overrides.league,
  });
  batch.set(firestore.doc(`leagueInvites/${inviteCode}`), {
    schemaVersion: 1,
    inviteCode,
    leagueId,
    active: false,
    joinCount: 2,
    expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000),
  });
  batch.set(
    firestore.doc(`leagues/${leagueId}/members/${commissionerId}`),
    { ...member(commissionerId, 'commissioner'), leagueId },
  );
  batch.set(
    firestore.doc(`leagues/${leagueId}/members/${targetOwnerId}`),
    { ...member(targetOwnerId), leagueId },
  );
  batch.set(
    firestore.doc(`leagues/${leagueId}/teams/${commissionerId}`),
    team(commissionerId, 'Commissioner Rats'),
  );
  batch.set(
    firestore.doc(`leagues/${leagueId}/teams/${targetOwnerId}`),
    team(targetOwnerId, targetTeamName, overrides.targetTeam),
  );
  batch.set(
    firestore.doc(`leagues/${leagueId}/teams/${commissionerId}/roster/current`),
    emptyRoster(),
  );
  batch.set(
    firestore.doc(`leagues/${leagueId}/teams/${targetOwnerId}/roster/current`),
    overrides.targetRoster ?? emptyRoster(),
  );
  batch.set(
    firestore.doc(`leagues/${leagueId}/draft/current/queues/${targetOwnerId}`),
    { ownerId: targetOwnerId, assetKeys: [] },
  );
  batch.set(firestore.doc(`leagueLifecycleState/${targetOwnerId}`), {
    schemaVersion: 1,
    activeLeagueCount: 1,
  });

  if (overrides.draft) {
    batch.set(firestore.doc(`leagues/${leagueId}/draft/current`), overrides.draft);
  }

  await batch.commit();

  return {
    leagueId,
    commissionerId,
    targetOwnerId,
    targetTeamName,
    inviteCode,
  };
}

function removalRequest(fixture, requestId = `remove-${randomUUID()}`) {
  return {
    requestId,
    leagueId: fixture.leagueId,
    targetOwnerId: fixture.targetOwnerId,
    confirmationTeamName: fixture.targetTeamName,
  };
}

async function assertHttpsError(promise, code, reason) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    if (reason) {
      assert.equal(error?.details?.reason, reason);
    }
    return true;
  });
}

before(async () => {
  assert.equal(
    process.env.GCLOUD_PROJECT,
    TEST_PROJECT_ID,
    'The authority must be pinned to the demo emulator project.',
  );
  adminApp = initializeApp({ projectId: TEST_PROJECT_ID }, `l1a-${randomUUID()}`);
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

test('pre-Draft guard fails closed for every protected history boundary', () => {
  const baseline = {
    leagueJoinStatus: 'open',
    draftData: null,
    cycleDocumentCount: 0,
    draftPickDocumentCount: 0,
    transactionDocumentCount: 0,
    waiverDocumentCount: 0,
    teamData: team('member', 'Safe Team'),
    rosterData: emptyRoster(),
  };

  assert.equal(getPreDraftMemberRemovalBlockReason(baseline), null);
  assert.equal(getPreDraftMemberRemovalBlockReason({
    ...baseline,
    leagueJoinStatus: 'locked',
  }), 'membership-locked');
  assert.equal(getPreDraftMemberRemovalBlockReason({
    ...baseline,
    leagueJoinStatus: undefined,
  }), 'membership-state-unsafe');
  assert.equal(getPreDraftMemberRemovalBlockReason({
    ...baseline,
    draftData: { status: 'scheduled' },
  }), 'draft-locked');
  assert.equal(getPreDraftMemberRemovalBlockReason({
    ...baseline,
    cycleDocumentCount: 1,
  }), 'competition-started');
  assert.equal(getPreDraftMemberRemovalBlockReason({
    ...baseline,
    draftPickDocumentCount: 1,
  }), 'draft-picks-exist');
  assert.equal(getPreDraftMemberRemovalBlockReason({
    ...baseline,
    transactionDocumentCount: 1,
  }), 'transactions-exist');
  assert.equal(getPreDraftMemberRemovalBlockReason({
    ...baseline,
    waiverDocumentCount: 1,
  }), 'waivers-exist');
  assert.equal(getPreDraftMemberRemovalBlockReason({
    ...baseline,
    teamData: team('member', 'History Team', { pointsFor: 0.01 }),
  }), 'team-history-exists');
  assert.equal(getPreDraftMemberRemovalBlockReason({
    ...baseline,
    teamData: { ownerId: 'member', teamName: 'Malformed Team' },
  }), 'team-history-exists');
  assert.equal(getPreDraftMemberRemovalBlockReason({
    ...baseline,
    rosterData: { activeSlots: [], benchSlots: [] },
  }), 'roster-state-unsafe');
  assert.equal(getPreDraftMemberRemovalBlockReason({
    ...baseline,
    rosterData: {
      ...emptyRoster(),
      benchSlots: [{ slotId: 'B-1', asset: { assetKey: 'skater-7' } }],
    },
  }), 'roster-state-unsafe');
});

test('concurrent duplicate delivery removes once and decrements lifecycle once', async () => {
  const fixture = await seedLeague();
  const request = removalRequest(fixture);

  const results = await Promise.all([
    executePreDraftLeagueMemberRemoval({
      commissionerId: fixture.commissionerId,
      request,
    }),
    executePreDraftLeagueMemberRemoval({
      commissionerId: fixture.commissionerId,
      request,
    }),
  ]);

  assert.deepEqual(
    results.map((result) => result.idempotentReplay).sort(),
    [false, true],
  );
  assert.ok(results.every((result) => result.removed === true));
  assert.ok(results.every((result) => result.teamCount === 1));
  assert.ok(results.every((result) => result.joinStatus === 'open'));
  assert.equal(results[0].auditId, results[1].auditId);

  const [
    league,
    invite,
    lifecycle,
    memberSnapshot,
    teamSnapshot,
    rosterSnapshot,
    queueSnapshot,
    auditSnapshot,
  ] = await Promise.all([
    firestore.doc(`leagues/${fixture.leagueId}`).get(),
    firestore.doc(`leagueInvites/${fixture.inviteCode}`).get(),
    firestore.doc(`leagueLifecycleState/${fixture.targetOwnerId}`).get(),
    firestore.doc(`leagues/${fixture.leagueId}/members/${fixture.targetOwnerId}`).get(),
    firestore.doc(`leagues/${fixture.leagueId}/teams/${fixture.targetOwnerId}`).get(),
    firestore.doc(`leagues/${fixture.leagueId}/teams/${fixture.targetOwnerId}/roster/current`).get(),
    firestore.doc(`leagues/${fixture.leagueId}/draft/current/queues/${fixture.targetOwnerId}`).get(),
    firestore.doc(`leagues/${fixture.leagueId}/audit/${results[0].auditId}`).get(),
  ]);

  assert.deepEqual(
    { teamCount: league.get('teamCount'), joinStatus: league.get('joinStatus') },
    { teamCount: 1, joinStatus: 'open' },
  );
  assert.deepEqual(
    { active: invite.get('active'), joinCount: invite.get('joinCount') },
    { active: true, joinCount: 1 },
  );
  assert.equal(lifecycle.get('activeLeagueCount'), 0);
  assert.equal(memberSnapshot.exists, false);
  assert.equal(teamSnapshot.exists, false);
  assert.equal(rosterSnapshot.exists, false);
  assert.equal(queueSnapshot.exists, false);
  assert.equal(auditSnapshot.get('action'), 'member-removed');
  assert.equal(auditSnapshot.get('values.targetOwnerId'), fixture.targetOwnerId);
  assert.equal(auditSnapshot.get('values.removedTeamName'), fixture.targetTeamName);
});

test('a completed request replays without another lifecycle decrement', async () => {
  const fixture = await seedLeague();
  const request = removalRequest(fixture);

  const first = await executePreDraftLeagueMemberRemoval({
    commissionerId: fixture.commissionerId,
    request,
  });
  const replay = await executePreDraftLeagueMemberRemoval({
    commissionerId: fixture.commissionerId,
    request,
  });

  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(
    { ...replay, idempotentReplay: false },
    first,
  );
  assert.equal(
    (await firestore.doc(`leagueLifecycleState/${fixture.targetOwnerId}`).get())
      .get('activeLeagueCount'),
    0,
  );
});

test('a request identifier cannot be reused for a different payload', async () => {
  const fixture = await seedLeague();
  const request = removalRequest(fixture);

  await executePreDraftLeagueMemberRemoval({
    commissionerId: fixture.commissionerId,
    request,
  });

  await assertHttpsError(
    executePreDraftLeagueMemberRemoval({
      commissionerId: fixture.commissionerId,
      request: {
        ...request,
        confirmationTeamName: 'Different Team',
      },
    }),
    'already-exists',
  );
});

test('saved Draft setup blocks removal without partial deletion', async () => {
  const fixture = await seedLeague({
    draft: {
      status: 'setup',
      roundOneOrder: ['commissioner', 'member'],
      nextOverallPick: 1,
    },
  });

  await assertHttpsError(
    executePreDraftLeagueMemberRemoval({
      commissionerId: fixture.commissionerId,
      request: removalRequest(fixture),
    }),
    'failed-precondition',
    'draft-locked',
  );

  const [memberSnapshot, teamSnapshot, rosterSnapshot, lifecycleSnapshot, audits] =
    await Promise.all([
      firestore.doc(`leagues/${fixture.leagueId}/members/${fixture.targetOwnerId}`).get(),
      firestore.doc(`leagues/${fixture.leagueId}/teams/${fixture.targetOwnerId}`).get(),
      firestore.doc(`leagues/${fixture.leagueId}/teams/${fixture.targetOwnerId}/roster/current`).get(),
      firestore.doc(`leagueLifecycleState/${fixture.targetOwnerId}`).get(),
      firestore.collection(`leagues/${fixture.leagueId}/audit`).get(),
    ]);

  assert.equal(memberSnapshot.exists, true);
  assert.equal(teamSnapshot.exists, true);
  assert.equal(rosterSnapshot.exists, true);
  assert.equal(lifecycleSnapshot.get('activeLeagueCount'), 1);
  assert.equal(audits.empty, true);
});

test('commissioner authority, self-removal, and exact confirmation fail closed', async () => {
  const fixture = await seedLeague();
  const request = removalRequest(fixture);

  await assertHttpsError(
    executePreDraftLeagueMemberRemoval({
      commissionerId: 'different-manager',
      request,
    }),
    'permission-denied',
  );
  await assertHttpsError(
    executePreDraftLeagueMemberRemoval({
      commissionerId: fixture.commissionerId,
      request: { ...request, targetOwnerId: fixture.commissionerId },
    }),
    'failed-precondition',
    'commissioner-self-removal',
  );
  await assertHttpsError(
    executePreDraftLeagueMemberRemoval({
      commissionerId: fixture.commissionerId,
      request: { ...request, confirmationTeamName: 'remove me rats' },
    }),
    'failed-precondition',
    'confirmation-mismatch',
  );
});

test('inconsistent invite, lifecycle, and membership authority block all writes', async () => {
  const missingInvite = await seedLeague();
  await firestore.doc(`leagueInvites/${missingInvite.inviteCode}`).delete();
  await assertHttpsError(
    executePreDraftLeagueMemberRemoval({
      commissionerId: missingInvite.commissionerId,
      request: removalRequest(missingInvite),
    }),
    'failed-precondition',
    'incomplete-invite-authority',
  );

  const invalidLifecycle = await seedLeague();
  await firestore.doc(`leagueLifecycleState/${invalidLifecycle.targetOwnerId}`).set({
    activeLeagueCount: 0,
  }, { merge: true });
  await assertHttpsError(
    executePreDraftLeagueMemberRemoval({
      commissionerId: invalidLifecycle.commissionerId,
      request: removalRequest(invalidLifecycle),
    }),
    'failed-precondition',
    'incomplete-lifecycle-authority',
  );

  const mismatchedMembership = await seedLeague();
  const danglingOwnerId = `dangling-${randomUUID()}`;
  await firestore
    .doc(`leagues/${mismatchedMembership.leagueId}/members/${danglingOwnerId}`)
    .set({ ...member(danglingOwnerId), leagueId: mismatchedMembership.leagueId });
  await assertHttpsError(
    executePreDraftLeagueMemberRemoval({
      commissionerId: mismatchedMembership.commissionerId,
      request: removalRequest(mismatchedMembership),
    }),
    'failed-precondition',
    'membership-authority-mismatch',
  );

  for (const fixture of [missingInvite, invalidLifecycle, mismatchedMembership]) {
    assert.equal(
      (await firestore
        .doc(`leagues/${fixture.leagueId}/members/${fixture.targetOwnerId}`)
        .get()).exists,
      true,
    );
    assert.equal(
      (await firestore.collection(`leagues/${fixture.leagueId}/audit`).get()).empty,
      true,
    );
  }
});

test('member removal audit maps to one commissioner-owned public activity', () => {
  assert.deepEqual(buildAuditLeagueActivity({
    action: 'member-removed',
    actorId: 'commissioner-1',
    values: { targetOwnerId: 'removed-member' },
  }), {
    schemaVersion: 1,
    category: 'league',
    eventType: 'member-removed',
    ownerId: 'commissioner-1',
    primaryAsset: null,
    secondaryAsset: null,
    overallPick: null,
    round: null,
    selectionType: null,
    effectiveCycleNumber: null,
    effectiveLabel: null,
  });
});

test('callable, UI, activity, and deployment contracts remain explicit', async () => {
  const [authority, index, service, component, template, activity, wire, firebaseConfig] =
    await Promise.all([
      read('functions/src/league-lifecycle-authority.ts'),
      read('functions/src/index.ts'),
      read('src/app/core/league/league.service.ts'),
      read('src/app/features/leagues/league-detail/league-detail.ts'),
      read('src/app/features/leagues/league-detail/league-detail.html'),
      read('functions/src/shared/core/league/league-activity.util.ts'),
      read('src/app/features/leagues/league-wire/league-wire.ts'),
      read('firebase.json'),
    ]);

  assert.match(authority, /requireVerifiedRecentAuthentication\(request\.auth, 'remove a league member'\)/);
  assert.match(authority, /transaction\.create\(auditRef/);
  assert.match(authority, /getPreDraftMemberRemovalBlockReason/);
  assert.match(index, /removeLeagueMemberSecure/);
  assert.match(service, /rinkrat:pending-league-member-removal:v1/);
  assert.match(service, /httpsCallable<[^>]+>[\s\S]*removeLeagueMemberSecure/);
  assert.match(component, /reauthenticateCurrentUserWithPassword/);
  assert.match(component, /competitiveActionsReady/);
  assert.match(component, /memberRemovalStatus\?\.nativeElement\.focus/);
  assert.match(template, /Type the team name exactly/);
  assert.match(template, /autocomplete="current-password"/);
  assert.match(activity, /'member-removed'/);
  assert.match(wire, /removed a manager before the Draft/);
  assert.doesNotMatch(firebaseConfig, /removeLeagueMemberSecure/);
});
