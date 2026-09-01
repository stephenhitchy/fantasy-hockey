import { monitorFirestoreListener } from '../observability/firestore-listener-monitor';
import { Signal, signal } from '@angular/core';
import {
  doc,
  getDoc,
  getDocFromCache,
  onSnapshot,
  Unsubscribe,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { auth, db } from '../firebase';
import { functions } from '../firebase-functions';
import { NHLPlayer } from './player.models';
import {
  DailyPlayerAvailabilityRefreshResult,
  PlayerAvailabilityDatabaseRecord,
  PlayerAvailabilityMatchCandidateSuggestion,
  PlayerAvailabilityMatchIssue,
  PlayerAvailabilityMatchIssueCategory,
  PlayerAvailabilityMatchIssueResolution,
  PlayerAvailabilityMatchQuality,
  PlayerAvailabilityStatus,
  PlayerAvailabilitySyncResult,
  PlayerAvailabilitySyncState,
  PlayerAvailabilitySyncTrigger,
} from './player-availability.models';

const GLOBAL_AVAILABILITY_COLLECTION = 'appData';
const GLOBAL_AVAILABILITY_DOCUMENT = 'playerAvailability';
const GLOBAL_REFRESH_STALE_AFTER_MS = 90_000;
const GLOBAL_LISTENER_INITIAL_TIMEOUT_MS = 8_000;
const GLOBAL_LISTENER_RETRY_BASE_MS = 2_000;
const GLOBAL_LISTENER_RETRY_MAX_MS = 30_000;

const VALID_STATUSES = new Set<PlayerAvailabilityStatus>([
  'active',
  'day-to-day',
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
  'suspended',
  'personal-leave',
  'unknown',
]);

const VALID_MATCH_ISSUE_CATEGORIES = new Set<PlayerAvailabilityMatchIssueCategory>([
  'name-not-found',
  'ambiguous-name',
  'alias-target-missing',
  'team-discrepancy',
  'position-discrepancy',
]);

const VALID_MATCH_ISSUE_RESOLUTIONS = new Set<PlayerAvailabilityMatchIssueResolution>([
  'unresolved',
  'matched-with-advisory',
]);

const VALID_MATCH_POSITIONS = new Set<PlayerAvailabilityMatchCandidateSuggestion['position']>([
  'LW',
  'C',
  'RW',
  'D',
]);

interface RefreshDailyPlayerAvailabilityRequest {
  leagueId: string;
  force: boolean;
  trigger: PlayerAvailabilitySyncTrigger;
}

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

function getTimestampMilliseconds(value: unknown): number {
  const iso = toIsoDate(value);
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isPlayerIrEligibleForSync(status: PlayerAvailabilityStatus): boolean {
  return (
    status === 'out' ||
    status === 'injured-reserve' ||
    status === 'long-term-injured-reserve'
  );
}

function getGlobalAvailabilityReference() {
  return doc(db, GLOBAL_AVAILABILITY_COLLECTION, GLOBAL_AVAILABILITY_DOCUMENT);
}

function normalizeGlobalRecord(value: unknown): PlayerAvailabilityDatabaseRecord | null {
  const data = asRecord(value);
  const playerId = data['playerId'];
  const playerName = asString(data['playerName']);
  const status = asString(data['status']) as PlayerAvailabilityStatus;

  if (
    typeof playerId !== 'number' ||
    !Number.isFinite(playerId) ||
    !playerName ||
    !VALID_STATUSES.has(status)
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
    syncedAt: toIsoDate(data['syncedAt']) || undefined,
  };
}

function normalizeGlobalRecords(
  data: Record<string, unknown>,
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

function nonNegativeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function normalizeMatchCandidate(
  value: unknown,
): PlayerAvailabilityMatchCandidateSuggestion | null {
  const data = asRecord(value);
  const playerName = asString(data['playerName']);
  const teamAbbreviation = asString(data['teamAbbreviation']).toUpperCase();
  const position = asString(data['position']).toUpperCase() as
    PlayerAvailabilityMatchCandidateSuggestion['position'];

  if (!playerName || !VALID_MATCH_POSITIONS.has(position)) {
    return null;
  }

  return {
    playerName,
    teamAbbreviation,
    position,
    reason: asString(data['reason']),
  };
}

function normalizeMatchIssue(value: unknown): PlayerAvailabilityMatchIssue | null {
  const data = asRecord(value);
  const category = asString(data['category']) as PlayerAvailabilityMatchIssueCategory;
  const resolution = asString(data['resolution']) as PlayerAvailabilityMatchIssueResolution;
  const sourcePlayerName = asString(data['sourcePlayerName']);

  if (
    !sourcePlayerName ||
    !VALID_MATCH_ISSUE_CATEGORIES.has(category) ||
    !VALID_MATCH_ISSUE_RESOLUTIONS.has(resolution)
  ) {
    return null;
  }

  const candidateSuggestions: PlayerAvailabilityMatchCandidateSuggestion[] = [];

  for (const candidateValue of asArray(data['candidateSuggestions']).slice(0, 3)) {
    const candidate = normalizeMatchCandidate(candidateValue);

    if (candidate) {
      candidateSuggestions.push(candidate);
    }
  }

  return {
    sourcePlayerName,
    sourceTeamName: asString(data['sourceTeamName']),
    sourceTeamAbbreviation: asString(data['sourceTeamAbbreviation']).toUpperCase(),
    sourcePosition: asString(data['sourcePosition']).toUpperCase(),
    sourceStatus: asString(data['sourceStatus']),
    category,
    resolution,
    candidateSuggestions,
  };
}

function normalizeMatchQuality(value: unknown): PlayerAvailabilityMatchQuality | undefined {
  const data = asRecord(value);

  if (data['schemaVersion'] !== 1) {
    return undefined;
  }

  const rawCounts = asRecord(data['counts']);
  const issues: PlayerAvailabilityMatchIssue[] = [];

  for (const issueValue of asArray(data['issues']).slice(0, 60)) {
    const issue = normalizeMatchIssue(issueValue);

    if (issue) {
      issues.push(issue);
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: toIsoDate(data['generatedAt']) || asString(data['generatedAt']),
    sourceEntryCount: nonNegativeCount(data['sourceEntryCount']),
    matchedSkaterCount: nonNegativeCount(data['matchedSkaterCount']),
    unresolvedSkaterCount: nonNegativeCount(data['unresolvedSkaterCount']),
    matchedWithAdvisoryCount: nonNegativeCount(data['matchedWithAdvisoryCount']),
    aliasResolvedCount: nonNegativeCount(data['aliasResolvedCount']),
    skippedGoalieCount: nonNegativeCount(data['skippedGoalieCount']),
    counts: {
      nameNotFound: nonNegativeCount(rawCounts['nameNotFound']),
      ambiguousName: nonNegativeCount(rawCounts['ambiguousName']),
      aliasTargetMissing: nonNegativeCount(rawCounts['aliasTargetMissing']),
      teamDiscrepancy: nonNegativeCount(rawCounts['teamDiscrepancy']),
      positionDiscrepancy: nonNegativeCount(rawCounts['positionDiscrepancy']),
    },
    issues,
  };
}

function normalizeSyncState(
  data: Record<string, unknown>,
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
  const lastAttemptAtMilliseconds = getTimestampMilliseconds(data['lastAttemptAt']);
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
  const trigger = asString(data['trigger']);

  return {
    source: 'ESPN',
    status,
    lastAttemptAt: toIsoDate(data['lastAttemptAt']),
    lastSuccessfulSyncAt: toIsoDate(data['lastSuccessfulSyncAt']),
    leaseExpiresAt: leaseExpiresAt || undefined,
    updatedBy: asString(data['updatedBy']),
    fetchedCount: typeof data['fetchedCount'] === 'number' ? data['fetchedCount'] : 0,
    matchedCount: typeof data['matchedCount'] === 'number' ? data['matchedCount'] : 0,
    unmatchedCount: typeof data['unmatchedCount'] === 'number' ? data['unmatchedCount'] : 0,
    syncedRecordCount:
      typeof data['syncedRecordCount'] === 'number' ? data['syncedRecordCount'] : 0,
    clearedRecordCount:
      typeof data['clearedRecordCount'] === 'number' ? data['clearedRecordCount'] : 0,
    preservedManualOverrideCount: 0,
    skippedGoalieCount:
      typeof data['skippedGoalieCount'] === 'number' ? data['skippedGoalieCount'] : 0,
    matchQuality: normalizeMatchQuality(data['matchQuality']),
    message: staleRunningLease
      ? 'The previous injury refresh was interrupted. The last saved report remains available and the server can retry.'
      : storedMessage,
    trigger:
      trigger === 'daily-visit' ||
      trigger === 'draft-start' ||
      trigger === 'commissioner-browser' ||
      trigger === 'scheduled-server'
        ? trigger
        : undefined,
    dailyKey: asString(data['dailyKey']) || undefined,
    lastDailySyncKey: asString(data['lastDailySyncKey']) || undefined,
    lastDailySuccessfulSyncAt:
      toIsoDate(data['lastDailySuccessfulSyncAt']) || undefined,
  };
}

const globalRecordsSignal = signal<ReadonlyMap<number, PlayerAvailabilityDatabaseRecord>>(
  new Map(),
);
const globalSyncStateSignal = signal<PlayerAvailabilitySyncState | null>(null);

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
let activeGlobalRefreshPromise: Promise<PlayerAvailabilitySyncResult> | null = null;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);

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

function updateGlobalDocumentState(data: Record<string, unknown>): void {
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
    void globalListenerReadyPromise.catch(() => undefined);
  }

  const startReason = globalListenerRetryCount > 0 ? 'retry' : 'initial';

  stopGlobalListener = monitorFirestoreListener('availability:global', (listenerObserver) => onSnapshot(
    getGlobalAvailabilityReference(),
    (snapshot) => {
      listenerObserver.next(snapshot);
      globalListenerRetryCount = 0;
      clearGlobalListenerRetry();
      updateGlobalDocumentState(snapshot.exists() ? snapshot.data() : {});
      resolveGlobalListenerReady?.();
      resolveGlobalListenerReady = null;
      rejectGlobalListenerReady = null;
      globalListenerReadyPromise = null;
    },
    (error) => {
      listenerObserver.error();
      const normalizedError = error instanceof Error
        ? error
        : new Error('Unable to listen for the global player-availability report.');

      if (!globalDocumentLoaded) {
        rejectGlobalListenerReady?.(normalizedError);
      }

      resolveGlobalListenerReady = null;
      rejectGlobalListenerReady = null;
      globalListenerReadyPromise = null;
      const stopFailedListener = stopGlobalListener;
      stopGlobalListener = null;
      stopFailedListener?.();

      console.warn(
        'The shared player-availability listener disconnected and will retry.',
        error,
      );
      scheduleGlobalListenerRetry(userId);
    },
  ), { startReason });
}

export function stopGlobalPlayerAvailabilityListener(): void {
  stopGlobalListener?.();
  stopGlobalListener = null;
  clearGlobalListenerRetry();
  rejectGlobalListenerReady?.(
    new Error('The shared player-availability listener was stopped.'),
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
    // This device may not have a cached report yet.
  }

  try {
    const snapshot = await getDoc(reference);
    updateGlobalDocumentState(snapshot.exists() ? snapshot.data() : {});
    return true;
  } catch {
    return false;
  }
}

async function ensureGlobalAvailabilityLoaded(): Promise<void> {
  if (globalDocumentLoaded) {
    return;
  }

  if (!auth.currentUser) {
    throw new Error('The shared player-availability report requires a signed-in user.');
  }

  startGlobalPlayerAvailabilityListener();

  if (globalListenerReadyPromise) {
    try {
      await withTimeout(
        globalListenerReadyPromise,
        GLOBAL_LISTENER_INITIAL_TIMEOUT_MS,
        'The shared injury-report listener did not connect in time.',
      );
      return;
    } catch {
      // Fall through to a one-time read so draft startup cannot hang forever.
    }
  }

  const loaded = await loadGlobalAvailabilityOnce();

  if (!loaded) {
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
  _leagueId?: string,
): Promise<PlayerAvailabilitySyncState | null> {
  await ensureGlobalAvailabilityLoaded();
  return globalSyncStateSignal();
}

export function listenToPlayerAvailabilitySyncState(
  _leagueId: string,
  callback: (state: PlayerAvailabilitySyncState | null) => void,
): Unsubscribe {
  syncStateCallbacks.add(callback);
  startGlobalPlayerAvailabilityListener();
  callback(globalSyncStateSignal());

  return () => {
    syncStateCallbacks.delete(callback);
  };
}

async function performServerPlayerAvailabilityRefresh(input: {
  leagueId: string;
  force?: boolean;
  trigger?: PlayerAvailabilitySyncTrigger;
}): Promise<PlayerAvailabilitySyncResult> {
  if (!auth.currentUser) {
    throw new Error('You must be logged in to refresh player availability.');
  }

  const leagueId = input.leagueId.trim();

  if (!leagueId) {
    throw new Error('A league is required to refresh the shared injury report.');
  }

  const callable = httpsCallable<
    RefreshDailyPlayerAvailabilityRequest,
    DailyPlayerAvailabilityRefreshResult
  >(functions, 'refreshDailyPlayerAvailability', { timeout: 600_000 });
  const response = await callable({
    leagueId,
    force: input.force === true,
    trigger: input.trigger ?? 'daily-visit',
  });
  const result = response.data;

  // Refresh the local snapshot immediately. The realtime listener will keep it
  // current afterward, but this makes commissioner feedback feel immediate.
  await loadGlobalAvailabilityOnce();

  const matchQuality = globalSyncStateSignal()?.matchQuality;
  const unmatchedPlayerNames = matchQuality?.issues
    .filter((issue) => issue.resolution === 'unresolved')
    .map((issue) => issue.sourcePlayerName) ?? [];

  return {
    skipped: result.skipped,
    fetchedCount: result.fetchedCount,
    matchedCount: result.matchedCount,
    unmatchedCount: result.unmatchedCount,
    syncedRecordCount: result.syncedRecordCount,
    clearedRecordCount: result.clearedRecordCount,
    preservedManualOverrideCount: result.preservedManualOverrideCount,
    skippedGoalieCount: result.skippedGoalieCount,
    matchQuality,
    unmatchedPlayerNames: [...new Set(unmatchedPlayerNames)].sort((left, right) =>
      left.localeCompare(right),
    ),
    completedAt: result.completedAt,
    message: result.message,
  };
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

  activeGlobalRefreshPromise = performServerPlayerAvailabilityRefresh(input)
    .finally(() => {
      activeGlobalRefreshPromise = null;
    });

  return activeGlobalRefreshPromise;
}
