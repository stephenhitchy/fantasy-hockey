import {
  Signal,
  signal
} from '@angular/core';

import {
  doc,
  getDoc,
  getDocFromCache,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  Unsubscribe
} from 'firebase/firestore';

import {
  auth,
  db
} from '../firebase';

import {
  getCurrentNhlDraftSkaters
} from '../nhl/nhl-api.service';

import {
  NHLPlayer
} from './player.models';

import {
  PlayerAvailabilityDatabaseRecord,
  PlayerAvailabilityStatus,
  PlayerAvailabilitySyncResult,
  PlayerAvailabilitySyncState,
  PlayerAvailabilitySyncTrigger
} from './player-availability.models';

const ESPN_NHL_INJURIES_URL =
  'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries';

const MAX_NOTE_LENGTH = 500;
const GLOBAL_REFRESH_LEASE_MINUTES = 10;
const GLOBAL_REFRESH_ERROR_COOLDOWN_MINUTES = 15;
const GLOBAL_REFRESH_STALE_AFTER_MS = 90_000;
const GLOBAL_LISTENER_INITIAL_TIMEOUT_MS = 8_000;
const GLOBAL_LISTENER_RETRY_BASE_MS = 2_000;
const GLOBAL_LISTENER_RETRY_MAX_MS = 30_000;
const FIRESTORE_OPERATION_TIMEOUT_MS = 12_000;
const ESPN_REQUEST_TIMEOUT_MS = 15_000;
const NHL_ROSTER_REQUEST_TIMEOUT_MS = 30_000;
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


const GLOBAL_AVAILABILITY_COLLECTION = 'appData';
const GLOBAL_AVAILABILITY_DOCUMENT = 'playerAvailability';

const globalRecordsSignal = signal<
  ReadonlyMap<number, PlayerAvailabilityDatabaseRecord>
>(new Map());

const globalSyncStateSignal = signal<
  PlayerAvailabilitySyncState | null
>(null);

export const playerAvailabilityGlobalRecords: Signal<
  ReadonlyMap<number, PlayerAvailabilityDatabaseRecord>
> = globalRecordsSignal.asReadonly();

export const playerAvailabilityGlobalSyncState: Signal<
  PlayerAvailabilitySyncState | null
> = globalSyncStateSignal.asReadonly();

let stopGlobalListener: Unsubscribe | null = null;
let globalListenerUserId = '';
let globalDocumentLoaded = false;
let globalListenerReadyPromise: Promise<void> | null = null;
let resolveGlobalListenerReady: (() => void) | null = null;
let rejectGlobalListenerReady: ((error: Error) => void) | null = null;
let globalListenerRetryTimer: ReturnType<typeof setTimeout> | null = null;
let globalListenerRetryCount = 0;
const syncStateCallbacks = new Set<
  (state: PlayerAvailabilitySyncState | null) => void
>();

let activeGlobalRefreshPromise: Promise<
  PlayerAvailabilitySyncResult
> | null = null;

interface GlobalRefreshClaim {
  status: 'claimed' | 'already-current' | 'in-progress' | 'cooldown';
  data: Record<string, unknown>;
}


function withTimeout<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMilliseconds);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMilliseconds: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new Error('The ESPN injury service took too long to respond.');
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isPlayerIrEligibleForSync(
  status: PlayerAvailabilityStatus
): boolean {
  return (
    status === 'out' ||
    status === 'injured-reserve' ||
    status === 'long-term-injured-reserve'
  );
}

function getGlobalAvailabilityReference() {
  return doc(
    db,
    GLOBAL_AVAILABILITY_COLLECTION,
    GLOBAL_AVAILABILITY_DOCUMENT
  );
}

function normalizeGlobalRecord(
  value: unknown
): PlayerAvailabilityDatabaseRecord | null {
  const data = asRecord(value);
  const playerId = data['playerId'];
  const playerName = asString(data['playerName']);
  const status = asString(data['status']) as PlayerAvailabilityStatus;

  if (
    typeof playerId !== 'number' ||
    !playerName ||
    !(status in STATUS_STRENGTH)
  ) {
    return null;
  }

  return {
    playerId,
    playerName,
    status,
    note: asString(data['note']),
    irEligible: isPlayerIrEligibleForSync(status),
    updatedAt: toIsoDate(data['updatedAt']),
    updatedBy: asString(data['updatedBy']),
    source: 'espn',
    leagueId: 'global',
    externalSource: 'ESPN',
    externalStatus: asString(data['externalStatus']) || undefined,
    externalReturnDate: asString(data['externalReturnDate']) || undefined,
    externalInjuryDate: asString(data['externalInjuryDate']) || undefined,
    externalTeamName: asString(data['externalTeamName']) || undefined,
    syncedAt: toIsoDate(data['syncedAt']) || undefined
  };
}

