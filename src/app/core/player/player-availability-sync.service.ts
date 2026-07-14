import {
  collection,
  doc,
  DocumentData,
  DocumentReference,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Unsubscribe,
  writeBatch
} from 'firebase/firestore';

import {
  auth,
  db
} from '../firebase';

import {
  NHLPlayer
} from './player.models';

import {
  PlayerAvailabilityDatabaseRecord,
  PlayerAvailabilityStatus,
  PlayerAvailabilitySyncResult,
  PlayerAvailabilitySyncState
} from './player-availability.models';

import {
  isPlayerIrEligible
} from './player-availability.service';

const ESPN_NHL_INJURIES_URL =
  'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries';

const MAX_NOTE_LENGTH = 500;
const WRITE_BATCH_SIZE = 9;
const DEFAULT_MINIMUM_SYNC_INTERVAL_MINUTES = 30;

interface EspnInjuryEntry {
  playerName: string;
  position: string;
  teamName: string;
  rawStatus: string;
  normalizedStatus: PlayerAvailabilityStatus;
  injuryDate: string;
  returnDate: string;
  shortComment: string;
  longComment: string;
  injuryType: string;
  fantasyStatus: string;
}

interface MatchedInjury {
  player: NHLPlayer;
  injury: EspnInjuryEntry;
}

interface PendingWrite {
  type: 'set' | 'delete';
  reference: DocumentReference<DocumentData>;
  data?: DocumentData;
}

const STATUS_STRENGTH: Record<PlayerAvailabilityStatus, number> = {
  active: 0,
  unknown: 1,
  'day-to-day': 2,
  'personal-leave': 3,
  suspended: 4,
  out: 5,
  'injured-reserve': 6,
  'long-term-injured-reserve': 7
};

const ESPN_TEAM_ABBREVIATIONS: Record<string, string> = {
  'anaheimducks': 'ANA',
  'bostonbruins': 'BOS',
  'buffalosabres': 'BUF',
  'calgaryflames': 'CGY',
  'carolinahurricanes': 'CAR',
  'chicagoblackhawks': 'CHI',
  'coloradoavalanche': 'COL',
  'columbusbluejackets': 'CBJ',
  'dallasstars': 'DAL',
  'detroitredwings': 'DET',
  'edmontonoilers': 'EDM',
  'floridapanthers': 'FLA',
  'losangeleskings': 'LAK',
  'minnesotawild': 'MIN',
  'montrealcanadiens': 'MTL',
  'nashvillepredators': 'NSH',
  'newjerseydevils': 'NJD',
  'newyorkislanders': 'NYI',
  'newyorkrangers': 'NYR',
  'ottawasenators': 'OTT',
  'philadelphiaflyers': 'PHI',
  'pittsburghpenguins': 'PIT',
  'sanjosesharks': 'SJS',
  'seattlekraken': 'SEA',
  'stlouisblues': 'STL',
  'tampabaylightning': 'TBL',
  'torontomapleleafs': 'TOR',
  'utahhockeyclub': 'UTA',
  'utahmammoth': 'UTA',
  'vancouvercanucks': 'VAN',
  'vegasgoldenknights': 'VGK',
  'washingtoncapitals': 'WSH',
  'winnipegjets': 'WPG'
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function toIsoDate(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }

  return '';
}

function getEspnTeamAbbreviation(teamName: string): string {
  return ESPN_TEAM_ABBREVIATIONS[normalizeText(teamName)] ?? '';
}

function normalizeEspnStatus(input: {
  rawStatus: string;
  injuryType: string;
  fantasyStatus: string;
  shortComment: string;
  longComment: string;
}): PlayerAvailabilityStatus {
  const combined = [
    input.rawStatus,
    input.injuryType,
    input.fantasyStatus,
    input.shortComment,
    input.longComment
  ]
    .join(' ')
    .toLowerCase();

  if (/\bltir\b|\bir-lt\b|long[- ]term/.test(combined)) {
    return 'long-term-injured-reserve';
  }

  if (/injured reserve|\bon ir\b|\bir\b/.test(combined)) {
    return 'injured-reserve';
  }

  if (/suspend/.test(combined)) {
    return 'suspended';
  }

  if (/personal|leave/.test(combined)) {
    return 'personal-leave';
  }

  if (
    /day[- ]to[- ]day|questionable|doubtful|probable|game[- ]time decision/.test(
      combined
    )
  ) {
    return 'day-to-day';
  }

  if (/\bout\b|inactive|unavailable/.test(combined)) {
    return 'out';
  }

  return 'unknown';
}

