import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';

import { db } from '../firebase';
import {
  type AutoDraftBenchRole,
  getAutoDraftBenchRole,
  getAutoDraftCandidateBlockReason,
} from './auto-draft-strategy';

import {
  getCycleTeamWindowsRef,
  normalizeFantasyTeamCycleWindows,
} from '../cycle/asset-cycle-window.service';

import { FantasyAssetCycleWindow } from '../cycle/cycle.models';

import { applyImmediateRosterMove } from '../transactions/immediate-roster-move.service';

import {
  createEmptyFantasyRoster,
  getFantasyRosterRef,
  normalizeFantasyRoster,
} from '../team/roster.service';

import {
  ActiveRosterSlot,
  FantasyRoster,
  PendingRosterSlotMove,
  RosterAsset,
  RosterStatus,
} from '../team/roster.models';

import {
  getPlayerAvailabilityForPlayer,
  getPlayerIrIneligibleReason,
  isPlayerIrEligible,
} from '../player/player-availability.service';

import { PlayerAvailabilityStatus } from '../player/player-availability.models';

import {
  DraftAutoPickReason,
  DraftableAsset,
  DraftPick,
  DraftPickPreview,
  DraftPosition,
  DraftProjection,
  DraftQueue,
  DraftRosterRequirements,
  DraftSelectionType,
  DraftStatus,
  FantasyDraft,
} from './draft.models';

import type { FantasyTeam } from '../team/team.service';

import {
  resolveRosterMoveAssetCycleEligibility,
} from '../transactions/roster-move-eligibility.service';


const DRAFT_DOCUMENT_ID = 'current';

export const DEFAULT_DRAFT_PICK_SECONDS = 60;
export const DRAFT_PICK_SECONDS_OPTIONS = [30, 45, 60, 90, 120] as const;

const MAX_DRAFT_QUEUE_SIZE = 100;

function reportDraftListenerError(
  error: unknown,
  fallbackMessage: string,
  onError?: (error: Error) => void,
): void {
  const normalizedError = error instanceof Error ? error : new Error(fallbackMessage);

  if (onError) {
    onError(normalizedError);
    return;
  }

  console.error(fallbackMessage, error);
}

export type FantasyTransactionType =
  | 'add-drop'
  | 'add-open-slot'
  | 'move-to-ir'
  | 'activate-from-ir'
  | 'drop-to-waivers'
  | 'waiver-claim'
  | 'waiver-award'
  | 'waiver-cleared'
  | 'queue-add-drop'
  | 'queue-add-open-slot'
  | 'queue-waiver-award'
  | 'slot-move-activated'
  | 'cancel-queued-move'
  | 'queue-active-bench-swap'
  | 'active-bench-swap-activated'
  | 'move-bench-to-ir'
  | 'activate-ir-to-bench';

export interface FantasyTransaction {
  id: string;
  type: FantasyTransactionType;
  ownerId: string;
  addedAsset?: DraftableAsset | null;
  droppedAsset?: RosterAsset | null;
  movedAsset?: RosterAsset | null;
  activatedAsset?: RosterAsset | null;
  waiverId?: string | null;
  waiverAsset?: DraftableAsset | null;
  winningOwnerId?: string | null;
  dropSlotId?: string | null;
  targetSlotId?: string | null;
  activeSlotId?: string | null;
  benchSlotId?: string | null;
  irSlotId?: string | null;
  availabilityStatus?: PlayerAvailabilityStatus | null;
  availabilityLabel?: string | null;
  sourceRosterArea?: RosterDropSource | null;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
  queuedMoveId?: string | null;
  rosterSlotId?: string | null;
  createdAt?: unknown;
}

export type FantasyWaiverStatus = 'active' | 'claimed' | 'cleared';

export type FantasyWaiverClaimMoveType = 'drop' | 'open-slot';

export interface FantasyWaiverClaim {
  ownerId: string;
  moveType: FantasyWaiverClaimMoveType;
  rosterArea?: 'active' | 'bench';
  dropSlotId?: string | null;
  targetSlotId?: string | null;
  waiverPriorityAtClaim?: number | null;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
  claimedAt?: unknown;
}

export interface FantasyWaiver {
  id: string;
  assetKey: string;
  asset: DraftableAsset;
  droppedAsset?: RosterAsset | null;
  droppedByOwnerId: string;
  status: FantasyWaiverStatus;
  claims: FantasyWaiverClaim[];
  awardedToOwnerId?: string | null;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
  queuedMoveId?: string | null;
  rosterSlotId?: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  processedAt?: unknown;
}

export interface AddDropRosterAssetInput {
  leagueId: string;
  ownerId: string;
  dropSlotId: string;
  addAsset: DraftableAsset;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
  leagueOwnerIds?: string[];
  preferImmediateCurrentCycle?: boolean;
}

export interface AddOpenRosterAssetInput {
  leagueId: string;
  ownerId: string;
  targetSlotId: string;
  addAsset: DraftableAsset;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
  leagueOwnerIds?: string[];
  preferImmediateCurrentCycle?: boolean;
}

export interface MoveRosterAssetToIrInput {
  leagueId: string;
  ownerId: string;
  activeSlotId: string;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
}

export interface MoveBenchRosterAssetToIrInput {
  leagueId: string;
  ownerId: string;
  benchSlotId: string;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
}

export interface QueueActiveBenchSwapInput {
  leagueId: string;
  ownerId: string;
  activeSlotId: string;
  benchSlotId: string;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
}

export interface ActivateIrRosterAssetInput {
  leagueId: string;
  ownerId: string;
  irSlotId: string;
  activeSlotId?: string | null;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
}

export interface ActivateIrRosterAssetToBenchInput {
  leagueId: string;
  ownerId: string;
  irSlotId: string;
  benchSlotId?: string | null;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
}

export type RosterDropSource = 'active' | 'bench' | 'ir';

export interface DropRosterAssetToWaiversInput {
  leagueId: string;
  ownerId: string;
  sourceRosterArea: RosterDropSource;
  slotId: string;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
}

export interface PlaceWaiverClaimInput {
  leagueId: string;
  ownerId: string;
  waiverId: string;
  moveType: FantasyWaiverClaimMoveType;
  rosterArea?: 'active' | 'bench';
  dropSlotId?: string | null;
  targetSlotId?: string | null;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
}

export interface ProcessWaiverInput {
  leagueId: string;
  commissionerId: string;
  waiverId: string;
  leagueTeams: FantasyTeam[];
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
}

export interface RosterMoveExecutionResult {
  mode: 'immediate' | 'queued' | 'ownership-only';
  effectiveCycleNumber: number | null;
}

export const DEFAULT_DRAFT_ROSTER_REQUIREMENTS: DraftRosterRequirements = {
  LW: 3,
  C: 3,
  RW: 3,
  D: 4,
  G: 1,
};

export const DEFAULT_DRAFT_BENCH_SLOTS = 3;

export const DEFAULT_DRAFT_TOTAL_ROUNDS =
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS.LW +
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS.C +
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS.RW +
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS.D +
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS.G +
  DEFAULT_DRAFT_BENCH_SLOTS;

function getDraftRef(leagueId: string) {
  return doc(db, 'leagues', leagueId, 'draft', DRAFT_DOCUMENT_ID);
}

function getSharedProjectionPointerRef(leagueId: string) {
  return doc(db, 'leagues', leagueId, 'projectionSnapshots', 'current');
}

function assertReadySharedProjectionSnapshot(snapshot: {
  exists: () => boolean;
  data: () => unknown;
}): void {
  if (!snapshot.exists()) {
    throw new Error(
      'Shared projections are not ready. The commissioner must build them before the draft clock can start.',
    );
  }

  const data = snapshot.data() as {
    status?: unknown;
    activeSnapshotId?: unknown;
    assetCount?: unknown;
  };

  if (
    data.status !== 'ready' ||
    typeof data.activeSnapshotId !== 'string' ||
    data.activeSnapshotId.trim() === '' ||
    typeof data.assetCount !== 'number' ||
    data.assetCount <= 0
  ) {
    throw new Error(
      'Shared projections are incomplete. The commissioner must rebuild them before the draft clock can start.',
    );
  }
}

function getDraftPicksRef(leagueId: string) {
  return collection(db, 'leagues', leagueId, 'draft', DRAFT_DOCUMENT_ID, 'picks');
}

function getCyclesRef(leagueId: string) {
  return collection(db, 'leagues', leagueId, 'cycles');
}

function getCycleRosterSlotPickRef(
  leagueId: string,
  cycleNumber: number,
  ownerId: string,
  rosterSlotId: string,
) {
  const documentId = `${ownerId}__${rosterSlotId}`.replace(/[^a-zA-Z0-9_-]/g, '-');

  return doc(
    db,
    'leagues',
    leagueId,
    'cycles',
    `cycle-${cycleNumber}`,
    'rosterPicks',
    documentId,
  );
}

function createUntouchedWindowFromPick(
  pick: DraftPick,
  cycleNumber: number,
  rosterSlotId: string,
): FantasyAssetCycleWindow {
  return {
    id: pick.cycleWindowId ?? `${pick.ownerId}__${rosterSlotId}__cycle-${cycleNumber}`,
    ownerId: pick.ownerId,
    rosterSlotId,
    cycleNumber,
    position: pick.asset.position,
    assetKey: pick.asset.assetKey,
    asset: pick.asset,
    status: 'scheduled',
    scheduledGameIds: [],
    scheduledGameDates: [],
    scheduledGameLabels: [],
    completedGameIds: [],
    liveGameIds: [],
    appearanceGameIds: [],
    gameScores: {},
    gameStates: {},
    scheduledGames: 0,
    gamesPlayed: 0,
    actualGamesPlayed: 0,
    gamesLeft: 0,
    fantasyPoints: 0,
    frozenProjectionPoints: null,
    frozenProjectionVersion: null,
    frozenProjectionSource: null,
    frozenProjectionSnapshotId: null,
    frozenProjectionGeneratedAt: null,
    frozenProjectionFrozenAt: null,
    frozenProjectionTargetGameIds: [],
    firstScheduledGameDate: null,
    lastScheduledGameDate: null,
    startedAt: null,
    completedAt: null,
  };
}

async function hasStartedFantasyCycle(leagueId: string): Promise<boolean> {
  const snapshot = await getDocs(
    query(getCyclesRef(leagueId), orderBy('cycleNumber', 'desc'), limit(1)),
  );

  return !snapshot.empty;
}

async function getLeagueRequiredGamesPerCycle(leagueId: string): Promise<number> {
  const leagueSnapshot = await getDoc(doc(db, 'leagues', leagueId));
  const scoringRules = leagueSnapshot.data()?.['scoringRules'] as
    | { requiredGamesPerCycle?: unknown }
    | undefined;
  const value = scoringRules?.requiredGamesPerCycle;

  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 6;
}

function isUntouchedRosterWindow(window: FantasyAssetCycleWindow | null): boolean {
  return Boolean(
    window &&
    window.gamesPlayed === 0 &&
    window.actualGamesPlayed === 0 &&
    window.fantasyPoints === 0 &&
    window.completedGameIds.length === 0 &&
    window.liveGameIds.length === 0 &&
    window.appearanceGameIds.length === 0,
  );
}

async function getLatestRosterSlotWindow(
  leagueId: string,
  ownerId: string,
  rosterSlotId: string,
): Promise<FantasyAssetCycleWindow | null> {
  const cyclesSnapshot = await getDocs(
    query(getCyclesRef(leagueId), orderBy('cycleNumber', 'desc')),
  );

  for (const cycleDocument of cyclesSnapshot.docs) {
    const cycleData = cycleDocument.data() as {
      cycleNumber?: number;
      status?: string;
    };

    if (cycleData.status !== 'active' || typeof cycleData.cycleNumber !== 'number') {
      continue;
    }

    const [teamWindowsSnapshot, rosterPickSnapshot] = await Promise.all([
      getDoc(getCycleTeamWindowsRef(leagueId, cycleData.cycleNumber, ownerId)),
      getDoc(
        getCycleRosterSlotPickRef(
          leagueId,
          cycleData.cycleNumber,
          ownerId,
          rosterSlotId,
        ),
      ),
    ]);

    if (teamWindowsSnapshot.exists()) {
      const teamWindows = normalizeFantasyTeamCycleWindows(
        ownerId,
        cycleData.cycleNumber,
        teamWindowsSnapshot.data(),
      );
      const window = teamWindows.windows.find(
        (candidate) => candidate.rosterSlotId === rosterSlotId,
      );

      if (window) {
        return window;
      }
    }

    if (rosterPickSnapshot.exists()) {
      return createUntouchedWindowFromPick(
        rosterPickSnapshot.data() as DraftPick,
        cycleData.cycleNumber,
        rosterSlotId,
      );
    }
  }

  return null;
}

function getDraftQueuesRef(leagueId: string) {
  return collection(db, 'leagues', leagueId, 'draft', DRAFT_DOCUMENT_ID, 'queues');
}

function getDraftQueueRef(leagueId: string, ownerId: string) {
  return doc(db, 'leagues', leagueId, 'draft', DRAFT_DOCUMENT_ID, 'queues', ownerId);
}

function getTransactionsRef(leagueId: string) {
  return collection(db, 'leagues', leagueId, 'transactions');
}

function getLeagueRef(leagueId: string) {
  return doc(db, 'leagues', leagueId);
}