function normalizeGlobalRecords(
  data: Record<string, unknown>
): ReadonlyMap<number, PlayerAvailabilityDatabaseRecord> {
  const records = new Map<number, PlayerAvailabilityDatabaseRecord>();

  for (const value of asArray(data['records'])) {
    const record = normalizeGlobalRecord(value);

    if (record) {
      records.set(record.playerId, record);
    }
  }

  return records;
}

function normalizeSyncState(
  data: Record<string, unknown>
): PlayerAvailabilitySyncState | null {
  const storedStatus = data['status'];

  if (
    storedStatus !== 'running' &&
    storedStatus !== 'success' &&
    storedStatus !== 'error'
  ) {
    return null;
  }

  const leaseExpiresAt = toIsoDate(data['leaseExpiresAt']);
  const leaseExpiresAtMilliseconds = Date.parse(leaseExpiresAt);
  const lastAttemptAtMilliseconds = getTimestampMilliseconds(
    data['lastAttemptAt']
  );
  const staleRunningLease =
    storedStatus === 'running' &&
    (
      (
        Number.isFinite(leaseExpiresAtMilliseconds) &&
        leaseExpiresAtMilliseconds <= Date.now()
      ) ||
      (
        lastAttemptAtMilliseconds > 0 &&
        lastAttemptAtMilliseconds + GLOBAL_REFRESH_STALE_AFTER_MS <= Date.now()
      )
    );
  const status: PlayerAvailabilitySyncState['status'] = staleRunningLease
    ? 'error'
    : storedStatus;
  const storedMessage = asString(data['message']);

  return {
    source: 'ESPN',
    status,
    lastAttemptAt: toIsoDate(data['lastAttemptAt']),
    lastSuccessfulSyncAt: toIsoDate(data['lastSuccessfulSyncAt']),
    leaseExpiresAt: leaseExpiresAt || undefined,
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
    preservedManualOverrideCount: 0,
    skippedGoalieCount: typeof data['skippedGoalieCount'] === 'number'
      ? data['skippedGoalieCount']
      : 0,
    message: staleRunningLease
      ? 'The previous injury refresh was interrupted. The last saved report remains available and the app can retry.'
      : storedMessage,
    trigger:
      data['trigger'] === 'daily-visit' ||
      data['trigger'] === 'draft-start' ||
      data['trigger'] === 'commissioner-browser'
        ? data['trigger']
        : undefined,
    dailyKey: asString(data['dailyKey']) || undefined,
    lastDailySyncKey:
      asString(data['lastDailySyncKey']) || undefined,
    lastDailySuccessfulSyncAt:
      toIsoDate(data['lastDailySuccessfulSyncAt']) || undefined
  };
}

function updateGlobalDocumentState(
  data: Record<string, unknown>
): void {
  globalRecordsSignal.set(normalizeGlobalRecords(data));
  globalSyncStateSignal.set(normalizeSyncState(data));
  globalDocumentLoaded = true;

  for (const callback of syncStateCallbacks) {
    callback(globalSyncStateSignal());
  }
}

function clearGlobalListenerRetry(): void {
  if (globalListenerRetryTimer) {
    clearTimeout(globalListenerRetryTimer);
    globalListenerRetryTimer = null;
  }
}

function scheduleGlobalListenerRetry(userId: string): void {
  if (!userId || auth.currentUser?.uid !== userId || globalListenerRetryTimer) {
    return;
  }

  const delayMilliseconds = Math.min(
    GLOBAL_LISTENER_RETRY_MAX_MS,
    GLOBAL_LISTENER_RETRY_BASE_MS * 2 ** globalListenerRetryCount,
  );

  globalListenerRetryCount += 1;
  globalListenerRetryTimer = setTimeout(() => {
    globalListenerRetryTimer = null;
    startGlobalPlayerAvailabilityListener();
  }, delayMilliseconds);
}

