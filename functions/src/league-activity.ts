import { createHash } from 'node:crypto';

import { FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentWritten,
} from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import {
  buildAuditLeagueActivity,
  buildCommissionerAnnouncementLeagueActivity,
  buildCommissionerAvailabilityLeagueActivity,
  buildCommissionerDraftControlLeagueActivity,
  buildDraftPickLeagueActivity,
  buildMatchupResultLeagueActivity,
  buildPrivateTransactionProjection,
  buildPrivateWaiverClaimProjections,
  buildPublicTransactionResultProjection,
  buildPublicWaiverProjection,
  buildRegularSeasonRoundRecapLeagueActivity,
  buildTransactionLeagueActivity,
  getLeagueActivityDocumentId,
  LEAGUE_ANNOUNCEMENT_BODY_MAX_LENGTH,
  LEAGUE_ANNOUNCEMENT_BODY_MAX_LINES,
  LEAGUE_ANNOUNCEMENT_TITLE_MAX_LENGTH,
  normalizeLeagueAnnouncementText,
  getLeagueActivityFingerprint,
  getPrivateTransactionDocumentId,
  getPublicTransactionResultDocumentId,
  getTransactionPrivacyFingerprint,
  type LeagueActivitySourceKind,
  type SanitizedLeagueActivity,
} from './shared/core/league/league-activity.util';
import {
  applyLeagueActivityReactionSelection,
  evaluateLeagueActivityReactionRateLimit,
  isLeagueActivityReactionEligibleEventType,
  normalizeLeagueActivityReactionRecords,
  normalizeLeagueActivityReactionType,
  type LeagueActivityReactionCounts,
  type LeagueActivityReactionType,
} from './shared/core/league/league-activity-reaction.util';
import {
  requireAuthenticatedUserId,
  requireVerifiedEmail,
} from './shared/security/auth-security.util';
import { resolveSafeFirestoreDocumentId } from './shared/security/firestore-document-id.util';
import {
  FIRESTORE_ASSET_KEY_OPTIONS,
  FIRESTORE_AUTH_USER_ID_OPTIONS,
  FIRESTORE_DRAFT_PICK_ID_OPTIONS,
  FIRESTORE_LEAGUE_ID_OPTIONS,
  FIRESTORE_REQUEST_ID_OPTIONS,
} from './shared/security/firestore-document-id-policies';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const ACTIVITY_TRIGGER_OPTIONS = {
  region: FUNCTION_REGION,
  timeoutSeconds: 60,
  memory: '256MiB' as const,
  retry: true,
  maxInstances: 80,
};
const ACTIVITY_CALLABLE_OPTIONS = {
  region: FUNCTION_REGION,
  timeoutSeconds: 30,
  memory: '256MiB' as const,
  maxInstances: 40,
  cors: TRUSTED_WEB_ORIGINS,
  invoker: 'public' as const,
};
const PINNED_ANNOUNCEMENT_DOCUMENT_ID = 'pinned-announcement';
const ANNOUNCEMENT_RATE_LIMIT_MILLISECONDS = 10_000;

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

function resolvePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
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
  release?:
    | 'Social Batch C1A'
    | 'Social Batch C1C'
    | 'Social Batch C1D'
    | 'Social Batch C1E'
    | 'Social Batch C1F';
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


interface PublishLeagueAnnouncementRequest {
  leagueId: string;
  title: string;
  body: string;
  pin: boolean;
  requestId: string;
}

interface PublishLeagueAnnouncementResult {
  published: true;
  activityId: string;
  pinned: boolean;
  idempotentReplay: boolean;
}

interface UnpinLeagueAnnouncementResult {
  unpinned: boolean;
}


interface SetLeagueActivityReactionRequest {
  leagueId: string;
  activityId: string;
  reactionType: LeagueActivityReactionType | null;
}