function buildAvailabilityNote(injury: EspnInjuryEntry): string {
  const comment = injury.longComment || injury.shortComment;
  const pieces = [comment];

  if (injury.returnDate) {
    pieces.push(`Estimated return: ${injury.returnDate}.`);
  }

  const note = pieces.filter(Boolean).join(' ').trim();

  return note.slice(0, MAX_NOTE_LENGTH);
}

function parseEspnInjuries(payload: unknown): {
  entries: EspnInjuryEntry[];
  teamEntryCount: number;
} {
  const topLevel = asRecord(payload);
  const teamEntries = asArray(topLevel['injuries']);
  const entries: EspnInjuryEntry[] = [];

  for (const rawTeamEntry of teamEntries) {
    const teamEntry = asRecord(rawTeamEntry);
    const teamName = asString(teamEntry['displayName']);

    for (const rawInjury of asArray(teamEntry['injuries'])) {
      const injury = asRecord(rawInjury);
      const athlete = asRecord(injury['athlete']);
      const position = asRecord(athlete['position']);
      const injuryType = asRecord(injury['type']);
      const details = asRecord(injury['details']);
      const playerName = asString(athlete['displayName']);

      if (!playerName) {
        continue;
      }

      const entry: EspnInjuryEntry = {
        playerName,
        position: asString(position['abbreviation']),
        teamName,
        rawStatus: asString(injury['status']),
        injuryDate: asString(injury['date']),
        returnDate: asString(details['returnDate']),
        shortComment: asString(injury['shortComment']),
        longComment: asString(injury['longComment']),
        injuryType: asString(injuryType['name']) ||
          asString(injuryType['abbreviation']),
        fantasyStatus: asString(details['fantasyStatus']),
        normalizedStatus: 'unknown'
      };

      entry.normalizedStatus = normalizeEspnStatus(entry);
      entries.push(entry);
    }
  }

  return {
    entries,
    teamEntryCount: teamEntries.length
  };
}

function chooseStrongerInjury(
  first: EspnInjuryEntry,
  second: EspnInjuryEntry
): EspnInjuryEntry {
  const firstStrength = STATUS_STRENGTH[first.normalizedStatus];
  const secondStrength = STATUS_STRENGTH[second.normalizedStatus];

  if (secondStrength > firstStrength) {
    return second;
  }

  if (firstStrength > secondStrength) {
    return first;
  }

  const firstCommentLength = (
    first.longComment || first.shortComment
  ).length;
  const secondCommentLength = (
    second.longComment || second.shortComment
  ).length;

  return secondCommentLength > firstCommentLength
    ? second
    : first;
}

function matchInjuriesToPlayers(
  injuries: EspnInjuryEntry[],
  players: NHLPlayer[]
): {
  matches: MatchedInjury[];
  unmatchedNames: string[];
  skippedGoalieCount: number;
} {
  const playersByName = new Map<string, NHLPlayer[]>();

  for (const player of players) {
    const key = normalizeText(player.fullName);
    const candidates = playersByName.get(key) ?? [];
    candidates.push(player);
    playersByName.set(key, candidates);
  }

  const matchedByPlayerId = new Map<number, MatchedInjury>();
  const unmatchedNames = new Set<string>();
  let skippedGoalieCount = 0;

  for (const injury of injuries) {
    if (injury.position.toUpperCase() === 'G') {
      skippedGoalieCount += 1;
      continue;
    }

    const candidates = playersByName.get(
      normalizeText(injury.playerName)
    ) ?? [];

    let narrowed = candidates;

    if (narrowed.length > 1 && injury.position) {
      const samePosition = narrowed.filter(
        (candidate) => candidate.position === injury.position.toUpperCase()
      );

      if (samePosition.length > 0) {
        narrowed = samePosition;
      }
    }

    if (narrowed.length > 1 && injury.teamName) {
      const teamAbbreviation = getEspnTeamAbbreviation(injury.teamName);
      const sameTeam = narrowed.filter(
        (candidate) => candidate.nhlTeamAbbreviation === teamAbbreviation
      );

      if (sameTeam.length > 0) {
        narrowed = sameTeam;
      }
    }

    if (narrowed.length !== 1) {
      unmatchedNames.add(injury.playerName);
      continue;
    }

    const player = narrowed[0];
    const existing = matchedByPlayerId.get(player.id);

    if (!existing) {
      matchedByPlayerId.set(player.id, {
        player,
        injury
      });
      continue;
    }

    matchedByPlayerId.set(player.id, {
      player,
      injury: chooseStrongerInjury(existing.injury, injury)
    });
  }

  return {
    matches: [...matchedByPlayerId.values()],
    unmatchedNames: [...unmatchedNames].sort((first, second) =>
      first.localeCompare(second)
    ),
    skippedGoalieCount
  };
}

