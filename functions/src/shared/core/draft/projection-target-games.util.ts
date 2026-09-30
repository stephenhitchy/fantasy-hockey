export interface ProjectionScheduleGame {
  id: number;
}

/**
 * Selects the source block for ordinary windows and, for an anchored Draft
 * opening, resolves the exact frozen game IDs without trusting later provider
 * ordering.
 */
export function selectProjectionTargetGames<T extends ProjectionScheduleGame>(
  schedule: readonly T[],
  targetSourceBlockNumber: number | undefined,
  requiredGamesPerCycle: number,
  frozenTargetGameIds: readonly number[] | undefined,
  teamAbbreviation: string,
): T[] {
  if (!targetSourceBlockNumber) {
    return [];
  }

  if (frozenTargetGameIds) {
    if (
      frozenTargetGameIds.length !== requiredGamesPerCycle ||
      new Set(frozenTargetGameIds).size !== requiredGamesPerCycle
    ) {
      throw new Error(
        `Frozen Draft schedule evidence for ${teamAbbreviation} is malformed.`,
      );
    }

    const scheduleByGameId = new Map(
      schedule.map((game) => [game.id, game] as const),
    );
    const exactGames = frozenTargetGameIds.map((gameId) =>
      scheduleByGameId.get(gameId));

    if (exactGames.some((game) => !game)) {
      throw new Error(
        `The current NHL schedule for ${teamAbbreviation} no longer contains every game frozen by the Draft season-window anchor.`,
      );
    }

    return exactGames as T[];
  }

  const startIndex =
    (targetSourceBlockNumber - 1) * requiredGamesPerCycle;

  return schedule.slice(
    startIndex,
    startIndex + requiredGamesPerCycle,
  );
}
