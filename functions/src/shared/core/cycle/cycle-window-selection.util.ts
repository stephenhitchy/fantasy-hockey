import type { FantasyDraft } from '../draft/draft.models';

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

function normalizeFrozenSeasonPlan(
  value: unknown,
): Record<string, number[]> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The frozen NHL season plan is malformed.');
  }

  const result: Record<string, number[]> = {};

  for (const [rawTeam, rawGameIds] of Object.entries(value)) {
    const team = rawTeam.trim().toUpperCase();

    if (!/^[A-Z0-9]{2,4}$/.test(team) || result[team] || !Array.isArray(rawGameIds)) {
      throw new Error('The frozen NHL season plan has malformed club evidence.');
    }

    const gameIds = rawGameIds.filter(
      (gameId): gameId is number =>
        typeof gameId === 'number' && Number.isSafeInteger(gameId) && gameId > 0,
    );

    if (
      gameIds.length !== rawGameIds.length ||
      gameIds.length === 0 ||
      new Set(gameIds).size !== gameIds.length
    ) {
      throw new Error(`The frozen NHL season plan for ${team} is malformed.`);
    }

    result[team] = gameIds;
  }

  if (Object.keys(result).length === 0) {
    throw new Error('The frozen NHL season plan is empty.');
  }

  return result;
}

/**
 * Rehydrates the longest schedule already sealed into the Draft anchor. Older
 * FF1.42 plans stopped at the final normal source block, while the anchor kept
 * the remaining provider IDs. Those frozen tail games form a safe transfer
 * reserve without consulting a mutable post-Draft schedule.
 */
export function resolveFrozenSeasonSourceGameIdsByTeam(
  draft: Pick<
    FantasyDraft,
    'seasonWindowSourceGameIdsByTeam' | 'seasonWindowAnchorTeams'
  > | null | undefined,
): Record<string, number[]> | undefined {
  const planned = normalizeFrozenSeasonPlan(
    draft?.seasonWindowSourceGameIdsByTeam,
  );

  if (!planned) {
    return undefined;
  }

  const anchorTeams = draft?.seasonWindowAnchorTeams;

  if (!Array.isArray(anchorTeams) || anchorTeams.length === 0) {
    return planned;
  }

  const anchorPlan = normalizeFrozenSeasonPlan(
    Object.fromEntries(
      anchorTeams.map((team) => [
        team.teamAbbreviation,
        team.regularSeasonGameIds,
      ]),
    ),
  )!;
  const plannedTeams = Object.keys(planned).sort();
  const anchorTeamKeys = Object.keys(anchorPlan).sort();

  if (
    plannedTeams.length !== anchorTeamKeys.length ||
    plannedTeams.some((team, index) => team !== anchorTeamKeys[index])
  ) {
    throw new Error(
      'The frozen NHL season plan does not match the all-club Draft anchor.',
    );
  }

  for (const team of plannedTeams) {
    const plannedIds = planned[team];
    const anchorIds = anchorPlan[team];

    if (
      anchorIds.length < plannedIds.length ||
      plannedIds.some((gameId, index) => anchorIds[index] !== gameId)
    ) {
      throw new Error(
        `The frozen NHL season plan for ${team} does not match its Draft anchor.`,
      );
    }
  }

  return anchorPlan;
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
