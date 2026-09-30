import { createHash } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { enforceAppCheckCallableCanaryForLeague } from './app-check-canary-authority';
import { db } from './shared/core/firebase';
import {
  DraftQueue,
  DraftPick,
  DraftRosterRequirements,
  FantasyDraft,
} from './shared/core/draft/draft.models';
import {
  SHARED_PROJECTION_VERSION,
} from './shared/core/projection/projection-snapshot.service';
import {
  isProjectionSha256,
  PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
} from './shared/core/projection/projection-snapshot-hash.util';
import { FantasyRoster } from './shared/core/team/roster.models';
import {
  createEmptyFantasyRoster,
  normalizeFantasyRoster,
} from './shared/core/team/roster.service';
import {
  applyDraftAssetToRoster,
  canUseAssetForBench,
  getDraftDestination,
  getDraftPickAtOverall,
  getDraftTotalPickCount,
  hasExactDraftOwnerSet,
  rosterContainsDraftAsset,
} from './draft-pick-engine';
import {
  ensureCurrentDraftClockTask,
  loadPreparedProjectionSnapshotForScheduledDraft,
  loadProjectionSnapshotForDraft,
  repairDraftTurnFromCommittedPicks,
} from './draft-automation';
import {
  LEAGUE_AUDIT_SCHEMA_VERSION,
  LEAGUE_AUTHORITY_SCHEMA_VERSION,
} from './league-lifecycle-authority.util';
import {
  type DraftOrderMode,
  draftFinalizationMatchesParticipants,
  isDraftMembershipCutoffReached,
  isDraftMembershipLocked,
} from './draft-lifecycle.util';
import { requireRecentAuthentication } from './shared/security/auth-security.util';
import {
  requireFirestoreDocumentId,
  resolveSafeFirestoreDocumentId,
} from './shared/security/firestore-document-id.util';
import {
  FIRESTORE_AUTH_USER_ID_OPTIONS,
  FIRESTORE_INVITE_CODE_OPTIONS,
} from './shared/security/firestore-document-id-policies';
import {
  getDraftNearTermScheduleGateState,
  getEarliestSafeUnpreparedDraftStartMilliseconds,
} from './draft-readiness.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';
import {
  validateSeasonWindowSourcePlan,
} from './shared/core/draft/season-window-source-plan.util';
import { NHL_DRAFT_CLUBS } from './shared/core/nhl/nhl-api.service';

const FUNCTION_REGION = 'us-central1';
const DRAFT_DOCUMENT_PATH_SUFFIX = 'draft/current';
const DEFAULT_DRAFT_PICK_SECONDS = 60;
const ALLOWED_PICK_SECONDS = new Set([30, 45, 60, 90, 120]);
const DEFAULT_ROSTER_REQUIREMENTS: DraftRosterRequirements = {
  LW: 3,
  C: 3,
  RW: 3,
  D: 4,
  G: 1,
};
const DEFAULT_BENCH_SLOTS = 3;
const DEFAULT_TOTAL_ROUNDS = 17;
const MAX_LEAGUE_TEAMS = 32;

function getLeagueRequiredGamesPerCycle(data: Record<string, unknown>): number {
  const scoringRules = data['scoringRules'];
  const nested = scoringRules && typeof scoringRules === 'object'
    ? (scoringRules as Record<string, unknown>)['requiredGamesPerCycle']
    : undefined;
  const value = typeof nested === 'number'
    ? nested
    : data['requiredGamesPerCycle'];

  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 6;
}
const MAX_ASSET_KEY_LENGTH = 180;
const MAX_DRAFT_SUBMISSION_ID_LENGTH = 120;

export type DraftCommandAction =
  | 'save-settings'
  | 'cancel-schedule'
  | 'postpone-reopen'
  | 'activate-scheduled'
  | 'start-clock'
  | 'pause-clock'
  | 'resume-clock';

interface DraftCommandRequest {
  leagueId?: unknown;
  action?: unknown;
  submissionId?: unknown;
  expectedSettingsSubmissionId?: unknown;
  roundOneOrder?: unknown;
  orderMode?: unknown;
  scheduledStartAt?: unknown;
  pickSeconds?: unknown;
}

interface DraftCommandResult {
  applied: true;
  action: DraftCommandAction;
  message: string;
  submissionId?: string | null;
}

interface SecureDraftPickRequest {
  leagueId?: unknown;
  assetKey?: unknown;
  submissionId?: unknown;
  expectedOverallPick?: unknown;
}

export interface SecureDraftPickResult {
  pick: DraftPick;
}

interface RepairDraftTurnHandoffRequest {
  leagueId?: unknown;
}

export interface RepairDraftTurnHandoffResult {
  repaired: boolean;
  status: FantasyDraft['status'];
  nextOverallPick: number;
  currentOwnerId: string | null;
  clockTaskScheduled: boolean;
  message: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requireLeagueId(value: unknown): string {
  return requireFirestoreDocumentId(value, 'league ID', {
    minimumLength: 3,
    maxBytes: 120,
    pattern: /^[A-Za-z0-9_-]+$/,
  });
}

function requireAssetKey(value: unknown): string {
  return requireFirestoreDocumentId(value, 'draft asset', {
    minimumLength: 2,
    maxBytes: MAX_ASSET_KEY_LENGTH,
    pattern: /^[A-Za-z0-9:._-]+$/,
  });
}

function getOptionalDraftSubmissionId(value: unknown): string | null {
  const submissionId = asString(value);

  // Keep one deployment window backward-compatible with older open tabs.
  // The new client always supplies an idempotency key, while a legacy client
  // can still complete its current turn before Hosting asks it to reload.
  if (!submissionId) {
    return null;
  }

  return requireFirestoreDocumentId(submissionId, 'draft submission identifier', {
    minimumLength: 8,
    maxBytes: MAX_DRAFT_SUBMISSION_ID_LENGTH,
    pattern: /^[A-Za-z0-9_-]+$/,
  });
}

function getExpectedSettingsSubmissionId(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const submissionId = asString(value);

  if (!submissionId) {
    throw new HttpsError(
      'failed-precondition',
      'Draft Setup is out of date. Refresh before changing the schedule.',
      { reason: 'draft-settings-revision-required' },
    );
  }

  return requireFirestoreDocumentId(submissionId, 'prior draft settings identifier', {
    minimumLength: 8,
    maxBytes: MAX_DRAFT_SUBMISSION_ID_LENGTH,
    pattern: /^[A-Za-z0-9_-]+$/,
  });
}

function parseDraftOrderMode(value: unknown): DraftOrderMode {
  // Older Hosting revisions saved an explicit order without a mode. During a
  // targeted Functions-first rollout, preserve that exact order as custom.
  if (value === undefined || value === null || value === '') {
    return 'custom';
  }

  if (value === 'randomized' || value === 'custom' || value === 'legacy-custom') {
    return value;
  }

  throw new HttpsError('invalid-argument', 'Choose randomized or custom draft order.');
}

function getOptionalExpectedOverallPick(value: unknown): number | null {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }

  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > 10_000) {
    throw new HttpsError(
      'invalid-argument',
      'The expected draft pick number is invalid. Refresh the Draft Room and try again.',
    );
  }

  return Number(value);
}

function draftPickMatchesSubmission(
  pick: DraftPick,
  input: {
    submissionId: string | null;
    expectedOverallPick: number;
    assetKey: string;
    userId: string;
  },
): boolean {
  if (!input.submissionId) {
    return false;
  }

  return (
    pick.overallPick === input.expectedOverallPick &&
    pick.asset?.assetKey === input.assetKey &&
    pick.submissionId === input.submissionId &&
    (pick.ownerId === input.userId || pick.selectedByUserId === input.userId)
  );
}

function requireAuthenticatedUserId(auth: { uid?: string } | undefined): string {
  const userId = asString(auth?.uid);

  if (!userId) {
    throw new HttpsError('unauthenticated', 'Sign in before changing the draft.');
  }

  return requireFirestoreDocumentId(userId, 'manager ID', { maxBytes: 128 });
}

function normalizePickSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(10 * 60, Math.max(15, Math.ceil(value)))
    : DEFAULT_DRAFT_PICK_SECONDS;
}

