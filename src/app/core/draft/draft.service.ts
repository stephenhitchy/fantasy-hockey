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

import { executeSecureRosterAction } from '../transactions/roster-authority.service';

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
}): string {
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

  return data.activeSnapshotId.trim();
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
    serverDraftProjectionSnapshotId:
      typeof data.serverDraftProjectionSnapshotId === 'string'
        ? data.serverDraftProjectionSnapshotId
        : null,
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
    serverDraftProjectionSnapshotId: null,
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
      serverDraftProjectionSnapshotId:
        draft.status === 'live'
          ? (draft.serverDraftProjectionSnapshotId ?? null)
          : null,
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
  const activeSnapshotId = assertReadySharedProjectionSnapshot(projectionSnapshot);

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

      const startedAt = serverTimestamp();

      transaction.update(draftRef, {
        status: 'live',
        clockStatus: 'running',
        pickStartedAt: startedAt,
        currentPickSeconds: draft.pickSeconds,
        pausedRemainingSeconds: null,
        clockUpdatedBy: activatedByUserId ?? null,
        clockUpdatedAt: startedAt,
        serverDraftProjectionSnapshotId: activeSnapshotId,
        startedAt,
        updatedAt: startedAt,
      });

      return {
        ...draft,
        status: 'live',
        clockStatus: 'running',
        pickStartedAt: startedAt,
        currentPickSeconds: draft.pickSeconds,
        pausedRemainingSeconds: null,
        clockUpdatedBy: activatedByUserId ?? null,
        serverDraftProjectionSnapshotId: activeSnapshotId,
        startedAt,
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
  leagueOwnerIds: _leagueOwnerIds = [],
  preferImmediateCurrentCycle = false,
}: AddDropRosterAssetInput): Promise<RosterMoveExecutionResult> {
  if (preferImmediateCurrentCycle) {
    const result = await applyImmediateRosterMove({
      leagueId,
      moveType: 'add-drop-active',
      activeSlotId: dropSlotId,
      addAssetKey: addAsset.assetKey,
    });

    return {
      mode: 'immediate',
      effectiveCycleNumber: result.cycleNumber,
    };
  }

  if (!ownerId) {
    throw new Error('The roster owner is required.');
  }

  const result = await executeSecureRosterAction({
    leagueId,
    action: 'add-drop',
    assetKey: addAsset.assetKey,
    dropSlotId,
    effectiveCycleNumber,
    effectiveLabel,
  });

  return {
    mode: result.mode,
    effectiveCycleNumber: result.effectiveCycleNumber,
  };
}

