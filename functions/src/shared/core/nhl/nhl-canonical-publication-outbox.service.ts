import {
  type DocumentData,
  FieldPath,
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';

export const CANONICAL_PUBLICATION_OUTBOX_SCHEMA_VERSION = 1;
export const CANONICAL_PUBLICATION_OUTBOX_COLLECTION =
  'nhlCanonicalPublicationOutbox';

export interface CanonicalPublicationOutboxEntry {
  id: string;
  gameId: number;
  sourceVersion: string;
  changeKind: string;
  affectedPlayerIds: number[];
  affectedTeamAbbreviations: string[];
  observedAtMilliseconds: number;
}

export function buildCanonicalPublicationOutboxId(
  gameId: number,
  sourceVersion: string,
): string {
  const normalizedGameId = Math.trunc(gameId);
  const normalizedSourceVersion = sourceVersion.trim().toLowerCase();

  if (
    !Number.isFinite(normalizedGameId) ||
    normalizedGameId <= 0 ||
    !/^[a-f0-9]{64}$/.test(normalizedSourceVersion)
  ) {
    throw new Error('canonical-publication-outbox-identity-invalid');
  }

  return `${normalizedGameId}_${normalizedSourceVersion}`;
}

function normalizeOutboxEntry(
  id: string,
  data: DocumentData | undefined,
): CanonicalPublicationOutboxEntry | null {
  const gameId = data?.['gameId'];
  const sourceVersion = typeof data?.['sourceVersion'] === 'string'
    ? data['sourceVersion'].trim().toLowerCase()
    : '';

  if (
    typeof gameId !== 'number' ||
    !Number.isFinite(gameId) ||
    gameId <= 0 ||
    !/^[a-f0-9]{64}$/.test(sourceVersion) ||
    id !== buildCanonicalPublicationOutboxId(gameId, sourceVersion)
  ) {
    return null;
  }

  return {
    id,
    gameId: Math.trunc(gameId),
    sourceVersion,
    changeKind: typeof data?.['changeKind'] === 'string'
      ? data['changeKind'].slice(0, 40)
      : 'unknown',
    affectedPlayerIds: Array.isArray(data?.['affectedPlayerIds'])
      ? data['affectedPlayerIds']
          .filter((value): value is number =>
            typeof value === 'number' && Number.isFinite(value) && value > 0
          )
          .map((value) => Math.trunc(value))
          .slice(0, 700)
      : [],
    affectedTeamAbbreviations: Array.isArray(data?.['affectedTeamAbbreviations'])
      ? data['affectedTeamAbbreviations']
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim().toUpperCase())
          .filter(Boolean)
          .slice(0, 40)
      : [],
    observedAtMilliseconds: data?.['observedAt'] instanceof Timestamp
      ? data['observedAt'].toMillis()
      : 0,
  };
}

