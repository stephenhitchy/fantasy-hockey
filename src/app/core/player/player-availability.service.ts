import {
  computed,
  Signal,
  signal
} from '@angular/core';

import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Unsubscribe,
  where
} from 'firebase/firestore';

import { onAuthStateChanged } from 'firebase/auth';

import {
  auth,
  db
} from '../firebase';

import { NHLPlayer } from './player.models';

import {
  PLAYER_AVAILABILITY_OVERRIDES,
  PLAYER_AVAILABILITY_OVERRIDES_LAST_REVIEWED
} from './player-availability-overrides';

import {
  PlayerAvailability,
  PlayerAvailabilityDatabaseRecord,
  PlayerAvailabilityDatabaseSource,
  PlayerAvailabilityOverride,
  PlayerAvailabilityStatus
} from './player-availability.models';

import {
  getGlobalPlayerAvailabilityRecords,
  playerAvailabilityGlobalRecords,
  startGlobalPlayerAvailabilityListener,
  stopGlobalPlayerAvailabilityListener
} from './player-availability-sync.service';

const STATUS_LABELS: Record<PlayerAvailabilityStatus, string> = {
  active: 'Active',
  'day-to-day': 'Day-to-Day',
  out: 'Out',
  'injured-reserve': 'Injured Reserve',
  'long-term-injured-reserve': 'Long-Term IR',
  suspended: 'Suspended',
  'personal-leave': 'Personal Leave',
  unknown: 'Unknown'
};

const STATUS_SHORT_LABELS: Record<PlayerAvailabilityStatus, string> = {
  active: 'Active',
  'day-to-day': 'DTD',
  out: 'Out',
  'injured-reserve': 'IR',
  'long-term-injured-reserve': 'LTIR',
  suspended: 'Susp.',
  'personal-leave': 'Leave',
  unknown: 'Unknown'
};

const VALID_STATUSES = new Set<PlayerAvailabilityStatus>([
  'active',
  'day-to-day',
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
  'suspended',
  'personal-leave',
  'unknown'
]);

const IR_ELIGIBLE_STATUSES = new Set<PlayerAvailabilityStatus>([
  'out',
  'injured-reserve',
  'long-term-injured-reserve'
]);

const OVERRIDES_BY_PLAYER_ID = new Map<number, PlayerAvailabilityOverride>();
const OVERRIDES_BY_PLAYER_NAME = new Map<string, PlayerAvailabilityOverride>();

const manualDatabaseRecordsSignal = signal<
  ReadonlyMap<number, PlayerAvailabilityDatabaseRecord>
>(new Map());

export const playerAvailabilityDatabaseRecords: Signal<
  ReadonlyMap<number, PlayerAvailabilityDatabaseRecord>
> = computed(() => {
  const merged = new Map(playerAvailabilityGlobalRecords());

  for (const [playerId, record] of manualDatabaseRecordsSignal()) {
    merged.set(playerId, record);
  }

  return merged;
});

let activeLeagueId = '';
let activeUserId = '';
let queuedListenerKey = '';
let stopDatabaseListener: Unsubscribe | null = null;
let manualDatabaseRecordsLoaded = false;

