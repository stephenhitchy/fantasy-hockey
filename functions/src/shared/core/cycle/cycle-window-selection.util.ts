export function getCycleGameStartIndex(
  cycleNumber: number,
  requiredGamesPerCycle: number
): number {
  return Math.max(0, (cycleNumber - 1) * requiredGamesPerCycle);
}

export function getCycleGameEndIndex(
  cycleNumber: number,
  requiredGamesPerCycle: number
): number {
  return cycleNumber * requiredGamesPerCycle;
}

/**
 * Resolves the NHL schedule block that supplies a fantasy window. Legacy
 * records did not store a separate source block, so their fantasy cycle
 * number remains the compatibility fallback.
 */
export function resolveSourceNhlBlockNumber(
  sourceNhlBlockNumber: unknown,
  fallbackCycleNumber: number,
): number {
  if (
    typeof sourceNhlBlockNumber === 'number' &&
    Number.isInteger(sourceNhlBlockNumber) &&
    sourceNhlBlockNumber > 0
  ) {
    return sourceNhlBlockNumber;
  }

  if (Number.isInteger(fallbackCycleNumber) && fallbackCycleNumber > 0) {
    return fallbackCycleNumber;
  }

  return 1;
}

/**
 * Rehydrates a frozen schedule selection without allowing a later provider
 * reorder to move games across an immutable six-game boundary.
 */
export function selectGamesByStableIds<T extends { id: number }>(
  schedule: T[],
  targetGameIds: readonly number[],
): T[] {
  const uniqueTargetIds = new Set(targetGameIds);

  if (
    targetGameIds.length === 0 ||
    uniqueTargetIds.size !== targetGameIds.length ||
    targetGameIds.some((gameId) => !Number.isInteger(gameId) || gameId <= 0)
  ) {
    throw new Error('The frozen NHL game-id selection is malformed.');
  }

  const gameById = new Map(schedule.map((game) => [game.id, game] as const));
  const selected = targetGameIds.map((gameId) => gameById.get(gameId));
  const missingGameIds = targetGameIds.filter((gameId, index) => !selected[index]);

  if (missingGameIds.length > 0) {
    throw new Error(
      `The NHL schedule is missing frozen game id(s): ${missingGameIds.join(', ')}.`,
    );
  }

  return selected as T[];
}

/**
 * Selects the exact provider game IDs frozen for one absolute NHL source
 * block. Missing input means a legacy league and deliberately returns an
 * empty map so its historical schedule-slicing behavior remains available.
 * Once a plan field exists, malformed or truncated evidence fails visibly.
 */
export function buildSourceNhlTargetGameIdsByTeam(
  sourceGameIdsByTeam: unknown,
  sourceNhlBlockNumber: number,
  requiredGamesPerCycle: number,
): Record<string, number[]> {
  if (sourceGameIdsByTeam === null || sourceGameIdsByTeam === undefined) {
    return {};
  }

  if (
    !sourceGameIdsByTeam ||
    typeof sourceGameIdsByTeam !== 'object' ||
    Array.isArray(sourceGameIdsByTeam)
  ) {
    throw new Error('The frozen NHL source-game plan is malformed.');
  }

  if (!Number.isSafeInteger(sourceNhlBlockNumber) || sourceNhlBlockNumber < 1) {
    throw new Error('The requested NHL source block is malformed.');
  }

  if (!Number.isSafeInteger(requiredGamesPerCycle) || requiredGamesPerCycle < 1) {
    throw new Error('The requested NHL source-block game count is malformed.');
  }

  const entries = Object.entries(sourceGameIdsByTeam);

  if (entries.length === 0) {
    throw new Error('The frozen NHL source-game plan is empty.');
  }

  const startIndex = getCycleGameStartIndex(
    sourceNhlBlockNumber,
    requiredGamesPerCycle,
  );
  const endIndex = getCycleGameEndIndex(
    sourceNhlBlockNumber,
    requiredGamesPerCycle,
  );
  const targets: Record<string, number[]> = {};

  for (const [rawTeamAbbreviation, rawGameIds] of entries) {
    const teamAbbreviation = rawTeamAbbreviation.trim().toUpperCase();

    if (!/^[A-Z0-9]{2,4}$/.test(teamAbbreviation) || targets[teamAbbreviation]) {
      throw new Error('The frozen NHL source-game plan has a malformed team key.');
    }

    if (!Array.isArray(rawGameIds)) {
      throw new Error(
        `The frozen NHL source-game plan for ${teamAbbreviation} is malformed.`,
      );
    }

    const gameIds = rawGameIds.filter(
      (gameId): gameId is number =>
        typeof gameId === 'number' && Number.isSafeInteger(gameId) && gameId > 0,
    );

    if (
      gameIds.length !== rawGameIds.length ||
      new Set(gameIds).size !== gameIds.length
    ) {
      throw new Error(
        `The frozen NHL source-game plan for ${teamAbbreviation} is malformed.`,
      );
    }

    const targetGameIds = gameIds.slice(startIndex, endIndex);

    if (targetGameIds.length !== requiredGamesPerCycle) {
      throw new Error(
        `The frozen NHL source-game plan for ${teamAbbreviation} is incomplete for ` +
          `source block ${sourceNhlBlockNumber}.`,
      );
    }

    targets[teamAbbreviation] = targetGameIds;
  }

  return targets;
}

export function selectCycleWindowGames<T>(
  schedule: T[],
  cycleNumber: number,
  requiredGamesPerCycle: number
): T[] {
  return schedule.slice(
    getCycleGameStartIndex(cycleNumber, requiredGamesPerCycle),
    getCycleGameEndIndex(cycleNumber, requiredGamesPerCycle)
  );
}
