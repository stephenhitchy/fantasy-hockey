import type { NhlScoreGame } from '../../../core/nhl/nhl-api.service';

const LIVE_GAME_STATES = new Set(['LIVE', 'CRIT']);
const FINAL_GAME_STATES = new Set(['OFF', 'FINAL']);

function normalizeTeamAbbreviation(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? '';
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

  if (focusedDate === getLocalDateKey(now)) {
    return "Today's NHL Games";
  }

  const date = parseScoreboardDate(focusedDate);

  if (!date) {
    return 'NHL Scoreboard';
  }

  const formatted = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date);

  return `Next NHL Games · ${formatted}`;
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
