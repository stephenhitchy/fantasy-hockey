import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { buildD1nFixtureDocuments, D1N_FIXTURE_LEAGUE_ID } from './seed-d1n-route-fixture.mjs';
import { D1N_STAGING_PROJECT_ID } from './prepare-d1n-staging-hosting.mjs';

export const FF1_READINESS_STAGING_ACKNOWLEDGEMENT = `exercise-ff1-draft-readiness-in-${D1N_STAGING_PROJECT_ID}`;
export const FF1_READINESS_SCHEDULER_JOB =
  'firebase-schedule-runScheduledDraftAutomation-us-central1';
export const FF1_READINESS_REGION = 'us-central1';

const DEFAULT_TIMEOUT_MILLISECONDS = 600_000;
const EVIDENCE_START_OFFSET_MILLISECONDS = 19 * 60 * 1000;
const SAFE_RESET_OFFSET_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MILLISECONDS = 2_000;
export const FF1_READINESS_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_REVISION_PATTERN = /^[a-f0-9]{40}$/;
export const FF1_READINESS_TERMINAL_REQUEST_STATUSES = new Set(['ready', 'error']);
const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));

const READINESS_FIELDS = Object.freeze([
  'projectionPreparationRequestId',
  'projectionPreparationStatus',
  'serverAutomationLastErrorAt',
  'serverAutomationMessage',
  'serverAutomationStatus',
  'serverAutomationUpdatedAt',
  'serverDraftReadinessAttemptCount',
  'serverDraftReadinessAvailabilityRevision',
  'serverDraftReadinessMessage',
  'serverDraftReadinessProjectionRequestId',
  'serverDraftReadinessProjectionSnapshotHash',
  'serverDraftReadinessProjectionSnapshotId',
  'serverDraftReadinessRetryAfterAt',
  'serverDraftReadinessScheduledStartAt',
  'serverDraftReadinessStatus',
  'serverDraftReadinessUpdatedAt',
  'serverDraftProjectionAuthorityVersion',
  'serverDraftProjectionCatalogHash',
  'serverDraftProjectionSnapshotHash',
  'serverDraftProjectionSnapshotId',
  'serverProjectionFallbackUsed',
]);

export function assertFf1ReadinessStagingSafety(environment = process.env) {
  if (
    environment.FIRESTORE_EMULATOR_HOST ||
    environment.FIREBASE_AUTH_EMULATOR_HOST ||
    environment.FIREBASE_DATABASE_EMULATOR_HOST
  ) {
    throw new Error('FF1 readiness evidence refuses every Emulator Suite environment.');
  }

  if (environment.FF1_READINESS_STAGING_PROJECT_ID !== D1N_STAGING_PROJECT_ID) {
    throw new Error(`FF1_READINESS_STAGING_PROJECT_ID must equal ${D1N_STAGING_PROJECT_ID}.`);
  }

  if (environment.FF1_READINESS_STAGING_ACK !== FF1_READINESS_STAGING_ACKNOWLEDGEMENT) {
    throw new Error(
      'FF1_READINESS_STAGING_ACK does not authorize the exact synthetic Draft readiness run.',
    );
  }

  const timeoutMilliseconds = Number(
    environment.FF1_READINESS_STAGING_TIMEOUT_MILLISECONDS ?? DEFAULT_TIMEOUT_MILLISECONDS,
  );

  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 120_000 ||
    timeoutMilliseconds > 900_000
  ) {
    throw new Error(
      'FF1_READINESS_STAGING_TIMEOUT_MILLISECONDS must be an integer from 120000 through 900000.',
    );
  }

  return { timeoutMilliseconds };
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });

  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim().slice(-1_000);
    throw new Error(`${command} ${args.join(' ')} failed.${detail ? ` ${detail}` : ''}`);
  }

  return result.stdout.trim();
}

export function readCleanGitRevision() {
  const status = runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all']);

  if (status) {
    throw new Error('FF1 readiness evidence requires a clean Git worktree.');
  }

  const revision = runCommand('git', ['rev-parse', 'HEAD']);

  if (!GIT_REVISION_PATTERN.test(revision)) {
    throw new Error('The current Git revision could not be resolved exactly.');
  }

  return revision;
}

