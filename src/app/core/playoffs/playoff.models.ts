export type FantasySeasonPhase =
  | 'regular_season'
  | 'playoffs';

export type FantasyPlayoffStatus =
  | 'active'
  | 'complete';

export type FantasyPlayoffBracketType =
  | 'championship'
  | 'consolation';

export type FantasyPlayoffMatchupStatus =
  | 'scheduled'
  | 'active'
  | 'complete';

export type FantasyPlayoffSource =
  | {
      type: 'seed';
      seed: number;
    }
  | {
      type: 'winner' | 'loser';
      matchupId: string;
    };

export interface FantasyPlayoffSeed {
  seed: number;
  ownerId: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  gamesPlayed: number;
  winPercentage: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifferential: number;
}

export interface FantasyPlayoffPlacement {
  place: number;
  ownerId: string;
  seed: number;
  teamName: string;
}

export interface FantasyPlayoffMatchup {
  id: string;
  bracketType: FantasyPlayoffBracketType;
  roundNumber: number;
  roundLabel: string;
  cycleNumber: number;
  sourceA: FantasyPlayoffSource;
  sourceB: FantasyPlayoffSource;
  teamAOwnerId: string | null;
  teamBOwnerId: string | null;
  teamASeed: number | null;
  teamBSeed: number | null;
  teamAScore: number | null;
  teamBScore: number | null;
  winnerOwnerId: string | null;
  loserOwnerId: string | null;
  winnerPlace: number | null;
  loserPlace: number | null;
  status: FantasyPlayoffMatchupStatus;
  tieBrokenByHigherSeed: boolean;
  completedAt?: unknown | null;
}

export interface FantasyPlayoffs {
  id: 'current';
  formatVersion: 1;
  formatName: 'standard';
  status: FantasyPlayoffStatus;
  regularSeasonCycleCount: number;
  playoffTeamCount: number;
  playoffRoundCount: number;
  currentRoundNumber: number;
  currentCycleNumber: number;
  seeds: FantasyPlayoffSeed[];
  matchups: FantasyPlayoffMatchup[];
  placements: FantasyPlayoffPlacement[];
  championOwnerId: string | null;
  runnerUpOwnerId: string | null;
  thirdPlaceOwnerId: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  completedAt?: unknown | null;
}

export interface FantasyPlayoffRoundResult {
  matchupId: string;
  teamAScore: number;
  teamBScore: number;
  winnerOwnerId: string;
  loserOwnerId: string;
  tieBrokenByHigherSeed: boolean;
}
