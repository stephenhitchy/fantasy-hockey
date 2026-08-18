import { createHash } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import {
  requireFirestoreDocumentId,
  requireServerFirestoreDocumentId,
  resolveSafeFirestoreDocumentId,
} from './shared/security/firestore-document-id.util';
import {
  FIRESTORE_AUTH_USER_ID_OPTIONS,
  FIRESTORE_LEAGUE_ID_OPTIONS,
  FIRESTORE_REQUEST_ID_OPTIONS,
} from './shared/security/firestore-document-id-policies';
import { TRUSTED_WEB_ORIGINS } from './web-security';
import { enforceAppCheckCallableCanaryForLeague } from './app-check-canary-authority';
import { db } from './shared/core/firebase';
import { requireVerifiedRecentAuthentication } from './shared/security/auth-security.util';
import {
  generateSharedProjectionSnapshot,
  getExpectedProjectionSnapshotContext,
  loadSharedProjectionSnapshotById,
  sealSharedProjectionSnapshotIntegrity,
  SHARED_PROJECTION_VERSION,
  SharedProjectionGenerationReason,
  SharedProjectionSnapshot,
  SharedProjectionSnapshotMetadata,
} from './shared/core/projection/projection-snapshot.service';
import {
  isProjectionSha256,
  PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  PROJECTION_SNAPSHOT_HASH_ALGORITHM,
  PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
} from './shared/core/projection/projection-snapshot-hash.util';

const FUNCTION_REGION = 'us-central1';
const PROJECTION_REQUEST_SCHEMA_VERSION = 1;
const PROJECTION_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{12,128}$/;
const LEAGUE_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const PROJECTION_TASK_MAX_CONCURRENT_DISPATCHES = 2;
const PROJECTION_TASK_TIMEOUT_SECONDS = 540;
const PROJECTION_REQUEST_LEASE_MILLISECONDS = 12 * 60 * 1000;
const PROJECTION_REQUEST_STALE_MILLISECONDS = 15 * 60 * 1000;
const PROJECTION_REQUEST_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const PROJECTION_STALE_SWEEP_LIMIT = 100;
const DRAFT_PROJECTION_FRESH_MILLISECONDS = 45 * 60 * 1000;
const WINDOW_PROJECTION_FRESH_MILLISECONDS = 6 * 60 * 60 * 1000;
const PROJECTION_INTEGRITY_REASON_MIN_LENGTH = 8;
const PROJECTION_INTEGRITY_REASON_MAX_LENGTH = 500;

const CLIENT_GENERATION_REASONS = new Set<SharedProjectionGenerationReason>([
  'manual',
  'draft-setup',
  'pre-draft',
  'draft-start-fallback',
  'cycle-refresh',
  'window-boundary',
]);

interface ProjectionGenerationTaskPayload {
  requestId: string;
  leagueId: string;
  requestedBy: string;
  targetCycleNumber: number;
}

interface ProjectionGenerationRequestInput {
  requestId: string;
  leagueId: string;
  generationReason: SharedProjectionGenerationReason;
  targetCycleNumber?: number;
}

interface ProjectionGenerationRequestResult {
  requestId: string;
  status: 'queued' | 'ready';
  snapshotId: string | null;
  targetCycleNumber: number;
  message: string;
  reusedFreshSnapshot: boolean;
}

type ProjectionIntegrityCommandAction = 'verify-current' | 'restore-previous';

interface ProjectionIntegrityCommandRequest {
  requestId?: unknown;
  leagueId?: unknown;
  action?: unknown;
  reason?: unknown;
}

interface ProjectionIntegrityCommandResult {
  requestId: string;
  action: ProjectionIntegrityCommandAction;
  snapshotId: string;
  snapshotContentHash: string;
  targetCycleNumber: number;
  alreadySealed: boolean;
  restoredPointer: boolean;
  message: string;
}

interface ProjectionRequestDocument {
  schemaVersion: number;
  requestId: string;
  leagueId: string;
  requestedBy: string;
  generationReason: SharedProjectionGenerationReason;
  targetCycleNumber: number;
  teamCount: number;
  requiredGamesPerCycle: number;
  status: 'queued' | 'processing' | 'ready' | 'error';
  payloadHash: string;
  snapshotId: string | null;
  message: string;
  lastError: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requireLeagueId(value: unknown): string {
  return requireFirestoreDocumentId(value, 'league ID', {
    minimumLength: 3,
    maxBytes: 120,
    pattern: LEAGUE_ID_PATTERN,
  });
}

function requireRequestId(value: unknown): string {
  return requireFirestoreDocumentId(value, 'projection request ID', {
    minimumLength: 8,
    maxBytes: 120,
    pattern: PROJECTION_REQUEST_ID_PATTERN,
  });
}

function requireGenerationReason(value: unknown): SharedProjectionGenerationReason {
  const reason = asString(value) as SharedProjectionGenerationReason;

  if (!CLIENT_GENERATION_REASONS.has(reason)) {
    throw new HttpsError('invalid-argument', 'Choose a supported projection refresh reason.');
  }

  return reason;
}

function requireProjectionIntegrityAction(value: unknown): ProjectionIntegrityCommandAction {
  const action = asString(value);

  if (action !== 'verify-current' && action !== 'restore-previous') {
    throw new HttpsError('invalid-argument', 'Choose a supported projection integrity action.');
  }

  return action;
}

function requireProjectionIntegrityReason(value: unknown): string {
  const reason = asString(value);

  if (
    reason.length < PROJECTION_INTEGRITY_REASON_MIN_LENGTH ||
    reason.length > PROJECTION_INTEGRITY_REASON_MAX_LENGTH
  ) {
    throw new HttpsError(
      'invalid-argument',
      `The audit reason must be between ${PROJECTION_INTEGRITY_REASON_MIN_LENGTH} and ${PROJECTION_INTEGRITY_REASON_MAX_LENGTH} characters.`,
    );
  }

  return reason;
}

function isIntegrityVerifiedSnapshot(
  snapshot: SharedProjectionSnapshot | null,
): snapshot is SharedProjectionSnapshot {
  const metadata = snapshot?.metadata;

  return Boolean(
    snapshot &&
    snapshot.assets.length > 0 &&
    metadata?.status === 'ready' &&
    metadata.projectionVersion === SHARED_PROJECTION_VERSION &&
    metadata.generatedByAuthority === 'server' &&
    metadata.authoritySchemaVersion === PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION &&
    metadata.catalogValidationStatus === 'validated' &&
    metadata.snapshotHashSchemaVersion === PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION &&
    metadata.snapshotHashAlgorithm === PROJECTION_SNAPSHOT_HASH_ALGORITHM &&
    metadata.snapshotIntegrityStatus === 'verified' &&
    isProjectionSha256(metadata.catalogHash) &&
    isProjectionSha256(metadata.snapshotContentHash),
  );
}

function normalizePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : null;
}

