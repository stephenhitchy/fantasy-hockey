import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc
} from 'firebase/firestore';

import { db } from '../firebase';

import {
  DraftPickPreview,
  DraftRosterRequirements,
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

export function buildSnakePickPreview(
  roundOneOrder: string[],
  totalRounds: number
): DraftPickPreview[] {
  const picks: DraftPickPreview[] = [];
  let overallPick = 1;

  for (let round = 1; round <= totalRounds; round++) {
    const roundOrder =
      round % 2 === 1
        ? roundOneOrder
        : [...roundOneOrder].reverse();

    roundOrder.forEach((ownerId, index) => {
      picks.push({
        overallPick,
        round,
        pickInRound: index + 1,
        ownerId
      });

      overallPick++;
    });
  }

  return picks;
}