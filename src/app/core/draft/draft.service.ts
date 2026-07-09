import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc
} from 'firebase/firestore';

import { db } from '../firebase';

import {
  createEmptyFantasyRoster,
  getFantasyRosterRef,
  normalizeFantasyRoster
} from '../team/roster.service';

import {
  FantasyRoster,
  RosterAsset,
  RosterStatus
} from '../team/roster.models';

import {
  DraftableAsset,
  DraftPick,
  DraftPickPreview,
  DraftPosition,
  DraftRosterRequirements,
  DraftStatus,
  FantasyDraft
} from './draft.models';

import type {
  FantasyTeam
} from '../team/team.service';

const DRAFT_DOCUMENT_ID = 'current';


export type FantasyTransactionType =
  | 'add-drop'
  | 'add-open-slot'
  | 'move-to-ir'
  | 'activate-from-ir'
  | 'waiver-claim'
  | 'waiver-award'
  | 'waiver-cleared';

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
  irSlotId?: string | null;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
  createdAt?: unknown;
}

export type FantasyWaiverStatus =
  | 'active'
  | 'claimed'
  | 'cleared';

export type FantasyWaiverClaimMoveType =
  | 'drop'
  | 'open-slot';

export interface FantasyWaiverClaim {
  ownerId: string;
  moveType: FantasyWaiverClaimMoveType;
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
}

export interface AddOpenRosterAssetInput {
  leagueId: string;
  ownerId: string;
  targetSlotId: string;
  addAsset: DraftableAsset;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
  leagueOwnerIds?: string[];
}

export interface MoveRosterAssetToIrInput {
  leagueId: string;
  ownerId: string;
  activeSlotId: string;
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

export interface PlaceWaiverClaimInput {
  leagueId: string;
  ownerId: string;
  waiverId: string;
  moveType: FantasyWaiverClaimMoveType;
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

export const DEFAULT_DRAFT_ROSTER_REQUIREMENTS: DraftRosterRequirements = {
  LW: 3,
  C: 3,
  RW: 3,
  D: 4,
  G: 1
};

export const DEFAULT_DRAFT_TOTAL_ROUNDS =
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS.LW +
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS.C +
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS.RW +
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS.D +
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS.G;

function getDraftRef(leagueId: string) {
  return doc(
    db,
    'leagues',
    leagueId,
    'draft',
    DRAFT_DOCUMENT_ID
  );
}

function getDraftPicksRef(leagueId: string) {
  return collection(
    db,
    'leagues',
    leagueId,
    'draft',
    DRAFT_DOCUMENT_ID,
    'picks'
  );
}



function getTransactionsRef(leagueId: string) {
  return collection(
    db,
    'leagues',
    leagueId,
    'transactions'
  );
}

function getLeagueRef(leagueId: string) {
  return doc(
    db,
    'leagues',
    leagueId
  );
}

function getTeamRef(
  leagueId: string,
  ownerId: string
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'teams',
    ownerId
  );
}

function getWaiversRef(leagueId: string) {
  return collection(
    db,
    'leagues',
    leagueId,
    'waivers'
  );
}

function getWaiverRef(
  leagueId: string,
  waiverId: string
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'waivers',
    waiverId
  );
}

function getDraftPickRef(
  leagueId: string,
  overallPick: number
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'draft',
    DRAFT_DOCUMENT_ID,
    'picks',
    overallPick.toString().padStart(3, '0')
  );
}

function normalizeDraft(
  data: Partial<FantasyDraft>
): FantasyDraft {
  const scheduledStartAt = data.scheduledStartAt ?? null;

  return {
    schemaVersion: data.schemaVersion ?? 1,
    status:
      data.status ??
      (scheduledStartAt ? 'scheduled' : 'setup'),
    format: 'snake',
    totalRounds:
      data.totalRounds ?? DEFAULT_DRAFT_TOTAL_ROUNDS,
    rosterRequirements:
      data.rosterRequirements ?? {
        ...DEFAULT_DRAFT_ROSTER_REQUIREMENTS
      },
    roundOneOrder: Array.isArray(data.roundOneOrder)
      ? data.roundOneOrder
      : [],
    nextOverallPick:
      typeof data.nextOverallPick === 'number'
        ? data.nextOverallPick
        : 1,
    draftedAssetKeys: Array.isArray(data.draftedAssetKeys)
      ? data.draftedAssetKeys
      : [],
    scheduledStartAt,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    startedAt: data.startedAt
  };
}

export function createDefaultFantasyDraft(
  roundOneOrder: string[]
): FantasyDraft {
  return {
    schemaVersion: 1,
    status: 'setup',
    format: 'snake',
    totalRounds: DEFAULT_DRAFT_TOTAL_ROUNDS,
    rosterRequirements: {
      ...DEFAULT_DRAFT_ROSTER_REQUIREMENTS
    },
    roundOneOrder,
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt: null
  };
}

