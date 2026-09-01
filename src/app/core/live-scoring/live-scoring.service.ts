import { monitorFirestoreListener } from '../observability/firestore-listener-monitor';
import {
  doc,
  getDoc,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';

import { auth, db } from '../firebase';
import { functions } from '../firebase-functions';
import { CycleScoringResult } from '../cycle/cycle-scoring.service';
import {
  LocalLiveScoringSessionInfo,
  SharedCycleScoringSnapshot,
  SharedLiveScoringControl,
} from './live-scoring.models';

const LIVE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const NEAR_GAME_REFRESH_MAX_MS = 60 * 60 * 1000;
const IDLE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RAPID_TRANSITION_REFRESH_MS = 7_500;

interface ManualLiveScoringRefreshResult {
  status: 'success';
  activeCycleNumbers: number[];
  publishedSnapshotCount: number;
  skippedSnapshotCount: number;
  cycleOneCreated: boolean;
  durationMilliseconds: number;
}

interface LiveScoringControlResetResult {
  reset: true;
  message: string;
}

export interface OpenNextCompetitionPeriodResult {
  status: 'opened' | 'season-complete';
  currentCycleNumber: number;
  nextCycleNumber: number | null;
  nextCycleId: string | null;
  phase: 'regular_season' | 'playoffs' | null;
  alreadyExisted: boolean;
}

const requestServerLiveScoringRefresh = httpsCallable<
  { leagueId: string },
  ManualLiveScoringRefreshResult
>(functions, 'requestLeagueLiveScoringRefresh', { timeout: 600_000 });

const openNextCompetitionPeriodCallable = httpsCallable<
  { leagueId: string; currentCycleNumber: number },
  OpenNextCompetitionPeriodResult
>(functions, 'openNextCompetitionPeriod', { timeout: 600_000 });

const releaseServerLiveScoringHandoff = httpsCallable<
  { leagueId: string },
  LiveScoringControlResetResult
>(functions, 'releaseLeagueLiveScoringHandoff', { timeout: 35_000 });

const clearServerLiveScoringLease = httpsCallable<
  { leagueId: string },
  LiveScoringControlResetResult
>(functions, 'clearExpiredOrErroredLiveScoringLease', { timeout: 35_000 });

function waitForAuthUser(): Promise<User | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }

  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

function getControlRef(leagueId: string) {
  return doc(db, 'leagues', leagueId, 'liveScoring', 'control');
}

function getCycleSnapshotRef(leagueId: string, cycleNumber: number) {
  return doc(db, 'leagues', leagueId, 'liveScoring', `cycle-${cycleNumber}`);
}

