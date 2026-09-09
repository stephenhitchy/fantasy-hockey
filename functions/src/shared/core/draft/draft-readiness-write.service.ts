import {
  DocumentData,
  DocumentReference,
  FieldValue,
  Timestamp,
} from 'firebase-admin/firestore';

function toTimestampMilliseconds(value: unknown): number | null {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toMillis' in value &&
    typeof value.toMillis === 'function'
  ) {
    const milliseconds = value.toMillis();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  return null;
}

/**
 * Atomically updates readiness only for the exact still-scheduled Draft.
 * Duplicate callers converge on the same merge; a reschedule or live Draft
 * makes an older worker a no-op.
 */
export async function updateScheduledDraftReadinessDocument(
  draftRef: DocumentReference<DocumentData>,
  scheduledStartMilliseconds: number,
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!Number.isFinite(scheduledStartMilliseconds)) {
    return false;
  }

  return draftRef.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(draftRef);
    const data = snapshot.exists ? snapshot.data() : undefined;

    if (
      data?.['status'] !== 'scheduled' ||
      toTimestampMilliseconds(data?.['scheduledStartAt']) !==
        scheduledStartMilliseconds
    ) {
      return false;
    }

    transaction.set(
      draftRef,
      {
        ...payload,
        serverDraftReadinessScheduledStartAt:
          Timestamp.fromMillis(scheduledStartMilliseconds),
        serverDraftReadinessUpdatedAt: FieldValue.serverTimestamp(),
        serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return true;
  });
}
