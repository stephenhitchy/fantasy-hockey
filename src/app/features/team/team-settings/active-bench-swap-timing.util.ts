import type { ActiveBenchSwapTimingPreview } from '../../../core/transactions/active-bench-swap-timing.util';

export interface ActiveBenchSwapTimingMessage {
  tone: 'ready' | 'waiting' | 'checking';
  matchupLabel: string;
  headline: string;
  detail: string;
}

function progressLabel(finalGames: number, liveGames: number, scheduledGames: number): string {
  const liveLabel = liveGames > 0
    ? `, with ${liveGames} ${liveGames === 1 ? 'game' : 'games'} live`
    : '';

  return `${finalGames}/${scheduledGames} NHL team games final${liveLabel}`;
}

/**
 * Turns read-only timing evidence into manager-facing copy. The secure server
 * action still repeats the timing check at confirmation, so this function is
 * deliberately presentation-only.
 */
export function buildActiveBenchSwapTimingMessage(
  preview: ActiveBenchSwapTimingPreview,
  activePlayerName: string | null,
  benchPlayerName: string,
): ActiveBenchSwapTimingMessage {
  const activeName = activePlayerName ?? 'The open active slot';
  const matchupLabel = `Matchup ${preview.effectiveCycleNumber}`;

  if (preview.mode === 'immediate') {
    return {
      tone: 'ready',
      matchupLabel,
      headline: `This swap can happen now in ${matchupLabel}`,
      detail: `Neither ${activeName}'s active assignment nor ${benchPlayerName}'s incoming NHL block has started. RinkRat can change the untouched lineup without moving any already-played game.`,
    };
  }

  if (preview.delaySource === 'bench-player') {
    const hasStarted = preview.benchFinalGames > 0 || preview.benchLiveGames > 0;

    return {
      tone: 'waiting',
      matchupLabel,
      headline: `${benchPlayerName} is the reason this swap waits until ${matchupLabel}`,
      detail: hasStarted
        ? `${benchPlayerName} is further along: their NHL team has already started Matchup ${preview.benchCurrentCycleNumber} (${progressLabel(preview.benchFinalGames, preview.benchLiveGames, preview.benchScheduledGames)}). Those earlier games cannot be backfilled after the player enters your active lineup.`
        : `${benchPlayerName} is not eligible to enter an active scoring slot before ${matchupLabel}. RinkRat waits rather than attaching that player to an earlier six-game window.`,
    };
  }

  if (preview.delaySource === 'active-player') {
    return {
      tone: 'waiting',
      matchupLabel,
      headline: `${activeName} is the reason this swap waits until ${matchupLabel}`,
      detail: `${activeName}'s active roster spot is further along: its Matchup ${preview.activeCycleNumber ?? '—'} six-game window has started (${progressLabel(preview.activeFinalGames, preview.activeLiveGames, preview.activeScheduledGames)}). That protected window must stay intact before ${benchPlayerName} can take the slot.`,
    };
  }

  if (preview.delaySource === 'both-players') {
    return {
      tone: 'waiting',
      matchupLabel,
      headline: `Both players hold this swap until ${matchupLabel}`,
      detail: `${activeName}'s Matchup ${preview.activeCycleNumber ?? '—'} active window has started (${progressLabel(preview.activeFinalGames, preview.activeLiveGames, preview.activeScheduledGames)}), and ${benchPlayerName}'s Matchup ${preview.benchCurrentCycleNumber} NHL block has also started (${progressLabel(preview.benchFinalGames, preview.benchLiveGames, preview.benchScheduledGames)}). RinkRat preserves both histories and uses the next clean matchup.`,
    };
  }

  return {
    tone: 'waiting',
    matchupLabel,
    headline: `This swap is scheduled for ${matchupLabel}`,
    detail: preview.activeWindowStatus === 'complete'
      ? `${activeName} has completed the current six-game window. The player is no longer holding the move; RinkRat is waiting for the active roster slot's next matchup boundary to open.`
      : `The selected active roster assignment cannot change until its next legal matchup boundary. The server will recheck both players before applying the swap.`,
  };
}
