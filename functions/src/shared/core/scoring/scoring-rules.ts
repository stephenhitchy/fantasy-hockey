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

export const CURRENT_SCORING_RULES_VERSION = 3;
export const DEFAULT_GOALIE_GAME_MAXIMUM = 28;

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

  /** Stable participation value for one completed NHL team game. */
  goalieGameBase: number;
  goalieSave: number;
  goalieWin: number;
  goalieShutout: number;

  /**
   * Continuous save-quality model. The baseline should reflect the NHL scoring
   * environment and remains frozen with the league scoring rules so completed
   * games can always be reproduced deterministically.
   */
  goalieSavePercentageBaseline: number;
  goalieSavePercentageBasePoints: number;
  goalieSavePercentagePointsPerPercentagePoint: number;
  goalieSavePercentageMinimum: number;
  goalieSavePercentageMaximum: number;

  /** @deprecated Retained only so older league documents remain readable. */
  goalieSavePercentageTiers: GoalieSavePercentageTier[];

  /**
   * Maximum fantasy points a team goalie unit may earn from one NHL game.
   * With six games per cycle, the default creates a 168-point absolute ceiling.
   */
  goalieGameMaximum: number;
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
      first: 4.5,
      second: 2.75,
      additional: 1.5
    },

    primaryAssist: {
      first: 4,
      second: 2.75,
      additional: 1.5
    },

    secondaryAssist: {
      first: 1.75,
      second: 1,
      additional: 0.4
    },

    shotOnGoal: 0.4,
    hit: 0.55,
    blockedShot: 1.05,

    powerPlayPoint: 0.85,
    shortHandedPoint: 2
  },

  gameWinningGoal: 2,
  overtimeGoal: 2,

  forwardToiMultiplier: 0.2,

  defenseToiBaseMultiplier: 0.27,
  defenseToiPlusMinusModifier: 0.015,
  defenseToiFloor: 0.24,
  defenseToiCeiling: 0.31,

  goalieGameBase: 3,
  goalieSave: 0.27,
  goalieWin: 3.5,
  goalieShutout: 4,

  goalieSavePercentageBaseline: 0.9,
  goalieSavePercentageBasePoints: 4,
  goalieSavePercentagePointsPerPercentagePoint: 1.2,
  goalieSavePercentageMinimum: -3,
  goalieSavePercentageMaximum: 10,

  goalieSavePercentageTiers: [
    { minSavePercentage: 0.945, points: 15 },
    { minSavePercentage: 0.935, points: 13 },
    { minSavePercentage: 0.925, points: 11 },
    { minSavePercentage: 0.915, points: 9 },
    { minSavePercentage: 0.9, points: 6 },
    { minSavePercentage: 0.88, points: 3 },
    { minSavePercentage: 0.85, points: 1 },
    { minSavePercentage: 0, points: 0 }
  ],

  goalieGameMaximum: DEFAULT_GOALIE_GAME_MAXIMUM
};