function toMilliseconds(value: unknown): number {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toMillis' in value &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return 0;
}

function requestPayloadHash(
  input: ProjectionGenerationRequestInput,
  requestedBy: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      requestedBy,
      leagueId: input.leagueId,
      generationReason: input.generationReason,
      targetCycleNumber: input.targetCycleNumber ?? null,
    }))
    .digest('hex');
}

function controlId(leagueId: string, targetCycleNumber: number): string {
  return createHash('sha256')
    .update(`${leagueId}:${targetCycleNumber}`)
    .digest('hex')
    .slice(0, 40);
}

function getRequestRef(requestId: string) {
  const safeRequestId = requireServerFirestoreDocumentId(
    requestId,
    'projection request identifier',
    FIRESTORE_REQUEST_ID_OPTIONS,
  );
  return db.doc(`projectionGenerationRequests/${safeRequestId}`);
}

function getControlRef(leagueId: string, targetCycleNumber: number) {
  return db.doc(`projectionGenerationControls/${controlId(leagueId, targetCycleNumber)}`);
}

function getProjectionTaskQueue() {
  return getFunctions().taskQueue<ProjectionGenerationTaskPayload>(
    'processProjectionGenerationTask',
  );
}

function buildProjectionTaskId(payload: ProjectionGenerationTaskPayload): string {
  return createHash('sha256')
    .update(`${payload.requestId}:${payload.leagueId}:${payload.targetCycleNumber}`)
    .digest('hex')
    .slice(0, 40);
}

function isTaskAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';

  return code.includes('already-exists') || /already exists/i.test(message);
}

async function isPlatformAdministrator(
  userId: string,
  token: Record<string, unknown>,
): Promise<boolean> {
  const safeUserId = requireServerFirestoreDocumentId(
    userId,
    'platform administrator user identifier',
    FIRESTORE_AUTH_USER_ID_OPTIONS,
  );

  if (token['platformAdmin'] === true) {
    return true;
  }

  const snapshot = await db.doc(`platformAdmins/${safeUserId}`).get();
  return snapshot.exists && snapshot.data()?.['enabled'] === true;
}

async function getLatestCycleNumber(leagueId: string): Promise<number> {
  const snapshot = await db
    .collection(`leagues/${leagueId}/cycles`)
    .orderBy('cycleNumber', 'desc')
    .limit(1)
    .get();
  const value = snapshot.docs[0]?.data()?.['cycleNumber'];

  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 0;
}

function getLeagueRequiredGames(data: Record<string, unknown>): number {
  const direct = data['requiredGamesPerCycle'];
  const scoringRules = asRecord(data['scoringRules']);
  const nested = scoringRules['requiredGamesPerCycle'];
  const value = typeof nested === 'number' ? nested : direct;

  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 6;
}

async function resolveProjectionRequestContext(
  leagueId: string,
  userId: string,
  token: Record<string, unknown>,
  generationReason: SharedProjectionGenerationReason,
  requestedTargetCycleNumber: number | null,
): Promise<{
  teamCount: number;
  requiredGamesPerCycle: number;
  targetCycleNumber: number;
}> {
  const [leagueSnapshot, memberSnapshot, teamSnapshot, draftSnapshot, teamsSnapshot, latestCycle] =
    await Promise.all([
      db.doc(`leagues/${leagueId}`).get(),
      db.doc(`leagues/${leagueId}/members/${userId}`).get(),
      db.doc(`leagues/${leagueId}/teams/${userId}`).get(),
      db.doc(`leagues/${leagueId}/draft/current`).get(),
      db.collection(`leagues/${leagueId}/teams`).get(),
      getLatestCycleNumber(leagueId),
    ]);

  if (!leagueSnapshot.exists) {
    throw new HttpsError('not-found', 'That league no longer exists.');
  }

  const league = leagueSnapshot.data() ?? {};
  const commissioner = league['commissionerId'] === userId;
  const platformAdmin = await isPlatformAdministrator(userId, token);
  const member = commissioner || memberSnapshot.exists || teamSnapshot.exists || platformAdmin;

  if (!member) {
    throw new HttpsError('permission-denied', 'You do not have access to that league.');
  }

  const privilegedReason =
    generationReason === 'manual' ||
    generationReason === 'draft-setup' ||
    generationReason === 'cycle-refresh' ||
    generationReason === 'window-boundary';

  if (privilegedReason && !commissioner && !platformAdmin) {
    throw new HttpsError(
      'permission-denied',
      'Only the commissioner can manually rebuild this league projection snapshot.',
    );
  }

  const draftStatus = typeof draftSnapshot.data()?.['status'] === 'string'
    ? draftSnapshot.data()?.['status']
    : 'setup';
  const inferredTarget = latestCycle > 0 ? latestCycle + 1 : 1;
  const targetCycleNumber = requestedTargetCycleNumber ?? inferredTarget;
  const maximumAllowedTarget = Math.max(1, latestCycle + 1);

  if (!platformAdmin && targetCycleNumber > maximumAllowedTarget) {
    throw new HttpsError(
      'invalid-argument',
      `Matchup ${targetCycleNumber} is not yet eligible for projection generation.`,
    );
  }

  if (draftStatus !== 'complete' && targetCycleNumber !== 1) {
    throw new HttpsError(
      'failed-precondition',
      'Pre-draft projection generation must target Matchup 1.',
    );
  }

  return {
    teamCount: Math.max(
      2,
      teamsSnapshot.size,
      typeof league['maxTeams'] === 'number' && Number.isFinite(league['maxTeams'])
        ? Math.floor(league['maxTeams'])
        : 2,
    ),
    requiredGamesPerCycle: getLeagueRequiredGames(league),
    targetCycleNumber,
  };
}

