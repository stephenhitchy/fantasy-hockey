const NHL_API_BASE_URL = '/v1';

interface CachedApiResponse {
  loadedAt: number;
  value: unknown;
}

const apiResponseCache = new Map<string, CachedApiResponse>();
const apiRequestInFlight = new Map<string, Promise<unknown>>();
const MAX_API_RESPONSE_CACHE_ENTRIES = 2500;

const NHL_SCHEDULE_CACHE_MILLISECONDS = 10 * 60 * 1000;
const NHL_GAME_DATA_CACHE_MILLISECONDS = 2 * 60 * 1000;
const NHL_PLAYER_LOG_CACHE_MILLISECONDS = 15 * 60 * 1000;
const NHL_STATS_CACHE_MILLISECONDS = 5 * 60 * 1000;

const RETRYABLE_HTTP_STATUSES = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504
]);

function waitForApiRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getRetryDelayMilliseconds(
  response: Response | null,
  attemptNumber: number
): number {
  const retryAfterSeconds = Number(
    response?.headers.get('retry-after') ?? ''
  );

  if (
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
  ) {
    return Math.min(retryAfterSeconds * 1000, 15_000);
  }

  return Math.min(
    750 * 2 ** Math.max(0, attemptNumber - 1),
    8_000
  );
}