export function startGlobalPlayerAvailabilityListener(): void {
  const userId = auth.currentUser?.uid ?? '';

  if (!userId) {
    return;
  }

  if (stopGlobalListener && globalListenerUserId === userId) {
    return;
  }

  stopGlobalListener?.();
  stopGlobalListener = null;
  clearGlobalListenerRetry();
  globalListenerUserId = userId;

  if (!globalDocumentLoaded) {
    globalListenerReadyPromise = new Promise<void>((resolve, reject) => {
      resolveGlobalListenerReady = resolve;
      rejectGlobalListenerReady = reject;
    });

    // The same promise is also awaited by callers. This catch only prevents an
    // unhandled rejection if a listener fails before any caller begins waiting.
    void globalListenerReadyPromise.catch(() => undefined);
  }

  stopGlobalListener = onSnapshot(
    getGlobalAvailabilityReference(),
    (snapshot) => {
      globalListenerRetryCount = 0;
      clearGlobalListenerRetry();
      updateGlobalDocumentState(
        snapshot.exists()
          ? snapshot.data()
          : {}
      );

      resolveGlobalListenerReady?.();
      resolveGlobalListenerReady = null;
      rejectGlobalListenerReady = null;
      globalListenerReadyPromise = null;
    },
    (error) => {
      const normalizedError = error instanceof Error
        ? error
        : new Error(
            'Unable to listen for the global player-availability report.'
          );

      if (!globalDocumentLoaded) {
        rejectGlobalListenerReady?.(normalizedError);
      }

      resolveGlobalListenerReady = null;
      rejectGlobalListenerReady = null;
      globalListenerReadyPromise = null;
      stopGlobalListener = null;

      console.warn(
        'The shared player-availability listener disconnected and will retry.',
        error
      );

      scheduleGlobalListenerRetry(userId);
    }
  );
}

export function stopGlobalPlayerAvailabilityListener(): void {
  stopGlobalListener?.();
  stopGlobalListener = null;
  clearGlobalListenerRetry();

  rejectGlobalListenerReady?.(
    new Error('The shared player-availability listener was stopped.')
  );

  globalListenerUserId = '';
  globalListenerRetryCount = 0;
  globalDocumentLoaded = false;
  globalListenerReadyPromise = null;
  resolveGlobalListenerReady = null;
  rejectGlobalListenerReady = null;
  globalRecordsSignal.set(new Map());
  globalSyncStateSignal.set(null);
}

async function loadGlobalAvailabilityOnce(): Promise<boolean> {
  const reference = getGlobalAvailabilityReference();

  try {
    const cachedSnapshot = await getDocFromCache(reference);

    if (cachedSnapshot.exists()) {
      updateGlobalDocumentState(cachedSnapshot.data());
      return true;
    }
  } catch {
    // The report may not have been cached on this device yet.
  }

  try {
    const snapshot = await withTimeout(
      getDoc(reference),
      GLOBAL_LISTENER_INITIAL_TIMEOUT_MS,
      'The shared injury report did not respond in time.',
    );

    updateGlobalDocumentState(
      snapshot.exists()
        ? snapshot.data()
        : {},
    );
    return true;
  } catch {
    return false;
  }
}

async function ensureGlobalAvailabilityLoaded(): Promise<void> {
  startGlobalPlayerAvailabilityListener();

  if (globalDocumentLoaded) {
    return;
  }

  if (!auth.currentUser) {
    throw new Error(
      'The shared player-availability report requires a signed-in user.'
    );
  }

  if (globalListenerReadyPromise) {
    try {
      await withTimeout(
        globalListenerReadyPromise,
        GLOBAL_LISTENER_INITIAL_TIMEOUT_MS,
        'The shared injury-report listener did not connect in time.',
      );
      return;
    } catch {
      // Fall through to a one-time read. Draft startup must not wait forever
      // for a realtime listener on an unreliable mobile/Safari connection.
    }
  }

  const loaded = await loadGlobalAvailabilityOnce();

  if (!loaded) {
    // Keep the last in-memory report (or an empty report on a first visit) and
    // allow the caller to continue. The realtime listener will keep retrying.
    globalDocumentLoaded = true;
  }
}