export async function verifyFf1ReadinessStagingManifest(
  sourceRevision,
  fetchImplementation = fetch,
) {
  const response = await fetchImplementation(
    `https://${D1N_STAGING_PROJECT_ID}.web.app/release-manifest.json?ff1=${Date.now()}`,
    { cache: 'no-store' },
  );

  if (!response.ok) {
    throw new Error(`The staging release manifest returned HTTP ${response.status}.`);
  }

  const manifest = await response.json();

  assert.equal(manifest.sourceRevision, sourceRevision);
  assert.equal(manifest.scoringRulesVersion, 4);
  assert.equal(manifest.projectionVersion, 11);

  return manifest;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForFf1ReadinessSnapshot(
  readSnapshot,
  predicate,
  timeoutMilliseconds,
  label,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMilliseconds) {
    const snapshot = await readSnapshot();

    if (predicate(snapshot)) {
      return snapshot;
    }

    await wait(POLL_INTERVAL_MILLISECONDS);
  }

  throw new Error(`${label} did not complete before the staging timeout.`);
}

export function triggerFf1DraftScheduler() {
  runCommand('gcloud', [
    'scheduler',
    'jobs',
    'run',
    FF1_READINESS_SCHEDULER_JOB,
    '--location',
    FF1_READINESS_REGION,
    '--project',
    D1N_STAGING_PROJECT_ID,
    '--quiet',
  ]);
}

export function deletedFf1ReadinessFields(FieldValue) {
  return Object.fromEntries(READINESS_FIELDS.map((field) => [field, FieldValue.delete()]));
}

export async function assertSyntheticFf1FixtureSafety(firestore) {
  const leagueRef = firestore.doc(`leagues/${D1N_FIXTURE_LEAGUE_ID}`);
  const draftRef = firestore.doc(`leagues/${D1N_FIXTURE_LEAGUE_ID}/draft/current`);
  const [leagueSnapshot, draftSnapshot, picksSnapshot, overridesSnapshot, availabilitySnapshot] =
    await Promise.all([
      leagueRef.get(),
      draftRef.get(),
      draftRef.collection('picks').limit(1).get(),
      leagueRef.collection('playerAvailability').limit(1).get(),
      firestore.doc('appData/playerAvailability').get(),
    ]);

  assert.ok(leagueSnapshot.exists, 'The synthetic D1N league is missing.');
  assert.ok(draftSnapshot.exists, 'The synthetic D1N Draft is missing.');
  assert.equal(leagueSnapshot.get('name'), 'D1N Capacity Fixture');
  assert.equal(leagueSnapshot.get('scoringRulesVersion'), 4);
  assert.equal(leagueSnapshot.get('teamCount'), 10);
  assert.equal(picksSnapshot.empty, true, 'The synthetic Draft already contains picks.');
  assert.equal(
    overridesSnapshot.empty,
    true,
    'The synthetic fixture has commissioner injury overrides that would change the evidence input.',
  );
  assert.ok(availabilitySnapshot.exists, 'The synthetic D1N availability fixture is missing.');

  const availabilityRecords = availabilitySnapshot.get('records');

  assert.equal(Array.isArray(availabilityRecords), true);
  assert.equal(availabilityRecords.length, 20);
  assert.equal(
    availabilityRecords.every(
      (record, index) =>
        record?.playerId === 10_000 + index && record?.updatedBy === 'd1n-local-fixture',
    ),
    true,
    'The shared staging availability document is not the bounded D1N fixture.',
  );

  const draft = draftSnapshot.data() ?? {};

  assert.ok(
    draft.status === 'scheduled' || draft.status === 'setup',
    'The synthetic Draft is not safe to reset for readiness evidence.',
  );
  assert.deepEqual(draft.draftedAssetKeys ?? [], []);
  assert.equal(draft.nextOverallPick, 1);
  assert.equal(Array.isArray(draft.roundOneOrder), true);
  assert.equal(draft.roundOneOrder.length, 10);
  assert.equal(draft.roundOneOrder[0], leagueSnapshot.get('commissionerId'));
  assert.equal(draft.startedAt ?? null, null);

  return {
    commissionerId: leagueSnapshot.get('commissionerId'),
    draftRef,
  };
}

