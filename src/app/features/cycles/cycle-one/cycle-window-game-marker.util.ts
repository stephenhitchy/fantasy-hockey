import type { AssetCycleGameState } from '../../../core/cycle/cycle.models';

import type { CycleWindowGameMarker } from './cycle-one.models';

export interface CycleWindowGameMarkerStateInput {
  gameId: number | null;
  completedGameIds: readonly number[];
  appearanceGameIds: readonly number[];
  liveGameIds: readonly number[];
  gameStates: Readonly<Record<string, AssetCycleGameState>>;
  actualGamesPlayed: number;
}

/**
 * Converts server-owned scoring evidence into the visual state of one game in
 * a roster slot's six-game window. A final NHL game remains "finalizing" until
 * the scorer has complete appearance evidence; it must not be shown as a
 * played or missed game prematurely.
 */
export function resolveCycleWindowGameMarkerState(
  input: CycleWindowGameMarkerStateInput,
): Pick<CycleWindowGameMarker, 'status' | 'statusLabel'> {
  const gameId = input.gameId;

  if (!gameId) {
    return {
      status: 'unavailable',
      statusLabel: 'Not scheduled',
    };
  }

  const completed = input.completedGameIds.includes(gameId);
  const hasAppearanceData = input.appearanceGameIds.length > 0;
  const inferredAllAppearances =
    input.actualGamesPlayed === input.completedGameIds.length &&
    input.completedGameIds.length > 0;
  const appeared =
    input.appearanceGameIds.includes(gameId) ||
    (!hasAppearanceData && inferredAllAppearances);

  if (completed && appeared) {
    return {
      status: 'played',
      statusLabel: 'Played',
    };
  }

  if (completed) {
    return {
      status: 'missed',
      statusLabel: 'Counted team game · no appearance',
    };
  }

  const runtimeState = input.gameStates[String(gameId)] ??
    (input.liveGameIds.includes(gameId) ? 'live' : 'scheduled');

  if (runtimeState === 'final') {
    return {
      status: 'finalizing',
      statusLabel: 'Final · confirming appearance',
    };
  }

  if (runtimeState === 'live') {
    return {
      status: 'live',
      statusLabel: 'Live',
    };
  }

  return {
    status: 'upcoming',
    statusLabel: 'Upcoming',
  };
}