function normalizeSeasonWindowSourceGameIdsByTeam(
  value: unknown,
): Record<string, number[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const normalized: Record<string, number[]> = {};

  for (const [teamAbbreviation, rawGameIds] of Object.entries(value)) {
    if (!/^[A-Z0-9]{2,4}$/.test(teamAbbreviation) || !Array.isArray(rawGameIds)) {
      return null;
    }

    const gameIds = rawGameIds.filter(
      (gameId): gameId is number =>
        typeof gameId === 'number' && Number.isSafeInteger(gameId) && gameId > 0,
    );

    if (gameIds.length !== rawGameIds.length || new Set(gameIds).size !== gameIds.length) {
      return null;
    }

    normalized[teamAbbreviation] = gameIds;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeDraft(value: Partial<FantasyDraft>): FantasyDraft {
  const scheduledStartAt = value.scheduledStartAt ?? null;
  const status = value.status ?? (scheduledStartAt ? 'scheduled' : 'setup');
  const pickSeconds = normalizePickSeconds(value.pickSeconds);

  return {
    schemaVersion:
      typeof value.schemaVersion === 'number' && Number.isFinite(value.schemaVersion)
        ? Math.max(1, Math.trunc(value.schemaVersion))
        : 3,
    status,
    format: 'snake',
    totalRounds:
      typeof value.totalRounds === 'number' && Number.isFinite(value.totalRounds)
        ? Math.max(1, Math.trunc(value.totalRounds))
        : DEFAULT_TOTAL_ROUNDS,
    rosterRequirements: value.rosterRequirements ?? DEFAULT_ROSTER_REQUIREMENTS,
    benchSlots:
      typeof value.benchSlots === 'number' && Number.isFinite(value.benchSlots)
        ? Math.max(0, Math.trunc(value.benchSlots))
        : DEFAULT_BENCH_SLOTS,
    roundOneOrder: Array.isArray(value.roundOneOrder)
      ? value.roundOneOrder
          .map((entry) =>
            resolveSafeFirestoreDocumentId(entry, FIRESTORE_AUTH_USER_ID_OPTIONS),
          )
          .filter((entry): entry is string => entry !== null)
      : [],
    nextOverallPick:
      typeof value.nextOverallPick === 'number' && Number.isFinite(value.nextOverallPick)
        ? Math.max(1, Math.trunc(value.nextOverallPick))
        : 1,
    draftedAssetKeys: Array.isArray(value.draftedAssetKeys)
      ? value.draftedAssetKeys.filter((entry): entry is string => typeof entry === 'string')
      : [],
    scheduledStartAt,
    pickSeconds,
    clockStatus:
      value.clockStatus ??
      (status === 'complete' ? 'complete' : status === 'live' ? 'running' : 'stopped'),
    pickStartedAt: value.pickStartedAt ?? null,
    currentPickSeconds:
      typeof value.currentPickSeconds === 'number' && Number.isFinite(value.currentPickSeconds)
        ? Math.min(pickSeconds, Math.max(1, Math.ceil(value.currentPickSeconds)))
        : pickSeconds,
    pausedRemainingSeconds:
      typeof value.pausedRemainingSeconds === 'number' && Number.isFinite(value.pausedRemainingSeconds)
        ? Math.min(pickSeconds, Math.max(0, Math.ceil(value.pausedRemainingSeconds)))
        : null,
    clockUpdatedBy: value.clockUpdatedBy ?? null,
    clockUpdatedAt: value.clockUpdatedAt,
    lastPickId: value.lastPickId ?? null,
    lastSettingsSubmissionId:
      typeof value.lastSettingsSubmissionId === 'string'
        ? value.lastSettingsSubmissionId
        : null,
    orderMode:
      value.orderMode === 'randomized' || value.orderMode === 'custom' ||
      value.orderMode === 'legacy-custom'
        ? value.orderMode
        : 'legacy-custom',
    scheduleGeneration:
      typeof value.scheduleGeneration === 'number' && Number.isFinite(value.scheduleGeneration)
        ? Math.max(0, Math.trunc(value.scheduleGeneration))
        : 0,
    initialNhlBlockNumber:
      typeof value.initialNhlBlockNumber === 'number' &&
      Number.isFinite(value.initialNhlBlockNumber)
        ? Math.max(1, Math.trunc(value.initialNhlBlockNumber))
        : null,
    seasonWindowAnchorStatus:
      value.seasonWindowAnchorStatus === 'pending' ||
      value.seasonWindowAnchorStatus === 'ready' ||
      value.seasonWindowAnchorStatus === 'error'
        ? value.seasonWindowAnchorStatus
        : null,
    seasonWindowAnchorSeason:
      typeof value.seasonWindowAnchorSeason === 'string'
        ? value.seasonWindowAnchorSeason
        : null,
    seasonWindowAnchorScheduleGeneration:
      typeof value.seasonWindowAnchorScheduleGeneration === 'number' &&
      Number.isFinite(value.seasonWindowAnchorScheduleGeneration)
        ? Math.max(0, Math.trunc(value.seasonWindowAnchorScheduleGeneration))
        : null,
    seasonWindowAnchorEvidenceHash:
      typeof value.seasonWindowAnchorEvidenceHash === 'string'
        ? value.seasonWindowAnchorEvidenceHash
        : null,
    seasonWindowAnchorEvidenceHashAlgorithm:
      value.seasonWindowAnchorEvidenceHashAlgorithm === 'sha256'
        ? 'sha256'
        : null,
    seasonWindowAnchorFinalPrefixGameCount:
      typeof value.seasonWindowAnchorFinalPrefixGameCount === 'number' &&
      Number.isFinite(value.seasonWindowAnchorFinalPrefixGameCount)
        ? Math.max(0, Math.trunc(value.seasonWindowAnchorFinalPrefixGameCount))
        : null,
    seasonWindowAnchorSourceGameStart:
      typeof value.seasonWindowAnchorSourceGameStart === 'number' &&
      Number.isFinite(value.seasonWindowAnchorSourceGameStart)
        ? Math.max(1, Math.trunc(value.seasonWindowAnchorSourceGameStart))
        : null,
    seasonWindowAnchorSourceGameEnd:
      typeof value.seasonWindowAnchorSourceGameEnd === 'number' &&
      Number.isFinite(value.seasonWindowAnchorSourceGameEnd)
        ? Math.max(1, Math.trunc(value.seasonWindowAnchorSourceGameEnd))
        : null,
    seasonWindowAnchorTeams: Array.isArray(value.seasonWindowAnchorTeams)
      ? value.seasonWindowAnchorTeams
      : null,
    seasonWindowSourceGameIdsByTeam:
      normalizeSeasonWindowSourceGameIdsByTeam(
        value.seasonWindowSourceGameIdsByTeam,
      ),
    seasonWindowAnchorUpdatedAt: value.seasonWindowAnchorUpdatedAt,
    seasonWindowAnchorFrozenAt: value.seasonWindowAnchorFrozenAt,
    seasonWindowAnchorLastError:
      typeof value.seasonWindowAnchorLastError === 'string'
        ? value.seasonWindowAnchorLastError
        : null,
    orderEpoch:
      typeof value.orderEpoch === 'number' && Number.isFinite(value.orderEpoch)
        ? Math.max(0, Math.trunc(value.orderEpoch))
        : 0,
    membershipLockStatus:
      value.membershipLockStatus === 'open' || value.membershipLockStatus === 'locked'
        ? value.membershipLockStatus
        : undefined,
    membershipLockedAt: value.membershipLockedAt ?? null,
    orderFinalizedAt: value.orderFinalizedAt ?? null,
    orderParticipantHash:
      typeof value.orderParticipantHash === 'string' ? value.orderParticipantHash : null,
    finalizedScheduleGeneration:
      typeof value.finalizedScheduleGeneration === 'number' &&
      Number.isFinite(value.finalizedScheduleGeneration)
        ? Math.max(0, Math.trunc(value.finalizedScheduleGeneration))
        : null,
    orderRandomizationSeedHash:
      typeof value.orderRandomizationSeedHash === 'string'
        ? value.orderRandomizationSeedHash
        : null,
    serverDraftReadinessScheduleGeneration:
      typeof value.serverDraftReadinessScheduleGeneration === 'number' &&
      Number.isFinite(value.serverDraftReadinessScheduleGeneration)
        ? Math.max(0, Math.trunc(value.serverDraftReadinessScheduleGeneration))
        : null,
    projectionPreparationRequestId:
      typeof value.projectionPreparationRequestId === 'string'
        ? value.projectionPreparationRequestId
        : null,
    projectionPreparationStatus:
      value.projectionPreparationStatus === 'ready' ||
      value.projectionPreparationStatus === 'queued' ||
      value.projectionPreparationStatus === 'processing' ||
      value.projectionPreparationStatus === 'error'
        ? value.projectionPreparationStatus
        : null,
    serverDraftReadinessStatus:
      value.serverDraftReadinessStatus === 'waiting-injury' ||
      value.serverDraftReadinessStatus === 'preparing-projection' ||
      value.serverDraftReadinessStatus === 'ready' ||
      value.serverDraftReadinessStatus === 'error'
        ? value.serverDraftReadinessStatus
        : null,
    serverDraftReadinessScheduledStartAt:
      value.serverDraftReadinessScheduledStartAt ?? null,
    serverDraftReadinessAvailabilityRevision:
      typeof value.serverDraftReadinessAvailabilityRevision === 'string'
        ? value.serverDraftReadinessAvailabilityRevision
        : null,
    serverDraftReadinessProjectionRequestId:
      typeof value.serverDraftReadinessProjectionRequestId === 'string'
        ? value.serverDraftReadinessProjectionRequestId
        : null,
    serverDraftReadinessProjectionSnapshotId:
      typeof value.serverDraftReadinessProjectionSnapshotId === 'string'
        ? value.serverDraftReadinessProjectionSnapshotId
        : null,
    serverDraftReadinessProjectionSnapshotHash:
      typeof value.serverDraftReadinessProjectionSnapshotHash === 'string'
        ? value.serverDraftReadinessProjectionSnapshotHash
        : null,
    serverDraftReadinessAttemptCount:
      typeof value.serverDraftReadinessAttemptCount === 'number' &&
      Number.isFinite(value.serverDraftReadinessAttemptCount)
        ? Math.max(0, Math.trunc(value.serverDraftReadinessAttemptCount))
        : 0,
    serverDraftReadinessRetryAfterAt:
      value.serverDraftReadinessRetryAfterAt ?? null,
    serverDraftReadinessMessage:
      typeof value.serverDraftReadinessMessage === 'string'
        ? value.serverDraftReadinessMessage
        : null,
    serverDraftReadinessUpdatedAt: value.serverDraftReadinessUpdatedAt,
    serverDraftProjectionSnapshotId:
      typeof value.serverDraftProjectionSnapshotId === 'string'
        ? value.serverDraftProjectionSnapshotId
        : null,
    serverDraftProjectionSnapshotHash:
      typeof value.serverDraftProjectionSnapshotHash === 'string'
        ? value.serverDraftProjectionSnapshotHash
        : null,
    serverDraftProjectionAuthorityVersion:
      typeof value.serverDraftProjectionAuthorityVersion === 'number'
        ? value.serverDraftProjectionAuthorityVersion
        : null,
    serverDraftProjectionCatalogHash:
      typeof value.serverDraftProjectionCatalogHash === 'string'
        ? value.serverDraftProjectionCatalogHash
        : null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    startedAt: value.startedAt,
  };
}

function normalizeQueue(ownerId: string, value: Partial<DraftQueue> | undefined): DraftQueue {
  const consecutiveClockExpirations =
    typeof value?.consecutiveClockExpirations === 'number' &&
    Number.isFinite(value.consecutiveClockExpirations)
      ? Math.min(2, Math.max(0, Math.trunc(value.consecutiveClockExpirations)))
      : 0;

  return {
    ownerId,
    assetKeys: Array.isArray(value?.assetKeys)
      ? value.assetKeys.filter((entry): entry is string => typeof entry === 'string')
      : [],
    autoDraftEnabled: value?.autoDraftEnabled === true,
    consecutiveClockExpirations,
    autoDraftActivatedByTimeout:
      value?.autoDraftActivatedByTimeout === true && consecutiveClockExpirations === 2,
    updatedAt: value?.updatedAt,
  };
}

function asTimestampDate(value: unknown): Date | null {
  if (value instanceof Timestamp) {
    return value.toDate();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(date.getTime()) ? date : null;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  return null;
}

function getDraftClockRemainingSeconds(draft: FantasyDraft, now = new Date()): number {
  if (draft.status !== 'live') {
    return 0;
  }

  if (draft.clockStatus === 'paused') {
    return Math.max(0, Math.ceil(draft.pausedRemainingSeconds ?? 0));
  }

  if (draft.clockStatus !== 'running') {
    return 0;
  }

  const startedAt = asTimestampDate(draft.pickStartedAt);

  if (!startedAt) {
    return draft.currentPickSeconds ?? draft.pickSeconds;
  }

  const durationSeconds = draft.currentPickSeconds ?? draft.pickSeconds;

  return Math.max(
    0,
    Math.ceil((startedAt.getTime() + durationSeconds * 1000 - now.getTime()) / 1000),
  );
}

async function requireCommissioner(leagueId: string, userId: string): Promise<void> {
  const leagueSnapshot = await db.doc(`leagues/${leagueId}`).get();

  if (!leagueSnapshot.exists) {
    throw new HttpsError('not-found', 'That league was not found.');
  }

  if (leagueSnapshot.data()?.['commissionerId'] !== userId) {
    throw new HttpsError('permission-denied', 'Only the commissioner can change draft settings.');
  }
}

function parseScheduledStartAt(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', 'Choose a valid draft date and start time.');
  }

  const parsed = new Date(value);

  if (!Number.isFinite(parsed.getTime())) {
    throw new HttpsError('invalid-argument', 'Choose a valid draft date and start time.');
  }

  if (parsed.getTime() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'Draft start time must be in the future.');
  }

  return parsed;
}

function parseRoundOneOrder(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HttpsError('invalid-argument', 'A draft order is required.');
  }

  const order = value.map((entry) =>
    requireFirestoreDocumentId(
      entry,
      'draft-order manager ID',
      FIRESTORE_AUTH_USER_ID_OPTIONS,
    ),
  );

  if (order.length < 2 || order.length > MAX_LEAGUE_TEAMS) {
    throw new HttpsError(
      'invalid-argument',
      `The draft order must contain between 2 and ${MAX_LEAGUE_TEAMS} teams.`,
    );
  }

  if (new Set(order).size !== order.length) {
    throw new HttpsError('invalid-argument', 'Each team can appear only once in the draft order.');
  }

  return order;
}

