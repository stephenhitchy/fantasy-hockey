import {
  calculateGoalieGameBreakdown,
  calculateSkaterGameBreakdown,
  type GamePointBreakdown,
  type GoalieGameStats,
  type SkaterGameStats,
} from './scoring-engine';
import { defaultScoringRules } from './scoring-rules';

export type PublicScoringCalculatorMode = 'forward' | 'defense' | 'goalie';

export interface PublicSkaterCalculatorInput {
  goals: number;
  primaryAssists: number;
  secondaryAssists: number;
  shotsOnGoal: number;
  hits: number;
  blockedShots: number;
  plusMinus: number;
  powerPlayPoints: number;
  shortHandedPoints: number;
  gameWinningGoal: boolean;
  overtimeGoal: boolean;
  timeOnIceMinutes: number;
}

export interface PublicGoalieCalculatorInput {
  saves: number;
  shotsAgainst: number;
  won: boolean;
  shutout: boolean;
}

export interface PublicScoringCalculatorResult {
  valid: boolean;
  errorMessage: string;
  breakdown: GamePointBreakdown;
  repeatedSixGameTotal: number;
  savePercentage: number | null;
}

export interface PublicScoringCalculatorPreset<T> {
  id: string;
  label: string;
  detail: string;
  input: T;
}

export const DEFAULT_PUBLIC_SKATER_INPUT: PublicSkaterCalculatorInput = {
  goals: 1,
  primaryAssists: 0,
  secondaryAssists: 0,
  shotsOnGoal: 3,
  hits: 1,
  blockedShots: 0,
  plusMinus: 1,
  powerPlayPoints: 0,
  shortHandedPoints: 0,
  gameWinningGoal: false,
  overtimeGoal: false,
  timeOnIceMinutes: 18,
};

export const DEFAULT_PUBLIC_GOALIE_INPUT: PublicGoalieCalculatorInput = {
  saves: 28,
  shotsAgainst: 30,
  won: true,
  shutout: false,
};

export const FORWARD_SCORING_PRESETS: readonly PublicScoringCalculatorPreset<PublicSkaterCalculatorInput>[] = [
  {
    id: 'forward-big-night',
    label: 'Big forward night',
    detail: '2 goals, primary assist, PP point, 4 shots',
    input: {
      goals: 2,
      primaryAssists: 1,
      secondaryAssists: 0,
      shotsOnGoal: 4,
      hits: 2,
      blockedShots: 0,
      plusMinus: 1,
      powerPlayPoints: 1,
      shortHandedPoints: 0,
      gameWinningGoal: true,
      overtimeGoal: false,
      timeOnIceMinutes: 18,
    },
  },
  {
    id: 'forward-volume',
    label: 'Quiet volume game',
    detail: 'No points, 7 shots, 4 hits, 19 minutes',
    input: {
      goals: 0,
      primaryAssists: 0,
      secondaryAssists: 0,
      shotsOnGoal: 7,
      hits: 4,
      blockedShots: 1,
      plusMinus: 0,
      powerPlayPoints: 0,
      shortHandedPoints: 0,
      gameWinningGoal: false,
      overtimeGoal: false,
      timeOnIceMinutes: 19,
    },
  },
];

export const DEFENSE_SCORING_PRESETS: readonly PublicScoringCalculatorPreset<PublicSkaterCalculatorInput>[] = [
  {
    id: 'defense-offense',
    label: 'Offensive defense game',
    detail: 'Goal, primary assist, PP point, 3 blocks',
    input: {
      goals: 1,
      primaryAssists: 1,
      secondaryAssists: 0,
      shotsOnGoal: 3,
      hits: 2,
      blockedShots: 3,
      plusMinus: 2,
      powerPlayPoints: 1,
      shortHandedPoints: 0,
      gameWinningGoal: false,
      overtimeGoal: false,
      timeOnIceMinutes: 24,
    },
  },
  {
    id: 'defense-shutdown',
    label: 'Shutdown defense game',
    detail: 'No points, 3 hits, 6 blocks, 25 minutes',
    input: {
      goals: 0,
      primaryAssists: 0,
      secondaryAssists: 0,
      shotsOnGoal: 1,
      hits: 3,
      blockedShots: 6,
      plusMinus: 1,
      powerPlayPoints: 0,
      shortHandedPoints: 0,
      gameWinningGoal: false,
      overtimeGoal: false,
      timeOnIceMinutes: 25,
    },
  },
];