function normalizeExistingRecord(
  data: Record<string, unknown>,
  leagueId: string
): PlayerAvailabilityDatabaseRecord | null {
  const playerId = data['playerId'];
  const playerName = data['playerName'];
  const status = data['status'];

  if (
    typeof playerId !== 'number' ||
    typeof playerName !== 'string' ||
    typeof status !== 'string'
  ) {
    return null;
  }

  const normalizedStatus = status as PlayerAvailabilityStatus;
  const source = data['source'] === 'espn'
    ? 'espn'
    : 'commissioner';

  return {
    playerId,
    playerName,
    status: normalizedStatus,
    note: asString(data['note']),
    irEligible: isPlayerIrEligible(normalizedStatus),
    updatedAt: toIsoDate(data['updatedAt']),
    updatedBy: asString(data['updatedBy']),
    source,
    leagueId,
    externalSource: data['externalSource'] === 'ESPN'
      ? 'ESPN'
      : undefined,
    externalStatus: asString(data['externalStatus']) || undefined,
    externalReturnDate: asString(data['externalReturnDate']) || undefined,
    externalInjuryDate: asString(data['externalInjuryDate']) || undefined,
    externalTeamName: asString(data['externalTeamName']) || undefined,
    syncedAt: toIsoDate(data['syncedAt']) || undefined
  };
}

async function commitPendingWrites(
  pendingWrites: PendingWrite[]
): Promise<void> {
  for (
    let startIndex = 0;
    startIndex < pendingWrites.length;
    startIndex += WRITE_BATCH_SIZE
  ) {
    const batch = writeBatch(db);
    const chunk = pendingWrites.slice(
      startIndex,
      startIndex + WRITE_BATCH_SIZE
    );

    for (const pendingWrite of chunk) {
      if (pendingWrite.type === 'delete') {
        batch.delete(pendingWrite.reference);
      } else if (pendingWrite.data) {
        batch.set(pendingWrite.reference, pendingWrite.data);
      }
    }

    await batch.commit();
  }
}

function getSyncStateReference(leagueId: string) {
  return doc(
    db,
    'leagues',
    leagueId,
    'playerAvailabilitySync',
    'current'
  );
}

function normalizeSyncState(
  data: Record<string, unknown>
): PlayerAvailabilitySyncState | null {
  const status = data['status'];

  if (
    status !== 'running' &&
    status !== 'success' &&
    status !== 'error'
  ) {
    return null;
  }

  return {
    source: 'ESPN',
    status,
    lastAttemptAt: toIsoDate(data['lastAttemptAt']),
    lastSuccessfulSyncAt: toIsoDate(data['lastSuccessfulSyncAt']),
    updatedBy: asString(data['updatedBy']),
    fetchedCount: typeof data['fetchedCount'] === 'number'
      ? data['fetchedCount']
      : 0,
    matchedCount: typeof data['matchedCount'] === 'number'
      ? data['matchedCount']
      : 0,
    unmatchedCount: typeof data['unmatchedCount'] === 'number'
      ? data['unmatchedCount']
      : 0,
    syncedRecordCount: typeof data['syncedRecordCount'] === 'number'
      ? data['syncedRecordCount']
      : 0,
    clearedRecordCount: typeof data['clearedRecordCount'] === 'number'
      ? data['clearedRecordCount']
      : 0,
    preservedManualOverrideCount:
      typeof data['preservedManualOverrideCount'] === 'number'
        ? data['preservedManualOverrideCount']
        : 0,
    skippedGoalieCount: typeof data['skippedGoalieCount'] === 'number'
      ? data['skippedGoalieCount']
      : 0,
    message: asString(data['message'])
  };
}

export async function getPlayerAvailabilitySyncState(
  leagueId: string
): Promise<PlayerAvailabilitySyncState | null> {
  const snapshot = await getDoc(getSyncStateReference(leagueId));

  if (!snapshot.exists()) {
    return null;
  }

  return normalizeSyncState(snapshot.data());
}