function normalizePointerMetadata(
  data: Record<string, unknown>,
): Partial<SharedProjectionSnapshotMetadata> {
  return data as Partial<SharedProjectionSnapshotMetadata>;
}

function isReusableProjectionPointer(
  data: Record<string, unknown>,
  input: {
    teamCount: number;
    requiredGamesPerCycle: number;
    targetCycleNumber: number;
    generationReason: SharedProjectionGenerationReason;
  },
): boolean {
  if (
    data['status'] !== 'ready' ||
    data['projectionVersion'] !== SHARED_PROJECTION_VERSION ||
    data['generatedByAuthority'] !== 'server' ||
    data['authoritySchemaVersion'] !== PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION ||
    data['catalogValidationStatus'] !== 'validated' ||
    data['snapshotHashSchemaVersion'] !== PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION ||
    data['snapshotHashAlgorithm'] !== PROJECTION_SNAPSHOT_HASH_ALGORITHM ||
    data['snapshotIntegrityStatus'] !== 'verified' ||
    !isProjectionSha256(data['snapshotContentHash']) ||
    data['teamCount'] !== input.teamCount ||
    data['requiredGamesPerCycle'] !== input.requiredGamesPerCycle ||
    data['targetCycleNumber'] !== input.targetCycleNumber
  ) {
    return false;
  }

  if (input.generationReason === 'manual') {
    return false;
  }

  const now = Date.now();

  if (
    input.generationReason === 'draft-setup' ||
    input.generationReason === 'pre-draft' ||
    input.generationReason === 'draft-start-fallback'
  ) {
    const readyUntil = toMilliseconds(data['draftReadyUntil']);
    return readyUntil > now;
  }

  const generatedAt = toMilliseconds(data['generatedAt']);
  return generatedAt > 0 && now - generatedAt <= WINDOW_PROJECTION_FRESH_MILLISECONDS;
}

async function findReusableProjection(
  leagueId: string,
  context: {
    teamCount: number;
    requiredGamesPerCycle: number;
    targetCycleNumber: number;
  },
  generationReason: SharedProjectionGenerationReason,
): Promise<SharedProjectionSnapshotMetadata | null> {
  const pointerId =
    generationReason === 'window-boundary'
      ? `target-cycle-${context.targetCycleNumber}`
      : 'current';
  const pointerSnapshot = await db
    .doc(`leagues/${leagueId}/projectionSnapshots/${pointerId}`)
    .get();

  if (!pointerSnapshot.exists) {
    return null;
  }

  const data = pointerSnapshot.data() ?? {};

  if (!isReusableProjectionPointer(data, { ...context, generationReason })) {
    return null;
  }

  return normalizePointerMetadata(data) as SharedProjectionSnapshotMetadata;
}


export interface ServerProjectionRefreshQueueResult {
  requestId: string;
  status: 'queued' | 'ready' | 'already-queued';
  targetCycleNumber: number;
}


async function queueHistoricalReplayProjectionCatchUp(input: {
  leagueId: string;
  requestedBy: string;
  completedRequestId: string;
  snapshot: SharedProjectionSnapshot;
}): Promise<void> {
  if (!input.completedRequestId.startsWith('projection-replay-')) {
    return;
  }

  const expectedContext = await getExpectedProjectionSnapshotContext(input.leagueId);

  if (expectedContext.projectionContext !== 'historical-replay') {
    return;
  }

  const completedAsOfDate = input.snapshot.metadata.projectionAsOfDate ?? '';

  if (completedAsOfDate >= expectedContext.projectionAsOfDate) {
    return;
  }

  const requestKey = `replay-catchup-${createHash('sha256')
    .update(`${input.leagueId}:${expectedContext.projectionAsOfDate}:${input.completedRequestId}`)
    .digest('hex')
    .slice(0, 32)}`;
  const queueResult = await queueServerProjectionSnapshotRefresh({
    leagueId: input.leagueId,
    requestedBy: input.requestedBy,
    requestKey,
  });

  console.info('Historical replay projection catch-up evaluated.', {
    leagueId: input.leagueId,
    completedRequestId: input.completedRequestId,
    completedAsOfDate,
    expectedAsOfDate: expectedContext.projectionAsOfDate,
    followUpRequestId: queueResult.requestId,
    followUpStatus: queueResult.status,
  });
}

/**
 * Queues a fresh Projection V11 rebuild from an already-authorized server
 * workflow. This writes only the existing projection request/control records
 * and dispatches the existing projection task; it never waits for the rebuild
 * and therefore cannot block scoring or historical replay completion.
 */