function toMillis(value: unknown): number | null {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toMillis' in value &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/**
 * Retained for the deterministic diagnostics simulator. Browser clients no
 * longer claim or write scoring leases; Cloud Functions own the real lease.
 */
export function canClaimLiveScoringLease(
  control: SharedLiveScoringControl | null,
  requesterClientId: string,
  nowMilliseconds: number,
): boolean {
  const nextRefreshAt = toMillis(control?.nextRefreshAt) ?? 0;
  const leaseExpiresAt = toMillis(control?.leaseExpiresAt) ?? 0;
  const otherLeaseIsActive =
    leaseExpiresAt > nowMilliseconds && control?.holderClientId !== requesterClientId;

  return nextRefreshAt <= nowMilliseconds && !otherLeaseIsActive;
}

/** Retained for deterministic diagnostics of snapshot fingerprint behavior. */
export function shouldPublishSharedScoringSnapshot(
  previousFingerprint: string | null | undefined,
  nextFingerprint: string,
): boolean {
  return previousFingerprint !== nextFingerprint;
}

function normalizeControl(
  value: Partial<SharedLiveScoringControl> | null,
): SharedLiveScoringControl | null {
  if (!value) {
    return null;
  }

  return {
    id: 'control',
    schemaVersion: 1,
    automationMode:
      typeof value.automationMode === 'string' ? value.automationMode : 'server',
    historicalReplayEnabled: value.historicalReplayEnabled === true,
    historicalReplayDate:
      typeof value.historicalReplayDate === 'string' ? value.historicalReplayDate : null,
    status:
      value.status === 'refreshing' ? 'refreshing' : value.status === 'error' ? 'error' : 'idle',
    holderUserId: typeof value.holderUserId === 'string' ? value.holderUserId : null,
    holderClientId: typeof value.holderClientId === 'string' ? value.holderClientId : null,
    leaseExpiresAt: value.leaseExpiresAt ?? null,
    nextRefreshAt: value.nextRefreshAt ?? null,
    lastRefreshStartedAt: value.lastRefreshStartedAt ?? null,
    lastRefreshCompletedAt: value.lastRefreshCompletedAt ?? null,
    refreshRequestedAt: value.refreshRequestedAt ?? null,
    activeCycleNumbers: Array.isArray(value.activeCycleNumbers)
      ? value.activeCycleNumbers.filter(
          (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
        )
      : [],
    lastError: typeof value.lastError === 'string' ? value.lastError : '',
    lastRefreshReason:
      value.lastRefreshReason === 'startup' ||
      value.lastRefreshReason === 'scheduled' ||
      value.lastRefreshReason === 'manual' ||
      value.lastRefreshReason === 'handoff'
        ? value.lastRefreshReason
        : 'unknown',
    lastRefreshDurationMs:
      typeof value.lastRefreshDurationMs === 'number' ? value.lastRefreshDurationMs : 0,
    lastPublishedSnapshotCount:
      typeof value.lastPublishedSnapshotCount === 'number' ? value.lastPublishedSnapshotCount : 0,
    lastSkippedSnapshotWriteCount:
      typeof value.lastSkippedSnapshotWriteCount === 'number'
        ? value.lastSkippedSnapshotWriteCount
        : 0,
    totalSuccessfulRefreshCount:
      typeof value.totalSuccessfulRefreshCount === 'number' ? value.totalSuccessfulRefreshCount : 0,
    totalFailedRefreshCount:
      typeof value.totalFailedRefreshCount === 'number' ? value.totalFailedRefreshCount : 0,
    totalPublishedSnapshotCount:
      typeof value.totalPublishedSnapshotCount === 'number' ? value.totalPublishedSnapshotCount : 0,
    totalSkippedSnapshotWriteCount:
      typeof value.totalSkippedSnapshotWriteCount === 'number'
        ? value.totalSkippedSnapshotWriteCount
        : 0,
    updatedAt: value.updatedAt,
  };
}

function normalizeSnapshot(
  value: Partial<SharedCycleScoringSnapshot>,
  leagueId: string,
  cycleNumber: number,
): SharedCycleScoringSnapshot | null {
  if (!value.result || typeof value.scoringFingerprint !== 'string') {
    return null;
  }

  return {
    id: value.id ?? `cycle-${cycleNumber}`,
    schemaVersion: 1,
    leagueId: value.leagueId ?? leagueId,
    cycleNumber: value.cycleNumber ?? cycleNumber,
    season: value.season ?? '',
    scoringFingerprint: value.scoringFingerprint,
    scoringRulesFingerprint:
      typeof value.scoringRulesFingerprint === 'string' ? value.scoringRulesFingerprint : '',
    result: value.result,
    workerUserId: value.workerUserId ?? '',
    workerClientId: value.workerClientId ?? '',
    refreshedAt: value.refreshedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function getLiveScoringRefreshDelay(
  results: Array<Pick<CycleScoringResult, 'hasLiveGames' | 'nextScheduledGameStart'>>,
  rapidTransitionNeeded: boolean,
  nowMilliseconds = Date.now(),
): number {
  if (rapidTransitionNeeded) {
    return RAPID_TRANSITION_REFRESH_MS;
  }

  if (results.some((result) => result.hasLiveGames)) {
    return LIVE_REFRESH_INTERVAL_MS;
  }

  const nextStarts = results
    .map((result) => result.nextScheduledGameStart)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((first, second) => first - second);
  const nextStart = nextStarts[0];

  if (typeof nextStart === 'number') {
    const untilStart = nextStart - nowMilliseconds;

    if (untilStart <= 0) {
      return LIVE_REFRESH_INTERVAL_MS;
    }

    return Math.max(
      LIVE_REFRESH_INTERVAL_MS,
      Math.min(untilStart + 2 * 60 * 1000, NEAR_GAME_REFRESH_MAX_MS),
    );
  }

  return IDLE_REFRESH_INTERVAL_MS;
}

/**
 * Compatibility no-op. Scoring is now always scheduled and persisted by Cloud
 * Functions; opening a commissioner page never starts a browser worker.
 */
export function startLeagueLiveScoringSession(_leagueId: string): () => void {
  return () => undefined;
}

export function listenToSharedCycleScoring(
  leagueId: string,
  cycleNumber: number,
  callback: (snapshot: SharedCycleScoringSnapshot | null) => void,
  onError?: (error: Error) => void,
): () => void {
  return monitorFirestoreListener('scoring:snapshot', (listenerObserver) => onSnapshot(
    getCycleSnapshotRef(leagueId, cycleNumber),
    (snapshot) => {
      listenerObserver.next(snapshot);
      callback(
        snapshot.exists()
          ? normalizeSnapshot(
              snapshot.data() as Partial<SharedCycleScoringSnapshot>,
              leagueId,
              cycleNumber,
            )
          : null,
      );
    },
    (error) => {
      listenerObserver.error();
      const normalized =
        error instanceof Error ? error : new Error('Unable to load shared cycle scoring.');

      if (onError) {
        onError(normalized);
      } else {
        console.warn('Unable to load shared cycle scoring.', error);
      }
    },
  ));
}

export function listenToSharedLiveScoringControl(
  leagueId: string,
  callback: (control: SharedLiveScoringControl | null) => void,
  onError?: (error: Error) => void,
): () => void {
  return monitorFirestoreListener('scoring:control', (listenerObserver) => onSnapshot(
    getControlRef(leagueId),
    (snapshot) => {
      listenerObserver.next(snapshot);
      callback(
        snapshot.exists()
          ? normalizeControl(snapshot.data() as Partial<SharedLiveScoringControl>)
          : null,
      );
    },
    (error) => {
      listenerObserver.error();
      const normalized =
        error instanceof Error ? error : new Error('Unable to load shared live-scoring status.');

      onError?.(normalized);
    },
  ));
}

export function getLeagueLiveScoringSessionInfo(leagueId: string): LocalLiveScoringSessionInfo {
  return {
    leagueId,
    clientId: 'server-authoritative',
    active: false,
    refreshInProgress: false,
    pausedUntilMs: null,
  };
}

export async function releaseLeagueLiveScoringLeaseForHandoff(leagueId: string): Promise<void> {
  const user = await waitForAuthUser();

  if (!user) {
    throw new Error('You must be signed in to release the scoring lease.');
  }

  const response = await releaseServerLiveScoringHandoff({ leagueId });

  if (!response.data.reset) {
    throw new Error('The live-scoring control record was not reset.');
  }
}

export async function requestLeagueLiveScoringRefresh(leagueId: string): Promise<void> {
  const user = await waitForAuthUser();

  if (!user) {
    throw new Error('You must be signed in to refresh shared scoring.');
  }

  const response = await requestServerLiveScoringRefresh({ leagueId });

  if (response.data.status !== 'success') {
    throw new Error('The server scoring refresh did not complete successfully.');
  }
}

export async function openNextCompetitionPeriod(
  leagueId: string,
  currentCycleNumber: number,
): Promise<OpenNextCompetitionPeriodResult> {
  const user = await waitForAuthUser();

  if (!user) {
    throw new Error('You must be signed in to open the next matchup period.');
  }

  if (!Number.isInteger(currentCycleNumber) || currentCycleNumber < 1) {
    throw new Error('A valid current cycle number is required.');
  }

  const response = await openNextCompetitionPeriodCallable({
    leagueId,
    currentCycleNumber,
  });

  return response.data;
}

/** One-time commissioner/readiness read of the shared scoring control document. */
export async function getSharedLiveScoringControlOnce(
  leagueId: string,
): Promise<SharedLiveScoringControl | null> {
  const snapshot = await getDoc(getControlRef(leagueId));

  return snapshot.exists()
    ? normalizeControl(snapshot.data() as Partial<SharedLiveScoringControl>)
    : null;
}

/**
 * Safe server recovery for an expired or errored control lease. A healthy
 * active worker is never interrupted.
 */
export async function clearExpiredOrErroredLiveScoringLease(leagueId: string): Promise<void> {
  const user = await waitForAuthUser();

  if (!user) {
    throw new Error('You must be signed in to clear a scoring lease.');
  }

  const response = await clearServerLiveScoringLease({ leagueId });

  if (!response.data.reset) {
    throw new Error('The expired or errored scoring lease was not cleared.');
  }
}
