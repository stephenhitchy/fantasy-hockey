import type { DraftPosition } from '../draft/draft.models';

export const PROJECTION_MODEL_VERSION = 11;

export type SkaterProjectionPosition = Exclude<DraftPosition, 'G'>;

export interface ProjectionSkaterStatLine {
  gamesPlayed: number;
  goals: number;
  assists: number;
  shotsOnGoal: number;
  hits: number;
  blockedShots: number;
  plusMinus: number;
  powerPlayPoints: number;
  shortHandedPoints: number;
  gameWinningGoals: number;
  overtimeGoals: number;
  averageTimeOnIceMinutes: number;
}

export interface ProjectionGoalieStatLine {
  gamesPlayed: number;
  saves: number;
  shotsAgainst: number;
  wins: number;
  shutouts: number;
}

export interface ProjectionV11SkaterRateResult {
  expectedStatsPer82: ProjectionSkaterStatLine;
  primaryAssistShare: number;
  shootingPercentage: number;
  shootingRegressionAdjustmentGoalsPer82: number;
  currentSeasonWeight: number;
  historicalWeight: number;
  modelConfidence: number;
  componentModelUsed: boolean;
}

export interface ProjectionV11GoalieRateResult {
  expectedStatsPer82: ProjectionGoalieStatLine;
  savePercentage: number;
  shotsAgainstPerGame: number;
  winRate: number;
  shutoutRate: number;
  currentSeasonWeight: number;
  historicalWeight: number;
  modelConfidence: number;
  componentModelUsed: boolean;
}

export interface ProjectionRangeResult {
  floor: number;
  ceiling: number;
  uncertainty: number;
}

type SkaterRateKey = Exclude<keyof ProjectionSkaterStatLine, 'gamesPlayed'>;

interface PositionRatePrior {
  goals: number;
  assists: number;
  shotsOnGoal: number;
  hits: number;
  blockedShots: number;
  plusMinus: number;
  powerPlayPoints: number;
  shortHandedPoints: number;
  gameWinningGoals: number;
  overtimeGoals: number;
  averageTimeOnIceMinutes: number;
  shootingPercentage: number;
  primaryAssistShare: number;
}

const POSITION_RATE_PRIORS: Record<SkaterProjectionPosition, PositionRatePrior> = {
  LW: {
    goals: 0.2,
    assists: 0.31,
    shotsOnGoal: 2.1,
    hits: 1.2,
    blockedShots: 0.45,
    plusMinus: 0,
    powerPlayPoints: 0.13,
    shortHandedPoints: 0.012,
    gameWinningGoals: 0.024,
    overtimeGoals: 0.006,
    averageTimeOnIceMinutes: 15.8,
    shootingPercentage: 0.105,
    primaryAssistShare: 0.56,
  },
  C: {
    goals: 0.2,
    assists: 0.36,
    shotsOnGoal: 2.15,
    hits: 0.95,
    blockedShots: 0.55,
    plusMinus: 0,
    powerPlayPoints: 0.15,
    shortHandedPoints: 0.018,
    gameWinningGoals: 0.024,
    overtimeGoals: 0.006,
    averageTimeOnIceMinutes: 16.2,
    shootingPercentage: 0.105,
    primaryAssistShare: 0.56,
  },
  RW: {
    goals: 0.2,
    assists: 0.31,
    shotsOnGoal: 2.1,
    hits: 1.2,
    blockedShots: 0.45,
    plusMinus: 0,
    powerPlayPoints: 0.13,
    shortHandedPoints: 0.012,
    gameWinningGoals: 0.024,
    overtimeGoals: 0.006,
    averageTimeOnIceMinutes: 15.8,
    shootingPercentage: 0.105,
    primaryAssistShare: 0.56,
  },
  D: {
    goals: 0.08,
    assists: 0.28,
    shotsOnGoal: 1.55,
    hits: 1.25,
    blockedShots: 1.45,
    plusMinus: 0,
    powerPlayPoints: 0.11,
    shortHandedPoints: 0.01,
    gameWinningGoals: 0.01,
    overtimeGoals: 0.003,
    averageTimeOnIceMinutes: 19.2,
    shootingPercentage: 0.06,
    primaryAssistShare: 0.53,
  },
};

/**
 * Approximate games needed before the current-season rate carries half of the
 * component forecast. Opportunity stats stabilize faster than finishing and
 * rare-event stats, so a hot goal/GWG week cannot overwhelm a stable role.
 */