export async function getFantasyDraft(
  leagueId: string
): Promise<FantasyDraft | null> {
  const snapshot = await getDoc(getDraftRef(leagueId));

  if (!snapshot.exists()) {
    return null;
  }

  return normalizeDraft(
    snapshot.data() as Partial<FantasyDraft>
  );
}

export function listenToFantasyDraft(
  leagueId: string,
  callback: (draft: FantasyDraft | null) => void
): () => void {
  return onSnapshot(getDraftRef(leagueId), (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }

    callback(
      normalizeDraft(
        snapshot.data() as Partial<FantasyDraft>
      )
    );
  });
}

export function listenToDraftPicks(
  leagueId: string,
  callback: (picks: DraftPick[]) => void
): () => void {
  const picksQuery = query(
    getDraftPicksRef(leagueId),
    orderBy('overallPick', 'asc')
  );

  return onSnapshot(picksQuery, (snapshot) => {
    callback(
      snapshot.docs.map(
        (pickDoc) => pickDoc.data() as DraftPick
      )
    );
  });
}


export function listenToOwnerTransactions(
  leagueId: string,
  ownerId: string,
  callback: (transactions: FantasyTransaction[]) => void
): () => void {
  const transactionsQuery = query(
    getTransactionsRef(leagueId),
    orderBy('createdAt', 'desc'),
    limit(50)
  );

  return onSnapshot(transactionsQuery, (snapshot) => {
    callback(
      snapshot.docs
        .map((transactionDoc) => ({
          id: transactionDoc.id,
          ...(transactionDoc.data() as Omit<FantasyTransaction, 'id'>)
        }))
        .filter((transaction) => transaction.ownerId === ownerId)
    );
  });
}


export function listenToLeagueWaivers(
  leagueId: string,
  callback: (waivers: FantasyWaiver[]) => void
): () => void {
  const waiversQuery = query(
    getWaiversRef(leagueId),
    orderBy('createdAt', 'desc'),
    limit(100)
  );

  return onSnapshot(waiversQuery, (snapshot) => {
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
          claims: Array.isArray(data.claims)
            ? data.claims
            : [],
          awardedToOwnerId: data.awardedToOwnerId ?? null,
          effectiveCycleNumber: data.effectiveCycleNumber ?? null,
          effectiveLabel: data.effectiveLabel ?? null,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          processedAt: data.processedAt
        };
      })
    );
  });
}

