import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { db } from './shared/core/firebase';
import { resolveSafeFirestoreDocumentId } from './shared/security/firestore-document-id-core.util';
import { FIRESTORE_REQUEST_ID_OPTIONS } from './shared/security/firestore-document-id-policies';
import {
  assertD1nLoadProbeRuntimeProject,
  buildD1nLoadProbeResult,
  D1NC_LOAD_FIXTURE_MARKER,
  d1nLoadSha256,
  type D1nLoadProbeKind,
  parseD1nLoadProbeTaskPayload,
  resolveD1nLoadRuntimeProjectId,
} from './d1n-load-probe.util';

let coldStartAvailable = true;
const ACKNOWLEDGED_TERMINAL_RUN_STATUSES = new Set([
  'seed-error',
  'enqueue-error',
  'timed-out',
  'awaiting-external-usage-and-cost',
  'reviewed',
]);

function consumeColdStart(): boolean {
  const result = coldStartAvailable;
  coldStartAvailable = false;
  return result;
}

function boundedErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return 'unknown';
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number'
    ? String(code).slice(0, 60)
    : 'unknown';
}

export async function processD1nLoadProbeIfPresent(
  rawPayload: unknown,
  expectedKind: D1nLoadProbeKind,
): Promise<boolean> {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return false;
  }
  const taskEnvelope = rawPayload as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(taskEnvelope, 'd1nLoadProbe')) {
    return false;
  }

  const payload = parseD1nLoadProbeTaskPayload(
    taskEnvelope['d1nLoadProbe'],
    expectedKind,
  );
  const runtimeProjectId = resolveD1nLoadRuntimeProjectId();
  assertD1nLoadProbeRuntimeProject(runtimeProjectId);
  const runId = resolveSafeFirestoreDocumentId(
    payload.runId,
    FIRESTORE_REQUEST_ID_OPTIONS,
  );
  const operationId = resolveSafeFirestoreDocumentId(
    payload.operationId,
    FIRESTORE_REQUEST_ID_OPTIONS,
  );
  if (!runId || !operationId) {
    throw new Error('D1N-C load probe document identity is invalid.');
  }

  const runRef = db.doc(`d1nLoadRuns/${runId}`);
  const operationRef = runRef.collection('operations').doc(operationId);
  const resultRef = runRef.collection('results').doc(operationId);
  const startedAtMilliseconds = Date.now();
  const coldStart = consumeColdStart();
  let transactionCallbackAttempts = 0;
  let operationAuthorityValidated = false;

  try {
    const outcome = await db.runTransaction(async (transaction) => {
      transactionCallbackAttempts += 1;
      const [runSnapshot, operationSnapshot, resultSnapshot] = await Promise.all([
        transaction.get(runRef),
        transaction.get(operationRef),
        transaction.get(resultRef),
      ]);
      const run = runSnapshot.data() ?? {};
      const operation = operationSnapshot.data() ?? {};

      if (
        !runSnapshot.exists
        || run['schemaVersion'] !== 1
        || run['fixtureMarker'] !== D1NC_LOAD_FIXTURE_MARKER
        || run['projectId'] !== runtimeProjectId
        || run['sourceRevision'] !== payload.sourceRevision
        || run['nonceHash'] !== d1nLoadSha256(payload.nonce)
      ) {
        throw new Error('D1N-C load run authority is missing, stale, or mismatched.');
      }
      if (ACKNOWLEDGED_TERMINAL_RUN_STATUSES.has(String(run['status'] ?? ''))) {
        return 'terminal-acknowledged' as const;
      }
      if (run['status'] !== 'running') {
        throw new Error('D1N-C load run is not ready for worker execution.');
      }
      if (
        !operationSnapshot.exists
        || operation['schemaVersion'] !== 1
        || operation['fixtureMarker'] !== D1NC_LOAD_FIXTURE_MARKER
        || operation['runId'] !== runId
        || operation['kind'] !== expectedKind
        || operation['sourceRevision'] !== payload.sourceRevision
        || operation['scheduledAtMilliseconds'] !== payload.scheduledAtMilliseconds
      ) {
        throw new Error('D1N-C load operation authority is missing or mismatched.');
      }

      const shardCount = Number(run['shardCount']);
      const shardOrdinal = Number(operation['shardOrdinal']);
      if (
        !Number.isSafeInteger(shardCount)
        || shardCount < 1
        || shardCount > 64
        || !Number.isSafeInteger(shardOrdinal)
        || shardOrdinal < 0
        || shardOrdinal >= shardCount
      ) {
        throw new Error('D1N-C load operation shard is invalid.');
      }
      operationAuthorityValidated = true;
      const shardRef = runRef.collection('shards').doc(
        `${expectedKind}-${String(shardOrdinal).padStart(2, '0')}`,
      );
      const result = buildD1nLoadProbeResult(expectedKind, operation);

      if (resultSnapshot.exists) {
        const storedResult = resultSnapshot.data() ?? {};
        if (
          storedResult['schemaVersion'] !== 1
          || storedResult['fixtureMarker'] !== D1NC_LOAD_FIXTURE_MARKER
          || storedResult['runId'] !== runId
          || storedResult['operationId'] !== operationId
          || storedResult['kind'] !== expectedKind
          || storedResult['sourceRevision'] !== payload.sourceRevision
          || storedResult['resultFingerprint'] !== result.resultFingerprint
        ) {
          throw new Error('D1N-C duplicate delivery found a mismatched result.');
        }
        transaction.set(
          operationRef,
          {
            deliveryCount: FieldValue.increment(1),
            duplicateDeliveryCount: FieldValue.increment(1),
            lastDuplicateDeliveryAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        transaction.set(
          shardRef,
          {
            schemaVersion: 1,
            fixtureMarker: D1NC_LOAD_FIXTURE_MARKER,
            kind: expectedKind,
            duplicateDeliveryCount: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return 'duplicate' as const;
      }

      const completedAtMilliseconds = Date.now();
      const durationMilliseconds = Math.max(
        0,
        completedAtMilliseconds - startedAtMilliseconds,
      );
      const queueAgeMilliseconds = Math.max(
        0,
        startedAtMilliseconds - payload.scheduledAtMilliseconds,
      );
      transaction.create(resultRef, {
        schemaVersion: 1,
        fixtureMarker: D1NC_LOAD_FIXTURE_MARKER,
        runId,
        operationId,
        kind: expectedKind,
        sourceRevision: payload.sourceRevision,
        resultFingerprint: result.resultFingerprint,
        scoring: result.scoring ?? null,
        draft: result.draft ?? null,
        queueAgeMilliseconds,
        durationMilliseconds,
        deadlineDriftMilliseconds:
          expectedKind === 'draft' ? queueAgeMilliseconds : null,
        transactionCallbackAttempts,
        coldStart,
        startedAt: Timestamp.fromMillis(startedAtMilliseconds),
        completedAt: Timestamp.fromMillis(completedAtMilliseconds),
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.set(
        operationRef,
        {
          status: 'completed',
          deliveryCount: FieldValue.increment(1),
          transactionCallbackAttempts,
          completedAt: Timestamp.fromMillis(completedAtMilliseconds),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.set(
        shardRef,
        {
          schemaVersion: 1,
          fixtureMarker: D1NC_LOAD_FIXTURE_MARKER,
          kind: expectedKind,
          completedCount: FieldValue.increment(1),
          totalDurationMilliseconds: FieldValue.increment(durationMilliseconds),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return 'completed' as const;
    }, { maxAttempts: 5 });

    console.info('D1N-C staging load probe handled.', {
      kind: expectedKind,
      outcome,
      durationMilliseconds: Date.now() - startedAtMilliseconds,
      transactionCallbackAttempts,
      coldStart,
    });
    return true;
  } catch (error: unknown) {
    if (operationAuthorityValidated) {
      await operationRef.set(
        {
          status: 'retrying',
          deliveryCount: FieldValue.increment(1),
          lastErrorCode: boundedErrorCode(error),
          lastErrorAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ).catch(() => undefined);
    }
    throw error;
  }
}
