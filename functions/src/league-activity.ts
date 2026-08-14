import { FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentWritten,
} from 'firebase-functions/v2/firestore';

import { db } from './shared/core/firebase';
import {
  buildAuditLeagueActivity,
  buildCommissionerAvailabilityLeagueActivity,
  buildCommissionerDraftControlLeagueActivity,
  buildDraftPickLeagueActivity,
  buildMatchupResultLeagueActivity,
  buildPrivateTransactionProjection,
  buildPrivateWaiverClaimProjections,
  buildPublicTransactionResultProjection,
  buildPublicWaiverProjection,
  buildTransactionLeagueActivity,
  getLeagueActivityDocumentId,
  getLeagueActivityFingerprint,
  getPrivateTransactionDocumentId,
  getPublicTransactionResultDocumentId,
  getTransactionPrivacyFingerprint,
  type LeagueActivitySourceKind,
  type SanitizedLeagueActivity,
} from './shared/core/league/league-activity.util';
import { resolveSafeFirestoreDocumentId } from './shared/security/firestore-document-id.util';
import {
  FIRESTORE_ASSET_KEY_OPTIONS,
  FIRESTORE_AUTH_USER_ID_OPTIONS,
  FIRESTORE_DRAFT_PICK_ID_OPTIONS,
  FIRESTORE_LEAGUE_ID_OPTIONS,
} from './shared/security/firestore-document-id-policies';

const FUNCTION_REGION = 'us-central1';
const ACTIVITY_TRIGGER_OPTIONS = {
  region: FUNCTION_REGION,
  timeoutSeconds: 60,
  memory: '256MiB' as const,
  retry: true,
  maxInstances: 80,
};

function resolveSourceDocumentId(
  value: unknown,
  sourceKind: LeagueActivitySourceKind,
): string | null {
  return resolveSafeFirestoreDocumentId(
    value,
    sourceKind === 'draft-pick'
      ? FIRESTORE_DRAFT_PICK_ID_OPTIONS
      : { maxBytes: 256 },
  );
}

function resolveOccurredAt(value: unknown, eventTime: string | undefined): Timestamp {
  if (value instanceof Timestamp) {
    return value;
  }

  const eventDate = eventTime ? new Date(eventTime) : null;

  return eventDate && Number.isFinite(eventDate.getTime())
    ? Timestamp.fromDate(eventDate)
    : Timestamp.now();
}

async function publishLeagueActivity(options: {
  leagueId: string;
  sourceKind: LeagueActivitySourceKind;
  sourceDocumentId: string;
  activity: SanitizedLeagueActivity;
  occurredAt: Timestamp;
  release?: 'Social Batch C1A' | 'Social Batch C1C' | 'Social Batch C1D';
}): Promise<void> {
  const fingerprint = getLeagueActivityFingerprint(
    options.sourceKind,
    options.sourceDocumentId,
  );
  const activityReference = db.doc(
    `leagues/${options.leagueId}/activity/${getLeagueActivityDocumentId(
      options.sourceKind,
      options.sourceDocumentId,
    )}`,
  );

  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(activityReference);

    if (existing.exists) {
      return;
    }

    transaction.create(activityReference, {
      ...options.activity,
      sourceKind: options.sourceKind,
      sourceFingerprint: fingerprint,
      occurredAt: options.occurredAt,
      publishedAt: FieldValue.serverTimestamp(),
      authority: 'league-activity-authority',
      release: options.release ?? 'Social Batch C1A',
    });
  });
}