export async function saveFantasyDraft(
  leagueId: string,
  draft: FantasyDraft
): Promise<void> {
  await setDoc(
    getDraftRef(leagueId),
    {
      schemaVersion: draft.schemaVersion,
      status: draft.status,
      format: draft.format,
      totalRounds: draft.totalRounds,
      rosterRequirements: draft.rosterRequirements,
      roundOneOrder: draft.roundOneOrder,
      nextOverallPick: draft.nextOverallPick,
      draftedAssetKeys: draft.draftedAssetKeys,
      scheduledStartAt: draft.scheduledStartAt ?? null,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export function getScheduledStartDate(
  draft: FantasyDraft | null
): Date | null {
  const value = draft?.scheduledStartAt;

  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value
  ) {
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

export function isDraftStartTimeReached(
  draft: FantasyDraft | null,
  now: Date = new Date()
): boolean {
  const startDate = getScheduledStartDate(draft);

  return Boolean(
    startDate &&
    now.getTime() >= startDate.getTime()
  );
}

export async function activateScheduledDraftIfReady(
  leagueId: string
): Promise<FantasyDraft | null> {
  const draftRef = getDraftRef(leagueId);

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(draftRef);

    if (!snapshot.exists()) {
      return null;
    }

    const draft = normalizeDraft(
      snapshot.data() as Partial<FantasyDraft>
    );

    if (
      draft.status !== 'scheduled' ||
      !isDraftStartTimeReached(draft)
    ) {
      return draft;
    }

    transaction.update(draftRef, {
      status: 'live',
      startedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    return {
      ...draft,
      status: 'live'
    };
  });
}

export function getDraftTotalPickCount(
  draft: FantasyDraft | null
): number {
  if (!draft) {
    return 0;
  }

  return draft.totalRounds * draft.roundOneOrder.length;
}

export function getDraftPickAtOverall(
  draft: FantasyDraft | null,
  overallPick: number
): DraftPickPreview | null {
  if (
    !draft ||
    overallPick < 1 ||
    overallPick > getDraftTotalPickCount(draft)
  ) {
    return null;
  }

  const teamCount = draft.roundOneOrder.length;
  const round = Math.floor(
    (overallPick - 1) / teamCount
  ) + 1;

  const pickInRound = (
    (overallPick - 1) % teamCount
  ) + 1;

  const roundOrder =
    round % 2 === 1
      ? draft.roundOneOrder
      : [...draft.roundOneOrder].reverse();

  return {
    overallPick,
    round,
    pickInRound,
    ownerId: roundOrder[pickInRound - 1]
  };
}

export function getCurrentDraftPick(
  draft: FantasyDraft | null
): DraftPickPreview | null {
  if (draft?.status !== 'live') {
    return null;
  }

  return getDraftPickAtOverall(
    draft,
    draft.nextOverallPick
  );
}

export function buildSnakePickPreview(
  roundOneOrder: string[],
  totalRounds: number
): DraftPickPreview[] {
  const draft = createDefaultFantasyDraft(roundOneOrder);

  return Array.from(
    { length: roundOneOrder.length * totalRounds },
    (_, index) =>
      getDraftPickAtOverall(
        {
          ...draft,
          totalRounds
        },
        index + 1
      )
  ).filter(
    (pick): pick is DraftPickPreview => pick !== null
  );
}

function createRosterAsset(
  asset: DraftableAsset,
  rosterStatus: RosterStatus = 'active'
): RosterAsset {
  const cycleScore = {
    cycleNumber: 1,
    gamesCounted: 0,
    fantasyPoints: 0
  };

  if (asset.assetType === 'skater') {
    return {
      assetType: 'skater',
      assetKey: asset.assetKey,
      position: asset.position,
      player: asset.player,
      projectedSeasonPoints: asset.projectedSeasonPoints ?? null,
      projectedCyclePoints: asset.projectedCyclePoints ?? null,
      reliabilityRating: asset.reliabilityRating ?? null,
      volatilityPenalty: asset.volatilityPenalty ?? null,
      floorAdjustedCyclePoints: asset.floorAdjustedCyclePoints ?? null,
      floorAdjustedDraftValue: asset.floorAdjustedDraftValue ?? null,
      rosterStatus,
      cycleScore
    };
  }

  return {
    assetType: 'team-goalie-unit',
    assetKey: asset.assetKey,
    position: 'G',
    teamName: asset.teamName,
    teamAbbreviation: asset.teamAbbreviation,
    teamLogoUrl: asset.teamLogoUrl,
    projectedSeasonPoints: asset.projectedSeasonPoints ?? null,
    projectedCyclePoints: asset.projectedCyclePoints ?? null,
    reliabilityRating: asset.reliabilityRating ?? null,
    volatilityPenalty: asset.volatilityPenalty ?? null,
    floorAdjustedCyclePoints: asset.floorAdjustedCyclePoints ?? null,
    floorAdjustedDraftValue: asset.floorAdjustedDraftValue ?? null,
    rosterStatus,
    cycleScore
  };
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

    const playerId =
      player.id ??
      player.playerId ??
      player.nhlPlayerId;

    return playerId
      ? `skater-${playerId}`
      : '';
  }

  return asset.teamAbbreviation
    ? `goalie-unit-${asset.teamAbbreviation}`
    : '';
}


function rosterAssetToDraftableAsset(
  asset: RosterAsset
): DraftableAsset {
  const assetKey = getRosterAssetKey(asset);

  if (asset.assetType === 'skater') {
    return {
      assetType: 'skater',
      assetKey,
      position: asset.position,
      player: asset.player,
      projectedSeasonPoints: asset.projectedSeasonPoints ?? null,
      projectedCyclePoints: asset.projectedCyclePoints ?? null,
      reliabilityRating: asset.reliabilityRating ?? null,
      volatilityPenalty: asset.volatilityPenalty ?? null,
      floorAdjustedCyclePoints: asset.floorAdjustedCyclePoints ?? null,
      floorAdjustedDraftValue: asset.floorAdjustedDraftValue ?? null
    };
  }

  return {
    assetType: 'team-goalie-unit',
    assetKey,
    position: 'G',
    teamName: asset.teamName,
    teamAbbreviation: asset.teamAbbreviation,
    teamLogoUrl: asset.teamLogoUrl,
    projectedSeasonPoints: asset.projectedSeasonPoints ?? null,
    projectedCyclePoints: asset.projectedCyclePoints ?? null,
    reliabilityRating: asset.reliabilityRating ?? null,
    volatilityPenalty: asset.volatilityPenalty ?? null,
    floorAdjustedCyclePoints: asset.floorAdjustedCyclePoints ?? null,
    floorAdjustedDraftValue: asset.floorAdjustedDraftValue ?? null
  };
}

function buildActiveWaiverPayload(
  droppedAsset: RosterAsset,
  droppedByOwnerId: string,
  effectiveCycleNumber: number | null,
  effectiveLabel: string | null
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
    processedAt: null
  };
}

function getTeamWaiverPriority(
  team: FantasyTeam | undefined,
  fallback: number
): number {
  return typeof team?.waiverPriority === 'number'
    ? team.waiverPriority
    : fallback;
}


function getPositionRequirement(
  draft: FantasyDraft,
  position: DraftPosition
): number {
  return draft.rosterRequirements[position];
}

export async function makeDraftPick(
  leagueId: string,
  selectingUserId: string,
  asset: DraftableAsset
): Promise<DraftPick> {
  const draftRef = getDraftRef(leagueId);

  return runTransaction(db, async (transaction) => {
    const draftSnapshot = await transaction.get(draftRef);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(
      draftSnapshot.data() as Partial<FantasyDraft>
    );

    const scheduleReached = isDraftStartTimeReached(draft);
    const isScheduledDraftReady =
      draft.status === 'scheduled' && scheduleReached;

    const draftIsLive =
      draft.status === 'live' || isScheduledDraftReady;

    if (!draftIsLive) {
      throw new Error('The draft is not live yet.');
    }

    if (
      draft.status === 'complete' ||
      draft.nextOverallPick > getDraftTotalPickCount(draft)
    ) {
      throw new Error('This draft is already complete.');
    }

    const currentPick = getDraftPickAtOverall(
      draft,
      draft.nextOverallPick
    );

    if (!currentPick) {
      throw new Error('Unable to determine the current draft pick.');
    }

    if (currentPick.ownerId !== selectingUserId) {
      throw new Error('It is not your turn to draft.');
    }

    if (draft.draftedAssetKeys.includes(asset.assetKey)) {
      throw new Error('That player or goalie unit has already been drafted.');
    }

    const rosterRef = getFantasyRosterRef(
      leagueId,
      selectingUserId
    );

    const rosterSnapshot = await transaction.get(rosterRef);

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(
          rosterSnapshot.data() as Partial<FantasyRoster>
        )
      : createEmptyFantasyRoster();

    const openSlotIndex = roster.activeSlots.findIndex(
      (slot) =>
        slot.position === asset.position &&
        slot.asset === null
    );

    if (openSlotIndex === -1) {
      const limit = getPositionRequirement(
        draft,
        asset.position
      );

      throw new Error(
        `Your ${asset.position} limit of ${limit} has already been reached.`
      );
    }

    roster.activeSlots[openSlotIndex] = {
      ...roster.activeSlots[openSlotIndex],
      asset: createRosterAsset(asset)
    };

    const pick: DraftPick = {
      overallPick: currentPick.overallPick,
      round: currentPick.round,
      pickInRound: currentPick.pickInRound,
      ownerId: selectingUserId,
      asset
    };

    const nextOverallPick = currentPick.overallPick + 1;
    const draftComplete =
      nextOverallPick > getDraftTotalPickCount(draft);

    const pickRef = getDraftPickRef(
      leagueId,
      currentPick.overallPick
    );

    transaction.set(pickRef, {
      ...pick,
      madeAt: serverTimestamp()
    });

    const rosterPayload = {
      schemaVersion: roster.schemaVersion,
      activeSlots: roster.activeSlots,
      irSlots: roster.irSlots,
      updatedAt: serverTimestamp()
    };

    if (rosterSnapshot.exists()) {
      transaction.set(
        rosterRef,
        rosterPayload,
        { merge: true }
      );
    } else {
      transaction.set(rosterRef, {
        ...rosterPayload,
        createdAt: serverTimestamp()
      });
    }

    const draftPayload = {
      status: draftComplete ? 'complete' : 'live',
      nextOverallPick,
      draftedAssetKeys: [
        ...draft.draftedAssetKeys,
        asset.assetKey
      ],
      updatedAt: serverTimestamp()
    };

    if (isScheduledDraftReady) {
      transaction.update(draftRef, {
        ...draftPayload,
        startedAt: serverTimestamp()
      });
    } else {
      transaction.update(draftRef, draftPayload);
    }

    return pick;
  });
}



function assertDraftComplete(draft: FantasyDraft): void {
  if (draft.status !== 'complete') {
    throw new Error(
      'Roster moves are available after the draft is complete.'
    );
  }
}

function isAssetOnRoster(
  roster: FantasyRoster,
  assetKey: string
): boolean {
  return [
    ...roster.activeSlots.map((slot) => slot.asset),
    ...roster.irSlots.map((slot) => slot.asset)
  ].some((asset) => getRosterAssetKey(asset) === assetKey);
}

function isAssetOnAnyRoster(
  rosterSnapshots: Array<{ exists: () => boolean; data: () => unknown }>,
  assetKey: string
): boolean {
  return rosterSnapshots.some((snapshot) => {
    if (!snapshot.exists()) {
      return false;
    }

    const roster = normalizeFantasyRoster(
      snapshot.data() as Partial<FantasyRoster>
    );

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
  leagueOwnerIds = []
}: AddDropRosterAssetInput): Promise<void> {
  const draftRef = getDraftRef(leagueId);

  const rosterRef = getFantasyRosterRef(
    leagueId,
    ownerId
  );

  const transactionRef = doc(
    getTransactionsRef(leagueId)
  );

  const otherRosterRefs = leagueOwnerIds
    .filter((leagueOwnerId) => leagueOwnerId !== ownerId)
    .map((leagueOwnerId) => getFantasyRosterRef(
      leagueId,
      leagueOwnerId
    ));

  await runTransaction(db, async (transaction) => {
    const [
      draftSnapshot,
      rosterSnapshot,
      ...otherRosterSnapshots
    ] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef),
      ...otherRosterRefs.map((otherRosterRef) => transaction.get(otherRosterRef))
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(
      draftSnapshot.data() as Partial<FantasyDraft>
    );

    assertDraftComplete(draft);

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(
          rosterSnapshot.data() as Partial<FantasyRoster>
        )
      : createEmptyFantasyRoster();

    const slotIndex = roster.activeSlots.findIndex(
      (slot) => slot.slotId === dropSlotId
    );

    if (slotIndex === -1) {
      throw new Error(
        'The selected roster slot was not found.'
      );
    }

    const selectedSlot = roster.activeSlots[slotIndex];
    const dropAsset = selectedSlot.asset;

    if (!dropAsset) {
      throw new Error(
        'The selected roster slot is already empty.'
      );
    }

    if (selectedSlot.position !== addAsset.position) {
      throw new Error(
        `This first version only supports same-position moves. Drop ${addAsset.position} to add ${addAsset.position}.`
      );
    }

    const dropAssetKey = getRosterAssetKey(dropAsset);

    if (dropAssetKey === addAsset.assetKey) {
      throw new Error(
        'You already have that player on your roster.'
      );
    }

    const alreadyOnUserRoster = roster.activeSlots.some((slot) =>
      getRosterAssetKey(slot.asset) === addAsset.assetKey
    );

    if (alreadyOnUserRoster) {
      throw new Error(
        'That player or goalie unit is already on your roster.'
      );
    }

    const alreadyOnAnotherRoster = isAssetOnAnyRoster(
      otherRosterSnapshots,
      addAsset.assetKey
    );

    if (alreadyOnAnotherRoster) {
      throw new Error(
        'That player or goalie unit is already on another roster.'
      );
    }

    roster.activeSlots[slotIndex] = {
      ...selectedSlot,
      asset: createRosterAsset(addAsset, 'new')
    };

    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );

    const waiverRef = getWaiverRef(
      leagueId,
      dropAssetKey
    );

    transaction.set(
      waiverRef,
      buildActiveWaiverPayload(
        dropAsset,
        ownerId,
        effectiveCycleNumber,
        effectiveLabel
      )
    );

    transaction.set(transactionRef, {
      type: 'add-drop',
      ownerId,
      addedAsset: addAsset,
      droppedAsset: dropAsset,
      waiverId: dropAssetKey,
      waiverAsset: rosterAssetToDraftableAsset(dropAsset),
      dropSlotId,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp()
    });
  });
}


export async function addFreeAgentToOpenRosterSlot({
  leagueId,
  ownerId,
  targetSlotId,
  addAsset,
  effectiveCycleNumber = null,
  effectiveLabel = null,
  leagueOwnerIds = []
}: AddOpenRosterAssetInput): Promise<void> {
  const draftRef = getDraftRef(leagueId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));

  const otherRosterRefs = leagueOwnerIds
    .filter((leagueOwnerId) => leagueOwnerId !== ownerId)
    .map((leagueOwnerId) => getFantasyRosterRef(
      leagueId,
      leagueOwnerId
    ));

  await runTransaction(db, async (transaction) => {
    const [
      draftSnapshot,
      rosterSnapshot,
      ...otherRosterSnapshots
    ] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef),
      ...otherRosterRefs.map((otherRosterRef) => transaction.get(otherRosterRef))
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(
      draftSnapshot.data() as Partial<FantasyDraft>
    );

    assertDraftComplete(draft);

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(
          rosterSnapshot.data() as Partial<FantasyRoster>
        )
      : createEmptyFantasyRoster();

    const slotIndex = roster.activeSlots.findIndex(
      (slot) => slot.slotId === targetSlotId
    );

    if (slotIndex === -1) {
      throw new Error('The selected roster slot was not found.');
    }

    const selectedSlot = roster.activeSlots[slotIndex];

    if (selectedSlot.asset) {
      throw new Error(
        'That roster slot is already filled. Choose a filled same-position player to drop, or choose an open slot.'
      );
    }

    if (selectedSlot.position !== addAsset.position) {
      throw new Error(
        `This player must be added to an open ${addAsset.position} slot.`
      );
    }

    if (isAssetOnRoster(roster, addAsset.assetKey)) {
      throw new Error(
        'That player or goalie unit is already on your roster.'
      );
    }

    const alreadyOnAnotherRoster = isAssetOnAnyRoster(
      otherRosterSnapshots,
      addAsset.assetKey
    );

    if (alreadyOnAnotherRoster) {
      throw new Error(
        'That player or goalie unit is already on another roster.'
      );
    }

    roster.activeSlots[slotIndex] = {
      ...selectedSlot,
      asset: createRosterAsset(addAsset, 'new')
    };

    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );

    transaction.set(transactionRef, {
      type: 'add-open-slot',
      ownerId,
      addedAsset: addAsset,
      droppedAsset: null,
      targetSlotId,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp()
    });
  });
}

