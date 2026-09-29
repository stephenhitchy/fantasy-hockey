import type { AssetCycleWindowStatus } from '../cycle/cycle.models';

export type ActiveBenchSwapDelaySource =
  | 'none'
  | 'active-player'
  | 'bench-player'
  | 'both-players'
  | 'roster-boundary';

export interface ActiveBenchSwapTimingPreview {
  mode: 'immediate' | 'queued';
  effectiveCycleNumber: number;
  delaySource: ActiveBenchSwapDelaySource;
  activeCycleNumber: number | null;
  activeFinalGames: number;
  activeLiveGames: number;
  activeScheduledGames: number;
  activeWindowStatus: AssetCycleWindowStatus | null;
  benchCurrentCycleNumber: number;
  benchFinalGames: number;
  benchLiveGames: number;
  benchScheduledGames: number;
  benchEarliestCycleNumber: number;
}

export interface ActiveBenchSwapTimingInput {
  activeCycleNumber: number | null;
  activeFinalGames: number;
  activeLiveGames: number;
  activeScheduledGames: number;
  activeWindowStatus: AssetCycleWindowStatus | null;
  activeAssignmentUntouched: boolean;
  immediateCycleNumber: number | null;
  openFromCycleNumber: number | null;
  benchCurrentCycleNumber: number;
  benchFinalGames: number;
  benchLiveGames: number;
  benchScheduledGames: number;
  benchCurrentCycleHasStarted: boolean;
  benchEarliestCycleNumber: number;
}

/**
 * Mirrors the existing immediate-versus-queued browser preview without
 * authorizing a roster write. Server roster authority repeats every fact when
 * the manager confirms the swap.
 */
export function resolveActiveBenchSwapTimingPreview(
  input: ActiveBenchSwapTimingInput,
): ActiveBenchSwapTimingPreview {
  const canApplyImmediately = Boolean(
    input.activeAssignmentUntouched &&
    input.immediateCycleNumber !== null &&
    input.benchEarliestCycleNumber <= input.immediateCycleNumber
  );
  const activeEarliestCycleNumber = canApplyImmediately
    ? input.immediateCycleNumber!
    : input.activeCycleNumber !== null
      ? input.activeCycleNumber + 1
      : input.openFromCycleNumber ?? 1;
  const effectiveCycleNumber = Math.max(
    activeEarliestCycleNumber,
    input.benchEarliestCycleNumber,
  );
  const activeWindowStarted = Boolean(
    !input.activeAssignmentUntouched &&
    input.activeWindowStatus !== null &&
    input.activeWindowStatus !== 'complete',
  );
  let delaySource: ActiveBenchSwapDelaySource = 'roster-boundary';

  if (canApplyImmediately) {
    delaySource = 'none';
  } else if (input.benchEarliestCycleNumber > activeEarliestCycleNumber) {
    delaySource = 'bench-player';
  } else if (activeEarliestCycleNumber > input.benchEarliestCycleNumber) {
    delaySource = input.activeWindowStatus === 'complete'
      ? 'roster-boundary'
      : 'active-player';
  } else if (activeWindowStarted && input.benchCurrentCycleHasStarted) {
    delaySource = 'both-players';
  } else if (activeWindowStarted) {
    delaySource = 'active-player';
  } else if (input.benchCurrentCycleHasStarted) {
    delaySource = 'bench-player';
  }

  return {
    mode: canApplyImmediately ? 'immediate' : 'queued',
    effectiveCycleNumber,
    delaySource,
    activeCycleNumber: input.activeCycleNumber,
    activeFinalGames: input.activeFinalGames,
    activeLiveGames: input.activeLiveGames,
    activeScheduledGames: input.activeScheduledGames,
    activeWindowStatus: input.activeWindowStatus,
    benchCurrentCycleNumber: input.benchCurrentCycleNumber,
    benchFinalGames: input.benchFinalGames,
    benchLiveGames: input.benchLiveGames,
    benchScheduledGames: input.benchScheduledGames,
    benchEarliestCycleNumber: input.benchEarliestCycleNumber,
  };
}