interface SetLeagueActivityReactionResult {
  activityId: string;
  reactionType: LeagueActivityReactionType | null;
  reactionCounts: LeagueActivityReactionCounts;
  changed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}


function normalizeSetLeagueActivityReactionRequest(
  value: unknown,
): SetLeagueActivityReactionRequest {
  const source = asRecord(value);
  const leagueId = resolveSafeFirestoreDocumentId(
    source['leagueId'],
    FIRESTORE_LEAGUE_ID_OPTIONS,
  );
  const activityId = resolveSafeFirestoreDocumentId(
    source['activityId'],
    { maxBytes: 256 },
  );
  const rawReactionType = source['reactionType'];
  const reactionType = rawReactionType === null
    ? null
    : normalizeLeagueActivityReactionType(rawReactionType);

  if (
    !leagueId ||
    !activityId ||
    activityId === PINNED_ANNOUNCEMENT_DOCUMENT_ID ||
    (rawReactionType !== null && !reactionType)
  ) {
    throw new HttpsError('invalid-argument', 'Choose a valid League Wire reaction.');
  }

  return { leagueId, activityId, reactionType };
}

function normalizePublishLeagueAnnouncementRequest(
  value: unknown,
): PublishLeagueAnnouncementRequest {
  const source = asRecord(value);
  const leagueId = resolveSafeFirestoreDocumentId(
    source['leagueId'],
    FIRESTORE_LEAGUE_ID_OPTIONS,
  );
  const requestId = resolveSafeFirestoreDocumentId(
    source['requestId'],
    FIRESTORE_REQUEST_ID_OPTIONS,
  );
  const announcement = normalizeLeagueAnnouncementText(source);

  if (!leagueId || !requestId) {
    throw new HttpsError(
      'invalid-argument',
      'The announcement request was missing a valid league or request identifier.',
    );
  }

  if (!announcement.valid) {
    throw new HttpsError(
      'invalid-argument',
      `Use a title up to ${LEAGUE_ANNOUNCEMENT_TITLE_MAX_LENGTH} characters and a message up to ${LEAGUE_ANNOUNCEMENT_BODY_MAX_LENGTH} characters across ${LEAGUE_ANNOUNCEMENT_BODY_MAX_LINES} lines.`,
    );
  }

  return {
    leagueId,
    requestId,
    title: announcement.title,
    body: announcement.body,
    pin: source['pin'] === true,
  };
}

function createAnnouncementPayloadHash(
  input: PublishLeagueAnnouncementRequest,
  ownerId: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      ownerId,
      leagueId: input.leagueId,
      title: input.title,
      body: input.body,
      pin: input.pin,
    }))
    .digest('hex');
}

function timestampFromUnknown(value: unknown): Timestamp | null {
  return value instanceof Timestamp ? value : null;
}

function pinnedAnnouncementDocument(options: {
  activityId: string;
  activity: SanitizedLeagueActivity;
  announcementOccurredAt: Timestamp;
}): Record<string, unknown> {
  return {
    schemaVersion: options.activity.schemaVersion,
    category: 'announcement',
    eventType: 'commissioner-announcement',
    ownerId: options.activity.ownerId,
    announcementTitle: options.activity.announcementTitle,
    announcementBody: options.activity.announcementBody,
    activityId: options.activityId,
    announcementOccurredAt: options.announcementOccurredAt,
    pinnedAt: FieldValue.serverTimestamp(),
    authority: 'league-activity-authority',
    release: 'Social Batch C1E',
  };
}

