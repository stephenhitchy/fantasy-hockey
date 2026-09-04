import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { D1N_STAGING_PROJECT_ID } from './prepare-d1n-staging-hosting.mjs';
import {
  FF1_READINESS_SHA256_PATTERN,
  FF1_READINESS_TERMINAL_REQUEST_STATUSES,
  prepareSyntheticFf1ReadinessRun,
  readCleanGitRevision,
  restoreSafeSyntheticFf1Draft,
  triggerFf1DraftScheduler,
  verifyFf1ReadinessStagingManifest,
  waitForFf1ReadinessSnapshot,
} from './run-ff1-draft-readiness-staging-evidence.mjs';

export const FF1_ADVERSARIAL_STAGING_ACKNOWLEDGEMENT = `exercise-ff1-draft-readiness-adversarial-in-${D1N_STAGING_PROJECT_ID}`;

const DEFAULT_TIMEOUT_MILLISECONDS = 600_000;
const RESCHEDULE_OFFSET_MILLISECONDS = 18 * 60 * 1000;
const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));

export function assertFf1AdversarialStagingSafety(environment = process.env) {
  if (
    environment.FIRESTORE_EMULATOR_HOST ||
    environment.FIREBASE_AUTH_EMULATOR_HOST ||
    environment.FIREBASE_DATABASE_EMULATOR_HOST
  ) {
    throw new Error('FF1 adversarial readiness evidence refuses every Emulator Suite environment.');
  }

  if (environment.FF1_ADVERSARIAL_STAGING_PROJECT_ID !== D1N_STAGING_PROJECT_ID) {
    throw new Error(`FF1_ADVERSARIAL_STAGING_PROJECT_ID must equal ${D1N_STAGING_PROJECT_ID}.`);
  }

  if (environment.FF1_ADVERSARIAL_STAGING_ACK !== FF1_ADVERSARIAL_STAGING_ACKNOWLEDGEMENT) {
    throw new Error(
      'FF1_ADVERSARIAL_STAGING_ACK does not authorize the exact synthetic adversarial run.',
    );
  }

  const timeoutMilliseconds = Number(
    environment.FF1_ADVERSARIAL_STAGING_TIMEOUT_MILLISECONDS ?? DEFAULT_TIMEOUT_MILLISECONDS,
  );

  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 120_000 ||
    timeoutMilliseconds > 900_000
  ) {
    throw new Error(
      'FF1_ADVERSARIAL_STAGING_TIMEOUT_MILLISECONDS must be an integer from 120000 through 900000.',
    );
  }

  return { timeoutMilliseconds };
}

function timestampMilliseconds(value) {
  return value?.toMillis?.() ?? null;
}

function assertScheduledAndLocked(draft, scheduledStartAt) {
  assert.equal(draft.status, 'scheduled');
  assert.equal(draft.clockStatus, 'stopped');
  assert.equal(draft.startedAt ?? null, null);
  assert.equal(timestampMilliseconds(draft.scheduledStartAt), scheduledStartAt.getTime());
}

async function assertNoDraftPicks(draftRef) {
  const picks = await draftRef.collection('picks').limit(1).get();
  assert.equal(picks.empty, true, 'Adversarial readiness evidence must never create a pick.');
  return picks.size;
}

async function waitForTerminalRequest(firestore, requestId, timeoutMilliseconds, label) {
  const requestRef = firestore.doc(`projectionGenerationRequests/${requestId}`);
  const snapshot = await waitForFf1ReadinessSnapshot(
    () => requestRef.get(),
    (current) => FF1_READINESS_TERMINAL_REQUEST_STATUSES.has(current.data()?.status ?? ''),
    timeoutMilliseconds,
    label,
  );

  return { requestRef, snapshot };
}

async function waitForReadyDraft(draftRef, requestId, timeoutMilliseconds, label) {
  return waitForFf1ReadinessSnapshot(
    () => draftRef.get(),
    (snapshot) => {
      const draft = snapshot.data() ?? {};
      return (
        draft.serverDraftReadinessStatus === 'ready' &&
        draft.serverDraftReadinessProjectionRequestId === requestId
      );
    },
    timeoutMilliseconds,
    label,
  );
}

