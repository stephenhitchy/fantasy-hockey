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

export interface NhlTeamSeasonGame {
  id: number;
  gameDate: string;
  gameType: number;
  gameState?: string;
  homeTeam: {
    abbrev: string;
    score?: number;
  };
  awayTeam: {
    abbrev: string;
    score?: number;
  };
}

export interface NhlTeamSeasonScheduleResponse {
  games?: NhlTeamSeasonGame[];
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

export interface NhlGoalieBoxscoreLine {
  playerId: number;
  name: {
    default: string;
  };
  position: 'G';
  goalsAgainst: number;
  toi: string;
  starter: boolean;
  decision?: string;
  shotsAgainst: number;
  saves: number;
  savePctg?: number;
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

export interface NhlTeamBoxscore {
  forwards?: NhlSkaterBoxscoreLine[];
  defense?: NhlSkaterBoxscoreLine[];
  goalies?: NhlGoalieBoxscoreLine[];
}

export interface NhlGameTeamSummary {
  abbrev: string;
  score: number;
}

export interface NhlGameBoxscoreResponse {
  homeTeam?: NhlGameTeamSummary;
  awayTeam?: NhlGameTeamSummary;
  playerByGameStats?: {
    homeTeam?: NhlTeamBoxscore;
    awayTeam?: NhlTeamBoxscore;
  };
}

export interface TeamGoalieAppearance {
  name: string;
  starter: boolean;
  toi: string;
  saves: number;
  shotsAgainst: number;
}

export interface TeamGoalieUnitResult {
  teamAbbreviation: string;
  opponentAbbreviation: string;
  teamScore: number;
  opponentScore: number;
  saves: number;
  shotsAgainst: number;
  won: boolean;
  shutout: boolean;
  goalies: TeamGoalieAppearance[];
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

export async function getRegularSeasonTeamGames(
  teamAbbreviation: string,
  season: string
): Promise<NhlTeamSeasonGame[]> {
  const response = await fetch(
    `${NHL_API_BASE_URL}/club-schedule-season/${teamAbbreviation.toLowerCase()}/${season}`
  );

  if (!response.ok) {
    throw new Error(
      `NHL schedule request failed: ${response.status} ${response.statusText}`
    );
  }

  const data =
    (await response.json()) as NhlTeamSeasonScheduleResponse;

  const games = Array.isArray(data.games) ? data.games : [];

  return games
    .filter((game) => game.gameType === 2)
    .filter((game) => {
      const hasFinalScores =
        typeof game.homeTeam.score === 'number' &&
        typeof game.awayTeam.score === 'number';

      return game.gameState === 'OFF' || game.gameState === 'FINAL' || hasFinalScores;
    })
    .sort((a, b) => b.gameDate.localeCompare(a.gameDate));
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

export function findGoalieBoxscoreLine(
  boxscore: NhlGameBoxscoreResponse,
  playerId: number
): NhlGoalieBoxscoreLine | null {
  const teams = [
    boxscore.playerByGameStats?.homeTeam,
    boxscore.playerByGameStats?.awayTeam
  ];

  for (const team of teams) {
    const goalie = (team?.goalies ?? []).find(
      (goalieLine) => goalieLine.playerId === playerId
    );

    if (goalie) {
      return goalie;
    }
  }

  return null;
}

export function getTeamGoalieUnitResult(
  boxscore: NhlGameBoxscoreResponse,
  teamAbbreviation: string
): TeamGoalieUnitResult | null {
  const team = teamAbbreviation.trim().toUpperCase();

  const isHomeTeam = boxscore.homeTeam?.abbrev === team;
  const isAwayTeam = boxscore.awayTeam?.abbrev === team;

  if (!isHomeTeam && !isAwayTeam) {
    return null;
  }

  const teamSummary = isHomeTeam
    ? boxscore.homeTeam
    : boxscore.awayTeam;

  const opponentSummary = isHomeTeam
    ? boxscore.awayTeam
    : boxscore.homeTeam;

  const teamStats = isHomeTeam
    ? boxscore.playerByGameStats?.homeTeam
    : boxscore.playerByGameStats?.awayTeam;

  if (!teamSummary || !opponentSummary || !teamStats) {
    return null;
  }

  const activeGoalies = (teamStats.goalies ?? []).filter((goalie) => {
    return (
      goalie.toi !== '00:00' ||
      goalie.saves > 0 ||
      goalie.shotsAgainst > 0
    );
  });

  if (activeGoalies.length === 0) {
    return null;
  }

  const saves = activeGoalies.reduce(
    (total, goalie) => total + goalie.saves,
    0
  );

  const shotsAgainst = activeGoalies.reduce(
    (total, goalie) => total + goalie.shotsAgainst,
    0
  );

  const won = teamSummary.score > opponentSummary.score;

  return {
    teamAbbreviation: teamSummary.abbrev,
    opponentAbbreviation: opponentSummary.abbrev,
    teamScore: teamSummary.score,
    opponentScore: opponentSummary.score,
    saves,
    shotsAgainst,
    won,
    shutout: won && opponentSummary.score === 0,
    goalies: activeGoalies.map((goalie) => ({
      name: goalie.name.default,
      starter: goalie.starter,
      toi: goalie.toi,
      saves: goalie.saves,
      shotsAgainst: goalie.shotsAgainst
    }))
  };
}