function getTeamRef(leagueId: string, ownerId: string) {
  return doc(db, 'leagues', leagueId, 'teams', ownerId);
}

function getWaiversRef(leagueId: string) {
  return collection(db, 'leagues', leagueId, 'waivers');
}

function getWaiverRef(leagueId: string, waiverId: string) {
  return doc(db, 'leagues', leagueId, 'waivers', waiverId);
}

export function getDraftPickDocumentId(overallPick: number): string {
  return overallPick.toString().padStart(3, '0');
}

function getDraftPickRef(leagueId: string, overallPick: number) {
  return doc(
    db,
    'leagues',
    leagueId,
    'draft',
    DRAFT_DOCUMENT_ID,
    'picks',
    getDraftPickDocumentId(overallPick),
  );
}

function normalizePickSeconds(value: unknown): number {
  if (
    typeof value === 'number' &&
    DRAFT_PICK_SECONDS_OPTIONS.includes(value as (typeof DRAFT_PICK_SECONDS_OPTIONS)[number])
  ) {
    return value;
  }

  return DEFAULT_DRAFT_PICK_SECONDS;
}

function normalizeDraftQueue(ownerId: string, data: Partial<DraftQueue> | undefined): DraftQueue {
  const consecutiveClockExpirations =
    typeof data?.consecutiveClockExpirations === 'number' &&
    Number.isFinite(data.consecutiveClockExpirations)
      ? Math.min(2, Math.max(0, Math.trunc(data.consecutiveClockExpirations)))
      : 0;

  return {
    ownerId,
    assetKeys: Array.isArray(data?.assetKeys)
      ? data.assetKeys.filter((assetKey): assetKey is string => typeof assetKey === 'string')
      : [],
    autoDraftEnabled: data?.autoDraftEnabled === true,
    consecutiveClockExpirations,
    autoDraftActivatedByTimeout:
      data?.autoDraftActivatedByTimeout === true && data?.autoDraftEnabled === true,
    updatedAt: data?.updatedAt,
  };
}

function normalizeDraft(data: Partial<FantasyDraft>): FantasyDraft {
  const scheduledStartAt = data.scheduledStartAt ?? null;
  const status = data.status ?? (scheduledStartAt ? 'scheduled' : 'setup');
  const sourceSchemaVersion =
    typeof data.schemaVersion === 'number' && Number.isFinite(data.schemaVersion)
      ? Math.max(1, Math.trunc(data.schemaVersion))
      : 1;
  const shouldUpgradeLegacyDraft = sourceSchemaVersion < 3 && status !== 'complete';

  const pickSeconds = normalizePickSeconds(data.pickSeconds);

  return {
    schemaVersion: shouldUpgradeLegacyDraft ? 3 : sourceSchemaVersion,
    status,
    format: 'snake',
    totalRounds: shouldUpgradeLegacyDraft
      ? DEFAULT_DRAFT_TOTAL_ROUNDS
      : data.totalRounds ?? DEFAULT_DRAFT_TOTAL_ROUNDS,
    rosterRequirements: data.rosterRequirements ?? {
      ...DEFAULT_DRAFT_ROSTER_REQUIREMENTS,
    },
    benchSlots: shouldUpgradeLegacyDraft
      ? DEFAULT_DRAFT_BENCH_SLOTS
      : typeof data.benchSlots === 'number' && data.benchSlots >= 0
        ? Math.trunc(data.benchSlots)
        : DEFAULT_DRAFT_BENCH_SLOTS,
    roundOneOrder: Array.isArray(data.roundOneOrder) ? data.roundOneOrder : [],
    nextOverallPick: typeof data.nextOverallPick === 'number' ? data.nextOverallPick : 1,
    draftedAssetKeys: Array.isArray(data.draftedAssetKeys) ? data.draftedAssetKeys : [],
    scheduledStartAt,
    pickSeconds,
    clockStatus:
      data.clockStatus ??
      (status === 'complete' ? 'complete' : status === 'live' ? 'running' : 'stopped'),
    pickStartedAt: data.pickStartedAt ?? null,
    currentPickSeconds:
      typeof data.currentPickSeconds === 'number'
        ? Math.max(1, Math.min(pickSeconds, Math.ceil(data.currentPickSeconds)))
        : pickSeconds,
    pausedRemainingSeconds:
      typeof data.pausedRemainingSeconds === 'number'
        ? Math.max(0, Math.min(pickSeconds, Math.ceil(data.pausedRemainingSeconds)))
        : null,
    clockUpdatedBy: data.clockUpdatedBy ?? null,
    clockUpdatedAt: data.clockUpdatedAt,
    lastPickId: data.lastPickId ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    startedAt: data.startedAt,
  };
}

export function createDefaultFantasyDraft(roundOneOrder: string[]): FantasyDraft {
  return {
    schemaVersion: 3,
    status: 'setup',
    format: 'snake',
    totalRounds: DEFAULT_DRAFT_TOTAL_ROUNDS,
    rosterRequirements: {
      ...DEFAULT_DRAFT_ROSTER_REQUIREMENTS,
    },
    benchSlots: DEFAULT_DRAFT_BENCH_SLOTS,
    roundOneOrder,
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt: null,
    pickSeconds: DEFAULT_DRAFT_PICK_SECONDS,
    clockStatus: 'stopped',
    pickStartedAt: null,
    currentPickSeconds: DEFAULT_DRAFT_PICK_SECONDS,
    pausedRemainingSeconds: null,
    clockUpdatedBy: null,
    lastPickId: null,
  };
}

export async function getFantasyDraft(leagueId: string): Promise<FantasyDraft | null> {
  const snapshot = await getDoc(getDraftRef(leagueId));

  if (!snapshot.exists()) {
    return null;
  }

  return normalizeDraft(snapshot.data() as Partial<FantasyDraft>);
}

export function listenToFantasyDraft(
  leagueId: string,
  callback: (draft: FantasyDraft | null) => void,
  onError?: (error: Error) => void,
): () => void {
  return onSnapshot(
    getDraftRef(leagueId),
    (snapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }

      callback(normalizeDraft(snapshot.data() as Partial<FantasyDraft>));
    },
    (error) => {
      reportDraftListenerError(error, 'Unable to load the league draft.', onError);
    },
  );
}

