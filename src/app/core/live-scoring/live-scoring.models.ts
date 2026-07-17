import { CycleScoringResult } from '../cycle/cycle-scoring.service';

export type SharedLiveScoringStatus =
  | 'idle'
  | 'refreshing'
  | 'error';

export type SharedLiveScoringRefreshReason =
  | 'startup'
  | 'scheduled'
  | 'manual'
  | 'handoff'
  | 'unknown';

export interface SharedLiveScoringControl {
  id: 'control';
  schemaVersion: 1;
  status: SharedLiveScoringStatus;
  holderUserId: string | null;
  holderClientId: string | null;
  leaseExpiresAt?: unknown | null;
  nextRefreshAt?: unknown | null;
  lastRefreshStartedAt?: unknown | null;
  lastRefreshCompletedAt?: unknown | null;
  refreshRequestedAt?: unknown | null;
  activeCycleNumbers: number[];
  lastError: string;
  lastRefreshReason: SharedLiveScoringRefreshReason;
  lastRefreshDurationMs: number;
  lastPublishedSnapshotCount: number;
  lastSkippedSnapshotWriteCount: number;
  totalSuccessfulRefreshCount: number;
  totalFailedRefreshCount: number;
  totalPublishedSnapshotCount: number;
  totalSkippedSnapshotWriteCount: number;
  updatedAt?: unknown;
}

export interface SharedCycleScoringSnapshot {
  id: string;
  schemaVersion: 1;
  leagueId: string;
  cycleNumber: number;
  season: string;
  scoringFingerprint: string;
  scoringRulesFingerprint: string;
  result: CycleScoringResult;
  workerUserId: string;
  workerClientId: string;
  refreshedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface LocalLiveScoringSessionInfo {
  leagueId: string;
  clientId: string;
  active: boolean;
  refreshInProgress: boolean;
  pausedUntilMs: number | null;
}

export interface LiveScoringSimulationCheck {
  id: string;
  label: string;
  passed: boolean;
  expected: string;
  actual: string;
}

export interface LiveScoringSimulationResult {
  passed: boolean;
  passedCount: number;
  totalCount: number;
  checks: LiveScoringSimulationCheck[];
}