function normalizePlayerName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function getLeagueIdFromCurrentPath(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  const match = window.location.pathname.match(/\/leagues\/([^/]+)/);

  if (!match?.[1]) {
    return '';
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function toIsoDate(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const converted = (value as { toDate: () => Date }).toDate();

    return converted.toISOString();
  }

  return '';
}

function normalizeDatabaseRecord(
  data: Record<string, unknown>,
  leagueId: string
): PlayerAvailabilityDatabaseRecord | null {
  const playerId = data['playerId'];
  const playerName = data['playerName'];
  const status = data['status'];

  if (
    typeof playerId !== 'number' ||
    typeof playerName !== 'string' ||
    typeof status !== 'string' ||
    !VALID_STATUSES.has(status as PlayerAvailabilityStatus)
  ) {
    return null;
  }

  const normalizedStatus = status as PlayerAvailabilityStatus;

  const rawSource = data['source'];
  const source: PlayerAvailabilityDatabaseSource =
    rawSource === 'espn'
      ? 'espn'
      : 'commissioner';

  return {
    playerId,
    playerName,
    status: normalizedStatus,
    note: typeof data['note'] === 'string' ? data['note'] : '',
    irEligible: isPlayerIrEligible(normalizedStatus),
    updatedAt: toIsoDate(data['updatedAt']),
    updatedBy: typeof data['updatedBy'] === 'string'
      ? data['updatedBy']
      : '',
    source,
    leagueId,
    externalSource: data['externalSource'] === 'ESPN'
      ? 'ESPN'
      : undefined,
    externalStatus: typeof data['externalStatus'] === 'string'
      ? data['externalStatus']
      : undefined,
    externalReturnDate: typeof data['externalReturnDate'] === 'string'
      ? data['externalReturnDate']
      : undefined,
    externalInjuryDate: typeof data['externalInjuryDate'] === 'string'
      ? data['externalInjuryDate']
      : undefined,
    externalTeamName: typeof data['externalTeamName'] === 'string'
      ? data['externalTeamName']
      : undefined,
    syncedAt: toIsoDate(data['syncedAt']) || undefined
  };
}

function stopCurrentDatabaseListener(): void {
  stopDatabaseListener?.();
  stopDatabaseListener = null;
  activeLeagueId = '';
  activeUserId = '';
  queuedListenerKey = '';
  manualDatabaseRecordsLoaded = false;
  manualDatabaseRecordsSignal.set(new Map());
}

export function stopPlayerAvailabilityListeners(): void {
  stopCurrentDatabaseListener();
  stopGlobalPlayerAvailabilityListener();
}

for (const override of PLAYER_AVAILABILITY_OVERRIDES) {
  if (typeof override.playerId === 'number') {
    OVERRIDES_BY_PLAYER_ID.set(override.playerId, override);
  }

  const names = [
    override.playerName,
    ...(override.playerAliases ?? [])
  ].filter((value): value is string => Boolean(value));

  for (const name of names) {
    OVERRIDES_BY_PLAYER_NAME.set(
      normalizePlayerName(name),
      override
    );
  }
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    stopPlayerAvailabilityListeners();
  }
});

export function isPlayerIrEligible(
  status: PlayerAvailabilityStatus
): boolean {
  return IR_ELIGIBLE_STATUSES.has(status);
}

export function getPlayerAvailabilityStatusLabel(
  status: PlayerAvailabilityStatus
): string {
  return STATUS_LABELS[status];
}

export function getPlayerAvailabilityStatusShortLabel(
  status: PlayerAvailabilityStatus
): string {
  return STATUS_SHORT_LABELS[status];
}

export function getPlayerAvailabilityStatusClass(
  status: PlayerAvailabilityStatus
): string {
  return `availability-${status}`;
}

function queuePlayerAvailabilityListenerForCurrentLeague(): void {
  const resolvedLeagueId = getLeagueIdFromCurrentPath();
  const currentUserId = auth.currentUser?.uid ?? '';

  if (!resolvedLeagueId || !currentUserId) {
    return;
  }

  const listenerKey = `${resolvedLeagueId}::${currentUserId}`;

  if (
    (
      stopDatabaseListener &&
      activeLeagueId === resolvedLeagueId &&
      activeUserId === currentUserId
    ) ||
    queuedListenerKey === listenerKey
  ) {
    return;
  }

  queuedListenerKey = listenerKey;

  queueMicrotask(() => {
    if (queuedListenerKey !== listenerKey) {
      return;
    }

    queuedListenerKey = '';
    startPlayerAvailabilityListenerForLeague(resolvedLeagueId);
  });
}

