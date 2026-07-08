import {
  collection,
  doc,
  getDoc,
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
  RosterAsset
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

const DRAFT_DOCUMENT_ID = 'current';

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
  asset: DraftableAsset
): RosterAsset {
  const cycleScore = {
    cycleNumber: 1,
    gamesCounted: 0,
    fantasyPoints: 0
  };

  if (asset.assetType === 'skater') {
    return {
      assetType: 'skater',
      position: asset.position,
      player: asset.player,
      cycleScore
    };
  }

  return {
    assetType: 'team-goalie-unit',
    position: 'G',
    teamName: asset.teamName,
    teamAbbreviation: asset.teamAbbreviation,
    teamLogoUrl: asset.teamLogoUrl,
    cycleScore
  };
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