import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { deleteApp, initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

import {
  assertL1aStagingConnectionSafety,
  L1A_STAGING_COMMISSIONER_EMAIL,
  L1A_STAGING_COMMISSIONER_ID,
  L1A_STAGING_LEAGUE_ID,
  L1A_STAGING_PROJECT_ID,
  L1A_STAGING_TARGET_ID,
  L1A_STAGING_TARGET_TEAM_NAME,
} from './seed-l1a-member-removal-staging-fixture.mjs';

export const L1A_STAGING_RUN_ACKNOWLEDGEMENT =
  `exercise-${L1A_STAGING_LEAGUE_ID}-in-${L1A_STAGING_PROJECT_ID}`;
export const L1A_STAGING_FIREBASE_OPTIONS = Object.freeze({
  apiKey: 'AIzaSyDejIpv-Pi1iDcuKSgDyVK_5h2s9kZ05sY',
  authDomain: 'rinkrat-staging-d1nc-2026.firebaseapp.com',
  projectId: L1A_STAGING_PROJECT_ID,
  storageBucket: 'rinkrat-staging-d1nc-2026.firebasestorage.app',
  messagingSenderId: '817415114086',
  appId: '1:817415114086:web:d8be39fcb0b05074b28ca7',
});

const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);

export function assertL1aStagingRunSafety(environment = process.env) {
  const connectionSafety = assertL1aStagingConnectionSafety(environment);

  if (environment.L1A_STAGING_RUN_ACK !== L1A_STAGING_RUN_ACKNOWLEDGEMENT) {
    throw new Error(
      'L1A_STAGING_RUN_ACK does not authorize the exact member-removal evidence run.',
    );
  }

  const timeoutMilliseconds = Number(
    environment.L1A_STAGING_TIMEOUT_MILLISECONDS ?? 120_000,
  );

  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 30_000 ||
    timeoutMilliseconds > 300_000
  ) {
    throw new Error(
      'L1A_STAGING_TIMEOUT_MILLISECONDS must be an integer from 30000 through 300000.',
    );
  }

  return { password: connectionSafety.password, timeoutMilliseconds };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getActivityDocumentId(auditId) {
  const fingerprint = createHash('sha256')
    .update(`rinkrat-league-activity:audit:${auditId}`)
    .digest('hex')
    .slice(0, 40);
  return `activity-${fingerprint}`;
}

async function waitForActivity(activityRef, timeoutMilliseconds) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMilliseconds) {
    const snapshot = await activityRef.get();

    if (snapshot.exists) {
      return snapshot;
    }

    await wait(1_000);
  }

  throw new Error('League Wire publication did not appear before the L1A timeout.');
}

async function expectCallableCode(operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error?.code, `functions/${expectedCode}`);
    return;
  }

  assert.fail(`The callable did not reject with ${expectedCode}.`);
}

async function readBoundedRemovalState(firestore, auditId, activityId) {
  const prefix = `leagues/${L1A_STAGING_LEAGUE_ID}`;
  const [
    league,
    invite,
    lifecycle,
    member,
    team,
    roster,
    queue,
    audit,
    activity,
    audits,
    activities,
  ] = await Promise.all([
    firestore.doc(prefix).get(),
    firestore.doc('leagueInvites/L1ASTG').get(),
    firestore.doc(`leagueLifecycleState/${L1A_STAGING_TARGET_ID}`).get(),
    firestore.doc(`${prefix}/members/${L1A_STAGING_TARGET_ID}`).get(),
    firestore.doc(`${prefix}/teams/${L1A_STAGING_TARGET_ID}`).get(),
    firestore.doc(`${prefix}/teams/${L1A_STAGING_TARGET_ID}/roster/current`).get(),
    firestore.doc(`${prefix}/draft/current/queues/${L1A_STAGING_TARGET_ID}`).get(),
    firestore.doc(`${prefix}/audit/${auditId}`).get(),
    firestore.doc(`${prefix}/activity/${activityId}`).get(),
    firestore.collection(`${prefix}/audit`).get(),
    firestore.collection(`${prefix}/activity`).get(),
  ]);

  assert.ok(league.exists, 'The synthetic league document is missing.');
  assert.ok(invite.exists, 'The synthetic invite document is missing.');
  assert.ok(lifecycle.exists, 'The synthetic lifecycle document is missing.');
  assert.ok(audit.exists, 'The member-removal audit document is missing.');
  assert.ok(activity.exists, 'The member-removal League Wire document is missing.');
  assert.equal(audit.get('action'), 'member-removed');
  assert.equal(audit.get('actorId'), L1A_STAGING_COMMISSIONER_ID);
  assert.equal(audit.get('values.targetOwnerId'), L1A_STAGING_TARGET_ID);
  assert.equal(audit.get('values.removedTeamName'), L1A_STAGING_TARGET_TEAM_NAME);
  assert.equal(activity.get('eventType'), 'member-removed');
  assert.equal(activity.get('sourceKind'), 'audit');
  assert.equal(activity.get('ownerId'), L1A_STAGING_COMMISSIONER_ID);

  return {
    teamCount: league.get('teamCount'),
    joinStatus: league.get('joinStatus'),
    inviteActive: invite.get('active'),
    inviteJoinCount: invite.get('joinCount'),
    activeLeagueCount: lifecycle.get('activeLeagueCount'),
    memberExists: member.exists,
    teamExists: team.exists,
    rosterExists: roster.exists,
    queueExists: queue.exists,
    auditCount: audits.size,
    activityCount: activities.size,
    auditPublished: activity.exists,
  };
}

