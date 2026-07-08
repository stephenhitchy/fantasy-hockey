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

      return (
        game.gameState === 'OFF' ||
        game.gameState === 'FINAL' ||
        hasFinalScores
      );
    })
    .sort((a, b) => b.gameDate.localeCompare(a.gameDate));
}

export async function getNhlTeamSeasonSchedule(
  teamAbbreviation: string,
  season: string
): Promise<NhlTeamSeasonGame[]> {
  const response = await fetch(
    `${NHL_API_BASE_URL}/club-schedule-season/${teamAbbreviation.toLowerCase()}/${season}`
  );

  if (!response.ok) {
    throw new Error(
      `NHL season schedule request failed: ${response.status} ${response.statusText}`
    );
  }

  const data =
    (await response.json()) as NhlTeamSeasonScheduleResponse;

  const games = Array.isArray(data.games) ? data.games : [];

  return games
    .filter((game) => game.gameType === 2)
    .sort((first, second) =>
      first.gameDate.localeCompare(second.gameDate)
    );
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

/* Draft player pool */

export interface NhlDraftClub {
  abbreviation: string;
  name: string;
}

export interface NhlDraftSkater {
  id: number;
  fullName: string;
  position: 'LW' | 'C' | 'RW' | 'D';
  nhlTeamAbbreviation: string;
  teamLogoUrl: string;
  headshotUrl?: string;
}

interface NhlCurrentRosterPlayer {
  id?: number;
  playerId?: number;
  firstName?: {
    default?: string;
  };
  lastName?: {
    default?: string;
  };
  fullName?: {
    default?: string;
  };
  positionCode?: string;
  currentTeamAbbrev?: string;
  headshot?: string;
}

interface NhlCurrentRosterResponse {
  forwards?: NhlCurrentRosterPlayer[];
  defensemen?: NhlCurrentRosterPlayer[];
}

const NHL_ROSTER_BATCH_SIZE = 1;
const NHL_ROSTER_DELAY_MS = 350;

export const NHL_DRAFT_CLUBS: NhlDraftClub[] = [
  { abbreviation: 'ANA', name: 'Anaheim Ducks' },
  { abbreviation: 'BOS', name: 'Boston Bruins' },
  { abbreviation: 'BUF', name: 'Buffalo Sabres' },
  { abbreviation: 'CGY', name: 'Calgary Flames' },
  { abbreviation: 'CAR', name: 'Carolina Hurricanes' },
  { abbreviation: 'CHI', name: 'Chicago Blackhawks' },
  { abbreviation: 'COL', name: 'Colorado Avalanche' },
  { abbreviation: 'CBJ', name: 'Columbus Blue Jackets' },
  { abbreviation: 'DAL', name: 'Dallas Stars' },
  { abbreviation: 'DET', name: 'Detroit Red Wings' },
  { abbreviation: 'EDM', name: 'Edmonton Oilers' },
  { abbreviation: 'FLA', name: 'Florida Panthers' },
  { abbreviation: 'LAK', name: 'Los Angeles Kings' },
  { abbreviation: 'MIN', name: 'Minnesota Wild' },
  { abbreviation: 'MTL', name: 'Montreal Canadiens' },
  { abbreviation: 'NSH', name: 'Nashville Predators' },
  { abbreviation: 'NJD', name: 'New Jersey Devils' },
  { abbreviation: 'NYI', name: 'New York Islanders' },
  { abbreviation: 'NYR', name: 'New York Rangers' },
  { abbreviation: 'OTT', name: 'Ottawa Senators' },
  { abbreviation: 'PHI', name: 'Philadelphia Flyers' },
  { abbreviation: 'PIT', name: 'Pittsburgh Penguins' },
  { abbreviation: 'SJS', name: 'San Jose Sharks' },
  { abbreviation: 'SEA', name: 'Seattle Kraken' },
  { abbreviation: 'STL', name: 'St. Louis Blues' },
  { abbreviation: 'TBL', name: 'Tampa Bay Lightning' },
  { abbreviation: 'TOR', name: 'Toronto Maple Leafs' },
  { abbreviation: 'UTA', name: 'Utah Mammoth' },
  { abbreviation: 'VAN', name: 'Vancouver Canucks' },
  { abbreviation: 'VGK', name: 'Vegas Golden Knights' },
  { abbreviation: 'WSH', name: 'Washington Capitals' },
  { abbreviation: 'WPG', name: 'Winnipeg Jets' }
];

function getDraftPosition(
  positionCode?: string
): NhlDraftSkater['position'] | null {
  switch (positionCode?.toUpperCase()) {
    case 'L':
    case 'LW':
      return 'LW';

    case 'C':
      return 'C';

    case 'R':
    case 'RW':
      return 'RW';

    case 'D':
      return 'D';

    default:
      return null;
  }
}

function getDraftTeamLogo(
  teamAbbreviation: string
): string {
  return `https://assets.nhle.com/logos/nhl/svg/${teamAbbreviation}_light.svg`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Unknown NHL roster request error.';
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getCurrentDraftRosterSeason(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const seasonStartYear = month >= 7
    ? year
    : year - 1;

  return `${seasonStartYear}${seasonStartYear + 1}`;
}

async function getDraftClubRoster(
  club: NhlDraftClub
): Promise<{
  club: NhlDraftClub;
  roster: NhlCurrentRosterResponse;
}> {
  const season = getCurrentDraftRosterSeason();

  const response = await fetch(
    `${NHL_API_BASE_URL}/roster/${club.abbreviation.toLowerCase()}/${season}`
  );

  if (!response.ok) {
    throw new Error(
      `${club.abbreviation} roster request failed with ${response.status} ${response.statusText}.`
    );
  }

  return {
    club,
    roster: (await response.json()) as NhlCurrentRosterResponse
  };
}

function addRosterSkaters(
  skaters: Map<number, NhlDraftSkater>,
  club: NhlDraftClub,
  roster: NhlCurrentRosterResponse
): void {
  const rosterPlayers = [
    ...(roster.forwards ?? []),
    ...(roster.defensemen ?? [])
  ];

  for (const player of rosterPlayers) {
    const playerId = player.id ?? player.playerId;
    const position = getDraftPosition(player.positionCode);

    if (!playerId || !position) {
      continue;
    }

    const fullName =
      [
        player.firstName?.default,
        player.lastName?.default
      ]
        .filter(Boolean)
        .join(' ') ||
      player.fullName?.default ||
      'Unknown Player';

    const teamAbbreviation =
      player.currentTeamAbbrev ?? club.abbreviation;

    skaters.set(playerId, {
      id: playerId,
      fullName,
      position,
      nhlTeamAbbreviation: teamAbbreviation,
      teamLogoUrl: getDraftTeamLogo(teamAbbreviation),
      headshotUrl: player.headshot
    });
  }
}

export async function getCurrentNhlDraftSkaters(): Promise<NhlDraftSkater[]> {
  const skaters = new Map<number, NhlDraftSkater>();
  const retryClubs: NhlDraftClub[] = [];
  const failedClubs = new Map<string, string>();

  for (
    let index = 0;
    index < NHL_DRAFT_CLUBS.length;
    index += NHL_ROSTER_BATCH_SIZE
  ) {
    const batch = NHL_DRAFT_CLUBS.slice(
      index,
      index + NHL_ROSTER_BATCH_SIZE
    );

    const results = await Promise.allSettled(
      batch.map((club) => getDraftClubRoster(club))
    );

    results.forEach((result, resultIndex) => {
      const club = batch[resultIndex];

      if (result.status === 'fulfilled') {
        addRosterSkaters(
          skaters,
          result.value.club,
          result.value.roster
        );
        return;
      }

      retryClubs.push(club);
      failedClubs.set(
        club.abbreviation,
        getErrorMessage(result.reason)
      );
    });

    if (
      index + NHL_ROSTER_BATCH_SIZE <
      NHL_DRAFT_CLUBS.length
    ) {
      await wait(NHL_ROSTER_DELAY_MS);
    }
  }

  for (const club of retryClubs) {
    await wait(NHL_ROSTER_DELAY_MS);

    try {
      const result = await getDraftClubRoster(club);

      addRosterSkaters(
        skaters,
        result.club,
        result.roster
      );

      failedClubs.delete(club.abbreviation);
    } catch (error: unknown) {
      failedClubs.set(
        club.abbreviation,
        getErrorMessage(error)
      );
    }
  }

  if (failedClubs.size > 0) {
    const clubErrors = [...failedClubs.entries()]
      .slice(0, 4)
      .map(
        ([abbreviation, message]) =>
          `${abbreviation}: ${message}`
      )
      .join(' | ');

    throw new Error(
      `Unable to load all NHL rosters. Please try again. ${clubErrors}`
    );
  }

  if (skaters.size === 0) {
    throw new Error(
      'The NHL roster service responded, but no draftable skaters were found.'
    );
  }

  return [...skaters.values()].sort((first, second) =>
    first.fullName.localeCompare(second.fullName)
  );
}

const NHL_STATS_API_BASE_URL = '/stats/rest/en';

export type NhlStatsRecord = Record<string, unknown>;

interface NhlStatsApiResponse {
  data?: NhlStatsRecord[];
}

async function getNhlStatsRestData(
  path: string,
  params: Record<string, string>
): Promise<NhlStatsRecord[]> {
  const query = new URLSearchParams(params);

  const response = await fetch(
    `${NHL_STATS_API_BASE_URL}${path}?${query.toString()}`
  );

  if (!response.ok) {
    throw new Error(
      `NHL stats request failed for ${path}: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as NhlStatsApiResponse;

  return Array.isArray(data.data) ? data.data : [];
}

export async function getSkaterSeasonSummaryStats(
  season: string
): Promise<NhlStatsRecord[]> {
  return getNhlStatsRestData('/skater/summary', {
    isAggregate: 'false',
    isGame: 'false',
    start: '0',
    limit: '-1',
    sort: 'points',
    dir: 'desc',
    cayenneExp: `seasonId=${season} and gameTypeId=2`
  });
}

export async function getSkaterSeasonRealtimeStats(
  season: string
): Promise<NhlStatsRecord[]> {
  return getNhlStatsRestData('/skater/realtime', {
    isAggregate: 'false',
    isGame: 'false',
    start: '0',
    limit: '-1',
    sort: 'hits',
    dir: 'desc',
    cayenneExp: `seasonId=${season} and gameTypeId=2`
  });
}

export async function getGoalieSeasonSummaryStats(
  season: string
): Promise<NhlStatsRecord[]> {
  return getNhlStatsRestData('/goalie/summary', {
    isAggregate: 'false',
    isGame: 'false',
    start: '0',
    limit: '-1',
    sort: 'wins',
    dir: 'desc',
    cayenneExp: `seasonId=${season} and gameTypeId=2`
  });
}

