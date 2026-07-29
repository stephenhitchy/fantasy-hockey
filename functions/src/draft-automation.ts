import { createHash } from 'node:crypto';

import { getFunctions } from 'firebase-admin/functions';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { db } from './shared/core/firebase';
import {
  DraftAutoPickReason,
  DraftPosition,
  DraftQueue,
  DraftSelectionType,
  DraftableAsset,
  DraftPick,
  DraftPickPreview,
  FantasyDraft,
} from './shared/core/draft/draft.models';
import {
  SHARED_PROJECTION_VERSION,
  SharedProjectionSnapshot,
  loadSharedProjectionSnapshot,
} from './shared/core/projection/projection-snapshot.service';
import {
  FantasyRoster,
  RosterAsset,
  RosterStatus,
} from './shared/core/team/roster.models';
import {
  createEmptyFantasyRoster,
  normalizeFantasyRoster,
} from './shared/core/team/roster.service';

const FUNCTION_REGION = 'us-central1';
const SERVER_DRAFT_ACTOR = 'server:draft-automation';
const DRAFT_AUTOMATION_SCAN_LIMIT = 250;
const AUTO_DRAFT_STEP_DELAY_MILLISECONDS = 1_500;
const DRAFT_TASK_DISPATCH_DEADLINE_SECONDS = 60;
const MAX_CLOCK_SECONDS = 10 * 60;
const DEFAULT_PICK_SECONDS = 60;
const DRAFT_AUTOMATION_LEASE_MILLISECONDS = 90_000;
const DRAFT_AUTOMATION_CONTENTION_RETRY_DELAYS = [125, 300, 700, 1_500];

interface DraftAutomationRunResult {
  leagueId: string;
  status: 'opened' | 'picked' | 'waiting' | 'complete' | 'skipped' | 'error';
  picksMade: number;
  message: string;
}

interface DraftDestination {
  rosterArea: 'active' | 'bench';
  slotIndex: number;
  slotId: string;
}

interface DraftAutomationLease {
  referencePath: string;
  token: string;
}

interface DraftClockTaskPayload {
  leagueId: string;
  expectedOverallPick: number;
  expectedPickStartedAtMilliseconds: number;
  expectedDueAtMilliseconds: number;
}

type BenchRole = 'F' | 'D' | 'G';

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isFirestoreContentionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof candidate.code === 'number' ? candidate.code : Number.NaN;
  const combinedMessage = [candidate.message, candidate.details]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');

  return code === 10 || /ABORTED|cross-transaction contention/i.test(combinedMessage);
}

async function withContentionRetry<T>(
  operation: () => Promise<T>,
  context: string,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= DRAFT_AUTOMATION_CONTENTION_RETRY_DELAYS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;

      if (!isFirestoreContentionError(error) || attempt >= DRAFT_AUTOMATION_CONTENTION_RETRY_DELAYS.length) {
        throw error;
      }

      const delay = DRAFT_AUTOMATION_CONTENTION_RETRY_DELAYS[attempt];
      console.warn('Retrying draft automation after Firestore contention.', {
        context,
        attempt: attempt + 1,
        delayMilliseconds: delay,
      });
      await sleep(delay);
    }
  }

  throw lastError;
}

async function claimDraftAutomationLease(
  leagueId: string,
): Promise<DraftAutomationLease | null> {
  const referencePath = `leagues/${leagueId}/draftAutomation/server`;
  const reference = db.doc(referencePath);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const nowMilliseconds = Date.now();
  const expiresAt = Timestamp.fromMillis(
    nowMilliseconds + DRAFT_AUTOMATION_LEASE_MILLISECONDS,
  );

  const acquired = await withContentionRetry(
    () => db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const data = snapshot.data() ?? {};
      const existingExpiresAt = asTimestampDate(data['leaseExpiresAt']);
      const existingToken = typeof data['leaseToken'] === 'string'
        ? data['leaseToken']
        : '';

      if (
        existingToken &&
        existingToken !== token &&
        existingExpiresAt &&
        existingExpiresAt.getTime() > nowMilliseconds
      ) {
        return false;
      }

      transaction.set(
        reference,
        {
          schemaVersion: 1,
          leaseToken: token,
          leaseExpiresAt: expiresAt,
          leaseAcquiredAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return true;
    }),
    `claim lease for ${leagueId}`,
  );

  return acquired ? { referencePath, token } : null;
}

async function releaseDraftAutomationLease(
  lease: DraftAutomationLease,
): Promise<void> {
  const reference = db.doc(lease.referencePath);

  await withContentionRetry(
    () => db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);

      if (!snapshot.exists || snapshot.data()?.['leaseToken'] !== lease.token) {
        return;
      }

      transaction.set(
        reference,
        {
          leaseToken: FieldValue.delete(),
          leaseExpiresAt: FieldValue.delete(),
          leaseReleasedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }),
    `release lease ${lease.referencePath}`,
  ).catch((error: unknown) => {
    console.warn('Unable to release draft automation lease; it will expire automatically.', {
      referencePath: lease.referencePath,
      error,
    });
  });
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


