import {
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc
} from 'firebase/firestore';

import { db } from '../firebase';
import {
  DEFAULT_ROSTER_GROUPS,
  IR_SLOT_COUNT
} from './roster-config';

import {
  ActiveRosterSlot,
  FantasyRoster,
  IrRosterSlot
} from './roster.models';

const ROSTER_DOCUMENT_ID = 'current';

function buildEmptyActiveSlots(): ActiveRosterSlot[] {
  return DEFAULT_ROSTER_GROUPS.flatMap((group) =>
    Array.from({ length: group.slots }, (_, index) => ({
      slotId: `${group.position}-${index + 1}`,
      position: group.position,
      slotNumber: index + 1,
      asset: null,
      pendingMove: null
    }))
  );
}

function buildEmptyIrSlots(): IrRosterSlot[] {
  return Array.from({ length: IR_SLOT_COUNT }, (_, index) => ({
    slotId: `IR-${index + 1}`,
    slotNumber: index + 1,
    asset: null
  }));
}

export function createEmptyFantasyRoster(): FantasyRoster {
  return {
    schemaVersion: 1,
    activeSlots: buildEmptyActiveSlots(),
    irSlots: buildEmptyIrSlots()
  };
}

export function normalizeFantasyRoster(
  data: Partial<FantasyRoster>
): FantasyRoster {
  const fallbackRoster = createEmptyFantasyRoster();

  return {
    schemaVersion: data.schemaVersion ?? 1,
    activeSlots: Array.isArray(data.activeSlots)
      ? (data.activeSlots as ActiveRosterSlot[]).map((slot) => ({
          ...slot,
          pendingMove: slot.pendingMove ?? null
        }))
      : fallbackRoster.activeSlots,
    irSlots: Array.isArray(data.irSlots)
      ? data.irSlots as IrRosterSlot[]
      : fallbackRoster.irSlots,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

export function getFantasyRosterRef(
  leagueId: string,
  ownerId: string
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'teams',
    ownerId,
    'roster',
    ROSTER_DOCUMENT_ID
  );
}

export async function getOrCreateFantasyRoster(
  leagueId: string,
  ownerId: string
): Promise<FantasyRoster> {
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(rosterRef);

    if (snapshot.exists()) {
      return normalizeFantasyRoster(
        snapshot.data() as Partial<FantasyRoster>
      );
    }

    const roster = createEmptyFantasyRoster();

    transaction.set(rosterRef, {
      schemaVersion: roster.schemaVersion,
      activeSlots: roster.activeSlots,
      irSlots: roster.irSlots,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    return roster;
  });
}

export function listenToFantasyRoster(
  leagueId: string,
  ownerId: string,
  callback: (roster: FantasyRoster | null) => void,
  onError?: (error: Error) => void
): () => void {
  return onSnapshot(
    getFantasyRosterRef(leagueId, ownerId),
    (snapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }

      callback(
        normalizeFantasyRoster(
          snapshot.data() as Partial<FantasyRoster>
        )
      );
    },
    (error) => {
      const normalizedError = error instanceof Error
        ? error
        : new Error('Unable to load the fantasy roster.');

      if (onError) {
        onError(normalizedError);
        return;
      }

      console.error(
        'Unable to listen to the fantasy roster.',
        error
      );
    }
  );
}

export async function saveFantasyRoster(
  leagueId: string,
  ownerId: string,
  roster: FantasyRoster
): Promise<void> {
  const rosterRef = getFantasyRosterRef(leagueId, ownerId);

  await setDoc(
    rosterRef,
    {
      schemaVersion: roster.schemaVersion,
      activeSlots: roster.activeSlots,
      irSlots: roster.irSlots,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}
