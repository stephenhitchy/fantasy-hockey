import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';

import {
  DRAFT_AVAILABILITY_SOURCE_SCHEMA_VERSION,
} from './draft-availability-source-completeness.util';

export async function invalidateDraftAvailabilityAttestationForRosterMismatch(input: {
  reference: DocumentReference;
  expectedSourceAttemptId: string;
  expectedRosterIdentityHash: string;
}): Promise<boolean> {
  return input.reference.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(input.reference);
    const data = snapshot.exists ? snapshot.data() ?? {} : {};

    if (
      data['draftReadinessSourceSchemaVersion'] !==
        DRAFT_AVAILABILITY_SOURCE_SCHEMA_VERSION ||
      data['draftReadinessSourceComplete'] !== true ||
      data['draftReadinessSourceAttemptId'] !== input.expectedSourceAttemptId ||
      data['refreshAttemptId'] !== input.expectedSourceAttemptId ||
      data['draftReadinessNhlRosterIdentityHash'] !==
        input.expectedRosterIdentityHash
    ) {
      return false;
    }

    const existingIssues = Array.isArray(data['draftReadinessSourceIssues'])
      ? data['draftReadinessSourceIssues'].filter(
          (issue): issue is string => typeof issue === 'string',
        )
      : [];

    transaction.set(
      input.reference,
      {
        draftReadinessSourceComplete: false,
        draftReadinessSourceIssues: [
          ...new Set([...existingIssues, 'nhl-roster-identity-changed']),
        ],
        draftReadinessSourceInvalidatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return true;
  });
}
