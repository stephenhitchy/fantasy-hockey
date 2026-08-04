import type { DraftPosition } from '../draft/draft.models';

export type DraftTrajectoryLabel =
  | 'breakout'
  | 'rising'
  | 'stable'
  | 'declining'
  | 'insufficient-data';

export interface DraftTrajectorySeasonInput {
  pace: number | null;
  gamesPlayed: number;
  averageTimeOnIceMinutes?: number | null;
  shotsPerGame?: number | null;
  powerPlayPointsPerGame?: number | null;
}

export interface DraftTrajectoryAssessment {
  label: DraftTrajectoryLabel;
  confidence: number;
  latestSeasonWeight: number;
  previousSeasonWeight: number;
  conservativeBaselineWeight: number;
  maximumPositiveUpliftRate: number;
  paceChangeRate: number | null;
  supportingSignalCount: number;
  playerAge: number | null;
}

export interface StableDraftProjectionInput {
  position: DraftPosition;
  currentPace: number | null;
  currentGamesPlayed: number;
  latestCompletedSeason: DraftTrajectorySeasonInput;
  previousCompletedSeason: DraftTrajectorySeasonInput;
  conservativeBaseline: number;
  birthDate?: string | null;
  projectionDate?: Date;
  capProjectionBySample: (
    projection: number,
    position: DraftPosition,
    gamesPlayed: number,
  ) => number;
}

