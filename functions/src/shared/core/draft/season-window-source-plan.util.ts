import {
  validateAnchoredSeasonCapacity,
  type AnchoredSeasonCapacity,
} from './anchored-season-capacity.util';

export interface SeasonWindowSourcePlanTeamEvidence {
  teamAbbreviation: string;
  regularSeasonGameCount: number;
  regularSeasonGameIds: readonly number[];
  finalPrefixGameCount: number;
  targetGameIds: readonly number[];
}

export interface ValidateSeasonWindowSourcePlanInput {
  finalizedTeamCount: number;
  initialNhlBlockNumber: number;
  requiredGamesPerCycle: number;
  activeNhlTeamAbbreviations: readonly string[];
  anchorTeams: readonly SeasonWindowSourcePlanTeamEvidence[];
  sourceGameIdsByTeam: unknown;
}

export interface ValidatedSeasonWindowSourcePlan extends AnchoredSeasonCapacity {
  sourceGameIdsByTeam: Record<string, number[]>;
}

export type BuildSeasonWindowSourcePlanFromAnchorInput = Omit<
  ValidateSeasonWindowSourcePlanInput,
  'sourceGameIdsByTeam'
>;

function sameGameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length &&
    left.every((gameId, index) => gameId === right[index]);
}

/**
 * Validates the complete immutable NHL source plan used by every matchup and
 * playoff window, not only the opening six-game block.
 */
export function validateSeasonWindowSourcePlan(
  input: ValidateSeasonWindowSourcePlanInput,
): ValidatedSeasonWindowSourcePlan {
  const activeTeams = [...input.activeNhlTeamAbbreviations]
    .map((team) => team.trim().toUpperCase())
    .sort((left, right) => left.localeCompare(right));

  if (
    activeTeams.length === 0 ||
    new Set(activeTeams).size !== activeTeams.length ||
    input.anchorTeams.length !== activeTeams.length
  ) {
    throw new Error(
      'Draft season-window source planning requires complete all-club NHL evidence.',
    );
  }

  const anchorByTeam = new Map(
    input.anchorTeams.map((team) => [team.teamAbbreviation, team] as const),
  );

  if (
    anchorByTeam.size !== activeTeams.length ||
    activeTeams.some((team) => !anchorByTeam.has(team))
  ) {
    throw new Error(
      'Draft season-window source planning is missing one or more NHL clubs.',
    );
  }

  const capacity = validateAnchoredSeasonCapacity({
    finalizedTeamCount: input.finalizedTeamCount,
    activeNhlTeamCount: activeTeams.length,
    initialNhlBlockNumber: input.initialNhlBlockNumber,
    requiredGamesPerCycle: input.requiredGamesPerCycle,
    teams: input.anchorTeams,
  });
  const rawPlan = input.sourceGameIdsByTeam;

  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    throw new Error('Draft season-window source plan is missing.');
  }

  const planRecord = rawPlan as Record<string, unknown>;

  if (Object.keys(planRecord).length !== activeTeams.length) {
    throw new Error('Draft season-window source plan is incomplete.');
  }

  const sourceGameIdsByTeam: Record<string, number[]> = {};
  const openingStartIndex =
    (input.initialNhlBlockNumber - 1) * input.requiredGamesPerCycle;

  for (const teamAbbreviation of activeTeams) {
    const anchorTeam = anchorByTeam.get(teamAbbreviation)!;
    const rawGameIds = planRecord[teamAbbreviation];

    if (!Array.isArray(rawGameIds)) {
      throw new Error(
        `Draft season-window source plan is missing ${teamAbbreviation}.`,
      );
    }

    const gameIds = rawGameIds.filter(
      (gameId): gameId is number =>
        typeof gameId === 'number' && Number.isSafeInteger(gameId) && gameId > 0,
    );

    if (
      gameIds.length !== capacity.requiredThroughGameNumber ||
      gameIds.length !== rawGameIds.length ||
      new Set(gameIds).size !== gameIds.length ||
      anchorTeam.regularSeasonGameIds.length < capacity.requiredThroughGameNumber ||
      !sameGameIds(
        gameIds,
        anchorTeam.regularSeasonGameIds.slice(0, capacity.requiredThroughGameNumber),
      ) ||
      !sameGameIds(
        anchorTeam.targetGameIds,
        gameIds.slice(
          openingStartIndex,
          openingStartIndex + input.requiredGamesPerCycle,
        ),
      )
    ) {
      throw new Error(
        `Draft season-window source plan for ${teamAbbreviation} is incomplete or does not match the frozen anchor.`,
      );
    }

    sourceGameIdsByTeam[teamAbbreviation] = gameIds;
  }

  return {
    ...capacity,
    sourceGameIdsByTeam,
  };
}

/**
 * Repairs an intermediate record from the IDs already sealed into its anchor.
 * It deliberately performs no provider fetch, so recovery cannot move a game
 * after the T-40 freeze.
 */
export function buildSeasonWindowSourcePlanFromAnchor(
  input: BuildSeasonWindowSourcePlanFromAnchorInput,
): ValidatedSeasonWindowSourcePlan {
  const capacity = validateAnchoredSeasonCapacity({
    finalizedTeamCount: input.finalizedTeamCount,
    activeNhlTeamCount: input.activeNhlTeamAbbreviations.length,
    initialNhlBlockNumber: input.initialNhlBlockNumber,
    requiredGamesPerCycle: input.requiredGamesPerCycle,
    teams: input.anchorTeams,
  });

  return validateSeasonWindowSourcePlan({
    ...input,
    sourceGameIdsByTeam: Object.fromEntries(
      input.anchorTeams.map((team) => [
        team.teamAbbreviation,
        team.regularSeasonGameIds.slice(0, capacity.requiredThroughGameNumber),
      ]),
    ),
  });
}
