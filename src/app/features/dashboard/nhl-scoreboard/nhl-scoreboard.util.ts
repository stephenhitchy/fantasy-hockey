import type { NhlScoreGame } from '../../../core/nhl/nhl-api.service';
import type {
  DashboardNhlRosterEntry,
  DashboardNhlRosterLocation,
  DashboardNhlTeamRosterCount,
  DashboardNhlTeamRosterPresence,
} from '../../../core/league/dashboard-league-activity.models';

const LIVE_GAME_STATES = new Set(['LIVE', 'CRIT']);
const FINAL_GAME_STATES = new Set(['OFF', 'FINAL']);

function normalizeTeamAbbreviation(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? '';
}

export function combineDashboardNhlTeamRosterCounts(
  groups: readonly {
    leagueId: string;
    leagueName: string;
    ownerId: string;
    rosterCounts: readonly DashboardNhlTeamRosterCount[];
  }[],
): DashboardNhlTeamRosterPresence[] {
  const entriesByTeam = new Map<string, DashboardNhlTeamRosterPresence['entries']>();
  const locationOrder = { active: 0, bench: 1, ir: 2 } as const;

  for (const group of groups) {
    for (const team of group.rosterCounts) {
      const teamAbbreviation = normalizeTeamAbbreviation(team.teamAbbreviation);

      if (!teamAbbreviation || !Array.isArray(team.assets) || team.assets.length === 0) {
        continue;
      }

      const entries = entriesByTeam.get(teamAbbreviation) ?? [];

      for (const asset of team.assets) {
        entries.push({
          ...asset,
          leagueId: group.leagueId,
          leagueName: group.leagueName,
          ownerId: group.ownerId,
        });
      }

      entriesByTeam.set(teamAbbreviation, entries);
    }
  }

  return [...entriesByTeam.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([teamAbbreviation, entries]) => ({
      teamAbbreviation,
      count: entries.length,
      entries: [...entries].sort((first, second) =>
        first.leagueName.localeCompare(second.leagueName) ||
        locationOrder[first.rosterLocation] - locationOrder[second.rosterLocation] ||
        first.assetName.localeCompare(second.assetName),
      ),
    }));
}

export function getDashboardNhlRosterEntryRoute(
  entry: DashboardNhlRosterEntry,
): Array<string | number> {
  if (entry.matchupCycleNumber !== null && entry.matchupId) {
    return [
      '/leagues',
      entry.leagueId,
      'cycles',
      entry.matchupCycleNumber,
      'matchups',
      entry.matchupId,
    ];
  }

  return ['/leagues', entry.leagueId];
}

function parseScoreboardDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function getLocalDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isNhlScoreboardDateToday(
  focusedDate: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return Boolean(focusedDate && focusedDate === getLocalDateKey(now));
}

function getOrdinalPeriod(period: number): string {
  if (period === 1) {
    return '1st';
  }

  if (period === 2) {
    return '2nd';
  }

  if (period === 3) {
    return '3rd';
  }

  return `${period}th`;
}

function getPeriodLabel(game: NhlScoreGame): string {
  const periodType = game.periodDescriptor?.periodType?.trim().toUpperCase();

  if (periodType === 'OT') {
    return 'OT';
  }

  if (periodType === 'SO') {
    return 'SO';
  }

  const period = game.periodDescriptor?.number ?? game.period;
  return typeof period === 'number' && period > 0
    ? getOrdinalPeriod(period)
    : 'Live';
}

export function isNhlScoreGameLive(game: NhlScoreGame): boolean {
  return LIVE_GAME_STATES.has(game.gameState.trim().toUpperCase());
}

export function isNhlScoreGameFinal(game: NhlScoreGame): boolean {
  return FINAL_GAME_STATES.has(game.gameState.trim().toUpperCase());
}

export function isFavoriteTeamGame(
  game: NhlScoreGame,
  favoriteTeamAbbreviation: string | null | undefined,
): boolean {
  const favorite = normalizeTeamAbbreviation(favoriteTeamAbbreviation);

  if (!favorite) {
    return false;
  }

  return (
    normalizeTeamAbbreviation(game.awayTeam.abbrev) === favorite ||
    normalizeTeamAbbreviation(game.homeTeam.abbrev) === favorite
  );
}

