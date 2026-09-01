export const STANDARD_LIVE_REFRESH_INTERVAL_MILLISECONDS = 10 * 60 * 1000;
export const NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS = 2 * 60 * 1000;
export const NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT = 4;
export const NEAR_GAME_REFRESH_MAX_MILLISECONDS = 60 * 60 * 1000;
export const IDLE_REFRESH_INTERVAL_MILLISECONDS = 6 * 60 * 60 * 1000;

export type LeagueAutomationRefreshCadence =
  | 'standard'
  | 'near-live-canary';

export interface LiveScoringRefreshResult {
  hasLiveGames: boolean;
  hasIncompleteFinalGames?: boolean;
  nextScheduledGameStart: string | null;
}

export function selectLeagueAutomationRefreshCadence(input: {
  queueMode: 'shadow' | 'canary' | 'primary';
  leagueId: string;
  canaryLeagueIds: readonly string[];
  internalTestLeagueIds: readonly string[];
}): LeagueAutomationRefreshCadence {
  return input.queueMode === 'canary' &&
    input.canaryLeagueIds.length > 0 &&
    input.canaryLeagueIds.length <= NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT &&
    input.canaryLeagueIds.includes(input.leagueId) &&
    input.internalTestLeagueIds.includes(input.leagueId)
    ? 'near-live-canary'
    : 'standard';
}

export function getLiveRefreshIntervalMilliseconds(
  cadence: LeagueAutomationRefreshCadence,
): number {
  return cadence === 'near-live-canary'
    ? NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS
    : STANDARD_LIVE_REFRESH_INTERVAL_MILLISECONDS;
}

export function getLiveScoringRefreshDelay(
  results: readonly LiveScoringRefreshResult[],
  transitionOccurred: boolean,
  nowMilliseconds = Date.now(),
  cadence: LeagueAutomationRefreshCadence = 'standard',
): number {
  const liveRefreshInterval = getLiveRefreshIntervalMilliseconds(cadence);

  if (
    transitionOccurred ||
    results.some((result) =>
      result.hasLiveGames || result.hasIncompleteFinalGames === true
    )
  ) {
    return liveRefreshInterval;
  }

  const nextStart = results
    .map((result) => result.nextScheduledGameStart)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((first, second) => first - second)[0];

  if (typeof nextStart === 'number') {
    const untilStart = nextStart - nowMilliseconds;

    if (untilStart <= 0) {
      return liveRefreshInterval;
    }

    return Math.max(
      liveRefreshInterval,
      Math.min(
        untilStart + 2 * 60 * 1000,
        NEAR_GAME_REFRESH_MAX_MILLISECONDS,
      ),
    );
  }

  return IDLE_REFRESH_INTERVAL_MILLISECONDS;
}