export async function queueServerProjectionSnapshotRefresh(input: {
  leagueId: string;
  requestedBy: string;
  requestKey: string;
  targetCycleNumber?: number | null;
}): Promise<ServerProjectionRefreshQueueResult> {
  const leagueId = requireServerFirestoreDocumentId(
    input.leagueId,
    'server projection league identifier',
    FIRESTORE_LEAGUE_ID_OPTIONS,
  );
  const requestedBy = requireServerFirestoreDocumentId(
    input.requestedBy,
    'server projection requester identifier',
    FIRESTORE_AUTH_USER_ID_OPTIONS,
  );
  const requestKey = requireServerFirestoreDocumentId(
    input.requestKey,
    'server projection request key',
    FIRESTORE_REQUEST_ID_OPTIONS,
  );
  const generationReason: SharedProjectionGenerationReason = 'manual';
  const context = await resolveProjectionRequestContext(
    leagueId,
    requestedBy,
    { platformAdmin: true },
    generationReason,
    normalizePositiveInteger(input.targetCycleNumber),
  );
  const requestId = `projection-replay-${createHash('sha256')
    .update(`${leagueId}:${requestKey}:${context.targetCycleNumber}`)
    .digest('hex')
    .slice(0, 32)}`;
  const payloadHash = requestPayloadHash({
    requestId,
    leagueId,
    generationReason,
    targetCycleNumber: context.targetCycleNumber,
  }, requestedBy);
  const requestRef = getRequestRef(requestId);
  const controlRef = getControlRef(leagueId, context.targetCycleNumber);
  const now = Date.now();
  const leaseExpiresAt = Timestamp.fromMillis(
    now + PROJECTION_REQUEST_LEASE_MILLISECONDS,
  );

  const queueState = await db.runTransaction(async (transaction) => {
    const [existingRequest, existingControl] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(controlRef),
    ]);
    const requestData = existingRequest.data() ?? {};

    if (
      existingRequest.exists &&
      requestData['requestedBy'] === requestedBy &&
      requestData['payloadHash'] === payloadHash &&
      requestData['status'] === 'ready'
    ) {
      return 'ready' as const;
    }

    const control = existingControl.data() ?? {};
    const activeRequestId = asString(control['activeRequestId']);
    const activeStatus = asString(control['status']);
    const activeLeaseExpiresAt = toMilliseconds(control['leaseExpiresAt']);

    if (
      activeRequestId &&
      activeRequestId !== requestId &&
      (activeStatus === 'queued' || activeStatus === 'processing') &&
      activeLeaseExpiresAt > now
    ) {
      return 'already-queued' as const;
    }

    const requestDocument: ProjectionRequestDocument = {
      schemaVersion: PROJECTION_REQUEST_SCHEMA_VERSION,
      requestId,
      leagueId,
      requestedBy,
      generationReason,
      targetCycleNumber: context.targetCycleNumber,
      teamCount: context.teamCount,
      requiredGamesPerCycle: context.requiredGamesPerCycle,
      status: 'queued',
      payloadHash,
      snapshotId: null,
      message: 'Historical replay player-stat refresh is queued.',
      lastError: '',
    };

    transaction.set(requestRef, {
      ...requestDocument,
      createdAt: existingRequest.exists
        ? requestData['createdAt'] ?? FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      leaseExpiresAt,
      expiresAt: Timestamp.fromMillis(now + PROJECTION_REQUEST_RETENTION_MILLISECONDS),
    }, { merge: true });
    transaction.set(controlRef, {
      schemaVersion: PROJECTION_REQUEST_SCHEMA_VERSION,
      leagueId,
      targetCycleNumber: context.targetCycleNumber,
      activeRequestId: requestId,
      status: 'queued',
      requestedBy,
      generationReason,
      leaseExpiresAt,
      createdAt: existingControl.exists
        ? control['createdAt'] ?? FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return 'queued' as const;
  });

  if (queueState !== 'queued') {
    return {
      requestId,
      status: queueState,
      targetCycleNumber: context.targetCycleNumber,
    };
  }

  const payload: ProjectionGenerationTaskPayload = {
    requestId,
    leagueId,
    requestedBy,
    targetCycleNumber: context.targetCycleNumber,
  };

  try {
    await getProjectionTaskQueue().enqueue(payload, {
      id: buildProjectionTaskId(payload),
      scheduleTime: new Date(Date.now() + 250),
      dispatchDeadlineSeconds: PROJECTION_TASK_TIMEOUT_SECONDS,
    });
  } catch (error: unknown) {
    if (!isTaskAlreadyExistsError(error)) {
      const message = error instanceof Error
        ? error.message
        : 'The replay player-stat refresh queue could not accept this request.';

      await Promise.all([
        requestRef.set({
          status: 'error',
          message,
          lastError: message.slice(0, 500),
          failedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
        controlRef.set({
          status: 'error',
          lastError: message.slice(0, 500),
          leaseExpiresAt: Timestamp.fromMillis(Date.now()),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
      ]).catch(() => undefined);

      throw error;
    }
  }

  return {
    requestId,
    status: 'queued',
    targetCycleNumber: context.targetCycleNumber,
  };
}


export const manageProjectionSnapshotIntegrity = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '512MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<ProjectionIntegrityCommandResult> => {
    const authenticatedUserId = request.auth?.uid;

    if (!authenticatedUserId) {
      throw new HttpsError('unauthenticated', 'Sign in before managing projection integrity.');
    }

    const userId = requireFirestoreDocumentId(
      authenticatedUserId,
      'platform administrator ID',
      { maxBytes: 128 },
    );

    if (!await isPlatformAdministrator(userId, request.auth?.token ?? {})) {
      throw new HttpsError(
        'permission-denied',
        'Only a platform administrator can verify or restore projection snapshots.',
      );
    }

    requireVerifiedRecentAuthentication(
      request.auth,
      'verify or restore a Draft projection snapshot',
    );

    const input = asRecord(request.data) as ProjectionIntegrityCommandRequest;
    const requestId = requireRequestId(input.requestId);
    const leagueId = requireLeagueId(input.leagueId);
    const action = requireProjectionIntegrityAction(input.action);
    const reason = requireProjectionIntegrityReason(input.reason);
    const auditId = `projection-integrity-${createHash('sha256')
      .update(requestId)
      .digest('hex')
      .slice(0, 24)}`;
    const auditRef = db.doc(`leagues/${leagueId}/audit/${auditId}`);
    const existingAudit = await auditRef.get();

    if (existingAudit.exists) {
      const audit = existingAudit.data() ?? {};

      if (
        audit['actorId'] !== userId ||
        audit['action'] !== `projection-${action}`
      ) {
        throw new HttpsError(
          'already-exists',
          'That projection integrity request ID was already used for another action.',
        );
      }

      const snapshotId = asString(audit['snapshotId']);
      const snapshotContentHash = asString(audit['snapshotContentHash']);
      const targetCycleNumber = normalizePositiveInteger(audit['targetCycleNumber']) ?? 1;

      if (!snapshotId || !isProjectionSha256(snapshotContentHash)) {
        throw new HttpsError(
          'data-loss',
          'The prior projection integrity audit record is incomplete.',
        );
      }

      return {
        requestId,
        action,
        snapshotId,
        snapshotContentHash,
        targetCycleNumber,
        alreadySealed: audit['alreadySealed'] === true,
        restoredPointer: audit['restoredPointer'] === true,
        message: asString(audit['message']) || 'Projection integrity action was already completed.',
      };
    }

    const leagueRef = db.doc(`leagues/${leagueId}`);
    const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
    const currentPointerRef = db.doc(`leagues/${leagueId}/projectionSnapshots/current`);
    const [leagueSnapshot, draftSnapshot, currentPointerSnapshot, pickSnapshot] = await Promise.all([
      leagueRef.get(),
      draftRef.get(),
      currentPointerRef.get(),
      db.collection(`leagues/${leagueId}/draft/current/picks`).limit(1).get(),
    ]);

    if (!leagueSnapshot.exists) {
      throw new HttpsError('not-found', 'That league no longer exists.');
    }

    const currentPointer = currentPointerSnapshot.data() ?? {};
    const currentSnapshotId = asString(currentPointer['activeSnapshotId']);
    let selectedSnapshotId = currentSnapshotId;

    if (action === 'restore-previous') {
      const draft = draftSnapshot.data() ?? {};
      const draftStatus = asString(draft['status']) || 'setup';

      if (
        !pickSnapshot.empty ||
        draftStatus === 'live' ||
        draftStatus === 'complete'
      ) {
        throw new HttpsError(
          'failed-precondition',
          'A previous projection snapshot cannot be restored after the Draft has started or a pick exists.',
        );
      }

      const candidatesSnapshot = await db
        .collection(`leagues/${leagueId}/projectionSnapshots`)
        .get();
      const candidates = candidatesSnapshot.docs
        .map((document) => ({
          id: document.id,
          data: document.data() as Record<string, unknown>,
        }))
        .filter(({ id, data }) =>
          id !== 'current' &&
          !id.startsWith('target-cycle-') &&
          id !== currentSnapshotId &&
          data['status'] === 'ready' &&
          data['projectionVersion'] === SHARED_PROJECTION_VERSION &&
          data['generationReason'] !== 'server-emergency' &&
          data['generatedByAuthority'] === 'server' &&
          data['catalogValidationStatus'] === 'validated' &&
          data['activeSnapshotId'] === id,
        )
        .sort((first, second) =>
          toMilliseconds(second.data['generatedAt']) - toMilliseconds(first.data['generatedAt']),
        );

      selectedSnapshotId = candidates[0]?.id ?? '';

      if (!selectedSnapshotId) {
        throw new HttpsError(
          'failed-precondition',
          'No earlier server-generated Projection V11 snapshot is available to restore.',
        );
      }
    }

    if (!selectedSnapshotId) {
      throw new HttpsError(
        'failed-precondition',
        'No current server projection snapshot is available. Generate a fresh Projection V11 snapshot first.',
      );
    }

    let snapshot: SharedProjectionSnapshot | null;
    let alreadySealed = false;

    try {
      snapshot = await loadSharedProjectionSnapshotById(leagueId, selectedSnapshotId);
    } catch (error: unknown) {
      throw new HttpsError(
        'data-loss',
        error instanceof Error
          ? `Projection integrity verification failed: ${error.message}`
          : 'Projection integrity verification failed.',
      );
    }

    if (!isIntegrityVerifiedSnapshot(snapshot)) {
      try {
        const sealed = await sealSharedProjectionSnapshotIntegrity(leagueId, selectedSnapshotId);
        snapshot = sealed.snapshot;
        alreadySealed = sealed.alreadySealed;
      } catch (error: unknown) {
        throw new HttpsError(
          'failed-precondition',
          error instanceof Error
            ? error.message
            : 'This projection snapshot cannot be trusted and must be regenerated.',
        );
      }
    } else {
      alreadySealed = true;
    }

    if (!isIntegrityVerifiedSnapshot(snapshot)) {
      throw new HttpsError(
        'data-loss',
        'The projection snapshot did not pass its final server hash verification.',
      );
    }

    const verifiedSnapshot = snapshot;
    const snapshotContentHash = verifiedSnapshot.metadata.snapshotContentHash!;
    const targetCycleNumber = Math.max(1, verifiedSnapshot.metadata.targetCycleNumber);
    const restoredPointer = action === 'restore-previous';
    const message = restoredPointer
      ? `Restored verified Projection V${SHARED_PROJECTION_VERSION} snapshot ${verifiedSnapshot.metadata.activeSnapshotId}.`
      : alreadySealed
        ? `Projection snapshot ${verifiedSnapshot.metadata.activeSnapshotId} already has a verified server hash.`
        : `Projection snapshot ${verifiedSnapshot.metadata.activeSnapshotId} was sealed with a verified server hash.`;
    const pointerPayload = {
      ...verifiedSnapshot.metadata,
      snapshotId: verifiedSnapshot.metadata.activeSnapshotId,
      activeSnapshotId: verifiedSnapshot.metadata.activeSnapshotId,
      restoredBy: restoredPointer ? userId : null,
      restoredAt: restoredPointer ? FieldValue.serverTimestamp() : null,
      updatedAt: FieldValue.serverTimestamp(),
    };

    await db.runTransaction(async (transaction) => {
      const [auditSnapshot, latestDraftSnapshot, latestPickSnapshot, latestPointerSnapshot] =
        await Promise.all([
          transaction.get(auditRef),
          transaction.get(draftRef),
          transaction.get(db.collection(`leagues/${leagueId}/draft/current/picks`).limit(1)),
          transaction.get(currentPointerRef),
        ]);

      if (auditSnapshot.exists) {
        return;
      }

      if (restoredPointer) {
        const latestDraft = latestDraftSnapshot.data() ?? {};
        const latestDraftStatus = asString(latestDraft['status']) || 'setup';

        if (
          !latestPickSnapshot.empty ||
          latestDraftStatus === 'live' ||
          latestDraftStatus === 'complete'
        ) {
          throw new HttpsError(
            'aborted',
            'The Draft started while the projection restore was being prepared. No pointer was changed.',
          );
        }

        const expectedCurrentSnapshotId = currentSnapshotId;
        const latestCurrentSnapshotId = asString(
          (latestPointerSnapshot.data() ?? {})['activeSnapshotId'],
        );

        if (latestCurrentSnapshotId !== expectedCurrentSnapshotId) {
          throw new HttpsError(
            'aborted',
            'The current projection changed while the restore was being prepared. Refresh and review it again.',
          );
        }

        transaction.set(currentPointerRef, pointerPayload, { merge: true });
        transaction.set(
          db.doc(`leagues/${leagueId}/projectionSnapshots/target-cycle-${targetCycleNumber}`),
          pointerPayload,
          { merge: true },
        );
        transaction.set(
          draftRef,
          {
            serverDraftProjectionSnapshotId: null,
            serverDraftProjectionSnapshotHash: null,
            serverDraftProjectionAuthorityVersion: null,
            serverDraftProjectionCatalogHash: null,
            serverAutomationMessage:
              'A platform administrator restored a prior verified projection. Save Draft settings again before starting.',
            serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      transaction.create(auditRef, {
        schemaVersion: 1,
        id: auditId,
        leagueId,
        action: `projection-${action}`,
        actorId: userId,
        actorRole: 'platform-admin',
        authority: 'cloud-function',
        requestId,
        reason,
        snapshotId: verifiedSnapshot.metadata.activeSnapshotId,
        snapshotContentHash,
        targetCycleNumber,
        alreadySealed,
        restoredPointer,
        message,
        release: 'Security Batch S2B',
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    return {
      requestId,
      action,
      snapshotId: verifiedSnapshot.metadata.activeSnapshotId,
      snapshotContentHash,
      targetCycleNumber,
      alreadySealed,
      restoredPointer,
      message,
    };
  },
);

export const requestProjectionSnapshotGeneration = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 20,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<ProjectionGenerationRequestResult> => {
    const authenticatedUserId = request.auth?.uid;

    if (!authenticatedUserId) {
      throw new HttpsError('unauthenticated', 'Sign in before refreshing projections.');
    }

    const userId = requireFirestoreDocumentId(
      authenticatedUserId,
      'manager ID',
      { maxBytes: 128 },
    );

    const data = asRecord(request.data);
    const leagueId = requireLeagueId(data['leagueId']);
    await enforceAppCheckCallableCanaryForLeague(
      request,
      'requestProjectionSnapshotGeneration',
      leagueId,
    );
    const requestId = requireRequestId(data['requestId']);
    const generationReason = requireGenerationReason(data['generationReason']);
    const requestedTargetCycleNumber = normalizePositiveInteger(data['targetCycleNumber']);
    const context = await resolveProjectionRequestContext(
      leagueId,
      userId,
      request.auth?.token ?? {},
      generationReason,
      requestedTargetCycleNumber,
    );
    const payloadHash = requestPayloadHash({
      requestId,
      leagueId,
      generationReason,
      targetCycleNumber: context.targetCycleNumber,
    }, userId);
    const reusable = await findReusableProjection(leagueId, context, generationReason);

    if (reusable) {
      return {
        requestId,
        status: 'ready',
        snapshotId: reusable.activeSnapshotId,
        targetCycleNumber: context.targetCycleNumber,
        message: 'Using the newest server-validated Projection V11 snapshot.',
        reusedFreshSnapshot: true,
      };
    }

    const requestRef = getRequestRef(requestId);
    const controlRef = getControlRef(leagueId, context.targetCycleNumber);
    const now = Date.now();
    const leaseExpiresAt = Timestamp.fromMillis(
      now + PROJECTION_REQUEST_LEASE_MILLISECONDS,
    );

    const queued = await db.runTransaction(async (transaction) => {
      const [existingRequest, existingControl] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(controlRef),
      ]);

      if (existingRequest.exists) {
        const existing = existingRequest.data() ?? {};

        if (
          existing['requestedBy'] !== userId ||
          existing['payloadHash'] !== payloadHash
        ) {
          throw new HttpsError(
            'already-exists',
            'That projection request ID was already used for different settings.',
          );
        }

        return {
          requestId,
          alreadyQueued: true,
        };
      }

      const control = existingControl.data() ?? {};
      const activeRequestId = asString(control['activeRequestId']);
      const activeStatus = asString(control['status']);
      const activeLeaseExpiresAt = toMilliseconds(control['leaseExpiresAt']);

      if (
        activeRequestId &&
        (activeStatus === 'queued' || activeStatus === 'processing') &&
        activeLeaseExpiresAt > now
      ) {
        return {
          requestId: activeRequestId,
          alreadyQueued: true,
        };
      }

      const requestDocument: ProjectionRequestDocument = {
        schemaVersion: PROJECTION_REQUEST_SCHEMA_VERSION,
        requestId,
        leagueId,
        requestedBy: userId,
        generationReason,
        targetCycleNumber: context.targetCycleNumber,
        teamCount: context.teamCount,
        requiredGamesPerCycle: context.requiredGamesPerCycle,
        status: 'queued',
        payloadHash,
        snapshotId: null,
        message: 'Projection generation is queued.',
        lastError: '',
      };

      transaction.set(requestRef, {
        ...requestDocument,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        leaseExpiresAt,
        expiresAt: Timestamp.fromMillis(now + PROJECTION_REQUEST_RETENTION_MILLISECONDS),
      });
      transaction.set(controlRef, {
        schemaVersion: PROJECTION_REQUEST_SCHEMA_VERSION,
        leagueId,
        targetCycleNumber: context.targetCycleNumber,
        activeRequestId: requestId,
        status: 'queued',
        requestedBy: userId,
        generationReason,
        leaseExpiresAt,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      return {
        requestId,
        alreadyQueued: false,
      };
    });

    const payload: ProjectionGenerationTaskPayload = {
      requestId: queued.requestId,
      leagueId,
      requestedBy: userId,
      targetCycleNumber: context.targetCycleNumber,
    };

    if (!queued.alreadyQueued || queued.requestId === requestId) {
      try {
        await getProjectionTaskQueue().enqueue(payload, {
          id: buildProjectionTaskId(payload),
          scheduleTime: new Date(Date.now() + 250),
          dispatchDeadlineSeconds: PROJECTION_TASK_TIMEOUT_SECONDS,
        });
      } catch (error: unknown) {
        if (!isTaskAlreadyExistsError(error)) {
          const message = error instanceof Error
            ? error.message
            : 'The projection queue could not accept this request.';

          await Promise.all([
            getRequestRef(queued.requestId).set({
              status: 'error',
              message,
              lastError: message.slice(0, 500),
              failedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true }),
            controlRef.set({
              status: 'error',
              lastError: message.slice(0, 500),
              leaseExpiresAt: Timestamp.fromMillis(Date.now()),
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true }),
          ]).catch(() => undefined);

          throw new HttpsError('unavailable', message);
        }
      }
    }

    return {
      requestId: queued.requestId,
      status: 'queued',
      snapshotId: null,
      targetCycleNumber: context.targetCycleNumber,
      message: queued.alreadyQueued
        ? 'RinkRat is already building this server-validated projection snapshot.'
        : 'Server-validated Projection V11 generation is queued.',
      reusedFreshSnapshot: false,
    };
  },
);

export const processProjectionGenerationTask = onTaskDispatched<ProjectionGenerationTaskPayload>(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: PROJECTION_TASK_TIMEOUT_SECONDS,
    memory: '2GiB',
    retryConfig: {
      maxAttempts: 1,
    },
    rateLimits: {
      maxConcurrentDispatches: PROJECTION_TASK_MAX_CONCURRENT_DISPATCHES,
    },
  },
  async (request) => {
    const payload = request.data;

    const requestId = resolveSafeFirestoreDocumentId(
      payload?.requestId,
      FIRESTORE_REQUEST_ID_OPTIONS,
    );
    const leagueId = resolveSafeFirestoreDocumentId(
      payload?.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const requestedBy = resolveSafeFirestoreDocumentId(
      payload?.requestedBy,
      FIRESTORE_AUTH_USER_ID_OPTIONS,
    );

    if (
      !payload ||
      !requestId ||
      !leagueId ||
      !requestedBy ||
      !Number.isFinite(payload.targetCycleNumber) ||
      payload.targetCycleNumber < 1
    ) {
      console.warn('Ignored malformed projection generation task.', { payload });
      return;
    }

    const requestRef = getRequestRef(requestId);
    const controlRef = getControlRef(leagueId, payload.targetCycleNumber);
    const now = Date.now();
    const processingLease = Timestamp.fromMillis(
      now + PROJECTION_REQUEST_LEASE_MILLISECONDS,
    );

    const claimed = await db.runTransaction(async (transaction) => {
      const [requestSnapshot, controlSnapshot] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(controlRef),
      ]);

      if (!requestSnapshot.exists) {
        return null;
      }

      const requestData = requestSnapshot.data() ?? {};
      const controlData = controlSnapshot.data() ?? {};
      const status = asString(requestData['status']);

      if (status === 'ready' || status === 'error') {
        return null;
      }

      if (
        requestData['leagueId'] !== leagueId ||
        requestData['requestedBy'] !== requestedBy ||
        requestData['targetCycleNumber'] !== payload.targetCycleNumber ||
        controlData['activeRequestId'] !== requestId
      ) {
        transaction.set(requestRef, {
          status: 'error',
          message: 'Projection task identity did not match the queued request.',
          lastError: 'Projection task identity mismatch.',
          failedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return null;
      }

      transaction.set(requestRef, {
        status: 'processing',
        message: 'Building and validating Projection V11 on the server.',
        startedAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: processingLease,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(controlRef, {
        status: 'processing',
        leaseExpiresAt: processingLease,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      return requestData as ProjectionRequestDocument;
    });

    if (!claimed) {
      return;
    }

    const startedAt = Date.now();

    try {
      const snapshot = await generateSharedProjectionSnapshot({
        leagueId: claimed.leagueId,
        teamCount: claimed.teamCount,
        requiredGamesPerCycle: claimed.requiredGamesPerCycle,
        generationReason: claimed.generationReason,
        targetCycleNumber: claimed.targetCycleNumber,
        requestedBy: claimed.requestedBy,
        generationRequestId: claimed.requestId,
      });
      const durationMilliseconds = Date.now() - startedAt;

      await Promise.all([
        requestRef.set({
          status: 'ready',
          snapshotId: snapshot.metadata.activeSnapshotId,
          message: snapshot.metadata.message,
          completedAt: FieldValue.serverTimestamp(),
          durationMilliseconds,
          catalogSnapshotId: snapshot.metadata.catalogSnapshotId ?? null,
          catalogHash: snapshot.metadata.catalogHash ?? null,
          canonicalAssetCount: snapshot.metadata.canonicalAssetCount ?? null,
          catalogCacheHit: snapshot.metadata.catalogCacheHit ?? null,
          snapshotContentHash: snapshot.metadata.snapshotContentHash ?? null,
          snapshotHashSchemaVersion: snapshot.metadata.snapshotHashSchemaVersion ?? null,
          snapshotChunkCount: snapshot.metadata.snapshotChunkHashes?.length ?? null,
          leaseExpiresAt: Timestamp.fromMillis(Date.now()),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
        controlRef.set({
          status: 'ready',
          activeRequestId: requestId,
          lastSnapshotId: snapshot.metadata.activeSnapshotId,
          lastSnapshotContentHash: snapshot.metadata.snapshotContentHash ?? null,
          lastCompletedAt: FieldValue.serverTimestamp(),
          lastDurationMilliseconds: durationMilliseconds,
          lastError: '',
          leaseExpiresAt: Timestamp.fromMillis(Date.now()),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
        db.doc('appData/projectionGeneration').set({
          schemaVersion: PROJECTION_REQUEST_SCHEMA_VERSION,
          lastStatus: 'success',
          lastLeagueId: leagueId,
          lastTargetCycleNumber: payload.targetCycleNumber,
          lastSnapshotId: snapshot.metadata.activeSnapshotId,
          lastCatalogSnapshotId: snapshot.metadata.catalogSnapshotId ?? null,
          lastCatalogCacheHit: snapshot.metadata.catalogCacheHit ?? null,
          lastSnapshotContentHash: snapshot.metadata.snapshotContentHash ?? null,
          lastSnapshotChunkCount: snapshot.metadata.snapshotChunkHashes?.length ?? null,
          lastDurationMilliseconds: durationMilliseconds,
          successfulGenerationCount: FieldValue.increment(1),
          lastCompletedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
      ]);


      try {
        await queueHistoricalReplayProjectionCatchUp({
          leagueId,
          requestedBy,
          completedRequestId: requestId,
          snapshot,
        });
      } catch (catchUpError: unknown) {
        console.warn('Projection V11 completed, but a newer replay date could not be queued for catch-up.', {
          leagueId,
          requestId,
          completedAsOfDate: snapshot.metadata.projectionAsOfDate ?? null,
          message: catchUpError instanceof Error
            ? catchUpError.message
            : 'Unknown replay projection catch-up error.',
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to generate the server projection snapshot.';
      const durationMilliseconds = Date.now() - startedAt;

      await Promise.all([
        requestRef.set({
          status: 'error',
          message,
          lastError: message.slice(0, 500),
          failedAt: FieldValue.serverTimestamp(),
          durationMilliseconds,
          leaseExpiresAt: Timestamp.fromMillis(Date.now()),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
        controlRef.set({
          status: 'error',
          lastError: message.slice(0, 500),
          lastFailedAt: FieldValue.serverTimestamp(),
          lastDurationMilliseconds: durationMilliseconds,
          leaseExpiresAt: Timestamp.fromMillis(Date.now()),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
        db.doc('appData/projectionGeneration').set({
          schemaVersion: PROJECTION_REQUEST_SCHEMA_VERSION,
          lastStatus: 'error',
          lastLeagueId: leagueId,
          lastTargetCycleNumber: payload.targetCycleNumber,
          lastError: message.slice(0, 500),
          lastDurationMilliseconds: durationMilliseconds,
          failedGenerationCount: FieldValue.increment(1),
          lastFailedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
      ]).catch(() => undefined);

      console.error('Projection generation task failed.', {
        leagueId: leagueId,
        targetCycleNumber: payload.targetCycleNumber,
        requestId: requestId,
        error,
      });
    }
  },
);

export const recoverStaleProjectionGenerationRequests = onSchedule(
  {
    region: FUNCTION_REGION,
    schedule: 'every 5 minutes',
    timeoutSeconds: 60,
    memory: '256MiB',
    maxInstances: 1,
  },
  async () => {
    const cutoff = Timestamp.fromMillis(Date.now() - PROJECTION_REQUEST_STALE_MILLISECONDS);
    const snapshot = await db
      .collection('projectionGenerationControls')
      .where('leaseExpiresAt', '<=', cutoff)
      .limit(PROJECTION_STALE_SWEEP_LIMIT)
      .get();

    if (snapshot.empty) {
      return;
    }

    const batch = db.batch();
    let recovered = 0;

    for (const control of snapshot.docs) {
      const data = control.data();
      const status = asString(data['status']);

      if (status !== 'queued' && status !== 'processing') {
        continue;
      }

      const activeRequestId = asString(data['activeRequestId']);
      const message = 'The projection worker stopped reporting progress. Retry the refresh.';

      batch.set(control.ref, {
        status: 'error',
        lastError: message,
        recoveredAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: Timestamp.fromMillis(Date.now()),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      const safeActiveRequestId = resolveSafeFirestoreDocumentId(
        activeRequestId,
        FIRESTORE_REQUEST_ID_OPTIONS,
      );

      if (safeActiveRequestId) {
        batch.set(getRequestRef(safeActiveRequestId), {
          status: 'error',
          message,
          lastError: message,
          recoveredAt: FieldValue.serverTimestamp(),
          leaseExpiresAt: Timestamp.fromMillis(Date.now()),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      recovered += 1;
    }

    if (recovered > 0) {
      batch.set(db.doc('appData/projectionGeneration'), {
        staleRecoveryCount: FieldValue.increment(recovered),
        lastRecoveryAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await batch.commit();
    }
  },
);
