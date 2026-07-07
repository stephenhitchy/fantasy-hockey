export interface DiminishingReturnValues {
  first: number;
  second: number;
  additional: number;
}

export interface SkaterPositionScoringRules {
  goal: DiminishingReturnValues;
  primaryAssist: DiminishingReturnValues;
  secondaryAssist: DiminishingReturnValues;

  shotOnGoal: number;
  hit: number;
  blockedShot: number;

  powerPlayPoint: number;
  shortHandedPoint: number;
}

export interface GoalieSavePercentageTier {
  minSavePercentage: number;
  points: number;
}

export interface ScoringRules {
  requiredGamesPerCycle: number;

  forward: SkaterPositionScoringRules;
  defense: SkaterPositionScoringRules;

  gameWinningGoal: number;
  overtimeGoal: number;

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

  forward: {
    goal: {
      first: 6,
      second: 4,
      additional: 2.5
    },

    primaryAssist: {
      first: 5,
      second: 3.5,
      additional: 2.5
    },

    secondaryAssist: {
      first: 2.5,
      second: 1.5,
      additional: 0.5
    },

    shotOnGoal: 0.75,
    hit: 0.45,
    blockedShot: 0.75,

    powerPlayPoint: 1.25,
    shortHandedPoint: 3
  },

  defense: {
    goal: {
      first: 5,
      second: 3.25,
      additional: 2
    },

    primaryAssist: {
      first: 4.25,
      second: 3,
      additional: 2
    },

    secondaryAssist: {
      first: 2,
      second: 1.25,
      additional: 0.5
    },

    shotOnGoal: 0.45,
    hit: 0.5,
    blockedShot: .9,

    powerPlayPoint: 1,
    shortHandedPoint: 2
  },

  gameWinningGoal: 2,
  overtimeGoal: 2,

  forwardToiMultiplier: 0.2,

  defenseToiBaseMultiplier: 0.25,
  defenseToiPlusMinusModifier: 0.03,
  defenseToiFloor: 0.18,
  defenseToiCeiling: 0.36,

  goalieSave: 0.35,
  goalieWin: 6,
  goalieShutout: 10,

  goalieSavePercentageTiers: [
    { minSavePercentage: 0.945, points: 28 },
    { minSavePercentage: 0.935, points: 24 },
    { minSavePercentage: 0.925, points: 21 },
    { minSavePercentage: 0.915, points: 18 },
    { minSavePercentage: 0.9, points: 14 },
    { minSavePercentage: 0.88, points: 9 },
    { minSavePercentage: 0.85, points: 5 },
    { minSavePercentage: 0, points: 0 }
  ]
};