function draftSettingsMatchRequest(
  draft: FantasyDraft | null,
  input: {
    submissionId: string | null;
    roundOneOrder: string[];
    orderMode: DraftOrderMode;
    scheduledStartMilliseconds: number | null;
    pickSeconds: number;
  },
): boolean {
  if (!draft || !input.submissionId || draft.lastSettingsSubmissionId !== input.submissionId) {
    return false;
  }

  const existingStartMilliseconds =
    asTimestampDate(draft.scheduledStartAt)?.getTime() ?? null;
  const expectedStatus = input.scheduledStartMilliseconds === null
    ? 'setup'
    : 'scheduled';

  return draft.status === expectedStatus &&
    existingStartMilliseconds === input.scheduledStartMilliseconds &&
    draft.pickSeconds === input.pickSeconds &&
    draft.orderMode === input.orderMode &&
    draft.roundOneOrder.length === input.roundOneOrder.length &&
    draft.roundOneOrder.every(
      (ownerId, index) => ownerId === input.roundOneOrder[index],
    );
}

function createUnsafeNearTermScheduleError(
  nowMilliseconds: number,
  scheduledStartMilliseconds: number | null,
): HttpsError {
  const earliestSafeStartMilliseconds =
    getEarliestSafeUnpreparedDraftStartMilliseconds(nowMilliseconds);
  const earliestSafeStart = earliestSafeStartMilliseconds === null
    ? 'at least 40 minutes from now'
    : new Date(earliestSafeStartMilliseconds).toISOString();

  console.warn('Rejected an unsafe near-term Draft schedule.', {
    requestedLeadMilliseconds: scheduledStartMilliseconds === null
      ? null
      : scheduledStartMilliseconds - nowMilliseconds,
    minimumUnpreparedLeadMilliseconds: earliestSafeStartMilliseconds === null
      ? null
      : earliestSafeStartMilliseconds - nowMilliseconds,
    exactReadinessVerified: false,
    priorDraftPreserved: true,
  });

  return new HttpsError(
    'failed-precondition',
    `That Draft start is too soon. Choose a start at least 40 minutes from now (earliest safe start: ${earliestSafeStart}) so membership and the order can be finalized safely. Your existing Draft settings were not changed.`,
  );
}

