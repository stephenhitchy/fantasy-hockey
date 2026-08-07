import { createHash } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import {
  DraftQueue,
  DraftPick,
  DraftRosterRequirements,
  FantasyDraft,
} from './shared/core/draft/draft.models';
import {
  SHARED_PROJECTION_VERSION,
  loadSharedProjectionSnapshot,
} from './shared/core/projection/projection-snapshot.service';
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
  loadProjectionSnapshotForDraft,
  repairDraftTurnFromCommittedPicks,
} from './draft-automation';
import {
  LEAGUE_AUDIT_SCHEMA_VERSION,
  LEAGUE_AUTHORITY_SCHEMA_VERSION,
} from './league-lifecycle-authority.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';

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
const MAX_ASSET_KEY_LENGTH = 180;
const MAX_DRAFT_SUBMISSION_ID_LENGTH = 120;

export type DraftCommandAction =
  | 'save-settings'
  | 'activate-scheduled'
  | 'start-clock'
  | 'pause-clock'
  | 'resume-clock';

interface DraftCommandRequest {
  leagueId?: unknown;
  action?: unknown;
  submissionId?: unknown;
  roundOneOrder?: unknown;
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
  const leagueId = asString(value);

  if (!/^[A-Za-z0-9_-]{3,120}$/.test(leagueId)) {
    throw new HttpsError('invalid-argument', 'A valid league is required.');
  }

  return leagueId;
}

function requireAssetKey(value: unknown): string {
  const assetKey = asString(value);

  if (
    assetKey.length < 2 ||
    assetKey.length > MAX_ASSET_KEY_LENGTH ||
    !/^[A-Za-z0-9:._-]+$/.test(assetKey)
  ) {
    throw new HttpsError('invalid-argument', 'Choose a valid draft asset.');
  }

  return assetKey;
}

function getOptionalDraftSubmissionId(value: unknown): string | null {
  const submissionId = asString(value);

  // Keep one deployment window backward-compatible with older open tabs.
  // The new client always supplies an idempotency key, while a legacy client
  // can still complete its current turn before Hosting asks it to reload.
  if (!submissionId) {
    return null;
  }

  if (
    submissionId.length < 8 ||
    submissionId.length > MAX_DRAFT_SUBMISSION_ID_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(submissionId)
  ) {
    throw new HttpsError(
      'invalid-argument',
      'The draft submission identifier is invalid. Refresh the draft page and try again.',
    );
  }

  return submissionId;
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

  return userId;
}

function normalizePickSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(10 * 60, Math.max(15, Math.ceil(value)))
    : DEFAULT_DRAFT_PICK_SECONDS;
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
      ? value.roundOneOrder.filter(
          (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
        )
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
    serverDraftProjectionSnapshotId:
      typeof value.serverDraftProjectionSnapshotId === 'string'
        ? value.serverDraftProjectionSnapshotId
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
      value?.autoDraftActivatedByTimeout === true && value?.autoDraftEnabled === true,
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

  const order = value.map(asString).filter(Boolean);

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

async function saveDraftSettings(
  leagueId: string,
  userId: string,
  request: DraftCommandRequest,
): Promise<DraftCommandResult> {
  await requireCommissioner(leagueId, userId);

  const submissionId = getOptionalDraftSubmissionId(request.submissionId);
  const roundOneOrder = parseRoundOneOrder(request.roundOneOrder);
  const scheduledStartAt = parseScheduledStartAt(request.scheduledStartAt);
  const pickSeconds = normalizePickSeconds(request.pickSeconds);

  if (!ALLOWED_PICK_SECONDS.has(pickSeconds)) {
    throw new HttpsError('invalid-argument', 'Choose a supported draft clock duration.');
  }

  if (scheduledStartAt) {
    const projection = await loadSharedProjectionSnapshot(leagueId);

    if (
      !projection ||
      projection.metadata.status !== 'ready' ||
      projection.metadata.projectionVersion !== SHARED_PROJECTION_VERSION ||
      projection.metadata.generationReason === 'server-emergency' ||
      projection.assets.length === 0
    ) {
      throw new HttpsError(
        'failed-precondition',
        `Verified Projection V${SHARED_PROJECTION_VERSION} rankings must be ready before scheduling the draft.`,
      );
    }
  }

  const draftRef = db.doc(`leagues/${leagueId}/${DRAFT_DOCUMENT_PATH_SUFFIX}`);
  const leagueRef = db.doc(`leagues/${leagueId}`);
  const teamsQuery = db.collection(`leagues/${leagueId}/teams`).limit(MAX_LEAGUE_TEAMS + 1);
  const inviteLockAuditRef = db.doc(`leagues/${leagueId}/audit/invite-locked-draft-setup`);
  const draftSettingsAuditId = `draft-settings-${createHash('sha256')
    .update(submissionId ?? `${userId}:${Date.now()}:${roundOneOrder.join(',')}:${pickSeconds}`)
    .digest('hex')
    .slice(0, 24)}`;
  const draftSettingsAuditRef = db.doc(`leagues/${leagueId}/audit/${draftSettingsAuditId}`);

  await db.runTransaction(async (transaction) => {
    const [
      draftSnapshot,
      leagueSnapshot,
      teamSnapshot,
      inviteLockAuditSnapshot,
      draftSettingsAuditSnapshot,
    ] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(leagueRef),
      transaction.get(teamsQuery),
      transaction.get(inviteLockAuditRef),
      transaction.get(draftSettingsAuditRef),
    ]);

    if (!leagueSnapshot.exists) {
      throw new HttpsError('not-found', 'This league no longer exists.');
    }

    const leagueData = leagueSnapshot.data() ?? {};
    const inviteCode = asString(leagueData['inviteCode']);
    const inviteRef = inviteCode ? db.doc(`leagueInvites/${inviteCode}`) : null;
    const inviteSnapshot = inviteRef
      ? await transaction.get(inviteRef)
      : null;
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

    let idempotentSettingsReplay = false;

    if (submissionId && existingDraft?.lastSettingsSubmissionId === submissionId) {
      const existingStartAt = asTimestampDate(existingDraft.scheduledStartAt);
      const expectedStatus = scheduledStartAt ? 'scheduled' : 'setup';
      const sameStart =
        (existingStartAt?.getTime() ?? null) === (scheduledStartAt?.getTime() ?? null);
      const sameOrder =
        existingDraft.roundOneOrder.length === roundOneOrder.length &&
        existingDraft.roundOneOrder.every(
          (ownerId, index) => ownerId === roundOneOrder[index],
        );

      if (
        existingDraft.status !== expectedStatus ||
        !sameOrder ||
        !sameStart ||
        existingDraft.pickSeconds !== pickSeconds
      ) {
        throw new HttpsError(
          'already-exists',
          'That draft-settings submission identifier was already used for different settings. Refresh Draft Setup before trying again.',
        );
      }

      idempotentSettingsReplay = true;
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

    const timestamp = FieldValue.serverTimestamp();
    const status = scheduledStartAt ? 'scheduled' : 'setup';

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
          serverDraftProjectionSnapshotId: null,
          serverAutomationStatus: status === 'scheduled' ? 'scheduled' : 'waiting',
          serverAutomationMessage: status === 'scheduled'
            ? 'Draft settings are saved. The server will open the draft at the scheduled time.'
            : 'Draft order saved without a scheduled start time.',
          serverAutomationUpdatedAt: timestamp,
          updatedAt: timestamp,
          ...(draftSnapshot.exists ? {} : { createdAt: timestamp }),
        },
        { merge: true },
      );
    }

    if (asString(leagueData['joinStatus']) !== 'locked') {
      transaction.set(
        leagueRef,
        {
          teamCount: teamSnapshot.size,
          joinStatus: 'locked',
          joinLockedAt: timestamp,
          joinLockedReason: 'draft-order-saved',
          updatedAt: timestamp,
        },
        { merge: true },
      );
    }

    if (inviteRef && inviteSnapshot?.exists && inviteSnapshot.data()?.['active'] !== false) {
      transaction.set(
        inviteRef,
        {
          active: false,
          lockedAt: timestamp,
          lockedReason: 'draft-order-saved',
          updatedAt: timestamp,
        },
        { merge: true },
      );
    }

    if (!inviteLockAuditSnapshot.exists) {
      transaction.create(inviteLockAuditRef, {
        schemaVersion: LEAGUE_AUDIT_SCHEMA_VERSION,
        id: 'invite-locked-draft-setup',
        leagueId,
        action: 'invite-locked',
        actorId: userId,
        actorRole: 'commissioner',
        authority: 'cloud-function',
        authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
        reason: 'Draft order saved; league membership is now frozen.',
        release: 'Security Batch S1C',
        values: {
          teamCount: teamSnapshot.size,
          draftStatus: status,
          inviteCode,
        },
        createdAt: timestamp,
      });
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
        reason: 'Commissioner saved the exact Draft order, start time, and pick clock.',
        release: 'Security Batch S1C',
        previousValues: existingDraft
          ? {
              status: existingDraft.status,
              roundOneOrder: existingDraft.roundOneOrder,
              scheduledStartAt: existingDraft.scheduledStartAt ?? null,
              pickSeconds: existingDraft.pickSeconds,
            }
          : null,
        newValues: {
          status,
          roundOneOrder,
          scheduledStartAt: scheduledStartAt ? Timestamp.fromDate(scheduledStartAt) : null,
          pickSeconds,
        },
        createdAt: timestamp,
      });
    }
  });

  return {
    applied: true,
    action: 'save-settings',
    message: scheduledStartAt
      ? 'Draft settings and scheduled start were saved. League entry is now closed.'
      : 'Draft order was saved. League entry is now closed.',
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
  const projection = await loadProjectionSnapshotForDraft(leagueId, preflightDraft);

  if (!projection) {
    throw new HttpsError(
      'failed-precondition',
      `Verified Projection V${SHARED_PROJECTION_VERSION} draft rankings are unavailable.`,
    );
  }

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(draftRef);

    if (!snapshot.exists) {
      throw new HttpsError('not-found', 'Draft setup was not found.');
    }

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
      !preflightDraft.serverDraftProjectionSnapshotId &&
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

      if (draft.serverDraftProjectionSnapshotId !== projection.metadata.activeSnapshotId) {
        throw new HttpsError(
          'aborted',
          'The frozen draft pool changed while the pick was being submitted. Refresh and try again.',
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
      const rosterOwners = [...new Set(draft.roundOneOrder)];
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
        projectionSnapshotId: projection.metadata.activeSnapshotId,
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