export function listenToPlayerAvailabilitySyncState(
  leagueId: string,
  callback: (state: PlayerAvailabilitySyncState | null) => void
): Unsubscribe {
  return onSnapshot(
    getSyncStateReference(leagueId),
    (snapshot) => {
      callback(
        snapshot.exists()
          ? normalizeSyncState(snapshot.data())
          : null
      );
    },
    (error) => {
      console.error(
        'Unable to listen for player availability sync state.',
        error
      );
      callback(null);
    }
  );
}

function isSyncStateFresh(
  state: PlayerAvailabilitySyncState | null,
  minimumIntervalMinutes: number
): boolean {
  if (!state?.lastSuccessfulSyncAt) {
    return false;
  }

  const timestamp = new Date(state.lastSuccessfulSyncAt).getTime();

  if (Number.isNaN(timestamp)) {
    return false;
  }

  return Date.now() - timestamp < minimumIntervalMinutes * 60_000;
}

async function saveSyncRunning(
  leagueId: string,
  userId: string
): Promise<void> {
  await setDoc(
    getSyncStateReference(leagueId),
    {
      source: 'ESPN',
      status: 'running',
      lastAttemptAt: serverTimestamp(),
      updatedBy: userId,
      fetchedCount: 0,
      matchedCount: 0,
      unmatchedCount: 0,
      syncedRecordCount: 0,
      clearedRecordCount: 0,
      preservedManualOverrideCount: 0,
      skippedGoalieCount: 0,
      message: 'Refreshing ESPN injury data before the draft opens.'
    },
    { merge: true }
  );
}

async function saveSyncError(
  leagueId: string,
  userId: string,
  message: string
): Promise<void> {
  try {
    await setDoc(
      getSyncStateReference(leagueId),
      {
        source: 'ESPN',
        status: 'error',
        lastAttemptAt: serverTimestamp(),
        updatedBy: userId,
        fetchedCount: 0,
        matchedCount: 0,
        unmatchedCount: 0,
        syncedRecordCount: 0,
        clearedRecordCount: 0,
        preservedManualOverrideCount: 0,
        skippedGoalieCount: 0,
        message: message.slice(0, 500)
      },
      { merge: true }
    );
  } catch {
    // Preserve the original sync error even when metadata cannot be written.
  }
}