async function requestApiJsonWithRetry<T>(
  url: string,
  errorLabel: string,
  maxAttempts: number = 3
): Promise<T> {
  let lastError: unknown = null;

  for (
    let attemptNumber = 1;
    attemptNumber <= maxAttempts;
    attemptNumber += 1
  ) {
    let response: Response | null = null;

    try {
      response = await fetch(url);
    } catch (error: unknown) {
      lastError = error;

      if (attemptNumber >= maxAttempts) {
        throw error;
      }

      await waitForApiRetry(
        getRetryDelayMilliseconds(null, attemptNumber)
      );
      continue;
    }

    if (response.ok) {
      return await response.json() as T;
    }

    const error = new Error(
      `${errorLabel}: ${response.status} ${response.statusText}`
    );

    lastError = error;

    if (
      !RETRYABLE_HTTP_STATUSES.has(response.status) ||
      attemptNumber >= maxAttempts
    ) {
      throw error;
    }

    await waitForApiRetry(
      getRetryDelayMilliseconds(response, attemptNumber)
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(errorLabel);
}

async function getCachedApiJson<T>(
  url: string,
  cacheMilliseconds: number,
  errorLabel: string,
  forceRefresh: boolean = false
): Promise<T> {
  if (forceRefresh) {
    apiResponseCache.delete(url);
  }

  const cached = apiResponseCache.get(url);

  if (
    cached &&
    Date.now() - cached.loadedAt < cacheMilliseconds
  ) {
    return cached.value as T;
  }

  const existingRequest = apiRequestInFlight.get(url);

  if (existingRequest) {
    return existingRequest as Promise<T>;
  }

  const request = requestApiJsonWithRetry<T>(
    url,
    errorLabel
  )
    .then((value) => {
      apiResponseCache.set(url, {
        loadedAt: Date.now(),
        value
      });

      if (apiResponseCache.size > MAX_API_RESPONSE_CACHE_ENTRIES) {
        const entriesByAge = [...apiResponseCache.entries()].sort(
          (first, second) => first[1].loadedAt - second[1].loadedAt
        );
        const removeCount = Math.ceil(
          MAX_API_RESPONSE_CACHE_ENTRIES * 0.2
        );

        for (const [cacheKey] of entriesByAge.slice(0, removeCount)) {
          apiResponseCache.delete(cacheKey);
        }
      }

      return value;
    })
    .finally(() => {
      apiRequestInFlight.delete(url);
    });

  apiRequestInFlight.set(url, request as Promise<unknown>);
  return request;
}

export function clearNhlProjectionApiCache(): void {
  for (const cacheKey of [...apiResponseCache.keys()]) {
    if (
      cacheKey.startsWith('/stats/') ||
      cacheKey.includes('/club-schedule-season/')
    ) {
      apiResponseCache.delete(cacheKey);
    }
  }
}

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
  startTimeUTC?: string;
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
  season: string,
  forceRefresh: boolean = false
): Promise<NhlPlayerGameLogResponse> {
  const url =
    `${NHL_API_BASE_URL}/player/${playerId}/game-log/${season}/2`;

  return getCachedApiJson<NhlPlayerGameLogResponse>(
    url,
    NHL_PLAYER_LOG_CACHE_MILLISECONDS,
    'NHL player game-log request failed',
    forceRefresh
  );
}

export async function getRegularSeasonTeamGames(
  teamAbbreviation: string,
  season: string
): Promise<NhlTeamSeasonGame[]> {
  const url =
    `${NHL_API_BASE_URL}/club-schedule-season/${teamAbbreviation.toLowerCase()}/${season}`;

  const data = await getCachedApiJson<NhlTeamSeasonScheduleResponse>(
    url,
    NHL_SCHEDULE_CACHE_MILLISECONDS,
    'NHL schedule request failed'
  );

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
  const url =
    `${NHL_API_BASE_URL}/club-schedule-season/${teamAbbreviation.toLowerCase()}/${season}`;

  const data = await getCachedApiJson<NhlTeamSeasonScheduleResponse>(
    url,
    NHL_SCHEDULE_CACHE_MILLISECONDS,
    'NHL season schedule request failed'
  );

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
  const url = `${NHL_API_BASE_URL}/gamecenter/${gameId}/boxscore`;

  return getCachedApiJson<NhlGameBoxscoreResponse>(
    url,
    NHL_GAME_DATA_CACHE_MILLISECONDS,
    'NHL boxscore request failed'
  );
}

export async function getGamePlayByPlay(
  gameId: number
): Promise<NhlGamePlayByPlayResponse> {
  const url =
    `${NHL_API_BASE_URL}/gamecenter/${gameId}/play-by-play`;

  return getCachedApiJson<NhlGamePlayByPlayResponse>(
    url,
    NHL_GAME_DATA_CACHE_MILLISECONDS,
    'NHL play-by-play request failed'
  );
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
const NHL_ROSTER_CACHE_MILLISECONDS = 6 * 60 * 60 * 1000;
const NHL_ROSTER_CACHE_KEY = 'fantasy-hockey:nhl-rosters:v1';

let cachedDraftSkaters: {
  season: string;
  loadedAt: number;
  players: NhlDraftSkater[];
} | null = null;

let draftSkaterRequestInFlight: Promise<NhlDraftSkater[]> | null = null;

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

  const url =
    `${NHL_API_BASE_URL}/roster/${club.abbreviation.toLowerCase()}/${season}`;
  const roster = await getCachedApiJson<NhlCurrentRosterResponse>(
    url,
    NHL_ROSTER_CACHE_MILLISECONDS,
    `${club.abbreviation} roster request failed`
  );

  return {
    club,
    roster
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

async function loadCurrentNhlDraftSkatersFromApi(): Promise<NhlDraftSkater[]> {
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

function isValidCachedDraftSkaters(value: unknown): value is {
  season: string;
  loadedAt: number;
  players: NhlDraftSkater[];
} {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    season?: unknown;
    loadedAt?: unknown;
    players?: unknown;
  };

  return (
    typeof candidate.season === 'string' &&
    typeof candidate.loadedAt === 'number' &&
    Array.isArray(candidate.players) &&
    candidate.players.length >= 300
  );
}

function readDraftSkatersFromBrowserCache(): typeof cachedDraftSkaters {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(NHL_ROSTER_CACHE_KEY);

    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);

    return isValidCachedDraftSkaters(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function saveDraftSkatersToBrowserCache(
  value: NonNullable<typeof cachedDraftSkaters>
): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(
      NHL_ROSTER_CACHE_KEY,
      JSON.stringify(value)
    );
  } catch {
    // Browser storage is an optimization only.
  }
}

export function clearCurrentNhlDraftSkaterCache(): void {
  cachedDraftSkaters = null;

  for (const url of apiResponseCache.keys()) {
    if (url.includes('/roster/')) {
      apiResponseCache.delete(url);
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(NHL_ROSTER_CACHE_KEY);
    } catch {
      // Browser storage is an optimization only.
    }
  }
}

export async function getCurrentNhlDraftSkaters(): Promise<NhlDraftSkater[]> {
  const season = getCurrentDraftRosterSeason();
  const now = Date.now();
  const cached = cachedDraftSkaters ?? readDraftSkatersFromBrowserCache();

  if (
    cached &&
    cached.season === season &&
    now - cached.loadedAt < NHL_ROSTER_CACHE_MILLISECONDS
  ) {
    cachedDraftSkaters = cached;
    return cached.players;
  }

  if (draftSkaterRequestInFlight) {
    return draftSkaterRequestInFlight;
  }

  draftSkaterRequestInFlight = loadCurrentNhlDraftSkatersFromApi()
    .then((players) => {
      const value = {
        season,
        loadedAt: Date.now(),
        players
      };

      cachedDraftSkaters = value;
      saveDraftSkatersToBrowserCache(value);
      return players;
    })
    .finally(() => {
      draftSkaterRequestInFlight = null;
    });

  return draftSkaterRequestInFlight;
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

  const url =
    `${NHL_STATS_API_BASE_URL}${path}?${query.toString()}`;
  const data = await getCachedApiJson<NhlStatsApiResponse>(
    url,
    NHL_STATS_CACHE_MILLISECONDS,
    `NHL stats request failed for ${path}`
  );

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


export async function getSkaterGameSummaryStats(
  season: string
): Promise<NhlStatsRecord[]> {
  return getNhlStatsRestData('/skater/summary', {
    isAggregate: 'false',
    isGame: 'true',
    start: '0',
    limit: '-1',
    sort: 'gameId',
    dir: 'desc',
    cayenneExp: `seasonId=${season} and gameTypeId=2`
  });
}

export async function getSkaterGameRealtimeStats(
  season: string
): Promise<NhlStatsRecord[]> {
  return getNhlStatsRestData('/skater/realtime', {
    isAggregate: 'false',
    isGame: 'true',
    start: '0',
    limit: '-1',
    sort: 'gameId',
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


export async function getGoalieGameSummaryStats(
  season: string
): Promise<NhlStatsRecord[]> {
  return getNhlStatsRestData('/goalie/summary', {
    isAggregate: 'false',
    isGame: 'true',
    start: '0',
    limit: '-1',
    sort: 'gameId',
    dir: 'desc',
    cayenneExp: `seasonId=${season} and gameTypeId=2`
  });
}