export async function addFreeAgentToOpenRosterSlot({
  leagueId,
  ownerId,
  targetSlotId,
  addAsset,
  effectiveCycleNumber = null,
  effectiveLabel = null,
  leagueOwnerIds: _leagueOwnerIds = [],
  preferImmediateCurrentCycle = false,
}: AddOpenRosterAssetInput): Promise<RosterMoveExecutionResult> {
  if (preferImmediateCurrentCycle) {
    const result = await applyImmediateRosterMove({
      leagueId,
      moveType: 'add-open-active',
      activeSlotId: targetSlotId,
      addAssetKey: addAsset.assetKey,
    });

    return {
      mode: 'immediate',
      effectiveCycleNumber: result.cycleNumber,
    };
  }

  if (!ownerId) {
    throw new Error('The roster owner is required.');
  }

  const result = await executeSecureRosterAction({
    leagueId,
    action: 'add-open-slot',
    assetKey: addAsset.assetKey,
    targetSlotId,
    effectiveCycleNumber,
    effectiveLabel,
  });

  return {
    mode: result.mode,
    effectiveCycleNumber: result.effectiveCycleNumber,
  };
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
  if (!ownerId) {
    throw new Error('The roster owner is required.');
  }

  await executeSecureRosterAction({
    leagueId,
    action: 'cancel-queued-move',
    rosterSlotId,
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

  const result = await executeSecureRosterAction({
    leagueId,
    action: 'move-active-to-ir',
    activeSlotId,
    effectiveCycleNumber,
    effectiveLabel,
  });

  return {
    mode: result.mode,
    effectiveCycleNumber: result.effectiveCycleNumber,
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
  const rosterSnapshot = await getDoc(getFantasyRosterRef(leagueId, ownerId));

  if (!rosterSnapshot.exists()) {
    throw new Error('Your roster was not found.');
  }

  const roster = normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>);
  const irAsset = roster.irSlots.find((slot) => slot.slotId === irSlotId)?.asset ?? null;

  if (!irAsset) {
    throw new Error('That IR slot is already empty.');
  }

  const resolvedActiveSlotId = activeSlotId ?? roster.activeSlots.find(
    (slot) => slot.position === irAsset.position && slot.asset === null,
  )?.slotId ?? null;

  if (!resolvedActiveSlotId) {
    throw new Error(`Choose a ${irAsset.position} roster slot before activating this player from IR.`);
  }

  const activeSlot = roster.activeSlots.find((slot) => slot.slotId === resolvedActiveSlotId);
  const currentWindow = await getLatestRosterSlotWindow(leagueId, ownerId, resolvedActiveSlotId);
  const immediateCycleNumber = currentWindow?.cycleNumber ?? activeSlot?.openFromCycleNumber ?? null;
  const activeAssignmentUntouched =
    isUntouchedRosterWindow(currentWindow) ||
    (!currentWindow && !activeSlot?.asset && typeof activeSlot?.openFromCycleNumber === 'number');
  const requiredGamesPerCycle = await getLeagueRequiredGamesPerCycle(leagueId);
  const incomingEligibility = await resolveRosterMoveAssetCycleEligibility(
    rosterAssetToDraftableAsset(irAsset),
    requiredGamesPerCycle,
  );
  const incomingEarliestCycleNumber = Math.max(
    irAsset.eligibleFromCycleNumber ?? 1,
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

  const result = await executeSecureRosterAction({
    leagueId,
    action: 'activate-ir-active',
    activeSlotId: resolvedActiveSlotId,
    irSlotId,
    effectiveCycleNumber,
    effectiveLabel,
  });

  return {
    mode: result.mode,
    effectiveCycleNumber: result.effectiveCycleNumber,
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

  const result = await executeSecureRosterAction({
    leagueId,
    action: 'drop-to-waivers',
    sourceRosterArea,
    slotId,
    effectiveCycleNumber,
    effectiveLabel,
  });

  return {
    mode: result.mode,
    effectiveCycleNumber: result.effectiveCycleNumber,
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
  const rosterSnapshot = await getDoc(getFantasyRosterRef(leagueId, ownerId));

  if (!rosterSnapshot.exists()) {
    throw new Error('Your roster was not found.');
  }

  const roster = normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>);
  const benchAsset = roster.benchSlots.find((slot) => slot.slotId === benchSlotId)?.asset ?? null;
  const activeSlot = roster.activeSlots.find((slot) => slot.slotId === activeSlotId);

  if (!benchAsset || !activeSlot) {
    throw new Error('The selected active or bench slot was not found.');
  }

  const requiredGamesPerCycle = await getLeagueRequiredGamesPerCycle(leagueId);
  const benchEligibility = await resolveRosterMoveAssetCycleEligibility(
    rosterAssetToDraftableAsset(benchAsset),
    requiredGamesPerCycle,
  );
  const currentWindow = await getLatestRosterSlotWindow(leagueId, ownerId, activeSlotId);
  const immediateCycleNumber = currentWindow?.cycleNumber ?? activeSlot.openFromCycleNumber ?? null;
  const activeAssignmentUntouched =
    isUntouchedRosterWindow(currentWindow) ||
    (!currentWindow && !activeSlot.asset && typeof activeSlot.openFromCycleNumber === 'number');
  const incomingEarliestCycleNumber = Math.max(
    benchAsset.eligibleFromCycleNumber ?? 1,
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

  const result = await executeSecureRosterAction({
    leagueId,
    action: 'queue-active-bench-swap',
    activeSlotId,
    benchSlotId,
    effectiveCycleNumber,
    effectiveLabel,
  });

  return {
    mode: result.mode,
    effectiveCycleNumber: result.effectiveCycleNumber,
  };
}

export async function moveBenchRosterAssetToIr({
  leagueId,
  ownerId,
  benchSlotId,
  effectiveCycleNumber = null,
  effectiveLabel = null,
}: MoveBenchRosterAssetToIrInput): Promise<void> {
  if (!ownerId) {
    throw new Error('The roster owner is required.');
  }

  await executeSecureRosterAction({
    leagueId,
    action: 'move-bench-to-ir',
    benchSlotId,
    effectiveCycleNumber,
    effectiveLabel,
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
  if (!ownerId) {
    throw new Error('The roster owner is required.');
  }

  await executeSecureRosterAction({
    leagueId,
    action: 'activate-ir-to-bench',
    irSlotId,
    benchSlotId,
    effectiveCycleNumber,
    effectiveLabel,
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
  if (!ownerId) {
    throw new Error('The roster owner is required.');
  }

  await executeSecureRosterAction({
    leagueId,
    action: 'place-waiver-claim',
    waiverId,
    waiverMoveType: moveType,
    dropSlotId,
    targetSlotId,
    effectiveCycleNumber,
    effectiveLabel,
  });
}

export async function processWaiver({
  leagueId,
  commissionerId,
  waiverId,
  leagueTeams: _leagueTeams,
  effectiveCycleNumber = null,
  effectiveLabel = null,
}: ProcessWaiverInput): Promise<void> {
  if (!commissionerId) {
    throw new Error('The commissioner is required.');
  }

  await executeSecureRosterAction({
    leagueId,
    action: 'process-waiver',
    waiverId,
    effectiveCycleNumber,
    effectiveLabel,
  });
}

export async function addDropDraftAsset(input: AddDropRosterAssetInput): Promise<void> {
  await addDropRosterAsset(input);
}

