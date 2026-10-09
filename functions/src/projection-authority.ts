import { createHash } from 'node:crypto';

import {
  type DocumentData,
  FieldValue,
  type QueryDocumentSnapshot,
  Timestamp,
} from 'firebase-admin/firestore';
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
import {
  CURRENT_SCORING_RULES_VERSION,
  SCORING_RULES_V3_VERSION,
} from './shared/core/scoring/scoring-rules';
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
  createServerProjectionRequestId,
  isProjectionSha256,
  PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  PROJECTION_SNAPSHOT_HASH_ALGORITHM,
  PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
  PROJECTION_SNAPSHOT_LEGACY_HASH_SCHEMA_VERSION,
  PROJECTION_SNAPSHOT_SCORING_HASH_SCHEMA_VERSION,
} from './shared/core/projection/projection-snapshot-hash.util';
import { DRAFT_RANKING_MODEL_VERSION } from './shared/core/projection/projection-ranking.util';
import {
  getProjectionGenerationRecoveryAction,
  shouldRecoverProjectionGenerationRequest,
  type ProjectionGenerationRecoveryState,
} from './shared/core/projection/projection-generation-recovery.util';
import {
  isClientProjectionGenerationReason,
  projectionGenerationRequiresCommissioner,
} from './shared/core/projection/projection-generation-access.util';
import {
  projectionGameIdMapsMatch,
  shouldMutateProjectionControl,
  shouldPublishProjectionResult,
  shouldReuseActiveProjectionRequest,
} from './shared/core/projection/projection-publication-guard.util';
import { NHL_DRAFT_CLUBS } from './shared/core/nhl/nhl-api.service';
import {
  buildSourceNhlTargetGameIdsByTeam,
} from './shared/core/cycle/cycle-window-selection.util';

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
const PROJECTION_STALE_RECOVERY_CONCURRENCY = 10;
const DRAFT_PROJECTION_FRESH_MILLISECONDS = 45 * 60 * 1000;
const WINDOW_PROJECTION_FRESH_MILLISECONDS = 6 * 60 * 60 * 1000;
const PROJECTION_INTEGRITY_REASON_MIN_LENGTH = 8;
const PROJECTION_INTEGRITY_REASON_MAX_LENGTH = 500;

interface ProjectionGenerationTaskPayload {
  requestId: string;
  leagueId: string;
  requestedBy: string;
  targetCycleNumber: number;
  targetSourceBlockNumber?: number;
}

interface ProjectionGenerationRequestInput {
  requestId: string;
  leagueId: string;
  generationReason: SharedProjectionGenerationReason;
  targetCycleNumber?: number;
  targetSourceBlockNumber?: number;
  seasonWindowAnchorEvidenceHash?: string | null;
  draftScheduleGeneration?: number | null;
  draftScheduledStartMilliseconds?: number | null;
  seasonWindowSourceGamePlanHash?: string | null;
  availabilityRevision?: string | null;
}

interface ProjectionGenerationRequestResult {
  requestId: string;
  status: 'queued' | 'ready';
  snapshotId: string | null;
  targetCycleNumber: number;
  targetSourceBlockNumber: number;
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
  targetSourceBlockNumber: number;
  teamCount: number;
  requiredGamesPerCycle: number;
  status: 'queued' | 'processing' | 'ready' | 'error';
  payloadHash: string;
  snapshotId: string | null;
  message: string;
  lastError: string;
  availabilityRevision?: string | null;
  seasonWindowAnchorEvidenceHash?: string | null;
  draftScheduleGeneration?: number | null;
  draftScheduledStartMilliseconds?: number | null;
  targetGameIdsByTeam?: Record<string, number[]> | null;
  seasonWindowSourceGameIdsByTeam?: Record<string, number[]> | null;
  seasonWindowSourceGamePlanHash?: string | null;
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
  const reason = asString(value);

  if (!isClientProjectionGenerationReason(reason)) {
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

function normalizeLeagueScoringRulesVersion(value: unknown): number {
  return typeof value === 'number' && value >= CURRENT_SCORING_RULES_VERSION
    ? CURRENT_SCORING_RULES_VERSION
    : SCORING_RULES_V3_VERSION;
}

function isIntegrityVerifiedSnapshot(
  snapshot: SharedProjectionSnapshot | null,
  expectedScoringRulesVersion: number,
): snapshot is SharedProjectionSnapshot {
  const metadata = snapshot?.metadata;

  return Boolean(
    snapshot &&
    snapshot.assets.length > 0 &&
    metadata?.status === 'ready' &&
    metadata.projectionVersion === SHARED_PROJECTION_VERSION &&
    metadata.draftRankingVersion === DRAFT_RANKING_MODEL_VERSION &&
    metadata.scoringRulesVersion === expectedScoringRulesVersion &&
    metadata.generatedByAuthority === 'server' &&
    metadata.authoritySchemaVersion === PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION &&
    metadata.catalogValidationStatus === 'validated' &&
    (
      metadata.snapshotHashSchemaVersion === PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION ||
      metadata.snapshotHashSchemaVersion ===
        PROJECTION_SNAPSHOT_SCORING_HASH_SCHEMA_VERSION ||
      (expectedScoringRulesVersion === SCORING_RULES_V3_VERSION &&
        metadata.snapshotHashSchemaVersion ===
          PROJECTION_SNAPSHOT_LEGACY_HASH_SCHEMA_VERSION)
    ) &&
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
      ...(
        input.targetSourceBlockNumber &&
        input.targetSourceBlockNumber !== input.targetCycleNumber
          ? { targetSourceBlockNumber: input.targetSourceBlockNumber }
          : {}
      ),
      ...(input.seasonWindowAnchorEvidenceHash
        ? { seasonWindowAnchorEvidenceHash: input.seasonWindowAnchorEvidenceHash }
        : {}),
      ...(typeof input.draftScheduleGeneration === 'number'
        ? { draftScheduleGeneration: input.draftScheduleGeneration }
        : {}),
      ...(typeof input.draftScheduledStartMilliseconds === 'number'
        ? {
            draftScheduledStartMilliseconds:
              input.draftScheduledStartMilliseconds,
          }
        : {}),
      ...(input.seasonWindowSourceGamePlanHash
        ? {
            seasonWindowSourceGamePlanHash:
              input.seasonWindowSourceGamePlanHash,
          }
        : {}),
      ...(input.availabilityRevision
        ? { availabilityRevision: input.availabilityRevision }
        : {}),
    }))
    .digest('hex');
}

