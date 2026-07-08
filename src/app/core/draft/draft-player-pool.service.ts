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

function calculateSkaterProjection(
  position: DraftPosition,
  stats: Partial<SkaterProjectionStats> | undefined
): {
  projectedSeasonPoints: number | null;
  projectedCyclePoints: number | null;
} {
  const gamesPlayed = stats?.gamesPlayed ?? 0;

  if (gamesPlayed <= 0) {
    const conservativeProjection =
      POSITION_BASELINES[position].conservativeSeasonPoints;

    return {
      projectedSeasonPoints:
        Number(conservativeProjection.toFixed(1)),
      projectedCyclePoints:
        Number(
          (
            conservativeProjection /
            82 *
            defaultScoringRules.requiredGamesPerCycle
          ).toFixed(1)
        )
    };
  }

  const positionRules =
    position === 'D'
      ? defaultScoringRules.defense
      : defaultScoringRules.forward;

  const goals = stats?.goals ?? 0;
  const assists = stats?.assists ?? 0;

  const estimatedPrimaryAssists = assists * 0.65;
  const estimatedSecondaryAssists = assists * 0.35;

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

  return {
    projectedSeasonPoints:
      Number(projectedSeasonPoints.toFixed(1)),
    projectedCyclePoints:
      Number(projectedCyclePoints.toFixed(1))
  };
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

function calculateGoalieUnitProjection(
  stats: Partial<GoalieProjectionStats> | undefined
): {
  projectedSeasonPoints: number | null;
  projectedCyclePoints: number | null;
} {
  if (!stats) {
    const conservativeProjection =
      POSITION_BASELINES.G.conservativeSeasonPoints;

    return {
      projectedSeasonPoints:
        Number(conservativeProjection.toFixed(1)),
      projectedCyclePoints:
        Number(
          (
            conservativeProjection /
            82 *
            defaultScoringRules.requiredGamesPerCycle
          ).toFixed(1)
        )
    };
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

  return {
    projectedSeasonPoints:
      Number(projectedSeasonPoints.toFixed(1)),
    projectedCyclePoints:
      Number(projectedCyclePoints.toFixed(1))
  };
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
          projection.projectedCyclePoints
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