export async function saveDraftSettings(
  leagueId: string,
  userId: string,
  request: DraftCommandRequest,
  nowMilliseconds?: number,
): Promise<DraftCommandResult> {
  await requireCommissioner(leagueId, userId);

  const submissionId = getOptionalDraftSubmissionId(request.submissionId);
  const expectedSettingsSubmissionId = getExpectedSettingsSubmissionId(
    request.expectedSettingsSubmissionId,
  );
  const roundOneOrder = parseRoundOneOrder(request.roundOneOrder);
  const orderMode = parseDraftOrderMode(request.orderMode);
  const scheduledStartAt = parseScheduledStartAt(request.scheduledStartAt);
  const pickSeconds = normalizePickSeconds(request.pickSeconds);

  if (!ALLOWED_PICK_SECONDS.has(pickSeconds)) {
    throw new HttpsError('invalid-argument', 'Choose a supported draft clock duration.');
  }

  const draftRef = db.doc(`leagues/${leagueId}/${DRAFT_DOCUMENT_PATH_SUFFIX}`);
  const leagueRef = db.doc(`leagues/${leagueId}`);
  const teamsQuery = db.collection(`leagues/${leagueId}/teams`).limit(MAX_LEAGUE_TEAMS + 1);
  const draftSettingsAuditId = `draft-settings-${createHash('sha256')
    .update(submissionId ?? `${userId}:${Date.now()}:${roundOneOrder.join(',')}:${pickSeconds}`)
    .digest('hex')
    .slice(0, 24)}`;
  const draftSettingsAuditRef = db.doc(`leagues/${leagueId}/audit/${draftSettingsAuditId}`);
  const scheduledStartMilliseconds = scheduledStartAt?.getTime() ?? null;
  const settingsRequest = {
    submissionId,
    roundOneOrder,
    orderMode,
    scheduledStartMilliseconds,
    pickSeconds,
  };
  await db.runTransaction(async (transaction) => {
    const authorizationNowMilliseconds = nowMilliseconds ?? Date.now();
    const [
      draftSnapshot,
      leagueSnapshot,
      teamSnapshot,
      draftSettingsAuditSnapshot,
    ] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(leagueRef),
      transaction.get(teamsQuery),
      transaction.get(draftSettingsAuditRef),
    ]);

    if (!leagueSnapshot.exists) {
      throw new HttpsError('not-found', 'This league no longer exists.');
    }

    const leagueData = leagueSnapshot.data() ?? {};

    if (leagueData['commissionerId'] !== userId) {
      throw new HttpsError('permission-denied', 'Only the commissioner can change draft settings.');
    }

    const existingDraft = draftSnapshot.exists
      ? normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>)
      : null;
    const teamOwnerIds = teamSnapshot.docs.map((document) => document.id).sort();
    const requestedOwnerIds = [...roundOneOrder].sort();

    if (
      teamOwnerIds.length !== requestedOwnerIds.length ||
      teamOwnerIds.some((ownerId, index) => ownerId !== requestedOwnerIds[index])
    ) {
      throw new HttpsError(
        'failed-precondition',
        'The draft order must contain every current league team exactly once. Refresh and try again.',
      );
    }

    const idempotentSettingsReplay = draftSettingsMatchRequest(
      existingDraft,
      settingsRequest,
    );

    if (submissionId && existingDraft?.lastSettingsSubmissionId === submissionId) {
      if (!idempotentSettingsReplay) {
        throw new HttpsError(
          'already-exists',
          'That draft-settings submission identifier was already used for different settings. Refresh Draft Setup before trying again.',
        );
      }
    }

    const observedSettingsSubmissionId = existingDraft?.lastSettingsSubmissionId ?? null;

    if (
      !idempotentSettingsReplay &&
      observedSettingsSubmissionId !== expectedSettingsSubmissionId
    ) {
      throw new HttpsError(
        'aborted',
        'Draft settings changed in another tab. Refresh Draft Setup before saving again.',
        { reason: 'stale-draft-settings' },
      );
    }

    if (
      existingDraft &&
      (
        existingDraft.status === 'live' ||
        existingDraft.status === 'complete' ||
        existingDraft.nextOverallPick !== 1 ||
        existingDraft.draftedAssetKeys.length > 0
      )
    ) {
      throw new HttpsError(
        'failed-precondition',
        'Draft settings are locked after the live draft begins.',
      );
    }

    const existingStartMilliseconds = existingDraft
      ? asTimestampDate(existingDraft.scheduledStartAt)?.getTime() ?? null
      : null;
    const membershipCutoffReached = existingDraft
      ? isDraftMembershipCutoffReached({
          draftStatus: existingDraft.status,
          scheduledStartMilliseconds: existingStartMilliseconds,
          nowMilliseconds: authorizationNowMilliseconds,
        })
      : false;

    if (
      existingDraft &&
      (isDraftMembershipLocked(draftSnapshot.data()) || membershipCutoffReached) &&
      !idempotentSettingsReplay
    ) {
      throw new HttpsError(
        'failed-precondition',
        'Draft membership and order are finalized. Use Postpone and Reopen before changing setup.',
        { reason: 'draft-membership-finalized' },
      );
    }

    const timestamp = FieldValue.serverTimestamp();
    const status = scheduledStartAt ? 'scheduled' : 'setup';
    const nearTermGateState = getDraftNearTermScheduleGateState({
      scheduledStartMilliseconds,
      nowMilliseconds: authorizationNowMilliseconds,
      exactReadinessVerified: false,
    });

    if (nearTermGateState === 'requires-exact-readiness' && !idempotentSettingsReplay) {
      throw createUnsafeNearTermScheduleError(
        authorizationNowMilliseconds,
        scheduledStartMilliseconds,
      );
    }

    const previousStartMilliseconds = existingDraft
      ? asTimestampDate(existingDraft.scheduledStartAt)?.getTime() ?? null
      : null;
    const scheduleChanged = previousStartMilliseconds !== scheduledStartMilliseconds;
    const scheduleGeneration = Math.max(0, existingDraft?.scheduleGeneration ?? 0) +
      (scheduleChanged ? 1 : 0);
    const orderChanged = !existingDraft || existingDraft.orderMode !== orderMode ||
      existingDraft.roundOneOrder.length !== roundOneOrder.length ||
      existingDraft.roundOneOrder.some((ownerId, index) => ownerId !== roundOneOrder[index]);

    if (!idempotentSettingsReplay) {
      transaction.set(
        draftRef,
        {
          schemaVersion: 3,
          status,
          format: 'snake',
          totalRounds: DEFAULT_TOTAL_ROUNDS,
          rosterRequirements: DEFAULT_ROSTER_REQUIREMENTS,
          benchSlots: DEFAULT_BENCH_SLOTS,
          roundOneOrder,
          nextOverallPick: 1,
          draftedAssetKeys: [],
          scheduledStartAt: scheduledStartAt ? Timestamp.fromDate(scheduledStartAt) : null,
          pickSeconds,
          clockStatus: 'stopped',
          pickStartedAt: null,
          currentPickSeconds: pickSeconds,
          pausedRemainingSeconds: null,
          clockUpdatedBy: null,
          clockUpdatedAt: timestamp,
          lastPickId: null,
          lastSettingsSubmissionId: submissionId ?? null,
          orderMode,
          scheduleGeneration,
          orderEpoch: existingDraft?.orderEpoch ?? 0,
          membershipLockStatus: 'open',
          membershipLockedAt: null,
          orderFinalizedAt: null,
          orderParticipantHash: orderChanged
            ? null
            : existingDraft?.orderParticipantHash ?? null,
          finalizedScheduleGeneration: null,
          orderRandomizationSeedHash: orderChanged
            ? null
            : existingDraft?.orderRandomizationSeedHash ?? null,
          initialNhlBlockNumber: null,
          seasonWindowAnchorStatus: null,
          seasonWindowAnchorSeason: null,
          seasonWindowAnchorScheduleGeneration: null,
          seasonWindowAnchorEvidenceHash: null,
          seasonWindowAnchorEvidenceHashAlgorithm: null,
          seasonWindowAnchorFinalPrefixGameCount: null,
          seasonWindowAnchorSourceGameStart: null,
          seasonWindowAnchorSourceGameEnd: null,
          seasonWindowAnchorTeams: null,
          seasonWindowSourceGameIdsByTeam: null,
          seasonWindowAnchorUpdatedAt: timestamp,
          seasonWindowAnchorFrozenAt: null,
          seasonWindowAnchorLastError: null,
          projectionPreparationRequestId: null,
          projectionPreparationStatus: null,
          serverDraftReadinessStatus: null,
          serverDraftReadinessScheduledStartAt: null,
          serverDraftReadinessScheduleGeneration: null,
          serverDraftReadinessAvailabilityRevision: null,
          serverDraftReadinessProjectionRequestId: null,
          serverDraftReadinessProjectionSnapshotId: null,
          serverDraftReadinessProjectionSnapshotHash: null,
          serverDraftReadinessAttemptCount: 0,
          serverDraftReadinessRetryAfterAt: null,
          serverDraftReadinessMessage: null,
          serverDraftReadinessUpdatedAt: timestamp,
          serverDraftProjectionSnapshotId: null,
          serverDraftProjectionSnapshotHash: null,
          serverDraftProjectionAuthorityVersion: null,
          serverDraftProjectionCatalogHash: null,
          serverAutomationStatus: status === 'scheduled'
            ? 'scheduled'
            : 'waiting',
          serverAutomationMessage: status === 'scheduled'
            ? 'Draft settings are saved. Membership and the final order remain open until 40 minutes before the start.'
            : 'Draft order saved without a scheduled start time.',
          serverAutomationUpdatedAt: timestamp,
          updatedAt: timestamp,
          ...(draftSnapshot.exists ? {} : { createdAt: timestamp }),
        },
        { merge: true },
      );
    }

    if (!idempotentSettingsReplay && !draftSettingsAuditSnapshot.exists) {
      transaction.create(draftSettingsAuditRef, {
        schemaVersion: LEAGUE_AUDIT_SCHEMA_VERSION,
        id: draftSettingsAuditId,
        leagueId,
        action: 'draft-settings-saved',
        actorId: userId,
        actorRole: 'commissioner',
        authority: 'cloud-function',
        authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
        requestId: submissionId ?? null,
        reason: 'Commissioner saved Draft setup intent before the membership cutoff.',
        release: 'Draft Lifecycle T40',
        previousValues: existingDraft
          ? {
              status: existingDraft.status,
              roundOneOrder: existingDraft.roundOneOrder,
              scheduledStartAt: existingDraft.scheduledStartAt ?? null,
              pickSeconds: existingDraft.pickSeconds,
              orderMode: existingDraft.orderMode,
              scheduleGeneration: existingDraft.scheduleGeneration,
            }
          : null,
        newValues: {
          status,
          roundOneOrder,
          scheduledStartAt: scheduledStartAt ? Timestamp.fromDate(scheduledStartAt) : null,
          pickSeconds,
          orderMode,
          scheduleGeneration,
          membershipLockStatus: 'open',
        },
        createdAt: timestamp,
      });
    }
  });

  return {
    applied: true,
    action: 'save-settings',
    message: scheduledStartAt
      ? 'Draft settings were saved. League entry and size remain open until 40 minutes before the scheduled start.'
      : 'Draft order preferences were saved. League entry remains open.',
    submissionId,
  };
}