export const publishLeagueAnnouncement = onCall(
  ACTIVITY_CALLABLE_OPTIONS,
  async (request): Promise<PublishLeagueAnnouncementResult> => {
    const actionLabel = 'post a league announcement';
    const userId = requireAuthenticatedUserId(request.auth, actionLabel);
    requireVerifiedEmail(request.auth, actionLabel);
    const input = normalizePublishLeagueAnnouncementRequest(request.data);
    const payloadHash = createAnnouncementPayloadHash(input, userId);
    const activityId = getLeagueActivityDocumentId('announcement', input.requestId);
    const sourceFingerprint = getLeagueActivityFingerprint('announcement', input.requestId);
    const leagueReference = db.doc(`leagues/${input.leagueId}`);
    const activityReference = db.doc(
      `leagues/${input.leagueId}/activity/${activityId}`,
    );
    const pinnedReference = db.doc(
      `leagues/${input.leagueId}/activity/${PINNED_ANNOUNCEMENT_DOCUMENT_ID}`,
    );
    const controlReference = db.doc(
      `leagues/${input.leagueId}/activityControls/announcements`,
    );

    return db.runTransaction(async (transaction) => {
      const [leagueSnapshot, activitySnapshot, controlSnapshot] = await Promise.all([
        transaction.get(leagueReference),
        transaction.get(activityReference),
        transaction.get(controlReference),
      ]);

      if (!leagueSnapshot.exists) {
        throw new HttpsError('not-found', 'This league no longer exists.');
      }

      const commissionerId = resolveSafeFirestoreDocumentId(
        leagueSnapshot.data()?.['commissionerId'],
        FIRESTORE_AUTH_USER_ID_OPTIONS,
      );

      if (!commissionerId || commissionerId !== userId) {
        throw new HttpsError(
          'permission-denied',
          'Only the league commissioner can post an announcement.',
        );
      }

      const activity = buildCommissionerAnnouncementLeagueActivity(
        {
          ownerId: userId,
          title: input.title,
          body: input.body,
        },
        commissionerId,
      );

      if (!activity) {
        throw new HttpsError(
          'failed-precondition',
          'The announcement could not be converted into a safe League Wire update.',
        );
      }

      if (activitySnapshot.exists) {
        const existing = activitySnapshot.data() ?? {};

        if (
          existing['payloadHash'] !== payloadHash ||
          existing['ownerId'] !== userId ||
          existing['eventType'] !== 'commissioner-announcement'
        ) {
          throw new HttpsError(
            'already-exists',
            'That announcement request identifier was already used for different information.',
          );
        }

        const existingOccurredAt = timestampFromUnknown(existing['occurredAt']) ?? Timestamp.now();

        if (input.pin) {
          transaction.set(
            pinnedReference,
            pinnedAnnouncementDocument({
              activityId,
              activity,
              announcementOccurredAt: existingOccurredAt,
            }),
          );
        }

        return {
          published: true,
          activityId,
          pinned: input.pin,
          idempotentReplay: true,
        };
      }

      const now = Timestamp.now();
      const lastPublishedAt = timestampFromUnknown(
        controlSnapshot.data()?.['lastPublishedAt'],
      );
      const elapsedMilliseconds = lastPublishedAt
        ? now.toMillis() - lastPublishedAt.toMillis()
        : Number.POSITIVE_INFINITY;

      if (elapsedMilliseconds < ANNOUNCEMENT_RATE_LIMIT_MILLISECONDS) {
        throw new HttpsError(
          'resource-exhausted',
          'Wait a few seconds before posting another league announcement.',
          {
            retryAfterSeconds: Math.max(
              1,
              Math.ceil(
                (ANNOUNCEMENT_RATE_LIMIT_MILLISECONDS - elapsedMilliseconds) / 1_000,
              ),
            ),
          },
        );
      }

      transaction.create(activityReference, {
        ...activity,
        sourceKind: 'announcement',
        sourceFingerprint,
        payloadHash,
        occurredAt: now,
        publishedAt: FieldValue.serverTimestamp(),
        authority: 'league-activity-authority',
        release: 'Social Batch C1E',
      });
      transaction.set(controlReference, {
        lastPublishedAt: now,
        lastPublisherId: userId,
        authority: 'league-activity-authority',
        release: 'Social Batch C1E',
      });

      if (input.pin) {
        transaction.set(
          pinnedReference,
          pinnedAnnouncementDocument({
            activityId,
            activity,
            announcementOccurredAt: now,
          }),
        );
      }

      return {
        published: true,
        activityId,
        pinned: input.pin,
        idempotentReplay: false,
      };
    });
  },
);