export async function getGlobalPlayerAvailabilityRecords(): Promise<
  ReadonlyMap<number, PlayerAvailabilityDatabaseRecord>
> {
  await ensureGlobalAvailabilityLoaded();
  return globalRecordsSignal();
}

export async function getPlayerAvailabilitySyncState(
  _leagueId?: string
): Promise<PlayerAvailabilitySyncState | null> {
  await ensureGlobalAvailabilityLoaded();
  return globalSyncStateSignal();
}

export function listenToPlayerAvailabilitySyncState(
  _leagueId: string,
  callback: (state: PlayerAvailabilitySyncState | null) => void
): Unsubscribe {
  syncStateCallbacks.add(callback);
  startGlobalPlayerAvailabilityListener();
  callback(globalSyncStateSignal());

  return () => {
    syncStateCallbacks.delete(callback);
  };
}

function getUtcDailyKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function getTimestampMilliseconds(value: unknown): number {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate().getTime();
  }

  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

function resultFromState(
  state: PlayerAvailabilitySyncState | null,
  message: string
): PlayerAvailabilitySyncResult {
  return {
    skipped: true,
    fetchedCount: state?.fetchedCount ?? 0,
    matchedCount: state?.matchedCount ?? 0,
    unmatchedCount: state?.unmatchedCount ?? 0,
    syncedRecordCount: state?.syncedRecordCount ?? 0,
    clearedRecordCount: state?.clearedRecordCount ?? 0,
    preservedManualOverrideCount: 0,
    skippedGoalieCount: state?.skippedGoalieCount ?? 0,
    unmatchedPlayerNames: [],
    completedAt: state?.lastSuccessfulSyncAt ?? '',
    message
  };
}

async function claimGlobalRefresh(
  userId: string,
  refreshLeagueId: string,
  trigger: PlayerAvailabilitySyncTrigger,
  dailyKey: string
): Promise<GlobalRefreshClaim> {
  const reference = getGlobalAvailabilityReference();
  const now = Date.now();

  return withTimeout(
    runTransaction(
      db,
      async (transaction) => {
      const snapshot = await transaction.get(reference);
      const data = snapshot.exists()
        ? snapshot.data() as Record<string, unknown>
        : {};
      const state = normalizeSyncState(data);

      if (state?.lastDailySyncKey === dailyKey) {
        return {
          status: 'already-current' as const,
          data
        };
      }

      const leaseExpiresAt = getTimestampMilliseconds(
        data['leaseExpiresAt']
      );

      const lastAttemptAt = getTimestampMilliseconds(
        data['lastAttemptAt']
      );
      const runningAttemptIsFresh =
        lastAttemptAt <= 0 ||
        now - lastAttemptAt < GLOBAL_REFRESH_STALE_AFTER_MS;

      if (
        data['status'] === 'running' &&
        leaseExpiresAt > now &&
        runningAttemptIsFresh
      ) {
        return {
          status: 'in-progress' as const,
          data
        };
      }

      if (
        data['status'] === 'error' &&
        lastAttemptAt > 0 &&
        now - lastAttemptAt <
          GLOBAL_REFRESH_ERROR_COOLDOWN_MINUTES * 60_000
      ) {
        return {
          status: 'cooldown' as const,
          data
        };
      }

      transaction.set(
        reference,
        {
          source: 'ESPN',
          status: 'running',
          refreshLeagueId,
          trigger,
          dailyKey,
          lastAttemptAt: serverTimestamp(),
          leaseExpiresAt: Timestamp.fromMillis(
            now + GLOBAL_REFRESH_LEASE_MINUTES * 60_000
          ),
          updatedBy: userId,
          message: 'Refreshing the single shared NHL injury report for the app.'
        },
        { merge: true }
      );

      return {
        status: 'claimed' as const,
        data
      };
      },
      { maxAttempts: 2 }
    ),
    FIRESTORE_OPERATION_TIMEOUT_MS,
    'The injury-report lock could not be reached in time.',
  );
}