export function listenToDraftPicks(
  leagueId: string,
  callback: (picks: DraftPick[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const picksQuery = query(getDraftPicksRef(leagueId), orderBy('overallPick', 'asc'));

  return onSnapshot(
    picksQuery,
    (snapshot) => {
      callback(snapshot.docs.map((pickDoc) => pickDoc.data() as DraftPick));
    },
    (error) => {
      reportDraftListenerError(error, 'Unable to load draft picks.', onError);
    },
  );
}

export function listenToDraftQueue(
  leagueId: string,
  ownerId: string,
  callback: (queue: DraftQueue) => void,
): () => void {
  return onSnapshot(getDraftQueueRef(leagueId, ownerId), (snapshot) => {
    callback(
      normalizeDraftQueue(
        ownerId,
        snapshot.exists() ? (snapshot.data() as Partial<DraftQueue>) : undefined,
      ),
    );
  });
}

export function listenToDraftQueues(
  leagueId: string,
  callback: (queues: DraftQueue[]) => void,
): () => void {
  return onSnapshot(getDraftQueuesRef(leagueId), (snapshot) => {
    callback(
      snapshot.docs.map((queueDocument) =>
        normalizeDraftQueue(queueDocument.id, queueDocument.data() as Partial<DraftQueue>),
      ),
    );
  });
}

export async function saveDraftQueue(
  leagueId: string,
  ownerId: string,
  assetKeys: string[],
  autoDraftEnabled: boolean,
): Promise<void> {
  const normalizedAssetKeys = [
    ...new Set(
      assetKeys
        .filter((assetKey) => typeof assetKey === 'string')
        .map((assetKey) => assetKey.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_DRAFT_QUEUE_SIZE);

  await setDoc(
    getDraftQueueRef(leagueId, ownerId),
    {
      ownerId,
      assetKeys: normalizedAssetKeys,
      autoDraftEnabled,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function setDraftAutoDraftEnabled(
  leagueId: string,
  ownerId: string,
  autoDraftEnabled: boolean,
): Promise<void> {
  const queueReference = getDraftQueueRef(leagueId, ownerId);

  const snapshot = await getDoc(queueReference);
  const queue = normalizeDraftQueue(
    ownerId,
    snapshot.exists() ? (snapshot.data() as Partial<DraftQueue>) : undefined,
  );

  await setDoc(
    queueReference,
    {
      ownerId,
      assetKeys: queue.assetKeys,
      autoDraftEnabled,
      consecutiveClockExpirations: 0,
      autoDraftActivatedByTimeout: false,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export function listenToOwnerTransactions(
  leagueId: string,
  ownerId: string,
  callback: (transactions: FantasyTransaction[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const transactionsQuery = query(
    getTransactionsRef(leagueId),
    orderBy('createdAt', 'desc'),
    limit(50),
  );

  return onSnapshot(
    transactionsQuery,
    (snapshot) => {
      callback(
        snapshot.docs
          .map((transactionDoc) => ({
            id: transactionDoc.id,
            ...(transactionDoc.data() as Omit<FantasyTransaction, 'id'>),
          }))
          .filter((transaction) => transaction.ownerId === ownerId),
      );
    },
    (error) => {
      reportDraftListenerError(error, 'Unable to load roster transactions.', onError);
    },
  );
}

export function listenToLeagueWaivers(
  leagueId: string,
  callback: (waivers: FantasyWaiver[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const waiversQuery = query(getWaiversRef(leagueId), orderBy('createdAt', 'desc'), limit(100));

  return onSnapshot(
    waiversQuery,
    (snapshot) => {
      callback(
        snapshot.docs.map((waiverDoc) => {
          const data = waiverDoc.data() as Partial<FantasyWaiver>;

          return {
            id: waiverDoc.id,
            assetKey: data.assetKey ?? waiverDoc.id,
            asset: data.asset as DraftableAsset,
            droppedAsset: data.droppedAsset ?? null,
            droppedByOwnerId: data.droppedByOwnerId ?? '',
            status: data.status ?? 'active',
            claims: Array.isArray(data.claims) ? data.claims : [],
            awardedToOwnerId: data.awardedToOwnerId ?? null,
            effectiveCycleNumber: data.effectiveCycleNumber ?? null,
            effectiveLabel: data.effectiveLabel ?? null,
            queuedMoveId: data.queuedMoveId ?? null,
            rosterSlotId: data.rosterSlotId ?? null,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            processedAt: data.processedAt,
          };
        }),
      );
    },
    (error) => {
      reportDraftListenerError(error, 'Unable to load league waivers.', onError);
    },
  );
}

export async function saveFantasyDraft(leagueId: string, draft: FantasyDraft): Promise<void> {
  const pickSeconds = normalizePickSeconds(draft.pickSeconds);

  await setDoc(
    getDraftRef(leagueId),
    {
      schemaVersion: 3,
      status: draft.status,
      format: draft.format,
      totalRounds: draft.totalRounds,
      rosterRequirements: draft.rosterRequirements,
      benchSlots: draft.benchSlots,
      roundOneOrder: draft.roundOneOrder,
      nextOverallPick: draft.nextOverallPick,
      draftedAssetKeys: draft.draftedAssetKeys,
      scheduledStartAt: draft.scheduledStartAt ?? null,
      pickSeconds,
      clockStatus:
        draft.status === 'complete'
          ? 'complete'
          : draft.status === 'live'
            ? draft.clockStatus
            : 'stopped',
      pickStartedAt: draft.status === 'live' ? (draft.pickStartedAt ?? null) : null,
      currentPickSeconds:
        draft.status === 'live' ? (draft.currentPickSeconds ?? pickSeconds) : pickSeconds,
      pausedRemainingSeconds:
        draft.status === 'live' ? (draft.pausedRemainingSeconds ?? null) : null,
      clockUpdatedBy: draft.clockUpdatedBy ?? null,
      lastPickId: draft.lastPickId ?? null,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export function getScheduledStartDate(draft: FantasyDraft | null): Date | null {
  const value = draft?.scheduledStartAt;

  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    const timestampLike = value as {
      toDate?: () => Date;
    };

    if (typeof timestampLike.toDate === 'function') {
      return timestampLike.toDate();
    }
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsedDate = new Date(value);

    if (!Number.isNaN(parsedDate.getTime())) {
      return parsedDate;
    }
  }

  return null;
}

export function getDraftPickStartedDate(draft: FantasyDraft | null): Date | null {
  const value = draft?.pickStartedAt;

  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    const timestampLike = value as {
      toDate?: () => Date;
    };

    if (typeof timestampLike.toDate === 'function') {
      return timestampLike.toDate();
    }
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsedDate = new Date(value);

    if (!Number.isNaN(parsedDate.getTime())) {
      return parsedDate;
    }
  }

  return null;
}

export function getDraftClockRemainingSeconds(
  draft: FantasyDraft | null,
  now: Date = new Date(),
): number {
  if (!draft || draft.status !== 'live') {
    return 0;
  }

  if (draft.clockStatus === 'paused') {
    return Math.max(0, Math.ceil(draft.pausedRemainingSeconds ?? 0));
  }

  if (draft.clockStatus !== 'running') {
    return 0;
  }

  const startedAt = getDraftPickStartedDate(draft);

  if (!startedAt) {
    return draft.currentPickSeconds ?? draft.pickSeconds;
  }

  const durationSeconds = draft.currentPickSeconds ?? draft.pickSeconds;

  return Math.max(
    0,
    Math.ceil((startedAt.getTime() + durationSeconds * 1000 - now.getTime()) / 1000),
  );
}

export function isDraftClockExpired(draft: FantasyDraft | null, now: Date = new Date()): boolean {
  return Boolean(
    draft?.status === 'live' &&
    draft.clockStatus === 'running' &&
    getDraftClockRemainingSeconds(draft, now) <= 0,
  );
}

export function isDraftStartTimeReached(
  draft: FantasyDraft | null,
  now: Date = new Date(),
): boolean {
  const startDate = getScheduledStartDate(draft);

  return Boolean(startDate && now.getTime() >= startDate.getTime());
}

export async function activateScheduledDraftIfReady(
  leagueId: string,
  activatedByUserId?: string,
): Promise<FantasyDraft | null> {
  const draftRef = getDraftRef(leagueId);

  // Read the shared projection pointer once before entering the transaction.
  // Firestore transactions can automatically retry every document read when
  // the service is throttled. Keeping this readiness check outside the
  // transaction prevents projectionSnapshots/current from being fetched again
  // on every retry while the draft document itself remains atomic.
  const projectionSnapshot = await getDoc(getSharedProjectionPointerRef(leagueId));

  assertReadySharedProjectionSnapshot(projectionSnapshot);

  return runTransaction(
    db,
    async (transaction) => {
      const snapshot = await transaction.get(draftRef);

      if (!snapshot.exists()) {
        return null;
      }

      const draft = normalizeDraft(snapshot.data() as Partial<FantasyDraft>);

      if (draft.status !== 'scheduled' || !isDraftStartTimeReached(draft)) {
        return draft;
      }

      transaction.update(draftRef, {
        status: 'live',
        clockStatus: 'stopped',
        pickStartedAt: null,
        currentPickSeconds: draft.pickSeconds,
        pausedRemainingSeconds: null,
        clockUpdatedBy: activatedByUserId ?? null,
        clockUpdatedAt: serverTimestamp(),
        startedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      return {
        ...draft,
        status: 'live',
        clockStatus: 'stopped',
        pickStartedAt: null,
        currentPickSeconds: draft.pickSeconds,
        pausedRemainingSeconds: null,
        clockUpdatedBy: activatedByUserId ?? null,
      };
    },
    {
      maxAttempts: 2,
    },
  );
}

export async function startDraftClock(leagueId: string, ownerId: string): Promise<void> {
  const draftRef = getDraftRef(leagueId);

  await runTransaction(db, async (transaction) => {
    const [draftSnapshot, projectionSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(getSharedProjectionPointerRef(leagueId)),
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    if (draft.status !== 'live') {
      throw new Error('The live draft has not opened yet.');
    }

    assertReadySharedProjectionSnapshot(projectionSnapshot);

    if (draft.clockStatus === 'running') {
      return;
    }

    if (draft.clockStatus === 'paused') {
      throw new Error('The commissioner has paused the draft clock.');
    }

    if (draft.clockStatus !== 'stopped') {
      throw new Error('The draft clock cannot be started right now.');
    }

    const currentPick = getDraftPickAtOverall(draft, draft.nextOverallPick);

    if (!currentPick || currentPick.ownerId !== ownerId) {
      throw new Error(
        'Only the manager currently making the first pick can start the draft clock.',
      );
    }

    transaction.update(draftRef, {
      clockStatus: 'running',
      pickStartedAt: serverTimestamp(),
      currentPickSeconds: draft.pickSeconds,
      pausedRemainingSeconds: null,
      clockUpdatedBy: ownerId,
      clockUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

export async function pauseDraftClock(leagueId: string, commissionerId: string): Promise<void> {
  const draftRef = getDraftRef(leagueId);
  const leagueRef = getLeagueRef(leagueId);

  await runTransaction(db, async (transaction) => {
    const [draftSnapshot, leagueSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(leagueRef),
    ]);

    if (!draftSnapshot.exists() || !leagueSnapshot.exists()) {
      throw new Error('Draft or league setup was not found.');
    }

    const leagueData = leagueSnapshot.data() as {
      commissionerId?: string;
    };

    if (leagueData.commissionerId !== commissionerId) {
      throw new Error('Only the commissioner can pause the draft clock.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    if (draft.status !== 'live' || draft.clockStatus !== 'running') {
      return;
    }

    const remainingSeconds = Math.max(1, getDraftClockRemainingSeconds(draft));

    transaction.update(draftRef, {
      clockStatus: 'paused',
      pickStartedAt: null,
      currentPickSeconds: remainingSeconds,
      pausedRemainingSeconds: remainingSeconds,
      clockUpdatedBy: commissionerId,
      clockUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

export async function resumeDraftClock(leagueId: string, commissionerId: string): Promise<void> {
  const draftRef = getDraftRef(leagueId);
  const leagueRef = getLeagueRef(leagueId);

  await runTransaction(db, async (transaction) => {
    const [draftSnapshot, leagueSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(leagueRef),
    ]);

    if (!draftSnapshot.exists() || !leagueSnapshot.exists()) {
      throw new Error('Draft or league setup was not found.');
    }

    const leagueData = leagueSnapshot.data() as {
      commissionerId?: string;
    };

    if (leagueData.commissionerId !== commissionerId) {
      throw new Error('Only the commissioner can resume the draft clock.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    if (draft.status !== 'live' || draft.clockStatus !== 'paused') {
      return;
    }

    const remainingSeconds = Math.max(
      1,
      Math.min(draft.pickSeconds, draft.pausedRemainingSeconds ?? draft.pickSeconds),
    );

    transaction.update(draftRef, {
      clockStatus: 'running',
      pickStartedAt: serverTimestamp(),
      currentPickSeconds: remainingSeconds,
      pausedRemainingSeconds: null,
      clockUpdatedBy: commissionerId,
      clockUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

export function getDraftTotalPickCount(draft: FantasyDraft | null): number {
  if (!draft) {
    return 0;
  }

  return draft.totalRounds * draft.roundOneOrder.length;
}

export function getDraftPickAtOverall(
  draft: FantasyDraft | null,
  overallPick: number,
): DraftPickPreview | null {
  if (!draft || overallPick < 1 || overallPick > getDraftTotalPickCount(draft)) {
    return null;
  }

  const teamCount = draft.roundOneOrder.length;
  const round = Math.floor((overallPick - 1) / teamCount) + 1;

  const pickInRound = ((overallPick - 1) % teamCount) + 1;

  const roundOrder = round % 2 === 1 ? draft.roundOneOrder : [...draft.roundOneOrder].reverse();

  return {
    overallPick,
    round,
    pickInRound,
    ownerId: roundOrder[pickInRound - 1],
  };
}

export function getCurrentDraftPick(draft: FantasyDraft | null): DraftPickPreview | null {
  if (draft?.status !== 'live') {
    return null;
  }

  return getDraftPickAtOverall(draft, draft.nextOverallPick);
}

export function buildSnakePickPreview(
  roundOneOrder: string[],
  totalRounds: number,
): DraftPickPreview[] {
  const draft = createDefaultFantasyDraft(roundOneOrder);

  return Array.from({ length: roundOneOrder.length * totalRounds }, (_, index) =>
    getDraftPickAtOverall(
      {
        ...draft,
        totalRounds,
      },
      index + 1,
    ),
  ).filter((pick): pick is DraftPickPreview => pick !== null);
}

function getStoredProjectionFields(asset: DraftableAsset | RosterAsset): DraftProjection {
  return {
    projectedSeasonPoints: asset.projectedSeasonPoints ?? null,
    projectedCyclePoints: asset.projectedCyclePoints ?? null,
    seasonBaselineCyclePoints: asset.seasonBaselineCyclePoints ?? null,
    recentFormAdjustment: asset.recentFormAdjustment ?? null,
    roleAdjustment: asset.roleAdjustment ?? null,
    scheduleStrengthAdjustment: asset.scheduleStrengthAdjustment ?? null,
    scheduleStrengthMultiplier: asset.scheduleStrengthMultiplier ?? null,
    scheduleDifficultyRating: asset.scheduleDifficultyRating ?? null,
    scheduleDifficultyLabel: asset.scheduleDifficultyLabel ?? null,
    scheduleDataConfidence: asset.scheduleDataConfidence ?? null,
    projectionHomeGames: asset.projectionHomeGames ?? null,
    projectionRoadGames: asset.projectionRoadGames ?? null,
    projectionBackToBackGames: asset.projectionBackToBackGames ?? null,
    projectionRestAdvantageGames: asset.projectionRestAdvantageGames ?? null,
    projectionOpponentAbbreviations: asset.projectionOpponentAbbreviations ?? null,
    projectionDataSeason: asset.projectionDataSeason ?? null,
    projectionDataSource: (asset.projectionDataSource ??
      null) as DraftProjection['projectionDataSource'],
    projectionGamesPlayed: asset.projectionGamesPlayed ?? null,
    recentFormSampleSize: asset.recentFormSampleSize ?? null,
    seasonFantasyPointsPerGame: asset.seasonFantasyPointsPerGame ?? null,
    recentThreeGameFantasyPointsPerGame: asset.recentThreeGameFantasyPointsPerGame ?? null,
    recentFiveGameFantasyPointsPerGame: asset.recentFiveGameFantasyPointsPerGame ?? null,
    recentTenGameFantasyPointsPerGame: asset.recentTenGameFantasyPointsPerGame ?? null,
    seasonAverageTimeOnIceMinutes: asset.seasonAverageTimeOnIceMinutes ?? null,
    recentAverageTimeOnIceMinutes: asset.recentAverageTimeOnIceMinutes ?? null,
    actualRecentAppearances: asset.actualRecentAppearances ?? null,
    missedRecentTeamGames: asset.missedRecentTeamGames ?? null,
    weightedRecentAppearances: asset.weightedRecentAppearances ?? null,
    fullWeightRecentGames: asset.fullWeightRecentGames ?? null,
    partialWeightRecentGames: asset.partialWeightRecentGames ?? null,
    healthyProjectedCyclePoints: asset.healthyProjectedCyclePoints ?? null,
    scheduledGamesInProjectionCycle: asset.scheduledGamesInProjectionCycle ?? null,
    expectedGamesAvailable: asset.expectedGamesAvailable ?? null,
    expectedGamesMissed: asset.expectedGamesMissed ?? null,
    availabilityAdjustment: asset.availabilityAdjustment ?? null,
    availabilityAdjustedCyclePoints: asset.availabilityAdjustedCyclePoints ?? null,
    availabilityStatus: (asset.availabilityStatus ?? null) as DraftProjection['availabilityStatus'],
    availabilityLabel: asset.availabilityLabel ?? null,
    availabilityReturnDate: asset.availabilityReturnDate ?? null,
    availabilityNote: asset.availabilityNote ?? null,
    availabilityAsOf: asset.availabilityAsOf ?? null,
    targetProjectionCycleNumber: asset.targetProjectionCycleNumber ?? null,
    sharedProjectionSnapshotId: asset.sharedProjectionSnapshotId ?? null,
    projectionGeneratedAt: asset.projectionGeneratedAt ?? null,
    balancedDraftValue: asset.balancedDraftValue ?? null,
    balancedRank: asset.balancedRank ?? null,
    positionRank: asset.positionRank ?? null,
    reliabilityRating: asset.reliabilityRating ?? null,
    volatilityPenalty: asset.volatilityPenalty ?? null,
    floorAdjustedCyclePoints: asset.floorAdjustedCyclePoints ?? null,
    floorAdjustedDraftValue: asset.floorAdjustedDraftValue ?? null,
    eligibleFromCycleNumber: asset.eligibleFromCycleNumber ?? null,
  };
}

function createRosterAsset(
  asset: DraftableAsset,
  rosterStatus: RosterStatus = 'active',
): RosterAsset {
  const cycleScore = {
    cycleNumber: 1,
    gamesCounted: 0,
    fantasyPoints: 0,
  };

  if (asset.assetType === 'skater') {
    return {
      assetType: 'skater',
      assetKey: asset.assetKey,
      position: asset.position,
      player: asset.player,
      ...getStoredProjectionFields(asset),
      rosterStatus,
      cycleScore,
    };
  }

  return {
    assetType: 'team-goalie-unit',
    assetKey: asset.assetKey,
    position: 'G',
    teamName: asset.teamName,
    teamAbbreviation: asset.teamAbbreviation,
    teamLogoUrl: asset.teamLogoUrl,
    ...getStoredProjectionFields(asset),
    rosterStatus,
    cycleScore,
  };
}

function createPendingRosterMove(
  moveType: PendingRosterSlotMove['moveType'],
  ownerId: string,
  slot: ActiveRosterSlot,
  incomingAsset: DraftableAsset,
  sourceWaiverId: string | null,
  requestedEffectiveCycleNumber: number | null,
  requestedEffectiveLabel: string | null,
  sourceBenchSlotId: string | null = null,
  outgoingDestination: 'waivers' | 'bench' = 'waivers',
): PendingRosterSlotMove {
  return {
    id: `${ownerId}__${slot.slotId}__${Date.now()}`,
    moveType,
    incomingAsset: createRosterAsset(
      incomingAsset,
      sourceBenchSlotId ? 'benched' : 'new',
    ),
    outgoingAssetKey: getRosterAssetKey(slot.asset),
    sourceWaiverId,
    queuedByOwnerId: ownerId,
    queuedAt: new Date().toISOString(),
    requestedEffectiveCycleNumber,
    requestedEffectiveLabel,
    sourceBenchSlotId,
    outgoingDestination,
  };
}

function assertSlotHasNoPendingMove(slot: ActiveRosterSlot): void {
  if (slot.pendingMove) {
    throw new Error(
      `A roster move is already queued for ${slot.slotId}. Wait for that slot's current six-game window to finish.`,
    );
  }
}

function getRosterAssetKey(asset: RosterAsset | null): string {
  if (!asset) {
    return '';
  }

  if (asset.assetKey) {
    return asset.assetKey;
  }

  if (asset.assetType === 'skater') {
    const player = asset.player as {
      id?: number | string;
      playerId?: number | string;
      nhlPlayerId?: number | string;
    };

    const playerId = player.id ?? player.playerId ?? player.nhlPlayerId;

    return playerId ? `skater-${playerId}` : '';
  }

  return asset.teamAbbreviation ? `goalie-unit-${asset.teamAbbreviation}` : '';
}

function rosterAssetToDraftableAsset(asset: RosterAsset): DraftableAsset {
  const assetKey = getRosterAssetKey(asset);

  if (asset.assetType === 'skater') {
    return {
      assetType: 'skater',
      assetKey,
      position: asset.position,
      player: asset.player,
      ...getStoredProjectionFields(asset),
    };
  }

  return {
    assetType: 'team-goalie-unit',
    assetKey,
    position: 'G',
    teamName: asset.teamName,
    teamAbbreviation: asset.teamAbbreviation,
    teamLogoUrl: asset.teamLogoUrl,
    ...getStoredProjectionFields(asset),
  };
}

function buildActiveWaiverPayload(
  droppedAsset: RosterAsset,
  droppedByOwnerId: string,
  effectiveCycleNumber: number | null,
  effectiveLabel: string | null,
): Omit<FantasyWaiver, 'id'> {
  const asset = rosterAssetToDraftableAsset(droppedAsset);

  return {
    assetKey: asset.assetKey,
    asset,
    droppedAsset,
    droppedByOwnerId,
    status: 'active',
    claims: [],
    awardedToOwnerId: null,
    effectiveCycleNumber,
    effectiveLabel,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    processedAt: null,
  };
}

function getTeamWaiverPriority(team: FantasyTeam | undefined, fallback: number): number {
  return typeof team?.waiverPriority === 'number' ? team.waiverPriority : fallback;
}

function getPositionRequirement(draft: FantasyDraft, position: DraftPosition): number {
  return draft.rosterRequirements[position];
}

interface DraftRosterDestination {
  rosterArea: 'active' | 'bench';
  slotIndex: number;
  slotId: string;
}

function getDraftRosterDestination(
  roster: FantasyRoster,
  position: DraftPosition,
): DraftRosterDestination | null {
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

function assertGoalieReserveForBenchPick(
  draft: FantasyDraft,
  ownerId: string,
  asset: DraftableAsset,
  rostersByOwnerId: Map<string, FantasyRoster>,
  destination: DraftRosterDestination,
): void {
  if (asset.position !== 'G' || destination.rosterArea !== 'bench') {
    return;
  }

  const ownerRoster = rostersByOwnerId.get(ownerId);
  const ownerNeedsStartingGoalie = ownerRoster?.activeSlots.some(
    (slot) => slot.position === 'G' && slot.asset === null,
  );

  if (ownerNeedsStartingGoalie) {
    return;
  }

  const missingStartingGoalies = [...rostersByOwnerId.values()].filter((roster) =>
    roster.activeSlots.some((slot) => slot.position === 'G' && slot.asset === null),
  ).length;

  const draftedGoalieUnits = [...rostersByOwnerId.values()].reduce((total, roster) => {
    const activeGoalies = roster.activeSlots.filter((slot) => slot.asset?.position === 'G').length;
    const benchGoalies = roster.benchSlots.filter((slot) => slot.asset?.position === 'G').length;
    return total + activeGoalies + benchGoalies;
  }, 0);

  const remainingGoalieUnitsAfterPick = Math.max(0, 32 - draftedGoalieUnits - 1);

  if (remainingGoalieUnitsAfterPick < missingStartingGoalies) {
    throw new Error(
      'That goalie unit is reserved for a team that still needs its starting goalie. Choose a different bench player.',
    );
  }
}

interface MakeDraftPickInternalInput {
  leagueId: string;
  actorUserId: string;
  ownerId: string;
  asset: DraftableAsset;
  selectionType: DraftSelectionType;
  autoPickReason?: DraftAutoPickReason | null;
}

async function makeDraftPickInternal({
  leagueId,
  actorUserId,
  ownerId,
  asset,
  selectionType,
  autoPickReason = null,
}: MakeDraftPickInternalInput): Promise<DraftPick> {
  const draftRef = getDraftRef(leagueId);
  const leagueRef = getLeagueRef(leagueId);

  return runTransaction(db, async (transaction) => {
    const [draftSnapshot, leagueSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(leagueRef),
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    if (!leagueSnapshot.exists()) {
      throw new Error('League setup was not found.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    if (draft.status !== 'live') {
      throw new Error(
        'The draft is waiting for the commissioner to refresh the injury report and open it.',
      );
    }

    if (draft.clockStatus === 'stopped') {
      throw new Error('The first manager must start the draft clock before making a pick.');
    }

    if (draft.clockStatus === 'paused') {
      throw new Error('The draft clock is currently paused.');
    }

    if (draft.clockStatus !== 'running') {
      throw new Error('The draft clock is not running.');
    }

    if (draft.nextOverallPick > getDraftTotalPickCount(draft)) {
      throw new Error('This draft is already complete.');
    }

    const currentPick = getDraftPickAtOverall(draft, draft.nextOverallPick);

    if (!currentPick) {
      throw new Error('Unable to determine the current draft pick.');
    }

    if (currentPick.ownerId !== ownerId) {
      throw new Error('That manager is no longer on the clock.');
    }

    const leagueData = leagueSnapshot.data() as {
      commissionerId?: string;
    };

    const isAutomaticSelection = selectionType !== 'manual';

    if (!isAutomaticSelection && actorUserId !== ownerId) {
      throw new Error('Managers can only make their own manual draft picks.');
    }

    const queueRef = getDraftQueueRef(leagueId, ownerId);

    const queueSnapshot = await transaction.get(queueRef);
    const queue = normalizeDraftQueue(
      ownerId,
      queueSnapshot.exists() ? (queueSnapshot.data() as Partial<DraftQueue>) : undefined,
    );

    if (isAutomaticSelection) {
      if (leagueData.commissionerId !== actorUserId) {
        throw new Error('Only the commissioner can process automatic draft picks.');
      }

      if (!queue.autoDraftEnabled && !isDraftClockExpired(draft)) {
        throw new Error('The manager is not on auto-draft and the pick timer has not expired.');
      }
    }

    let nextConsecutiveClockExpirations = queue.consecutiveClockExpirations;
    let nextAutoDraftEnabled = queue.autoDraftEnabled;
    let nextAutoDraftActivatedByTimeout = queue.autoDraftActivatedByTimeout;

    if (selectionType === 'manual') {
      if (!queue.autoDraftActivatedByTimeout) {
        nextConsecutiveClockExpirations = 0;
      }
    } else if (autoPickReason === 'timer-expired') {
      nextConsecutiveClockExpirations = Math.min(2, queue.consecutiveClockExpirations + 1);

      if (nextConsecutiveClockExpirations >= 2) {
        nextAutoDraftEnabled = true;
        nextAutoDraftActivatedByTimeout = true;
      }
    }

    if (draft.draftedAssetKeys.includes(asset.assetKey)) {
      throw new Error('That player or goalie unit has already been drafted.');
    }

    const rosterOwners = Array.from(new Set([...draft.roundOneOrder, ownerId]));
    const rosterRefs = rosterOwners.map((rosterOwnerId) =>
      getFantasyRosterRef(leagueId, rosterOwnerId),
    );
    const rosterSnapshots = await Promise.all(
      rosterRefs.map((rosterRef) => transaction.get(rosterRef)),
    );

    const rostersByOwnerId = new Map<string, FantasyRoster>();
    rosterOwners.forEach((rosterOwnerId, index) => {
      const snapshot = rosterSnapshots[index];
      rostersByOwnerId.set(
        rosterOwnerId,
        snapshot.exists()
          ? normalizeFantasyRoster(snapshot.data() as Partial<FantasyRoster>)
          : createEmptyFantasyRoster(),
      );
    });

    const rosterRef = getFantasyRosterRef(leagueId, ownerId);
    const rosterSnapshotIndex = rosterOwners.indexOf(ownerId);
    const rosterSnapshot = rosterSnapshots[rosterSnapshotIndex];
    const roster = rostersByOwnerId.get(ownerId) ?? createEmptyFantasyRoster();
    const destination = getDraftRosterDestination(roster, asset.position);

    if (!destination) {
      throw new Error(
        `Your ${asset.position} starters are filled and all ${draft.benchSlots} bench slots are full.`,
      );
    }

    if (isAutomaticSelection) {
      const blockReason = getAutoDraftCandidateBlockReason({
        hasOpenStartingSlot: roster.activeSlots.some((slot) => slot.asset === null),
        destination: destination.rosterArea,
        assetPosition: asset.position,
        existingBenchRoles: new Set(
          roster.benchSlots
            .map((slot) => slot.asset?.position)
            .filter((position): position is DraftPosition => !!position)
            .map((position) => getAutoDraftBenchRole(position)),
        ) as Set<AutoDraftBenchRole>,
      });

      if (blockReason === 'fill-starters-first') {
        throw new Error(
          'Auto-draft must fill every starting roster spot before selecting bench players.',
        );
      }

      if (blockReason === 'duplicate-bench-role') {
        throw new Error(
          'Auto-draft must fill a missing bench role before duplicating a forward, defenseman, or goalie unit.',
        );
      }
    }

    assertGoalieReserveForBenchPick(draft, ownerId, asset, rostersByOwnerId, destination);

    if (destination.rosterArea === 'active') {
      roster.activeSlots[destination.slotIndex] = {
        ...roster.activeSlots[destination.slotIndex],
        asset: createRosterAsset(asset, 'active'),
        openFromCycleNumber: null,
      };
    } else {
      roster.benchSlots[destination.slotIndex] = {
        ...roster.benchSlots[destination.slotIndex],
        asset: createRosterAsset(asset, 'benched'),
      };
    }

    const pick: DraftPick = {
      overallPick: currentPick.overallPick,
      round: currentPick.round,
      pickInRound: currentPick.pickInRound,
      ownerId,
      asset,
      rosterArea: destination.rosterArea,
      rosterSlotId: destination.slotId,
      selectionType,
      selectedByUserId: actorUserId,
      autoPickReason,
    };

    const nextOverallPick = currentPick.overallPick + 1;
    const draftComplete = nextOverallPick > getDraftTotalPickCount(draft);

    const pickId = getDraftPickDocumentId(currentPick.overallPick);

    const pickRef = getDraftPickRef(leagueId, currentPick.overallPick);

    transaction.set(pickRef, {
      ...pick,
      madeAt: serverTimestamp(),
    });

    const rosterPayload = {
      schemaVersion: roster.schemaVersion,
      activeSlots: roster.activeSlots,
      benchSlots: roster.benchSlots,
      irSlots: roster.irSlots,
      updatedAt: serverTimestamp(),
    };

    if (rosterSnapshot.exists()) {
      transaction.set(rosterRef, rosterPayload, { merge: true });
    } else {
      transaction.set(rosterRef, {
        ...rosterPayload,
        createdAt: serverTimestamp(),
      });
    }

    transaction.update(draftRef, {
      status: draftComplete ? 'complete' : 'live',
      nextOverallPick,
      draftedAssetKeys: [...draft.draftedAssetKeys, asset.assetKey],
      clockStatus: draftComplete ? 'complete' : 'running',
      pickStartedAt: draftComplete ? null : serverTimestamp(),
      currentPickSeconds: draft.pickSeconds,
      pausedRemainingSeconds: null,
      clockUpdatedBy: actorUserId,
      clockUpdatedAt: serverTimestamp(),
      lastPickId: pickId,
      updatedAt: serverTimestamp(),
    });

    transaction.set(
      queueRef,
      {
        ownerId,
        assetKeys: queue.assetKeys.filter((assetKey) => assetKey !== asset.assetKey),
        autoDraftEnabled: nextAutoDraftEnabled,
        consecutiveClockExpirations: nextConsecutiveClockExpirations,
        autoDraftActivatedByTimeout: nextAutoDraftActivatedByTimeout,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    return pick;
  });
}

export async function makeDraftPick(
  leagueId: string,
  selectingUserId: string,
  asset: DraftableAsset,
): Promise<DraftPick> {
  return makeDraftPickInternal({
    leagueId,
    actorUserId: selectingUserId,
    ownerId: selectingUserId,
    asset,
    selectionType: 'manual',
  });
}

export async function makeAutomaticDraftPick(
  leagueId: string,
  commissionerId: string,
  ownerId: string,
  asset: DraftableAsset,
  selectionType: Extract<DraftSelectionType, 'queue' | 'automatic'>,
  autoPickReason: DraftAutoPickReason,
): Promise<DraftPick> {
  return makeDraftPickInternal({
    leagueId,
    actorUserId: commissionerId,
    ownerId,
    asset,
    selectionType,
    autoPickReason,
  });
}

function assertDraftComplete(draft: FantasyDraft): void {
  if (draft.status !== 'complete') {
    throw new Error('Roster moves are available after the draft is complete.');
  }
}

function isAssetOnRoster(roster: FantasyRoster, assetKey: string): boolean {
  const currentAssets = [
    ...roster.activeSlots.map((slot) => slot.asset),
    ...roster.benchSlots.map((slot) => slot.asset),
    ...roster.irSlots.map((slot) => slot.asset),
  ];
  const reservedIncomingAssets = roster.activeSlots.map(
    (slot) => slot.pendingMove?.incomingAsset ?? null,
  );

  return [...currentAssets, ...reservedIncomingAssets].some(
    (asset) => getRosterAssetKey(asset) === assetKey,
  );
}

function isAssetOnAnyRoster(
  rosterSnapshots: Array<{ exists: () => boolean; data: () => unknown }>,
  assetKey: string,
): boolean {
  return rosterSnapshots.some((snapshot) => {
    if (!snapshot.exists()) {
      return false;
    }

    const roster = normalizeFantasyRoster(snapshot.data() as Partial<FantasyRoster>);

    return isAssetOnRoster(roster, assetKey);
  });
}

export async function addDropRosterAsset({
  leagueId,
  ownerId,
  dropSlotId,
  addAsset,
  effectiveCycleNumber = null,
  effectiveLabel = null,
  leagueOwnerIds = [],
  preferImmediateCurrentCycle = false,
}: AddDropRosterAssetInput): Promise<RosterMoveExecutionResult> {
  if (preferImmediateCurrentCycle) {
    const result = await applyImmediateRosterMove({
      leagueId,
      moveType: 'add-drop-active',
      activeSlotId: dropSlotId,
      addAsset,
    });

    return {
      mode: 'immediate',
      effectiveCycleNumber: result.cycleNumber,
    };
  }

  const queueAtSlotBoundary = await hasStartedFantasyCycle(leagueId);
  const draftRef = getDraftRef(leagueId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));
  const otherRosterRefs = leagueOwnerIds
    .filter((leagueOwnerId) => leagueOwnerId !== ownerId)
    .map((leagueOwnerId) => getFantasyRosterRef(leagueId, leagueOwnerId));

  return runTransaction(db, async (transaction) => {
    const [draftSnapshot, rosterSnapshot, ...otherRosterSnapshots] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef),
      ...otherRosterRefs.map((otherRosterRef) => transaction.get(otherRosterRef)),
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    assertDraftComplete(draft);

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>)
      : createEmptyFantasyRoster();

    const benchSlotIndex = roster.benchSlots.findIndex((slot) => slot.slotId === dropSlotId);

    if (benchSlotIndex >= 0) {
      const benchSlot = roster.benchSlots[benchSlotIndex];
      const dropAsset = benchSlot.asset;

      if (!dropAsset) {
        throw new Error('The selected bench slot is already empty.');
      }

      const dropAssetKey = getRosterAssetKey(dropAsset);

      if (dropAssetKey === addAsset.assetKey || isAssetOnRoster(roster, addAsset.assetKey)) {
        throw new Error('You already have that player on your roster.');
      }

      if (isAssetOnAnyRoster(otherRosterSnapshots, addAsset.assetKey)) {
        throw new Error(
          'That player or goalie unit is already on another roster or reserved by another queued move.',
        );
      }

      roster.benchSlots[benchSlotIndex] = {
        ...benchSlot,
        asset: {
          ...createRosterAsset(addAsset, 'benched'),
          eligibleFromCycleNumber: effectiveCycleNumber,
        },
      };

      transaction.set(
        rosterRef,
        {
          schemaVersion: roster.schemaVersion,
          activeSlots: roster.activeSlots,
          benchSlots: roster.benchSlots,
          irSlots: roster.irSlots,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      transaction.set(
        getWaiverRef(leagueId, dropAssetKey),
        buildActiveWaiverPayload(dropAsset, ownerId, effectiveCycleNumber, effectiveLabel),
      );

      transaction.set(transactionRef, {
        type: 'add-drop',
        ownerId,
        addedAsset: addAsset,
        droppedAsset: dropAsset,
        waiverId: dropAssetKey,
        waiverAsset: rosterAssetToDraftableAsset(dropAsset),
        sourceRosterArea: 'bench',
        benchSlotId: benchSlot.slotId,
        dropSlotId,
        rosterSlotId: dropSlotId,
        effectiveCycleNumber,
        effectiveLabel,
        createdAt: serverTimestamp(),
      });

      return { mode: 'ownership-only', effectiveCycleNumber };
    }

    const slotIndex = roster.activeSlots.findIndex((slot) => slot.slotId === dropSlotId);

    if (slotIndex === -1) {
      throw new Error('The selected roster slot was not found.');
    }

    const selectedSlot = roster.activeSlots[slotIndex];
    const dropAsset = selectedSlot.asset;

    assertSlotHasNoPendingMove(selectedSlot);

    if (!dropAsset) {
      throw new Error('The selected roster slot is already empty.');
    }

    if (selectedSlot.position !== addAsset.position) {
      throw new Error(
        `This version only supports same-position moves. Drop ${addAsset.position} to add ${addAsset.position}.`,
      );
    }

    const dropAssetKey = getRosterAssetKey(dropAsset);

    if (dropAssetKey === addAsset.assetKey) {
      throw new Error('You already have that player on your roster.');
    }

    if (isAssetOnRoster(roster, addAsset.assetKey)) {
      throw new Error(
        'That player or goalie unit is already on your roster or reserved by a queued move.',
      );
    }

    if (isAssetOnAnyRoster(otherRosterSnapshots, addAsset.assetKey)) {
      throw new Error(
        'That player or goalie unit is already on another roster or reserved by another queued move.',
      );
    }

    if (queueAtSlotBoundary) {
      const pendingMove = createPendingRosterMove(
        'add-drop',
        ownerId,
        selectedSlot,
        addAsset,
        null,
        effectiveCycleNumber,
        effectiveLabel,
      );

      roster.activeSlots[slotIndex] = {
        ...selectedSlot,
        pendingMove,
      };

      transaction.set(
        rosterRef,
        {
          schemaVersion: roster.schemaVersion,
          activeSlots: roster.activeSlots,
          benchSlots: roster.benchSlots,
          irSlots: roster.irSlots,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      transaction.set(transactionRef, {
        type: 'queue-add-drop',
        ownerId,
        addedAsset: addAsset,
        droppedAsset: dropAsset,
        dropSlotId,
        rosterSlotId: dropSlotId,
        queuedMoveId: pendingMove.id,
        effectiveCycleNumber,
        effectiveLabel: effectiveLabel ?? 'After current slot window',
        createdAt: serverTimestamp(),
      });

      return { mode: 'queued', effectiveCycleNumber };
    }

    roster.activeSlots[slotIndex] = {
      ...selectedSlot,
      asset: createRosterAsset(addAsset, 'new'),
      pendingMove: null,
      openFromCycleNumber: null,
    };

    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        benchSlots: roster.benchSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(
      getWaiverRef(leagueId, dropAssetKey),
      buildActiveWaiverPayload(dropAsset, ownerId, effectiveCycleNumber, effectiveLabel),
    );

    transaction.set(transactionRef, {
      type: 'add-drop',
      ownerId,
      addedAsset: addAsset,
      droppedAsset: dropAsset,
      waiverId: dropAssetKey,
      waiverAsset: rosterAssetToDraftableAsset(dropAsset),
      dropSlotId,
      rosterSlotId: dropSlotId,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp(),
    });

    return { mode: 'immediate', effectiveCycleNumber };
  });
}

export async function addFreeAgentToOpenRosterSlot({
  leagueId,
  ownerId,
  targetSlotId,
  addAsset,
  effectiveCycleNumber = null,
  effectiveLabel = null,
  leagueOwnerIds = [],
  preferImmediateCurrentCycle = false,
}: AddOpenRosterAssetInput): Promise<RosterMoveExecutionResult> {
  if (preferImmediateCurrentCycle) {
    const result = await applyImmediateRosterMove({
      leagueId,
      moveType: 'add-open-active',
      activeSlotId: targetSlotId,
      addAsset,
    });

    return {
      mode: 'immediate',
      effectiveCycleNumber: result.cycleNumber,
    };
  }

  const queueAtSlotBoundary = await hasStartedFantasyCycle(leagueId);
  const draftRef = getDraftRef(leagueId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));
  const otherRosterRefs = leagueOwnerIds
    .filter((leagueOwnerId) => leagueOwnerId !== ownerId)
    .map((leagueOwnerId) => getFantasyRosterRef(leagueId, leagueOwnerId));

  return runTransaction(db, async (transaction) => {
    const [draftSnapshot, rosterSnapshot, ...otherRosterSnapshots] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef),
      ...otherRosterRefs.map((otherRosterRef) => transaction.get(otherRosterRef)),
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    assertDraftComplete(draft);

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>)
      : createEmptyFantasyRoster();

    const benchSlotIndex = roster.benchSlots.findIndex((slot) => slot.slotId === targetSlotId);

    if (benchSlotIndex >= 0) {
      const benchSlot = roster.benchSlots[benchSlotIndex];

      if (benchSlot.asset) {
        throw new Error('That bench slot is already filled.');
      }

      if (isAssetOnRoster(roster, addAsset.assetKey)) {
        throw new Error('That player or goalie unit is already on your roster.');
      }

      if (isAssetOnAnyRoster(otherRosterSnapshots, addAsset.assetKey)) {
        throw new Error(
          'That player or goalie unit is already on another roster or reserved by another queued move.',
        );
      }

      roster.benchSlots[benchSlotIndex] = {
        ...benchSlot,
        asset: {
          ...createRosterAsset(addAsset, 'benched'),
          eligibleFromCycleNumber: effectiveCycleNumber,
        },
      };

      transaction.set(
        rosterRef,
        {
          schemaVersion: roster.schemaVersion,
          activeSlots: roster.activeSlots,
          benchSlots: roster.benchSlots,
          irSlots: roster.irSlots,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      transaction.set(transactionRef, {
        type: 'add-open-slot',
        ownerId,
        addedAsset: addAsset,
        droppedAsset: null,
        sourceRosterArea: 'bench',
        benchSlotId: benchSlot.slotId,
        targetSlotId,
        rosterSlotId: targetSlotId,
        effectiveCycleNumber,
        effectiveLabel,
        createdAt: serverTimestamp(),
      });

      return { mode: 'ownership-only', effectiveCycleNumber };
    }

    const slotIndex = roster.activeSlots.findIndex((slot) => slot.slotId === targetSlotId);

    if (slotIndex === -1) {
      throw new Error('The selected roster slot was not found.');
    }

    const selectedSlot = roster.activeSlots[slotIndex];

    assertSlotHasNoPendingMove(selectedSlot);

    if (selectedSlot.asset) {
      throw new Error(
        'That roster slot is already filled. Choose a filled same-position player to drop, or choose an open slot.',
      );
    }

    if (selectedSlot.position !== addAsset.position) {
      throw new Error(`This player must be added to an open ${addAsset.position} slot.`);
    }

    if (isAssetOnRoster(roster, addAsset.assetKey)) {
      throw new Error(
        'That player or goalie unit is already on your roster or reserved by a queued move.',
      );
    }

    if (isAssetOnAnyRoster(otherRosterSnapshots, addAsset.assetKey)) {
      throw new Error(
        'That player or goalie unit is already on another roster or reserved by another queued move.',
      );
    }

    if (queueAtSlotBoundary) {
      const pendingMove = createPendingRosterMove(
        'add-open-slot',
        ownerId,
        selectedSlot,
        addAsset,
        null,
        effectiveCycleNumber,
        effectiveLabel,
      );

      roster.activeSlots[slotIndex] = {
        ...selectedSlot,
        pendingMove,
      };

      transaction.set(
        rosterRef,
        {
          schemaVersion: roster.schemaVersion,
          activeSlots: roster.activeSlots,
          benchSlots: roster.benchSlots,
          irSlots: roster.irSlots,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      transaction.set(transactionRef, {
        type: 'queue-add-open-slot',
        ownerId,
        addedAsset: addAsset,
        targetSlotId,
        rosterSlotId: targetSlotId,
        queuedMoveId: pendingMove.id,
        effectiveCycleNumber,
        effectiveLabel: effectiveLabel ?? 'At this slot boundary',
        createdAt: serverTimestamp(),
      });

      return { mode: 'queued', effectiveCycleNumber };
    }

    roster.activeSlots[slotIndex] = {
      ...selectedSlot,
      asset: createRosterAsset(addAsset, 'new'),
      pendingMove: null,
      openFromCycleNumber: null,
    };

    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        benchSlots: roster.benchSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(transactionRef, {
      type: 'add-open-slot',
      ownerId,
      addedAsset: addAsset,
      droppedAsset: null,
      targetSlotId,
      rosterSlotId: targetSlotId,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp(),
    });

    return { mode: 'immediate', effectiveCycleNumber };
  });
}

export async function cancelQueuedRosterMove({
  leagueId,
  ownerId,
  rosterSlotId,
}: {
  leagueId: string;
  ownerId: string;
  rosterSlotId: string;
}): Promise<void> {
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));

  await runTransaction(db, async (transaction) => {
    const rosterSnapshot = await transaction.get(rosterRef);

    if (!rosterSnapshot.exists()) {
      throw new Error('Your roster was not found.');
    }

    const roster = normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>);
    const slotIndex = roster.activeSlots.findIndex((slot) => slot.slotId === rosterSlotId);

    if (slotIndex === -1) {
      throw new Error('The queued roster slot was not found.');
    }

    const slot = roster.activeSlots[slotIndex];
    const pendingMove = slot.pendingMove;

    if (!pendingMove) {
      throw new Error('That roster slot no longer has a queued move.');
    }

    if (pendingMove.sourceWaiverId) {
      throw new Error(
        'An awarded waiver move cannot be canceled after the commissioner processes it.',
      );
    }

    roster.activeSlots[slotIndex] = {
      ...slot,
      pendingMove: null,
    };

    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        benchSlots: roster.benchSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(transactionRef, {
      type: 'cancel-queued-move',
      ownerId,
      addedAsset: rosterAssetToDraftableAsset(pendingMove.incomingAsset),
      droppedAsset: slot.asset,
      rosterSlotId,
      queuedMoveId: pendingMove.id,
      effectiveCycleNumber: null,
      effectiveLabel: 'Canceled before activation',
      createdAt: serverTimestamp(),
    });
  });
}

export async function moveRosterAssetToIr({
  leagueId,
  ownerId,
  activeSlotId,
  effectiveCycleNumber = null,
  effectiveLabel = null,
}: MoveRosterAssetToIrInput): Promise<RosterMoveExecutionResult> {
  const currentWindow = await getLatestRosterSlotWindow(leagueId, ownerId, activeSlotId);

  if (isUntouchedRosterWindow(currentWindow) && currentWindow) {
    const result = await applyImmediateRosterMove({
      leagueId,
      moveType: 'move-active-to-ir',
      activeSlotId,
    });

    return {
      mode: 'immediate',
      effectiveCycleNumber: result.cycleNumber,
    };
  }

  const draftRef = getDraftRef(leagueId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));

  await runTransaction(db, async (transaction) => {
    const [draftSnapshot, rosterSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef),
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    assertDraftComplete(draft);

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>)
      : createEmptyFantasyRoster();

    const activeSlotIndex = roster.activeSlots.findIndex((slot) => slot.slotId === activeSlotId);

    if (activeSlotIndex === -1) {
      throw new Error('The selected active roster slot was not found.');
    }

    const activeSlot = roster.activeSlots[activeSlotIndex];
    const asset = activeSlot.asset;

    assertSlotHasNoPendingMove(activeSlot);

    if (!asset) {
      throw new Error('That roster slot is already empty.');
    }

    if (asset.assetType !== 'skater') {
      throw new Error('Only skaters can be moved to IR.');
    }

    const availability = getPlayerAvailabilityForPlayer(asset.player);

    if (!isPlayerIrEligible(availability.status)) {
      throw new Error(
        getPlayerIrIneligibleReason(availability) ||
          `${availability.label} players are not IR eligible.`,
      );
    }

    const openIrSlotIndex = roster.irSlots.findIndex((slot) => slot.asset === null);

    if (openIrSlotIndex === -1) {
      throw new Error('All IR slots are already filled.');
    }

    const openIrSlot = roster.irSlots[openIrSlotIndex];
    const irAsset = {
      ...asset,
      rosterStatus: 'injured' as RosterStatus,
    };

    roster.activeSlots[activeSlotIndex] = {
      ...activeSlot,
      asset: null,
      openFromCycleNumber: null,
    };

    roster.irSlots[openIrSlotIndex] = {
      ...openIrSlot,
      asset: irAsset,
    };

    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        benchSlots: roster.benchSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(transactionRef, {
      type: 'move-to-ir',
      ownerId,
      movedAsset: asset,
      activeSlotId,
      irSlotId: openIrSlot.slotId,
      availabilityStatus: availability.status,
      availabilityLabel: availability.label,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp(),
    });
  });

  return {
    mode: 'ownership-only',
    effectiveCycleNumber,
  };
}

export async function activateIrRosterAsset({
  leagueId,
  ownerId,
  irSlotId,
  activeSlotId = null,
  effectiveCycleNumber = null,
  effectiveLabel = null,
}: ActivateIrRosterAssetInput): Promise<RosterMoveExecutionResult> {
  const draftRef = getDraftRef(leagueId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));
  const preflightRosterSnapshot = await getDoc(rosterRef);

  if (!preflightRosterSnapshot.exists()) {
    throw new Error('Your roster was not found.');
  }

  const preflightRoster = normalizeFantasyRoster(
    preflightRosterSnapshot.data() as Partial<FantasyRoster>,
  );
  const preflightIrSlot = preflightRoster.irSlots.find((slot) => slot.slotId === irSlotId);
  const preflightIrAsset = preflightIrSlot?.asset ?? null;

  if (!preflightIrAsset) {
    throw new Error('That IR slot is already empty.');
  }

  const resolvedActiveSlotId = activeSlotId ?? preflightRoster.activeSlots.find(
    (slot) => slot.position === preflightIrAsset.position && slot.asset === null,
  )?.slotId ?? null;

  if (!resolvedActiveSlotId) {
    throw new Error(
      `Choose a ${preflightIrAsset.position} roster slot before activating this player from IR.`,
    );
  }

  const preflightActiveSlot = preflightRoster.activeSlots.find(
    (slot) => slot.slotId === resolvedActiveSlotId,
  );
  const currentWindow = await getLatestRosterSlotWindow(
    leagueId,
    ownerId,
    resolvedActiveSlotId,
  );
  const immediateCycleNumber =
    currentWindow?.cycleNumber ?? preflightActiveSlot?.openFromCycleNumber ?? null;
  const activeAssignmentUntouched =
    isUntouchedRosterWindow(currentWindow) ||
    (!currentWindow &&
      !preflightActiveSlot?.asset &&
      typeof preflightActiveSlot?.openFromCycleNumber === 'number');
  const requiredGamesPerCycle = await getLeagueRequiredGamesPerCycle(leagueId);
  const incomingEligibility = await resolveRosterMoveAssetCycleEligibility(
    rosterAssetToDraftableAsset(preflightIrAsset),
    requiredGamesPerCycle,
  );
  const incomingEarliestCycleNumber = Math.max(
    preflightIrAsset.eligibleFromCycleNumber ?? 1,
    incomingEligibility.earliestEligibleCycleNumber,
  );

  if (
    activeAssignmentUntouched &&
    immediateCycleNumber !== null &&
    incomingEarliestCycleNumber <= immediateCycleNumber
  ) {
    const result = await applyImmediateRosterMove({
      leagueId,
      moveType: 'activate-ir-active',
      activeSlotId: resolvedActiveSlotId,
      irSlotId,
    });

    return {
      mode: 'immediate',
      effectiveCycleNumber: result.cycleNumber,
    };
  }

  const fairEffectiveCycleNumber = Math.max(
    effectiveCycleNumber ?? ((immediateCycleNumber ?? 0) + 1),
    incomingEarliestCycleNumber,
  );
  const fairEffectiveLabel = effectiveLabel ?? `Cycle ${fairEffectiveCycleNumber}`;

  await runTransaction(db, async (transaction) => {
    const [draftSnapshot, rosterSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef),
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    assertDraftComplete(draft);

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>)
      : createEmptyFantasyRoster();

    const irSlotIndex = roster.irSlots.findIndex((slot) => slot.slotId === irSlotId);

    if (irSlotIndex === -1) {
      throw new Error('The selected IR slot was not found.');
    }

    const irSlot = roster.irSlots[irSlotIndex];
    const asset = irSlot.asset;

    if (!asset) {
      throw new Error('That IR slot is already empty.');
    }

    const activeSlotIndex = roster.activeSlots.findIndex(
      (slot) => slot.slotId === resolvedActiveSlotId,
    );

    if (activeSlotIndex === -1) {
      throw new Error(
        `Choose a ${asset.position} roster slot before activating this player from IR.`,
      );
    }

    const activeSlot = roster.activeSlots[activeSlotIndex];

    assertSlotHasNoPendingMove(activeSlot);

    if (activeSlot.position !== asset.position) {
      throw new Error(`This player must be activated into a ${asset.position} roster slot.`);
    }

    const droppedAsset = activeSlot.asset;

    const activatedAsset = {
      ...asset,
      rosterStatus: 'moved' as RosterStatus,
      eligibleFromCycleNumber: fairEffectiveCycleNumber,
    };

    roster.activeSlots[activeSlotIndex] = {
      ...activeSlot,
      asset: activatedAsset,
      openFromCycleNumber: null,
    };

    roster.irSlots[irSlotIndex] = {
      ...irSlot,
      asset: null,
    };

    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        benchSlots: roster.benchSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    let waiverId: string | null = null;
    let waiverAsset: DraftableAsset | null = null;

    if (droppedAsset) {
      waiverId = getRosterAssetKey(droppedAsset);

      if (!waiverId) {
        throw new Error('The replaced player could not be identified for waivers.');
      }

      waiverAsset = rosterAssetToDraftableAsset(droppedAsset);

      transaction.set(
        getWaiverRef(leagueId, waiverId),
        buildActiveWaiverPayload(
          droppedAsset,
          ownerId,
          fairEffectiveCycleNumber,
          fairEffectiveLabel,
        ),
      );
    }

    transaction.set(transactionRef, {
      type: 'activate-from-ir',
      ownerId,
      activatedAsset: asset,
      droppedAsset,
      waiverId,
      waiverAsset,
      activeSlotId: activeSlot.slotId,
      irSlotId,
      effectiveCycleNumber: fairEffectiveCycleNumber,
      effectiveLabel: fairEffectiveLabel,
      createdAt: serverTimestamp(),
    });
  });

  return {
    mode: 'ownership-only',
    effectiveCycleNumber: fairEffectiveCycleNumber,
  };
}


export async function dropRosterAssetToWaivers({
  leagueId,
  ownerId,
  sourceRosterArea,
  slotId,
  effectiveCycleNumber = null,
  effectiveLabel = null,
}: DropRosterAssetToWaiversInput): Promise<RosterMoveExecutionResult> {
  if (sourceRosterArea === 'active') {
    const currentWindow = await getLatestRosterSlotWindow(leagueId, ownerId, slotId);

    if (isUntouchedRosterWindow(currentWindow) && currentWindow) {
      const result = await applyImmediateRosterMove({
        leagueId,
        moveType: 'drop-active',
        activeSlotId: slotId,
      });

      return {
        mode: 'immediate',
        effectiveCycleNumber: result.cycleNumber,
      };
    }
  }

  const draftRef = getDraftRef(leagueId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));

  await runTransaction(db, async (transaction) => {
    const [draftSnapshot, rosterSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef),
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    assertDraftComplete(draft);

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>)
      : createEmptyFantasyRoster();

    let droppedAsset: RosterAsset | null = null;
    let activeSlotId: string | null = null;
    let irSlotId: string | null = null;

    if (sourceRosterArea === 'active') {
      const activeSlotIndex = roster.activeSlots.findIndex((slot) => slot.slotId === slotId);

      if (activeSlotIndex === -1) {
        throw new Error('The selected active roster slot was not found.');
      }

      const activeSlot = roster.activeSlots[activeSlotIndex];

      assertSlotHasNoPendingMove(activeSlot);

      if (!activeSlot.asset) {
        throw new Error('That active roster slot is already empty.');
      }

      droppedAsset = activeSlot.asset;
      activeSlotId = activeSlot.slotId;

      roster.activeSlots[activeSlotIndex] = {
        ...activeSlot,
        asset: null,
        openFromCycleNumber: null,
      };
    } else if (sourceRosterArea === 'bench') {
      const benchSlotIndex = roster.benchSlots.findIndex((slot) => slot.slotId === slotId);

      if (benchSlotIndex === -1) {
        throw new Error('The selected bench slot was not found.');
      }

      const benchSlot = roster.benchSlots[benchSlotIndex];

      if (!benchSlot.asset) {
        throw new Error('That bench slot is already empty.');
      }

      const benchAssetKey = getRosterAssetKey(benchSlot.asset);
      const reservedBySwap = roster.activeSlots.some(
        (slot) => slot.pendingMove?.sourceBenchSlotId === benchSlot.slotId &&
          getRosterAssetKey(slot.pendingMove.incomingAsset) === benchAssetKey,
      );

      if (reservedBySwap) {
        throw new Error('That bench player is reserved for a queued active-lineup swap.');
      }

      droppedAsset = benchSlot.asset;
      roster.benchSlots[benchSlotIndex] = { ...benchSlot, asset: null };
    } else if (sourceRosterArea === 'ir') {
      const irSlotIndex = roster.irSlots.findIndex((slot) => slot.slotId === slotId);

      if (irSlotIndex === -1) {
        throw new Error('The selected IR slot was not found.');
      }

      const irSlot = roster.irSlots[irSlotIndex];

      if (!irSlot.asset) {
        throw new Error('That IR slot is already empty.');
      }

      droppedAsset = irSlot.asset;
      irSlotId = irSlot.slotId;

      roster.irSlots[irSlotIndex] = {
        ...irSlot,
        asset: null,
      };
    } else {
      throw new Error('Choose whether to drop from the active roster, bench, or IR.');
    }

    const waiverId = getRosterAssetKey(droppedAsset);

    if (!waiverId) {
      throw new Error('The selected player or goalie unit could not be identified for waivers.');
    }

    const waiverAsset = rosterAssetToDraftableAsset(droppedAsset);

    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        benchSlots: roster.benchSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(
      getWaiverRef(leagueId, waiverId),
      buildActiveWaiverPayload(droppedAsset, ownerId, effectiveCycleNumber, effectiveLabel),
    );

    transaction.set(transactionRef, {
      type: 'drop-to-waivers',
      ownerId,
      droppedAsset,
      waiverId,
      waiverAsset,
      sourceRosterArea,
      dropSlotId: slotId,
      activeSlotId,
      irSlotId,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp(),
    });
  });

  return {
    mode: sourceRosterArea === 'active' ? 'ownership-only' : 'immediate',
    effectiveCycleNumber,
  };
}

export async function queueActiveBenchSwap({
  leagueId,
  ownerId,
  activeSlotId,
  benchSlotId,
  effectiveCycleNumber = null,
  effectiveLabel = null,
}: QueueActiveBenchSwapInput): Promise<RosterMoveExecutionResult> {
  const draftRef = getDraftRef(leagueId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));
  const preflightRosterSnapshot = await getDoc(rosterRef);

  if (!preflightRosterSnapshot.exists()) {
    throw new Error('Your roster was not found.');
  }

  const preflightRoster = normalizeFantasyRoster(
    preflightRosterSnapshot.data() as Partial<FantasyRoster>,
  );
  const preflightBenchSlot = preflightRoster.benchSlots.find(
    (slot) => slot.slotId === benchSlotId,
  );

  if (!preflightBenchSlot?.asset) {
    throw new Error('The selected bench slot is empty.');
  }

  const requiredGamesPerCycle = await getLeagueRequiredGamesPerCycle(leagueId);
  const benchEligibility = await resolveRosterMoveAssetCycleEligibility(
    rosterAssetToDraftableAsset(preflightBenchSlot.asset),
    requiredGamesPerCycle,
  );
  const preflightActiveSlot = preflightRoster.activeSlots.find(
    (slot) => slot.slotId === activeSlotId,
  );

  if (!preflightActiveSlot) {
    throw new Error('The selected active roster slot was not found.');
  }

  const currentWindow = await getLatestRosterSlotWindow(leagueId, ownerId, activeSlotId);
  const immediateCycleNumber =
    currentWindow?.cycleNumber ?? preflightActiveSlot.openFromCycleNumber ?? null;
  const activeAssignmentUntouched =
    isUntouchedRosterWindow(currentWindow) ||
    (!currentWindow &&
      !preflightActiveSlot.asset &&
      typeof preflightActiveSlot.openFromCycleNumber === 'number');
  const incomingEarliestCycleNumber = Math.max(
    preflightBenchSlot.asset.eligibleFromCycleNumber ?? 1,
    benchEligibility.earliestEligibleCycleNumber,
  );

  if (
    activeAssignmentUntouched &&
    immediateCycleNumber !== null &&
    incomingEarliestCycleNumber <= immediateCycleNumber
  ) {
    const result = await applyImmediateRosterMove({
      leagueId,
      moveType: 'active-bench-swap',
      activeSlotId,
      benchSlotId,
    });

    return {
      mode: 'immediate',
      effectiveCycleNumber: result.cycleNumber,
    };
  }

  const fairEffectiveCycleNumber = Math.max(
    effectiveCycleNumber ?? ((immediateCycleNumber ?? 0) + 1),
    incomingEarliestCycleNumber,
  );

  return runTransaction(db, async (transaction) => {
    const [draftSnapshot, rosterSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef),
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    assertDraftComplete(normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>));

    const roster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>)
      : createEmptyFantasyRoster();
    const activeSlotIndex = roster.activeSlots.findIndex((slot) => slot.slotId === activeSlotId);
    const benchSlotIndex = roster.benchSlots.findIndex((slot) => slot.slotId === benchSlotId);

    if (activeSlotIndex < 0 || benchSlotIndex < 0) {
      throw new Error('The selected active or bench slot was not found.');
    }

    const activeSlot = roster.activeSlots[activeSlotIndex];
    const benchSlot = roster.benchSlots[benchSlotIndex];
    const benchAsset = benchSlot.asset;

    assertSlotHasNoPendingMove(activeSlot);

    if (!benchAsset) {
      throw new Error('The selected bench slot is empty.');
    }

    if (activeSlot.position !== benchAsset.position) {
      throw new Error(`That bench asset can only move into a ${benchAsset.position} active slot.`);
    }

    const requestedCycle = Math.max(
      fairEffectiveCycleNumber,
      benchAsset.eligibleFromCycleNumber ?? 1,
    );
    const pendingMove = createPendingRosterMove(
      'add-drop',
      ownerId,
      activeSlot,
      rosterAssetToDraftableAsset(benchAsset),
      null,
      requestedCycle,
      effectiveLabel,
      benchSlot.slotId,
      'bench',
    );

    roster.activeSlots[activeSlotIndex] = { ...activeSlot, pendingMove };

    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        benchSlots: roster.benchSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(transactionRef, {
      type: 'queue-active-bench-swap',
      ownerId,
      movedAsset: benchAsset,
      droppedAsset: activeSlot.asset,
      activeSlotId,
      benchSlotId,
      rosterSlotId: activeSlotId,
      queuedMoveId: pendingMove.id,
      effectiveCycleNumber: requestedCycle,
      effectiveLabel: effectiveLabel ?? `Cycle ${requestedCycle}`,
      createdAt: serverTimestamp(),
    });

    return {
      mode: 'queued',
      effectiveCycleNumber: requestedCycle,
    };
  });
}

export async function moveBenchRosterAssetToIr({
  leagueId,
  ownerId,
  benchSlotId,
  effectiveCycleNumber = null,
  effectiveLabel = null,
}: MoveBenchRosterAssetToIrInput): Promise<void> {
  const draftRef = getDraftRef(leagueId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));

  await runTransaction(db, async (transaction) => {
    const [draftSnapshot, rosterSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef),
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    assertDraftComplete(normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>));
    const roster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>)
      : createEmptyFantasyRoster();
    const benchSlotIndex = roster.benchSlots.findIndex((slot) => slot.slotId === benchSlotId);
    const openIrSlotIndex = roster.irSlots.findIndex((slot) => slot.asset === null);

    if (benchSlotIndex < 0) {
      throw new Error('The selected bench slot was not found.');
    }
    if (openIrSlotIndex < 0) {
      throw new Error('All IR slots are already filled.');
    }

    const benchSlot = roster.benchSlots[benchSlotIndex];
    const asset = benchSlot.asset;

    if (!asset || asset.assetType !== 'skater') {
      throw new Error('Only a skater on the bench can be moved to IR.');
    }

    const availability = getPlayerAvailabilityForPlayer(asset.player);
    if (!isPlayerIrEligible(availability.status)) {
      throw new Error(
        getPlayerIrIneligibleReason(availability) || `${availability.label} players are not IR eligible.`,
      );
    }

    const assetKey = getRosterAssetKey(asset);
    const reservedBySwap = roster.activeSlots.some(
      (slot) => slot.pendingMove?.sourceBenchSlotId === benchSlotId &&
        getRosterAssetKey(slot.pendingMove.incomingAsset) === assetKey,
    );
    if (reservedBySwap) {
      throw new Error('Cancel the queued active-lineup swap before moving this player to IR.');
    }

    roster.benchSlots[benchSlotIndex] = { ...benchSlot, asset: null };
    roster.irSlots[openIrSlotIndex] = {
      ...roster.irSlots[openIrSlotIndex],
      asset: { ...asset, rosterStatus: 'injured' },
    };

    transaction.set(rosterRef, {
      schemaVersion: roster.schemaVersion,
      activeSlots: roster.activeSlots,
      benchSlots: roster.benchSlots,
      irSlots: roster.irSlots,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    transaction.set(transactionRef, {
      type: 'move-bench-to-ir',
      ownerId,
      movedAsset: asset,
      benchSlotId,
      irSlotId: roster.irSlots[openIrSlotIndex].slotId,
      availabilityStatus: availability.status,
      availabilityLabel: availability.label,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp(),
    });
  });
}

export async function activateIrRosterAssetToBench({
  leagueId,
  ownerId,
  irSlotId,
  benchSlotId = null,
  effectiveCycleNumber = null,
  effectiveLabel = null,
}: ActivateIrRosterAssetToBenchInput): Promise<void> {
  const draftRef = getDraftRef(leagueId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));

  await runTransaction(db, async (transaction) => {
    const [draftSnapshot, rosterSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef),
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    assertDraftComplete(normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>));
    const roster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>)
      : createEmptyFantasyRoster();
    const irSlotIndex = roster.irSlots.findIndex((slot) => slot.slotId === irSlotId);
    const benchSlotIndex = benchSlotId
      ? roster.benchSlots.findIndex((slot) => slot.slotId === benchSlotId)
      : roster.benchSlots.findIndex((slot) => slot.asset === null);

    if (irSlotIndex < 0 || !roster.irSlots[irSlotIndex].asset) {
      throw new Error('The selected IR player was not found.');
    }
    if (benchSlotIndex < 0) {
      throw new Error('Choose a bench player to replace or open a bench slot first.');
    }

    const irAsset = roster.irSlots[irSlotIndex].asset!;
    const benchSlot = roster.benchSlots[benchSlotIndex];
    const droppedAsset = benchSlot.asset;

    if (droppedAsset) {
      const droppedAssetKey = getRosterAssetKey(droppedAsset);
      const reservedBySwap = roster.activeSlots.some(
        (slot) => slot.pendingMove?.sourceBenchSlotId === benchSlot.slotId &&
          getRosterAssetKey(slot.pendingMove.incomingAsset) === droppedAssetKey,
      );

      if (reservedBySwap) {
        throw new Error(
          'That bench player is reserved for a queued active-lineup swap. Cancel the swap or choose another bench slot.',
        );
      }
    }

    roster.irSlots[irSlotIndex] = { ...roster.irSlots[irSlotIndex], asset: null };
    roster.benchSlots[benchSlotIndex] = {
      ...benchSlot,
      asset: { ...irAsset, rosterStatus: 'benched' },
    };

    transaction.set(rosterRef, {
      schemaVersion: roster.schemaVersion,
      activeSlots: roster.activeSlots,
      benchSlots: roster.benchSlots,
      irSlots: roster.irSlots,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    let waiverId: string | null = null;
    if (droppedAsset) {
      waiverId = getRosterAssetKey(droppedAsset);
      transaction.set(
        getWaiverRef(leagueId, waiverId),
        buildActiveWaiverPayload(droppedAsset, ownerId, effectiveCycleNumber, effectiveLabel),
      );
    }

    transaction.set(transactionRef, {
      type: 'activate-ir-to-bench',
      ownerId,
      activatedAsset: irAsset,
      droppedAsset,
      waiverId,
      irSlotId,
      benchSlotId: benchSlot.slotId,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp(),
    });
  });
}

export async function placeWaiverClaim({
  leagueId,
  ownerId,
  waiverId,
  moveType,
  dropSlotId = null,
  targetSlotId = null,
  effectiveCycleNumber = null,
  effectiveLabel = null,
}: PlaceWaiverClaimInput): Promise<void> {
  const draftRef = getDraftRef(leagueId);
  const waiverRef = getWaiverRef(leagueId, waiverId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const teamRef = getTeamRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));

  await runTransaction(db, async (transaction) => {
    const [draftSnapshot, waiverSnapshot, rosterSnapshot, teamSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(waiverRef),
      transaction.get(rosterRef),
      transaction.get(teamRef),
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    assertDraftComplete(draft);

    if (!waiverSnapshot.exists()) {
      throw new Error('That waiver player was not found.');
    }

    const waiver = {
      id: waiverSnapshot.id,
      ...(waiverSnapshot.data() as Omit<FantasyWaiver, 'id'>),
    } as FantasyWaiver;

    if (waiver.status !== 'active') {
      throw new Error('That player is no longer on waivers.');
    }

    if (waiver.droppedByOwnerId === ownerId) {
      throw new Error('You cannot claim a player you just dropped while he is still on waivers.');
    }

    const claimAsset = waiver.asset;

    if (!claimAsset || claimAsset.assetKey !== waiver.assetKey) {
      throw new Error('The waiver asset is missing or invalid.');
    }

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>)
      : createEmptyFantasyRoster();

    if (isAssetOnRoster(roster, claimAsset.assetKey)) {
      throw new Error('That player or goalie unit is already on your roster.');
    }

    const selectedSlotId = moveType === 'open-slot' ? targetSlotId : dropSlotId;

    if (!selectedSlotId) {
      throw new Error('Choose the roster spot for this waiver claim.');
    }

    const activeSlot = roster.activeSlots.find((slot) => slot.slotId === selectedSlotId);
    const benchSlot = roster.benchSlots.find((slot) => slot.slotId === selectedSlotId);

    if (!activeSlot && !benchSlot) {
      throw new Error('The selected roster slot was not found.');
    }

    if (activeSlot) {
      assertSlotHasNoPendingMove(activeSlot);

      if (activeSlot.position !== claimAsset.position) {
        throw new Error(`This waiver claim needs a ${claimAsset.position} active roster spot.`);
      }

      if (moveType === 'open-slot' && activeSlot.asset) {
        throw new Error('The selected open slot is no longer open.');
      }

      if (moveType === 'drop' && !activeSlot.asset) {
        throw new Error('The selected drop slot is already open.');
      }
    } else if (benchSlot) {
      if (moveType === 'open-slot' && benchSlot.asset) {
        throw new Error('The selected bench slot is no longer open.');
      }

      if (moveType === 'drop' && !benchSlot.asset) {
        throw new Error('The selected bench drop slot is already open.');
      }
    }

    const team = teamSnapshot.exists() ? (teamSnapshot.data() as FantasyTeam) : undefined;

    const newClaim: FantasyWaiverClaim = {
      ownerId,
      moveType,
      rosterArea: benchSlot ? 'bench' : 'active',
      dropSlotId: moveType === 'drop' ? selectedSlotId : null,
      targetSlotId: moveType === 'open-slot' ? selectedSlotId : null,
      waiverPriorityAtClaim: getTeamWaiverPriority(team, 999),
      effectiveCycleNumber,
      effectiveLabel,
      claimedAt: new Date().toISOString(),
    };

    const existingClaims = Array.isArray(waiver.claims) ? waiver.claims : [];

    const nextClaims = [...existingClaims.filter((claim) => claim.ownerId !== ownerId), newClaim];

    transaction.set(
      waiverRef,
      {
        ...waiver,
        claims: nextClaims,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(transactionRef, {
      type: 'waiver-claim',
      ownerId,
      waiverId,
      waiverAsset: claimAsset,
      targetSlotId: newClaim.targetSlotId,
      dropSlotId: newClaim.dropSlotId,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp(),
    });
  });
}

export async function processWaiver({
  leagueId,
  commissionerId,
  waiverId,
  leagueTeams,
  effectiveCycleNumber = null,
  effectiveLabel = null,
}: ProcessWaiverInput): Promise<void> {
  const queueAtSlotBoundary = await hasStartedFantasyCycle(leagueId);
  const leagueRef = getLeagueRef(leagueId);
  const draftRef = getDraftRef(leagueId);
  const waiverRef = getWaiverRef(leagueId, waiverId);
  const transactionRef = doc(getTransactionsRef(leagueId));
  const orderedTeams = [...leagueTeams].sort(
    (first, second) => getTeamWaiverPriority(first, 999) - getTeamWaiverPriority(second, 999),
  );

  await runTransaction(db, async (transaction) => {
    const [leagueSnapshot, draftSnapshot, waiverSnapshot] = await Promise.all([
      transaction.get(leagueRef),
      transaction.get(draftRef),
      transaction.get(waiverRef),
    ]);

    if (!leagueSnapshot.exists()) {
      throw new Error('League not found.');
    }

    const leagueData = leagueSnapshot.data() as {
      commissionerId?: string;
    };

    if (leagueData.commissionerId !== commissionerId) {
      throw new Error('Only the commissioner can process waivers.');
    }

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(draftSnapshot.data() as Partial<FantasyDraft>);

    assertDraftComplete(draft);

    if (!waiverSnapshot.exists()) {
      throw new Error('That waiver player was not found.');
    }

    const waiver = {
      id: waiverSnapshot.id,
      ...(waiverSnapshot.data() as Omit<FantasyWaiver, 'id'>),
    } as FantasyWaiver;

    if (waiver.status !== 'active') {
      throw new Error('That waiver has already been processed.');
    }

    const activeClaims = Array.isArray(waiver.claims) ? waiver.claims : [];

    if (activeClaims.length === 0) {
      transaction.set(
        waiverRef,
        {
          status: 'cleared',
          processedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      transaction.set(transactionRef, {
        type: 'waiver-cleared',
        ownerId: commissionerId,
        waiverId,
        waiverAsset: waiver.asset,
        effectiveCycleNumber,
        effectiveLabel,
        createdAt: serverTimestamp(),
      });

      return;
    }

    const teamByOwnerId = new Map(
      orderedTeams.map((team, index) => [
        team.ownerId,
        {
          team,
          fallbackPriority: index + 1,
        },
      ]),
    );
    const orderedClaims = [...activeClaims].sort((first, second) => {
      const firstTeam = teamByOwnerId.get(first.ownerId);
      const secondTeam = teamByOwnerId.get(second.ownerId);

      return (
        getTeamWaiverPriority(firstTeam?.team, firstTeam?.fallbackPriority ?? 999) -
        getTeamWaiverPriority(secondTeam?.team, secondTeam?.fallbackPriority ?? 999)
      );
    });
    const claimantOwnerIds = [...new Set(orderedClaims.map((claim) => claim.ownerId))];
    const claimantRosterRefs = claimantOwnerIds.map((ownerId) =>
      getFantasyRosterRef(leagueId, ownerId),
    );
    const claimantRosterSnapshots = await Promise.all(
      claimantRosterRefs.map((rosterRef) => transaction.get(rosterRef)),
    );
    const claimantRostersByOwnerId = new Map(
      claimantOwnerIds.map((ownerId, index) => {
        const snapshot = claimantRosterSnapshots[index];

        return [
          ownerId,
          snapshot?.exists()
            ? normalizeFantasyRoster(snapshot.data() as Partial<FantasyRoster>)
            : null,
        ] as const;
      }),
    );

    let winningClaim: FantasyWaiverClaim | null = null;
    let winnerRoster: FantasyRoster | null = null;
    let activeSlotIndex = -1;
    let benchSlotIndex = -1;
    let winningRosterArea: 'active' | 'bench' = 'active';
    let slotId = '';

    for (const claim of orderedClaims) {
      const claimRoster = claimantRostersByOwnerId.get(claim.ownerId);
      const claimSlotId = claim.moveType === 'open-slot' ? claim.targetSlotId : claim.dropSlotId;

      if (!claimRoster || !claimSlotId) {
        continue;
      }

      const claimActiveSlotIndex = claimRoster.activeSlots.findIndex(
        (slot) => slot.slotId === claimSlotId,
      );
      const claimBenchSlotIndex = claimRoster.benchSlots.findIndex(
        (slot) => slot.slotId === claimSlotId,
      );
      const claimActiveSlot = claimActiveSlotIndex >= 0
        ? claimRoster.activeSlots[claimActiveSlotIndex]
        : null;
      const claimBenchSlot = claimBenchSlotIndex >= 0
        ? claimRoster.benchSlots[claimBenchSlotIndex]
        : null;
      const slotIsEligible = !isAssetOnRoster(claimRoster, waiver.asset.assetKey) && (
        claimActiveSlot
          ? !claimActiveSlot.pendingMove &&
            claimActiveSlot.position === waiver.asset.position &&
            ((claim.moveType === 'open-slot' && !claimActiveSlot.asset) ||
              (claim.moveType === 'drop' && Boolean(claimActiveSlot.asset)))
          : claimBenchSlot
            ? ((claim.moveType === 'open-slot' && !claimBenchSlot.asset) ||
              (claim.moveType === 'drop' && Boolean(claimBenchSlot.asset)))
            : false
      );

      if (!slotIsEligible) {
        continue;
      }

      winningClaim = claim;
      winnerRoster = claimRoster;
      activeSlotIndex = claimActiveSlotIndex;
      benchSlotIndex = claimBenchSlotIndex;
      winningRosterArea = claimBenchSlot ? 'bench' : 'active';
      slotId = claimSlotId;
      break;
    }

    if (
      !winningClaim ||
      !winnerRoster ||
      (winningRosterArea === 'active' ? activeSlotIndex === -1 : benchSlotIndex === -1)
    ) {
      transaction.set(
        waiverRef,
        {
          status: 'cleared',
          processedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      transaction.set(transactionRef, {
        type: 'waiver-cleared',
        ownerId: commissionerId,
        waiverId,
        waiverAsset: waiver.asset,
        effectiveCycleNumber,
        effectiveLabel: 'All submitted claims were no longer roster-eligible',
        createdAt: serverTimestamp(),
      });

      return;
    }

    const winnerRosterRef = getFantasyRosterRef(leagueId, winningClaim.ownerId);
    const selectedActiveSlot = winningRosterArea === 'active'
      ? winnerRoster.activeSlots[activeSlotIndex]
      : null;
    const selectedBenchSlot = winningRosterArea === 'bench'
      ? winnerRoster.benchSlots[benchSlotIndex]
      : null;
    const droppedByWinningTeam = selectedActiveSlot?.asset ?? selectedBenchSlot?.asset ?? null;
    const winningEffectiveCycleCandidates = [
      winningClaim.effectiveCycleNumber,
      effectiveCycleNumber,
    ].filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
    );
    const winningEffectiveCycleNumber =
      winningEffectiveCycleCandidates.length > 0
        ? Math.max(...winningEffectiveCycleCandidates)
        : null;
    const winningEffectiveLabel = winningEffectiveCycleNumber
      ? `Cycle ${winningEffectiveCycleNumber}`
      : (winningClaim.effectiveLabel ?? effectiveLabel ?? 'After current slot window');
    let queuedMove: PendingRosterSlotMove | null = null;

    if (winningRosterArea === 'bench' && selectedBenchSlot) {
      winnerRoster.benchSlots[benchSlotIndex] = {
        ...selectedBenchSlot,
        asset: {
          ...createRosterAsset(waiver.asset, 'benched'),
          eligibleFromCycleNumber: winningEffectiveCycleNumber,
        },
      };
    } else if (queueAtSlotBoundary && selectedActiveSlot) {
      queuedMove = createPendingRosterMove(
        'waiver-award',
        winningClaim.ownerId,
        selectedActiveSlot,
        waiver.asset,
        waiver.id,
        winningEffectiveCycleNumber,
        winningEffectiveLabel,
      );

      winnerRoster.activeSlots[activeSlotIndex] = {
        ...selectedActiveSlot,
        pendingMove: queuedMove,
      };
    } else if (selectedActiveSlot) {
      winnerRoster.activeSlots[activeSlotIndex] = {
        ...selectedActiveSlot,
        asset: createRosterAsset(waiver.asset, 'new'),
        pendingMove: null,
        openFromCycleNumber: null,
      };
    }

    transaction.set(
      winnerRosterRef,
      {
        schemaVersion: winnerRoster.schemaVersion,
        activeSlots: winnerRoster.activeSlots,
        benchSlots: winnerRoster.benchSlots,
        irSlots: winnerRoster.irSlots,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    if ((winningRosterArea === 'bench' || !queueAtSlotBoundary) && droppedByWinningTeam) {
      const droppedAssetKey = getRosterAssetKey(droppedByWinningTeam);

      transaction.set(
        getWaiverRef(leagueId, droppedAssetKey),
        buildActiveWaiverPayload(
          droppedByWinningTeam,
          winningClaim.ownerId,
          effectiveCycleNumber,
          effectiveLabel,
        ),
      );
    }

    const winnerTeamRecord = teamByOwnerId.get(winningClaim.ownerId);
    const winnerPriority = getTeamWaiverPriority(
      winnerTeamRecord?.team,
      winnerTeamRecord?.fallbackPriority ?? orderedTeams.length,
    );
    const maxPriority = Math.max(1, orderedTeams.length);

    for (const [index, team] of orderedTeams.entries()) {
      const currentPriority = getTeamWaiverPriority(team, index + 1);
      let nextPriority = currentPriority;

      if (team.ownerId === winningClaim.ownerId) {
        nextPriority = maxPriority;
      } else if (currentPriority > winnerPriority) {
        nextPriority = Math.max(1, currentPriority - 1);
      }

      transaction.set(
        getTeamRef(leagueId, team.ownerId),
        {
          waiverPriority: nextPriority,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }

    transaction.set(
      waiverRef,
      {
        status: 'claimed',
        awardedToOwnerId: winningClaim.ownerId,
        queuedMoveId: queuedMove?.id ?? null,
        rosterSlotId: slotId,
        effectiveCycleNumber: winningEffectiveCycleNumber,
        effectiveLabel: winningEffectiveLabel,
        processedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(transactionRef, {
      type:
        winningRosterArea === 'active' && queueAtSlotBoundary
          ? 'queue-waiver-award'
          : 'waiver-award',
      ownerId: winningClaim.ownerId,
      winningOwnerId: winningClaim.ownerId,
      waiverId,
      waiverAsset: waiver.asset,
      addedAsset: waiver.asset,
      droppedAsset: droppedByWinningTeam,
      targetSlotId: winningClaim.targetSlotId ?? null,
      dropSlotId: winningClaim.dropSlotId ?? null,
      rosterSlotId: slotId,
      queuedMoveId: queuedMove?.id ?? null,
      effectiveCycleNumber: winningEffectiveCycleNumber,
      effectiveLabel: winningEffectiveLabel,
      createdAt: serverTimestamp(),
    });
  });
}

// Backward-compatible wrapper name. It now preserves draft history and only
// updates the current roster plus transaction log. New code should call
// addDropRosterAsset with a dropSlotId.
export async function addDropDraftAsset(input: AddDropRosterAssetInput): Promise<void> {
  await addDropRosterAsset(input);
}
