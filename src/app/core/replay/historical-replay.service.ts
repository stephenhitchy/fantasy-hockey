import { monitorFirestoreListener } from '../observability/firestore-listener-monitor';
import { doc, onSnapshot } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { db } from '../firebase';
import { functions } from '../firebase-functions';

export type HistoricalReplayStatus = 'inactive' | 'queued' | 'advancing' | 'ready' | 'error';

export interface HistoricalReplayControl {
  enabled: boolean;
  status: HistoricalReplayStatus;
  targetSeason: string;
  sourceSeason: string;
  simulatedDate: string | null;
  seasonStartDate: string | null;
  daysAdvanced: number;
  lastReleasedGameCount: number;
  totalReleasedGameCount: number;
  message: string;
  lastError: string;
  lastActiveCycleNumbers: number[];
  updatedAt?: unknown;
}

export interface QueueHistoricalReplayResult {
  enabled: true;
  status: 'queued';
  requestId: string;
  message: string;
}

function getHistoricalReplayControlRef(leagueId: string) {
  return doc(db, 'leagues', leagueId, 'historicalReplay', 'control');
}

function normalizeControl(value: Partial<HistoricalReplayControl>): HistoricalReplayControl {
  return {
    enabled: value.enabled === true,
    status:
      value.status === 'queued' ||
      value.status === 'advancing' ||
      value.status === 'ready' ||
      value.status === 'error'
        ? value.status
        : 'inactive',
    targetSeason: typeof value.targetSeason === 'string' ? value.targetSeason : '20262027',
    sourceSeason: typeof value.sourceSeason === 'string' ? value.sourceSeason : '20252026',
    simulatedDate: typeof value.simulatedDate === 'string' ? value.simulatedDate : null,
    seasonStartDate: typeof value.seasonStartDate === 'string' ? value.seasonStartDate : null,
    daysAdvanced: typeof value.daysAdvanced === 'number' ? value.daysAdvanced : 0,
    lastReleasedGameCount:
      typeof value.lastReleasedGameCount === 'number' ? value.lastReleasedGameCount : 0,
    totalReleasedGameCount:
      typeof value.totalReleasedGameCount === 'number' ? value.totalReleasedGameCount : 0,
    message: typeof value.message === 'string' ? value.message : '',
    lastError: typeof value.lastError === 'string' ? value.lastError : '',
    lastActiveCycleNumbers: Array.isArray(value.lastActiveCycleNumbers)
      ? value.lastActiveCycleNumbers.filter(
          (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
        )
      : [],
    updatedAt: value.updatedAt,
  };
}

const advanceReplayCallable = httpsCallable<
  { leagueId: string; requestId: string },
  QueueHistoricalReplayResult
>(
  functions,
  'advanceHistoricalReplayDay',
  {
    // The callable now queues the heavy replay worker and returns quickly.
    // Firestore remains the authoritative queued/advancing/ready signal.
    timeout: 60_000,
  },
);

function createHistoricalReplayRequestId(leagueId: string): string {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replaceAll('-', '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const leaguePart = leagueId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);

  return `replay_${leaguePart}_${randomPart}`.slice(0, 96);
}

export function listenToHistoricalReplayControl(
  leagueId: string,
  callback: (control: HistoricalReplayControl | null) => void,
  onError?: (error: Error) => void,
): () => void {
  return monitorFirestoreListener('replay:control', (listenerObserver) => onSnapshot(
    getHistoricalReplayControlRef(leagueId),
    (snapshot) => {
      listenerObserver.next(snapshot);
      callback(
        snapshot.exists()
          ? normalizeControl(snapshot.data() as Partial<HistoricalReplayControl>)
          : null,
      );
    },
    (error) => {
      listenerObserver.error();
      onError?.(
        error instanceof Error
          ? error
          : new Error('Unable to load the historical replay control.'),
      );
    },
  ));
}

export async function advanceHistoricalReplayDay(
  leagueId: string,
): Promise<QueueHistoricalReplayResult> {
  const response = await advanceReplayCallable({
    leagueId,
    requestId: createHistoricalReplayRequestId(leagueId),
  });
  return response.data;
}