export async function cancelDraftSchedule(
  leagueId: string,
  userId: string,
  request: DraftCommandRequest,
  reopenFinalizedMembership: boolean,
  nowMilliseconds?: number,
): Promise<DraftCommandResult> {
  await requireCommissioner(leagueId, userId);

  const submissionId = getOptionalDraftSubmissionId(request.submissionId);

  if (!submissionId) {
    throw new HttpsError('invalid-argument', 'A cancellation request identifier is required.');
  }

  const expectedSettingsSubmissionId = getExpectedSettingsSubmissionId(
    request.expectedSettingsSubmissionId,
  );
  const draftRef = db.doc(`leagues/${leagueId}/${DRAFT_DOCUMENT_PATH_SUFFIX}`);
  const leagueRef = db.doc(`leagues/${leagueId}`);
  const teamsQuery = db.collection(`leagues/${leagueId}/teams`).limit(MAX_LEAGUE_TEAMS + 1);
  const cyclesQuery = db.collection(`leagues/${leagueId}/cycles`).limit(1);
  const picksQuery = db.collection(`leagues/${leagueId}/draft/current/picks`).limit(1);
  const transactionsQuery = db.collection(`leagues/${leagueId}/transactions`).limit(1);
  const waiversQuery = db.collection(`leagues/${leagueId}/waivers`).limit(1);
  const auditId = `draft-schedule-cancelled-${createHash('sha256')
    .update(submissionId)
    .digest('hex')
    .slice(0, 24)}`;
  const auditRef = db.doc(`leagues/${leagueId}/audit/${auditId}`);

  await db.runTransaction(async (transaction) => {
    const authorizationNowMilliseconds = nowMilliseconds ?? Date.now();
    const [
      draftSnapshot,
      leagueSnapshot,
      teamSnapshot,
      cyclesSnapshot,
      picksSnapshot,
      transactionsSnapshot,
      waiversSnapshot,
      auditSnapshot,
    ] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(leagueRef),
      transaction.get(teamsQuery),
      transaction.get(cyclesQuery),
      transaction.get(picksQuery),
      transaction.get(transactionsQuery),
      transaction.get(waiversQuery),
      transaction.get(auditRef),
    ]);

    if (!draftSnapshot.exists || !leagueSnapshot.exists) {
      throw new HttpsError('not-found', 'Draft setup was not found.');
    }

    const rawDraft = draftSnapshot.data() ?? {};
    const draft = normalizeDraft(rawDraft as Partial<FantasyDraft>);
    const league = leagueSnapshot.data() ?? {};

    if (league['commissionerId'] !== userId) {
      throw new HttpsError('permission-denied', 'Only the commissioner can cancel the Draft schedule.');
    }

    if (
      draft.lastSettingsSubmissionId === submissionId &&
      draft.status === 'setup' &&
      !draft.scheduledStartAt &&
      draft.membershipLockStatus === 'open'
    ) {
      return;
    }

    if ((draft.lastSettingsSubmissionId ?? null) !== expectedSettingsSubmissionId) {
      throw new HttpsError(
        'aborted',
        'Draft settings changed in another tab. Refresh Draft Setup before canceling.',
        { reason: 'stale-draft-settings' },
      );
    }

    if (
      draft.status === 'live' || draft.status === 'complete' ||
      draft.nextOverallPick !== 1 || draft.draftedAssetKeys.length > 0 ||
      cyclesSnapshot.size > 0 || picksSnapshot.size > 0 ||
      transactionsSnapshot.size > 0 || waiversSnapshot.size > 0
    ) {
      throw new HttpsError(
        'failed-precondition',
        'A Draft cannot be canceled or reopened after drafting begins.',
        { reason: 'draft-started' },
      );
    }

    const currentScheduledStartMilliseconds =
      asTimestampDate(draft.scheduledStartAt)?.getTime() ?? null;
    const membershipFinalized = isDraftMembershipLocked(rawDraft) ||
      isDraftMembershipCutoffReached({
        draftStatus: draft.status,
        scheduledStartMilliseconds: currentScheduledStartMilliseconds,
        nowMilliseconds: authorizationNowMilliseconds,
      });

    if (membershipFinalized !== reopenFinalizedMembership) {
      throw new HttpsError(
        'failed-precondition',
        membershipFinalized
          ? 'Membership is finalized. Use the password-confirmed Postpone and Reopen action.'
          : 'This Draft is still open. Use Cancel Scheduled Time instead.',
        { reason: membershipFinalized ? 'draft-membership-finalized' : 'draft-membership-open' },
      );
    }

    const inviteCode = resolveSafeFirestoreDocumentId(
      league['inviteCode'],
      FIRESTORE_INVITE_CODE_OPTIONS,
    );
    const inviteRef = inviteCode ? db.doc(`leagueInvites/${inviteCode}`) : null;
    const inviteSnapshot = inviteRef ? await transaction.get(inviteRef) : null;

    if (!inviteRef || !inviteSnapshot?.exists) {
      throw new HttpsError(
        'failed-precondition',
        'League invitation authority is incomplete. Repair League HQ before reopening.',
      );
    }

    const maxTeams = typeof league['maxTeams'] === 'number'
      ? Math.max(2, Math.min(MAX_LEAGUE_TEAMS, Math.trunc(league['maxTeams'])))
      : 2;
    const teamCount = teamSnapshot.size;
    const joinStatus = teamCount >= maxTeams ? 'full' : 'open';
    const invite = inviteSnapshot.data() ?? {};
    const inviteExpiry = asTimestampDate(invite['expiresAt']);
    const inviteActive = joinStatus === 'open' &&
      Boolean(inviteExpiry && inviteExpiry.getTime() > Date.now());
    const timestamp = FieldValue.serverTimestamp();

    transaction.set(draftRef, {
      status: 'setup',
      scheduledStartAt: null,
      scheduleGeneration: Math.max(0, draft.scheduleGeneration ?? 0) + 1,
      membershipLockStatus: 'open',
      membershipLockedAt: null,
      orderFinalizedAt: null,
      finalizedScheduleGeneration: null,
      initialNhlBlockNumber: null,
      seasonWindowAnchorStatus: null,
      seasonWindowAnchorSeason: null,
      seasonWindowAnchorScheduleGeneration: null,
      seasonWindowAnchorEvidenceHash: null,
      seasonWindowAnchorEvidenceHashAlgorithm: null,
      seasonWindowAnchorFinalPrefixGameCount: null,
      seasonWindowAnchorSourceGameStart: null,
      seasonWindowAnchorSourceGameEnd: null,
      seasonWindowAnchorTeams: null,
      seasonWindowSourceGameIdsByTeam: null,
      seasonWindowAnchorUpdatedAt: timestamp,
      seasonWindowAnchorFrozenAt: null,
      seasonWindowAnchorLastError: null,
      clockStatus: 'stopped',
      pickStartedAt: null,
      pausedRemainingSeconds: null,
      clockUpdatedBy: userId,
      clockUpdatedAt: timestamp,
      lastSettingsSubmissionId: submissionId,
      projectionPreparationRequestId: null,
      projectionPreparationStatus: null,
      serverDraftReadinessStatus: null,
      serverDraftReadinessScheduledStartAt: null,
      serverDraftReadinessScheduleGeneration: null,
      serverDraftReadinessAvailabilityRevision: null,
      serverDraftReadinessProjectionRequestId: null,
      serverDraftReadinessProjectionSnapshotId: null,
      serverDraftReadinessProjectionSnapshotHash: null,
      serverDraftReadinessAttemptCount: 0,
      serverDraftReadinessRetryAfterAt: null,
      serverDraftReadinessMessage: null,
      serverDraftProjectionSnapshotId: null,
      serverDraftProjectionSnapshotHash: null,
      serverDraftProjectionAuthorityVersion: null,
      serverDraftProjectionCatalogHash: null,
      serverAutomationStatus: 'waiting',
      serverAutomationMessage: reopenFinalizedMembership
        ? 'The commissioner postponed the Draft and reopened membership. The preserved order will be reconciled at the next cutoff.'
        : 'The commissioner canceled the scheduled time. Membership remains open.',
      serverAutomationUpdatedAt: timestamp,
      updatedAt: timestamp,
    }, { merge: true });

    transaction.set(leagueRef, {
      teamCount,
      joinStatus,
      joinLockedAt: joinStatus === 'full' ? timestamp : null,
      joinLockedReason: joinStatus === 'full' ? 'league-full' : null,
      updatedAt: timestamp,
    }, { merge: true });
    transaction.set(inviteRef, {
      active: inviteActive,
      joinCount: teamCount,
      lockedAt: joinStatus === 'full' ? timestamp : null,
      lockedReason: joinStatus === 'full' ? 'league-full' : null,
      updatedAt: timestamp,
    }, { merge: true });

    if (!auditSnapshot.exists) {
      transaction.create(auditRef, {
        schemaVersion: LEAGUE_AUDIT_SCHEMA_VERSION,
        id: auditId,
        leagueId,
        action: reopenFinalizedMembership
          ? 'draft-postponed-membership-reopened'
          : 'draft-schedule-cancelled',
        actorId: userId,
        actorRole: 'commissioner',
        authority: 'cloud-function',
        authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
        requestId: submissionId,
        reason: reopenFinalizedMembership
          ? 'Commissioner postponed an unstarted Draft and explicitly reopened membership.'
          : 'Commissioner canceled an unstarted Draft schedule before the membership cutoff.',
        release: 'Draft Lifecycle T40',
        previousValues: {
          scheduledStartAt: draft.scheduledStartAt ?? null,
          scheduleGeneration: draft.scheduleGeneration ?? 0,
          membershipLockStatus: membershipFinalized ? 'locked' : 'open',
          orderEpoch: draft.orderEpoch ?? 0,
        },
        newValues: {
          scheduledStartAt: null,
          scheduleGeneration: Math.max(0, draft.scheduleGeneration ?? 0) + 1,
          membershipLockStatus: 'open',
          orderPreserved: true,
        },
        createdAt: timestamp,
      });
    }
  });

  return {
    applied: true,
    action: reopenFinalizedMembership ? 'postpone-reopen' : 'cancel-schedule',
    message: reopenFinalizedMembership
      ? 'The Draft was postponed. Membership and league size are open again, and the order is preserved unless participants change.'
      : 'The scheduled Draft time was canceled. Membership remains open.',
    submissionId,
  };
}