export const publishLeagueAuditActivity = onDocumentCreated(
  {
    ...ACTIVITY_TRIGGER_OPTIONS,
    document: 'leagues/{leagueId}/audit/{auditId}',
  },
  async (event) => {
    const leagueId = resolveSafeFirestoreDocumentId(
      event.params.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const sourceDocumentId = resolveSourceDocumentId(event.params.auditId, 'audit');
    const source = event.data?.data();
    const activity = buildAuditLeagueActivity(source);

    if (!leagueId || !sourceDocumentId || !source || !activity) {
      return;
    }

    await publishLeagueActivity({
      leagueId,
      sourceKind: 'audit',
      sourceDocumentId,
      activity,
      occurredAt: resolveOccurredAt(source['createdAt'], event.time),
    });
  },
);

export const publishLeagueDraftPickActivity = onDocumentCreated(
  {
    ...ACTIVITY_TRIGGER_OPTIONS,
    document: 'leagues/{leagueId}/draft/current/picks/{pickId}',
  },
  async (event) => {
    const leagueId = resolveSafeFirestoreDocumentId(
      event.params.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const sourceDocumentId = resolveSourceDocumentId(event.params.pickId, 'draft-pick');
    const source = event.data?.data();
    const activity = buildDraftPickLeagueActivity(source);

    if (!leagueId || !sourceDocumentId || !source || !activity) {
      return;
    }

    await publishLeagueActivity({
      leagueId,
      sourceKind: 'draft-pick',
      sourceDocumentId,
      activity,
      occurredAt: resolveOccurredAt(source['madeAt'], event.time),
    });
  },
);

async function getLeagueCommissionerId(leagueId: string): Promise<string | null> {
  const leagueSnapshot = await db.doc(`leagues/${leagueId}`).get();

  return resolveSafeFirestoreDocumentId(
    leagueSnapshot.data()?.['commissionerId'],
    FIRESTORE_AUTH_USER_ID_OPTIONS,
  );
}

export const publishLeagueAvailabilityOverrideActivity = onDocumentWritten(
  {
    ...ACTIVITY_TRIGGER_OPTIONS,
    document: 'leagues/{leagueId}/playerAvailability/{playerId}',
  },
  async (event) => {
    const leagueId = resolveSafeFirestoreDocumentId(
      event.params.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const sourceDocumentId = resolveSourceDocumentId(
      event.id,
      'commissioner-availability',
    );

    if (!leagueId || !sourceDocumentId) {
      return;
    }

    const beforeSource = event.data?.before.exists
      ? event.data.before.data()
      : null;
    const afterSource = event.data?.after.exists
      ? event.data.after.data()
      : null;
    const commissionerId = await getLeagueCommissionerId(leagueId);
    const activity = buildCommissionerAvailabilityLeagueActivity(
      beforeSource,
      afterSource,
      commissionerId,
    );

    if (!activity) {
      return;
    }

    await publishLeagueActivity({
      leagueId,
      sourceKind: 'commissioner-availability',
      sourceDocumentId,
      activity,
      occurredAt: resolveOccurredAt(
        afterSource?.['updatedAt'] ?? beforeSource?.['updatedAt'],
        event.time,
      ),
      release: 'Social Batch C1D',
    });
  },
);

export const publishLeagueDraftControlActivity = onDocumentUpdated(
  {
    ...ACTIVITY_TRIGGER_OPTIONS,
    document: 'leagues/{leagueId}/draft/current',
  },
  async (event) => {
    const leagueId = resolveSafeFirestoreDocumentId(
      event.params.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const sourceDocumentId = resolveSourceDocumentId(event.id, 'draft-control');
    const beforeSource = event.data?.before.data();
    const afterSource = event.data?.after.data();

    if (!leagueId || !sourceDocumentId || !beforeSource || !afterSource) {
      return;
    }

    const commissionerId = await getLeagueCommissionerId(leagueId);
    const activity = buildCommissionerDraftControlLeagueActivity(
      beforeSource,
      afterSource,
      commissionerId,
    );

    if (!activity) {
      return;
    }

    await publishLeagueActivity({
      leagueId,
      sourceKind: 'draft-control',
      sourceDocumentId,
      activity,
      occurredAt: resolveOccurredAt(
        afterSource['clockUpdatedAt'] ?? afterSource['updatedAt'],
        event.time,
      ),
      release: 'Social Batch C1D',
    });
  },
);

async function publishProjectionIfMissing(
  reference: DocumentReference,
  data: Record<string, unknown>,
): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(reference);

    if (existing.exists) {
      return;
    }

    transaction.create(reference, data);
  });
}

export const publishLeagueTransactionActivity = onDocumentCreated(
  {
    ...ACTIVITY_TRIGGER_OPTIONS,
    document: 'leagues/{leagueId}/transactions/{transactionId}',
  },
  async (event) => {
    const leagueId = resolveSafeFirestoreDocumentId(
      event.params.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const sourceDocumentId = resolveSourceDocumentId(
      event.params.transactionId,
      'transaction',
    );
    const source = event.data?.data();

    if (!leagueId || !sourceDocumentId || !source) {
      return;
    }

    const occurredAt = resolveOccurredAt(source['createdAt'], event.time);
    const activity = buildTransactionLeagueActivity(source);
    const privateProjection = buildPrivateTransactionProjection(source);
    const publicProjection = buildPublicTransactionResultProjection(source);
    const projectionFingerprint = getTransactionPrivacyFingerprint(sourceDocumentId);
    const writes: Promise<void>[] = [];

    if (activity) {
      writes.push(publishLeagueActivity({
        leagueId,
        sourceKind: 'transaction',
        sourceDocumentId,
        activity,
        occurredAt,
      }));
    }

    if (privateProjection) {
      const ownerId = resolveSafeFirestoreDocumentId(
        privateProjection.ownerId,
        FIRESTORE_AUTH_USER_ID_OPTIONS,
      );

      if (ownerId) {
        writes.push(publishProjectionIfMissing(
          db.doc(
            `leagues/${leagueId}/members/${ownerId}/transactions/${getPrivateTransactionDocumentId(
              sourceDocumentId,
            )}`,
          ),
          {
            ...privateProjection,
            sourceFingerprint: projectionFingerprint,
            occurredAt,
            projectedAt: FieldValue.serverTimestamp(),
            authority: 'transaction-privacy-authority',
            release: 'Social Batch C1B',
          },
        ));
      }
    }

    if (publicProjection) {
      writes.push(publishProjectionIfMissing(
        db.doc(
          `leagues/${leagueId}/transactionResults/${getPublicTransactionResultDocumentId(
            sourceDocumentId,
          )}`,
        ),
        {
          ...publicProjection,
          sourceFingerprint: projectionFingerprint,
          occurredAt,
          projectedAt: FieldValue.serverTimestamp(),
          authority: 'transaction-privacy-authority',
          release: 'Social Batch C1B',
        },
      ));
    }

    await Promise.all(writes);
  },
);

export const publishLeagueMatchupResultActivity = onDocumentUpdated(
  {
    ...ACTIVITY_TRIGGER_OPTIONS,
    document: 'leagues/{leagueId}/cycles/{cycleId}/matchups/{matchupId}',
  },
  async (event) => {
    const leagueId = resolveSafeFirestoreDocumentId(
      event.params.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const cycleId = resolveSafeFirestoreDocumentId(
      event.params.cycleId,
      { maxBytes: 128 },
    );
    const matchupId = resolveSafeFirestoreDocumentId(
      event.params.matchupId,
      { maxBytes: 128 },
    );
    const beforeSource = event.data?.before.data();
    const afterSource = event.data?.after.data();

    if (
      !leagueId ||
      !cycleId ||
      !matchupId ||
      !beforeSource ||
      !afterSource ||
      beforeSource['status'] === 'complete' ||
      afterSource['status'] !== 'complete'
    ) {
      return;
    }

    const sourceDocumentId = resolveSourceDocumentId(
      `${cycleId}:${matchupId}`,
      'matchup',
    );
    const activity = buildMatchupResultLeagueActivity(afterSource);

    if (!sourceDocumentId || !activity) {
      return;
    }

    await publishLeagueActivity({
      leagueId,
      sourceKind: 'matchup',
      sourceDocumentId,
      activity,
      occurredAt: resolveOccurredAt(
        afterSource['completedAt'] ?? afterSource['updatedAt'],
        event.time,
      ),
      release: 'Social Batch C1C',
    });
  },
);

export const publishLeagueWaiverPrivacy = onDocumentWritten(
  {
    ...ACTIVITY_TRIGGER_OPTIONS,
    document: 'leagues/{leagueId}/waivers/{waiverId}',
  },
  async (event) => {
    const leagueId = resolveSafeFirestoreDocumentId(
      event.params.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const waiverId = resolveSafeFirestoreDocumentId(
      event.params.waiverId,
      FIRESTORE_ASSET_KEY_OPTIONS,
    );

    if (!leagueId || !waiverId) {
      return;
    }

    const beforeSource = event.data?.before.exists
      ? event.data.before.data()
      : null;
    const afterSource = event.data?.after.exists
      ? event.data.after.data()
      : null;
    const beforeClaims = buildPrivateWaiverClaimProjections(
      waiverId,
      beforeSource,
    );
    const afterPublicProjection = afterSource
      ? buildPublicWaiverProjection(waiverId, afterSource)
      : null;
    const afterClaims = afterSource && afterPublicProjection
      ? buildPrivateWaiverClaimProjections(waiverId, afterSource)
      : [];
    const afterOwnerIds = new Set(afterClaims.map((claim) => claim.ownerId));
    const batch = db.batch();
    const publicReference = db.doc(`leagues/${leagueId}/waiverPool/${waiverId}`);

    if (afterSource && afterPublicProjection) {
      batch.set(publicReference, {
        ...afterPublicProjection,
        createdAt: afterSource['createdAt'] ?? resolveOccurredAt(null, event.time),
        updatedAt: afterSource['updatedAt'] ?? resolveOccurredAt(null, event.time),
        processedAt: afterSource['processedAt'] ?? null,
        projectedAt: FieldValue.serverTimestamp(),
        authority: 'transaction-privacy-authority',
        release: 'Social Batch C1B',
      });
    } else {
      // Missing or invalid canonical data removes every browser-facing projection.
      batch.delete(publicReference);
    }

    for (const claim of beforeClaims) {
      if (afterOwnerIds.has(claim.ownerId)) {
        continue;
      }

      const ownerId = resolveSafeFirestoreDocumentId(
        claim.ownerId,
        FIRESTORE_AUTH_USER_ID_OPTIONS,
      );

      if (ownerId) {
        batch.delete(
          db.doc(`leagues/${leagueId}/members/${ownerId}/waiverClaims/${waiverId}`),
        );
      }
    }

    for (const claim of afterClaims) {
      const ownerId = resolveSafeFirestoreDocumentId(
        claim.ownerId,
        FIRESTORE_AUTH_USER_ID_OPTIONS,
      );

      if (!ownerId || !afterSource) {
        continue;
      }

      batch.set(
        db.doc(`leagues/${leagueId}/members/${ownerId}/waiverClaims/${waiverId}`),
        {
          ...claim,
          createdAt: afterSource['createdAt'] ?? null,
          updatedAt: afterSource['updatedAt'] ?? resolveOccurredAt(null, event.time),
          processedAt: afterSource['processedAt'] ?? null,
          projectedAt: FieldValue.serverTimestamp(),
          authority: 'transaction-privacy-authority',
          release: 'Social Batch C1B',
        },
      );
    }

    await batch.commit();
  },
);
