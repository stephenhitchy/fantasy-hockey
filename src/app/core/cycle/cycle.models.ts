export type FantasyCycleStatus =
  | 'active'
  | 'complete';

export type FantasyMatchupStatus =
  | 'active'
  | 'complete';

export interface FantasyCycle {
  id: string;
  cycleNumber: number;
  status: FantasyCycleStatus;
  matchupIds: string[];
  startedAt?: unknown;
  completedAt?: unknown | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface FantasyMatchup {
  id: string;
  cycleNumber: number;
  teamAOwnerId: string;
  teamBOwnerId: string | null;
  teamAScore: number;
  teamBScore: number;
  winnerOwnerId: string | null;
  status: FantasyMatchupStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
}