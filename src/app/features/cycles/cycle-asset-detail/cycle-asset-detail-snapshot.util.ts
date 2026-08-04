import type { CycleAssetScoreSummary, CycleGameRuntimeState } from '../../../core/cycle/cycle-scoring.service';
import type { DraftPick } from '../../../core/draft/draft.models';
import type { SharedCycleScoringSnapshot } from '../../../core/live-scoring/live-scoring.models';

export interface CycleAssetSnapshotGame {
  gameId: number;
  gameDate: string;
  scheduleLabel: string;
  state: CycleGameRuntimeState;
  fantasyPoints: number | null;
  counted: boolean;
  appeared: boolean;
}

export interface ReplaySnapshotSeason {
  targetSeason: string;
  sourceSeason: string;
}

export function resolveCycleAssetScoreSummary(
  snapshot: SharedCycleScoringSnapshot | null,
  pick: DraftPick | null,
  assetKey: string,
): CycleAssetScoreSummary | null {
  if (!snapshot) {
    return null;
  }

  if (pick?.cycleWindowId) {
    const windowSummary = snapshot.result.windowScores[pick.cycleWindowId];

    if (windowSummary?.assetKey === assetKey) {
      return windowSummary;
    }
  }

  const assetSummary = snapshot.result.assetScores[assetKey];
  return assetSummary?.assetKey === assetKey ? assetSummary : null;
}

export function buildCycleAssetSnapshotGames(
  summary: CycleAssetScoreSummary,
): CycleAssetSnapshotGame[] {
  const completedGameIds = new Set(summary.completedGameIds);
  const appearanceGameIds = new Set(summary.appearanceGameIds);

  return summary.scheduledGameIds.map((gameId, index) => {
    const gameIdKey = String(gameId);
    const recordedState = summary.gameStates[gameIdKey];
    const state: CycleGameRuntimeState =
      recordedState === 'live' || recordedState === 'final'
        ? recordedState
        : 'scheduled';
    const score = summary.gameScores[gameIdKey];

    return {
      gameId,
      gameDate: summary.scheduledGameDates[index] ?? '',
      scheduleLabel: summary.scheduledGameLabels[index] ?? 'NHL team game',
      state,
      fantasyPoints:
        state === 'scheduled' || typeof score !== 'number'
          ? null
          : Number(score.toFixed(1)),
      counted: state === 'final' || completedGameIds.has(gameId),
      appeared: appearanceGameIds.has(gameId),
    };
  });
}

export function parseReplaySnapshotSeason(value: string | null | undefined): ReplaySnapshotSeason | null {
  if (!value) {
    return null;
  }

  const match = /^replay-(\d{8})-from-(\d{8})$/.exec(value);

  if (!match) {
    return null;
  }

  return {
    targetSeason: match[1],
    sourceSeason: match[2],
  };
}

export function resolveCycleAssetDetailSeason(input: {
  snapshotSeason: string | null | undefined;
  replaySourceSeason: string | null | undefined;
  fallbackSeason: string;
}): string {
  if (/^\d{8}$/.test(input.replaySourceSeason ?? '')) {
    return input.replaySourceSeason as string;
  }

  const replaySeason = parseReplaySnapshotSeason(input.snapshotSeason);

  if (replaySeason) {
    return replaySeason.sourceSeason;
  }

  if (/^\d{8}$/.test(input.snapshotSeason ?? '')) {
    return input.snapshotSeason as string;
  }

  return input.fallbackSeason;
}