async function activateScheduledDraft(
  leagueId: string,
  userId: string,
): Promise<DraftCommandResult> {
  await requireCommissioner(leagueId, userId);

  const draftRef = db.doc(`leagues/${leagueId}/${DRAFT_DOCUMENT_PATH_SUFFIX}`);
  const preflightSnapshot = await draftRef.get();

  if (!preflightSnapshot.exists) {
    throw new HttpsError('not-found', 'Draft setup was not found.');
  }

  const preflightDraft = normalizeDraft(preflightSnapshot.data() as Partial<FantasyDraft>);
  const projection = await loadPreparedProjectionSnapshotForScheduledDraft(
    leagueId,
    preflightDraft,
  );

  if (!projection) {
    throw new HttpsError(
      'failed-precondition',
      `Server Draft readiness for this exact start time and injury-report revision is not verified. The clock remains locked.`,
    );
  }

  await db.runTransaction(async (transaction) => {
    const teamsQuery = db.collection(`leagues/${leagueId}/teams`).limit(MAX_LEAGUE_TEAMS + 1);
    const leagueRef = db.doc(`leagues/${leagueId}`);
    const [snapshot, teamsSnapshot, leagueSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(teamsQuery),
      transaction.get(leagueRef),
    ]);

    if (!snapshot.exists || !leagueSnapshot.exists) {
      throw new HttpsError('not-found', 'Draft setup was not found.');
    }

    const rawDraft = snapshot.data() ?? {};
    const draft = normalizeDraft(snapshot.data() as Partial<FantasyDraft>);

    if (draft.status === 'live') {
      return;
    }

    if (draft.status !== 'scheduled') {
      throw new HttpsError('failed-precondition', 'The draft is not scheduled.');
    }

    const scheduledStart = asTimestampDate(draft.scheduledStartAt);

    if (!scheduledStart || scheduledStart.getTime() > Date.now()) {
      throw new HttpsError('failed-precondition', 'The scheduled draft start time has not arrived.');
    }

    const participantIds = teamsSnapshot.docs
      .map((document) => document.id)
      .sort((first, second) => first.localeCompare(second));

    if (!draftFinalizationMatchesParticipants(rawDraft, participantIds)) {
      throw new HttpsError(
        'failed-precondition',
        'Draft membership and order have not been finalized for this schedule. The server will retry safely.',
      );
    }

    try {
      validateSeasonWindowSourcePlan({
        finalizedTeamCount: participantIds.length,
        initialNhlBlockNumber: draft.initialNhlBlockNumber ?? 0,
        requiredGamesPerCycle: getLeagueRequiredGamesPerCycle(
          leagueSnapshot.data() ?? {},
        ),
        activeNhlTeamAbbreviations:
          NHL_DRAFT_CLUBS.map((club) => club.abbreviation),
        anchorTeams: draft.seasonWindowAnchorTeams ?? [],
        sourceGameIdsByTeam: draft.seasonWindowSourceGameIdsByTeam,
      });
    } catch (error: unknown) {
      throw new HttpsError(
        'failed-precondition',
        error instanceof Error
          ? error.message
          : 'The immutable NHL source plan is incomplete.',
      );
    }

    const readinessScheduledStart = asTimestampDate(
      draft.serverDraftReadinessScheduledStartAt,
    );

    if (
      draft.serverDraftReadinessStatus !== 'ready' ||
      draft.seasonWindowAnchorStatus !== 'ready' ||
      draft.seasonWindowAnchorScheduleGeneration !==
        (draft.scheduleGeneration ?? 0) ||
      typeof draft.initialNhlBlockNumber !== 'number' ||
      !Number.isSafeInteger(draft.initialNhlBlockNumber) ||
      draft.initialNhlBlockNumber < 1 ||
      !isProjectionSha256(draft.seasonWindowAnchorEvidenceHash) ||
      readinessScheduledStart?.getTime() !== scheduledStart.getTime() ||
      draft.serverDraftReadinessProjectionSnapshotId !==
        projection.metadata.activeSnapshotId ||
      draft.serverDraftReadinessProjectionSnapshotHash !==
        projection.metadata.snapshotContentHash ||
      draft.serverDraftReadinessProjectionRequestId !==
        projection.metadata.generationRequestId ||
      draft.serverDraftReadinessAvailabilityRevision !==
        projection.metadata.availabilityRevision ||
      (projection.metadata.targetSourceBlockNumber ??
        projection.metadata.targetCycleNumber) !==
        draft.initialNhlBlockNumber ||
      projection.metadata.seasonWindowAnchorEvidenceHash !==
        draft.seasonWindowAnchorEvidenceHash ||
      (
        draft.membershipLockStatus !== undefined &&
        draft.serverDraftReadinessScheduleGeneration !== (draft.scheduleGeneration ?? 0)
      )
    ) {
      throw new HttpsError(
        'failed-precondition',
        'Draft readiness changed before the clock could start. The server will verify the newest evidence and retry.',
      );
    }

    const timestamp = FieldValue.serverTimestamp();

    transaction.set(
      draftRef,
      {
        status: 'live',
        clockStatus: 'running',
        pickStartedAt: timestamp,
        currentPickSeconds: draft.pickSeconds,
        pausedRemainingSeconds: null,
        clockUpdatedBy: userId,
        clockUpdatedAt: timestamp,
        serverDraftProjectionSnapshotId: projection.metadata.activeSnapshotId,
        serverDraftProjectionSnapshotHash: projection.metadata.snapshotContentHash,
        serverDraftProjectionAuthorityVersion:
          PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
        serverDraftProjectionCatalogHash: projection.metadata.catalogHash ?? null,
        serverProjectionFallbackUsed: false,
        serverAutomationStatus: 'healthy',
        serverAutomationMessage:
          `The draft opened with verified Projection V${SHARED_PROJECTION_VERSION} rankings.`,
        serverAutomationUpdatedAt: timestamp,
        startedAt: timestamp,
        updatedAt: timestamp,
      },
      { merge: true },
    );
  });

  return {
    applied: true,
    action: 'activate-scheduled',
    message: 'The scheduled draft is live.',
  };
}

async function startDraftClock(
  leagueId: string,
  userId: string,
): Promise<DraftCommandResult> {
  const draftRef = db.doc(`leagues/${leagueId}/${DRAFT_DOCUMENT_PATH_SUFFIX}`);
  const [preflightSnapshot, preflightMember, preflightTeam] = await Promise.all([
    draftRef.get(),
    db.doc(`leagues/${leagueId}/members/${userId}`).get(),
    db.doc(`leagues/${leagueId}/teams/${userId}`).get(),
  ]);

  if (!preflightSnapshot.exists) {
    throw new HttpsError('not-found', 'Draft setup was not found.');
  }

  if (!preflightMember.exists && !preflightTeam.exists) {
    throw new HttpsError('permission-denied', 'You are not an active member of this league.');
  }

  const preflightDraft = normalizeDraft(preflightSnapshot.data() as Partial<FantasyDraft>);
  const preflightPick = getDraftPickAtOverall(preflightDraft, preflightDraft.nextOverallPick);

  if (!preflightPick || preflightPick.ownerId !== userId) {
    throw new HttpsError('permission-denied', 'You are not the manager currently on the clock.');
  }

  const projection = await loadProjectionSnapshotForDraft(leagueId, preflightDraft);

  if (!projection) {
    throw new HttpsError(
      'failed-precondition',
      `Verified Projection V${SHARED_PROJECTION_VERSION} draft rankings are unavailable.`,
    );
  }

  await db.runTransaction(async (transaction) => {
    const [draftSnapshot, memberSnapshot, teamSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(db.doc(`leagues/${leagueId}/members/${userId}`)),
      transaction.get(db.doc(`leagues/${leagueId}/teams/${userId}`)),
    ]);

    if (!draftSnapshot.exists || (!memberSnapshot.exists && !teamSnapshot.exists)) {
      throw new HttpsError('permission-denied', 'You are not an active member of this league.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    if (draft.status !== 'live') {
      throw new HttpsError('failed-precondition', 'The live draft has not opened yet.');
    }

    if (draft.clockStatus === 'running') {
      return;
    }

    if (draft.clockStatus === 'paused') {
      throw new HttpsError('failed-precondition', 'The commissioner has paused the draft clock.');
    }

    if (draft.clockStatus !== 'stopped') {
      throw new HttpsError('failed-precondition', 'The draft clock cannot be started right now.');
    }

    const currentPick = getDraftPickAtOverall(draft, draft.nextOverallPick);

    if (!currentPick || currentPick.ownerId !== userId) {
      throw new HttpsError(
        'permission-denied',
        'Only the manager currently making the first pick can start the draft clock.',
      );
    }

    const timestamp = FieldValue.serverTimestamp();

    transaction.set(
      draftRef,
      {
        clockStatus: 'running',
        pickStartedAt: timestamp,
        currentPickSeconds: draft.pickSeconds,
        pausedRemainingSeconds: null,
        clockUpdatedBy: userId,
        clockUpdatedAt: timestamp,
        serverDraftProjectionSnapshotId: projection.metadata.activeSnapshotId,
        serverDraftProjectionSnapshotHash: projection.metadata.snapshotContentHash,
        serverDraftProjectionAuthorityVersion:
          PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
        serverDraftProjectionCatalogHash: projection.metadata.catalogHash ?? null,
        serverAutomationStatus: 'healthy',
        serverAutomationMessage: 'The first manager started the draft clock.',
        serverAutomationUpdatedAt: timestamp,
        updatedAt: timestamp,
      },
      { merge: true },
    );
  });

  return {
    applied: true,
    action: 'start-clock',
    message: 'The draft clock started.',
  };
}

