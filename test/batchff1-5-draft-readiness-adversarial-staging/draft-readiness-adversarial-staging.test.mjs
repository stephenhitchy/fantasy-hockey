import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  FF1_ADVERSARIAL_STAGING_ACKNOWLEDGEMENT,
  assertFf1AdversarialStagingSafety,
  buildPublicFf1AdversarialEvidence,
} from '../../scripts/capacity/run-ff1-draft-readiness-adversarial-staging-evidence.mjs';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('FF1 adversarial safety permits only the exact staging project and acknowledgement', () => {
  const environment = {
    FF1_ADVERSARIAL_STAGING_PROJECT_ID: 'rinkrat-staging-d1nc-2026',
    FF1_ADVERSARIAL_STAGING_ACK: FF1_ADVERSARIAL_STAGING_ACKNOWLEDGEMENT,
  };

  assert.deepEqual(assertFf1AdversarialStagingSafety(environment), {
    timeoutMilliseconds: 600_000,
  });
  assert.throws(
    () =>
      assertFf1AdversarialStagingSafety({
        ...environment,
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      }),
    /refuses every Emulator Suite environment/,
  );
  assert.throws(
    () =>
      assertFf1AdversarialStagingSafety({
        ...environment,
        FF1_ADVERSARIAL_STAGING_PROJECT_ID: 'nhl-fantasy-app-ab673',
      }),
    /must equal rinkrat-staging-d1nc-2026/,
  );
  assert.throws(
    () => assertFf1AdversarialStagingSafety({ ...environment, FF1_ADVERSARIAL_STAGING_ACK: 'yes' }),
    /does not authorize/,
  );
});

test('public adversarial evidence is aggregate-only and identity-free', () => {
  const evidence = buildPublicFf1AdversarialEvidence({
    releaseManifestMatched: true,
    delayedEvidenceLocked: true,
    rescheduleSupersededOldRequest: true,
    changedInputRebuilt: true,
    boundedRetryObserved: true,
    retryDelaySeconds: 60,
    retryAttemptCount: 2,
    retryRecovered: true,
    clockStayedStopped: true,
    pickCount: 0,
  });
  const serialized = JSON.stringify(evidence);

  assert.deepEqual(Object.keys(evidence), [
    'projectId',
    'leagueLabel',
    'releaseManifestMatched',
    'delayedEvidenceLocked',
    'rescheduleSupersededOldRequest',
    'changedInputRebuilt',
    'boundedRetryObserved',
    'retryDelaySeconds',
    'retryAttemptCount',
    'retryRecovered',
    'clockStayedStopped',
    'pickCount',
    'safeResetDays',
  ]);
  assert.doesNotMatch(
    serialized,
    /requestId|snapshotId|availabilityRevision|commissionerId|playerId|assetKey/i,
  );
});

test('the adversarial runner drives real persisted states without a runtime test hook', async () => {
  const source = await read(
    'scripts/capacity/run-ff1-draft-readiness-adversarial-staging-evidence.mjs',
  );

  assert.match(source, /verifyFf1ReadinessStagingManifest\(sourceRevision\)/);
  assert.match(source, /status: 'running'/);
  assert.match(source, /serverDraftReadinessStatus === 'waiting-injury'/);
  assert.match(source, /scheduledStartAt: rescheduledStartAt/);
  assert.match(source, /requestId !== firstRequestId/);
  assert.match(source, /serverDraftReadinessAvailabilityRevision !== rescheduledRevision/);
  assert.match(source, /serverDraftReadinessStatus === 'error'/);
  assert.match(source, /serverDraftReadinessAttemptCount === 2/);
  assert.match(source, /\.status, 'ready'\)/);
  assert.doesNotMatch(
    source,
    /failureInjection|testHook|debugMode|processProjectionGenerationTask\(/,
  );
});

test('fault injection is explicit, bounded, and restricted to the exact synthetic request', async () => {
  const source = await read(
    'scripts/capacity/run-ff1-draft-readiness-adversarial-staging-evidence.mjs',
  );

  assert.match(source, /prepareSyntheticFf1ReadinessRun/);
  assert.match(source, /draft\.serverDraftReadinessProjectionRequestId, request\.requestId/);
  assert.match(source, /evidenceFaultInjected: true/);
  assert.match(source, /evidenceLabel: 'ff1-readiness-adversarial'/);
  assert.match(source, /retryDelayMilliseconds >= 40_000 && retryDelayMilliseconds <= 90_000/);
  assert.doesNotMatch(source, /\.recursiveDelete\(|\.bulkDelete\(|collectionGroup\(/);
});

test('cleanup restores availability and Draft state while preserving audit records', async () => {
  const source = await read(
    'scripts/capacity/run-ff1-draft-readiness-adversarial-staging-evidence.mjs',
  );

  assert.match(source, /finally \{[\s\S]*?availabilityRef\.set\(originalAvailability\)/);
  assert.match(source, /finally \{[\s\S]*?restoreSafeSyntheticFf1Draft/);
  assert.match(source, /Promise\.allSettled\(cleanup\)/);
  assert.doesNotMatch(
    source,
    /(?:draftRef|availabilityRef|requestRef)\.delete\(|firebase functions:delete/,
  );
});

test('the runner contains no deployment or Production command', async () => {
  const source = await read(
    'scripts/capacity/run-ff1-draft-readiness-adversarial-staging-evidence.mjs',
  );

  assert.doesNotMatch(source, /nhl-fantasy-app-ab673/);
  assert.doesNotMatch(source, /firebase\s+deploy|gcloud\s+functions|gcloud\s+run\s+deploy/);
  assert.match(source, /triggerFf1DraftScheduler/);
  assert.match(source, /D1N_STAGING_PROJECT_ID/);
});

test('FF1.21 documents acceptance, edge cases, observability, deployment, and rollback', async () => {
  const [documentation, packageSource, roadmap, docsRoadmap] = await Promise.all([
    read('docs/RINKRAT_FF1_5_DRAFT_READINESS_ADVERSARIAL_STAGING.md'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(documentation, /Acceptance criteria/);
  assert.match(documentation, /Edge cases and stop conditions/);
  assert.match(documentation, /Observability/);
  assert.match(documentation, /Deployment resources/);
  assert.match(documentation, /Rollback/);
  assert.match(documentation, /Production Scoring V4/);
  assert.match(documentation, /Projection V11/);
  assert.match(packageJson.scripts['verify:batchff1-5:core'], /verify:batchff1-4:core/);
  assert.match(packageJson.scripts['staging:ff1:exercise-readiness-adversarial'], /adversarial/);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /FF1\.21 guarded adversarial Draft-readiness staging evidence/);
});