async function injectSyntheticTerminalFailure({ draftRef, requestRef, FieldValue }) {
  const firestore = draftRef.firestore;

  await firestore.runTransaction(async (transaction) => {
    const [draftSnapshot, requestSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(requestRef),
    ]);
    const draft = draftSnapshot.data() ?? {};
    const request = requestSnapshot.data() ?? {};

    assert.equal(draft.serverDraftReadinessStatus, 'ready');
    assert.equal(request.status, 'ready');
    assert.equal(draft.serverDraftReadinessProjectionRequestId, request.requestId);

    transaction.set(
      requestRef,
      {
        status: 'error',
        message: 'Synthetic FF1 staging fault injection.',
        lastError: 'Synthetic terminal Projection task failure for bounded staging evidence.',
        evidenceFaultInjected: true,
        evidenceLabel: 'ff1-readiness-adversarial',
        failedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      draftRef,
      {
        serverDraftReadinessStatus: 'preparing-projection',
        serverDraftReadinessProjectionSnapshotId: null,
        serverDraftReadinessProjectionSnapshotHash: null,
        serverDraftReadinessRetryAfterAt: FieldValue.delete(),
        serverDraftReadinessMessage:
          'Synthetic staging evidence is presenting a terminal Projection task failure.',
        projectionPreparationStatus: 'processing',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

export function buildPublicFf1AdversarialEvidence(evidence) {
  return {
    projectId: D1N_STAGING_PROJECT_ID,
    leagueLabel: 'd1n-capacity-fixture',
    releaseManifestMatched: evidence.releaseManifestMatched === true,
    delayedEvidenceLocked: evidence.delayedEvidenceLocked === true,
    rescheduleSupersededOldRequest: evidence.rescheduleSupersededOldRequest === true,
    changedInputRebuilt: evidence.changedInputRebuilt === true,
    boundedRetryObserved: evidence.boundedRetryObserved === true,
    retryDelaySeconds: evidence.retryDelaySeconds,
    retryAttemptCount: evidence.retryAttemptCount,
    retryRecovered: evidence.retryRecovered === true,
    clockStayedStopped: evidence.clockStayedStopped === true,
    pickCount: evidence.pickCount,
    safeResetDays: 7,
  };
}

export async function runFf1DraftReadinessAdversarialStagingEvidence(environment = process.env) {
  const { timeoutMilliseconds } = assertFf1AdversarialStagingSafety(environment);
  const sourceRevision = readCleanGitRevision();
  await verifyFf1ReadinessStagingManifest(sourceRevision);

  const { applicationDefault, deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
  const { FieldValue, Timestamp, getFirestore } = requireFunctions('firebase-admin/firestore');
  const app = initializeApp(
    {
      credential: applicationDefault(),
      projectId: D1N_STAGING_PROJECT_ID,
    },
    `ff1-readiness-adversarial-${Date.now()}`,
  );
  let availabilityRef = null;
  let draftRef = null;
  let originalAvailability = null;

  try {
    assert.equal(app.options.projectId, D1N_STAGING_PROJECT_ID);
    const firestore = getFirestore(app);
    const initialStartAt = new Date(Date.now() + 19 * 60 * 1000);
    draftRef = await prepareSyntheticFf1ReadinessRun(firestore, FieldValue, initialStartAt);
    availabilityRef = firestore.doc('appData/playerAvailability');
    const availabilitySnapshot = await availabilityRef.get();
    assert.ok(availabilitySnapshot.exists);
    originalAvailability = availabilitySnapshot.data();

    await availabilityRef.set(
      {
        status: 'running',
        lastSuccessfulSyncAt: FieldValue.delete(),
        lastDailySyncKey: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    triggerFf1DraftScheduler();

    const delayedSnapshot = await waitForFf1ReadinessSnapshot(
      () => draftRef.get(),
      (snapshot) => snapshot.data()?.serverDraftReadinessStatus === 'waiting-injury',
      timeoutMilliseconds,
      'The delayed availability lock',
    );
    const delayedDraft = delayedSnapshot.data() ?? {};
    assertScheduledAndLocked(delayedDraft, initialStartAt);
    assert.equal(delayedDraft.serverDraftReadinessProjectionRequestId ?? null, null);
    assert.equal(delayedDraft.serverDraftReadinessProjectionSnapshotId ?? null, null);

    await availabilityRef.set(originalAvailability);
    triggerFf1DraftScheduler();

    const firstRequestDraftSnapshot = await waitForFf1ReadinessSnapshot(
      () => draftRef.get(),
      (snapshot) => typeof snapshot.data()?.serverDraftReadinessProjectionRequestId === 'string',
      timeoutMilliseconds,
      'The first exact readiness request',
    );
    const firstRequestDraft = firstRequestDraftSnapshot.data() ?? {};
    const firstRequestId = firstRequestDraft.serverDraftReadinessProjectionRequestId;
    assert.match(
      firstRequestDraft.serverDraftReadinessAvailabilityRevision,
      FF1_READINESS_SHA256_PATTERN,
    );
    assertScheduledAndLocked(firstRequestDraft, initialStartAt);

    const rescheduledStartAt = new Date(Date.now() + RESCHEDULE_OFFSET_MILLISECONDS);
    await draftRef.set(
      {
        scheduledStartAt: rescheduledStartAt,
        clockUpdatedBy: 'ff1-adversarial-reschedule',
        clockUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    triggerFf1DraftScheduler();

    await waitForFf1ReadinessSnapshot(
      () => draftRef.get(),
      (snapshot) =>
        timestampMilliseconds(snapshot.data()?.serverDraftReadinessScheduledStartAt) ===
        rescheduledStartAt.getTime(),
      timeoutMilliseconds,
      'The rescheduled readiness binding',
    );
    await waitForTerminalRequest(
      firestore,
      firstRequestId,
      timeoutMilliseconds,
      'The superseded Projection request',
    );
    triggerFf1DraftScheduler();

    const rescheduledRequestSnapshot = await waitForFf1ReadinessSnapshot(
      () => draftRef.get(),
      (snapshot) => {
        const requestId = snapshot.data()?.serverDraftReadinessProjectionRequestId;
        return typeof requestId === 'string' && requestId !== firstRequestId;
      },
      timeoutMilliseconds,
      'The rescheduled Projection request',
    );
    const rescheduledDraft = rescheduledRequestSnapshot.data() ?? {};
    const rescheduledRequestId = rescheduledDraft.serverDraftReadinessProjectionRequestId;
    assertScheduledAndLocked(rescheduledDraft, rescheduledStartAt);
    const rescheduledTerminal = await waitForTerminalRequest(
      firestore,
      rescheduledRequestId,
      timeoutMilliseconds,
      'The rescheduled Projection task',
    );
    assert.equal(rescheduledTerminal.snapshot.data()?.status, 'ready');
    triggerFf1DraftScheduler();
    const rescheduledReadySnapshot = await waitForReadyDraft(
      draftRef,
      rescheduledRequestId,
      timeoutMilliseconds,
      'The rescheduled ready state',
    );
    const rescheduledReady = rescheduledReadySnapshot.data() ?? {};
    const rescheduledRevision = rescheduledReady.serverDraftReadinessAvailabilityRevision;
    assert.match(rescheduledRevision, FF1_READINESS_SHA256_PATTERN);
    assertScheduledAndLocked(rescheduledReady, rescheduledStartAt);

    const changedAt = new Date();
    const changedRecords = originalAvailability.records.map((record, index) =>
      index === 0
        ? {
            ...record,
            status: 'injured-reserve',
            externalStatus: 'Injured Reserve',
            note: 'Synthetic FF1 changed-input evidence.',
            updatedAt: changedAt.toISOString(),
            syncedAt: changedAt.toISOString(),
          }
        : record,
    );
    await availabilityRef.set({
      ...originalAvailability,
      status: 'success',
      lastSuccessfulSyncAt: changedAt,
      lastDailySyncKey: changedAt.toISOString().slice(0, 10),
      records: changedRecords,
      updatedAt: changedAt,
    });
    triggerFf1DraftScheduler();

    const changedRequestSnapshot = await waitForFf1ReadinessSnapshot(
      () => draftRef.get(),
      (snapshot) => {
        const draft = snapshot.data() ?? {};
        return (
          typeof draft.serverDraftReadinessProjectionRequestId === 'string' &&
          draft.serverDraftReadinessProjectionRequestId !== rescheduledRequestId &&
          typeof draft.serverDraftReadinessAvailabilityRevision === 'string' &&
          draft.serverDraftReadinessAvailabilityRevision !== rescheduledRevision
        );
      },
      timeoutMilliseconds,
      'The changed-input Projection request',
    );
    const changedDraft = changedRequestSnapshot.data() ?? {};
    const changedRequestId = changedDraft.serverDraftReadinessProjectionRequestId;
    assertScheduledAndLocked(changedDraft, rescheduledStartAt);
    const changedTerminal = await waitForTerminalRequest(
      firestore,
      changedRequestId,
      timeoutMilliseconds,
      'The changed-input Projection task',
    );
    assert.equal(changedTerminal.snapshot.data()?.status, 'ready');
    triggerFf1DraftScheduler();
    const changedReadySnapshot = await waitForReadyDraft(
      draftRef,
      changedRequestId,
      timeoutMilliseconds,
      'The changed-input ready state',
    );
    assertScheduledAndLocked(changedReadySnapshot.data() ?? {}, rescheduledStartAt);

    await injectSyntheticTerminalFailure({
      draftRef,
      requestRef: changedTerminal.requestRef,
      FieldValue,
    });
    triggerFf1DraftScheduler();

    const retryBackoffSnapshot = await waitForFf1ReadinessSnapshot(
      () => draftRef.get(),
      (snapshot) => {
        const draft = snapshot.data() ?? {};
        return (
          draft.serverDraftReadinessStatus === 'error' &&
          timestampMilliseconds(draft.serverDraftReadinessRetryAfterAt) !== null
        );
      },
      timeoutMilliseconds,
      'The bounded retry backoff',
    );
    const retryBackoffDraft = retryBackoffSnapshot.data() ?? {};
    const retryDelayMilliseconds =
      timestampMilliseconds(retryBackoffDraft.serverDraftReadinessRetryAfterAt) - Date.now();
    assert.ok(retryDelayMilliseconds >= 40_000 && retryDelayMilliseconds <= 90_000);
    assert.equal(retryBackoffDraft.serverDraftReadinessAttemptCount, 1);
    assertScheduledAndLocked(retryBackoffDraft, rescheduledStartAt);

    await draftRef.set(
      {
        serverDraftReadinessRetryAfterAt: Timestamp.fromMillis(Date.now() - 1_000),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    triggerFf1DraftScheduler();

    const retryRequestSnapshot = await waitForFf1ReadinessSnapshot(
      () => draftRef.get(),
      (snapshot) => {
        const draft = snapshot.data() ?? {};
        return (
          typeof draft.serverDraftReadinessProjectionRequestId === 'string' &&
          draft.serverDraftReadinessProjectionRequestId !== changedRequestId &&
          draft.serverDraftReadinessAttemptCount === 2
        );
      },
      timeoutMilliseconds,
      'The second bounded Projection attempt',
    );
    const retryDraft = retryRequestSnapshot.data() ?? {};
    const retryRequestId = retryDraft.serverDraftReadinessProjectionRequestId;
    assertScheduledAndLocked(retryDraft, rescheduledStartAt);
    const retryTerminal = await waitForTerminalRequest(
      firestore,
      retryRequestId,
      timeoutMilliseconds,
      'The retry Projection task',
    );
    assert.equal(retryTerminal.snapshot.data()?.status, 'ready');
    triggerFf1DraftScheduler();
    const recoveredSnapshot = await waitForReadyDraft(
      draftRef,
      retryRequestId,
      timeoutMilliseconds,
      'The recovered ready state',
    );
    const recoveredDraft = recoveredSnapshot.data() ?? {};
    assert.equal(recoveredDraft.serverDraftReadinessAttemptCount, 2);
    assertScheduledAndLocked(recoveredDraft, rescheduledStartAt);
    const pickCount = await assertNoDraftPicks(draftRef);

    return buildPublicFf1AdversarialEvidence({
      releaseManifestMatched: true,
      delayedEvidenceLocked: delayedDraft.serverDraftReadinessStatus === 'waiting-injury',
      rescheduleSupersededOldRequest: rescheduledRequestId !== firstRequestId,
      changedInputRebuilt:
        changedRequestId !== rescheduledRequestId &&
        changedDraft.serverDraftReadinessAvailabilityRevision !== rescheduledRevision,
      boundedRetryObserved: retryBackoffDraft.serverDraftReadinessStatus === 'error',
      retryDelaySeconds: Math.round(retryDelayMilliseconds / 1000),
      retryAttemptCount: recoveredDraft.serverDraftReadinessAttemptCount,
      retryRecovered: recoveredDraft.serverDraftReadinessStatus === 'ready',
      clockStayedStopped: recoveredDraft.clockStatus === 'stopped',
      pickCount,
    });
  } finally {
    const cleanup = [];

    if (availabilityRef && originalAvailability) {
      cleanup.push(availabilityRef.set(originalAvailability));
    }
    if (draftRef) {
      cleanup.push(restoreSafeSyntheticFf1Draft(draftRef, FieldValue));
    }

    const cleanupResults = await Promise.allSettled(cleanup);
    await deleteApp(app);
    const cleanupFailure = cleanupResults.find((result) => result.status === 'rejected');

    if (cleanupFailure) {
      throw cleanupFailure.reason;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFf1DraftReadinessAdversarialStagingEvidence()
    .then((evidence) => {
      console.log('FF1 adversarial Draft readiness staging evidence passed.');
      console.log(JSON.stringify(evidence, null, 2));
      console.log(
        'The exact synthetic availability input was restored, the Draft was reset seven days ahead, and audit records were preserved.',
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