function serializeGlobalRecord(
  record: PlayerAvailabilityDatabaseRecord
): Record<string, unknown> {
  return {
    playerId: record.playerId,
    playerName: record.playerName,
    status: record.status,
    note: record.note,
    irEligible: record.irEligible,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    source: 'espn',
    externalSource: 'ESPN',
    externalStatus: record.externalStatus ?? '',
    externalReturnDate: record.externalReturnDate ?? '',
    externalInjuryDate: record.externalInjuryDate ?? '',
    externalTeamName: record.externalTeamName ?? '',
    syncedAt: record.syncedAt ?? record.updatedAt
  };
}

async function saveGlobalSyncError(
  userId: string,
  refreshLeagueId: string,
  trigger: PlayerAvailabilitySyncTrigger,
  dailyKey: string,
  message: string
): Promise<void> {
  try {
    await withTimeout(
      setDoc(
        getGlobalAvailabilityReference(),
        {
          source: 'ESPN',
          status: 'error',
        refreshLeagueId,
        trigger,
        dailyKey,
        lastAttemptAt: serverTimestamp(),
        leaseExpiresAt: null,
        updatedBy: userId,
        message: message.slice(0, 500)
        },
        { merge: true }
      ),
      FIRESTORE_OPERATION_TIMEOUT_MS,
      'The failed injury-refresh state could not be saved in time.',
    );
  } catch {
    // Preserve the original network or parsing error.
  }
}

