export type PlayerAvailabilityStatus =
  | 'active'
  | 'day-to-day'
  | 'out'
  | 'injured-reserve'
  | 'long-term-injured-reserve'
  | 'suspended'
  | 'personal-leave'
  | 'unknown';

export type PlayerAvailabilitySource =
  | 'default'
  | 'manual-override'
  | 'firestore';

export type PlayerAvailabilityDatabaseSource =
  | 'commissioner'
  | 'espn';

export interface PlayerAvailabilityOverride {
  /** Prefer playerId whenever it is available. */
  playerId?: number;

  /** Optional fallback for older or incomplete player data. */
  playerName?: string;

  /** Additional normalized names that should match this override. */
  playerAliases?: string[];

  status: PlayerAvailabilityStatus;
  note?: string;

  /** ISO date string describing when the information was last reviewed. */
  updatedAt?: string;
}

export interface PlayerAvailabilityDatabaseRecord {
  playerId: number;
  playerName: string;
  status: PlayerAvailabilityStatus;
  note: string;
  irEligible: boolean;
  updatedAt: string;
  updatedBy: string;
  source: PlayerAvailabilityDatabaseSource;
  leagueId: string;

  /** Raw source fields are present only for automatically synced records. */
  externalSource?: 'ESPN';
  externalStatus?: string;
  externalReturnDate?: string;
  externalInjuryDate?: string;
  externalTeamName?: string;
  syncedAt?: string;
}

export interface PlayerAvailability {
  playerId: number;
  playerName: string;
  status: PlayerAvailabilityStatus;
  label: string;
  shortLabel: string;
  irEligible: boolean;
  note: string;
  updatedAt: string;
  source: PlayerAvailabilitySource;
}

export interface PlayerAvailabilitySyncState {
  source: 'ESPN';
  status: 'running' | 'success' | 'error';
  lastAttemptAt: string;
  lastSuccessfulSyncAt: string;
  updatedBy: string;
  fetchedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  syncedRecordCount: number;
  clearedRecordCount: number;
  preservedManualOverrideCount: number;
  skippedGoalieCount: number;
  message: string;
}

export interface PlayerAvailabilitySyncResult {
  skipped: boolean;
  fetchedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  syncedRecordCount: number;
  clearedRecordCount: number;
  preservedManualOverrideCount: number;
  skippedGoalieCount: number;
  unmatchedPlayerNames: string[];
  completedAt: string;
  message: string;
}