export function buildPublicL1aEvidence(evidence) {
  return {
    projectId: L1A_STAGING_PROJECT_ID,
    leagueLabel: 'l1a-member-removal-fixture',
    requestStatus: 'completed',
    duplicateDeliveryStable: evidence.duplicateDeliveryStable === true,
    payloadReuseRejected: evidence.payloadReuseRejected === true,
    auditPublished: evidence.auditPublished === true,
    teamCount: evidence.teamCount,
    joinStatus: evidence.joinStatus,
    inviteActive: evidence.inviteActive,
    inviteJoinCount: evidence.inviteJoinCount,
    activeLeagueCount: evidence.activeLeagueCount,
    removedAuthorityDocumentCount: [
      evidence.memberExists,
      evidence.teamExists,
      evidence.rosterExists,
      evidence.queueExists,
    ].filter((exists) => exists === false).length,
    auditCount: evidence.auditCount,
    activityCount: evidence.activityCount,
  };
}

export async function runL1aStagingEvidence(environment = process.env) {
  const { password, timeoutMilliseconds } =
    assertL1aStagingRunSafety(environment);
  const {
    applicationDefault,
    deleteApp: deleteAdminApp,
    initializeApp: initializeAdminApp,
  } = requireFunctions('firebase-admin/app');
  const { getFirestore } = requireFunctions('firebase-admin/firestore');
  const adminApp = initializeAdminApp({
    credential: applicationDefault(),
    projectId: L1A_STAGING_PROJECT_ID,
  }, `l1a-staging-evidence-admin-${Date.now()}`);
  const clientApp = initializeApp(
    L1A_STAGING_FIREBASE_OPTIONS,
    `l1a-staging-evidence-client-${Date.now()}`,
  );

  try {
    assert.equal(adminApp.options.projectId, L1A_STAGING_PROJECT_ID);
    assert.equal(clientApp.options.projectId, L1A_STAGING_PROJECT_ID);
    const auth = getAuth(clientApp);
    const credential = await signInWithEmailAndPassword(
      auth,
      L1A_STAGING_COMMISSIONER_EMAIL,
      password,
    );
    assert.equal(credential.user.uid, L1A_STAGING_COMMISSIONER_ID);
    assert.equal(credential.user.emailVerified, true);

    const functions = getFunctions(clientApp, 'us-central1');
    const removeMember = httpsCallable(functions, 'removeLeagueMemberSecure', {
      timeout: 60_000,
    });
    const requestId = `l1astaging_${randomUUID().replaceAll('-', '')}`;
    const request = {
      requestId,
      leagueId: L1A_STAGING_LEAGUE_ID,
      targetOwnerId: L1A_STAGING_TARGET_ID,
      confirmationTeamName: L1A_STAGING_TARGET_TEAM_NAME,
    };
    const firstResponse = await removeMember(request);
    const first = firstResponse.data ?? {};

    assert.equal(first.removed, true);
    assert.equal(first.idempotentReplay, false);
    assert.equal(first.leagueId, L1A_STAGING_LEAGUE_ID);
    assert.equal(first.targetOwnerId, L1A_STAGING_TARGET_ID);
    assert.equal(first.removedTeamName, L1A_STAGING_TARGET_TEAM_NAME);
    assert.equal(first.teamCount, 1);
    assert.equal(first.maxTeams, 4);
    assert.equal(first.joinStatus, 'open');
    assert.match(first.auditId ?? '', /^member-removed-[a-f0-9]{32}$/);

    const firestore = getFirestore(adminApp);
    const activityId = getActivityDocumentId(first.auditId);
    await waitForActivity(
      firestore.doc(
        `leagues/${L1A_STAGING_LEAGUE_ID}/activity/${activityId}`,
      ),
      timeoutMilliseconds,
    );
    const beforeDuplicate = await readBoundedRemovalState(
      firestore,
      first.auditId,
      activityId,
    );
    assert.deepEqual(beforeDuplicate, {
      teamCount: 1,
      joinStatus: 'open',
      inviteActive: true,
      inviteJoinCount: 1,
      activeLeagueCount: 0,
      memberExists: false,
      teamExists: false,
      rosterExists: false,
      queueExists: false,
      auditCount: 1,
      activityCount: 1,
      auditPublished: true,
    });

    const replayResponse = await removeMember(request);
    const replay = replayResponse.data ?? {};
    assert.equal(replay.removed, true);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.auditId, first.auditId);
    assert.equal(replay.teamCount, first.teamCount);
    assert.equal(replay.joinStatus, first.joinStatus);

    const afterDuplicate = await readBoundedRemovalState(
      firestore,
      first.auditId,
      activityId,
    );
    assert.deepEqual(afterDuplicate, beforeDuplicate);

    await expectCallableCode(
      () => removeMember({
        ...request,
        confirmationTeamName: 'Different Synthetic Team',
      }),
      'already-exists',
    );
    const afterPayloadReuse = await readBoundedRemovalState(
      firestore,
      first.auditId,
      activityId,
    );
    assert.deepEqual(afterPayloadReuse, beforeDuplicate);

    return buildPublicL1aEvidence({
      ...afterPayloadReuse,
      duplicateDeliveryStable: true,
      payloadReuseRejected: true,
    });
  } finally {
    await signOut(getAuth(clientApp)).catch(() => undefined);
    await Promise.all([
      deleteApp(clientApp),
      deleteAdminApp(adminApp),
    ]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runL1aStagingEvidence()
    .then((result) => {
      console.log('L1A commissioner-removal staging evidence passed.');
      console.log(JSON.stringify(result, null, 2));
      console.log('No account ID, email, invite code, password, or audit ID was printed.');
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