export function startPlayerAvailabilityListenerForLeague(
  leagueId?: string
): void {
  const resolvedLeagueId = leagueId?.trim() || getLeagueIdFromCurrentPath();
  const currentUserId = auth.currentUser?.uid ?? '';

  if (!resolvedLeagueId || !currentUserId) {
    return;
  }

  queuedListenerKey = '';
  startGlobalPlayerAvailabilityListener();

  if (
    stopDatabaseListener &&
    activeLeagueId === resolvedLeagueId &&
    activeUserId === currentUserId
  ) {
    return;
  }

  stopCurrentDatabaseListener();
  activeLeagueId = resolvedLeagueId;
  activeUserId = currentUserId;

  const manualRecordsQuery = query(
    collection(
      db,
      'leagues',
      resolvedLeagueId,
      'playerAvailability'
    ),
    where('source', '==', 'commissioner')
  );

  stopDatabaseListener = onSnapshot(
    manualRecordsQuery,
    (snapshot) => {
      const nextRecords = new Map<
        number,
        PlayerAvailabilityDatabaseRecord
      >();

      snapshot.docs.forEach((snapshotDocument) => {
        const record = normalizeDatabaseRecord(
          snapshotDocument.data(),
          resolvedLeagueId
        );

        if (record?.source === 'commissioner') {
          nextRecords.set(record.playerId, record);
        }
      });

      manualDatabaseRecordsSignal.set(nextRecords);
      manualDatabaseRecordsLoaded = true;
    },
    (error) => {
      console.error(
        'Unable to listen for player availability records.',
        error
      );

      stopDatabaseListener = null;
      activeLeagueId = '';
      activeUserId = '';
      manualDatabaseRecordsLoaded = false;
      manualDatabaseRecordsSignal.set(new Map());
    }
  );
}

export function getPlayerAvailabilityDatabaseRecord(
  playerId: number
): PlayerAvailabilityDatabaseRecord | null {
  queuePlayerAvailabilityListenerForCurrentLeague();

  return playerAvailabilityDatabaseRecords().get(playerId) ?? null;
}

export async function getPlayerAvailabilityRecordsForLeague(
  leagueId: string
): Promise<ReadonlyMap<number, PlayerAvailabilityDatabaseRecord>> {
  const normalizedLeagueId = leagueId.trim();

  if (!normalizedLeagueId) {
    return new Map();
  }

  const globalRecords = await getGlobalPlayerAvailabilityRecords();

  if (
    activeLeagueId === normalizedLeagueId &&
    activeUserId === (auth.currentUser?.uid ?? '') &&
    manualDatabaseRecordsLoaded
  ) {
    const records = new Map(globalRecords);

    for (const [playerId, record] of manualDatabaseRecordsSignal()) {
      records.set(playerId, record);
    }

    return records;
  }

  const manualSnapshot = await getDocs(
    query(
      collection(
        db,
        'leagues',
        normalizedLeagueId,
        'playerAvailability'
      ),
      where('source', '==', 'commissioner')
    )
  );

  const records = new Map(globalRecords);

  manualSnapshot.docs.forEach((snapshotDocument) => {
    const record = normalizeDatabaseRecord(
      snapshotDocument.data(),
      normalizedLeagueId
    );

    if (record?.source === 'commissioner') {
      records.set(record.playerId, record);
    }
  });

  return records;
}

export function isPlayerAvailabilityManualRecord(
  record: PlayerAvailabilityDatabaseRecord | null
): boolean {
  return record?.source === 'commissioner';
}

export function isPlayerAvailabilitySyncedRecord(
  record: PlayerAvailabilityDatabaseRecord | null
): boolean {
  return record?.source === 'espn';
}