export async function moveRosterAssetToIr({
  leagueId,
  ownerId,
  activeSlotId,
  effectiveCycleNumber = null,
  effectiveLabel = null
}: MoveRosterAssetToIrInput): Promise<void> {
  const draftRef = getDraftRef(leagueId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));

  await runTransaction(db, async (transaction) => {
    const [draftSnapshot, rosterSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef)
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(
      draftSnapshot.data() as Partial<FantasyDraft>
    );

    assertDraftComplete(draft);

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(
          rosterSnapshot.data() as Partial<FantasyRoster>
        )
      : createEmptyFantasyRoster();

    const activeSlotIndex = roster.activeSlots.findIndex(
      (slot) => slot.slotId === activeSlotId
    );

    if (activeSlotIndex === -1) {
      throw new Error('The selected active roster slot was not found.');
    }

    const activeSlot = roster.activeSlots[activeSlotIndex];
    const asset = activeSlot.asset;

    if (!asset) {
      throw new Error('That roster slot is already empty.');
    }

    if (asset.assetType !== 'skater') {
      throw new Error('Only skaters can be moved to IR.');
    }

    const openIrSlotIndex = roster.irSlots.findIndex(
      (slot) => slot.asset === null
    );

    if (openIrSlotIndex === -1) {
      throw new Error('All IR slots are already filled.');
    }

    const openIrSlot = roster.irSlots[openIrSlotIndex];
    const irAsset = {
      ...asset,
      rosterStatus: 'injured' as RosterStatus
    };

    roster.activeSlots[activeSlotIndex] = {
      ...activeSlot,
      asset: null
    };

    roster.irSlots[openIrSlotIndex] = {
      ...openIrSlot,
      asset: irAsset
    };

    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );

    transaction.set(transactionRef, {
      type: 'move-to-ir',
      ownerId,
      movedAsset: asset,
      activeSlotId,
      irSlotId: openIrSlot.slotId,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp()
    });
  });
}

