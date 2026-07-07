import {
  doc,
  getDoc,
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
    roundOneOrder
  };
}

export async function getFantasyDraft(
  leagueId: string
): Promise<FantasyDraft | null> {
  const snapshot = await getDoc(getDraftRef(leagueId));

  if (!snapshot.exists()) {
    return null;
  }

  return snapshot.data() as FantasyDraft;
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
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
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