async function pauseOrResumeDraftClock(
  leagueId: string,
  userId: string,
  action: Extract<DraftCommandAction, 'pause-clock' | 'resume-clock'>,
): Promise<DraftCommandResult> {
  await requireCommissioner(leagueId, userId);

  const draftRef = db.doc(`leagues/${leagueId}/${DRAFT_DOCUMENT_PATH_SUFFIX}`);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(draftRef);

    if (!snapshot.exists) {
      throw new HttpsError('not-found', 'Draft setup was not found.');
    }

    const draft = normalizeDraft(snapshot.data() as Partial<FantasyDraft>);

    if (draft.status !== 'live') {
      throw new HttpsError('failed-precondition', 'The draft is not live.');
    }

    if (action === 'pause-clock') {
      if (draft.clockStatus === 'paused') {
        return;
      }

      if (draft.clockStatus !== 'running') {
        throw new HttpsError('failed-precondition', 'The draft clock is not running.');
      }

      const remainingSeconds = getDraftClockRemainingSeconds(draft);

      if (remainingSeconds <= 0) {
        throw new HttpsError(
          'deadline-exceeded',
          'The pick clock already expired. The server is processing the automatic pick.',
        );
      }

      const timestamp = FieldValue.serverTimestamp();

      transaction.set(
        draftRef,
        {
          clockStatus: 'paused',
          pickStartedAt: null,
          currentPickSeconds: remainingSeconds,
          pausedRemainingSeconds: remainingSeconds,
          clockUpdatedBy: userId,
          clockUpdatedAt: timestamp,
          serverAutomationStatus: 'paused',
          serverAutomationMessage: 'The commissioner paused the draft clock.',
          serverAutomationUpdatedAt: timestamp,
          updatedAt: timestamp,
        },
        { merge: true },
      );
      return;
    }

    if (draft.clockStatus === 'running') {
      return;
    }

    if (draft.clockStatus !== 'paused') {
      throw new HttpsError('failed-precondition', 'The draft clock is not paused.');
    }

    const remainingSeconds = Math.max(
      1,
      Math.min(draft.pickSeconds, draft.pausedRemainingSeconds ?? draft.pickSeconds),
    );
    const timestamp = FieldValue.serverTimestamp();

    transaction.set(
      draftRef,
      {
        clockStatus: 'running',
        pickStartedAt: timestamp,
        currentPickSeconds: remainingSeconds,
        pausedRemainingSeconds: null,
        clockUpdatedBy: userId,
        clockUpdatedAt: timestamp,
        serverAutomationStatus: 'healthy',
        serverAutomationMessage: 'The commissioner resumed the draft clock.',
        serverAutomationUpdatedAt: timestamp,
        updatedAt: timestamp,
      },
      { merge: true },
    );
  });

  return {
    applied: true,
    action,
    message: action === 'pause-clock' ? 'The draft clock was paused.' : 'The draft clock resumed.',
  };
}

export const executeDraftCommand = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
    maxInstances: 20,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<DraftCommandResult> => {
    const userId = requireAuthenticatedUserId(request.auth);
    const input = request.data && typeof request.data === 'object'
      ? request.data as DraftCommandRequest
      : {};
    const leagueId = requireLeagueId(input.leagueId);
    const action = asString(input.action) as DraftCommandAction;

    if (action === 'save-settings') {
      return saveDraftSettings(leagueId, userId, input);
    }

    if (action === 'cancel-schedule') {
      return cancelDraftSchedule(leagueId, userId, input, false);
    }

    if (action === 'postpone-reopen') {
      requireRecentAuthentication(request.auth, 'postpone and reopen this Draft');
      return cancelDraftSchedule(leagueId, userId, input, true);
    }

    if (action === 'activate-scheduled') {
      return activateScheduledDraft(leagueId, userId);
    }

    if (action === 'start-clock') {
      return startDraftClock(leagueId, userId);
    }

    if (action === 'pause-clock' || action === 'resume-clock') {
      return pauseOrResumeDraftClock(leagueId, userId, action);
    }

    throw new HttpsError('invalid-argument', 'That draft command is not supported.');
  },
);

export const repairDraftTurnHandoff = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 30,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<RepairDraftTurnHandoffResult> => {
    const userId = requireAuthenticatedUserId(request.auth);
    const input = request.data && typeof request.data === 'object'
      ? request.data as RepairDraftTurnHandoffRequest
      : {};
    const leagueId = requireLeagueId(input.leagueId);
    const [memberSnapshot, teamSnapshot] = await Promise.all([
      db.doc(`leagues/${leagueId}/members/${userId}`).get(),
      db.doc(`leagues/${leagueId}/teams/${userId}`).get(),
    ]);

    if (!memberSnapshot.exists && !teamSnapshot.exists) {
      throw new HttpsError(
        'permission-denied',
        'You must be an active league member to reconcile its draft turn.',
      );
    }

    try {
      const result = await repairDraftTurnFromCommittedPicks(
        leagueId,
        `member:${userId}:draft-handoff-repair`,
      );
      const clockTaskScheduled = result.status === 'live'
        ? await ensureCurrentDraftClockTask(leagueId)
        : true;

      return {
        ...result,
        clockTaskScheduled,
        message: clockTaskScheduled
          ? result.message
          : `${result.message} The live turn is open, but the exact deadline task needs the scheduled recovery worker.`,
      };
    } catch (error: unknown) {
      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError(
        'internal',
        error instanceof Error
          ? error.message
          : 'RinkRat could not reconcile the next draft turn.',
      );
    }
  },
);

