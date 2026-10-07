export type NhlGameRuntimeState = 'scheduled' | 'live' | 'final';

export interface NhlGameRuntimeStateSource {
  gameState?: string;
  gameScheduleState?: string;
  startTimeUTC?: string;
  homeTeam?: { score?: number };
  awayTeam?: { score?: number };
}

const EXPLICITLY_DEFERRED_GAME_STATES = new Set([
  'PPD',
  'POSTPONED',
  'CNCL',
  'CANCELLED',
  'CANCELED',
]);

export function isNhlGameExplicitlyDeferred(
  source: NhlGameRuntimeStateSource | null | undefined,
): boolean {
  const gameState = (source?.gameState ?? '').trim().toUpperCase();
  const scheduleState = (source?.gameScheduleState ?? '')
    .trim()
    .toUpperCase();

  return EXPLICITLY_DEFERRED_GAME_STATES.has(gameState) ||
    EXPLICITLY_DEFERRED_GAME_STATES.has(scheduleState);
}

/**
 * A stale FUT response must not imply that puck drop has not happened. This
 * boundary is deliberately separate from runtime scoring state: it protects
 * immutable ownership, but it does not invent live stats. Explicit provider
 * postponement/cancellation evidence keeps the old start time from being
 * treated as an actual puck-drop boundary.
 */
export function hasNhlGameReachedStartSafetyBoundary(input: {
  source: NhlGameRuntimeStateSource | null | undefined;
  observedAtMilliseconds: number;
}): boolean {
  const runtimeState = getNhlGameRuntimeState(input.source);

  if (runtimeState === 'live' || runtimeState === 'final') {
    return true;
  }

  if (isNhlGameExplicitlyDeferred(input.source)) {
    return false;
  }

  if (
    !Number.isFinite(input.observedAtMilliseconds) ||
    typeof input.source?.startTimeUTC !== 'string' ||
    !input.source.startTimeUTC.trim()
  ) {
    return false;
  }

  const startMilliseconds = Date.parse(input.source.startTimeUTC);

  return Number.isFinite(startMilliseconds) &&
    startMilliseconds <= input.observedAtMilliseconds;
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