export async function activateIrRosterAsset({
  leagueId,
  ownerId,
  irSlotId,
  activeSlotId = null,
  effectiveCycleNumber = null,
  effectiveLabel = null
}: ActivateIrRosterAssetInput): Promise<void> {
  const draftRef = getDraftRef(leagueId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));

  await runTransaction(db, async (transaction) => {
    const [draftSnapshot, rosterSnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(rosterRef)
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(
      draftSnapshot.data() as Partial<FantasyDraft>
    );

    assertDraftComplete(draft);

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(
          rosterSnapshot.data() as Partial<FantasyRoster>
        )
      : createEmptyFantasyRoster();

    const irSlotIndex = roster.irSlots.findIndex(
      (slot) => slot.slotId === irSlotId
    );

    if (irSlotIndex === -1) {
      throw new Error('The selected IR slot was not found.');
    }

    const irSlot = roster.irSlots[irSlotIndex];
    const asset = irSlot.asset;

    if (!asset) {
      throw new Error('That IR slot is already empty.');
    }

    const activeSlotIndex = activeSlotId
      ? roster.activeSlots.findIndex((slot) => slot.slotId === activeSlotId)
      : roster.activeSlots.findIndex(
          (slot) => slot.position === asset.position && slot.asset === null
        );

    if (activeSlotIndex === -1) {
      throw new Error(
        `No open ${asset.position} slot was found. Drop or move a player before activating this player from IR.`
      );
    }

    const activeSlot = roster.activeSlots[activeSlotIndex];

    if (activeSlot.position !== asset.position) {
      throw new Error(
        `This player must be activated into an open ${asset.position} slot.`
      );
    }

    if (activeSlot.asset) {
      throw new Error('The selected active roster slot is already filled.');
    }

    const activatedAsset = {
      ...asset,
      rosterStatus: 'moved' as RosterStatus
    };

    roster.activeSlots[activeSlotIndex] = {
      ...activeSlot,
      asset: activatedAsset
    };

    roster.irSlots[irSlotIndex] = {
      ...irSlot,
      asset: null
    };

    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );

    transaction.set(transactionRef, {
      type: 'activate-from-ir',
      ownerId,
      activatedAsset: asset,
      activeSlotId: activeSlot.slotId,
      irSlotId,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp()
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
  effectiveLabel = null
}: PlaceWaiverClaimInput): Promise<void> {
  const draftRef = getDraftRef(leagueId);
  const waiverRef = getWaiverRef(leagueId, waiverId);
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);
  const teamRef = getTeamRef(leagueId, ownerId);
  const transactionRef = doc(getTransactionsRef(leagueId));

  await runTransaction(db, async (transaction) => {
    const [
      draftSnapshot,
      waiverSnapshot,
      rosterSnapshot,
      teamSnapshot
    ] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(waiverRef),
      transaction.get(rosterRef),
      transaction.get(teamRef)
    ]);

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(
      draftSnapshot.data() as Partial<FantasyDraft>
    );

    assertDraftComplete(draft);

    if (!waiverSnapshot.exists()) {
      throw new Error('That waiver player was not found.');
    }

    const waiver = {
      id: waiverSnapshot.id,
      ...(waiverSnapshot.data() as Omit<FantasyWaiver, 'id'>)
    } as FantasyWaiver;

    if (waiver.status !== 'active') {
      throw new Error('That player is no longer on waivers.');
    }

    if (waiver.droppedByOwnerId === ownerId) {
      throw new Error(
        'You cannot claim a player you just dropped while he is still on waivers.'
      );
    }

    const claimAsset = waiver.asset;

    if (!claimAsset || claimAsset.assetKey !== waiver.assetKey) {
      throw new Error('The waiver asset is missing or invalid.');
    }

    const roster: FantasyRoster = rosterSnapshot.exists()
      ? normalizeFantasyRoster(
          rosterSnapshot.data() as Partial<FantasyRoster>
        )
      : createEmptyFantasyRoster();

    if (isAssetOnRoster(roster, claimAsset.assetKey)) {
      throw new Error('That player or goalie unit is already on your roster.');
    }

    const selectedSlotId = moveType === 'open-slot'
      ? targetSlotId
      : dropSlotId;

    if (!selectedSlotId) {
      throw new Error('Choose the roster spot for this waiver claim.');
    }

    const activeSlot = roster.activeSlots.find(
      (slot) => slot.slotId === selectedSlotId
    );

    if (!activeSlot) {
      throw new Error('The selected roster slot was not found.');
    }

    if (activeSlot.position !== claimAsset.position) {
      throw new Error(
        `This waiver claim needs a ${claimAsset.position} roster spot.`
      );
    }

    if (moveType === 'open-slot' && activeSlot.asset) {
      throw new Error('The selected open slot is no longer open.');
    }

    if (moveType === 'drop' && !activeSlot.asset) {
      throw new Error('The selected drop slot is already open.');
    }

    const team = teamSnapshot.exists()
      ? teamSnapshot.data() as FantasyTeam
      : undefined;

    const newClaim: FantasyWaiverClaim = {
      ownerId,
      moveType,
      dropSlotId: moveType === 'drop' ? selectedSlotId : null,
      targetSlotId: moveType === 'open-slot' ? selectedSlotId : null,
      waiverPriorityAtClaim: getTeamWaiverPriority(team, 999),
      effectiveCycleNumber,
      effectiveLabel,
      claimedAt: new Date().toISOString()
    };

    const existingClaims = Array.isArray(waiver.claims)
      ? waiver.claims
      : [];

    const nextClaims = [
      ...existingClaims.filter((claim) => claim.ownerId !== ownerId),
      newClaim
    ];

    transaction.set(
      waiverRef,
      {
        ...waiver,
        claims: nextClaims,
        updatedAt: serverTimestamp()
      },
      { merge: true }
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
      createdAt: serverTimestamp()
    });
  });
}

