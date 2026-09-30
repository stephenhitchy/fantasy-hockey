export type NhlGameRuntimeState = 'scheduled' | 'live' | 'final';

export interface NhlGameRuntimeStateSource {
  gameState?: string;
  homeTeam?: { score?: number };
  awayTeam?: { score?: number };
}

/** Normalizes the NHL provider's schedule and game-detail state values. */
export function getNhlGameRuntimeState(
  source: NhlGameRuntimeStateSource | null | undefined,
): NhlGameRuntimeState {
  const state = (source?.gameState ?? '').toUpperCase();

  if (state === 'OFF' || state === 'FINAL') {
    return 'final';
  }

  if (state === 'LIVE' || state === 'CRIT') {
    return 'live';
  }

  /*
   * Historical NHL responses sometimes omit gameState but retain final scores.
   * Do not use this fallback when an explicit live/scheduled state exists.
   */
  if (
    !state &&
    typeof source?.homeTeam?.score === 'number' &&
    typeof source?.awayTeam?.score === 'number'
  ) {
    return 'final';
  }

  return 'scheduled';
}

/**
 * A recently live boxscore is fresher than the longer-lived season-schedule
 * cache for the one-way live-to-final transition. It may promote live to
 * final, but it may never reopen a final game or start a scheduled game.
 */
export function resolveNhlGameRuntimeState(input: {
  schedule: NhlGameRuntimeStateSource;
  boxscore?: NhlGameRuntimeStateSource | null;
}): NhlGameRuntimeState {
  const scheduleState = getNhlGameRuntimeState(input.schedule);

  if (scheduleState !== 'live') {
    return scheduleState;
  }

  const boxscoreState = (input.boxscore?.gameState ?? '').toUpperCase();

  // A live boxscore already contains scores, so only its explicit terminal
  // state can promote the cached schedule. Missing state remains safely live.
  return boxscoreState === 'OFF' || boxscoreState === 'FINAL'
    ? 'final'
    : 'live';
}