async function performGlobalPlayerAvailabilityRefresh(input: {
  leagueId: string;
  players?: NHLPlayer[];
  force?: boolean;
  minimumIntervalMinutes?: number;
  trigger?: PlayerAvailabilitySyncTrigger;
}): Promise<PlayerAvailabilitySyncResult> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to refresh player availability.');
  }

  const refreshLeagueId = input.leagueId?.trim() ?? '';

  if (!refreshLeagueId) {
    throw new Error(
      'A commissioner league is required to refresh the shared injury report.'
    );
  }

  const trigger = input.trigger ?? 'commissioner-browser';
  const dailyKey = getUtcDailyKey();

  await ensureGlobalAvailabilityLoaded();

  const cachedState = globalSyncStateSignal();

  if (cachedState?.lastDailySyncKey === dailyKey) {
    return resultFromState(
      cachedState,
      'Today’s app-wide injury report is already current.'
    );
  }

  const claim = await claimGlobalRefresh(
    user.uid,
    refreshLeagueId,
    trigger,
    dailyKey
  );
  const existingState = normalizeSyncState(claim.data);

  if (claim.status === 'already-current') {
    return resultFromState(
      existingState,
      'Today’s app-wide injury report is already current.'
    );
  }

  if (claim.status === 'in-progress') {
    return resultFromState(
      existingState,
      'Another browser is already refreshing today’s app-wide injury report.'
    );
  }

  if (claim.status === 'cooldown') {
    return resultFromState(
      existingState,
      'The last refresh attempt failed recently, so the app is waiting before trying again.'
    );
  }

  try {
    const providedPlayers = input.players ?? [];
    const players = providedPlayers.length >= 300
      ? providedPlayers
      : await withTimeout(
          getCurrentNhlDraftSkaters(),
          NHL_ROSTER_REQUEST_TIMEOUT_MS,
          'The NHL roster service took too long to respond.',
        );

    if (players.length === 0) {
      throw new Error('The NHL roster pool was empty, so injuries were not changed.');
    }

    const response = await fetchWithTimeout(
      ESPN_NHL_INJURIES_URL,
      {
        cache: 'no-store',
        headers: {
          Accept: 'application/json'
        }
      },
      ESPN_REQUEST_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(
        `ESPN injury request failed with status ${response.status}.`
      );
    }

    const payload: unknown = await response.json();
    const parsed = parseEspnInjuries(payload);

    if (parsed.entries.length === 0) {
      throw new Error(
        'ESPN returned no NHL injury entries, so the last saved report was preserved.'
      );
    }

    const matchResult = matchInjuriesToPlayers(
      parsed.entries,
      players
    );
    const nowIso = new Date().toISOString();
    const nextRecords = new Map<number, PlayerAvailabilityDatabaseRecord>();

    for (const match of matchResult.matches) {
      nextRecords.set(match.player.id, {
        playerId: match.player.id,
        playerName: match.player.fullName,
        status: match.injury.normalizedStatus,
        note: buildAvailabilityNote(match.injury),
        irEligible: isPlayerIrEligibleForSync(
          match.injury.normalizedStatus
        ),
        updatedAt: nowIso,
        updatedBy: user.uid,
        source: 'espn',
        leagueId: 'global',
        externalSource: 'ESPN',
        externalStatus: match.injury.rawStatus ||
          match.injury.fantasyStatus ||
          match.injury.injuryType ||
          'Unknown',
        externalReturnDate: match.injury.returnDate || undefined,
        externalInjuryDate: match.injury.injuryDate || undefined,
        externalTeamName: match.injury.teamName || undefined,
        syncedAt: nowIso
      });
    }

    const previousRecords = normalizeGlobalRecords(claim.data);
    const feedLooksCompleteEnoughToClear =
      parsed.teamEntryCount >= 10 || parsed.entries.length >= 20;

    if (!feedLooksCompleteEnoughToClear) {
      for (const [playerId, record] of previousRecords) {
        if (!nextRecords.has(playerId)) {
          nextRecords.set(playerId, record);
        }
      }
    }

    const clearedRecordCount = feedLooksCompleteEnoughToClear
      ? [...previousRecords.keys()].filter(
          (playerId) => !nextRecords.has(playerId)
        ).length
      : 0;
    const unmatchedCount = matchResult.unmatchedNames.length;
    const messageParts = [
      `Matched ${matchResult.matches.length} injured skaters from ${parsed.entries.length} ESPN entries.`,
      'Saved one shared report for every league and account.'
    ];

    if (clearedRecordCount > 0) {
      messageParts.push(
        `Removed ${clearedRecordCount} players no longer listed by ESPN.`
      );
    }

    if (!feedLooksCompleteEnoughToClear) {
      messageParts.push(
        'The feed looked sparse, so older automatic records were preserved.'
      );
    }

    if (unmatchedCount > 0) {
      messageParts.push(
        `${unmatchedCount} names could not be matched to the NHL roster pool.`
      );
    }

    const message = messageParts.join(' ');

    await withTimeout(
      setDoc(
        getGlobalAvailabilityReference(),
        {
          source: 'ESPN',
          status: 'success',
        refreshLeagueId,
        trigger,
        dailyKey,
        lastDailySyncKey: dailyKey,
        lastAttemptAt: serverTimestamp(),
        lastSuccessfulSyncAt: serverTimestamp(),
        lastDailySuccessfulSyncAt: serverTimestamp(),
        leaseExpiresAt: null,
        updatedBy: user.uid,
        fetchedCount: parsed.entries.length,
        matchedCount: matchResult.matches.length,
        unmatchedCount,
        syncedRecordCount: nextRecords.size,
        clearedRecordCount,
        preservedManualOverrideCount: 0,
        skippedGoalieCount: matchResult.skippedGoalieCount,
        message: message.slice(0, 500),
        records: [...nextRecords.values()]
          .sort((first, second) => first.playerId - second.playerId)
          .map(serializeGlobalRecord)
        },
        { merge: true }
      ),
      FIRESTORE_OPERATION_TIMEOUT_MS,
      'The completed injury report could not be saved in time.',
    );

    return {
      skipped: false,
      fetchedCount: parsed.entries.length,
      matchedCount: matchResult.matches.length,
      unmatchedCount,
      syncedRecordCount: nextRecords.size,
      clearedRecordCount,
      preservedManualOverrideCount: 0,
      skippedGoalieCount: matchResult.skippedGoalieCount,
      unmatchedPlayerNames: matchResult.unmatchedNames,
      completedAt: nowIso,
      message
    };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : 'Unable to refresh NHL injury data.';

    await saveGlobalSyncError(
      user.uid,
      refreshLeagueId,
      trigger,
      dailyKey,
      message
    );
    throw new Error(message);
  }
}


export function syncPlayerAvailabilityFromEspn(input: {
  leagueId: string;
  players?: NHLPlayer[];
  force?: boolean;
  minimumIntervalMinutes?: number;
  trigger?: PlayerAvailabilitySyncTrigger;
}): Promise<PlayerAvailabilitySyncResult> {
  if (activeGlobalRefreshPromise) {
    return activeGlobalRefreshPromise;
  }

  activeGlobalRefreshPromise =
    performGlobalPlayerAvailabilityRefresh(input)
      .finally(() => {
        activeGlobalRefreshPromise = null;
      });

  return activeGlobalRefreshPromise;
}
