import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertFf1ReadinessStagingSafety,
  buildPublicFf1ReadinessEvidence,
  FF1_READINESS_STAGING_ACKNOWLEDGEMENT,
  FF1_READINESS_SCHEDULER_JOB,
  verifyFf1ReadinessStagingManifest,
} from '../../scripts/capacity/run-ff1-draft-readiness-staging-evidence.mjs';
import { D1N_STAGING_PROJECT_ID } from '../../scripts/capacity/prepare-d1n-staging-hosting.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function safeEnvironment(overrides = {}) {
  return {
    FF1_READINESS_STAGING_PROJECT_ID: D1N_STAGING_PROJECT_ID,
    FF1_READINESS_STAGING_ACK: FF1_READINESS_STAGING_ACKNOWLEDGEMENT,
    ...overrides,
  };
}

test('FF1 readiness staging safety permits only the exact project and operation', () => {
  assert.deepEqual(assertFf1ReadinessStagingSafety(safeEnvironment()), {
    timeoutMilliseconds: 600_000,
  });
  assert.throws(
    () =>
      assertFf1ReadinessStagingSafety(
        safeEnvironment({
          FF1_READINESS_STAGING_PROJECT_ID: 'nhl-fantasy-app-ab673',
        }),
      ),
    /must equal/,
  );
  assert.throws(
    () =>
      assertFf1ReadinessStagingSafety(
        safeEnvironment({
          FF1_READINESS_STAGING_ACK: 'yes',
        }),
      ),
    /does not authorize/,
  );
  assert.throws(
    () =>
      assertFf1ReadinessStagingSafety(
        safeEnvironment({
          FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        }),
      ),
    /refuses every Emulator Suite environment/,
  );
  assert.throws(
    () =>
      assertFf1ReadinessStagingSafety(
        safeEnvironment({
          FF1_READINESS_STAGING_TIMEOUT_MILLISECONDS: '1',
        }),
      ),
    /120000 through 900000/,
  );
});

test('the live manifest gate requires the exact revision, Scoring V4, and Projection V11', async () => {
  const revision = 'a'.repeat(40);
  const goodManifest = {
    sourceRevision: revision,
    scoringRulesVersion: 4,
    projectionVersion: 11,
  };
  const response = (manifest) => async () => ({
    ok: true,
    status: 200,
    json: async () => manifest,
  });

  assert.deepEqual(
    await verifyFf1ReadinessStagingManifest(revision, response(goodManifest)),
    goodManifest,
  );
  await assert.rejects(verifyFf1ReadinessStagingManifest('b'.repeat(40), response(goodManifest)));
  await assert.rejects(
    verifyFf1ReadinessStagingManifest(
      revision,
      response({ ...goodManifest, projectionVersion: 12 }),
    ),
  );
});

test('public evidence is aggregate-only and excludes Draft and projection identities', () => {
  const evidence = buildPublicFf1ReadinessEvidence({
    releaseManifestMatched: true,
    noBrowserPreparation: true,
    readyBeforeStart: true,
    requestStatus: 'ready',
    readinessStatus: 'ready',
    attemptCount: 1,
    duplicateDeliveryStable: true,
    requestIdentityStable: true,
    snapshotIdentityStable: true,
    clockStayedStopped: true,
    pickCount: 0,
    requestId: 'must-not-leak',
    snapshotId: 'must-not-leak',
    availabilityRevision: 'must-not-leak',
  });
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.projectId, D1N_STAGING_PROJECT_ID);
  assert.equal(evidence.safeResetDays, 7);
  assert.doesNotMatch(serialized, /must-not-leak/);
  for (const key of ['requestId', 'snapshotId', 'availabilityRevision']) {
    assert.equal(Object.hasOwn(evidence, key), false);
  }
});

test('the runner is no-browser, duplicate-safe, audit-preserving, and always resets', async () => {
  const source = await read('scripts/capacity/run-ff1-draft-readiness-staging-evidence.mjs');

  assert.equal(
    FF1_READINESS_SCHEDULER_JOB,
    'firebase-schedule-runScheduledDraftAutomation-us-central1',
  );
  assert.match(source, /readCleanGitRevision\(\)/);
  assert.match(source, /verifyFf1ReadinessStagingManifest\(sourceRevision\)/);
  assert.match(source, /triggerFf1DraftScheduler\(\);[\s\S]*?triggerFf1DraftScheduler\(\);/);
  assert.match(source, /assert\.deepEqual\(duplicateIdentity, stableIdentity\)/);
  assert.match(source, /picksSnapshot\.empty, true/);
  assert.match(source, /record\?\.updatedBy === 'd1n-local-fixture'/);
  assert.match(source, /draft\.roundOneOrder\[0\][\s\S]*?commissionerId/);
  assert.match(source, /finally \{[\s\S]*?restoreSafeSyntheticFf1Draft/);
  assert.match(source, /SAFE_RESET_OFFSET_MILLISECONDS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.ok(
    source.indexOf('await restoreSafeSyntheticFf1Draft') < source.indexOf('await deleteApp(app)'),
  );
  assert.doesNotMatch(source, /firebase\s+deploy/);
  assert.doesNotMatch(source, /functions:|hosting:app|firestore:rules/);
  assert.doesNotMatch(source, /D1N_STAGING_FIXTURE_PASSWORD|signInWithEmailAndPassword/);
  assert.doesNotMatch(source, /nhl-fantasy-app-ab673/);
  assert.doesNotMatch(source, /\.recursiveDelete\(|\.bulkDelete\(|firebase functions:delete/);
});

test('FF1.20 documents acceptance, observability, deployment boundary, and rollback', async () => {
  const document = await read('docs/RINKRAT_FF1_4_DRAFT_READINESS_STAGING.md');

  for (const value of [
    'before zero',
    'ready',
    'duplicate',
    'No Firebase runtime resource',
    'seven days',
    'Production Scoring V4',
    'Projection V11',
    'six-game',
    'Game 7',
    'Rules',
    'indexes',
    'TTL',
    'App Check',
    'queue',
    'worker',
  ]) {
    assert.match(document, new RegExp(value, 'i'));
  }
});
