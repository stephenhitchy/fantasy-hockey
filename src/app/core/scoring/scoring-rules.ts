export interface ScoringRules {
  requiredGamesPerCycle: number;

  goal: number;
  primaryAssist: number;
  secondaryAssist: number;
  shotOnGoal: number;
  hit: number;
  blockedShot: number;
  powerPlayPoint: number;
  shortHandedPoint: number;
  gameWinningGoal: number;
  overtimeGoal: number;
  twoGoalGameBonus: number;
  hatTrickBonus: number;

  forwardToiMultiplier: number;

  defenseToiBaseMultiplier: number;
  defenseToiPlusMinusModifier: number;
  defenseToiFloor: number;
  defenseToiCeiling: number;

  goalieSave: number;
  goalieWin: number;
  goalieShutout: number;
  goalieSavePercentageTiers: GoalieSavePercentageTier[];
}

export const defaultScoringRules: ScoringRules = {
  requiredGamesPerCycle: 6,

  goal: 8,
  primaryAssist: 5,
  secondaryAssist: 3,
  shotOnGoal: 0.6,
  hit: 0.45,
  blockedShot: 0.75,
  powerPlayPoint: 1.25,
  shortHandedPoint: 2,
  gameWinningGoal: 2,
  overtimeGoal: 2,
  twoGoalGameBonus: 2.5,
  hatTrickBonus: 5,

  forwardToiMultiplier: 0.12,

  defenseToiBaseMultiplier: 0.25,
  defenseToiPlusMinusModifier: 0.06,
  defenseToiFloor: 0.12,
  defenseToiCeiling: 0.36,

  goalieSave: 0.35,
  goalieWin: 6,
  goalieShutout: 10,

  goalieSavePercentageTiers: [
  { minSavePercentage: 0.945, points: 28 },
  { minSavePercentage: 0.935, points: 24 },
  { minSavePercentage: 0.925, points: 21 },
  { minSavePercentage: 0.915, points: 18 },
  { minSavePercentage: 0.900, points: 14 },
  { minSavePercentage: 0.880, points: 9 },
  { minSavePercentage: 0.850, points: 5 },
  { minSavePercentage: 0.000, points: 0 }
]
};

export interface GoalieSavePercentageTier {
  minSavePercentage: number;
  points: number;
}