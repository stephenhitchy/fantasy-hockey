import type { ProjectionCycleGameMarker } from './draft.models';

export interface CurrentTeamCycleGamePoints {
  gameId: number;
  fantasyPoints: number;
}

/**
 * Totals the non-counting fantasy production for the NHL team's current
 * six-game block. A missing played game stays unknown instead of becoming a
 * misleading zero.
 */
export function calculateCurrentTeamCycleFantasyPoints(
  games: readonly CurrentTeamCycleGamePoints[],
  markers: readonly ProjectionCycleGameMarker[],
): number | null {
  if (markers.length === 0) {
    return null;
  }

  const playedGameIds = markers
    .filter((marker) => marker.status === 'played')
    .map((marker) => marker.gameId);

  if (playedGameIds.length === 0) {
    return 0;
  }

  const pointsByGameId = new Map(
    games
      .filter((game) => Number.isInteger(game.gameId) && Number.isFinite(game.fantasyPoints))
      .map((game) => [game.gameId, game.fantasyPoints]),
  );

  if (playedGameIds.some((gameId) => !pointsByGameId.has(gameId))) {
    return null;
  }

  const total = playedGameIds.reduce(
    (sum, gameId) => sum + (pointsByGameId.get(gameId) ?? 0),
    0,
  );

  return Number(total.toFixed(1));
}