const STABILIZATION_GAMES: Record<SkaterRateKey, number> = {
  goals: 38,
  assists: 30,
  shotsOnGoal: 12,
  hits: 15,
  blockedShots: 15,
  plusMinus: 65,
  powerPlayPoints: 34,
  shortHandedPoints: 90,
  gameWinningGoals: 95,
  overtimeGoals: 120,
  averageTimeOnIceMinutes: 8,
};

const SKATER_RATE_KEYS: SkaterRateKey[] = [
  'goals',
  'assists',
  'shotsOnGoal',
  'hits',
  'blockedShots',
  'plusMinus',
  'powerPlayPoints',
  'shortHandedPoints',
  'gameWinningGoals',
  'overtimeGoals',
  'averageTimeOnIceMinutes',
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeGamesPlayed(stats: Partial<ProjectionSkaterStatLine> | undefined): number {
  return Math.max(0, Math.floor(finiteOrZero(stats?.gamesPlayed)));
}

function normalizeGoalieGamesPlayed(stats: Partial<ProjectionGoalieStatLine> | undefined): number {
  return Math.max(0, Math.floor(finiteOrZero(stats?.gamesPlayed)));
}

function getSkaterRate(
  stats: Partial<ProjectionSkaterStatLine> | undefined,
  key: SkaterRateKey,
): number | null {
  const gamesPlayed = normalizeGamesPlayed(stats);

  if (gamesPlayed <= 0) {
    return null;
  }

  const value = finiteOrZero(stats?.[key]);

  if (key === 'averageTimeOnIceMinutes') {
    return value > 0 ? value : null;
  }

  return value / gamesPlayed;
}

function weightedAverage(
  values: Array<{ value: number | null; weight: number }>,
  fallback: number,
): number {
  const valid = values.filter(
    (entry): entry is { value: number; weight: number } =>
      entry.value !== null && Number.isFinite(entry.value) && entry.weight > 0,
  );
  const totalWeight = valid.reduce((total, entry) => total + entry.weight, 0);

  if (totalWeight <= 0) {
    return fallback;
  }

  return valid.reduce(
    (total, entry) => total + entry.value * entry.weight / totalWeight,
    0,
  );
}

function getHistoricalRate(input: {
  key: SkaterRateKey;
  prior: PositionRatePrior;
  latestCompletedStats?: Partial<ProjectionSkaterStatLine>;
  previousCompletedStats?: Partial<ProjectionSkaterStatLine>;
  latestSeasonWeight: number;
  previousSeasonWeight: number;
}): number {
  const latestGames = normalizeGamesPlayed(input.latestCompletedStats);
  const previousGames = normalizeGamesPlayed(input.previousCompletedStats);
  const stabilizationGames = STABILIZATION_GAMES[input.key];
  const priorValue = input.prior[input.key];
  const latestSampleWeight = clamp(
    latestGames / Math.max(12, stabilizationGames),
    latestGames > 0 ? 0.2 : 0,
    1,
  );
  const previousSampleWeight = clamp(
    previousGames / Math.max(12, stabilizationGames),
    previousGames > 0 ? 0.15 : 0,
    1,
  );

  return weightedAverage(
    [
      {
        value: getSkaterRate(input.latestCompletedStats, input.key),
        weight: input.latestSeasonWeight * latestSampleWeight,
      },
      {
        value: getSkaterRate(input.previousCompletedStats, input.key),
        weight: input.previousSeasonWeight * previousSampleWeight,
      },
      {
        value: priorValue,
        weight: 0.08,
      },
    ],
    priorValue,
  );
}

function getCurrentComponentWeight(gamesPlayed: number, key: SkaterRateKey): number {
  if (gamesPlayed <= 0) {
    return 0;
  }

  const stabilizationGames = STABILIZATION_GAMES[key];
  return clamp(gamesPlayed / (gamesPlayed + stabilizationGames), 0.03, 0.9);
}

function getShootingPercentage(
  stats: Partial<ProjectionSkaterStatLine> | undefined,
): number | null {
  const shots = finiteOrZero(stats?.shotsOnGoal);
  const goals = finiteOrZero(stats?.goals);

  if (shots <= 0) {
    return null;
  }

  return goals / shots;
}

function getHistoricalShootingPercentage(input: {
  prior: PositionRatePrior;
  latestCompletedStats?: Partial<ProjectionSkaterStatLine>;
  previousCompletedStats?: Partial<ProjectionSkaterStatLine>;
  latestSeasonWeight: number;
  previousSeasonWeight: number;
}): number {
  const latestShots = finiteOrZero(input.latestCompletedStats?.shotsOnGoal);
  const previousShots = finiteOrZero(input.previousCompletedStats?.shotsOnGoal);

  return weightedAverage(
    [
      {
        value: getShootingPercentage(input.latestCompletedStats),
        weight: input.latestSeasonWeight * clamp(latestShots / 180, 0, 1),
      },
      {
        value: getShootingPercentage(input.previousCompletedStats),
        weight: input.previousSeasonWeight * clamp(previousShots / 180, 0, 1),
      },
      {
        value: input.prior.shootingPercentage,
        weight: 0.22,
      },
    ],
    input.prior.shootingPercentage,
  );
}

export function getProjectionPrimaryAssistShare(position: DraftPosition): number {
  return position === 'D'
    ? POSITION_RATE_PRIORS.D.primaryAssistShare
    : POSITION_RATE_PRIORS[position === 'G' ? 'C' : position].primaryAssistShare;
}

/**
 * Projection V11 builds a stat-component ensemble instead of blending only
 * total fantasy-point pace. Stable opportunity categories (TOI, shots, hits,
 * blocks) can react quickly, while goals, power-play output, plus/minus and
 * rare bonuses receive stronger regression. Missed team games never enter as
 * zero appearances because every input is normalized by games played.
 */
export function buildProjectionV11SkaterRates(input: {
  position: SkaterProjectionPosition;
  currentStats?: Partial<ProjectionSkaterStatLine>;
  latestCompletedStats?: Partial<ProjectionSkaterStatLine>;
  previousCompletedStats?: Partial<ProjectionSkaterStatLine>;
  latestSeasonWeight?: number;
  previousSeasonWeight?: number;
}): ProjectionV11SkaterRateResult {
  const prior = POSITION_RATE_PRIORS[input.position];
  const latestSeasonWeight = clamp(input.latestSeasonWeight ?? 0.72, 0.45, 0.92);
  const previousSeasonWeight = clamp(input.previousSeasonWeight ?? 0.2, 0.04, 0.45);
  const currentGames = normalizeGamesPlayed(input.currentStats);
  const latestGames = normalizeGamesPlayed(input.latestCompletedStats);
  const previousGames = normalizeGamesPlayed(input.previousCompletedStats);
  const rates = {} as Record<SkaterRateKey, number>;
  const currentWeights: number[] = [];

  for (const key of SKATER_RATE_KEYS) {
    const historicalRate = getHistoricalRate({
      key,
      prior,
      latestCompletedStats: input.latestCompletedStats,
      previousCompletedStats: input.previousCompletedStats,
      latestSeasonWeight,
      previousSeasonWeight,
    });
    const currentRate = getSkaterRate(input.currentStats, key);
    const currentWeight = currentRate === null
      ? 0
      : getCurrentComponentWeight(currentGames, key);

    rates[key] = currentRate === null
      ? historicalRate
      : currentRate * currentWeight + historicalRate * (1 - currentWeight);
    currentWeights.push(currentWeight);
  }

  const historicalShootingPercentage = getHistoricalShootingPercentage({
    prior,
    latestCompletedStats: input.latestCompletedStats,
    previousCompletedStats: input.previousCompletedStats,
    latestSeasonWeight,
    previousSeasonWeight,
  });
  const currentShots = finiteOrZero(input.currentStats?.shotsOnGoal);
  const currentShootingPercentage = getShootingPercentage(input.currentStats);
  const currentShootingWeight = currentShootingPercentage === null
    ? 0
    : clamp(currentShots / (currentShots + 260), 0.02, 0.72);
  const shootingPercentage = clamp(
    currentShootingPercentage === null
      ? historicalShootingPercentage
      : currentShootingPercentage * currentShootingWeight +
        historicalShootingPercentage * (1 - currentShootingWeight),
    input.position === 'D' ? 0.025 : 0.045,
    input.position === 'D' ? 0.14 : 0.22,
  );
  const directGoalRate = rates.goals;
  const shotDerivedGoalRate = rates.shotsOnGoal * shootingPercentage;

  // Most of the goal forecast comes from shot volume and a regressed finish
  // rate, while a smaller direct-rate share preserves genuine elite finishers.
  rates.goals = directGoalRate * 0.35 + shotDerivedGoalRate * 0.65;

  // Plus/minus only changes the defense TOI multiplier in production scoring.
  // It is noisy year to year, so keep a smaller portion of the observed rate.
  rates.plusMinus = clamp(rates.plusMinus * 0.45, -0.65, 0.65);

  const expectedStatsPer82: ProjectionSkaterStatLine = {
    gamesPlayed: 82,
    goals: Math.max(0, rates.goals * 82),
    assists: Math.max(0, rates.assists * 82),
    shotsOnGoal: Math.max(0, rates.shotsOnGoal * 82),
    hits: Math.max(0, rates.hits * 82),
    blockedShots: Math.max(0, rates.blockedShots * 82),
    plusMinus: rates.plusMinus * 82,
    powerPlayPoints: Math.max(0, rates.powerPlayPoints * 82),
    shortHandedPoints: Math.max(0, rates.shortHandedPoints * 82),
    gameWinningGoals: Math.max(0, rates.gameWinningGoals * 82),
    overtimeGoals: Math.max(0, rates.overtimeGoals * 82),
    averageTimeOnIceMinutes: clamp(
      rates.averageTimeOnIceMinutes,
      input.position === 'D' ? 10 : 8,
      input.position === 'D' ? 30 : 25,
    ),
  };
  const averageCurrentWeight = currentWeights.reduce((total, weight) => total + weight, 0) /
    Math.max(1, currentWeights.length);
  const historyEquivalentGames = latestGames * 0.72 + previousGames * 0.28;
  const statCoverage = SKATER_RATE_KEYS.filter((key) =>
    getSkaterRate(input.currentStats, key) !== null ||
    getSkaterRate(input.latestCompletedStats, key) !== null ||
    getSkaterRate(input.previousCompletedStats, key) !== null
  ).length / SKATER_RATE_KEYS.length;
  const modelConfidence = clamp(
    34 +
      clamp(currentGames / 45, 0, 1) * 24 +
      clamp(historyEquivalentGames / 82, 0, 1) * 30 +
      statCoverage * 10,
    35,
    97,
  );

  return {
    expectedStatsPer82,
    primaryAssistShare: prior.primaryAssistShare,
    shootingPercentage,
    shootingRegressionAdjustmentGoalsPer82: (rates.goals - directGoalRate) * 82,
    currentSeasonWeight: averageCurrentWeight,
    historicalWeight: 1 - averageCurrentWeight,
    modelConfidence,
    componentModelUsed: currentGames + latestGames + previousGames > 0,
  };
}

function getGoalieRate(
  stats: Partial<ProjectionGoalieStatLine> | undefined,
  key: 'shotsAgainst' | 'wins' | 'shutouts',
): number | null {
  const gamesPlayed = normalizeGoalieGamesPlayed(stats);

  if (gamesPlayed <= 0) {
    return null;
  }

  return finiteOrZero(stats?.[key]) / gamesPlayed;
}

function getGoalieSavePercentage(
  stats: Partial<ProjectionGoalieStatLine> | undefined,
): number | null {
  const shotsAgainst = finiteOrZero(stats?.shotsAgainst);

  if (shotsAgainst <= 0) {
    return null;
  }

  return finiteOrZero(stats?.saves) / shotsAgainst;
}

export function buildProjectionV11GoalieRates(input: {
  currentStats?: Partial<ProjectionGoalieStatLine>;
  latestCompletedStats?: Partial<ProjectionGoalieStatLine>;
  previousCompletedStats?: Partial<ProjectionGoalieStatLine>;
}): ProjectionV11GoalieRateResult {
  const currentGames = normalizeGoalieGamesPlayed(input.currentStats);
  const latestGames = normalizeGoalieGamesPlayed(input.latestCompletedStats);
  const previousGames = normalizeGoalieGamesPlayed(input.previousCompletedStats);
  const historicalShotsPerGame = weightedAverage(
    [
      { value: getGoalieRate(input.latestCompletedStats, 'shotsAgainst'), weight: latestGames > 0 ? 0.72 : 0 },
      { value: getGoalieRate(input.previousCompletedStats, 'shotsAgainst'), weight: previousGames > 0 ? 0.2 : 0 },
      { value: 30, weight: 0.08 },
    ],
    30,
  );
  const currentShotsPerGame = getGoalieRate(input.currentStats, 'shotsAgainst');
  const shotsCurrentWeight = currentShotsPerGame === null
    ? 0
    : clamp(currentGames / (currentGames + 15), 0.04, 0.86);
  const shotsAgainstPerGame = currentShotsPerGame === null
    ? historicalShotsPerGame
    : currentShotsPerGame * shotsCurrentWeight + historicalShotsPerGame * (1 - shotsCurrentWeight);
  const historicalSavePercentage = weightedAverage(
    [
      {
        value: getGoalieSavePercentage(input.latestCompletedStats),
        weight: clamp(finiteOrZero(input.latestCompletedStats?.shotsAgainst) / 1500, 0, 1) * 0.72,
      },
      {
        value: getGoalieSavePercentage(input.previousCompletedStats),
        weight: clamp(finiteOrZero(input.previousCompletedStats?.shotsAgainst) / 1500, 0, 1) * 0.2,
      },
      { value: 0.9, weight: 0.18 },
    ],
    0.9,
  );
  const currentSavePercentage = getGoalieSavePercentage(input.currentStats);
  const currentSaveWeight = currentSavePercentage === null
    ? 0
    : clamp(finiteOrZero(input.currentStats?.shotsAgainst) /
      (finiteOrZero(input.currentStats?.shotsAgainst) + 1300), 0.02, 0.72);
  const savePercentage = clamp(
    currentSavePercentage === null
      ? historicalSavePercentage
      : currentSavePercentage * currentSaveWeight +
        historicalSavePercentage * (1 - currentSaveWeight),
    0.865,
    0.94,
  );

  const blendGoalieRate = (
    key: 'wins' | 'shutouts',
    fallback: number,
    stabilizationGames: number,
  ): { value: number; currentWeight: number } => {
    const historical = weightedAverage(
      [
        { value: getGoalieRate(input.latestCompletedStats, key), weight: latestGames > 0 ? 0.72 : 0 },
        { value: getGoalieRate(input.previousCompletedStats, key), weight: previousGames > 0 ? 0.2 : 0 },
        { value: fallback, weight: 0.08 },
      ],
      fallback,
    );
    const current = getGoalieRate(input.currentStats, key);
    const currentWeight = current === null
      ? 0
      : clamp(currentGames / (currentGames + stabilizationGames), 0.03, 0.84);

    return {
      value: current === null ? historical : current * currentWeight + historical * (1 - currentWeight),
      currentWeight,
    };
  };

  const winRateResult = blendGoalieRate('wins', 0.5, 28);
  const shutoutRateResult = blendGoalieRate('shutouts', 0.055, 65);
  const winRate = clamp(winRateResult.value, 0.22, 0.78);
  const shutoutRate = clamp(shutoutRateResult.value, 0.005, 0.18);
  const currentSeasonWeight = (
    shotsCurrentWeight + currentSaveWeight + winRateResult.currentWeight + shutoutRateResult.currentWeight
  ) / 4;
  const historyEquivalentGames = latestGames * 0.72 + previousGames * 0.28;
  const modelConfidence = clamp(
    42 +
      clamp(currentGames / 35, 0, 1) * 24 +
      clamp(historyEquivalentGames / 82, 0, 1) * 30,
    45,
    97,
  );
  const expectedShotsAgainst = shotsAgainstPerGame * 82;

  return {
    expectedStatsPer82: {
      gamesPlayed: 82,
      saves: expectedShotsAgainst * savePercentage,
      shotsAgainst: expectedShotsAgainst,
      wins: winRate * 82,
      shutouts: shutoutRate * 82,
    },
    savePercentage,
    shotsAgainstPerGame,
    winRate,
    shutoutRate,
    currentSeasonWeight,
    historicalWeight: 1 - currentSeasonWeight,
    modelConfidence,
    componentModelUsed: currentGames + latestGames + previousGames > 0,
  };
}

export function calculateProjectionV11Range(input: {
  mean: number;
  recentGameStandardDeviation?: number | null;
  recentSampleSize?: number | null;
  expectedGames: number;
  reliabilityRating?: number | null;
  position: DraftPosition;
}): ProjectionRangeResult {
  const mean = Math.max(0, input.mean);
  const expectedGames = Math.max(0.5, input.expectedGames);
  const sampleSize = Math.max(0, finiteOrZero(input.recentSampleSize));
  const reliability = clamp(finiteOrZero(input.reliabilityRating) || 55, 20, 99);
  const baselineRate = input.position === 'D'
    ? 0.18
    : input.position === 'G'
      ? 0.2
      : 0.22;
  const baselineUncertainty = mean * baselineRate;
  const observedStandardDeviation = finiteOrZero(input.recentGameStandardDeviation);
  const observedWindowUncertainty = observedStandardDeviation > 0
    ? observedStandardDeviation * Math.sqrt(expectedGames)
    : baselineUncertainty;
  const observedWeight = clamp(sampleSize / 24, 0, 0.75);
  const reliabilityMultiplier = clamp(1 + (70 - reliability) / 180, 0.82, 1.28);
  const rawUncertainty = (
    observedWindowUncertainty * observedWeight +
    baselineUncertainty * (1 - observedWeight)
  ) * reliabilityMultiplier;
  const uncertainty = clamp(
    rawUncertainty,
    mean * 0.1,
    mean * (input.position === 'G' ? 0.32 : 0.38),
  );
  const likelyHalfRange = uncertainty * 0.7;

  return {
    floor: Math.max(0, mean - likelyHalfRange),
    ceiling: mean + likelyHalfRange,
    uncertainty,
  };
}
