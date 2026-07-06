const NHL_API_BASE_URL = '/v1';

export interface NhlPlayerGameLogEntry {
  gameId: number;
  teamAbbrev: string;
  homeRoadFlag: 'H' | 'R';
  gameDate: string;
  goals: number;
  assists: number;
  points: number;
  plusMinus: number;
  powerPlayPoints: number;
  gameWinningGoals: number;
  otGoals: number;
  shots: number;
  shorthandedPoints: number;
  toi: string;
  opponentAbbrev: string;
}

export interface NhlPlayerGameLogResponse {
  gameLog?: NhlPlayerGameLogEntry[];
}

export interface NhlSkaterBoxscoreLine {
  playerId: number;
  name: {
    default: string;
  };
  position: string;
  goals: number;
  assists: number;
  points: number;
  plusMinus: number;
  hits: number;
  powerPlayGoals: number;
  sog: number;
  toi: string;
  blockedShots: number;
}

export interface NhlPlayByPlayEvent {
  typeDescKey?: string;
  details?: {
    scoringPlayerId?: number;
    assist1PlayerId?: number;
    assist2PlayerId?: number;
  };
}

export interface NhlGamePlayByPlayResponse {
  plays?: NhlPlayByPlayEvent[];
}

export interface NhlAssistBreakdown {
  primaryAssists: number;
  secondaryAssists: number;
}

export function getSkaterAssistBreakdown(
  playByPlay: NhlGamePlayByPlayResponse,
  playerId: number
): NhlAssistBreakdown {
  let primaryAssists = 0;
  let secondaryAssists = 0;

  for (const play of playByPlay.plays ?? []) {
    if (play.typeDescKey !== 'goal') {
      continue;
    }

    if (play.details?.assist1PlayerId === playerId) {
      primaryAssists += 1;
    }

    if (play.details?.assist2PlayerId === playerId) {
      secondaryAssists += 1;
    }
  }

  return {
    primaryAssists,
    secondaryAssists
  };
}

export async function getGamePlayByPlay(
  gameId: number
): Promise<NhlGamePlayByPlayResponse> {
  const response = await fetch(
    `${NHL_API_BASE_URL}/gamecenter/${gameId}/play-by-play`
  );

  if (!response.ok) {
    throw new Error(
      `NHL play-by-play request failed: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<NhlGamePlayByPlayResponse>;
}

interface NhlTeamBoxscore {
  forwards?: NhlSkaterBoxscoreLine[];
  defense?: NhlSkaterBoxscoreLine[];
}

export interface NhlGameBoxscoreResponse {
  playerByGameStats?: {
    homeTeam?: NhlTeamBoxscore;
    awayTeam?: NhlTeamBoxscore;
  };
}

export async function getRegularSeasonGameLog(
  playerId: number,
  season: string
): Promise<NhlPlayerGameLogResponse> {
  const response = await fetch(
    `${NHL_API_BASE_URL}/player/${playerId}/game-log/${season}/2`
  );

  if (!response.ok) {
    throw new Error(
      `NHL API request failed: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<NhlPlayerGameLogResponse>;
}

export async function getGameBoxscore(
  gameId: number
): Promise<NhlGameBoxscoreResponse> {
  const response = await fetch(
    `${NHL_API_BASE_URL}/gamecenter/${gameId}/boxscore`
  );

  if (!response.ok) {
    throw new Error(
      `NHL boxscore request failed: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<NhlGameBoxscoreResponse>;
}

export function findSkaterBoxscoreLine(
  boxscore: NhlGameBoxscoreResponse,
  playerId: number
): NhlSkaterBoxscoreLine | null {
  const teams = [
    boxscore.playerByGameStats?.homeTeam,
    boxscore.playerByGameStats?.awayTeam
  ];

  for (const team of teams) {
    const skaters = [
      ...(team?.forwards ?? []),
      ...(team?.defense ?? [])
    ];

    const player = skaters.find(
      (skater) => skater.playerId === playerId
    );

    if (player) {
      return player;
    }
  }

  return null;
}