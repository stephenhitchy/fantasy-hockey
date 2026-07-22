import {
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc
} from 'firebase/firestore';

import { db } from '../firebase';
import {
  BENCH_SLOT_COUNT,
  DEFAULT_ROSTER_GROUPS,
  IR_SLOT_COUNT
} from './roster-config';

import {
  ActiveRosterSlot,
  BenchRosterSlot,
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
      pendingMove: null,
      openFromCycleNumber: null
    }))
  );
}

function buildEmptyBenchSlots(): BenchRosterSlot[] {
  return Array.from({ length: BENCH_SLOT_COUNT }, (_, index) => ({
    slotId: `B-${index + 1}`,
    slotNumber: index + 1,
    asset: null
  }));
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
    schemaVersion: 2,
    activeSlots: buildEmptyActiveSlots(),
    benchSlots: buildEmptyBenchSlots(),
    irSlots: buildEmptyIrSlots()
  };
}

export function normalizeFantasyRoster(
  data: Partial<FantasyRoster>
): FantasyRoster {
  const fallbackRoster = createEmptyFantasyRoster();

  const activeSlots = Array.isArray(data.activeSlots)
    ? (data.activeSlots as ActiveRosterSlot[]).map((slot) => ({
        ...slot,
        pendingMove: slot.pendingMove ?? null,
        openFromCycleNumber:
          typeof slot.openFromCycleNumber === 'number'
            ? slot.openFromCycleNumber
            : null
      }))
    : fallbackRoster.activeSlots;

  const benchSlots = Array.isArray(data.benchSlots)
    ? (data.benchSlots as BenchRosterSlot[]).slice(0, BENCH_SLOT_COUNT)
    : fallbackRoster.benchSlots;

  while (benchSlots.length < BENCH_SLOT_COUNT) {
    const slotNumber = benchSlots.length + 1;
    benchSlots.push({ slotId: `B-${slotNumber}`, slotNumber, asset: null });
  }

  const sourceIrSlots = Array.isArray(data.irSlots)
    ? data.irSlots as IrRosterSlot[]
    : fallbackRoster.irSlots;

  // Schema v1 had four IR slots and no bench. Preserve a legacy IR4 asset by
  // moving it into the first empty bench slot rather than silently deleting it.
  for (const overflowSlot of sourceIrSlots.slice(IR_SLOT_COUNT)) {
    if (!overflowSlot.asset) {
      continue;
    }

    const openBenchSlot = benchSlots.find((slot) => slot.asset === null);
    if (openBenchSlot) {
      openBenchSlot.asset = {
        ...overflowSlot.asset,
        rosterStatus: 'benched'
      };
    }
  }

  const irSlots = sourceIrSlots.slice(0, IR_SLOT_COUNT);
  while (irSlots.length < IR_SLOT_COUNT) {
    const slotNumber = irSlots.length + 1;
    irSlots.push({ slotId: `IR-${slotNumber}`, slotNumber, asset: null });
  }

  return {
    schemaVersion: 2,
    activeSlots,
    benchSlots,
    irSlots,
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
      const source = snapshot.data() as Partial<FantasyRoster>;
      const roster = normalizeFantasyRoster(source);
      const needsMigration =
        source.schemaVersion !== 2 ||
        !Array.isArray(source.benchSlots) ||
        source.benchSlots.length !== BENCH_SLOT_COUNT ||
        !Array.isArray(source.irSlots) ||
        source.irSlots.length !== IR_SLOT_COUNT;

      if (needsMigration) {
        transaction.set(rosterRef, {
          schemaVersion: roster.schemaVersion,
          activeSlots: roster.activeSlots,
          benchSlots: roster.benchSlots,
          irSlots: roster.irSlots,
          updatedAt: serverTimestamp()
        }, { merge: true });
      }

      return roster;
    }

    const roster = createEmptyFantasyRoster();

    transaction.set(rosterRef, {
      schemaVersion: roster.schemaVersion,
      activeSlots: roster.activeSlots,
      benchSlots: roster.benchSlots,
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
      benchSlots: roster.benchSlots,
      irSlots: roster.irSlots,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}
