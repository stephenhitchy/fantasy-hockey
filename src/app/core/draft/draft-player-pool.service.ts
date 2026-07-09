import {
  getCurrentNhlDraftSkaters,
  getGoalieSeasonSummaryStats,
  getSkaterSeasonRealtimeStats,
  getSkaterSeasonSummaryStats,
  NHL_DRAFT_CLUBS,
  NhlStatsRecord
} from '../nhl/nhl-api.service';

import {
  DiminishingReturnValues,
  defaultScoringRules
} from '../scoring/scoring-rules';

import {
  DraftableAsset,
  DraftPosition
} from './draft.models';

let cachedPlayerPool: DraftableAsset[] | null = null;

interface SkaterProjectionStats {
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

interface GoalieProjectionStats {
  gamesPlayed: number;
  saves: number;
  shotsAgainst: number;
  wins: number;
  shutouts: number;
}

interface PositionProjectionBaseline {
  conservativeSeasonPoints: number;
  replacementSeasonPoints: number;
  highEndSeasonCap: number;
}

interface ProjectionCalculationResult {
  projectedSeasonPoints: number | null;
  projectedCyclePoints: number | null;
  reliabilityRating: number | null;
  volatilityPenalty: number | null;
  floorAdjustedCyclePoints: number | null;
}

const POSITION_BASELINES: Record<DraftPosition, PositionProjectionBaseline> = {
  LW: {
    conservativeSeasonPoints: 320,
    replacementSeasonPoints: 620,
    highEndSeasonCap: 1380
  },
  C: {
    conservativeSeasonPoints: 340,
    replacementSeasonPoints: 660,
    highEndSeasonCap: 1450
  },
  RW: {
    conservativeSeasonPoints: 320,
    replacementSeasonPoints: 620,
    highEndSeasonCap: 1380
  },
  D: {
    conservativeSeasonPoints: 300,
    replacementSeasonPoints: 560,
    highEndSeasonCap: 1300
  },
  G: {
    conservativeSeasonPoints: 500,
    replacementSeasonPoints: 650,
    highEndSeasonCap: 980
  }
};

function getPreviousCompletedSeason(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const completedSeasonStartYear =
    month >= 7
      ? year - 1
      : year - 2;

  return `${completedSeasonStartYear}${completedSeasonStartYear + 1}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getNumberFromRecord(
  record: NhlStatsRecord,
  keys: string[]
): number | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number') {
      return value;
    }

    if (
      typeof value === 'string' &&
      value.trim() !== '' &&
      !Number.isNaN(Number(value))
    ) {
      return Number(value);
    }
  }

  return null;
}

function getRawValueFromRecord(
  record: NhlStatsRecord,
  keys: string[]
): unknown {
  for (const key of keys) {
    const value = record[key];

    if (typeof value !== 'undefined' && value !== null) {
      return value;
    }
  }

  return null;
}

function getStringFromRecord(
  record: NhlStatsRecord,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string') {
      return value;
    }

    if (
      typeof value === 'object' &&
      value !== null &&
      'default' in value
    ) {
      const defaultValue =
        (value as { default?: unknown }).default;

      if (typeof defaultValue === 'string') {
        return defaultValue;
      }
    }
  }

  return null;
}

function getPlayerIdFromRecord(
  record: NhlStatsRecord
): number | null {
  return getNumberFromRecord(record, [
    'playerId',
    'id'
  ]);
}

function getTeamAbbreviationFromRecord(
  record: NhlStatsRecord
): string | null {
  const rawTeamValue = getStringFromRecord(record, [
    'teamAbbrevs',
    'teamAbbrev',
    'teamAbbreviation',
    'teamTriCode'
  ]);

  if (!rawTeamValue) {
    return null;
  }

  return rawTeamValue
    .split(',')
    .map((team) => team.trim().toUpperCase())
    .find(Boolean) ?? null;
}

function mergeNumberField<T extends object>(
  target: T,
  field: keyof T,
  record: NhlStatsRecord,
  keys: string[]
): void {
  const value = getNumberFromRecord(record, keys);

  if (typeof value === 'number') {
    target[field] = value as T[keyof T];
  }
}

function getMinutesFromTimeString(value: string): number | null {
  const parts = value
    .trim()
    .split(':')
    .map((part) => Number(part));

  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => Number.isNaN(part))
  ) {
    return null;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;

    return minutes + seconds / 60;
  }

  const [hours, minutes, seconds] = parts;

  return hours * 60 + minutes + seconds / 60;
}

function getPerGameToiMinutes(value: unknown): number | null {
  if (typeof value === 'string') {
    return getMinutesFromTimeString(value);
  }

  if (typeof value !== 'number') {
    return null;
  }

  if (value <= 0) {
    return null;
  }

  if (value > 60) {
    return value / 60;
  }

  return value;
}

function getAverageToiMinutesFromTotal(
  value: unknown,
  gamesPlayed: number
): number | null {
  if (gamesPlayed <= 0) {
    return null;
  }

  if (typeof value === 'string') {
    const totalMinutes = getMinutesFromTimeString(value);

    if (typeof totalMinutes !== 'number') {
      return null;
    }

    return totalMinutes / gamesPlayed;
  }

  if (typeof value !== 'number' || value <= 0) {
    return null;
  }

  const likelyTotalSecondsThreshold = gamesPlayed * 45;

  if (value > likelyTotalSecondsThreshold) {
    return value / 60 / gamesPlayed;
  }

  return value / gamesPlayed;
}

function getAverageTimeOnIceMinutesFromRecord(
  record: NhlStatsRecord,
  gamesPlayed: number
): number | null {
  const perGameValue = getRawValueFromRecord(record, [
    'timeOnIcePerGame',
    'avgTimeOnIce',
    'averageTimeOnIce',
    'averageTimeOnIcePerGame',
    'toiPerGame',
    'avgToi'
  ]);

  const perGameMinutes = getPerGameToiMinutes(perGameValue);

  if (typeof perGameMinutes === 'number') {
    return perGameMinutes;
  }

  const totalValue = getRawValueFromRecord(record, [
    'timeOnIce',
    'totalTimeOnIce',
    'toi'
  ]);

  return getAverageToiMinutesFromTotal(
    totalValue,
    gamesPlayed
  );
}

function mergeAverageTimeOnIce(
  stats: Partial<SkaterProjectionStats>,
  record: NhlStatsRecord
): void {
  const gamesPlayed = stats.gamesPlayed ?? getNumberFromRecord(record, [
    'gamesPlayed'
  ]) ?? 0;

  const averageTimeOnIceMinutes =
    getAverageTimeOnIceMinutesFromRecord(
      record,
      gamesPlayed
    );

  if (
    typeof averageTimeOnIceMinutes === 'number' &&
    averageTimeOnIceMinutes > 0
  ) {
    stats.averageTimeOnIceMinutes =
      Number(averageTimeOnIceMinutes.toFixed(2));
  }
}

async function loadSkaterProjectionStats(
  season: string
): Promise<Map<number, Partial<SkaterProjectionStats>>> {
  const statsByPlayerId =
    new Map<number, Partial<SkaterProjectionStats>>();

  try {
    const summaryRecords =
      await getSkaterSeasonSummaryStats(season);

    for (const record of summaryRecords) {
      const playerId = getPlayerIdFromRecord(record);

      if (!playerId) {
        continue;
      }

      const stats =
        statsByPlayerId.get(playerId) ?? {};

      mergeNumberField(stats, 'gamesPlayed', record, [
        'gamesPlayed'
      ]);

      mergeNumberField(stats, 'goals', record, [
        'goals'
      ]);

      mergeNumberField(stats, 'assists', record, [
        'assists'
      ]);

      mergeNumberField(stats, 'shotsOnGoal', record, [
        'shots',
        'shotsOnGoal'
      ]);

      mergeNumberField(stats, 'plusMinus', record, [
        'plusMinus'
      ]);

      mergeNumberField(stats, 'powerPlayPoints', record, [
        'ppPoints',
        'powerPlayPoints',
        'powerplayPoints'
      ]);

      mergeNumberField(stats, 'shortHandedPoints', record, [
        'shPoints',
        'shortHandedPoints',
        'shorthandedPoints'
      ]);

      mergeNumberField(stats, 'gameWinningGoals', record, [
        'gameWinningGoals',
        'gwg'
      ]);

      mergeNumberField(stats, 'overtimeGoals', record, [
        'otGoals',
        'overtimeGoals'
      ]);

      mergeAverageTimeOnIce(stats, record);

      statsByPlayerId.set(playerId, stats);
    }
  } catch (error: unknown) {
    console.warn(
      'Skipping skater summary projections.',
      error
    );
  }

  try {
    const realtimeRecords =
      await getSkaterSeasonRealtimeStats(season);

    for (const record of realtimeRecords) {
      const playerId = getPlayerIdFromRecord(record);

      if (!playerId) {
        continue;
      }

      const stats =
        statsByPlayerId.get(playerId) ?? {};

      mergeNumberField(stats, 'hits', record, [
        'hits'
      ]);

      mergeNumberField(stats, 'blockedShots', record, [
        'blockedShots',
        'blocks'
      ]);

      mergeAverageTimeOnIce(stats, record);

      statsByPlayerId.set(playerId, stats);
    }
  } catch (error: unknown) {
    console.warn(
      'Skipping skater realtime projections.',
      error
    );
  }

  return statsByPlayerId;
}

async function loadGoalieProjectionStats(
  season: string
): Promise<Map<string, Partial<GoalieProjectionStats>>> {
  const statsByTeam =
    new Map<string, Partial<GoalieProjectionStats>>();

  try {
    const goalieRecords =
      await getGoalieSeasonSummaryStats(season);

    for (const record of goalieRecords) {
      const teamAbbreviation =
        getTeamAbbreviationFromRecord(record);

      if (!teamAbbreviation) {
        continue;
      }

      const stats =
        statsByTeam.get(teamAbbreviation) ?? {
          gamesPlayed: 82,
          saves: 0,
          shotsAgainst: 0,
          wins: 0,
          shutouts: 0
        };

      stats.saves =
        (stats.saves ?? 0) +
        (getNumberFromRecord(record, ['saves']) ?? 0);

      stats.shotsAgainst =
        (stats.shotsAgainst ?? 0) +
        (getNumberFromRecord(record, ['shotsAgainst']) ?? 0);

      stats.wins =
        (stats.wins ?? 0) +
        (getNumberFromRecord(record, ['wins']) ?? 0);

      stats.shutouts =
        (stats.shutouts ?? 0) +
        (getNumberFromRecord(record, ['shutouts']) ?? 0);

      stats.gamesPlayed = 82;

      statsByTeam.set(teamAbbreviation, stats);
    }
  } catch (error: unknown) {
    console.warn(
      'Skipping goalie summary projections.',
      error
    );
  }

  return statsByTeam;
}

function estimateDiminishingSeasonTotal(
  eventCount: number,
  gamesPlayed: number,
  values: DiminishingReturnValues
): number {
  if (eventCount <= 0 || gamesPlayed <= 0) {
    return 0;
  }

  const eventsPerGame = eventCount / gamesPlayed;

  const probabilityZero = Math.exp(-eventsPerGame);
  const probabilityOne = probabilityZero * eventsPerGame;

  const probabilityAtLeastOne = 1 - probabilityZero;
  const probabilityAtLeastTwo =
    1 - probabilityZero - probabilityOne;

  const expectedAdditionalEventsAfterTwo = Math.max(
    0,
    eventsPerGame -
      probabilityAtLeastOne -
      probabilityAtLeastTwo
  );

  const expectedPointsPerGame =
    probabilityAtLeastOne * values.first +
    probabilityAtLeastTwo * values.second +
    expectedAdditionalEventsAfterTwo * values.additional;

  return expectedPointsPerGame * gamesPlayed;
}

function getSkaterSampleTrust(gamesPlayed: number): number {
  if (gamesPlayed >= 60) {
    return 1;
  }

  if (gamesPlayed >= 40) {
    return 0.82;
  }

  if (gamesPlayed >= 25) {
    return 0.62;
  }

  if (gamesPlayed >= 10) {
    return 0.38;
  }

  if (gamesPlayed >= 1) {
    return 0.18;
  }

  return 0;
}

function roundOneDecimal(value: number): number {
  return Number(value.toFixed(1));
}

function getDefaultReliabilityRating(position: DraftPosition): number {
  if (position === 'G') {
    return 68;
  }

  return 48;
}

function buildProjectionResult(
  projectedSeasonPoints: number,
  projectedCyclePoints: number,
  reliabilityRating: number,
  maxPenaltyRate: number
): ProjectionCalculationResult {
  const safeReliabilityRating = clamp(
    reliabilityRating,
    0,
    100
  );

  const penaltyRate =
    (100 - safeReliabilityRating) /
    100 *
    maxPenaltyRate;

  const volatilityPenalty =
    projectedCyclePoints * penaltyRate;

  const floorAdjustedCyclePoints =
    Math.max(
      0,
      projectedCyclePoints - volatilityPenalty
    );

  return {
    projectedSeasonPoints:
      roundOneDecimal(projectedSeasonPoints),
    projectedCyclePoints:
      roundOneDecimal(projectedCyclePoints),
    reliabilityRating:
      roundOneDecimal(safeReliabilityRating),
    volatilityPenalty:
      roundOneDecimal(volatilityPenalty),
    floorAdjustedCyclePoints:
      roundOneDecimal(floorAdjustedCyclePoints)
  };
}

function blendWithBaseline(
  paceProjection: number,
  baselineProjection: number,
  trust: number
): number {
  return (
    paceProjection * trust +
    baselineProjection * (1 - trust)
  );
}

function capProjectionBySample(
  projection: number,
  position: DraftPosition,
  gamesPlayed: number
): number {
  const cap = POSITION_BASELINES[position].highEndSeasonCap;

  if (gamesPlayed >= 60) {
    return Math.min(projection, cap);
  }

  if (gamesPlayed >= 40) {
    return Math.min(projection, cap * 0.9);
  }

  if (gamesPlayed >= 25) {
    return Math.min(projection, cap * 0.78);
  }

  if (gamesPlayed >= 10) {
    return Math.min(projection, cap * 0.62);
  }

  if (gamesPlayed >= 1) {
    return Math.min(projection, cap * 0.48);
  }

  return Math.min(
    projection,
    POSITION_BASELINES[position].conservativeSeasonPoints
  );
}

function calculateProjectedToiPoints(
  position: DraftPosition,
  stats: Partial<SkaterProjectionStats>,
  gamesPlayed: number
): number {
  const averageTimeOnIceMinutes =
    stats.averageTimeOnIceMinutes ?? 0;

  if (averageTimeOnIceMinutes <= 0 || gamesPlayed <= 0) {
    return 0;
  }

  if (position === 'D') {
    const plusMinusPerGame =
      (stats.plusMinus ?? 0) / gamesPlayed;

    const toiMultiplier = clamp(
      defaultScoringRules.defenseToiBaseMultiplier +
        plusMinusPerGame *
          defaultScoringRules.defenseToiPlusMinusModifier,
      defaultScoringRules.defenseToiFloor,
      defaultScoringRules.defenseToiCeiling
    );

    return averageTimeOnIceMinutes *
      gamesPlayed *
      toiMultiplier;
  }

  return averageTimeOnIceMinutes *
    gamesPlayed *
    defaultScoringRules.forwardToiMultiplier;
}

function calculateSkaterReliabilityRating(
  position: DraftPosition,
  stats: Partial<SkaterProjectionStats>,
  gamesPlayed: number
): number {
  if (gamesPlayed <= 0) {
    return getDefaultReliabilityRating(position);
  }

  const averageTimeOnIceMinutes =
    stats.averageTimeOnIceMinutes ?? 0;

  const shotsPerGame =
    (stats.shotsOnGoal ?? 0) / gamesPlayed;

  const hitsPerGame =
    (stats.hits ?? 0) / gamesPlayed;

  const blocksPerGame =
    (stats.blockedShots ?? 0) / gamesPlayed;

  const powerPlayPointsPerGame =
    (stats.powerPlayPoints ?? 0) / gamesPlayed;

  const plusMinusPerGame =
    (stats.plusMinus ?? 0) / gamesPlayed;

  const gamesScore =
    clamp(gamesPlayed / 82, 0, 1) * 42;

  const toiTarget =
    position === 'D'
      ? 21
      : 18;

  const toiScore =
    clamp(averageTimeOnIceMinutes / toiTarget, 0, 1) * 25;

  const volumeScore =
    position === 'D'
      ? clamp(
          (
            shotsPerGame +
            hitsPerGame * 0.25 +
            blocksPerGame * 0.5
          ) / 4,
          0,
          1
        ) * 20
      : clamp(
          (
            shotsPerGame +
            hitsPerGame * 0.15 +
            blocksPerGame * 0.2
          ) / 3,
          0,
          1
        ) * 20;

  const specialTeamsRoleScore =
    clamp(powerPlayPointsPerGame / 0.65, 0, 1) * 5;

  const plusMinusStabilityScore =
    position === 'D'
      ? clamp(0.55 + plusMinusPerGame, 0, 1) * 5
      : clamp(0.5 + plusMinusPerGame * 0.35, 0, 1) * 3;

  const availabilityBonus =
    gamesPlayed >= 78
      ? 5
      : gamesPlayed >= 70
        ? 3
        : 0;

  return roundOneDecimal(
    clamp(
      gamesScore +
        toiScore +
        volumeScore +
        specialTeamsRoleScore +
        plusMinusStabilityScore +
        availabilityBonus,
      35,
      98
    )
  );
}

function calculateSkaterProjection(
  position: DraftPosition,
  stats: Partial<SkaterProjectionStats> | undefined
): ProjectionCalculationResult {
  const gamesPlayed = stats?.gamesPlayed ?? 0;

  if (gamesPlayed <= 0) {
    const conservativeProjection =
      POSITION_BASELINES[position].conservativeSeasonPoints;

    const conservativeCycleProjection =
      conservativeProjection /
      82 *
      defaultScoringRules.requiredGamesPerCycle;

    return buildProjectionResult(
      conservativeProjection,
      conservativeCycleProjection,
      getDefaultReliabilityRating(position),
      0.22
    );
  }

  const positionRules =
    position === 'D'
      ? defaultScoringRules.defense
      : defaultScoringRules.forward;

  const goals = stats?.goals ?? 0;
  const assists = stats?.assists ?? 0;

  const estimatedPrimaryAssists = assists * 0.4;
  const estimatedSecondaryAssists = assists * 0.6;

  const rawSeasonFantasyPoints =
    estimateDiminishingSeasonTotal(
      goals,
      gamesPlayed,
      positionRules.goal
    ) +
    estimateDiminishingSeasonTotal(
      estimatedPrimaryAssists,
      gamesPlayed,
      positionRules.primaryAssist
    ) +
    estimateDiminishingSeasonTotal(
      estimatedSecondaryAssists,
      gamesPlayed,
      positionRules.secondaryAssist
    ) +
    (stats?.shotsOnGoal ?? 0) * positionRules.shotOnGoal +
    (stats?.hits ?? 0) * positionRules.hit +
    (stats?.blockedShots ?? 0) * positionRules.blockedShot +
    (stats?.powerPlayPoints ?? 0) * positionRules.powerPlayPoint +
    (stats?.shortHandedPoints ?? 0) * positionRules.shortHandedPoint +
    (stats?.gameWinningGoals ?? 0) * defaultScoringRules.gameWinningGoal +
    (stats?.overtimeGoals ?? 0) * defaultScoringRules.overtimeGoal +
    calculateProjectedToiPoints(
      position,
      stats ?? {},
      gamesPlayed
    );

  const purePaceProjection =
    rawSeasonFantasyPoints / gamesPlayed * 82;

  const trust = getSkaterSampleTrust(gamesPlayed);

  const baselineProjection =
    POSITION_BASELINES[position].conservativeSeasonPoints;

  const regressedProjection = blendWithBaseline(
    purePaceProjection,
    baselineProjection,
    trust
  );

  const projectedSeasonPoints = capProjectionBySample(
    regressedProjection,
    position,
    gamesPlayed
  );

  const projectedCyclePoints =
    projectedSeasonPoints / 82 *
    defaultScoringRules.requiredGamesPerCycle;

  const reliabilityRating =
    calculateSkaterReliabilityRating(
      position,
      stats ?? {},
      gamesPlayed
    );

  return buildProjectionResult(
    projectedSeasonPoints,
    projectedCyclePoints,
    reliabilityRating,
    0.22
  );
}

function getGoalieSavePercentageTierPoints(
  savePercentage: number
): number {
  const matchingTier =
    defaultScoringRules.goalieSavePercentageTiers.find(
      (tier) => savePercentage >= tier.minSavePercentage
    );

  return matchingTier?.points ?? 0;
}

function calculateGoalieUnitReliabilityRating(
  stats: Partial<GoalieProjectionStats> | undefined
): number {
  if (!stats) {
    return getDefaultReliabilityRating('G');
  }

  const gamesPlayed = stats.gamesPlayed ?? 82;
  const saves = stats.saves ?? 0;
  const shotsAgainst = stats.shotsAgainst ?? 0;
  const wins = stats.wins ?? 0;
  const shutouts = stats.shutouts ?? 0;

  const savePercentage =
    shotsAgainst > 0
      ? saves / shotsAgainst
      : 0;

  const shotsAgainstPerGame =
    gamesPlayed > 0
      ? shotsAgainst / gamesPlayed
      : 0;

  const gamesScore =
    clamp(gamesPlayed / 82, 0, 1) * 25;

  const workloadScore =
    clamp(shotsAgainstPerGame / 31, 0, 1) * 25;

  const savePercentageScore =
    clamp((savePercentage - 0.86) / 0.08, 0, 1) * 25;

  const winsScore =
    clamp(wins / 55, 0, 1) * 15;

  const shutoutScore =
    clamp(shutouts / 10, 0, 1) * 5;

  return roundOneDecimal(
    clamp(
      5 +
        gamesScore +
        workloadScore +
        savePercentageScore +
        winsScore +
        shutoutScore,
      50,
      98
    )
  );
}

function calculateGoalieUnitProjection(
  stats: Partial<GoalieProjectionStats> | undefined
): ProjectionCalculationResult {
  if (!stats) {
    const conservativeProjection =
      POSITION_BASELINES.G.conservativeSeasonPoints;

    const conservativeCycleProjection =
      conservativeProjection /
      82 *
      defaultScoringRules.requiredGamesPerCycle;

    return buildProjectionResult(
      conservativeProjection,
      conservativeCycleProjection,
      getDefaultReliabilityRating('G'),
      0.18
    );
  }

  const gamesPlayed = stats.gamesPlayed ?? 82;
  const saves = stats.saves ?? 0;
  const shotsAgainst = stats.shotsAgainst ?? 0;
  const wins = stats.wins ?? 0;
  const shutouts = stats.shutouts ?? 0;

  const savePercentage =
    shotsAgainst > 0
      ? saves / shotsAgainst
      : 0;

  const rawSeasonFantasyPoints =
    saves * defaultScoringRules.goalieSave +
    wins * defaultScoringRules.goalieWin +
    shutouts * defaultScoringRules.goalieShutout +
    gamesPlayed *
      getGoalieSavePercentageTierPoints(savePercentage);

  const projectedSeasonPoints = rawSeasonFantasyPoints;

  const projectedCyclePoints =
    projectedSeasonPoints / 82 *
    defaultScoringRules.requiredGamesPerCycle;

  const reliabilityRating =
    calculateGoalieUnitReliabilityRating(stats);

  return buildProjectionResult(
    projectedSeasonPoints,
    projectedCyclePoints,
    reliabilityRating,
    0.18
  );
}

function getAssetName(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.fullName
    : asset.teamName;
}

export async function loadDraftPlayerPool(
  forceRefresh = false
): Promise<DraftableAsset[]> {
  if (cachedPlayerPool && !forceRefresh) {
    return cachedPlayerPool;
  }

  const projectionSeason = getPreviousCompletedSeason();

  const skaters = await getCurrentNhlDraftSkaters();

  const [
    skaterProjectionStats,
    goalieProjectionStats
  ] = await Promise.all([
    loadSkaterProjectionStats(projectionSeason),
    loadGoalieProjectionStats(projectionSeason)
  ]);

  const skaterAssets: DraftableAsset[] = skaters.map(
    (skater) => {
      const projection = calculateSkaterProjection(
        skater.position,
        skaterProjectionStats.get(skater.id)
      );

      return {
        assetType: 'skater',
        assetKey: `skater-${skater.id}`,
        position: skater.position,
        projectedSeasonPoints:
          projection.projectedSeasonPoints,
        projectedCyclePoints:
          projection.projectedCyclePoints,
        reliabilityRating:
          projection.reliabilityRating,
        volatilityPenalty:
          projection.volatilityPenalty,
        floorAdjustedCyclePoints:
          projection.floorAdjustedCyclePoints,
        player: {
          id: skater.id,
          fullName: skater.fullName,
          position: skater.position,
          nhlTeamAbbreviation: skater.nhlTeamAbbreviation,
          teamLogoUrl: skater.teamLogoUrl,
          headshotUrl: skater.headshotUrl
        }
      };
    }
  );

  const goalieUnitAssets: DraftableAsset[] =
    NHL_DRAFT_CLUBS.map((club) => {
      const projection = calculateGoalieUnitProjection(
        goalieProjectionStats.get(club.abbreviation)
      );

      return {
        assetType: 'team-goalie-unit',
        assetKey: `goalie-unit-${club.abbreviation}`,
        position: 'G',
        teamName: club.name,
        teamAbbreviation: club.abbreviation,
        teamLogoUrl: `https://assets.nhle.com/logos/nhl/svg/${club.abbreviation}_light.svg`,
        projectedSeasonPoints:
          projection.projectedSeasonPoints,
        projectedCyclePoints:
          projection.projectedCyclePoints,
        reliabilityRating:
          projection.reliabilityRating,
        volatilityPenalty:
          projection.volatilityPenalty,
        floorAdjustedCyclePoints:
          projection.floorAdjustedCyclePoints
      };
    });

  cachedPlayerPool = [
    ...skaterAssets,
    ...goalieUnitAssets
  ].sort((first, second) => {
    const firstProjection =
      first.projectedCyclePoints ?? -1;

    const secondProjection =
      second.projectedCyclePoints ?? -1;

    if (secondProjection !== firstProjection) {
      return secondProjection - firstProjection;
    }

    return getAssetName(first).localeCompare(
      getAssetName(second)
    );
  });

  return cachedPlayerPool;
}