export async function processWaiver({
  leagueId,
  commissionerId,
  waiverId,
  leagueTeams,
  effectiveCycleNumber = null,
  effectiveLabel = null
}: ProcessWaiverInput): Promise<void> {
  const leagueRef = getLeagueRef(leagueId);
  const draftRef = getDraftRef(leagueId);
  const waiverRef = getWaiverRef(leagueId, waiverId);
  const transactionRef = doc(getTransactionsRef(leagueId));

  const orderedTeams = [...leagueTeams].sort(
    (first, second) =>
      getTeamWaiverPriority(first, 999) - getTeamWaiverPriority(second, 999)
  );

  await runTransaction(db, async (transaction) => {
    const [leagueSnapshot, draftSnapshot, waiverSnapshot] = await Promise.all([
      transaction.get(leagueRef),
      transaction.get(draftRef),
      transaction.get(waiverRef)
    ]);

    if (!leagueSnapshot.exists()) {
      throw new Error('League not found.');
    }

    const leagueData = leagueSnapshot.data() as { commissionerId?: string };

    if (leagueData.commissionerId !== commissionerId) {
      throw new Error('Only the commissioner can process waivers.');
    }

    if (!draftSnapshot.exists()) {
      throw new Error('Draft setup was not found.');
    }

    const draft = normalizeDraft(
      draftSnapshot.data() as Partial<FantasyDraft>
    );

    assertDraftComplete(draft);

    if (!waiverSnapshot.exists()) {
      throw new Error('That waiver player was not found.');
    }

    const waiver = {
      id: waiverSnapshot.id,
      ...(waiverSnapshot.data() as Omit<FantasyWaiver, 'id'>)
    } as FantasyWaiver;

    if (waiver.status !== 'active') {
      throw new Error('That waiver has already been processed.');
    }

    const activeClaims = Array.isArray(waiver.claims)
      ? waiver.claims
      : [];

    if (activeClaims.length === 0) {
      transaction.set(
        waiverRef,
        {
          status: 'cleared',
          processedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );

      transaction.set(transactionRef, {
        type: 'waiver-cleared',
        ownerId: commissionerId,
        waiverId,
        waiverAsset: waiver.asset,
        effectiveCycleNumber,
        effectiveLabel,
        createdAt: serverTimestamp()
      });

      return;
    }

    const teamByOwnerId = new Map(
      orderedTeams.map((team, index) => [
        team.ownerId,
        {
          team,
          fallbackPriority: index + 1
        }
      ])
    );

    const winningClaim = [...activeClaims].sort((first, second) => {
      const firstTeam = teamByOwnerId.get(first.ownerId);
      const secondTeam = teamByOwnerId.get(second.ownerId);

      return getTeamWaiverPriority(firstTeam?.team, firstTeam?.fallbackPriority ?? 999) -
        getTeamWaiverPriority(secondTeam?.team, secondTeam?.fallbackPriority ?? 999);
    })[0];

    if (!winningClaim) {
      throw new Error('Unable to determine a winning waiver claim.');
    }

    const winnerRosterRef = getFantasyRosterRef(
      leagueId,
      winningClaim.ownerId
    );

    const winnerRosterSnapshot = await transaction.get(winnerRosterRef);

    const winnerRoster: FantasyRoster = winnerRosterSnapshot.exists()
      ? normalizeFantasyRoster(
          winnerRosterSnapshot.data() as Partial<FantasyRoster>
        )
      : createEmptyFantasyRoster();

    const slotId = winningClaim.moveType === 'open-slot'
      ? winningClaim.targetSlotId
      : winningClaim.dropSlotId;

    if (!slotId) {
      throw new Error('The winning claim does not have a roster slot selected.');
    }

    const activeSlotIndex = winnerRoster.activeSlots.findIndex(
      (slot) => slot.slotId === slotId
    );

    if (activeSlotIndex === -1) {
      throw new Error('The winning claim roster slot was not found.');
    }

    const selectedSlot = winnerRoster.activeSlots[activeSlotIndex];

    if (selectedSlot.position !== waiver.asset.position) {
      throw new Error(
        `The winning claim needs an open ${waiver.asset.position} roster spot.`
      );
    }

    if (winningClaim.moveType === 'open-slot' && selectedSlot.asset) {
      throw new Error(
        'The winning claim selected an open slot that is no longer open.'
      );
    }

    if (winningClaim.moveType === 'drop' && !selectedSlot.asset) {
      throw new Error(
        'The winning claim selected a drop slot that is now empty.'
      );
    }

    const droppedByWinningTeam = selectedSlot.asset ?? null;

    winnerRoster.activeSlots[activeSlotIndex] = {
      ...selectedSlot,
      asset: createRosterAsset(waiver.asset, 'new')
    };

    transaction.set(
      winnerRosterRef,
      {
        schemaVersion: winnerRoster.schemaVersion,
        activeSlots: winnerRoster.activeSlots,
        irSlots: winnerRoster.irSlots,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );

    if (droppedByWinningTeam) {
      const droppedAssetKey = getRosterAssetKey(droppedByWinningTeam);
      const nextWaiverRef = getWaiverRef(leagueId, droppedAssetKey);

      transaction.set(
        nextWaiverRef,
        buildActiveWaiverPayload(
          droppedByWinningTeam,
          winningClaim.ownerId,
          effectiveCycleNumber,
          effectiveLabel
        )
      );
    }

    const winnerTeamRecord = teamByOwnerId.get(winningClaim.ownerId);
    const winnerPriority = getTeamWaiverPriority(
      winnerTeamRecord?.team,
      winnerTeamRecord?.fallbackPriority ?? orderedTeams.length
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
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    }

    transaction.set(
      waiverRef,
      {
        status: 'claimed',
        awardedToOwnerId: winningClaim.ownerId,
        processedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );

    transaction.set(transactionRef, {
      type: 'waiver-award',
      ownerId: winningClaim.ownerId,
      winningOwnerId: winningClaim.ownerId,
      waiverId,
      waiverAsset: waiver.asset,
      addedAsset: waiver.asset,
      droppedAsset: droppedByWinningTeam,
      targetSlotId: winningClaim.targetSlotId ?? null,
      dropSlotId: winningClaim.dropSlotId ?? null,
      effectiveCycleNumber,
      effectiveLabel,
      createdAt: serverTimestamp()
    });
  });
}

// Backward-compatible wrapper name. It now preserves draft history and only
// updates the current roster plus transaction log. New code should call
// addDropRosterAsset with a dropSlotId.
export async function addDropDraftAsset(input: AddDropRosterAssetInput): Promise<void> {
  return addDropRosterAsset(input);
}