export function getPlayerAvailabilityForPlayer(
  player: NHLPlayer
): PlayerAvailability {
  queuePlayerAvailabilityListenerForCurrentLeague();

  const databaseRecord = playerAvailabilityDatabaseRecords().get(player.id);

  if (databaseRecord) {
    return {
      playerId: player.id,
      playerName: player.fullName,
      status: databaseRecord.status,
      label: getPlayerAvailabilityStatusLabel(databaseRecord.status),
      shortLabel: getPlayerAvailabilityStatusShortLabel(databaseRecord.status),
      irEligible: databaseRecord.irEligible,
      note: databaseRecord.note,
      updatedAt: databaseRecord.updatedAt,
      source: 'firestore',
      externalReturnDate: databaseRecord.externalReturnDate,
      externalInjuryDate: databaseRecord.externalInjuryDate,
      externalStatus: databaseRecord.externalStatus,
      syncedAt: databaseRecord.syncedAt
    };
  }

  const override =
    OVERRIDES_BY_PLAYER_ID.get(player.id) ??
    OVERRIDES_BY_PLAYER_NAME.get(normalizePlayerName(player.fullName));

  const status = override?.status ?? 'active';

  return {
    playerId: player.id,
    playerName: player.fullName,
    status,
    label: getPlayerAvailabilityStatusLabel(status),
    shortLabel: getPlayerAvailabilityStatusShortLabel(status),
    irEligible: isPlayerIrEligible(status),
    note: override?.note ?? '',
    updatedAt:
      override?.updatedAt ??
      PLAYER_AVAILABILITY_OVERRIDES_LAST_REVIEWED,
    source: override
      ? 'manual-override'
      : 'default'
  };
}

export async function savePlayerAvailabilityRecord(input: {
  leagueId: string;
  player: NHLPlayer;
  status: PlayerAvailabilityStatus;
  note: string;
}): Promise<void> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to update player availability.');
  }

  const leagueId = input.leagueId.trim();
  const playerName = input.player.fullName.trim();
  const note = input.note.trim();

  if (!leagueId) {
    throw new Error('A league is required to update player availability.');
  }

  if (!VALID_STATUSES.has(input.status)) {
    throw new Error('Choose a valid player availability status.');
  }

  if (!playerName) {
    throw new Error('The selected player is missing a name.');
  }

  if (note.length > 500) {
    throw new Error('Availability notes must be 500 characters or fewer.');
  }

  const recordReference = doc(
    db,
    'leagues',
    leagueId,
    'playerAvailability',
    String(input.player.id)
  );

  await setDoc(recordReference, {
    playerId: input.player.id,
    playerName,
    status: input.status,
    note,
    irEligible: isPlayerIrEligible(input.status),
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    source: 'commissioner',
    leagueId
  });

  const nextRecords = new Map(manualDatabaseRecordsSignal());

  nextRecords.set(input.player.id, {
    playerId: input.player.id,
    playerName,
    status: input.status,
    note,
    irEligible: isPlayerIrEligible(input.status),
    updatedAt: new Date().toISOString(),
    updatedBy: user.uid,
    source: 'commissioner',
    leagueId
  });

  manualDatabaseRecordsSignal.set(nextRecords);
  startPlayerAvailabilityListenerForLeague(leagueId);
}

export async function deletePlayerAvailabilityRecord(input: {
  leagueId: string;
  playerId: number;
}): Promise<void> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to clear player availability.');
  }

  const leagueId = input.leagueId.trim();

  if (!leagueId) {
    throw new Error('A league is required to clear player availability.');
  }

  await deleteDoc(
    doc(
      db,
      'leagues',
      leagueId,
      'playerAvailability',
      String(input.playerId)
    )
  );

  const nextRecords = new Map(manualDatabaseRecordsSignal());
  nextRecords.delete(input.playerId);
  manualDatabaseRecordsSignal.set(nextRecords);
}

export function shouldDisplayPlayerAvailability(
  availability: PlayerAvailability
): boolean {
  return (
    availability.source !== 'default' ||
    availability.status !== 'active'
  );
}

export function getPlayerIrIneligibleReason(
  availability: PlayerAvailability
): string {
  switch (availability.status) {
    case 'active':
      return 'Player is currently listed as Active.';

    case 'day-to-day':
      return 'Day-to-Day players are not IR eligible.';

    case 'suspended':
      return 'Suspended players are not IR eligible.';

    case 'personal-leave':
      return 'Players on personal leave are not IR eligible.';

    case 'unknown':
      return 'This player does not have a verified IR-eligible status.';

    case 'out':
    case 'injured-reserve':
    case 'long-term-injured-reserve':
      return '';

    default:
      return 'This player is not IR eligible.';
  }
}
