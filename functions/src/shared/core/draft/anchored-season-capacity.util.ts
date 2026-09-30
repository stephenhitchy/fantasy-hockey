import { defaultScoringRules } from '../scoring/scoring-rules';
import {
  getAnchoredRegularSeasonCycleCount,
  getStandardPlayoffRoundCount,
  getStandardPlayoffTeamCount,
} from '../playoffs/playoff-format';

export interface AnchoredSeasonScheduleCapacityEvidence {
  teamAbbreviation: string;
  regularSeasonGameCount: number;
}

export interface ValidateAnchoredSeasonCapacityInput {
  finalizedTeamCount: number;
  activeNhlTeamCount: number;
  initialNhlBlockNumber: number;
  requiredGamesPerCycle: number;
  teams: readonly AnchoredSeasonScheduleCapacityEvidence[];
}

export interface AnchoredSeasonCapacity {
  regularSeasonCycleCount: number;
  playoffRoundCount: number;
  finalRequiredSourceBlock: number;
  requiredThroughGameNumber: number;
}

/**
 * Proves that a late-start league still fits at least one regular matchup and
 * every standard playoff round inside complete NHL six-game source blocks.
 */
export function validateAnchoredSeasonCapacity(
  input: ValidateAnchoredSeasonCapacityInput,
): AnchoredSeasonCapacity {
  if (
    input.requiredGamesPerCycle !==
      defaultScoringRules.requiredGamesPerCycle
  ) {
    throw new Error(
      `Draft season-window anchoring requires the protected ${defaultScoringRules.requiredGamesPerCycle}-game matchup format.`,
    );
  }

  if (!Number.isSafeInteger(input.finalizedTeamCount) || input.finalizedTeamCount < 2) {
    throw new Error(
      'Draft season-window anchoring requires at least two finalized participants.',
    );
  }

  if (
    !Number.isSafeInteger(input.activeNhlTeamCount) ||
    input.activeNhlTeamCount <= 0 ||
    input.teams.length !== input.activeNhlTeamCount
  ) {
    throw new Error(
      'Draft season-window anchoring requires complete all-club NHL schedule evidence.',
    );
  }

  const seenTeams = new Set<string>();

  for (const team of input.teams) {
    if (
      !/^[A-Z0-9]{2,4}$/.test(team.teamAbbreviation) ||
      seenTeams.has(team.teamAbbreviation) ||
      !Number.isSafeInteger(team.regularSeasonGameCount) ||
      team.regularSeasonGameCount < 0
    ) {
      throw new Error(
        'Draft season-window anchoring received malformed NHL schedule-capacity evidence.',
      );
    }

    seenTeams.add(team.teamAbbreviation);
  }

  const regularSeasonCycleCount = getAnchoredRegularSeasonCycleCount(
    input.finalizedTeamCount,
    input.initialNhlBlockNumber,
  );
  const playoffRoundCount = getStandardPlayoffRoundCount(
    getStandardPlayoffTeamCount(input.finalizedTeamCount),
  );
  const finalRequiredSourceBlock =
    input.initialNhlBlockNumber +
    regularSeasonCycleCount +
    playoffRoundCount -
    1;
  const requiredThroughGameNumber =
    finalRequiredSourceBlock * input.requiredGamesPerCycle;
  const incompleteSchedules = input.teams
    .filter((team) => team.regularSeasonGameCount < requiredThroughGameNumber)
    .map((team) => team.teamAbbreviation);

  if (incompleteSchedules.length > 0) {
    throw new Error(
      `NHL schedule evidence is incomplete through game ${requiredThroughGameNumber} for: ${incompleteSchedules.join(', ')}.`,
    );
  }

  return {
    regularSeasonCycleCount,
    playoffRoundCount,
    finalRequiredSourceBlock,
    requiredThroughGameNumber,
  };
}
