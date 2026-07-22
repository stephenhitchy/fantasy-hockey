import { doc, onSnapshot } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { db } from '../firebase';
import { functions } from '../firebase-functions';

export type HistoricalReplayStatus = 'inactive' | 'advancing' | 'ready' | 'error';

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

export interface AdvanceHistoricalReplayResult {
  enabled: true;
  status: 'ready';
  simulatedDate: string;
  seasonStartDate: string;
  targetSeason: string;
  sourceSeason: string;
  daysAdvanced: number;
  releasedGameCount: number;
  activeCycleNumbers: number[];
  message: string;
}

function getHistoricalReplayControlRef(leagueId: string) {
  return doc(db, 'leagues', leagueId, 'historicalReplay', 'control');
}

function normalizeControl(value: Partial<HistoricalReplayControl>): HistoricalReplayControl {
  return {
    enabled: value.enabled === true,
    status:
      value.status === 'advancing' || value.status === 'ready' || value.status === 'error'
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
  { leagueId: string },
  AdvanceHistoricalReplayResult
>(functions, 'advanceHistoricalReplayDay');

export function listenToHistoricalReplayControl(
  leagueId: string,
  callback: (control: HistoricalReplayControl | null) => void,
  onError?: (error: Error) => void,
): () => void {
  return onSnapshot(
    getHistoricalReplayControlRef(leagueId),
    (snapshot) => {
      callback(
        snapshot.exists()
          ? normalizeControl(snapshot.data() as Partial<HistoricalReplayControl>)
          : null,
      );
    },
    (error) => {
      onError?.(
        error instanceof Error
          ? error
          : new Error('Unable to load the historical replay control.'),
      );
    },
  );
}

export async function advanceHistoricalReplayDay(
  leagueId: string,
): Promise<AdvanceHistoricalReplayResult> {
  const response = await advanceReplayCallable({ leagueId });
  return response.data;
}