export interface StableDraftProjectionResult {
  projectedSeasonPoints: number;
  stableSeasonPoints: number;
  trajectoryLabel: DraftTrajectoryLabel;
  trajectoryConfidence: number;
  trajectoryAdjustment: number;
  latestSeasonWeight: number;
  paceChangeRate: number | null;
  supportingSignalCount: number;
  playerAge: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeRate(
  latest: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (
    typeof latest !== 'number' ||
    !Number.isFinite(latest) ||
    typeof previous !== 'number' ||
    !Number.isFinite(previous) ||
    previous <= 0
  ) {
    return null;
  }

  return latest / previous - 1;
}

export function getProjectionPlayerAge(
  birthDate: string | null | undefined,
  projectionDate: Date = new Date(),
): number | null {
  if (!birthDate || Number.isNaN(projectionDate.getTime())) {
    return null;
  }

  const parsed = new Date(`${birthDate.slice(0, 10)}T12:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  let age = projectionDate.getUTCFullYear() - parsed.getUTCFullYear();
  const monthDifference = projectionDate.getUTCMonth() - parsed.getUTCMonth();

  if (
    monthDifference < 0 ||
    (monthDifference === 0 && projectionDate.getUTCDate() < parsed.getUTCDate())
  ) {
    age -= 1;
  }

  return age >= 15 && age <= 50 ? age : null;
}

function getStableWeights(): Pick<
  DraftTrajectoryAssessment,
  'latestSeasonWeight' | 'previousSeasonWeight' | 'conservativeBaselineWeight'
> {
  return {
    latestSeasonWeight: 0.7,
    previousSeasonWeight: 0.2,
    conservativeBaselineWeight: 0.1,
  };
}

function getAgeSupport(playerAge: number | null): number {
  if (playerAge === null) {
    return 0.55;
  }

  if (playerAge <= 21) {
    return 1;
  }

  if (playerAge <= 23) {
    return 0.94;
  }

  if (playerAge <= 25) {
    return 0.82;
  }

  if (playerAge <= 28) {
    return 0.62;
  }

  if (playerAge <= 31) {
    return 0.42;
  }

  return 0.24;
}

function getBreakoutWeights(playerAge: number | null): {
  latestSeasonWeight: number;
  previousSeasonWeight: number;
  conservativeBaselineWeight: number;
  maximumPositiveUpliftRate: number;
} {
  if (playerAge !== null && playerAge <= 23) {
    return {
      latestSeasonWeight: 0.86,
      previousSeasonWeight: 0.11,
      conservativeBaselineWeight: 0.03,
      maximumPositiveUpliftRate: 0.1,
    };
  }

  if (playerAge !== null && playerAge >= 30) {
    return {
      latestSeasonWeight: 0.78,
      previousSeasonWeight: 0.16,
      conservativeBaselineWeight: 0.06,
      maximumPositiveUpliftRate: 0.04,
    };
  }

  return {
    latestSeasonWeight: 0.83,
    previousSeasonWeight: 0.13,
    conservativeBaselineWeight: 0.04,
    maximumPositiveUpliftRate: 0.08,
  };
}

function getRisingWeights(playerAge: number | null): {
  latestSeasonWeight: number;
  previousSeasonWeight: number;
  conservativeBaselineWeight: number;
  maximumPositiveUpliftRate: number;
} {
  if (playerAge !== null && playerAge <= 24) {
    return {
      latestSeasonWeight: 0.8,
      previousSeasonWeight: 0.15,
      conservativeBaselineWeight: 0.05,
      maximumPositiveUpliftRate: 0.065,
    };
  }

  if (playerAge !== null && playerAge >= 30) {
    return {
      latestSeasonWeight: 0.75,
      previousSeasonWeight: 0.18,
      conservativeBaselineWeight: 0.07,
      maximumPositiveUpliftRate: 0.03,
    };
  }

  return {
    latestSeasonWeight: 0.78,
    previousSeasonWeight: 0.16,
    conservativeBaselineWeight: 0.06,
    maximumPositiveUpliftRate: 0.05,
  };
}

/**
 * Projection V11 separates missed-game availability from healthy production.
 * The trajectory detector decides how quickly a supported completed-season
 * breakout or decline should affect the next draft outlook. It never inserts
 * missed NHL team games as zero-point appearances. Age only changes confidence
 * and the size of a bounded uplift; it can never create a breakout by itself.
 */
export function assessDraftTrajectory(input: {
  position: DraftPosition;
  latestCompletedSeason: DraftTrajectorySeasonInput;
  previousCompletedSeason: DraftTrajectorySeasonInput;
  birthDate?: string | null;
  projectionDate?: Date;
}): DraftTrajectoryAssessment {
  const stableWeights = getStableWeights();
  const latest = input.latestCompletedSeason;
  const previous = input.previousCompletedSeason;
  const paceChangeRate = safeRate(latest.pace, previous.pace);
  const playerAge = getProjectionPlayerAge(input.birthDate, input.projectionDate);

  if (
    input.position === 'G' ||
    paceChangeRate === null ||
    latest.gamesPlayed < 35 ||
    previous.gamesPlayed < 20
  ) {
    return {
      label: 'insufficient-data',
      confidence: 0,
      ...stableWeights,
      maximumPositiveUpliftRate: 0,
      paceChangeRate,
      supportingSignalCount: 0,
      playerAge,
    };
  }

  const timeOnIceChangeRate = safeRate(
    latest.averageTimeOnIceMinutes,
    previous.averageTimeOnIceMinutes,
  );
  const shotRateChange = safeRate(latest.shotsPerGame, previous.shotsPerGame);
  const powerPlayRateChange = safeRate(
    latest.powerPlayPointsPerGame,
    previous.powerPlayPointsPerGame,
  );
  const supportingSignalCount = [
    timeOnIceChangeRate !== null && timeOnIceChangeRate >= 0.055,
    shotRateChange !== null && shotRateChange >= 0.075,
    powerPlayRateChange !== null && powerPlayRateChange >= 0.08,
  ].filter(Boolean).length;
  const sampleConfidence = clamp((latest.gamesPlayed - 35) / 40, 0.25, 1);
  const historyConfidence = clamp(previous.gamesPlayed / 60, 0.35, 1);
  const ageSupport = getAgeSupport(playerAge);
  const confidence = Math.round(
    clamp(
      (
        sampleConfidence * 0.5 +
        historyConfidence * 0.24 +
        ageSupport * 0.11 +
        supportingSignalCount * 0.05
      ) * 100,
      25,
      100,
    ),
  );

  const isBreakout =
    latest.gamesPlayed >= 50 &&
    paceChangeRate >= 0.2 &&
    (supportingSignalCount >= 1 || paceChangeRate >= 0.34);

  if (isBreakout) {
    return {
      label: 'breakout',
      confidence,
      ...getBreakoutWeights(playerAge),
      paceChangeRate,
      supportingSignalCount,
      playerAge,
    };
  }

  const isRising =
    latest.gamesPlayed >= 45 &&
    paceChangeRate >= 0.1 &&
    (supportingSignalCount >= 1 || paceChangeRate >= 0.18);

  if (isRising) {
    return {
      label: 'rising',
      confidence,
      ...getRisingWeights(playerAge),
      paceChangeRate,
      supportingSignalCount,
      playerAge,
    };
  }

  if (latest.gamesPlayed >= 50 && paceChangeRate <= -0.15) {
    return {
      label: 'declining',
      confidence,
      latestSeasonWeight: playerAge !== null && playerAge >= 30 ? 0.82 : 0.78,
      previousSeasonWeight: playerAge !== null && playerAge >= 30 ? 0.13 : 0.16,
      conservativeBaselineWeight: 0.05,
      maximumPositiveUpliftRate: 0,
      paceChangeRate,
      supportingSignalCount,
      playerAge,
    };
  }

  return {
    label: 'stable',
    confidence,
    ...stableWeights,
    maximumPositiveUpliftRate: 0,
    paceChangeRate,
    supportingSignalCount,
    playerAge,
  };
}

function calculateHistoricalProjection(input: {
  latestProjection: number | null;
  previousProjection: number | null;
  conservativeBaseline: number;
  latestWeight: number;
  previousWeight: number;
  baselineWeight: number;
}): number {
  const candidates: Array<{ projection: number; weight: number }> = [];

  if (input.latestProjection !== null) {
    candidates.push({
      projection: input.latestProjection,
      weight: input.latestWeight,
    });
  }

  if (input.previousProjection !== null) {
    candidates.push({
      projection: input.previousProjection,
      weight: input.previousWeight,
    });
  }

  candidates.push({
    projection: input.conservativeBaseline,
    weight: input.baselineWeight,
  });

  const weightTotal = candidates.reduce((total, candidate) => total + candidate.weight, 0);

  return candidates.reduce(
    (total, candidate) =>
      total + candidate.projection * candidate.weight / Math.max(0.0001, weightTotal),
    0,
  );
}

/**
 * Applies trajectory-aware completed-season weights while retaining V9's
 * conservative current-season blend and sample caps. Positive breakout uplift
 * is capped so one hot shooting season cannot dominate the entire board.
 */
export function calculateTrajectoryAwareStableDraftProjection(
  input: StableDraftProjectionInput,
): StableDraftProjectionResult {
  const assessment = assessDraftTrajectory({
    position: input.position,
    latestCompletedSeason: input.latestCompletedSeason,
    previousCompletedSeason: input.previousCompletedSeason,
    birthDate: input.birthDate,
    projectionDate: input.projectionDate,
  });

  const latestProjection = input.latestCompletedSeason.pace !== null
    ? input.capProjectionBySample(
        input.latestCompletedSeason.pace,
        input.position,
        input.latestCompletedSeason.gamesPlayed,
      )
    : null;
  const previousProjection = input.previousCompletedSeason.pace !== null
    ? input.capProjectionBySample(
        input.previousCompletedSeason.pace,
        input.position,
        input.previousCompletedSeason.gamesPlayed,
      )
    : null;

  const stableWeights = getStableWeights();
  const stableHistoricalProjection = calculateHistoricalProjection({
    latestProjection,
    previousProjection,
    conservativeBaseline: input.conservativeBaseline,
    latestWeight: stableWeights.latestSeasonWeight,
    previousWeight: stableWeights.previousSeasonWeight,
    baselineWeight: stableWeights.conservativeBaselineWeight,
  });
  let trajectoryHistoricalProjection = calculateHistoricalProjection({
    latestProjection,
    previousProjection,
    conservativeBaseline: input.conservativeBaseline,
    latestWeight: assessment.latestSeasonWeight,
    previousWeight: assessment.previousSeasonWeight,
    baselineWeight: assessment.conservativeBaselineWeight,
  });

  if (
    assessment.maximumPositiveUpliftRate > 0 &&
    trajectoryHistoricalProjection > stableHistoricalProjection
  ) {
    trajectoryHistoricalProjection = Math.min(
      trajectoryHistoricalProjection,
      stableHistoricalProjection * (1 + assessment.maximumPositiveUpliftRate),
    );
  }

  const currentWeight =
    input.currentPace !== null && input.currentGamesPlayed > 0
      ? clamp(input.currentGamesPlayed / 82 * 0.65, 0.04, 0.65)
      : 0;
  const historicalWeight = 1 - currentWeight;
  const currentProjection = input.currentPace !== null
    ? input.capProjectionBySample(
        input.currentPace,
        input.position,
        input.currentGamesPlayed,
      )
    : null;
  const projectedSeasonPoints =
    currentWeight > 0 && currentProjection !== null
      ? currentProjection * currentWeight + trajectoryHistoricalProjection * historicalWeight
      : trajectoryHistoricalProjection;
  const stableSeasonPoints =
    currentWeight > 0 && currentProjection !== null
      ? currentProjection * currentWeight + stableHistoricalProjection * historicalWeight
      : stableHistoricalProjection;

  return {
    projectedSeasonPoints,
    stableSeasonPoints,
    trajectoryLabel: assessment.label,
    trajectoryConfidence: assessment.confidence,
    trajectoryAdjustment: projectedSeasonPoints - stableSeasonPoints,
    latestSeasonWeight: assessment.latestSeasonWeight,
    paceChangeRate: assessment.paceChangeRate,
    supportingSignalCount: assessment.supportingSignalCount,
    playerAge: assessment.playerAge,
  };
}
