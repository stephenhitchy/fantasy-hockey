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


export type PlayerAvailabilitySyncTrigger =
  | 'daily-visit'
  | 'draft-start'
  | 'commissioner-browser'
  | 'scheduled-server';


export type PlayerAvailabilityMatchIssueCategory =
  | 'name-not-found'
  | 'ambiguous-name'
  | 'alias-target-missing'
  | 'team-discrepancy'
  | 'position-discrepancy';

export type PlayerAvailabilityMatchIssueResolution =
  | 'unresolved'
  | 'matched-with-advisory';

export interface PlayerAvailabilityMatchCandidateSuggestion {
  playerName: string;
  teamAbbreviation: string;
  position: 'LW' | 'C' | 'RW' | 'D';
  reason: string;
}

export interface PlayerAvailabilityMatchIssue {
  sourcePlayerName: string;
  sourceTeamName: string;
  sourceTeamAbbreviation: string;
  sourcePosition: string;
  sourceStatus: string;
  category: PlayerAvailabilityMatchIssueCategory;
  resolution: PlayerAvailabilityMatchIssueResolution;
  candidateSuggestions: PlayerAvailabilityMatchCandidateSuggestion[];
}

export interface PlayerAvailabilityMatchQuality {
  schemaVersion: 1;
  generatedAt: string;
  sourceEntryCount: number;
  matchedSkaterCount: number;
  unresolvedSkaterCount: number;
  matchedWithAdvisoryCount: number;
  aliasResolvedCount: number;
  skippedGoalieCount: number;
  counts: {
    nameNotFound: number;
    ambiguousName: number;
    aliasTargetMissing: number;
    teamDiscrepancy: number;
    positionDiscrepancy: number;
  };
  issues: PlayerAvailabilityMatchIssue[];
}

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

  /** Optional external timing details used by cycle projections. */
  externalReturnDate?: string;
  externalInjuryDate?: string;
  externalStatus?: string;
  syncedAt?: string;
}

export interface PlayerAvailabilitySyncState {
  source: 'ESPN';
  status: 'running' | 'success' | 'error';
  lastAttemptAt: string;
  lastSuccessfulSyncAt: string;

  /** Lease deadline for an in-progress refresh. Used to recover stale jobs. */
  leaseExpiresAt?: string;

  updatedBy: string;
  fetchedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  syncedRecordCount: number;
  clearedRecordCount: number;
  preservedManualOverrideCount: number;
  skippedGoalieCount: number;
  matchQuality?: PlayerAvailabilityMatchQuality;
  message: string;

  /** Identifies what requested the most recent shared refresh. */
  trigger?: PlayerAvailabilitySyncTrigger;

  /** UTC calendar day currently being processed by the backend daily refresh. */
  dailyKey?: string;

  /** Most recent UTC calendar day successfully completed by the backend. */
  lastDailySyncKey?: string;

  /** ISO timestamp for the most recent successful backend daily refresh. */
  lastDailySuccessfulSyncAt?: string;
}

export type DailyPlayerAvailabilityRefreshStatus =
  | 'success'
  | 'already-current'
  | 'in-progress'
  | 'cooldown';

export interface DailyPlayerAvailabilityRefreshResult {
  status: DailyPlayerAvailabilityRefreshStatus;
  skipped: boolean;
  dailyKey: string;
  message: string;
  completedAt: string;
  fetchedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  syncedRecordCount: number;
  clearedRecordCount: number;
  preservedManualOverrideCount: number;
  skippedGoalieCount: number;
  matchQuality?: PlayerAvailabilityMatchQuality;
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
  matchQuality?: PlayerAvailabilityMatchQuality;
  unmatchedPlayerNames: string[];
  completedAt: string;
  message: string;
}