export const GOALIE_SCORING_PRESETS: readonly PublicScoringCalculatorPreset<PublicGoalieCalculatorInput>[] = [
  {
    id: 'goalie-efficient-win',
    label: 'Efficient win',
    detail: '28 saves on 30 shots',
    input: { saves: 28, shotsAgainst: 30, won: true, shutout: false },
  },
  {
    id: 'goalie-volume-loss',
    label: 'High-volume loss',
    detail: '34 saves on 40 shots',
    input: { saves: 34, shotsAgainst: 40, won: false, shutout: false },
  },
  {
    id: 'goalie-shutout',
    label: 'Shutout win',
    detail: '30 saves on 30 shots',
    input: { saves: 30, shotsAgainst: 30, won: true, shutout: true },
  },
];

const EMPTY_BREAKDOWN: GamePointBreakdown = { total: 0, lines: [] };

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validateWholeNumber(value: unknown, label: string, minimum: number, maximum: number): string | null {
  const parsed = finiteNumber(value);
  if (parsed === null || !Number.isInteger(parsed)) return `${label} must be a whole number.`;
  if (parsed < minimum || parsed > maximum) return `${label} must be between ${minimum} and ${maximum}.`;
  return null;
}

function invalidResult(errorMessage: string): PublicScoringCalculatorResult {
  return { valid: false, errorMessage, breakdown: EMPTY_BREAKDOWN, repeatedSixGameTotal: 0, savePercentage: null };
}

function validResult(breakdown: GamePointBreakdown, savePercentage: number | null): PublicScoringCalculatorResult {
  return {
    valid: true,
    errorMessage: '',
    breakdown,
    repeatedSixGameTotal: Number((breakdown.total * defaultScoringRules.requiredGamesPerCycle).toFixed(2)),
    savePercentage,
  };
}

export function calculatePublicSkaterScore(
  mode: Extract<PublicScoringCalculatorMode, 'forward' | 'defense'>,
  input: PublicSkaterCalculatorInput,
): PublicScoringCalculatorResult {
  const wholeNumberFields: Array<[unknown, string, number, number]> = [
    [input.goals, 'Goals', 0, 10],
    [input.primaryAssists, 'Primary assists', 0, 10],
    [input.secondaryAssists, 'Secondary assists', 0, 10],
    [input.shotsOnGoal, 'Shots on goal', 0, 30],
    [input.hits, 'Hits', 0, 30],
    [input.blockedShots, 'Blocked shots', 0, 30],
    [input.plusMinus, 'Plus/minus', -10, 10],
    [input.powerPlayPoints, 'Power-play points', 0, 10],
    [input.shortHandedPoints, 'Short-handed points', 0, 10],
  ];

  for (const [value, label, minimum, maximum] of wholeNumberFields) {
    const error = validateWholeNumber(value, label, minimum, maximum);
    if (error) return invalidResult(error);
  }

  const timeOnIceMinutes = finiteNumber(input.timeOnIceMinutes);
  if (timeOnIceMinutes === null || timeOnIceMinutes < 0 || timeOnIceMinutes > 60) {
    return invalidResult('Time on ice must be between 0 and 60 minutes.');
  }

  const scoringEvents = input.goals + input.primaryAssists + input.secondaryAssists;
  const specialTeamsPoints = input.powerPlayPoints + input.shortHandedPoints;
  if (specialTeamsPoints > scoringEvents) {
    return invalidResult('Power-play and short-handed points cannot exceed total goals and assists.');
  }
  if ((input.gameWinningGoal || input.overtimeGoal) && input.goals < 1) {
    return invalidResult('A game-winning or overtime goal requires at least one goal.');
  }
  if (input.overtimeGoal && !input.gameWinningGoal) {
    return invalidResult('An overtime goal is also game-winning. Select both bonuses.');
  }

  const stats: SkaterGameStats = { position: mode === 'defense' ? 'D' : 'F', ...input };
  return validResult(calculateSkaterGameBreakdown(stats, defaultScoringRules), null);
}

export function calculatePublicGoalieScore(input: PublicGoalieCalculatorInput): PublicScoringCalculatorResult {
  const savesError = validateWholeNumber(input.saves, 'Saves', 0, 100);
  if (savesError) return invalidResult(savesError);
  const shotsError = validateWholeNumber(input.shotsAgainst, 'Shots against', 0, 100);
  if (shotsError) return invalidResult(shotsError);
  if (input.saves > input.shotsAgainst) return invalidResult('Saves cannot exceed shots against.');
  if (input.shutout && input.saves !== input.shotsAgainst) {
    return invalidResult('A shutout requires saves to equal shots against.');
  }

  const stats: GoalieGameStats = { ...input };
  const savePercentage = input.shotsAgainst > 0 ? Number((input.saves / input.shotsAgainst).toFixed(3)) : 0;
  return validResult(calculateGoalieGameBreakdown(stats, defaultScoringRules), savePercentage);
}

export function formatPublicCalculatorPoints(value: number, signed = false): string {
  const normalized = Number.isInteger(value)
    ? value.toFixed(0)
    : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  if (!signed || value === 0) return normalized;
  return value > 0 ? `+${normalized}` : normalized;
}