export async function persistCanonicalPublicationWithOutbox(input: {
  firestore: Firestore;
  gameId: number;
  sourceVersion: string;
  changeKind: string;
  shouldSignal: boolean;
  affectedPlayerIds: readonly number[];
  affectedTeamAbbreviations: readonly string[];
  observedAtMilliseconds: number;
  expectedSourceVersion?: string;
  canonicalPayload: DocumentData;
}): Promise<{
  outboxId: string | null;
  outboxCreated: boolean;
  publicationApplied: boolean;
  publicationOutcome: 'applied' | 'duplicate' | 'stale';
}> {
  const gameId = Math.trunc(input.gameId);
  const sourceVersion = input.sourceVersion.trim().toLowerCase();
  const expectedSourceVersion = input.expectedSourceVersion?.trim().toLowerCase() ?? '';

  if (
    input.canonicalPayload['gameId'] !== gameId ||
    input.canonicalPayload['sourceVersion'] !== sourceVersion
  ) {
    throw new Error('canonical-publication-payload-identity-mismatch');
  }

  buildCanonicalPublicationOutboxId(gameId, sourceVersion);
  if (
    expectedSourceVersion &&
    !/^[a-f0-9]{64}$/.test(expectedSourceVersion)
  ) {
    throw new Error('canonical-publication-expected-version-invalid');
  }

  const canonicalRef = input.firestore.doc(
    `nhlCanonicalGameFacts/${gameId}`,
  );
  const outboxId = input.shouldSignal
    ? buildCanonicalPublicationOutboxId(gameId, sourceVersion)
    : null;
  const outboxRef = outboxId
    ? input.firestore.doc(
        `${CANONICAL_PUBLICATION_OUTBOX_COLLECTION}/${outboxId}`,
      )
    : null;

  return input.firestore.runTransaction(async (transaction) => {
    const canonicalSnapshot = await transaction.get(canonicalRef);
    const canonicalData = canonicalSnapshot.data() ?? {};
    const currentSourceVersion = typeof canonicalData['sourceVersion'] === 'string'
      ? canonicalData['sourceVersion'].trim().toLowerCase()
      : '';
    const currentObservedAt = canonicalData['sourceObservedAt'];
    const currentObservedAtMilliseconds = currentObservedAt instanceof Timestamp
      ? currentObservedAt.toMillis()
      : 0;
    const samePublication = currentSourceVersion === sourceVersion;
    if (
      currentSourceVersion !== expectedSourceVersion &&
      !samePublication
    ) {
      return {
        outboxId,
        outboxCreated: false,
        publicationApplied: false,
        publicationOutcome: 'stale' as const,
      };
    }

    const outboxSnapshot = outboxRef
      ? await transaction.get(outboxRef)
      : null;
    const observedAtMilliseconds = Math.max(
      0,
      Math.trunc(input.observedAtMilliseconds),
    );
    const shouldUpdateCanonical = !samePublication ||
      currentObservedAtMilliseconds <= observedAtMilliseconds;

    if (shouldUpdateCanonical) {
      transaction.set(canonicalRef, input.canonicalPayload, { merge: true });
    }

    if (outboxRef && outboxSnapshot && !outboxSnapshot.exists) {
      transaction.set(outboxRef, {
        schemaVersion: CANONICAL_PUBLICATION_OUTBOX_SCHEMA_VERSION,
        outboxId,
        gameId,
        sourceVersion,
        changeKind: input.changeKind.slice(0, 40),
        affectedPlayerIds: [...new Set(input.affectedPlayerIds)]
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.trunc(value))
          .sort((left, right) => left - right)
          .slice(0, 700),
        affectedTeamAbbreviations: [...new Set(
          input.affectedTeamAbbreviations
            .map((value) => value.trim().toUpperCase())
            .filter(Boolean),
        )].sort().slice(0, 40),
        status: 'pending',
        attemptCount: 0,
        observedAt: Timestamp.fromMillis(
          Math.max(0, Math.trunc(input.observedAtMilliseconds)),
        ),
        lastErrorCode: '',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      outboxId,
      outboxCreated: Boolean(outboxSnapshot && !outboxSnapshot.exists),
      publicationApplied: shouldUpdateCanonical,
      publicationOutcome: samePublication ? 'duplicate' as const : 'applied' as const,
    };
  });
}

export async function loadPendingCanonicalPublicationOutbox(input: {
  firestore: Firestore;
  limit: number;
  afterId?: string;
}): Promise<{
  entries: CanonicalPublicationOutboxEntry[];
  nextCursorId: string;
}> {
  const limit = Math.max(1, Math.min(80, Math.trunc(input.limit)));
  const afterId = typeof input.afterId === 'string' &&
    /^\d+_[a-f0-9]{64}$/.test(input.afterId)
      ? input.afterId
      : '';
  const collection = input.firestore
    .collection(CANONICAL_PUBLICATION_OUTBOX_COLLECTION);
  const baseQuery = collection
    .where('status', '==', 'pending')
    .orderBy(FieldPath.documentId());
  const firstSnapshot = await (afterId
    ? baseQuery.startAfter(afterId)
    : baseQuery
  ).limit(limit).get();
  const documents = [...firstSnapshot.docs];

  if (afterId && documents.length < limit) {
    const wrapSnapshot = await baseQuery
      .endBefore(afterId)
      .limit(limit - documents.length)
      .get();
    documents.push(...wrapSnapshot.docs);
  }

  return {
    entries: documents
    .map((document) => normalizeOutboxEntry(document.id, document.data()))
      .filter((entry): entry is CanonicalPublicationOutboxEntry => entry !== null),
    nextCursorId: documents.at(-1)?.id ?? afterId,
  };
}

export async function markCanonicalPublicationOutboxDelivered(input: {
  firestore: Firestore;
  entry: CanonicalPublicationOutboxEntry;
  leagueIds: readonly string[];
  outcome: 'delivered' | 'no-targets' | 'superseded';
}): Promise<boolean> {
  const reference = input.firestore.doc(
    `${CANONICAL_PUBLICATION_OUTBOX_COLLECTION}/${input.entry.id}`,
  );

  return input.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};

    if (
      !snapshot.exists ||
      data['status'] !== 'pending' ||
      data['sourceVersion'] !== input.entry.sourceVersion ||
      data['gameId'] !== input.entry.gameId
    ) {
      return false;
    }

    transaction.set(reference, {
      status: input.outcome,
      deliveredLeagueIds: [...new Set(input.leagueIds)]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim())
        .sort()
        .slice(0, 4),
      deliveredAt: FieldValue.serverTimestamp(),
      lastErrorCode: '',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return true;
  });
}

export async function recordCanonicalPublicationOutboxFailure(input: {
  firestore: Firestore;
  entry: CanonicalPublicationOutboxEntry;
  error: unknown;
}): Promise<boolean> {
  const message = input.error instanceof Error
    ? input.error.message
    : 'canonical-publication-delivery-failed';
  const reference = input.firestore.doc(
    `${CANONICAL_PUBLICATION_OUTBOX_COLLECTION}/${input.entry.id}`,
  );

  return input.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};

    if (
      !snapshot.exists ||
      data['status'] !== 'pending' ||
      data['sourceVersion'] !== input.entry.sourceVersion ||
      data['gameId'] !== input.entry.gameId
    ) {
      return false;
    }

    transaction.set(reference, {
      attemptCount: FieldValue.increment(1),
      lastAttemptAt: FieldValue.serverTimestamp(),
      lastErrorCode: message.replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 100),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return true;
  });
}