export const makeSecureDraftPick = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 100,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<SecureDraftPickResult> => {
    const userId = requireAuthenticatedUserId(request.auth);
    const input = request.data && typeof request.data === 'object'
      ? request.data as SecureDraftPickRequest
      : {};
    const leagueId = requireLeagueId(input.leagueId);
    await enforceAppCheckCallableCanaryForLeague(
      request,
      'makeSecureDraftPick',
      leagueId,
    );
    const assetKey = requireAssetKey(input.assetKey);
    const submissionId = getOptionalDraftSubmissionId(input.submissionId);
    const requestedOverallPick = getOptionalExpectedOverallPick(input.expectedOverallPick);
    const draftRef = db.doc(`leagues/${leagueId}/${DRAFT_DOCUMENT_PATH_SUFFIX}`);
    const [preflightDraftSnapshot, preflightMember, preflightTeam] = await Promise.all([
      draftRef.get(),
      db.doc(`leagues/${leagueId}/members/${userId}`).get(),
      db.doc(`leagues/${leagueId}/teams/${userId}`).get(),
    ]);

    if (!preflightDraftSnapshot.exists) {
      throw new HttpsError('not-found', 'Draft setup was not found.');
    }

    if (!preflightMember.exists && !preflightTeam.exists) {
      throw new HttpsError('permission-denied', 'You are not an active member of this league.');
    }

    const preflightDraft = normalizeDraft(
      preflightDraftSnapshot.data() as Partial<FantasyDraft>,
    );
    const expectedOverallPick = requestedOverallPick ?? preflightDraft.nextOverallPick;
    const pickId = String(expectedOverallPick).padStart(3, '0');
    const pickRef = db.doc(`leagues/${leagueId}/draft/current/picks/${pickId}`);
    const submissionIdentity = {
      submissionId,
      expectedOverallPick,
      assetKey,
      userId,
    };
    const preflightPickSnapshot = await pickRef.get();

    if (preflightPickSnapshot.exists) {
      const existingPick = preflightPickSnapshot.data() as DraftPick;

      if (draftPickMatchesSubmission(existingPick, submissionIdentity)) {
        return { pick: existingPick };
      }

      throw new HttpsError(
        'already-exists',
        `Pick ${expectedOverallPick} has already been completed. Refresh the live draft board before submitting another selection.`,
      );
    }

    if (preflightDraft.nextOverallPick !== expectedOverallPick) {
      throw new HttpsError(
        'aborted',
        `The live board advanced from pick ${expectedOverallPick}. Refresh before making another selection.`,
      );
    }

    const preflightPick = getDraftPickAtOverall(
      preflightDraft,
      expectedOverallPick,
    );

    if (!preflightPick || preflightPick.ownerId !== userId) {
      throw new HttpsError('permission-denied', 'You are not the manager currently on the clock.');
    }

    if (
      (
        !preflightDraft.serverDraftProjectionSnapshotId ||
        !preflightDraft.serverDraftProjectionSnapshotHash ||
        preflightDraft.serverDraftProjectionAuthorityVersion !==
          PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION
      ) &&
      (preflightDraft.nextOverallPick !== 1 || preflightDraft.draftedAssetKeys.length > 0)
    ) {
      throw new HttpsError(
        'failed-precondition',
        'This live draft does not have a frozen projection snapshot. Pause it and repair the draft before continuing.',
      );
    }

    const projection = await loadProjectionSnapshotForDraft(leagueId, preflightDraft);

    if (!projection) {
      throw new HttpsError(
        'failed-precondition',
        `Verified Projection V${SHARED_PROJECTION_VERSION} draft rankings are unavailable.`,
      );
    }

    const projectionSnapshotHash = projection.metadata.snapshotContentHash;

    if (
      !isProjectionSha256(projectionSnapshotHash) ||
      projection.metadata.authoritySchemaVersion !==
        PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION ||
      projection.metadata.snapshotIntegrityStatus !== 'verified'
    ) {
      throw new HttpsError(
        'failed-precondition',
        'The frozen Draft pool is missing its verified server content hash.',
      );
    }

    const canonicalAsset = projection.assets.find((asset) => asset.assetKey === assetKey);

    if (!canonicalAsset) {
      throw new HttpsError(
        'not-found',
        'That player or goalie unit is not part of the frozen draft pool.',
      );
    }

    const result = await db.runTransaction(async (transaction): Promise<SecureDraftPickResult> => {
      const [
        draftSnapshot,
        leagueSnapshot,
        memberSnapshot,
        teamSnapshot,
        existingPickSnapshot,
      ] = await Promise.all([
        transaction.get(draftRef),
        transaction.get(db.doc(`leagues/${leagueId}`)),
        transaction.get(db.doc(`leagues/${leagueId}/members/${userId}`)),
        transaction.get(db.doc(`leagues/${leagueId}/teams/${userId}`)),
        transaction.get(pickRef),
      ]);

      if (existingPickSnapshot.exists) {
        const existingPick = existingPickSnapshot.data() as DraftPick;

        if (draftPickMatchesSubmission(existingPick, submissionIdentity)) {
          return { pick: existingPick };
        }

        throw new HttpsError(
          'already-exists',
          `Pick ${expectedOverallPick} was completed by another submission. Refresh the live board.`,
        );
      }

      if (!draftSnapshot.exists || !leagueSnapshot.exists) {
        throw new HttpsError('not-found', 'Draft or league setup was not found.');
      }

      if (!memberSnapshot.exists && !teamSnapshot.exists) {
        throw new HttpsError('permission-denied', 'You are not an active member of this league.');
      }

      const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

      if (draft.status !== 'live') {
        throw new HttpsError('failed-precondition', 'The draft is not live.');
      }

      if (draft.nextOverallPick !== expectedOverallPick) {
        throw new HttpsError(
          'aborted',
          `The draft advanced from pick ${expectedOverallPick} while the request was being processed.`,
        );
      }

      if (draft.clockStatus === 'stopped') {
        throw new HttpsError('failed-precondition', 'Start the draft clock before making a pick.');
      }

      if (draft.clockStatus === 'paused') {
        throw new HttpsError('failed-precondition', 'The commissioner has paused the draft clock.');
      }

      if (draft.clockStatus !== 'running') {
        throw new HttpsError('failed-precondition', 'The draft clock is not running.');
      }

      if (getDraftClockRemainingSeconds(draft) <= 0) {
        throw new HttpsError(
          'deadline-exceeded',
          'The draft clock expired. The server is processing the automatic pick.',
        );
      }

      if (draft.nextOverallPick > getDraftTotalPickCount(draft)) {
        throw new HttpsError('failed-precondition', 'This draft is already complete.');
      }

      const currentPick = getDraftPickAtOverall(draft, expectedOverallPick);

      if (!currentPick || currentPick.ownerId !== userId) {
        throw new HttpsError('permission-denied', 'You are no longer on the clock.');
      }

      if (
        draft.serverDraftProjectionSnapshotId !== projection.metadata.activeSnapshotId ||
        draft.serverDraftProjectionSnapshotHash !== projectionSnapshotHash ||
        draft.serverDraftProjectionAuthorityVersion !==
          PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION ||
        draft.serverDraftProjectionCatalogHash !== projection.metadata.catalogHash
      ) {
        throw new HttpsError(
          'aborted',
          'The verified Draft pool or its server hash changed while the pick was being submitted. Refresh and try again.',
        );
      }

      if (draft.draftedAssetKeys.includes(assetKey)) {
        throw new HttpsError('already-exists', 'That player or goalie unit has already been drafted.');
      }

      const currentTeamsSnapshot = await transaction.get(
        db.collection(`leagues/${leagueId}/teams`),
      );
      const currentTeamOwnerIds = currentTeamsSnapshot.docs.map((document) => document.id);

      if (!hasExactDraftOwnerSet(draft, currentTeamOwnerIds)) {
        throw new HttpsError(
          'aborted',
          'League membership changed after the draft order was saved. Pause the draft and resolve the team list before continuing.',
        );
      }

      const queueRef = db.doc(`leagues/${leagueId}/draft/current/queues/${userId}`);
      const queueSnapshot = await transaction.get(queueRef);
      const queue = normalizeQueue(
        userId,
        queueSnapshot.exists
          ? queueSnapshot.data() as Partial<DraftQueue>
          : undefined,
      );
      const uniqueRosterOwners = [...new Set(draft.roundOneOrder)];
      const rosterOwners = uniqueRosterOwners
        .map((ownerId) =>
          resolveSafeFirestoreDocumentId(ownerId, FIRESTORE_AUTH_USER_ID_OPTIONS),
        )
        .filter((ownerId): ownerId is string => ownerId !== null);

      if (rosterOwners.length !== uniqueRosterOwners.length) {
        throw new HttpsError(
          'failed-precondition',
          'The saved Draft order contains an invalid manager identity.',
        );
      }

      const rosterRefs = rosterOwners.map((ownerId) =>
        db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`),
      );
      const rosterSnapshots = await Promise.all(
        rosterRefs.map((reference) => transaction.get(reference)),
      );
      const rostersByOwnerId = new Map<string, FantasyRoster>();

      rosterOwners.forEach((ownerId, index) => {
        rostersByOwnerId.set(
          ownerId,
          rosterSnapshots[index].exists
            ? normalizeFantasyRoster(rosterSnapshots[index].data() as Partial<FantasyRoster>)
            : createEmptyFantasyRoster(),
        );
      });

      if ([...rostersByOwnerId.values()].some((roster) => rosterContainsDraftAsset(roster, assetKey))) {
        throw new HttpsError(
          'already-exists',
          'That player or goalie unit is already assigned to a roster.',
        );
      }

      const roster = rostersByOwnerId.get(userId) ?? createEmptyFantasyRoster();
      const destination = getDraftDestination(roster, canonicalAsset.position);

      if (!destination) {
        throw new HttpsError(
          'failed-precondition',
          `Your ${canonicalAsset.position} starters are filled and all ${draft.benchSlots} bench slots are full.`,
        );
      }

      if (!canUseAssetForBench(canonicalAsset, destination, draft, rostersByOwnerId, projection.assets)) {
        throw new HttpsError(
          'failed-precondition',
          `That ${canonicalAsset.position} asset is reserved for a team that still needs a starting ${canonicalAsset.position}.`,
        );
      }

      const updatedRoster = applyDraftAssetToRoster(roster, canonicalAsset, destination);
      const pick: DraftPick = {
        ...currentPick,
        asset: canonicalAsset,
        rosterArea: destination.rosterArea,
        rosterSlotId: destination.slotId,
        selectionType: 'manual',
        selectedByUserId: userId,
        autoPickReason: null,
        submissionId: submissionId ?? null,
        projectionSnapshotId: projection.metadata.activeSnapshotId,
        projectionSnapshotHash,
        projectionAuthorityVersion: PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
      };
      const nextOverallPick = currentPick.overallPick + 1;
      const draftComplete = nextOverallPick > getDraftTotalPickCount(draft);
      const timestamp = FieldValue.serverTimestamp();
      const rosterIndex = rosterOwners.indexOf(userId);
      const rosterSnapshot = rosterSnapshots[rosterIndex];
      const rosterRef = rosterRefs[rosterIndex];

      transaction.set(pickRef, {
        ...pick,
        authority: 'cloud-function',
        madeAt: timestamp,
      });
      transaction.set(
        rosterRef,
        {
          schemaVersion: updatedRoster.schemaVersion,
          activeSlots: updatedRoster.activeSlots,
          benchSlots: updatedRoster.benchSlots,
          irSlots: updatedRoster.irSlots,
          updatedAt: timestamp,
          ...(rosterSnapshot.exists ? {} : { createdAt: timestamp }),
        },
        { merge: true },
      );
      transaction.set(
        queueRef,
        {
          ownerId: userId,
          assetKeys: queue.assetKeys.filter((queuedAssetKey) => queuedAssetKey !== assetKey),
          autoDraftEnabled: queue.autoDraftEnabled,
          consecutiveClockExpirations: queue.autoDraftActivatedByTimeout
            ? queue.consecutiveClockExpirations
            : 0,
          autoDraftActivatedByTimeout: queue.autoDraftActivatedByTimeout,
          updatedAt: timestamp,
        },
        { merge: true },
      );
      transaction.set(
        draftRef,
        {
          status: draftComplete ? 'complete' : 'live',
          nextOverallPick,
          draftedAssetKeys: [...draft.draftedAssetKeys, assetKey],
          clockStatus: draftComplete ? 'complete' : 'running',
          pickStartedAt: draftComplete ? null : timestamp,
          currentPickSeconds: draft.pickSeconds,
          pausedRemainingSeconds: null,
          clockUpdatedBy: userId,
          clockUpdatedAt: timestamp,
          lastPickId: pickId,
          serverAutomationStatus: draftComplete ? 'complete' : 'healthy',
          serverAutomationMessage: draftComplete
            ? 'The final manual pick completed the draft.'
            : `A manager completed pick ${currentPick.overallPick}.`,
          serverAutomationUpdatedAt: timestamp,
          updatedAt: timestamp,
        },
        { merge: true },
      );

      return { pick };
    });

    return result;
  },
);
