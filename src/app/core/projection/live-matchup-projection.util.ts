export interface LiveMatchupProjectionEvidence {
  currentScore: number;
  gamesPlayed: number;
  scheduledGames: number;
  completedGameIds: readonly number[];
  liveGameIds: readonly number[];
  gameScores: Readonly<Record<string, number>>;
}

export type LiveMatchupProjectionTrend = 'up' | 'down' | 'even' | 'unavailable';

function roundPoints(value: number): number {
  return Number(value.toFixed(1));
}

/**
 * Replaces each completed game's share of the frozen projection with its
 * settled points. Live games do not change the projection because RinkRat
 * does not have an in-game pace model that can make that adjustment honestly.
 */
export function calculateLiveMatchupProjection(
  frozenProjection: number | null | undefined,
  evidence: LiveMatchupProjectionEvidence | null | undefined,
): number | null {
  if (typeof frozenProjection !== 'number' || !Number.isFinite(frozenProjection)) {
    return null;
  }

  if (!evidence) {
    return roundPoints(frozenProjection);
  }

  const { currentScore } = evidence;
  if (!Number.isFinite(currentScore)) {
    return null;
  }

  const scheduledGames = Math.max(0, Math.floor(evidence.scheduledGames));
  if (scheduledGames === 0) {
    return roundPoints(frozenProjection);
  }

  const gamesPlayed = Math.min(
    scheduledGames,
    Math.max(0, Math.floor(evidence.gamesPlayed)),
  );
  const completedGameIds = [...new Set(evidence.completedGameIds)];

  if (completedGameIds.length !== gamesPlayed) {
    return null;
  }

  let settledScore = 0;
  for (const gameId of completedGameIds) {
    const gameScore = evidence.gameScores[String(gameId)];

    if (typeof gameScore !== 'number' || !Number.isFinite(gameScore)) {
      return null;
    }

    settledScore += gameScore;
  }

  const frozenPointsPerGame = frozenProjection / scheduledGames;

  return roundPoints(
    frozenProjection - gamesPlayed * frozenPointsPerGame + settledScore,
  );
}

export function getLiveMatchupProjectionTrend(
  liveProjection: number | null | undefined,
  frozenProjection: number | null | undefined,
): LiveMatchupProjectionTrend {
  if (
    typeof liveProjection !== 'number' ||
    !Number.isFinite(liveProjection) ||
    typeof frozenProjection !== 'number' ||
    !Number.isFinite(frozenProjection)
  ) {
    return 'unavailable';
  }

  const delta = roundPoints(liveProjection - frozenProjection);
  if (delta > 0) {
    return 'up';
  }

  if (delta < 0) {
    return 'down';
  }

  return 'even';
}