export function selectDashboardNhlGames(
  games: readonly NhlScoreGame[],
  favoriteTeamAbbreviation: string | null | undefined,
  limit: number = 6,
): NhlScoreGame[] {
  const favorite = normalizeTeamAbbreviation(favoriteTeamAbbreviation);

  return [...games]
    .sort((first, second) => {
      const liveDifference = Number(isNhlScoreGameLive(second)) - Number(isNhlScoreGameLive(first));

      if (liveDifference !== 0) {
        return liveDifference;
      }

      const favoriteDifference =
        Number(isFavoriteTeamGame(second, favorite)) - Number(isFavoriteTeamGame(first, favorite));

      if (favoriteDifference !== 0) {
        return favoriteDifference;
      }

      const firstStart = Date.parse(first.startTimeUTC);
      const secondStart = Date.parse(second.startTimeUTC);

      if (Number.isFinite(firstStart) && Number.isFinite(secondStart)) {
        return firstStart - secondStart;
      }

      return first.id - second.id;
    })
    .slice(0, Math.max(0, limit));
}

export function formatNhlScoreboardHeading(
  focusedDate: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!focusedDate) {
    return 'NHL Scoreboard';
  }

  const today = getLocalDateKey(now);

  if (focusedDate === today) {
    return "Today's NHL Games";
  }

  const date = parseScoreboardDate(focusedDate);

  if (!date) {
    return 'NHL Scoreboard';
  }

  const todayDate = parseScoreboardDate(today);
  const dayDifference = todayDate
    ? Math.round((date.getTime() - todayDate.getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  if (dayDifference === -1) {
    return "Yesterday's NHL Games";
  }

  if (dayDifference === 1) {
    return "Tomorrow's NHL Games";
  }

  const formatted = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);

  return `NHL Games · ${formatted}`;
}

export function formatNhlGameDate(game: NhlScoreGame): string {
  const date = parseScoreboardDate(game.gameDate);

  if (!date) {
    return 'Date unavailable';
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export type DashboardNhlRosterGamePointTone = 'scored' | 'pending' | 'not-counting';

export interface DashboardNhlRosterGamePointDisplay {
  label: string;
  tone: DashboardNhlRosterGamePointTone;
}

export function getDashboardNhlRosterGamePointDisplay(input: {
  rosterLocation: DashboardNhlRosterLocation;
  gameId: number;
  gameState: string;
  scheduledGameIds: readonly number[];
  gameScores: Readonly<Record<string, number>>;
}): DashboardNhlRosterGamePointDisplay {
  if (input.rosterLocation === 'bench') {
    return { label: 'Not scoring in this matchup', tone: 'not-counting' };
  }

  if (input.rosterLocation === 'ir') {
    return { label: 'Not scoring in this matchup', tone: 'not-counting' };
  }

  const gameKey = String(input.gameId);
  const hasSavedScore = Object.prototype.hasOwnProperty.call(input.gameScores, gameKey);
  const savedScore = input.gameScores[gameKey];

  if (hasSavedScore && typeof savedScore === 'number' && Number.isFinite(savedScore)) {
    return {
      label: `${savedScore.toFixed(1)} fantasy points`,
      tone: 'scored',
    };
  }

  if (!input.scheduledGameIds.includes(input.gameId)) {
    return { label: 'Not counting in this matchup', tone: 'not-counting' };
  }

  const gameState = input.gameState.trim().toUpperCase();

  if (LIVE_GAME_STATES.has(gameState)) {
    return { label: 'Fantasy points syncing', tone: 'pending' };
  }

  if (FINAL_GAME_STATES.has(gameState)) {
    return { label: 'Final score still syncing', tone: 'pending' };
  }

  return { label: 'Scheduled · points pending', tone: 'pending' };
}

export function formatNhlGameStatus(
  game: NhlScoreGame,
  now: Date = new Date(),
): string {
  if (isNhlScoreGameLive(game)) {
    const periodLabel = getPeriodLabel(game);

    if (game.clock?.inIntermission) {
      return `${periodLabel} intermission`;
    }

    const timeRemaining = game.clock?.timeRemaining?.trim();
    return timeRemaining ? `${periodLabel} · ${timeRemaining}` : periodLabel;
  }

  if (isNhlScoreGameFinal(game)) {
    const lastPeriodType = game.gameOutcome?.lastPeriodType?.trim().toUpperCase();

    if (lastPeriodType === 'OT' || lastPeriodType === 'SO') {
      return `Final/${lastPeriodType}`;
    }

    return 'Final';
  }

  const start = new Date(game.startTimeUTC);

  if (!Number.isFinite(start.getTime())) {
    return 'Scheduled';
  }

  const sameLocalDay = getLocalDateKey(start) === getLocalDateKey(now);

  return new Intl.DateTimeFormat(undefined, {
    ...(sameLocalDay ? {} : { weekday: 'short' as const }),
    hour: 'numeric',
    minute: '2-digit',
  }).format(start);
}

export function getNhlScoreboardRefreshDelay(games: readonly NhlScoreGame[]): number {
  return games.some(isNhlScoreGameLive)
    ? 30_000
    : 5 * 60 * 1000;
}