function controlId(
  leagueId: string,
  targetCycleNumber: number,
  targetSourceBlockNumber = targetCycleNumber,
): string {
  return createHash('sha256')
    .update(
      targetSourceBlockNumber === targetCycleNumber
        ? `${leagueId}:${targetCycleNumber}`
        : `${leagueId}:${targetCycleNumber}:source-block:${targetSourceBlockNumber}`,
    )
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

function getControlRef(
  leagueId: string,
  targetCycleNumber: number,
  targetSourceBlockNumber = targetCycleNumber,
) {
  return db.doc(
    `projectionGenerationControls/${controlId(
      leagueId,
      targetCycleNumber,
      targetSourceBlockNumber,
    )}`,
  );
}

function getProjectionTaskQueue() {
  return getFunctions().taskQueue<ProjectionGenerationTaskPayload>(
    'processProjectionGenerationTask',
  );
}

function buildProjectionTaskId(payload: ProjectionGenerationTaskPayload): string {
  const targetSourceBlockNumber =
    payload.targetSourceBlockNumber ?? payload.targetCycleNumber;

  return createHash('sha256')
    .update(
      targetSourceBlockNumber === payload.targetCycleNumber
        ? `${payload.requestId}:${payload.leagueId}:${payload.targetCycleNumber}`
        : `${payload.requestId}:${payload.leagueId}:${payload.targetCycleNumber}:${targetSourceBlockNumber}`,
    )
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

function normalizeAnchorTargetGameIdsByTeam(
  value: unknown,
  requiredGamesPerCycle: number,
): Record<string, number[]> | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const byTeam = new Map<string, number[]>();

  for (const entry of value) {
    const record = asRecord(entry);
    const teamAbbreviation = asString(record['teamAbbreviation']).toUpperCase();
    const rawGameIds = record['targetGameIds'];

    if (
      !/^[A-Z0-9]{2,4}$/.test(teamAbbreviation) ||
      !Array.isArray(rawGameIds) ||
      rawGameIds.length !== requiredGamesPerCycle
    ) {
      return null;
    }

    const gameIds = rawGameIds.filter(
      (gameId): gameId is number =>
        typeof gameId === 'number' && Number.isSafeInteger(gameId) && gameId > 0,
    );

    if (
      gameIds.length !== requiredGamesPerCycle ||
      new Set(gameIds).size !== requiredGamesPerCycle ||
      byTeam.has(teamAbbreviation)
    ) {
      return null;
    }

    byTeam.set(teamAbbreviation, gameIds);
  }

  const expectedTeams = NHL_DRAFT_CLUBS
    .map((club) => club.abbreviation)
    .sort((left, right) => left.localeCompare(right));

  if (
    byTeam.size !== expectedTeams.length ||
    expectedTeams.some((teamAbbreviation) => !byTeam.has(teamAbbreviation))
  ) {
    return null;
  }

  return Object.fromEntries(
    expectedTeams.map((teamAbbreviation) => [
      teamAbbreviation,
      [...byTeam.get(teamAbbreviation)!],
    ]),
  );
}

function normalizeSourceGameIdsByTeam(
  value: unknown,
): Record<string, number[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const expectedTeams = NHL_DRAFT_CLUBS
    .map((club) => club.abbreviation)
    .sort((left, right) => left.localeCompare(right));

  if (
    Object.keys(record).length !== expectedTeams.length ||
    expectedTeams.some((teamAbbreviation) => !Array.isArray(record[teamAbbreviation]))
  ) {
    return null;
  }

  const normalized: Record<string, number[]> = {};

  for (const teamAbbreviation of expectedTeams) {
    const rawGameIds = record[teamAbbreviation] as unknown[];
    const gameIds = rawGameIds.filter(
      (gameId): gameId is number =>
        typeof gameId === 'number' && Number.isSafeInteger(gameId) && gameId > 0,
    );

    if (
      gameIds.length === 0 ||
      gameIds.length !== rawGameIds.length ||
      new Set(gameIds).size !== gameIds.length
    ) {
      return null;
    }

    normalized[teamAbbreviation] = gameIds;
  }

  const length = normalized[expectedTeams[0]]?.length ?? 0;

  return expectedTeams.every(
    (teamAbbreviation) => normalized[teamAbbreviation].length === length,
  )
    ? normalized
    : null;
}

function hashSourceGamePlan(
  plan: Record<string, number[]> | null,
): string | null {
  return plan
    ? createHash('sha256').update(JSON.stringify(plan)).digest('hex')
    : null;
}

async function resolveProjectionRequestContext(
  leagueId: string,
  userId: string,
  token: Record<string, unknown>,
  generationReason: SharedProjectionGenerationReason,
  requestedTargetCycleNumber: number | null,
  requestedTargetSourceBlockNumber: number | null = null,
): Promise<{
  teamCount: number;
  requiredGamesPerCycle: number;
  targetCycleNumber: number;
  targetSourceBlockNumber: number;
  seasonWindowAnchorEvidenceHash: string | null;
  draftScheduleGeneration: number | null;
  draftScheduledStartMilliseconds: number | null;
  targetGameIdsByTeam: Record<string, number[]> | null;
  seasonWindowSourceGameIdsByTeam: Record<string, number[]> | null;
  seasonWindowSourceGamePlanHash: string | null;
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

  const privilegedReason = projectionGenerationRequiresCommissioner(generationReason);

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
  const rawDraft = draftSnapshot.data() ?? {};
  const initialNhlBlockNumber = normalizePositiveInteger(
    rawDraft['initialNhlBlockNumber'],
  );
  const anchorScheduleGeneration =
    typeof rawDraft['seasonWindowAnchorScheduleGeneration'] === 'number' &&
    Number.isSafeInteger(rawDraft['seasonWindowAnchorScheduleGeneration']) &&
    rawDraft['seasonWindowAnchorScheduleGeneration'] >= 0
      ? rawDraft['seasonWindowAnchorScheduleGeneration']
      : null;
  const draftScheduleGeneration = typeof rawDraft['scheduleGeneration'] === 'number' &&
    Number.isFinite(rawDraft['scheduleGeneration'])
    ? Math.max(0, Math.trunc(rawDraft['scheduleGeneration']))
    : 0;
  const anchorEvidenceHash = isProjectionSha256(
    rawDraft['seasonWindowAnchorEvidenceHash'],
  )
    ? rawDraft['seasonWindowAnchorEvidenceHash']
    : null;
  const requiredGamesPerCycle = getLeagueRequiredGames(league);
  const openingTargetGameIdsByTeam = normalizeAnchorTargetGameIdsByTeam(
    rawDraft['seasonWindowAnchorTeams'],
    requiredGamesPerCycle,
  );
  const seasonWindowSourceGameIdsByTeam = normalizeSourceGameIdsByTeam(
    rawDraft['seasonWindowSourceGameIdsByTeam'],
  );
  const seasonWindowSourceGamePlanHash = hashSourceGamePlan(
    seasonWindowSourceGameIdsByTeam,
  );
  const hasReadyAnchor =
    rawDraft['seasonWindowAnchorStatus'] === 'ready' &&
    initialNhlBlockNumber !== null &&
    anchorScheduleGeneration === draftScheduleGeneration &&
    anchorEvidenceHash !== null &&
    openingTargetGameIdsByTeam !== null &&
    seasonWindowSourceGameIdsByTeam !== null &&
    seasonWindowSourceGamePlanHash !== null;
  const expectedTargetSourceBlockNumber = hasReadyAnchor
    ? initialNhlBlockNumber + targetCycleNumber - 1
    : targetCycleNumber;
  let targetGameIdsByTeam: Record<string, number[]> | null = null;

  if (hasReadyAnchor) {
    try {
      targetGameIdsByTeam = buildSourceNhlTargetGameIdsByTeam(
        seasonWindowSourceGameIdsByTeam,
        expectedTargetSourceBlockNumber,
        requiredGamesPerCycle,
      );

      if (
        expectedTargetSourceBlockNumber === initialNhlBlockNumber &&
        !projectionGameIdMapsMatch(
          targetGameIdsByTeam,
          openingTargetGameIdsByTeam,
        )
      ) {
        throw new Error(
          'The frozen opening NHL source block does not match the complete source-game plan.',
        );
      }
    } catch (error: unknown) {
      throw new HttpsError(
        'failed-precondition',
        error instanceof Error
          ? error.message
          : 'The immutable NHL source-game plan is incomplete.',
      );
    }
  }

  if (
    requestedTargetSourceBlockNumber !== null &&
    requestedTargetSourceBlockNumber !== expectedTargetSourceBlockNumber
  ) {
    throw new HttpsError(
      'failed-precondition',
      'The requested NHL source block does not match this league\'s immutable season-window anchor.',
    );
  }
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
    requiredGamesPerCycle,
    targetCycleNumber,
    targetSourceBlockNumber: expectedTargetSourceBlockNumber,
    seasonWindowAnchorEvidenceHash: hasReadyAnchor
      ? anchorEvidenceHash
      : null,
    draftScheduleGeneration:
      hasReadyAnchor && draftStatus === 'scheduled'
        ? draftScheduleGeneration
        : null,
    draftScheduledStartMilliseconds:
      hasReadyAnchor && draftStatus === 'scheduled'
        ? toMilliseconds(rawDraft['scheduledStartAt']) || null
        : null,
    targetGameIdsByTeam: hasReadyAnchor ? targetGameIdsByTeam : null,
    seasonWindowSourceGameIdsByTeam: hasReadyAnchor
      ? seasonWindowSourceGameIdsByTeam
      : null,
    seasonWindowSourceGamePlanHash: hasReadyAnchor
      ? seasonWindowSourceGamePlanHash
      : null,
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
    targetSourceBlockNumber: number;
    seasonWindowAnchorEvidenceHash?: string | null;
    generationReason: SharedProjectionGenerationReason;
  },
): boolean {
  if (
    data['status'] !== 'ready' ||
    data['projectionVersion'] !== SHARED_PROJECTION_VERSION ||
    data['draftRankingVersion'] !== DRAFT_RANKING_MODEL_VERSION ||
    data['scoringRulesVersion'] !== CURRENT_SCORING_RULES_VERSION ||
    data['generatedByAuthority'] !== 'server' ||
    data['authoritySchemaVersion'] !== PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION ||
    data['catalogValidationStatus'] !== 'validated' ||
    data['snapshotHashSchemaVersion'] !== PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION ||
    data['snapshotHashAlgorithm'] !== PROJECTION_SNAPSHOT_HASH_ALGORITHM ||
    data['snapshotIntegrityStatus'] !== 'verified' ||
    !isProjectionSha256(data['snapshotContentHash']) ||
    data['teamCount'] !== input.teamCount ||
    data['requiredGamesPerCycle'] !== input.requiredGamesPerCycle ||
    data['targetCycleNumber'] !== input.targetCycleNumber ||
    (typeof data['targetSourceBlockNumber'] === 'number'
      ? data['targetSourceBlockNumber']
      : data['targetCycleNumber']) !== input.targetSourceBlockNumber ||
    (input.seasonWindowAnchorEvidenceHash
      ? data['seasonWindowAnchorEvidenceHash'] !==
        input.seasonWindowAnchorEvidenceHash
      : false)
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
    targetSourceBlockNumber?: number;
    seasonWindowAnchorEvidenceHash?: string | null;
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

  if (!isReusableProjectionPointer(data, {
    ...context,
    targetSourceBlockNumber:
      context.targetSourceBlockNumber ?? context.targetCycleNumber,
    generationReason,
  })) {
    return null;
  }

  return normalizePointerMetadata(data) as SharedProjectionSnapshotMetadata;
}


export interface ServerProjectionRefreshQueueResult {
  requestId: string;
  status: 'queued' | 'ready' | 'already-queued';
  targetCycleNumber: number;
  targetSourceBlockNumber: number;
}

interface ServerProjectionRefreshQueueInput {
  leagueId: string;
  requestedBy: string;
  requestKey: string;
  targetCycleNumber?: number | null;
  targetSourceBlockNumber?: number | null;
  seasonWindowAnchorEvidenceHash?: string | null;
  draftScheduleGeneration?: number | null;
  draftScheduledStartMilliseconds?: number | null;
  generationReason: 'manual' | 'pre-draft';
  requestPrefix: 'projection-replay' | 'projection-draft';
  availabilityRevision?: string | null;
  queuedMessage: string;
  queueErrorMessage: string;
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
async function queueServerProjectionSnapshotRefreshInternal(
  input: ServerProjectionRefreshQueueInput,
): Promise<ServerProjectionRefreshQueueResult> {
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
  const generationReason: SharedProjectionGenerationReason = input.generationReason;
  const context = await resolveProjectionRequestContext(
    leagueId,
    requestedBy,
    { platformAdmin: true },
    generationReason,
    normalizePositiveInteger(input.targetCycleNumber),
    normalizePositiveInteger(input.targetSourceBlockNumber),
  );
  const targetSourceBlockNumber = context.targetSourceBlockNumber;
  const seasonWindowAnchorEvidenceHash =
    input.seasonWindowAnchorEvidenceHash ??
    context.seasonWindowAnchorEvidenceHash;
  const draftScheduleGeneration =
    input.draftScheduleGeneration ?? context.draftScheduleGeneration;
  const draftScheduledStartMilliseconds =
    input.draftScheduledStartMilliseconds ??
    context.draftScheduledStartMilliseconds;

  if (
    generationReason === 'pre-draft' &&
    (
      !context.seasonWindowAnchorEvidenceHash ||
      seasonWindowAnchorEvidenceHash !==
        context.seasonWindowAnchorEvidenceHash ||
      !Number.isSafeInteger(draftScheduleGeneration) ||
      draftScheduleGeneration !== context.draftScheduleGeneration ||
      !Number.isSafeInteger(draftScheduledStartMilliseconds) ||
      draftScheduledStartMilliseconds !==
        context.draftScheduledStartMilliseconds ||
      !context.targetGameIdsByTeam ||
      !context.seasonWindowSourceGameIdsByTeam ||
      !context.seasonWindowSourceGamePlanHash
    )
  ) {
    throw new Error(
      'Draft projection preparation no longer matches the immutable season-window anchor.',
    );
  }
  const requestId = createServerProjectionRequestId({
    requestPrefix: input.requestPrefix,
    leagueId,
    requestKey,
    targetCycleNumber: context.targetCycleNumber,
    targetSourceBlockNumber,
    seasonWindowAnchorEvidenceHash:
      seasonWindowAnchorEvidenceHash ?? null,
    availabilityRevision: input.availabilityRevision,
  });
  const payloadHash = requestPayloadHash({
    requestId,
    leagueId,
    generationReason,
    targetCycleNumber: context.targetCycleNumber,
    targetSourceBlockNumber,
    seasonWindowAnchorEvidenceHash:
      seasonWindowAnchorEvidenceHash ?? null,
    availabilityRevision: input.availabilityRevision ?? null,
    draftScheduleGeneration,
    draftScheduledStartMilliseconds,
    seasonWindowSourceGamePlanHash:
      context.seasonWindowSourceGamePlanHash,
  }, requestedBy);
  const requestRef = getRequestRef(requestId);
  const controlRef = getControlRef(
    leagueId,
    context.targetCycleNumber,
    targetSourceBlockNumber,
  );
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
      return { status: 'ready' as const, requestId };
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
      const safeActiveRequestId = resolveSafeFirestoreDocumentId(
        activeRequestId,
        FIRESTORE_REQUEST_ID_OPTIONS,
      );
      const activeRequest = safeActiveRequestId
        ? await transaction.get(getRequestRef(safeActiveRequestId))
        : null;

      if (shouldReuseActiveProjectionRequest({
        activeRequestId,
        nextRequestId: requestId,
        activeStatus,
        activeLeaseExpiresAt,
        now,
        activePayloadHash: activeRequest?.data()?.['payloadHash'],
        nextPayloadHash: payloadHash,
      })) {
        return { status: 'already-queued' as const, requestId: activeRequestId };
      }
    }

    const requestDocument: ProjectionRequestDocument = {
      schemaVersion: PROJECTION_REQUEST_SCHEMA_VERSION,
      requestId,
      leagueId,
      requestedBy,
      generationReason,
      targetCycleNumber: context.targetCycleNumber,
      targetSourceBlockNumber,
      teamCount: context.teamCount,
      requiredGamesPerCycle: context.requiredGamesPerCycle,
      status: 'queued',
      payloadHash,
      snapshotId: null,
      message: input.queuedMessage,
      lastError: '',
      availabilityRevision: input.availabilityRevision ?? null,
      seasonWindowAnchorEvidenceHash:
        seasonWindowAnchorEvidenceHash ?? null,
      draftScheduleGeneration,
      draftScheduledStartMilliseconds,
      targetGameIdsByTeam: context.targetGameIdsByTeam,
      seasonWindowSourceGameIdsByTeam:
        context.seasonWindowSourceGameIdsByTeam,
      seasonWindowSourceGamePlanHash:
        context.seasonWindowSourceGamePlanHash,
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
      targetSourceBlockNumber,
      activeRequestId: requestId,
      status: 'queued',
      requestedBy,
      generationReason,
      availabilityRevision: input.availabilityRevision ?? null,
      seasonWindowAnchorEvidenceHash:
        seasonWindowAnchorEvidenceHash ?? null,
      draftScheduleGeneration,
      draftScheduledStartMilliseconds,
      seasonWindowSourceGamePlanHash:
        context.seasonWindowSourceGamePlanHash,
      leaseExpiresAt,
      createdAt: existingControl.exists
        ? control['createdAt'] ?? FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { status: 'queued' as const, requestId };
  });

  if (queueState.status !== 'queued') {
    return {
      requestId: queueState.requestId,
      status: queueState.status,
      targetCycleNumber: context.targetCycleNumber,
      targetSourceBlockNumber,
    };
  }

  const payload: ProjectionGenerationTaskPayload = {
    requestId,
    leagueId,
    requestedBy,
    targetCycleNumber: context.targetCycleNumber,
    targetSourceBlockNumber,
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
        : input.queueErrorMessage;

      await db.runTransaction(async (transaction) => {
        const controlSnapshot = await transaction.get(controlRef);
        const control = controlSnapshot.data() ?? {};

        transaction.set(requestRef, {
          status: 'error',
          message,
          lastError: message.slice(0, 500),
          failedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        if (shouldMutateProjectionControl(
          control['activeRequestId'],
          requestId,
        )) {
          transaction.set(controlRef, {
            status: 'error',
            lastError: message.slice(0, 500),
            leaseExpiresAt: Timestamp.fromMillis(Date.now()),
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      }).catch(() => undefined);

      throw error;
    }
  }

  return {
    requestId,
    status: 'queued',
    targetCycleNumber: context.targetCycleNumber,
    targetSourceBlockNumber,
  };
}

export async function queueServerProjectionSnapshotRefresh(input: {
  leagueId: string;
  requestedBy: string;
  requestKey: string;
  targetCycleNumber?: number | null;
}): Promise<ServerProjectionRefreshQueueResult> {
  return queueServerProjectionSnapshotRefreshInternal({
    ...input,
    generationReason: 'manual',
    requestPrefix: 'projection-replay',
    queuedMessage: 'Historical replay player-stat refresh is queued.',
    queueErrorMessage:
      'The replay player-stat refresh queue could not accept this request.',
  });
}

export async function queueServerDraftProjectionSnapshotRefresh(input: {
  leagueId: string;
  requestedBy: string;
  requestKey: string;
  availabilityRevision: string;
  targetSourceBlockNumber: number;
  seasonWindowAnchorEvidenceHash: string;
  draftScheduleGeneration: number;
  draftScheduledStartMilliseconds: number;
}): Promise<ServerProjectionRefreshQueueResult> {
  if (!/^[a-f0-9]{64}$/.test(input.availabilityRevision)) {
    throw new Error('Draft readiness requires a valid player-availability revision.');
  }

  if (
    !Number.isSafeInteger(input.targetSourceBlockNumber) ||
    input.targetSourceBlockNumber < 1 ||
    !/^[a-f0-9]{64}$/.test(input.seasonWindowAnchorEvidenceHash) ||
    !Number.isSafeInteger(input.draftScheduleGeneration) ||
    input.draftScheduleGeneration < 0 ||
    !Number.isSafeInteger(input.draftScheduledStartMilliseconds) ||
    input.draftScheduledStartMilliseconds <= 0
  ) {
    throw new Error('Draft readiness requires immutable season-window anchor evidence.');
  }

  return queueServerProjectionSnapshotRefreshInternal({
    ...input,
    targetCycleNumber: 1,
    targetSourceBlockNumber: input.targetSourceBlockNumber,
    seasonWindowAnchorEvidenceHash: input.seasonWindowAnchorEvidenceHash,
    generationReason: 'pre-draft',
    requestPrefix: 'projection-draft',
    queuedMessage:
      `Projection V${SHARED_PROJECTION_VERSION} Draft readiness is queued.`,
    queueErrorMessage:
      `The Projection V${SHARED_PROJECTION_VERSION} Draft-readiness queue could not accept this request.`,
  });
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

    const expectedScoringRulesVersion = normalizeLeagueScoringRulesVersion(
      leagueSnapshot.data()?.['scoringRulesVersion'],
    );
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
          normalizeLeagueScoringRulesVersion(data['scoringRulesVersion']) ===
            expectedScoringRulesVersion &&
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

    if (!isIntegrityVerifiedSnapshot(snapshot, expectedScoringRulesVersion)) {
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

    if (!isIntegrityVerifiedSnapshot(snapshot, expectedScoringRulesVersion)) {
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
    const requestedTargetSourceBlockNumber = normalizePositiveInteger(
      data['targetSourceBlockNumber'],
    );
    const context = await resolveProjectionRequestContext(
      leagueId,
      userId,
      request.auth?.token ?? {},
      generationReason,
      requestedTargetCycleNumber,
      requestedTargetSourceBlockNumber,
    );
    const payloadHash = requestPayloadHash({
      requestId,
      leagueId,
      generationReason,
      targetCycleNumber: context.targetCycleNumber,
      targetSourceBlockNumber: context.targetSourceBlockNumber,
      seasonWindowAnchorEvidenceHash:
        context.seasonWindowAnchorEvidenceHash,
      draftScheduleGeneration: context.draftScheduleGeneration,
      draftScheduledStartMilliseconds:
        context.draftScheduledStartMilliseconds,
      seasonWindowSourceGamePlanHash:
        context.seasonWindowSourceGamePlanHash,
    }, userId);
    const reusable = await findReusableProjection(leagueId, context, generationReason);

    if (reusable) {
      return {
        requestId,
        status: 'ready',
        snapshotId: reusable.activeSnapshotId,
        targetCycleNumber: context.targetCycleNumber,
        targetSourceBlockNumber: context.targetSourceBlockNumber,
        message: 'Using the newest server-validated Projection V11 snapshot.',
        reusedFreshSnapshot: true,
      };
    }

    const requestRef = getRequestRef(requestId);
    const controlRef = getControlRef(
      leagueId,
      context.targetCycleNumber,
      context.targetSourceBlockNumber,
    );
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
        const safeActiveRequestId = resolveSafeFirestoreDocumentId(
          activeRequestId,
          FIRESTORE_REQUEST_ID_OPTIONS,
        );
        const activeRequest = safeActiveRequestId
          ? await transaction.get(getRequestRef(safeActiveRequestId))
          : null;

        if (shouldReuseActiveProjectionRequest({
          activeRequestId,
          nextRequestId: requestId,
          activeStatus,
          activeLeaseExpiresAt,
          now,
          activePayloadHash: activeRequest?.data()?.['payloadHash'],
          nextPayloadHash: payloadHash,
        })) {
          return {
            requestId: activeRequestId,
            alreadyQueued: true,
          };
        }
      }

      const requestDocument: ProjectionRequestDocument = {
        schemaVersion: PROJECTION_REQUEST_SCHEMA_VERSION,
        requestId,
        leagueId,
        requestedBy: userId,
        generationReason,
        targetCycleNumber: context.targetCycleNumber,
        targetSourceBlockNumber: context.targetSourceBlockNumber,
        teamCount: context.teamCount,
        requiredGamesPerCycle: context.requiredGamesPerCycle,
        status: 'queued',
        payloadHash,
        snapshotId: null,
        message: 'Projection generation is queued.',
        lastError: '',
        seasonWindowAnchorEvidenceHash:
          context.seasonWindowAnchorEvidenceHash,
        draftScheduleGeneration: context.draftScheduleGeneration,
        draftScheduledStartMilliseconds:
          context.draftScheduledStartMilliseconds,
        targetGameIdsByTeam: context.targetGameIdsByTeam,
        seasonWindowSourceGameIdsByTeam:
          context.seasonWindowSourceGameIdsByTeam,
        seasonWindowSourceGamePlanHash:
          context.seasonWindowSourceGamePlanHash,
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
        targetSourceBlockNumber: context.targetSourceBlockNumber,
        activeRequestId: requestId,
        status: 'queued',
        requestedBy: userId,
        generationReason,
        seasonWindowAnchorEvidenceHash:
          context.seasonWindowAnchorEvidenceHash,
        draftScheduleGeneration: context.draftScheduleGeneration,
        draftScheduledStartMilliseconds:
          context.draftScheduledStartMilliseconds,
        seasonWindowSourceGamePlanHash:
          context.seasonWindowSourceGamePlanHash,
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
      targetSourceBlockNumber: context.targetSourceBlockNumber,
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

          const failedRequestRef = getRequestRef(queued.requestId);

          await db.runTransaction(async (transaction) => {
            const controlSnapshot = await transaction.get(controlRef);
            const control = controlSnapshot.data() ?? {};

            transaction.set(failedRequestRef, {
              status: 'error',
              message,
              lastError: message.slice(0, 500),
              failedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });

            if (shouldMutateProjectionControl(
              control['activeRequestId'],
              queued.requestId,
            )) {
              transaction.set(controlRef, {
                status: 'error',
                lastError: message.slice(0, 500),
                leaseExpiresAt: Timestamp.fromMillis(Date.now()),
                updatedAt: FieldValue.serverTimestamp(),
              }, { merge: true });
            }
          }).catch(() => undefined);

          throw new HttpsError('unavailable', message);
        }
      }
    }

    return {
      requestId: queued.requestId,
      status: 'queued',
      snapshotId: null,
      targetCycleNumber: context.targetCycleNumber,
      targetSourceBlockNumber: context.targetSourceBlockNumber,
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
      payload.targetCycleNumber < 1 ||
      (
        payload.targetSourceBlockNumber !== undefined &&
        (
          !Number.isFinite(payload.targetSourceBlockNumber) ||
          payload.targetSourceBlockNumber < 1
        )
      )
    ) {
      console.warn('Ignored malformed projection generation task.', { payload });
      return;
    }

    const targetSourceBlockNumber = normalizePositiveInteger(
      payload.targetSourceBlockNumber,
    ) ?? payload.targetCycleNumber;
    const requestRef = getRequestRef(requestId);
    const controlRef = getControlRef(
      leagueId,
      payload.targetCycleNumber,
      targetSourceBlockNumber,
    );
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
        (normalizePositiveInteger(requestData['targetSourceBlockNumber']) ??
          payload.targetCycleNumber) !== targetSourceBlockNumber ||
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
        targetSourceBlockNumber,
        ...(claimed.seasonWindowAnchorEvidenceHash
          ? {
              seasonWindowAnchorEvidenceHash:
                claimed.seasonWindowAnchorEvidenceHash,
            }
          : {}),
        ...(claimed.targetGameIdsByTeam
          ? { targetGameIdsByTeam: claimed.targetGameIdsByTeam }
          : {}),
        requestedBy: claimed.requestedBy,
        generationRequestId: claimed.requestId,
        publishPointers: false,
        ...(claimed.availabilityRevision
          ? { expectedAvailabilityRevision: claimed.availabilityRevision }
          : {}),
      });
      const durationMilliseconds = Date.now() - startedAt;
      const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
      const targetPointerRef = db.doc(
        `leagues/${leagueId}/projectionSnapshots/target-cycle-${claimed.targetCycleNumber}`,
      );
      const currentPointerRef = db.doc(
        `leagues/${leagueId}/projectionSnapshots/current`,
      );
      const pointerMetadata = Object.fromEntries(
        Object.entries(snapshot.metadata).filter(([, value]) => value !== undefined),
      );
      const published = await db.runTransaction(async (transaction) => {
        const [latestRequestSnapshot, latestControlSnapshot, latestDraftSnapshot] =
          await Promise.all([
            transaction.get(requestRef),
            transaction.get(controlRef),
            transaction.get(draftRef),
          ]);
        const latestRequest = latestRequestSnapshot.data() ?? {};
        const latestControl = latestControlSnapshot.data() ?? {};
        const latestDraft = latestDraftSnapshot.data() ?? {};
        const requiresDraftScheduleBinding =
          Boolean(claimed.seasonWindowAnchorEvidenceHash) &&
          (
            claimed.generationReason === 'pre-draft' ||
            typeof claimed.draftScheduleGeneration === 'number' ||
            typeof claimed.draftScheduledStartMilliseconds === 'number'
          );
        const latestAnchorTargets = normalizeAnchorTargetGameIdsByTeam(
          latestDraft['seasonWindowAnchorTeams'],
          claimed.requiredGamesPerCycle,
        );
        const latestRequestSourceGamePlan = normalizeSourceGameIdsByTeam(
          latestRequest['seasonWindowSourceGameIdsByTeam'],
        );
        const latestDraftSourceGamePlan = normalizeSourceGameIdsByTeam(
          latestDraft['seasonWindowSourceGameIdsByTeam'],
        );
        const claimedSourceGamePlan = claimed.seasonWindowSourceGameIdsByTeam
          ? normalizeSourceGameIdsByTeam(
              claimed.seasonWindowSourceGameIdsByTeam,
            )
          : null;
        const claimedSourceGamePlanHash =
          claimed.seasonWindowSourceGamePlanHash ?? null;
        const canPublish = shouldPublishProjectionResult({
          requestExists: latestRequestSnapshot.exists,
          requestStatus: latestRequest['status'],
          requestLeagueId: latestRequest['leagueId'],
          requestRequestedBy: latestRequest['requestedBy'],
          requestTargetCycleNumber: latestRequest['targetCycleNumber'],
          requestTargetSourceBlockNumber:
            normalizePositiveInteger(latestRequest['targetSourceBlockNumber']) ??
            claimed.targetCycleNumber,
          requestSeasonWindowAnchorEvidenceHash:
            latestRequest['seasonWindowAnchorEvidenceHash'],
          requestTargetGameIdsMatch: projectionGameIdMapsMatch(
            latestRequest['targetGameIdsByTeam'] as Record<string, number[]> | null,
            claimed.targetGameIdsByTeam,
          ),
          requestSourceGamePlanMatches:
            projectionGameIdMapsMatch(
              latestRequestSourceGamePlan,
              claimedSourceGamePlan,
            ) &&
            (latestRequest['seasonWindowSourceGamePlanHash'] ?? null) ===
              claimedSourceGamePlanHash &&
            hashSourceGamePlan(latestRequestSourceGamePlan) ===
              claimedSourceGamePlanHash,
          activeRequestId: latestControl['activeRequestId'],
          expectedRequestId: requestId,
          expectedLeagueId: leagueId,
          expectedRequestedBy: requestedBy,
          expectedTargetCycleNumber: claimed.targetCycleNumber,
          expectedTargetSourceBlockNumber: targetSourceBlockNumber,
          expectedSeasonWindowAnchorEvidenceHash:
            claimed.seasonWindowAnchorEvidenceHash ?? null,
          requiresDraftScheduleBinding,
          draftExists: latestDraftSnapshot.exists,
          draftStatus: latestDraft['status'],
          expectedDraftScheduleGeneration:
            claimed.draftScheduleGeneration ?? null,
          expectedDraftScheduledStartMilliseconds:
            claimed.draftScheduledStartMilliseconds ?? null,
          draftScheduleGeneration: latestDraft['scheduleGeneration'],
          draftScheduledStartMilliseconds:
            toMilliseconds(latestDraft['scheduledStartAt']),
          draftAnchorScheduleGeneration:
            latestDraft['seasonWindowAnchorScheduleGeneration'],
          draftAnchorStatus: latestDraft['seasonWindowAnchorStatus'],
          draftInitialNhlBlockNumber: latestDraft['initialNhlBlockNumber'],
          draftSeasonWindowAnchorEvidenceHash:
            latestDraft['seasonWindowAnchorEvidenceHash'],
          draftTargetGameIdsMatch: projectionGameIdMapsMatch(
            latestAnchorTargets,
            claimed.targetGameIdsByTeam,
          ),
          draftSourceGamePlanMatches:
            projectionGameIdMapsMatch(
              latestDraftSourceGamePlan,
              claimedSourceGamePlan,
            ) &&
            hashSourceGamePlan(latestDraftSourceGamePlan) ===
              claimedSourceGamePlanHash,
          generationReason: claimed.generationReason,
        });

        if (!canPublish) {
          if (
            latestRequestSnapshot.exists &&
            latestRequest['status'] === 'processing'
          ) {
            transaction.set(requestRef, {
              status: 'error',
              message:
                'Projection generation finished after the active Draft schedule or request changed. The immutable result was retained but was not published.',
              lastError: 'Stale projection publication rejected.',
              unpublishedSnapshotId: snapshot.metadata.activeSnapshotId,
              failedAt: FieldValue.serverTimestamp(),
              durationMilliseconds,
              leaseExpiresAt: Timestamp.fromMillis(Date.now()),
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
          }

          if (shouldMutateProjectionControl(
            latestControl['activeRequestId'],
            requestId,
          )) {
            transaction.set(controlRef, {
              status: 'error',
              lastError: 'Stale projection publication rejected.',
              lastFailedAt: FieldValue.serverTimestamp(),
              lastDurationMilliseconds: durationMilliseconds,
              leaseExpiresAt: Timestamp.fromMillis(Date.now()),
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
          }

          return false;
        }

        const pointerPayload = {
          ...pointerMetadata,
          generatedAtServer: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };

        transaction.set(targetPointerRef, pointerPayload);

        if (claimed.generationReason !== 'window-boundary') {
          transaction.set(currentPointerRef, pointerPayload);
        }

        transaction.set(requestRef, {
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
          snapshotHashSchemaVersion:
            snapshot.metadata.snapshotHashSchemaVersion ?? null,
          snapshotChunkCount:
            snapshot.metadata.snapshotChunkHashes?.length ?? null,
          leaseExpiresAt: Timestamp.fromMillis(Date.now()),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(controlRef, {
          status: 'ready',
          activeRequestId: requestId,
          lastSnapshotId: snapshot.metadata.activeSnapshotId,
          lastSnapshotContentHash: snapshot.metadata.snapshotContentHash ?? null,
          lastCompletedAt: FieldValue.serverTimestamp(),
          lastDurationMilliseconds: durationMilliseconds,
          lastError: '',
          leaseExpiresAt: Timestamp.fromMillis(Date.now()),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        return true;
      });

      if (!published) {
        console.warn('Projection result was retained but not published after a stale-request compare-and-set.', {
          leagueId,
          requestId,
          targetCycleNumber: claimed.targetCycleNumber,
          targetSourceBlockNumber,
          snapshotId: snapshot.metadata.activeSnapshotId,
        });
        return;
      }

      await db.doc('appData/projectionGeneration').set({
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
      }, { merge: true });


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

      const failureWasActive = await db.runTransaction(async (transaction) => {
        const [latestRequestSnapshot, latestControlSnapshot] =
          await Promise.all([
            transaction.get(requestRef),
            transaction.get(controlRef),
          ]);
        const latestRequest = latestRequestSnapshot.data() ?? {};
        const latestControl = latestControlSnapshot.data() ?? {};

        if (
          latestRequestSnapshot.exists &&
          latestRequest['status'] !== 'ready'
        ) {
          transaction.set(requestRef, {
            status: 'error',
            message,
            lastError: message.slice(0, 500),
            failedAt: FieldValue.serverTimestamp(),
            durationMilliseconds,
            leaseExpiresAt: Timestamp.fromMillis(Date.now()),
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        const controlStillBelongsToRequest = shouldMutateProjectionControl(
          latestControl['activeRequestId'],
          requestId,
        );

        if (controlStillBelongsToRequest) {
          transaction.set(controlRef, {
            status: 'error',
            lastError: message.slice(0, 500),
            lastFailedAt: FieldValue.serverTimestamp(),
            lastDurationMilliseconds: durationMilliseconds,
            leaseExpiresAt: Timestamp.fromMillis(Date.now()),
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        return controlStillBelongsToRequest;
      }).catch(() => false);

      if (failureWasActive) {
        await db.doc('appData/projectionGeneration').set({
          schemaVersion: PROJECTION_REQUEST_SCHEMA_VERSION,
          lastStatus: 'error',
          lastLeagueId: leagueId,
          lastTargetCycleNumber: payload.targetCycleNumber,
          lastError: message.slice(0, 500),
          lastDurationMilliseconds: durationMilliseconds,
          failedGenerationCount: FieldValue.increment(1),
          lastFailedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }).catch(() => undefined);
      }

      console.error('Projection generation task failed.', {
        leagueId: leagueId,
        targetCycleNumber: payload.targetCycleNumber,
        requestId: requestId,
        error,
      });
    }
  },
);

function projectionGenerationRecoveryState(
  data: DocumentData,
): ProjectionGenerationRecoveryState {
  return {
    status: asString(data['status']),
    leaseExpiresAtMilliseconds: toMilliseconds(data['leaseExpiresAt']),
    activeRequestId: asString(data['activeRequestId']),
  };
}

async function recoverProjectionGenerationCandidate(
  candidate: QueryDocumentSnapshot<DocumentData>,
  cutoffMilliseconds: number,
  recoveredAt: Timestamp,
): Promise<'skip' | 'cleanup-terminal' | 'recover-active'> {
  const candidateState = projectionGenerationRecoveryState(candidate.data());

  return db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(candidate.ref);

    if (!currentSnapshot.exists) {
      return 'skip';
    }

    const current = currentSnapshot.data() ?? {};
    const currentState = projectionGenerationRecoveryState(current);
    const action = getProjectionGenerationRecoveryAction({
      candidate: candidateState,
      current: currentState,
      cutoffMilliseconds,
    });

    if (action === 'skip') {
      return action;
    }

    if (action === 'cleanup-terminal') {
      transaction.update(candidate.ref, {
        leaseExpiresAt: FieldValue.delete(),
      });
      return action;
    }

    const safeActiveRequestId = resolveSafeFirestoreDocumentId(
      currentState.activeRequestId,
      FIRESTORE_REQUEST_ID_OPTIONS,
    );
    const requestRef = safeActiveRequestId
      ? getRequestRef(safeActiveRequestId)
      : null;
    const requestSnapshot = requestRef
      ? await transaction.get(requestRef)
      : null;
    const message = 'The projection worker stopped reporting progress. Retry the refresh.';

    transaction.set(candidate.ref, {
      status: 'error',
      lastError: message,
      recoveredAt: FieldValue.serverTimestamp(),
      leaseExpiresAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    if (
      safeActiveRequestId &&
      requestRef &&
      requestSnapshot &&
      shouldRecoverProjectionGenerationRequest({
        exists: requestSnapshot.exists,
        status: requestSnapshot.data()?.['status'],
        documentRequestId: requestSnapshot.data()?.['requestId'],
        expectedRequestId: safeActiveRequestId,
      })
    ) {
      transaction.set(requestRef, {
        status: 'error',
        message,
        lastError: message,
        recoveredAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: recoveredAt,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    transaction.set(db.doc('appData/projectionGeneration'), {
      staleRecoveryCount: FieldValue.increment(1),
      lastRecoveryAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return action;
  });
}

export const recoverStaleProjectionGenerationRequests = onSchedule(
  {
    region: FUNCTION_REGION,
    schedule: 'every 5 minutes',
    timeoutSeconds: 60,
    memory: '256MiB',
    maxInstances: 1,
  },
  async () => {
    const now = Date.now();
    const cutoffMilliseconds = now - PROJECTION_REQUEST_STALE_MILLISECONDS;
    const cutoff = Timestamp.fromMillis(cutoffMilliseconds);
    const snapshot = await db
      .collection('projectionGenerationControls')
      .where('leaseExpiresAt', '<=', cutoff)
      .orderBy('leaseExpiresAt', 'asc')
      .limit(PROJECTION_STALE_SWEEP_LIMIT)
      .get();

    if (snapshot.empty) {
      return;
    }

    for (
      let offset = 0;
      offset < snapshot.docs.length;
      offset += PROJECTION_STALE_RECOVERY_CONCURRENCY
    ) {
      await Promise.all(
        snapshot.docs
          .slice(offset, offset + PROJECTION_STALE_RECOVERY_CONCURRENCY)
          .map((candidate) => recoverProjectionGenerationCandidate(
            candidate,
            cutoffMilliseconds,
            Timestamp.fromMillis(now),
          )),
      );
    }
  },
);