export const unpinLeagueAnnouncement = onCall(
  ACTIVITY_CALLABLE_OPTIONS,
  async (request): Promise<UnpinLeagueAnnouncementResult> => {
    const actionLabel = 'unpin a league announcement';
    const userId = requireAuthenticatedUserId(request.auth, actionLabel);
    requireVerifiedEmail(request.auth, actionLabel);
    const source = asRecord(request.data);
    const leagueId = resolveSafeFirestoreDocumentId(
      source['leagueId'],
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );

    if (!leagueId) {
      throw new HttpsError('invalid-argument', 'Choose a valid league announcement.');
    }

    const leagueReference = db.doc(`leagues/${leagueId}`);
    const pinnedReference = db.doc(
      `leagues/${leagueId}/activity/${PINNED_ANNOUNCEMENT_DOCUMENT_ID}`,
    );

    return db.runTransaction(async (transaction) => {
      const [leagueSnapshot, pinnedSnapshot] = await Promise.all([
        transaction.get(leagueReference),
        transaction.get(pinnedReference),
      ]);

      if (!leagueSnapshot.exists) {
        throw new HttpsError('not-found', 'This league no longer exists.');
      }

      const commissionerId = resolveSafeFirestoreDocumentId(
        leagueSnapshot.data()?.['commissionerId'],
        FIRESTORE_AUTH_USER_ID_OPTIONS,
      );

      if (!commissionerId || commissionerId !== userId) {
        throw new HttpsError(
          'permission-denied',
          'Only the league commissioner can unpin an announcement.',
        );
      }

      if (pinnedSnapshot.exists) {
        transaction.delete(pinnedReference);
      }

      return { unpinned: pinnedSnapshot.exists };
    });
  },
);