export async function syncPlayerAvailabilityFromEspn(input: {
  leagueId: string;
  players: NHLPlayer[];
  force?: boolean;
  minimumIntervalMinutes?: number;
}): Promise<PlayerAvailabilitySyncResult> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to sync player availability.');
  }

  const leagueId = input.leagueId.trim();
  const minimumIntervalMinutes = Math.max(
    1,
    input.minimumIntervalMinutes ?? DEFAULT_MINIMUM_SYNC_INTERVAL_MINUTES
  );

  if (!leagueId) {
    throw new Error('A league is required to sync player availability.');
  }

  if (input.players.length === 0) {
    throw new Error('Load the NHL player pool before syncing injuries.');
  }

  const previousState = await getPlayerAvailabilitySyncState(leagueId);

  if (!input.force && isSyncStateFresh(previousState, minimumIntervalMinutes)) {
    return {
      skipped: true,
      fetchedCount: previousState?.fetchedCount ?? 0,
      matchedCount: previousState?.matchedCount ?? 0,
      unmatchedCount: previousState?.unmatchedCount ?? 0,
      syncedRecordCount: previousState?.syncedRecordCount ?? 0,
      clearedRecordCount: previousState?.clearedRecordCount ?? 0,
      preservedManualOverrideCount:
        previousState?.preservedManualOverrideCount ?? 0,
      skippedGoalieCount: previousState?.skippedGoalieCount ?? 0,
      unmatchedPlayerNames: [],
      completedAt: previousState?.lastSuccessfulSyncAt ?? '',
      message: `ESPN injury data was already synced within the last ${minimumIntervalMinutes} minutes.`
    };
  }

  try {
    await saveSyncRunning(leagueId, user.uid);

    const response = await fetch(ESPN_NHL_INJURIES_URL, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(
        `ESPN injury request failed with status ${response.status}.`
      );
    }

    const payload: unknown = await response.json();
    const parsed = parseEspnInjuries(payload);

    if (parsed.entries.length === 0) {
      throw new Error(
        'ESPN returned no NHL injury entries, so existing synced records were left unchanged.'
      );
    }

    const matchResult = matchInjuriesToPlayers(
      parsed.entries,
      input.players
    );

    const availabilityCollection = collection(
      db,
      'leagues',
      leagueId,
      'playerAvailability'
    );

    const existingSnapshot = await getDocs(availabilityCollection);
    const existingRecords = new Map<number, PlayerAvailabilityDatabaseRecord>();
    const referencesByPlayerId = new Map<
      number,
      DocumentReference<DocumentData>
    >();

    existingSnapshot.docs.forEach((snapshotDocument) => {
      const record = normalizeExistingRecord(
        snapshotDocument.data(),
        leagueId
      );

      if (record) {
        existingRecords.set(record.playerId, record);
        referencesByPlayerId.set(record.playerId, snapshotDocument.ref);
      }
    });

    const matchedPlayerIds = new Set<number>();
    const pendingWrites: PendingWrite[] = [];
    let syncedRecordCount = 0;
    let preservedManualOverrideCount = 0;

    for (const match of matchResult.matches) {
      matchedPlayerIds.add(match.player.id);
      const existingRecord = existingRecords.get(match.player.id);

      if (existingRecord?.source === 'commissioner') {
        preservedManualOverrideCount += 1;
        continue;
      }

      const recordReference = doc(
        db,
        'leagues',
        leagueId,
        'playerAvailability',
        String(match.player.id)
      );

      pendingWrites.push({
        type: 'set',
        reference: recordReference,
        data: {
          playerId: match.player.id,
          playerName: match.player.fullName,
          status: match.injury.normalizedStatus,
          note: buildAvailabilityNote(match.injury),
          irEligible: isPlayerIrEligible(match.injury.normalizedStatus),
          updatedAt: serverTimestamp(),
          updatedBy: user.uid,
          source: 'espn',
          leagueId,
          externalSource: 'ESPN',
          externalStatus: match.injury.rawStatus ||
            match.injury.fantasyStatus ||
            match.injury.injuryType ||
            'Unknown',
          externalReturnDate: match.injury.returnDate,
          externalInjuryDate: match.injury.injuryDate,
          externalTeamName: match.injury.teamName,
          syncedAt: serverTimestamp()
        }
      });

      syncedRecordCount += 1;
    }

    const feedLooksCompleteEnoughToClear =
      parsed.teamEntryCount >= 10 || parsed.entries.length >= 20;

    let clearedRecordCount = 0;

    if (feedLooksCompleteEnoughToClear) {
      for (const [playerId, record] of existingRecords) {
        if (
          record.source === 'espn' &&
          !matchedPlayerIds.has(playerId)
        ) {
          const reference = referencesByPlayerId.get(playerId);

          if (reference) {
            pendingWrites.push({
              type: 'delete',
              reference
            });
            clearedRecordCount += 1;
          }
        }
      }
    }

    await commitPendingWrites(pendingWrites);

    const completedAt = new Date().toISOString();
    const unmatchedCount = matchResult.unmatchedNames.length;
    const messageParts = [
      `Matched ${matchResult.matches.length} skaters from ${parsed.entries.length} ESPN injury entries.`,
      `Saved ${syncedRecordCount} automatic records.`,
      `Preserved ${preservedManualOverrideCount} commissioner overrides.`
    ];

    if (clearedRecordCount > 0) {
      messageParts.push(
        `Cleared ${clearedRecordCount} players no longer listed by ESPN.`
      );
    }

    if (!feedLooksCompleteEnoughToClear) {
      messageParts.push(
        'The feed was sparse, so older automatic records were preserved as a safety measure.'
      );
    }

    if (unmatchedCount > 0) {
      messageParts.push(
        `${unmatchedCount} injury names could not be matched to the NHL player pool.`
      );
    }

    const message = messageParts.join(' ');

    await setDoc(
      getSyncStateReference(leagueId),
      {
        source: 'ESPN',
        status: 'success',
        lastAttemptAt: serverTimestamp(),
        lastSuccessfulSyncAt: serverTimestamp(),
        updatedBy: user.uid,
        fetchedCount: parsed.entries.length,
        matchedCount: matchResult.matches.length,
        unmatchedCount,
        syncedRecordCount,
        clearedRecordCount,
        preservedManualOverrideCount,
        skippedGoalieCount: matchResult.skippedGoalieCount,
        message: message.slice(0, 500)
      }
    );

    return {
      skipped: false,
      fetchedCount: parsed.entries.length,
      matchedCount: matchResult.matches.length,
      unmatchedCount,
      syncedRecordCount,
      clearedRecordCount,
      preservedManualOverrideCount,
      skippedGoalieCount: matchResult.skippedGoalieCount,
      unmatchedPlayerNames: matchResult.unmatchedNames,
      completedAt,
      message
    };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : 'Unable to sync NHL injury data.';

    await saveSyncError(leagueId, user.uid, message);
    throw new Error(message);
  }
}
