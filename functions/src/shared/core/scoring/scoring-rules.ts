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

export const SCORING_RULES_V3_VERSION = 3;
export const CURRENT_SCORING_RULES_VERSION = 4;

/** Legacy Production Scoring V3 goalie maximum. V4 is intentionally uncapped. */
export const DEFAULT_GOALIE_GAME_MAXIMUM = 28;
export const UNLIMITED_GOALIE_GAME_MAXIMUM = 0;

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
   * Positive values cap one NHL team-goalie game. Zero means uncapped. Existing
   * V3 leagues retain 28; Production Scoring V4 uses zero so extraordinary
   * performances remain visible instead of being flattened.
   */
  goalieGameMaximum: number;
}

const sharedSkaterRules = {
  requiredGamesPerCycle: 6,

  forward: {
    goal: {
      first: 6,
      second: 4,
      additional: 2.5,
    },

    primaryAssist: {
      first: 5,
      second: 3.5,
      additional: 2.5,
    },

    secondaryAssist: {
      first: 2.5,
      second: 1.5,
      additional: 0.5,
    },

    shotOnGoal: 0.75,
    hit: 0.45,
    blockedShot: 0.75,

    powerPlayPoint: 1.25,
    shortHandedPoint: 3,
  },

  defense: {
    goal: {
      first: 4.5,
      second: 2.75,
      additional: 1.5,
    },

    primaryAssist: {
      first: 4,
      second: 2.75,
      additional: 1.5,
    },

    secondaryAssist: {
      first: 1.75,
      second: 1,
      additional: 0.4,
    },

    shotOnGoal: 0.4,
    hit: 0.55,
    blockedShot: 1.05,

    powerPlayPoint: 0.85,
    shortHandedPoint: 2,
  },

  gameWinningGoal: 2,
  overtimeGoal: 2,

  forwardToiMultiplier: 0.2,

  defenseToiBaseMultiplier: 0.27,
  defenseToiPlusMinusModifier: 0.015,
  defenseToiFloor: 0.24,
  defenseToiCeiling: 0.31,

  goalieSavePercentageTiers: [
    { minSavePercentage: 0.945, points: 15 },
    { minSavePercentage: 0.935, points: 13 },
    { minSavePercentage: 0.925, points: 11 },
    { minSavePercentage: 0.915, points: 9 },
    { minSavePercentage: 0.9, points: 6 },
    { minSavePercentage: 0.88, points: 3 },
    { minSavePercentage: 0.85, points: 1 },
    { minSavePercentage: 0, points: 0 },
  ],
} satisfies Partial<ScoringRules>;

/** Exact legacy rules retained for already-created Scoring V3 leagues. */
export const scoringRulesV3: ScoringRules = {
  ...sharedSkaterRules,
  forward: {
    ...sharedSkaterRules.forward,
    goal: { ...sharedSkaterRules.forward.goal },
    primaryAssist: { ...sharedSkaterRules.forward.primaryAssist },
    secondaryAssist: { ...sharedSkaterRules.forward.secondaryAssist },
  },
  defense: {
    ...sharedSkaterRules.defense,
    goal: { ...sharedSkaterRules.defense.goal },
    primaryAssist: { ...sharedSkaterRules.defense.primaryAssist },
    secondaryAssist: { ...sharedSkaterRules.defense.secondaryAssist },
  },
  goalieSavePercentageTiers: sharedSkaterRules.goalieSavePercentageTiers.map(
    (tier) => ({ ...tier }),
  ),

  goalieGameBase: 3,
  goalieSave: 0.27,
  goalieWin: 3.5,
  goalieShutout: 4,

  goalieSavePercentageBaseline: 0.9,
  goalieSavePercentageBasePoints: 4,
  goalieSavePercentagePointsPerPercentagePoint: 1.2,
  goalieSavePercentageMinimum: -3,
  goalieSavePercentageMaximum: 10,

  goalieGameMaximum: DEFAULT_GOALIE_GAME_MAXIMUM,
};

/**
 * Production Scoring V4 keeps every skater value unchanged and rebalances only
 * the team-goalie unit. Lower participation/save background points, stronger
 * win/efficiency/shutout rewards, a wider quality curve, and no game cap create
 * more separation between elite, average, and poor units without making raw
 * goalie totals comparable to skaters.
 */
export const defaultScoringRules: ScoringRules = {
  ...sharedSkaterRules,
  forward: {
    ...sharedSkaterRules.forward,
    goal: { ...sharedSkaterRules.forward.goal },
    primaryAssist: { ...sharedSkaterRules.forward.primaryAssist },
    secondaryAssist: { ...sharedSkaterRules.forward.secondaryAssist },
  },
  defense: {
    ...sharedSkaterRules.defense,
    goal: { ...sharedSkaterRules.defense.goal },
    primaryAssist: { ...sharedSkaterRules.defense.primaryAssist },
    secondaryAssist: { ...sharedSkaterRules.defense.secondaryAssist },
  },
  goalieSavePercentageTiers: sharedSkaterRules.goalieSavePercentageTiers.map(
    (tier) => ({ ...tier }),
  ),

  goalieGameBase: 2,
  goalieSave: 0.2,
  goalieWin: 5,
  goalieShutout: 5,

  goalieSavePercentageBaseline: 0.9,
  goalieSavePercentageBasePoints: 3,
  goalieSavePercentagePointsPerPercentagePoint: 1.8,
  goalieSavePercentageMinimum: -6,
  goalieSavePercentageMaximum: 14,

  goalieGameMaximum: UNLIMITED_GOALIE_GAME_MAXIMUM,
};

export function scoringRulesForVersion(version: unknown): ScoringRules {
  const source =
    typeof version === 'number' && version >= CURRENT_SCORING_RULES_VERSION
      ? defaultScoringRules
      : scoringRulesV3;

  return {
    ...source,
    forward: {
      ...source.forward,
      goal: { ...source.forward.goal },
      primaryAssist: { ...source.forward.primaryAssist },
      secondaryAssist: { ...source.forward.secondaryAssist },
    },
    defense: {
      ...source.defense,
      goal: { ...source.defense.goal },
      primaryAssist: { ...source.defense.primaryAssist },
      secondaryAssist: { ...source.defense.secondaryAssist },
    },
    goalieSavePercentageTiers: source.goalieSavePercentageTiers.map(
      (tier) => ({ ...tier }),
    ),
  };
}