export const setLeagueActivityReaction = onCall(
  ACTIVITY_CALLABLE_OPTIONS,
  async (request): Promise<SetLeagueActivityReactionResult> => {
    const actionLabel = 'react to a League Wire update';
    const userId = requireAuthenticatedUserId(request.auth, actionLabel);
    requireVerifiedEmail(request.auth, actionLabel);
    const input = normalizeSetLeagueActivityReactionRequest(request.data);
    const memberReference = db.doc(
      `leagues/${input.leagueId}/members/${userId}`,
    );
    const activityReference = db.doc(
      `leagues/${input.leagueId}/activity/${input.activityId}`,
    );
    const controlReference = db.doc(
      `leagues/${input.leagueId}/members/${userId}/activityReactionControls/current`,
    );
    const now = Timestamp.now();

    const result = await db.runTransaction(async (transaction) => {
      const [memberSnapshot, activitySnapshot, controlSnapshot] = await Promise.all([
        transaction.get(memberReference),
        transaction.get(activityReference),
        transaction.get(controlReference),
      ]);

      if (!memberSnapshot.exists) {
        throw new HttpsError(
          'permission-denied',
          'Only current league members can react to League Wire updates.',
        );
      }

      if (!activitySnapshot.exists) {
        throw new HttpsError('not-found', 'That League Wire update is no longer available.');
      }

      const activity = activitySnapshot.data() ?? {};

      if (
        activity['authority'] !== 'league-activity-authority' ||
        !isLeagueActivityReactionEligibleEventType(activity['eventType'])
      ) {
        throw new HttpsError(
          'failed-precondition',
          'That League Wire update does not accept reactions.',
        );
      }

      const reactionRecords = normalizeLeagueActivityReactionRecords(
        activity['reactionRecords'],
      );

      if (!reactionRecords) {
        throw new HttpsError(
          'failed-precondition',
          'That League Wire reaction history needs repair before it can be changed.',
        );
      }

      const transition = applyLeagueActivityReactionSelection({
        records: reactionRecords,
        ownerId: userId,
        desiredReactionType: input.reactionType,
        changedAt: now.toDate(),
      });

      if (!transition) {
        throw new HttpsError(
          'resource-exhausted',
          'That League Wire update has reached its reaction limit.',
        );
      }

      if (!transition.changed) {
        return {
          activityId: input.activityId,
          reactionType: transition.nextReactionType,
          reactionCounts: transition.nextCounts,
          changed: false,
        };
      }

      const control = controlSnapshot.exists ? controlSnapshot.data() ?? {} : {};
      const lastChangedAt = timestampFromUnknown(control['lastChangedAt']);
      const windowStartedAt = timestampFromUnknown(control['windowStartedAt']);
      const changesInWindow = controlSnapshot.exists ? control['changesInWindow'] : 0;
      const rateLimit = evaluateLeagueActivityReactionRateLimit({
        control: {
          lastChangedAtMilliseconds: lastChangedAt?.toMillis() ?? null,
          windowStartedAtMilliseconds: windowStartedAt?.toMillis() ?? null,
          changesInWindow,
        },
        nowMilliseconds: now.toMillis(),
      });

      if (!rateLimit) {
        throw new HttpsError(
          'failed-precondition',
          'Your League Wire reaction control needs repair before it can be changed.',
        );
      }

      if (!rateLimit.allowed) {
        throw new HttpsError(
          'resource-exhausted',
          'Wait a moment before changing another League Wire reaction.',
          { retryAfterMilliseconds: rateLimit.retryAfterMilliseconds },
        );
      }

      transaction.update(activityReference, {
        reactionRecords: transition.nextRecords,
        reactionCounts: transition.nextCounts,
        reactionUpdatedAt: now,
        reactionAuthority: 'league-activity-reaction-authority',
        reactionRelease: 'Social Batch C1G',
      });
      transaction.set(controlReference, {
        lastChangedAt: Timestamp.fromMillis(
          rateLimit.nextControl.lastChangedAtMilliseconds ?? now.toMillis(),
        ),
        windowStartedAt: Timestamp.fromMillis(
          rateLimit.nextControl.windowStartedAtMilliseconds ?? now.toMillis(),
        ),
        changesInWindow: rateLimit.nextControl.changesInWindow,
        authority: 'league-activity-reaction-control-authority',
        release: 'Social Batch C1G',
      });

      return {
        activityId: input.activityId,
        reactionType: transition.nextReactionType,
        reactionCounts: transition.nextCounts,
        changed: true,
      };
    });

    if (result.changed) {
      logger.info('League Wire reaction changed.', {
        leagueId: input.leagueId,
        activityId: input.activityId,
        ownerId: userId,
        reactionType: result.reactionType,
      });
    }

    return result;
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


export const publishLeagueRoundRecapActivity = onDocumentUpdated(
  {
    ...ACTIVITY_TRIGGER_OPTIONS,
    document: 'leagues/{leagueId}/cycles/{cycleId}',
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
    const beforeSource = event.data?.before.data();
    const afterSource = event.data?.after.data();

    if (
      !leagueId ||
      !cycleId ||
      !beforeSource ||
      !afterSource ||
      beforeSource['status'] === 'complete' ||
      afterSource['status'] !== 'complete' ||
      afterSource['phase'] !== 'regular_season'
    ) {
      return;
    }

    const sourceDocumentId = resolveSourceDocumentId(cycleId, 'cycle-recap');
    const cycleNumber = resolvePositiveInteger(afterSource['cycleNumber']);
    const totalMatchupCount = resolvePositiveInteger(afterSource['totalMatchupCount']);
    const completedMatchupCount = resolvePositiveInteger(afterSource['completedMatchupCount']);

    if (
      !sourceDocumentId ||
      !cycleNumber ||
      !totalMatchupCount ||
      completedMatchupCount !== totalMatchupCount
    ) {
      return;
    }

    const matchupSnapshots = await db
      .collection(`leagues/${leagueId}/cycles/${cycleId}/matchups`)
      .get();

    if (matchupSnapshots.size !== totalMatchupCount) {
      return;
    }

    const matchupValues = matchupSnapshots.docs.map((snapshot) => snapshot.data());
    const activityId = getLeagueActivityDocumentId('cycle-recap', sourceDocumentId);
    const activityReference = db.doc(`leagues/${leagueId}/activity/${activityId}`);
    const milestoneReference = db.doc(
      `leagues/${leagueId}/socialMilestones/regular-season-scoring`,
    );
    const occurredAt = resolveOccurredAt(
      afterSource['completedAt'] ?? afterSource['updatedAt'],
      event.time,
    );

    await db.runTransaction(async (transaction) => {
      const [existingActivity, milestoneSnapshot] = await Promise.all([
        transaction.get(activityReference),
        transaction.get(milestoneReference),
      ]);

      if (existingActivity.exists) {
        return;
      }

      const milestoneData = milestoneSnapshot.data() ?? {};
      const previousHighScoreValue = milestoneSnapshot.exists
        ? milestoneData['highestRegularSeasonTeamScore']
        : null;
      const previousHighScore = typeof previousHighScoreValue === 'number' &&
          Number.isFinite(previousHighScoreValue) &&
          previousHighScoreValue >= -100_000 &&
          previousHighScoreValue <= 100_000
        ? previousHighScoreValue
        : null;
      const previousLastRecapCycleNumber = milestoneSnapshot.exists
        ? resolvePositiveInteger(milestoneData['lastRecapCycleNumber'])
        : null;

      if (
        milestoneSnapshot.exists &&
        (
          previousHighScore === null ||
          previousLastRecapCycleNumber === null
        )
      ) {
        throw new Error(
          `League ${leagueId} has an invalid regular-season scoring milestone.`,
        );
      }

      const recap = buildRegularSeasonRoundRecapLeagueActivity(
        matchupValues,
        previousHighScore,
        previousLastRecapCycleNumber === cycleNumber - 1,
      );

      if (!recap || recap.activity.recapCycleNumber !== cycleNumber) {
        return;
      }

      transaction.create(activityReference, {
        ...recap.activity,
        sourceKind: 'cycle-recap',
        sourceFingerprint: getLeagueActivityFingerprint(
          'cycle-recap',
          sourceDocumentId,
        ),
        occurredAt,
        publishedAt: FieldValue.serverTimestamp(),
        authority: 'league-activity-authority',
        release: 'Social Batch C1F',
      });

      const milestoneUpdate: Record<string, unknown> = {
        schemaVersion: 1,
        updatedAt: FieldValue.serverTimestamp(),
        authority: 'league-social-milestone-authority',
        release: 'Social Batch C1F',
      };
      const isNewestObservedRecap = previousLastRecapCycleNumber === null ||
        cycleNumber >= previousLastRecapCycleNumber;
      const shouldUpdateHighScore = previousHighScore === null ||
        recap.highestScore > previousHighScore;

      if (isNewestObservedRecap) {
        milestoneUpdate['lastRecapCycleNumber'] = cycleNumber;
        milestoneUpdate['lastRecapMatchupCount'] = recap.activity.recapMatchupCount;
      }

      if (shouldUpdateHighScore) {
        milestoneUpdate['highestRegularSeasonTeamScore'] = recap.highestScore;
        milestoneUpdate['highestScoreOwnerIds'] = recap.highestScoreOwnerIds;
        milestoneUpdate['highestScoreCycleNumber'] = cycleNumber;
      }

      transaction.set(milestoneReference, milestoneUpdate, { merge: true });
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
