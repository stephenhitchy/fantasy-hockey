import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const stagingProjectId = 'rinkrat-staging-d1nc-2026';
process.env.GCLOUD_PROJECT = stagingProjectId;

const { FieldValue } = requireFunctions('firebase-admin/firestore');
const { db } = requireFunctions('./lib/shared/core/firebase.js');
const {
  processD1nLoadProbeIfPresent,
} = requireFunctions('./lib/d1n-load-probe.service.js');

const fixtureMarker = 'rinkrat-d1n-c-load-fixture-v1';
const revision = 'a'.repeat(40);
const nonce = 'b'.repeat(48);
const runId = `d1nc-${'c'.repeat(20)}-100`;
const operationId = 'd'.repeat(32);
const scheduledAtMilliseconds = Date.now() - 100;
const runRef = db.doc(`d1nLoadRuns/${runId}`);

test('normal worker payloads bypass the synthetic branch', async () => {
  assert.equal(await processD1nLoadProbeIfPresent({ leagueId: 'normal-league' }, 'scoring'), false);
});

test('malformed synthetic document identities fail before any probe write', async () => {
  await assert.rejects(
    processD1nLoadProbeIfPresent({
      d1nLoadProbe: {
        schemaVersion: 1,
        projectId: stagingProjectId,
        fixtureMarker,
        runId: '../outside',
        operationId,
        kind: 'scoring',
        sourceRevision: revision,
        nonce,
        scheduledAtMilliseconds,
      },
    }, 'scoring'),
    /run identity is invalid/,
  );
  assert.equal((await db.collection('d1nLoadRuns').limit(1).get()).empty, true);
});

test('missing synthetic run authority cannot create retry evidence', async () => {
  const missingRunId = `d1nc-${'f'.repeat(20)}-100`;
  const missingOperationId = 'a'.repeat(32);
  await assert.rejects(
    processD1nLoadProbeIfPresent({
      d1nLoadProbe: {
        schemaVersion: 1,
        projectId: stagingProjectId,
        fixtureMarker,
        runId: missingRunId,
        operationId: missingOperationId,
        kind: 'scoring',
        sourceRevision: revision,
        nonce,
        scheduledAtMilliseconds,
      },
    }, 'scoring'),
    /run authority is missing/,
  );
  assert.equal((await db.doc(`d1nLoadRuns/${missingRunId}`).get()).exists, false);
  assert.equal(
    (await db.doc(`d1nLoadRuns/${missingRunId}/operations/${missingOperationId}`).get()).exists,
    false,
  );
});

test('concurrent duplicate delivery produces one result and bounded duplicate evidence', async () => {
  await runRef.create({
    schemaVersion: 1,
    fixtureMarker,
    projectId: stagingProjectId,
    sourceRevision: revision,
    nonceHash: requireFunctions('node:crypto').createHash('sha256').update(nonce).digest('hex'),
    shardCount: 16,
    stage: 100,
    status: 'running',
    createdAt: FieldValue.serverTimestamp(),
  });
  await runRef.collection('operations').doc(operationId).create({
    schemaVersion: 1,
    fixtureMarker,
    runId,
    operationId,
    sourceRevision: revision,
    kind: 'scoring',
    shardOrdinal: 0,
    scheduledAtMilliseconds,
    ownedGamePoints: [1, 0, 2, 3, 4, 5],
    status: 'queued',
    deliveryCount: 0,
    duplicateDeliveryCount: 0,
  });
  const envelope = {
    d1nLoadProbe: {
      schemaVersion: 1,
      projectId: stagingProjectId,
      fixtureMarker,
      runId,
      operationId,
      kind: 'scoring',
      sourceRevision: revision,
      nonce,
      scheduledAtMilliseconds,
    },
  };

  assert.deepEqual(await Promise.all([
    processD1nLoadProbeIfPresent(envelope, 'scoring'),
    processD1nLoadProbeIfPresent(envelope, 'scoring'),
  ]), [true, true]);

  const [operationSnapshot, resultsSnapshot, shardSnapshot] = await Promise.all([
    runRef.collection('operations').doc(operationId).get(),
    runRef.collection('results').get(),
    runRef.collection('shards').doc('scoring-00').get(),
  ]);
  assert.equal(resultsSnapshot.size, 1);
  assert.equal(resultsSnapshot.docs[0].data().scoring.ownedGameCount, 6);
  assert.equal(resultsSnapshot.docs[0].data().scoring.zeroPointGameCount, 1);
  assert.equal(operationSnapshot.data().status, 'completed');
  assert.equal(operationSnapshot.data().deliveryCount, 2);
  assert.equal(operationSnapshot.data().duplicateDeliveryCount, 1);
  assert.equal(shardSnapshot.data().completedCount, 1);
  assert.equal(shardSnapshot.data().duplicateDeliveryCount, 1);
});

test('late delivery for a terminal synthetic run is acknowledged without mutation or retry', async () => {
  const lateOperationId = '9'.repeat(32);
  await runRef.collection('operations').doc(lateOperationId).create({
    schemaVersion: 1,
    fixtureMarker,
    runId,
    operationId: lateOperationId,
    sourceRevision: revision,
    kind: 'scoring',
    shardOrdinal: 1,
    scheduledAtMilliseconds,
    ownedGamePoints: [1, 0, 2, 3, 4, 5],
    status: 'queued',
    deliveryCount: 0,
    duplicateDeliveryCount: 0,
  });
  await runRef.update({ status: 'enqueue-error' });
  assert.equal(await processD1nLoadProbeIfPresent({
    d1nLoadProbe: {
      schemaVersion: 1,
      projectId: stagingProjectId,
      fixtureMarker,
      runId,
      operationId: lateOperationId,
      kind: 'scoring',
      sourceRevision: revision,
      nonce,
      scheduledAtMilliseconds,
    },
  }, 'scoring'), true);
  const [operationSnapshot, resultSnapshot] = await Promise.all([
    runRef.collection('operations').doc(lateOperationId).get(),
    runRef.collection('results').doc(lateOperationId).get(),
  ]);
  assert.equal(operationSnapshot.data().status, 'queued');
  assert.equal(operationSnapshot.data().deliveryCount, 0);
  assert.equal(resultSnapshot.exists, false);
});

test('the same probe payload is disabled under a Production runtime identity before any write', async () => {
  process.env.GCLOUD_PROJECT = 'nhl-fantasy-app-ab673';
  try {
    await assert.rejects(
      processD1nLoadProbeIfPresent({
        d1nLoadProbe: {
          schemaVersion: 1,
          projectId: stagingProjectId,
          fixtureMarker,
          runId,
          operationId: 'e'.repeat(32),
          kind: 'scoring',
          sourceRevision: revision,
          nonce,
          scheduledAtMilliseconds,
        },
      }, 'scoring'),
      /disabled outside/,
    );
    assert.equal((await runRef.collection('operations').doc('e'.repeat(32)).get()).exists, false);
  } finally {
    process.env.GCLOUD_PROJECT = stagingProjectId;
    await db.recursiveDelete(runRef);
  }
});