function isVerifiedDraftProjection(
  snapshot: SharedProjectionSnapshot | null,
): snapshot is SharedProjectionSnapshot {
  return Boolean(
    snapshot &&
    snapshot.assets.length > 0 &&
    snapshot.metadata.status === 'ready' &&
    snapshot.metadata.projectionVersion === SHARED_PROJECTION_VERSION &&
    snapshot.metadata.generationReason !== 'server-emergency',
  );
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function loadProjectionAssets(
  leagueId: string,
  snapshotId: string,
): Promise<DraftableAsset[]> {
  const assetsSnapshot = await db
    .collection(`leagues/${leagueId}/projectionSnapshots/${snapshotId}/assets`)
    .get();

  return assetsSnapshot.docs.flatMap((document) => {
    const data = document.data() as {
      assets?: unknown;
      assetKey?: unknown;
    };

    if (Array.isArray(data.assets)) {
      return data.assets as DraftableAsset[];
    }

    return typeof data.assetKey === 'string'
      ? [data as DraftableAsset]
      : [];
  });
}

async function restoreProjectionPointers(
  leagueId: string,
  snapshot: SharedProjectionSnapshot,
): Promise<void> {
  const pointerPayload = {
    ...snapshot.metadata,
    snapshotId: snapshot.metadata.activeSnapshotId,
    activeSnapshotId: snapshot.metadata.activeSnapshotId,
    restoredBy: SERVER_DRAFT_ACTOR,
    restoredAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();

  batch.set(
    db.doc(`leagues/${leagueId}/projectionSnapshots/current`),
    pointerPayload,
    { merge: true },
  );
  batch.set(
    db.doc(
      `leagues/${leagueId}/projectionSnapshots/target-cycle-${Math.max(
        1,
        snapshot.metadata.targetCycleNumber,
      )}`,
    ),
    pointerPayload,
    { merge: true },
  );

  await batch.commit();
}

async function loadVerifiedProjectionSnapshotById(
  leagueId: string,
  snapshotId: string,
): Promise<SharedProjectionSnapshot | null> {
  const metadataDocument = await db.doc(
    `leagues/${leagueId}/projectionSnapshots/${snapshotId}`,
  ).get();

  if (!metadataDocument.exists) {
    return null;
  }

  const data = metadataDocument.data() as Partial<SharedProjectionSnapshot['metadata']>;

  if (
    data.status !== 'ready' ||
    data.projectionVersion !== SHARED_PROJECTION_VERSION ||
    data.generationReason === 'server-emergency' ||
    data.activeSnapshotId !== snapshotId
  ) {
    return null;
  }

  const assets = await loadProjectionAssets(leagueId, snapshotId);
  const expectedAssetCount = asFiniteNumber(data.assetCount);

  if (assets.length === 0 || (expectedAssetCount > 0 && assets.length !== expectedAssetCount)) {
    return null;
  }

  const metadata = {
    ...data,
    snapshotId,
    activeSnapshotId: snapshotId,
    status: 'ready',
    projectionVersion: SHARED_PROJECTION_VERSION,
    generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : '',
    generatedBy: typeof data.generatedBy === 'string' ? data.generatedBy : 'unknown',
    assetCount: assets.length,
    teamCount: Math.max(2, asFiniteNumber(data.teamCount, 2)),
    targetCycleNumber: Math.max(1, asFiniteNumber(data.targetCycleNumber, 1)),
    requiredGamesPerCycle: Math.max(
      1,
      asFiniteNumber(data.requiredGamesPerCycle, 6),
    ),
    generationReason: data.generationReason ?? 'draft-setup',
    draftReadyUntil:
      typeof data.draftReadyUntil === 'string' ? data.draftReadyUntil : '',
    message:
      typeof data.message === 'string'
        ? data.message
        : 'Verified draft rankings are ready.',
  } as SharedProjectionSnapshot['metadata'];
  const snapshot: SharedProjectionSnapshot = { metadata, assets };

  return isVerifiedDraftProjection(snapshot) ? snapshot : null;
}

async function loadVerifiedDraftProjectionSnapshot(
  leagueId: string,
): Promise<SharedProjectionSnapshot | null> {
  const current = await loadSharedProjectionSnapshot(leagueId).catch(() => null);
  const previousGenerationReason =
    current?.metadata.generationReason ?? 'missing';

  if (isVerifiedDraftProjection(current)) {
    return current;
  }

  const metadataSnapshot = await db
    .collection(`leagues/${leagueId}/projectionSnapshots`)
    .get();
  const candidates = metadataSnapshot.docs
    .map((document) => ({
      document,
      data: document.data() as Partial<SharedProjectionSnapshot['metadata']>,
    }))
    .filter(({ document, data }) =>
      data.status === 'ready' &&
      data.projectionVersion === SHARED_PROJECTION_VERSION &&
      data.generationReason !== 'server-emergency' &&
      typeof data.activeSnapshotId === 'string' &&
      data.activeSnapshotId === document.id &&
      asFiniteNumber(data.assetCount) > 0,
    )
    .sort((first, second) => {
      const firstGeneratedAt = Date.parse(
        typeof first.data.generatedAt === 'string' ? first.data.generatedAt : '',
      );
      const secondGeneratedAt = Date.parse(
        typeof second.data.generatedAt === 'string' ? second.data.generatedAt : '',
      );

      return (Number.isFinite(secondGeneratedAt) ? secondGeneratedAt : 0) -
        (Number.isFinite(firstGeneratedAt) ? firstGeneratedAt : 0);
    });

  for (const candidate of candidates) {
    const snapshotId = candidate.document.id;
    const assets = await loadProjectionAssets(leagueId, snapshotId);
    const expectedAssetCount = asFiniteNumber(candidate.data.assetCount);

    if (assets.length === 0 || (expectedAssetCount > 0 && assets.length !== expectedAssetCount)) {
      continue;
    }

    const metadata = {
      ...candidate.data,
      snapshotId,
      activeSnapshotId: snapshotId,
      status: 'ready',
      projectionVersion: SHARED_PROJECTION_VERSION,
      generatedAt:
        typeof candidate.data.generatedAt === 'string'
          ? candidate.data.generatedAt
          : '',
      generatedBy:
        typeof candidate.data.generatedBy === 'string'
          ? candidate.data.generatedBy
          : 'unknown',
      assetCount: assets.length,
      teamCount: Math.max(2, asFiniteNumber(candidate.data.teamCount, 2)),
      targetCycleNumber: Math.max(
        1,
        asFiniteNumber(candidate.data.targetCycleNumber, 1),
      ),
      requiredGamesPerCycle: Math.max(
        1,
        asFiniteNumber(candidate.data.requiredGamesPerCycle, 6),
      ),
      generationReason: candidate.data.generationReason ?? 'draft-setup',
      draftReadyUntil:
        typeof candidate.data.draftReadyUntil === 'string'
          ? candidate.data.draftReadyUntil
          : '',
      message:
        typeof candidate.data.message === 'string'
          ? candidate.data.message
          : 'Verified draft rankings are ready.',
    } as SharedProjectionSnapshot['metadata'];
    const verified: SharedProjectionSnapshot = { metadata, assets };

    if (!isVerifiedDraftProjection(verified)) {
      continue;
    }

    await restoreProjectionPointers(leagueId, verified);

    console.warn('Restored the newest verified projection snapshot for draft automation.', {
      leagueId,
      snapshotId,
      previousGenerationReason,
    });

    return verified;
  }

  return null;
}

async function loadProjectionSnapshotForDraft(
  leagueId: string,
  draft: FantasyDraft,
): Promise<SharedProjectionSnapshot | null> {
  const pinnedSnapshotId = draft.serverDraftProjectionSnapshotId;

  if (typeof pinnedSnapshotId === 'string' && pinnedSnapshotId) {
    return loadVerifiedProjectionSnapshotById(leagueId, pinnedSnapshotId);
  }

  const projection = await loadVerifiedDraftProjectionSnapshot(leagueId);

  if (projection && draft.status === 'live') {
    await db.doc(`leagues/${leagueId}/draft/current`).set(
      {
        serverDraftProjectionSnapshotId: projection.metadata.activeSnapshotId,
        serverProjectionFallbackUsed: false,
        serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  return projection;
}

function getDraftClockTaskQueue() {
  return getFunctions().taskQueue<DraftClockTaskPayload>(
    'processDraftClockDeadline',
  );
}

function buildDraftClockTaskId(payload: DraftClockTaskPayload): string {
  return createHash('sha256')
    .update(
      `${payload.leagueId}:${payload.expectedOverallPick}:${payload.expectedPickStartedAtMilliseconds}:${payload.expectedDueAtMilliseconds}`,
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

  return code.includes('task-already-exists') || /already exists/i.test(message);
}

async function scheduleDraftClockTask(
  leagueId: string,
  draft: FantasyDraft,
): Promise<boolean> {
  if (draft.status !== 'live' || draft.clockStatus !== 'running') {
    return false;
  }

  const currentPick = getPickAtOverall(draft, draft.nextOverallPick);
  const pickStartedAt = asTimestampDate(draft.pickStartedAt);

  if (!currentPick || !pickStartedAt) {
    return false;
  }

  const queueSnapshot = await db.doc(
    `leagues/${leagueId}/draft/current/queues/${currentPick.ownerId}`,
  ).get();
  const queue = normalizeQueue(
    currentPick.ownerId,
    queueSnapshot.exists
      ? (queueSnapshot.data() as Partial<DraftQueue>)
      : undefined,
  );
  const dueAtMilliseconds = queue.autoDraftEnabled
    ? pickStartedAt.getTime() + AUTO_DRAFT_STEP_DELAY_MILLISECONDS
    : pickStartedAt.getTime() +
      normalizePickSeconds(draft.currentPickSeconds ?? draft.pickSeconds) * 1000;
  const payload: DraftClockTaskPayload = {
    leagueId,
    expectedOverallPick: currentPick.overallPick,
    expectedPickStartedAtMilliseconds: pickStartedAt.getTime(),
    expectedDueAtMilliseconds: dueAtMilliseconds,
  };

  try {
    await getDraftClockTaskQueue().enqueue(payload, {
      id: buildDraftClockTaskId(payload),
      scheduleTime: new Date(Math.max(Date.now() + 250, dueAtMilliseconds + 250)),
      dispatchDeadlineSeconds: DRAFT_TASK_DISPATCH_DEADLINE_SECONDS,
    });

    console.info('Scheduled exact draft clock task.', {
      leagueId,
      overallPick: currentPick.overallPick,
      ownerId: currentPick.ownerId,
      autoDraftEnabled: queue.autoDraftEnabled,
      dueAt: new Date(dueAtMilliseconds).toISOString(),
    });

    return true;
  } catch (error: unknown) {
    if (isTaskAlreadyExistsError(error)) {
      return true;
    }

    const message = error instanceof Error
      ? error.message
      : 'Cloud Tasks rejected the draft clock task.';

    console.error('Unable to schedule exact draft clock task.', {
      leagueId,
      overallPick: currentPick.overallPick,
      error,
    });
    await setDraftAutomationError(
      leagueId,
      `Unable to schedule the exact deadline for pick ${currentPick.overallPick}: ${message}`,
    );

    return false;
  }
}

function normalizePickSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_CLOCK_SECONDS, Math.max(15, Math.ceil(value)))
    : DEFAULT_PICK_SECONDS;
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
        : 17,
    rosterRequirements: value.rosterRequirements ?? {
      LW: 3,
      C: 3,
      RW: 3,
      D: 4,
      G: 1,
    },
    benchSlots:
      typeof value.benchSlots === 'number' && Number.isFinite(value.benchSlots)
        ? Math.max(0, Math.trunc(value.benchSlots))
        : 3,
    roundOneOrder: Array.isArray(value.roundOneOrder)
      ? value.roundOneOrder.filter((entry): entry is string => typeof entry === 'string' && !!entry)
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

function getTotalPickCount(draft: FantasyDraft): number {
  return draft.totalRounds * draft.roundOneOrder.length;
}

function getPickAtOverall(draft: FantasyDraft, overallPick: number): DraftPickPreview | null {
  const totalPickCount = getTotalPickCount(draft);

  if (overallPick < 1 || overallPick > totalPickCount || draft.roundOneOrder.length === 0) {
    return null;
  }

  const teamCount = draft.roundOneOrder.length;
  const round = Math.floor((overallPick - 1) / teamCount) + 1;
  const pickInRound = ((overallPick - 1) % teamCount) + 1;
  const order = round % 2 === 1
    ? draft.roundOneOrder
    : [...draft.roundOneOrder].reverse();

  return {
    overallPick,
    round,
    pickInRound,
    ownerId: order[pickInRound - 1],
  };
}

function isScheduledStartReached(draft: FantasyDraft, now = new Date()): boolean {
  const scheduledStart = asTimestampDate(draft.scheduledStartAt);
  return Boolean(scheduledStart && scheduledStart.getTime() <= now.getTime());
}

function isClockExpired(draft: FantasyDraft, now = new Date()): boolean {
  if (draft.status !== 'live' || draft.clockStatus !== 'running') {
    return false;
  }

  const startedAt = asTimestampDate(draft.pickStartedAt);

  if (!startedAt) {
    return false;
  }

  const currentPickSeconds = normalizePickSeconds(
    draft.currentPickSeconds ?? draft.pickSeconds,
  );

  return startedAt.getTime() + currentPickSeconds * 1000 <= now.getTime();
}

function getBenchRole(position: DraftPosition): BenchRole {
  if (position === 'D') {
    return 'D';
  }

  if (position === 'G') {
    return 'G';
  }

  return 'F';
}

function getDestination(roster: FantasyRoster, position: DraftPosition): DraftDestination | null {
  const activeSlotIndex = roster.activeSlots.findIndex(
    (slot) => slot.position === position && slot.asset === null,
  );

  if (activeSlotIndex >= 0) {
    return {
      rosterArea: 'active',
      slotIndex: activeSlotIndex,
      slotId: roster.activeSlots[activeSlotIndex].slotId,
    };
  }

  const benchSlotIndex = roster.benchSlots.findIndex((slot) => slot.asset === null);

  if (benchSlotIndex >= 0) {
    return {
      rosterArea: 'bench',
      slotIndex: benchSlotIndex,
      slotId: roster.benchSlots[benchSlotIndex].slotId,
    };
  }

  return null;
}

function needsAnyStarter(roster: FantasyRoster): boolean {
  return roster.activeSlots.some((slot) => slot.asset === null);
}

function getExistingBenchRoles(roster: FantasyRoster): Set<BenchRole> {
  return new Set(
    roster.benchSlots
      .map((slot) => slot.asset?.position)
      .filter((position): position is DraftPosition => Boolean(position))
      .map(getBenchRole),
  );
}

function automaticCandidateAllowed(
  roster: FantasyRoster,
  asset: DraftableAsset,
  destination: DraftDestination | null,
): boolean {
  if (!destination) {
    return false;
  }

  if (needsAnyStarter(roster)) {
    return destination.rosterArea === 'active';
  }

  if (destination.rosterArea !== 'bench') {
    return false;
  }

  return !getExistingBenchRoles(roster).has(getBenchRole(asset.position));
}

function getAssetDraftValue(asset: DraftableAsset): number | null {
  const candidates = [
    asset.draftScore,
    asset.draftValueAboveReplacement,
    asset.balancedDraftValue,
    asset.floorAdjustedDraftValue,
  ];

  const value = candidates.find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate),
  );

  return value ?? null;
}

function getAssetProjectedCycle(asset: DraftableAsset): number | null {
  const candidates = [
    asset.draftProjectedCyclePoints,
    asset.availabilityAdjustedCyclePoints,
    asset.floorAdjustedCyclePoints,
    asset.projectedCyclePoints,
  ];

  const value = candidates.find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate),
  );

  return value ?? null;
}

function getAssetName(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.fullName
    : `${asset.teamName} Goalie Unit`;
}

function compareDraftValue(first: DraftableAsset, second: DraftableAsset): number {
  const firstValue = getAssetDraftValue(first);
  const secondValue = getAssetDraftValue(second);

  if (firstValue !== null && secondValue !== null && firstValue !== secondValue) {
    return secondValue - firstValue;
  }

  if (firstValue !== null && secondValue === null) {
    return -1;
  }

  if (firstValue === null && secondValue !== null) {
    return 1;
  }

  const firstProjection = getAssetProjectedCycle(first) ?? -1;
  const secondProjection = getAssetProjectedCycle(second) ?? -1;

  if (firstProjection !== secondProjection) {
    return secondProjection - firstProjection;
  }

  return getAssetName(first).localeCompare(getAssetName(second));
}

function canUseAssetForBench(
  asset: DraftableAsset,
  destination: DraftDestination,
  draft: FantasyDraft,
  rostersByOwnerId: Map<string, FantasyRoster>,
  allAssets: DraftableAsset[],
): boolean {
  if (destination.rosterArea !== 'bench') {
    return true;
  }

  const missingStartingAssets = [...rostersByOwnerId.values()].reduce(
    (total, roster) => total + roster.activeSlots.filter(
      (slot) => slot.position === asset.position && slot.asset === null,
    ).length,
    0,
  );

  if (missingStartingAssets <= 0) {
    return true;
  }

  const draftedKeys = new Set(draft.draftedAssetKeys);
  const availableAtPosition = allAssets.filter(
    (candidate) =>
      candidate.position === asset.position &&
      !draftedKeys.has(candidate.assetKey),
  ).length;
  const safeAvailableCount = availableAtPosition > 0
    ? availableAtPosition
    : asset.position === 'G'
      ? Math.max(
          0,
          32 - [...rostersByOwnerId.values()].reduce(
            (total, roster) => total +
              roster.activeSlots.filter((slot) => slot.asset?.position === 'G').length +
              roster.benchSlots.filter((slot) => slot.asset?.position === 'G').length,
            0,
          ),
        )
      : Number.POSITIVE_INFINITY;

  return safeAvailableCount === Number.POSITIVE_INFINITY ||
    Math.max(0, safeAvailableCount - 1) >= missingStartingAssets;
}

function createRosterAsset(
  asset: DraftableAsset,
  rosterStatus: RosterStatus,
): RosterAsset {
  const cycleScore = {
    cycleNumber: 1,
    gamesCounted: 0,
    fantasyPoints: 0,
  };

  if (asset.assetType === 'skater') {
    return {
      ...asset,
      rosterStatus,
      cycleScore,
    };
  }

  return {
    ...asset,
    rosterStatus,
    cycleScore,
  };
}

function selectAutomaticCandidate(input: {
  ownerId: string;
  queue: DraftQueue;
  draft: FantasyDraft;
  roster: FantasyRoster;
  rostersByOwnerId: Map<string, FantasyRoster>;
  assets: DraftableAsset[];
}): { asset: DraftableAsset; selectionType: Extract<DraftSelectionType, 'queue' | 'automatic'> } | null {
  const draftedKeys = new Set(input.draft.draftedAssetKeys);
  const assetsByKey = new Map(input.assets.map((asset) => [asset.assetKey, asset] as const));

  const isEligible = (asset: DraftableAsset): boolean => {
    if (draftedKeys.has(asset.assetKey)) {
      return false;
    }

    const destination = getDestination(input.roster, asset.position);
    return automaticCandidateAllowed(input.roster, asset, destination) &&
      Boolean(destination) &&
      canUseAssetForBench(
        asset,
        destination!,
        input.draft,
        input.rostersByOwnerId,
        input.assets,
      );
  };

  for (const assetKey of input.queue.assetKeys) {
    const asset = assetsByKey.get(assetKey);

    if (asset && isEligible(asset)) {
      return { asset, selectionType: 'queue' };
    }
  }

  const asset = input.assets
    .filter(isEligible)
    .sort(compareDraftValue)[0];

  return asset ? { asset, selectionType: 'automatic' } : null;
}

async function setDraftAutomationError(
  leagueId: string,
  message: string,
): Promise<void> {
  await db.doc(`leagues/${leagueId}/draft/current`).set(
    {
      serverAutomationStatus: 'error',
      serverAutomationMessage: message.slice(0, 500),
      serverAutomationLastErrorAt: FieldValue.serverTimestamp(),
      serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  ).catch(() => undefined);
}

async function openScheduledDraftIfReady(leagueId: string): Promise<boolean> {
  const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
  const initialDraftSnapshot = await draftRef.get();

  if (!initialDraftSnapshot.exists) {
    return false;
  }

  const initialDraft = normalizeDraft(
    initialDraftSnapshot.data() as Partial<FantasyDraft>,
  );
  const shouldOpen =
    (initialDraft.status === 'scheduled' && isScheduledStartReached(initialDraft)) ||
    (initialDraft.status === 'live' && initialDraft.clockStatus === 'stopped');

  if (!shouldOpen) {
    return false;
  }

  const projection = await loadVerifiedDraftProjectionSnapshot(leagueId);

  if (!projection) {
    throw new Error(
      `Verified Projection V${SHARED_PROJECTION_VERSION} draft rankings are unavailable. The draft remained stopped so it cannot make inaccurate automatic selections. Open Draft Setup and save the schedule again to build fresh rankings.`,
    );
  }

  return withContentionRetry(
    () => db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(draftRef);

      if (!snapshot.exists) {
        return false;
      }

      const draft = normalizeDraft(snapshot.data() as Partial<FantasyDraft>);
      const sharedFields = {
        clockStatus: 'running' as const,
        pickStartedAt: FieldValue.serverTimestamp(),
        currentPickSeconds: draft.pickSeconds,
        pausedRemainingSeconds: null,
        clockUpdatedBy: SERVER_DRAFT_ACTOR,
        clockUpdatedAt: FieldValue.serverTimestamp(),
        serverAutomationStatus: 'healthy',
        serverDraftProjectionSnapshotId: projection.metadata.activeSnapshotId,
        serverProjectionFallbackUsed: false,
        serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (draft.status === 'live' && draft.clockStatus === 'stopped') {
        transaction.set(
          draftRef,
          {
            ...sharedFields,
            serverAutomationMessage:
              `The server resumed the draft clock using verified Projection V${SHARED_PROJECTION_VERSION} rankings.`,
          },
          { merge: true },
        );
        return true;
      }

      if (draft.status !== 'scheduled' || !isScheduledStartReached(draft)) {
        return false;
      }

      transaction.set(
        draftRef,
        {
          ...sharedFields,
          status: 'live',
          startedAt: FieldValue.serverTimestamp(),
          serverAutomationMessage:
            `The scheduled draft opened with verified Projection V${SHARED_PROJECTION_VERSION} rankings and its first clock started automatically.`,
        },
        { merge: true },
      );

      return true;
    }),
    `open scheduled draft ${leagueId}`,
  );
}

async function makeOneServerAutomaticPick(
  leagueId: string,
  projectionAssets: DraftableAsset[],
  reasonOverride?: DraftAutoPickReason,
): Promise<boolean> {
  if (projectionAssets.length === 0) {
    throw new Error('No shared projection assets are available for server auto-draft.');
  }

  const draftRef = db.doc(`leagues/${leagueId}/draft/current`);

  return db.runTransaction(async (transaction) => {
    const draftSnapshot = await transaction.get(draftRef);

    if (!draftSnapshot.exists) {
      return false;
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    if (draft.status !== 'live' || draft.clockStatus !== 'running') {
      return false;
    }

    const currentPick = getPickAtOverall(draft, draft.nextOverallPick);

    if (!currentPick) {
      return false;
    }

    const queueRef = db.doc(
      `leagues/${leagueId}/draft/current/queues/${currentPick.ownerId}`,
    );
    const queueSnapshot = await transaction.get(queueRef);
    const queue = normalizeQueue(
      currentPick.ownerId,
      queueSnapshot.exists
        ? (queueSnapshot.data() as Partial<DraftQueue>)
        : undefined,
    );
    const clockExpired = isClockExpired(draft);
    const autoReason: DraftAutoPickReason | null = reasonOverride ??
      (queue.autoDraftEnabled ? 'manager-auto-mode' : clockExpired ? 'timer-expired' : null);

    if (!autoReason) {
      return false;
    }

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

    const roster = rostersByOwnerId.get(currentPick.ownerId) ?? createEmptyFantasyRoster();
    const selected = selectAutomaticCandidate({
      ownerId: currentPick.ownerId,
      queue,
      draft,
      roster,
      rostersByOwnerId,
      assets: projectionAssets,
    });

    if (!selected) {
      throw new Error(
        `No legal automatic draft candidate was available for ${currentPick.ownerId}.`,
      );
    }

    const destination = getDestination(roster, selected.asset.position);

    if (!destination) {
      throw new Error(`No roster destination was available for ${selected.asset.assetKey}.`);
    }

    const rosterAsset = createRosterAsset(
      selected.asset,
      destination.rosterArea === 'active' ? 'active' : 'benched',
    );

    if (destination.rosterArea === 'active') {
      roster.activeSlots[destination.slotIndex] = {
        ...roster.activeSlots[destination.slotIndex],
        asset: rosterAsset,
        openFromCycleNumber: null,
      };
    } else {
      roster.benchSlots[destination.slotIndex] = {
        ...roster.benchSlots[destination.slotIndex],
        asset: rosterAsset,
      };
    }

    let nextConsecutiveClockExpirations = queue.consecutiveClockExpirations;
    let nextAutoDraftEnabled = queue.autoDraftEnabled;
    let nextAutoDraftActivatedByTimeout = queue.autoDraftActivatedByTimeout;

    if (autoReason === 'timer-expired') {
      nextConsecutiveClockExpirations = Math.min(2, queue.consecutiveClockExpirations + 1);

      if (nextConsecutiveClockExpirations >= 2) {
        nextAutoDraftEnabled = true;
        nextAutoDraftActivatedByTimeout = true;
      }
    }

    const pickId = String(currentPick.overallPick).padStart(3, '0');
    const pickRef = db.doc(`leagues/${leagueId}/draft/current/picks/${pickId}`);
    const pick: DraftPick = {
      ...currentPick,
      asset: selected.asset,
      rosterArea: destination.rosterArea,
      rosterSlotId: destination.slotId,
      selectionType: selected.selectionType,
      selectedByUserId: SERVER_DRAFT_ACTOR,
      autoPickReason: autoReason,
    };
    const nextOverallPick = currentPick.overallPick + 1;
    const draftComplete = nextOverallPick > getTotalPickCount(draft);
    const rosterRef = db.doc(
      `leagues/${leagueId}/teams/${currentPick.ownerId}/roster/current`,
    );

    transaction.set(pickRef, {
      ...pick,
      madeAt: FieldValue.serverTimestamp(),
    });
    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        benchSlots: roster.benchSlots,
        irSlots: roster.irSlots,
        updatedAt: FieldValue.serverTimestamp(),
        ...(rosterSnapshots[rosterOwners.indexOf(currentPick.ownerId)].exists
          ? {}
          : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );
    transaction.set(
      queueRef,
      {
        ownerId: currentPick.ownerId,
        assetKeys: queue.assetKeys.filter((assetKey) => assetKey !== selected.asset.assetKey),
        autoDraftEnabled: nextAutoDraftEnabled,
        consecutiveClockExpirations: nextConsecutiveClockExpirations,
        autoDraftActivatedByTimeout: nextAutoDraftActivatedByTimeout,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      draftRef,
      {
        status: draftComplete ? 'complete' : 'live',
        nextOverallPick,
        draftedAssetKeys: [...draft.draftedAssetKeys, selected.asset.assetKey],
        clockStatus: draftComplete ? 'complete' : 'running',
        pickStartedAt: draftComplete ? null : FieldValue.serverTimestamp(),
        currentPickSeconds: draft.pickSeconds,
        pausedRemainingSeconds: null,
        clockUpdatedBy: SERVER_DRAFT_ACTOR,
        clockUpdatedAt: FieldValue.serverTimestamp(),
        lastPickId: pickId,
        serverAutomationStatus: draftComplete ? 'complete' : 'healthy',
        serverAutomationMessage: draftComplete
          ? 'The server completed the draft.'
          : `The server selected ${getAssetName(selected.asset)} for pick ${currentPick.overallPick}.`,
        serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return true;
  });
}

async function processLeagueDraftAutomation(
  leagueId: string,
): Promise<DraftAutomationRunResult> {
  const lease = await claimDraftAutomationLease(leagueId);

  if (!lease) {
    return {
      leagueId,
      status: 'waiting',
      picksMade: 0,
      message: 'Another server worker is already processing this draft.',
    };
  }

  try {
    const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
    let draftSnapshot = await draftRef.get();

    if (!draftSnapshot.exists) {
      return {
        leagueId,
        status: 'skipped',
        picksMade: 0,
        message: 'No draft document exists.',
      };
    }

    let draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);
    let opened = false;

    if (
      (draft.status === 'scheduled' && isScheduledStartReached(draft)) ||
      (draft.status === 'live' && draft.clockStatus === 'stopped')
    ) {
      opened = await openScheduledDraftIfReady(leagueId);
      draftSnapshot = await draftRef.get();
      draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);
    }

    if (draft.status === 'complete') {
      return {
        leagueId,
        status: 'complete',
        picksMade: 0,
        message: 'Draft is complete.',
      };
    }

    if (draft.status !== 'live' || draft.clockStatus !== 'running') {
      return {
        leagueId,
        status: opened ? 'opened' : 'waiting',
        picksMade: 0,
        message: opened
          ? 'The draft opened and the first clock started.'
          : 'Draft is waiting for its scheduled start or is paused.',
      };
    }

    const currentPick = getPickAtOverall(draft, draft.nextOverallPick);

    if (!currentPick) {
      return {
        leagueId,
        status: 'complete',
        picksMade: 0,
        message: 'Draft has no remaining picks.',
      };
    }

    const queueSnapshot = await db.doc(
      `leagues/${leagueId}/draft/current/queues/${currentPick.ownerId}`,
    ).get();
    const currentQueue = normalizeQueue(
      currentPick.ownerId,
      queueSnapshot.exists
        ? (queueSnapshot.data() as Partial<DraftQueue>)
        : undefined,
    );

    if (!currentQueue.autoDraftEnabled && !isClockExpired(draft)) {
      const taskScheduled = await scheduleDraftClockTask(leagueId, draft);

      if (!taskScheduled) {
        throw new Error('The exact draft clock deadline could not be scheduled.');
      }

      return {
        leagueId,
        status: opened ? 'opened' : 'waiting',
        picksMade: 0,
        message: opened
          ? 'The draft opened and its exact pick-deadline task was scheduled.'
          : 'The current manager is still within the pick clock.',
      };
    }

    const projection = await loadProjectionSnapshotForDraft(leagueId, draft);

    if (!projection) {
      throw new Error(
        `Verified Projection V${SHARED_PROJECTION_VERSION} draft rankings are unavailable. Automatic drafting was stopped to prevent inaccurate selections.`,
      );
    }

    const picked = await withContentionRetry(
      () => makeOneServerAutomaticPick(leagueId, projection.assets),
      `automatic pick for ${leagueId}`,
    );
    const updatedDraftSnapshot = await draftRef.get();

    if (updatedDraftSnapshot.exists) {
      const updatedDraft = normalizeDraft(
        updatedDraftSnapshot.data() as Partial<FantasyDraft>,
      );

      if (updatedDraft.status === 'live' && updatedDraft.clockStatus === 'running') {
        const taskScheduled = await scheduleDraftClockTask(leagueId, updatedDraft);

        if (!taskScheduled) {
          throw new Error('The next exact draft clock deadline could not be scheduled.');
        }
      }
    }

    return {
      leagueId,
      status: picked ? 'picked' : opened ? 'opened' : 'waiting',
      picksMade: picked ? 1 : 0,
      message: picked
        ? 'The server made one automatic draft pick and scheduled the next exact deadline.'
        : opened
          ? 'The draft opened and the first clock started.'
          : 'The current manager is still within the pick clock.',
    };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : 'Server draft automation failed.';
    await setDraftAutomationError(leagueId, message);
    console.error('Server draft automation failed.', { leagueId, message, error });

    return {
      leagueId,
      status: 'error',
      picksMade: 0,
      message,
    };
  } finally {
    await releaseDraftAutomationLease(lease);
  }
}

async function getAutomatedDraftLeagueIds(): Promise<string[]> {
  const draftSnapshot = await db.collectionGroup('draft')
    .where('status', 'in', ['scheduled', 'live'])
    .limit(DRAFT_AUTOMATION_SCAN_LIMIT)
    .get();

  return [...new Set(
    draftSnapshot.docs
      .filter((document) => document.id === 'current')
      .map((document) => document.ref.parent.parent?.id ?? '')
      .filter(Boolean),
  )].sort();
}

export const runScheduledDraftAutomation = onSchedule(
  {
    schedule: '* * * * *',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    const startedAt = Date.now();
    const leagueIds = await getAutomatedDraftLeagueIds();
    const results: DraftAutomationRunResult[] = [];

    for (const leagueId of leagueIds) {
      results.push(await processLeagueDraftAutomation(leagueId));
    }

    const failed = results.filter((result) => result.status === 'error');
    const picksMade = results.reduce((sum, result) => sum + result.picksMade, 0);

    const durationMilliseconds = Date.now() - startedAt;

    await db.doc('appData/draftAutomation').set(
      {
        schemaVersion: 1,
        status: failed.length > 0 ? 'partial-error' : 'success',
        activeDraftCount: leagueIds.length,
        picksMade,
        failedDraftCount: failed.length,
        failures: failed.slice(0, 10).map((result) => ({
          leagueId: result.leagueId,
          message: result.message.slice(0, 300),
        })),
        durationMilliseconds,
        lastRunAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    console.info('Scheduled draft automation scan completed.', {
      activeDraftCount: leagueIds.length,
      picksMade,
      failedDraftCount: failed.length,
      durationMilliseconds,
    });
  },
);

export const processDraftClockDeadline = onTaskDispatched<DraftClockTaskPayload>(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '512MiB',
    retryConfig: {
      maxAttempts: 5,
      minBackoffSeconds: 2,
    },
    rateLimits: {
      maxConcurrentDispatches: 10,
    },
  },
  async (request) => {
    const payload = request.data;

    if (
      !payload ||
      typeof payload.leagueId !== 'string' ||
      !payload.leagueId ||
      !Number.isFinite(payload.expectedOverallPick) ||
      !Number.isFinite(payload.expectedPickStartedAtMilliseconds) ||
      !Number.isFinite(payload.expectedDueAtMilliseconds)
    ) {
      console.warn('Ignored malformed draft clock task.', { payload });
      return;
    }

    const draftRef = db.doc(`leagues/${payload.leagueId}/draft/current`);
    const draftSnapshot = await draftRef.get();

    if (!draftSnapshot.exists) {
      return;
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);
    const pickStartedAt = asTimestampDate(draft.pickStartedAt);

    if (
      draft.status !== 'live' ||
      draft.clockStatus !== 'running' ||
      draft.nextOverallPick !== Math.trunc(payload.expectedOverallPick) ||
      !pickStartedAt ||
      pickStartedAt.getTime() !== Math.trunc(payload.expectedPickStartedAtMilliseconds)
    ) {
      console.info('Ignored stale draft clock task.', {
        leagueId: payload.leagueId,
        expectedOverallPick: payload.expectedOverallPick,
        currentOverallPick: draft.nextOverallPick,
      });
      return;
    }

    const millisecondsUntilDue = Math.trunc(payload.expectedDueAtMilliseconds) - Date.now();

    if (millisecondsUntilDue > 0) {
      await sleep(Math.min(millisecondsUntilDue, 5_000));
    }

    const refreshedSnapshot = await draftRef.get();

    if (!refreshedSnapshot.exists) {
      return;
    }

    const refreshedDraft = normalizeDraft(
      refreshedSnapshot.data() as Partial<FantasyDraft>,
    );
    const refreshedPickStartedAt = asTimestampDate(refreshedDraft.pickStartedAt);

    if (
      refreshedDraft.status !== 'live' ||
      refreshedDraft.clockStatus !== 'running' ||
      refreshedDraft.nextOverallPick !== Math.trunc(payload.expectedOverallPick) ||
      !refreshedPickStartedAt ||
      refreshedPickStartedAt.getTime() !==
        Math.trunc(payload.expectedPickStartedAtMilliseconds)
    ) {
      return;
    }

    if (Date.now() + 100 < Math.trunc(payload.expectedDueAtMilliseconds)) {
      throw new Error('Draft clock task arrived before its exact deadline. Retrying shortly.');
    }

    const result = await processLeagueDraftAutomation(payload.leagueId);

    if (result.status === 'error') {
      throw new Error(result.message);
    }

    if (result.status === 'waiting' && result.message.includes('Another server worker')) {
      throw new Error('Another draft worker holds the lease. Retrying this pick shortly.');
    }

    console.info('Exact draft clock task completed.', {
      leagueId: payload.leagueId,
      expectedOverallPick: payload.expectedOverallPick,
      status: result.status,
      picksMade: result.picksMade,
      message: result.message,
    });
  },
);

export const continueServerDraftAutomation = onDocumentWritten(
  {
    document: 'leagues/{leagueId}/draft/current',
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '512MiB',
    retry: false,
  },
  async (event) => {
    const before = event.data?.before.exists
      ? normalizeDraft(event.data.before.data() as Partial<FantasyDraft>)
      : null;
    const after = event.data?.after.exists
      ? normalizeDraft(event.data.after.data() as Partial<FantasyDraft>)
      : null;

    if (!after || after.status !== 'live' || after.clockStatus !== 'running') {
      return;
    }

    const meaningfulProgress =
      !before ||
      before.status !== after.status ||
      before.clockStatus !== after.clockStatus ||
      before.nextOverallPick !== after.nextOverallPick;

    if (!meaningfulProgress) {
      return;
    }

    const result = await processLeagueDraftAutomation(event.params.leagueId);

    if (result.status === 'error') {
      throw new Error(result.message);
    }

    if (result.status === 'waiting' && result.message.includes('Another server worker')) {
      const taskScheduled = await scheduleDraftClockTask(event.params.leagueId, after);

      if (!taskScheduled) {
        throw new Error('Unable to schedule the exact draft clock deadline.');
      }
    }
  },
);

export const processAutoDraftQueueChange = onDocumentWritten(
  {
    document: 'leagues/{leagueId}/draft/current/queues/{ownerId}',
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '512MiB',
    retry: false,
  },
  async (event) => {
    const after = event.data?.after.exists
      ? normalizeQueue(
          event.params.ownerId,
          event.data.after.data() as Partial<DraftQueue>,
        )
      : null;
    const beforeEnabled = event.data?.before.exists
      ? event.data.before.data()?.['autoDraftEnabled'] === true
      : false;

    if (!after?.autoDraftEnabled || beforeEnabled) {
      return;
    }

    const draftSnapshot = await db.doc(
      `leagues/${event.params.leagueId}/draft/current`,
    ).get();

    if (!draftSnapshot.exists) {
      return;
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);
    const currentPick = getPickAtOverall(draft, draft.nextOverallPick);

    if (!currentPick || currentPick.ownerId !== event.params.ownerId) {
      return;
    }

    const result = await processLeagueDraftAutomation(event.params.leagueId);

    if (result.status === 'error') {
      throw new Error(result.message);
    }

    if (result.status === 'waiting' && result.message.includes('Another server worker')) {
      const taskScheduled = await scheduleDraftClockTask(event.params.leagueId, draft);

      if (!taskScheduled) {
        throw new Error('Unable to schedule the auto-draft task.');
      }
    }
  },
);
