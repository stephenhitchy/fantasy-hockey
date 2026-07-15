export type FantasyCycleStatus =
  | 'active'
  | 'complete';

export type FantasyMatchupStatus =
  | 'active'
  | 'complete';

export type ProjectionAccuracyStatus =
  | 'pending'
  | 'complete';

export type FantasySeasonPhase =
  | 'regular_season'
  | 'playoffs';

export type FantasyPlayoffBracketType =
  | 'championship'
  | 'consolation';

export interface FantasyCycle {
  id: string;
  cycleNumber: number;
  status: FantasyCycleStatus;
  phase: FantasySeasonPhase;
  playoffRoundNumber?: number | null;
  playoffRoundCount?: number | null;
  playoffRoundLabel?: string | null;
  matchupIds: string[];
  projectionAccuracyStatus?: ProjectionAccuracyStatus;
  projectionAccuracyAssetCount?: number;
  projectionAccuracyProjectionVersions?: number[];
  projectionAccuracyUpdatedAt?: unknown | null;
  startedAt?: unknown;
  completedAt?: unknown | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface FantasyMatchup {
  id: string;
  cycleNumber: number;
  phase: FantasySeasonPhase;
  bracketType?: FantasyPlayoffBracketType | null;
  playoffRoundNumber?: number | null;
  playoffMatchupId?: string | null;
  teamASeed?: number | null;
  teamBSeed?: number | null;
  winnerPlace?: number | null;
  loserPlace?: number | null;
  tieBrokenByHigherSeed?: boolean;
  teamAOwnerId: string;
  teamBOwnerId: string | null;
  teamAScore: number;
  teamBScore: number;
  winnerOwnerId: string | null;
  status: FantasyMatchupStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
}