export async function prepareSyntheticFf1ReadinessRun(firestore, FieldValue, scheduledStartAt) {
  const { commissionerId, draftRef } = await assertSyntheticFf1FixtureSafety(firestore);
  assert.equal(typeof commissionerId, 'string');
  assert.ok(commissionerId.length > 0);

  const now = new Date();
  const fixture = buildD1nFixtureDocuments(commissionerId, now, {
    draftStatus: 'scheduled',
    draftStartOffsetMinutes: 19,
  });
  const availability = fixture.documents.get('appData/playerAvailability');

  assert.equal(availability.status, 'success');
  assert.equal(availability.lastDailySyncKey, now.toISOString().slice(0, 10));
  assert.ok(Array.isArray(availability.records));
  assert.equal(availability.records.length, 20);

  await firestore.runTransaction(async (transaction) => {
    const currentDraft = await transaction.get(draftRef);
    const draft = currentDraft.data() ?? {};

    assert.ok(currentDraft.exists);
    assert.ok(draft.status === 'scheduled' || draft.status === 'setup');
    assert.deepEqual(draft.draftedAssetKeys ?? [], []);
    assert.equal(draft.nextOverallPick, 1);

    transaction.set(firestore.doc('appData/playerAvailability'), availability);
    transaction.set(
      draftRef,
      {
        ...deletedFf1ReadinessFields(FieldValue),
        status: 'scheduled',
        scheduledStartAt,
        startedAt: null,
        completedAt: null,
        clockStatus: 'stopped',
        pickStartedAt: null,
        currentPickSeconds: draft.pickSeconds ?? 120,
        pausedRemainingSeconds: null,
        draftedAssetKeys: [],
        nextOverallPick: 1,
        lastPickId: null,
        clockUpdatedBy: 'ff1-staging-evidence',
        clockUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  return draftRef;
}

export async function restoreSafeSyntheticFf1Draft(draftRef, FieldValue) {
  await draftRef.set(
    {
      ...deletedFf1ReadinessFields(FieldValue),
      status: 'scheduled',
      scheduledStartAt: new Date(Date.now() + SAFE_RESET_OFFSET_MILLISECONDS),
      startedAt: null,
      completedAt: null,
      clockStatus: 'stopped',
      pickStartedAt: null,
      currentPickSeconds: 120,
      pausedRemainingSeconds: null,
      draftedAssetKeys: [],
      nextOverallPick: 1,
      lastPickId: null,
      clockUpdatedBy: 'ff1-staging-evidence-cleanup',
      clockUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export function buildPublicFf1ReadinessEvidence(evidence) {
  return {
    projectId: D1N_STAGING_PROJECT_ID,
    leagueLabel: 'd1n-capacity-fixture',
    releaseManifestMatched: evidence.releaseManifestMatched === true,
    noBrowserPreparation: evidence.noBrowserPreparation === true,
    readyBeforeStart: evidence.readyBeforeStart === true,
    requestStatus: evidence.requestStatus,
    readinessStatus: evidence.readinessStatus,
    attemptCount: evidence.attemptCount,
    duplicateDeliveryStable: evidence.duplicateDeliveryStable === true,
    requestIdentityStable: evidence.requestIdentityStable === true,
    snapshotIdentityStable: evidence.snapshotIdentityStable === true,
    clockStayedStopped: evidence.clockStayedStopped === true,
    pickCount: evidence.pickCount,
    safeResetDays: 7,
  };
}

export async function runFf1DraftReadinessStagingEvidence(environment = process.env) {
  const { timeoutMilliseconds } = assertFf1ReadinessStagingSafety(environment);
  const sourceRevision = readCleanGitRevision();
  await verifyFf1ReadinessStagingManifest(sourceRevision);

  const { applicationDefault, deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
  const { FieldValue, getFirestore } = requireFunctions('firebase-admin/firestore');
  const app = initializeApp(
    {
      credential: applicationDefault(),
      projectId: D1N_STAGING_PROJECT_ID,
    },
    `ff1-readiness-evidence-${Date.now()}`,
  );
  let draftRef = null;

  try {
    assert.equal(app.options.projectId, D1N_STAGING_PROJECT_ID);
    const firestore = getFirestore(app);
    const scheduledStartAt = new Date(Date.now() + EVIDENCE_START_OFFSET_MILLISECONDS);
    draftRef = await prepareSyntheticFf1ReadinessRun(firestore, FieldValue, scheduledStartAt);

    triggerFf1DraftScheduler();
    triggerFf1DraftScheduler();

    const preparingDraft = await waitForFf1ReadinessSnapshot(
      () => draftRef.get(),
      (snapshot) => {
        const data = snapshot.data() ?? {};
        return (
          typeof data.serverDraftReadinessProjectionRequestId === 'string' ||
          data.serverDraftReadinessStatus === 'error'
        );
      },
      timeoutMilliseconds,
      'The no-browser readiness request',
    );
    const preparing = preparingDraft.data() ?? {};

    assert.notEqual(preparing.serverDraftReadinessStatus, 'error');
    assert.equal(preparing.status, 'scheduled');
    assert.equal(preparing.clockStatus, 'stopped');
    assert.match(preparing.serverDraftReadinessAvailabilityRevision, FF1_READINESS_SHA256_PATTERN);
    assert.equal(typeof preparing.serverDraftReadinessProjectionRequestId, 'string');
    const requestId = preparing.serverDraftReadinessProjectionRequestId;
    const requestRef = firestore.doc(`projectionGenerationRequests/${requestId}`);
    const terminalRequest = await waitForFf1ReadinessSnapshot(
      () => requestRef.get(),
      (snapshot) => FF1_READINESS_TERMINAL_REQUEST_STATUSES.has(snapshot.data()?.status ?? ''),
      timeoutMilliseconds,
      'The Projection V11 readiness task',
    );
    const request = terminalRequest.data() ?? {};

    assert.equal(request.status, 'ready');
    assert.equal(request.leagueId, D1N_FIXTURE_LEAGUE_ID);
    assert.equal(request.generationReason, 'pre-draft');
    assert.equal(request.availabilityRevision, preparing.serverDraftReadinessAvailabilityRevision);
    assert.match(request.snapshotContentHash, FF1_READINESS_SHA256_PATTERN);

    triggerFf1DraftScheduler();

    const readyDraftSnapshot = await waitForFf1ReadinessSnapshot(
      () => draftRef.get(),
      (snapshot) => snapshot.data()?.serverDraftReadinessStatus === 'ready',
      timeoutMilliseconds,
      'The verified Draft readiness state',
    );
    const readyDraft = readyDraftSnapshot.data() ?? {};
    const readyUpdatedAt = readyDraft.serverDraftReadinessUpdatedAt?.toMillis?.() ?? 0;

    assert.equal(readyDraft.status, 'scheduled');
    assert.equal(readyDraft.clockStatus, 'stopped');
    assert.equal(readyDraft.serverDraftReadinessProjectionRequestId, requestId);
    assert.equal(readyDraft.serverDraftReadinessProjectionSnapshotId, request.snapshotId);
    assert.equal(
      readyDraft.serverDraftReadinessProjectionSnapshotHash,
      request.snapshotContentHash,
    );
    assert.ok(readyUpdatedAt > 0 && readyUpdatedAt < scheduledStartAt.getTime());

    const stableIdentity = {
      requestId,
      snapshotId: readyDraft.serverDraftReadinessProjectionSnapshotId,
      snapshotHash: readyDraft.serverDraftReadinessProjectionSnapshotHash,
      attemptCount: readyDraft.serverDraftReadinessAttemptCount,
    };

    triggerFf1DraftScheduler();
    triggerFf1DraftScheduler();
    await wait(10_000);

    const [duplicateDraftSnapshot, picksSnapshot] = await Promise.all([
      draftRef.get(),
      draftRef.collection('picks').limit(2).get(),
    ]);
    const duplicateDraft = duplicateDraftSnapshot.data() ?? {};
    const duplicateIdentity = {
      requestId: duplicateDraft.serverDraftReadinessProjectionRequestId,
      snapshotId: duplicateDraft.serverDraftReadinessProjectionSnapshotId,
      snapshotHash: duplicateDraft.serverDraftReadinessProjectionSnapshotHash,
      attemptCount: duplicateDraft.serverDraftReadinessAttemptCount,
    };

    assert.deepEqual(duplicateIdentity, stableIdentity);
    assert.equal(duplicateDraft.status, 'scheduled');
    assert.equal(duplicateDraft.clockStatus, 'stopped');
    assert.equal(picksSnapshot.empty, true);

    return buildPublicFf1ReadinessEvidence({
      releaseManifestMatched: true,
      noBrowserPreparation: true,
      readyBeforeStart: true,
      requestStatus: request.status,
      readinessStatus: duplicateDraft.serverDraftReadinessStatus,
      attemptCount: duplicateDraft.serverDraftReadinessAttemptCount,
      duplicateDeliveryStable: true,
      requestIdentityStable: duplicateIdentity.requestId === stableIdentity.requestId,
      snapshotIdentityStable:
        duplicateIdentity.snapshotId === stableIdentity.snapshotId &&
        duplicateIdentity.snapshotHash === stableIdentity.snapshotHash,
      clockStayedStopped: duplicateDraft.clockStatus === 'stopped',
      pickCount: picksSnapshot.size,
    });
  } finally {
    if (draftRef) {
      await restoreSafeSyntheticFf1Draft(draftRef, FieldValue);
    }
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFf1DraftReadinessStagingEvidence()
    .then((evidence) => {
      console.log('FF1 Draft readiness staging evidence passed.');
      console.log(JSON.stringify(evidence, null, 2));
      console.log(
        'The synthetic Draft was reset seven days ahead; projection requests and snapshots were preserved for audit.',
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
