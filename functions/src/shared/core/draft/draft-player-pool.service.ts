import {
  clearNhlProjectionApiCache,
  getCurrentNhlDraftSkaters,
  getGoalieGameSummaryStats,
  getGoalieSeasonSummaryStats,
  getSkaterGameRealtimeStats,
  getSkaterGameSummaryStats,
  getNhlTeamSeasonSchedule,
  getSkaterSeasonRealtimeStats,
  getSkaterSeasonSummaryStats,
  NHL_DRAFT_CLUBS,
  NhlStatsRecord,
  NhlTeamSeasonGame
} from '../nhl/nhl-api.service';

import {
  DiminishingReturnValues,
  defaultScoringRules
} from '../scoring/scoring-rules';
import { calculateGoalieSaveQualityPoints } from '../scoring/scoring-engine';

import {
  DraftableAsset,
  DraftPosition,
  ProjectionCycleGameMarker,
  ProjectionStatBreakdownItem
} from './draft.models';

import {
  PlayerAvailabilityDatabaseRecord,
  PlayerAvailabilityStatus
} from '../player/player-availability.models';

import {
  buildTeamStrengthProfiles,
  calculateProjectionScheduleContext,
  NEUTRAL_PROJECTION_SCHEDULE_CONTEXT,
  ProjectionScheduleContext
} from '../projection/schedule-projection.util';

import {
  assessDraftTrajectory,
  calculateTrajectoryAwareStableDraftProjection,
  DraftTrajectoryLabel,
  StableDraftProjectionResult
} from '../projection/projection-trajectory.util';

import {
  buildProjectionV11GoalieRates,
  buildProjectionV11SkaterRates,
  calculateProjectionV11Range,
  getProjectionPrimaryAssistShare,
  PROJECTION_MODEL_VERSION
} from '../projection/projection-v11.util';

let cachedPlayerPool: DraftableAsset[] | null = null;

export interface DraftPlayerPoolProjectionOptions {
  forceRefresh?: boolean;
  targetCycleNumber?: number;
  requiredGamesPerCycle?: number;
  availabilityByPlayerId?: ReadonlyMap<
    number,
    PlayerAvailabilityDatabaseRecord
  >;

  /** Explicit seasons keep historical replay projections aligned to replay time. */
  currentSeasonOverride?: string;
  previousSeasonOverride?: string;
  secondPreviousSeasonOverride?: string;
  projectionAsOfDate?: Date;
  ignoreAvailability?: boolean;
}


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

interface SkaterGameProjectionStats {
  gameId: number;
  gameDate: string;
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

interface GoalieGameProjectionStats {
  gameId: number;
  gameDate: string;
  saves: number;
  shotsAgainst: number;
  won: boolean;
  shutout: boolean;
}

interface RecentFormMetrics {
  sampleSize: number;
  seasonFantasyPointsPerGame: number | null;
  recentThreeGameFantasyPointsPerGame: number | null;
  recentFiveGameFantasyPointsPerGame: number | null;
  recentTenGameFantasyPointsPerGame: number | null;
  recentTwentyGameFantasyPointsPerGame: number | null;

  /**
   * The next-cycle form signal uses the longer 10- and 20-appearance windows.
   * The 3- and 5-game windows remain available for explanation only.
   */
  weightedRecentFantasyPointsPerGame: number | null;

  /**
   * Opportunity-weighted form intentionally discounts volatile goals,
   * assists, and rare bonuses while preserving shots, peripherals, and role.
   */
  seasonSustainableFantasyPointsPerGame: number | null;
  weightedRecentSustainableFantasyPointsPerGame: number | null;
  fantasyPointsStandardDeviation: number | null;

  consistencyRating: number | null;
  seasonAverageTimeOnIceMinutes: number | null;
  recentAverageTimeOnIceMinutes: number | null;
  actualRecentAppearances: number;
  missedRecentTeamGames: number;
  weightedRecentAppearances: number;
  fullWeightRecentGames: number;
  partialWeightRecentGames: number;
}

interface PositionProjectionBaseline {
  conservativeSeasonPoints: number;
  replacementSeasonPoints: number;
  highEndSeasonCap: number;
}

interface ProjectionCalculationResult {
  /**
   * projectedSeasonPoints is the stable season-long draft outlook.
   * projectedCyclePoints is the availability-adjusted next-cycle outlook.
   */
  projectedSeasonPoints: number | null;
  projectedCyclePoints: number | null;

  draftProjectedSeasonPoints: number | null;
  draftProjectedCyclePoints: number | null;
  draftTrajectoryLabel: DraftTrajectoryLabel | null;
  draftTrajectoryConfidence: number | null;
  draftTrajectoryAdjustment: number | null;
  draftLatestSeasonWeight: number | null;
  draftPaceChangePercent: number | null;
  draftRecentTrendAdjustment: number | null;
  draftRoleAdjustment: number | null;
  draftReliabilityRating: number | null;
  draftVolatilityPenalty: number | null;
  draftFloorAdjustedCyclePoints: number | null;

  projectionModelVersion: number;
  projectionModelConfidence: number | null;
  projectionPrimaryAssistShare: number | null;
  projectionShootingPercentage: number | null;
  projectionShootingRegressionAdjustment: number | null;
  projectionCurrentSeasonWeight: number | null;
  projectionHistoricalWeight: number | null;
  projectionFloorPoints: number | null;
  projectionCeilingPoints: number | null;
  projectionUncertaintyPoints: number | null;
  sustainableFormAdjustment: number | null;
  recentGameStandardDeviation: number | null;

  seasonBaselineCyclePoints: number | null;
  recentFormAdjustment: number | null;
  roleAdjustment: number | null;
  scheduleStrengthAdjustment: number | null;
  scheduleStrengthMultiplier: number | null;
  scheduleDifficultyRating: number | null;
  scheduleDifficultyLabel: string | null;
  scheduleDataConfidence: number | null;
  projectionHomeGames: number | null;
  projectionRoadGames: number | null;
  projectionBackToBackGames: number | null;
  projectionRestAdvantageGames: number | null;
  projectionOpponentAbbreviations: string[] | null;
  projectionDataSeason: string | null;
  projectionDataSource:
    | 'current-season-form'
    | 'current-season-baseline'
    | 'previous-season-form'
    | 'previous-season-baseline'
    | 'conservative-baseline';
  projectionGamesPlayed: number | null;
  recentFormSampleSize: number | null;
  seasonFantasyPointsPerGame: number | null;
  recentThreeGameFantasyPointsPerGame: number | null;
  recentFiveGameFantasyPointsPerGame: number | null;
  recentTenGameFantasyPointsPerGame: number | null;
  recentTwentyGameFantasyPointsPerGame: number | null;
  seasonAverageTimeOnIceMinutes: number | null;
  recentAverageTimeOnIceMinutes: number | null;
  actualRecentAppearances: number | null;
  missedRecentTeamGames: number | null;
  weightedRecentAppearances: number | null;
  fullWeightRecentGames: number | null;
  partialWeightRecentGames: number | null;
  healthyProjectedCyclePoints: number | null;
  scheduledGamesInProjectionCycle: number | null;
  expectedGamesAvailable: number | null;
  expectedGamesMissed: number | null;
  availabilityAdjustment: number | null;
  availabilityAdjustedCyclePoints: number | null;
  availabilityStatus: PlayerAvailabilityStatus;
  availabilityLabel: string | null;
  availabilityReturnDate: string | null;
  availabilityNote: string | null;
  availabilityAsOf: string | null;
  targetProjectionCycleNumber: number | null;
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
    /*
     * A team goalie unit receives every goalie appearance for the NHL club.
     * With the continuous save-quality model, a normal six-game unit is
     * commonly worth roughly 90-115 points while elite units retain a
     * meaningful high end without one game overwhelming the entire cycle.
     */
    conservativeSeasonPoints: 1180,
    replacementSeasonPoints: 1380,
    highEndSeasonCap: 2000
  }
};

function getCurrentNhlSeason(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const startYear = month >= 7 ? year : year - 1;

  return `${startYear}${startYear + 1}`;
}

function getPreviousSeason(season: string): string {
  const startYear = Number(season.slice(0, 4));

  if (!Number.isFinite(startYear)) {
    return getCurrentNhlSeason();
  }

  return `${startYear - 1}${startYear}`;
}


const TEAM_SCHEDULE_BATCH_SIZE = 8;
const TEAM_SCHEDULE_BATCH_DELAY_MS = 80;

const AVAILABILITY_LABELS: Record<
  PlayerAvailabilityStatus,
  string
> = {
  active: 'Active',
  'day-to-day': 'Day-to-Day',
  out: 'Out',
  'injured-reserve': 'Injured Reserve',
  'long-term-injured-reserve': 'Long-Term Injured Reserve',
  suspended: 'Suspended',
  'personal-leave': 'Personal Leave',
  unknown: 'Unknown'
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds)
  );
}

function normalizeSeasonOverride(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^\d{8}$/.test(normalized)
    ? normalized
    : undefined;
}

function normalizeProjectionOptions(
  input: boolean | DraftPlayerPoolProjectionOptions
): Required<
  Pick<
    DraftPlayerPoolProjectionOptions,
    'forceRefresh' | 'requiredGamesPerCycle' | 'ignoreAvailability'
  >
> & Omit<
  DraftPlayerPoolProjectionOptions,
  'forceRefresh' | 'requiredGamesPerCycle' | 'ignoreAvailability'
> {
  if (typeof input === 'boolean') {
    return {
      forceRefresh: input,
      targetCycleNumber: undefined,
      requiredGamesPerCycle:
        defaultScoringRules.requiredGamesPerCycle,
      availabilityByPlayerId: undefined,
      currentSeasonOverride: undefined,
      previousSeasonOverride: undefined,
      secondPreviousSeasonOverride: undefined,
      projectionAsOfDate: undefined,
      ignoreAvailability: false
    };
  }

  const projectionAsOfDate =
    input.projectionAsOfDate instanceof Date &&
    Number.isFinite(input.projectionAsOfDate.getTime())
      ? input.projectionAsOfDate
      : undefined;

  return {
    forceRefresh: input.forceRefresh === true,
    targetCycleNumber:
      typeof input.targetCycleNumber === 'number'
        ? Math.max(1, Math.floor(input.targetCycleNumber))
        : undefined,
    requiredGamesPerCycle:
      typeof input.requiredGamesPerCycle === 'number'
        ? Math.max(1, Math.floor(input.requiredGamesPerCycle))
        : defaultScoringRules.requiredGamesPerCycle,
    availabilityByPlayerId: input.availabilityByPlayerId,
    currentSeasonOverride: normalizeSeasonOverride(input.currentSeasonOverride),
    previousSeasonOverride: normalizeSeasonOverride(input.previousSeasonOverride),
    secondPreviousSeasonOverride: normalizeSeasonOverride(input.secondPreviousSeasonOverride),
    projectionAsOfDate,
    ignoreAvailability: input.ignoreAvailability === true
  };
}

function parseExternalDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  const normalized = value
    .replace(/^(expected|estimated|return|returns?)\s*:?\s*/i, '')
    .trim();

  const fallback = new Date(normalized);

  return Number.isNaN(fallback.getTime())
    ? null
    : fallback;
}

function getGameDate(game: NhlTeamSeasonGame): Date | null {
  const parsed = new Date(`${game.gameDate}T12:00:00`);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed;
}

function getDaysBetween(
  earlier: Date,
  later: Date
): number {
  return (later.getTime() - earlier.getTime()) / 86400000;
}

function getAvailabilityProbabilityForGame(
  status: PlayerAvailabilityStatus,
  gameDate: Date | null,
  returnDate: Date | null,
  now: Date
): number {
  if (status === 'active') {
    return 1;
  }

  const daysUntilGame = gameDate
    ? getDaysBetween(now, gameDate)
    : 0;

  if (returnDate && gameDate) {
    const daysAfterReturn = getDaysBetween(
      returnDate,
      gameDate
    );

    if (daysAfterReturn < 0) {
      return 0;
    }

    if (daysAfterReturn <= 2) {
      return status === 'day-to-day' ? 0.85 : 0.7;
    }

    return daysAfterReturn <= 7 ? 0.9 : 0.98;
  }

  switch (status) {
    case 'day-to-day':
      if (daysUntilGame > 7) {
        return 0.9;
      }

      if (daysUntilGame > 3) {
        return 0.8;
      }

      return 0.7;

    case 'unknown':
      return 0.88;

    case 'out':
      if (daysUntilGame > 30) {
        return 0.7;
      }

      if (daysUntilGame > 14) {
        return 0.5;
      }

      return 0.2;

    case 'injured-reserve':
      if (daysUntilGame > 45) {
        return 0.6;
      }

      if (daysUntilGame > 21) {
        return 0.35;
      }

      return 0.1;

    case 'long-term-injured-reserve':
      if (daysUntilGame > 60) {
        return 0.35;
      }

      if (daysUntilGame > 30) {
        return 0.15;
      }

      return 0;

    case 'suspended':
    case 'personal-leave':
      return 0;

    default:
      return 0.88;
  }
}

async function loadTeamProjectionSchedules(
  season: string
): Promise<Map<string, NhlTeamSeasonGame[]>> {
  const schedules = new Map<string, NhlTeamSeasonGame[]>();

  for (
    let index = 0;
    index < NHL_DRAFT_CLUBS.length;
    index += TEAM_SCHEDULE_BATCH_SIZE
  ) {
    const batch = NHL_DRAFT_CLUBS.slice(
      index,
      index + TEAM_SCHEDULE_BATCH_SIZE
    );

    const results = await Promise.allSettled(
      batch.map(async (club) => ({
        teamAbbreviation: club.abbreviation,
        schedule: (await getNhlTeamSeasonSchedule(
          club.abbreviation,
          season
        ))
          .filter((game) =>
            typeof game.gameType !== 'number' ||
            game.gameType === 2
          )
          .sort((first, second) =>
            first.gameDate.localeCompare(second.gameDate) ||
            first.id - second.id
          )
      }))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        schedules.set(
          result.value.teamAbbreviation,
          result.value.schedule
        );
      } else {
        console.warn(
          `Skipping ${season} team schedule projection data.`,
          result.reason
        );
      }
    }

    if (index + TEAM_SCHEDULE_BATCH_SIZE < NHL_DRAFT_CLUBS.length) {
      await wait(TEAM_SCHEDULE_BATCH_DELAY_MS);
    }
  }

  return schedules;
}

function getTargetCycleGames(
  schedule: NhlTeamSeasonGame[],
  targetCycleNumber: number | undefined,
  requiredGamesPerCycle: number
): NhlTeamSeasonGame[] {
  if (!targetCycleNumber) {
    return [];
  }

  const startIndex =
    (targetCycleNumber - 1) * requiredGamesPerCycle;

  return schedule.slice(
    startIndex,
    startIndex + requiredGamesPerCycle
  );
}

function getAvailabilityReliabilityPenalty(
  status: PlayerAvailabilityStatus,
  hasReturnDate: boolean
): number {
  switch (status) {
    case 'active':
      return 0;

    case 'day-to-day':
      return hasReturnDate ? 4 : 7;

    case 'unknown':
      return 6;

    case 'out':
      return hasReturnDate ? 7 : 12;

    case 'injured-reserve':
      return hasReturnDate ? 8 : 14;

    case 'long-term-injured-reserve':
      return hasReturnDate ? 10 : 17;

    case 'suspended':
    case 'personal-leave':
      return hasReturnDate ? 8 : 15;

    default:
      return 6;
  }
}

function applyAvailabilityAdjustment(
  projection: ProjectionCalculationResult,
  position: DraftPosition,
  availabilityRecord: PlayerAvailabilityDatabaseRecord | undefined,
  targetGames: NhlTeamSeasonGame[],
  requiredGamesPerCycle: number,
  targetCycleNumber: number | undefined,
  maxPenaltyRate: number,
  projectionAsOfDate: Date = new Date(),
  ignoreAvailability: boolean = false
): ProjectionCalculationResult {
  const effectiveAvailabilityRecord = ignoreAvailability
    ? undefined
    : availabilityRecord;
  const status = effectiveAvailabilityRecord?.status ?? 'active';
  const returnDate = parseExternalDate(
    effectiveAvailabilityRecord?.externalReturnDate
  );
  const now = projectionAsOfDate;

  const scheduledGames =
    targetGames.length > 0
      ? targetGames.length
      : requiredGamesPerCycle;

  const expectedGames = targetGames.length > 0
    ? targetGames.reduce(
        (total, game) =>
          total + getAvailabilityProbabilityForGame(
            status,
            getGameDate(game),
            returnDate,
            now
          ),
        0
      )
    : scheduledGames * getAvailabilityProbabilityForGame(
        status,
        null,
        returnDate,
        now
      );

  const healthyProjection =
    projection.projectedCyclePoints ?? 0;

  const adjustedProjection = scheduledGames > 0
    ? healthyProjection *
      clamp(expectedGames / scheduledGames, 0, 1)
    : healthyProjection;

  const availabilityAdjustment =
    adjustedProjection - healthyProjection;

  // Missed appearances lower confidence slightly, but they never enter the
  // healthy production pace as zero-point games. Projection V11 also keeps
  // this historical-absence penalty intentionally small.
  const recentMissedGamesPenalty = ignoreAvailability
    ? 0
    : Math.min(
        3,
        Math.max(0, projection.missedRecentTeamGames ?? 0) * 0.35
      );
  const liveAvailabilityPenalty = ignoreAvailability
    ? 0
    : getAvailabilityReliabilityPenalty(
        status,
        Boolean(returnDate)
      );

  const reliabilityRating = clamp(
    (projection.reliabilityRating ?? 50) -
      liveAvailabilityPenalty -
      recentMissedGamesPenalty,
    25,
    98
  );

  const penaltyRate =
    (100 - reliabilityRating) / 100 * maxPenaltyRate;

  const volatilityPenalty =
    adjustedProjection * penaltyRate;

  const adjustedRange = calculateProjectionV11Range({
    mean: adjustedProjection,
    recentGameStandardDeviation:
      projection.recentGameStandardDeviation,
    recentSampleSize: projection.recentFormSampleSize,
    expectedGames: Math.max(0.5, expectedGames),
    reliabilityRating,
    position
  });

  return {
    ...projection,
    projectedCyclePoints:
      roundOneDecimal(adjustedProjection),
    healthyProjectedCyclePoints:
      roundOneDecimal(healthyProjection),
    scheduledGamesInProjectionCycle:
      scheduledGames,
    expectedGamesAvailable:
      roundOneDecimal(expectedGames),
    expectedGamesMissed:
      roundOneDecimal(Math.max(0, scheduledGames - expectedGames)),
    availabilityAdjustment:
      roundOneDecimal(availabilityAdjustment),
    availabilityAdjustedCyclePoints:
      roundOneDecimal(adjustedProjection),
    availabilityStatus: status,
    availabilityLabel: AVAILABILITY_LABELS[status],
    availabilityReturnDate:
      effectiveAvailabilityRecord?.externalReturnDate ?? null,
    availabilityNote:
      effectiveAvailabilityRecord?.note ?? null,
    availabilityAsOf:
      effectiveAvailabilityRecord?.updatedAt ?? null,
    targetProjectionCycleNumber:
      targetCycleNumber ?? null,
    reliabilityRating:
      roundOneDecimal(reliabilityRating),
    projectionFloorPoints:
      roundOneDecimal(adjustedRange.floor),
    projectionCeilingPoints:
      roundOneDecimal(adjustedRange.ceiling),
    projectionUncertaintyPoints:
      roundOneDecimal(adjustedRange.uncertainty),
    volatilityPenalty:
      roundOneDecimal(volatilityPenalty),
    floorAdjustedCyclePoints:
      roundOneDecimal(
        Math.max(0, adjustedProjection - volatilityPenalty)
      )
  };
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


function getGameIdFromRecord(
  record: NhlStatsRecord
): number | null {
  return getNumberFromRecord(record, [
    'gameId',
    'gamePk'
  ]);
}

function getGameDateFromRecord(
  record: NhlStatsRecord
): string {
  return getStringFromRecord(record, [
    'gameDate',
    'date'
  ]) ?? '';
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


async function loadSkaterGameProjectionStats(
  season: string
): Promise<Map<number, SkaterGameProjectionStats[]>> {
  const gamesByKey =
    new Map<string, Partial<SkaterGameProjectionStats> & {
      playerId: number;
    }>();

  const [summaryResult, realtimeResult] =
    await Promise.allSettled([
      getSkaterGameSummaryStats(season),
      getSkaterGameRealtimeStats(season)
    ]);

  const mergeRecord = (
    record: NhlStatsRecord,
    includeSummary: boolean
  ): void => {
    const playerId = getPlayerIdFromRecord(record);
    const gameId = getGameIdFromRecord(record) ?? 0;
    const gameDate = getGameDateFromRecord(record);

    if (!playerId || (!gameId && !gameDate)) {
      return;
    }

    const key = `${playerId}:${gameId || gameDate}`;
    const stats = gamesByKey.get(key) ?? {
      playerId,
      gameId,
      gameDate
    };

    stats.gameId = gameId;
    stats.gameDate = gameDate;

    if (includeSummary) {
      mergeNumberField(stats, 'goals', record, ['goals']);
      mergeNumberField(stats, 'assists', record, ['assists']);
      mergeNumberField(stats, 'shotsOnGoal', record, [
        'shots',
        'shotsOnGoal'
      ]);
      mergeNumberField(stats, 'plusMinus', record, ['plusMinus']);
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
    } else {
      mergeNumberField(stats, 'hits', record, ['hits']);
      mergeNumberField(stats, 'blockedShots', record, [
        'blockedShots',
        'blocks'
      ]);
    }

    const averageTimeOnIceMinutes =
      getAverageTimeOnIceMinutesFromRecord(record, 1);

    if (
      typeof averageTimeOnIceMinutes === 'number' &&
      averageTimeOnIceMinutes > 0
    ) {
      stats.averageTimeOnIceMinutes =
        roundOneDecimal(averageTimeOnIceMinutes);
    }

    gamesByKey.set(key, stats);
  };

  if (summaryResult.status === 'fulfilled') {
    summaryResult.value.forEach((record) =>
      mergeRecord(record, true)
    );
  } else {
    console.warn(
      `Skipping ${season} skater game-summary projections.`,
      summaryResult.reason
    );
  }

  if (realtimeResult.status === 'fulfilled') {
    realtimeResult.value.forEach((record) =>
      mergeRecord(record, false)
    );
  } else {
    console.warn(
      `Skipping ${season} skater game-realtime projections.`,
      realtimeResult.reason
    );
  }

  const gamesByPlayer =
    new Map<number, SkaterGameProjectionStats[]>();

  gamesByKey.forEach((partialGame) => {
    const game: SkaterGameProjectionStats = {
      gameId: partialGame.gameId ?? 0,
      gameDate: partialGame.gameDate ?? '',
      goals: partialGame.goals ?? 0,
      assists: partialGame.assists ?? 0,
      shotsOnGoal: partialGame.shotsOnGoal ?? 0,
      hits: partialGame.hits ?? 0,
      blockedShots: partialGame.blockedShots ?? 0,
      plusMinus: partialGame.plusMinus ?? 0,
      powerPlayPoints: partialGame.powerPlayPoints ?? 0,
      shortHandedPoints: partialGame.shortHandedPoints ?? 0,
      gameWinningGoals: partialGame.gameWinningGoals ?? 0,
      overtimeGoals: partialGame.overtimeGoals ?? 0,
      averageTimeOnIceMinutes:
        partialGame.averageTimeOnIceMinutes ?? 0
    };

    const playerGames =
      gamesByPlayer.get(partialGame.playerId) ?? [];

    playerGames.push(game);
    gamesByPlayer.set(partialGame.playerId, playerGames);
  });

  gamesByPlayer.forEach((games) => {
    games.sort((first, second) => {
      const dateComparison =
        second.gameDate.localeCompare(first.gameDate);

      return dateComparison !== 0
        ? dateComparison
        : second.gameId - first.gameId;
    });
  });

  return gamesByPlayer;
}

async function loadGoalieGameProjectionStats(
  season: string
): Promise<Map<string, GoalieGameProjectionStats[]>> {
  const gamesByKey =
    new Map<string, {
      teamAbbreviation: string;
      game: GoalieGameProjectionStats;
    }>();

  try {
    const records = await getGoalieGameSummaryStats(season);

    for (const record of records) {
      const teamAbbreviation =
        getTeamAbbreviationFromRecord(record);

      const gameId = getGameIdFromRecord(record) ?? 0;
      const gameDate = getGameDateFromRecord(record);

      if (
        !teamAbbreviation ||
        (!gameId && !gameDate)
      ) {
        continue;
      }

      const key =
        `${teamAbbreviation}:${gameId || gameDate}`;

      const existing = gamesByKey.get(key) ?? {
        teamAbbreviation,
        game: {
          gameId,
          gameDate,
          saves: 0,
          shotsAgainst: 0,
          won: false,
          shutout: false
        }
      };

      existing.game.saves +=
        getNumberFromRecord(record, ['saves']) ?? 0;

      existing.game.shotsAgainst +=
        getNumberFromRecord(record, ['shotsAgainst']) ?? 0;

      existing.game.won =
        existing.game.won ||
        (getNumberFromRecord(record, ['wins', 'win']) ?? 0) > 0;

      existing.game.shutout =
        existing.game.shutout ||
        (getNumberFromRecord(record, ['shutouts', 'shutout']) ?? 0) > 0;

      gamesByKey.set(key, existing);
    }
  } catch (error: unknown) {
    console.warn(
      `Skipping ${season} goalie game projections.`,
      error
    );
  }

  const gamesByTeam =
    new Map<string, GoalieGameProjectionStats[]>();

  gamesByKey.forEach(({ teamAbbreviation, game }) => {
    const teamGames = gamesByTeam.get(teamAbbreviation) ?? [];

    teamGames.push(game);
    gamesByTeam.set(teamAbbreviation, teamGames);
  });

  gamesByTeam.forEach((games) => {
    games.sort((first, second) => {
      const dateComparison =
        second.gameDate.localeCompare(first.gameDate);

      return dateComparison !== 0
        ? dateComparison
        : second.gameId - first.gameId;
    });
  });

  return gamesByTeam;
}

function getProjectionDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function filterGamesByProjectionDate<T extends { gameDate: string }>(
  games: T[],
  projectionAsOfDate: Date | undefined
): T[] {
  if (!projectionAsOfDate) {
    return games;
  }

  const dateKey = getProjectionDateKey(projectionAsOfDate);
  return games.filter((game) => !game.gameDate || game.gameDate <= dateKey);
}

function filterGameMapByProjectionDate<K, T extends { gameDate: string }>(
  gamesByKey: ReadonlyMap<K, T[]>,
  projectionAsOfDate: Date | undefined
): Map<K, T[]> {
  if (!projectionAsOfDate) {
    return new Map(gamesByKey);
  }

  const filtered = new Map<K, T[]>();

  gamesByKey.forEach((games, key) => {
    const eligible = filterGamesByProjectionDate(games, projectionAsOfDate);

    if (eligible.length > 0) {
      filtered.set(key, eligible);
    }
  });

  return filtered;
}

function filterScheduleMapByProjectionDate(
  schedules: ReadonlyMap<string, NhlTeamSeasonGame[]>,
  projectionAsOfDate: Date | undefined
): Map<string, NhlTeamSeasonGame[]> {
  if (!projectionAsOfDate) {
    return new Map(schedules);
  }

  const dateKey = getProjectionDateKey(projectionAsOfDate);
  const filtered = new Map<string, NhlTeamSeasonGame[]>();

  schedules.forEach((games, teamAbbreviation) => {
    filtered.set(
      teamAbbreviation,
      games.filter((game) => !game.gameDate || game.gameDate <= dateKey)
    );
  });

  return filtered;
}

function summarizeSkaterGames(
  games: SkaterGameProjectionStats[]
): SkaterProjectionStats | null {
  if (games.length === 0) {
    return null;
  }

  const totals = games.reduce<SkaterProjectionStats>(
    (summary, game) => ({
      gamesPlayed: summary.gamesPlayed + 1,
      goals: summary.goals + game.goals,
      assists: summary.assists + game.assists,
      shotsOnGoal: summary.shotsOnGoal + game.shotsOnGoal,
      hits: summary.hits + game.hits,
      blockedShots: summary.blockedShots + game.blockedShots,
      plusMinus: summary.plusMinus + game.plusMinus,
      powerPlayPoints: summary.powerPlayPoints + game.powerPlayPoints,
      shortHandedPoints: summary.shortHandedPoints + game.shortHandedPoints,
      gameWinningGoals: summary.gameWinningGoals + game.gameWinningGoals,
      overtimeGoals: summary.overtimeGoals + game.overtimeGoals,
      averageTimeOnIceMinutes:
        summary.averageTimeOnIceMinutes + game.averageTimeOnIceMinutes
    }),
    {
      gamesPlayed: 0,
      goals: 0,
      assists: 0,
      shotsOnGoal: 0,
      hits: 0,
      blockedShots: 0,
      plusMinus: 0,
      powerPlayPoints: 0,
      shortHandedPoints: 0,
      gameWinningGoals: 0,
      overtimeGoals: 0,
      averageTimeOnIceMinutes: 0
    }
  );

  totals.averageTimeOnIceMinutes /= Math.max(1, totals.gamesPlayed);
  return totals;
}

function summarizeGoalieGames(
  games: GoalieGameProjectionStats[]
): GoalieProjectionStats | null {
  if (games.length === 0) {
    return null;
  }

  return games.reduce<GoalieProjectionStats>(
    (summary, game) => ({
      gamesPlayed: summary.gamesPlayed + 1,
      saves: summary.saves + game.saves,
      shotsAgainst: summary.shotsAgainst + game.shotsAgainst,
      wins: summary.wins + (game.won ? 1 : 0),
      shutouts: summary.shutouts + (game.shutout ? 1 : 0)
    }),
    {
      gamesPlayed: 0,
      saves: 0,
      shotsAgainst: 0,
      wins: 0,
      shutouts: 0
    }
  );
}

function summarizeSkaterGameMap(
  gamesByPlayer: ReadonlyMap<number, SkaterGameProjectionStats[]>
): Map<number, SkaterProjectionStats> {
  const summaries = new Map<number, SkaterProjectionStats>();

  gamesByPlayer.forEach((games, playerId) => {
    const summary = summarizeSkaterGames(games);

    if (summary) {
      summaries.set(playerId, summary);
    }
  });

  return summaries;
}

function summarizeGoalieGameMap(
  gamesByTeam: ReadonlyMap<string, GoalieGameProjectionStats[]>
): Map<string, GoalieProjectionStats> {
  const summaries = new Map<string, GoalieProjectionStats>();

  gamesByTeam.forEach((games, teamAbbreviation) => {
    const summary = summarizeGoalieGames(games);

    if (summary) {
      summaries.set(teamAbbreviation, summary);
    }
  });

  return summaries;
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

function calculateDiminishingGamePoints(
  eventCount: number,
  values: DiminishingReturnValues
): number {
  if (eventCount <= 0) {
    return 0;
  }

  let points = values.first;

  if (eventCount >= 2) {
    points += values.second;
  }

  if (eventCount >= 3) {
    points += (eventCount - 2) * values.additional;
  }

  return points;
}

function getSkaterSampleTrust(gamesPlayed: number): number {
  if (gamesPlayed >= 60) {
    return 0.94;
  }

  if (gamesPlayed >= 40) {
    return 0.8;
  }

  if (gamesPlayed >= 25) {
    return 0.64;
  }

  if (gamesPlayed >= 10) {
    return 0.42;
  }

  if (gamesPlayed >= 5) {
    return 0.25;
  }

  if (gamesPlayed >= 1) {
    return 0.1;
  }

  return 0;
}

function roundOneDecimal(value: number): number {
  return Number(value.toFixed(1));
}

function getDefaultReliabilityRating(position: DraftPosition): number {
  return position === 'G' ? 68 : 48;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0) /
    values.length;
}

function standardDeviation(values: number[]): number | null {
  const mean = average(values);

  if (mean === null || values.length < 2) {
    return null;
  }

  const variance =
    values.reduce(
      (total, value) =>
        total + Math.pow(value - mean, 2),
      0
    ) / values.length;

  return Math.sqrt(variance);
}

function getWindowAverage(
  values: number[],
  size: number
): number | null {
  return average(values.slice(0, size));
}

function getAppearanceWeight(
  gameTimeOnIceMinutes: number,
  normalTimeOnIceMinutes: number | null
): number {
  if (
    gameTimeOnIceMinutes <= 0 ||
    typeof normalTimeOnIceMinutes !== 'number' ||
    normalTimeOnIceMinutes <= 0
  ) {
    return 1;
  }

  const workloadRatio =
    gameTimeOnIceMinutes / normalTimeOnIceMinutes;

  if (workloadRatio >= 0.65) {
    return 1;
  }

  return clamp(workloadRatio / 0.65, 0.15, 0.95);
}

function adjustPartialAppearancePoints(
  fantasyPoints: number,
  seasonFantasyPointsPerGame: number,
  appearanceWeight: number
): number {
  return seasonFantasyPointsPerGame +
    (fantasyPoints - seasonFantasyPointsPerGame) *
      appearanceWeight;
}

function isFinalTeamGame(game: NhlTeamSeasonGame): boolean {
  const hasFinalScores =
    typeof game.homeTeam.score === 'number' &&
    typeof game.awayTeam.score === 'number';

  return (
    game.gameState === 'OFF' ||
    game.gameState === 'FINAL' ||
    hasFinalScores
  );
}


interface SeasonDecisionMetrics {
  currentSeasonFantasyPoints: number | null;
  projectedRestOfSeasonPoints: number | null;
  projectedFinalSeasonPoints: number | null;
  expectedFantasyPointsToDate: number | null;
  performanceVsProjectionPoints: number | null;
  performanceVsProjectionPercent: number | null;
  seasonTeamGamesPlayed: number | null;
  seasonGamesRemaining: number | null;
}

function getRegularSeasonGames(
  schedule: NhlTeamSeasonGame[]
): NhlTeamSeasonGame[] {
  return schedule
    .filter((game) => game.gameType === 2)
    .sort((first, second) =>
      first.gameDate.localeCompare(second.gameDate) ||
      first.id - second.id
    );
}

function getCurrentTeamCycleDecisionData(input: {
  teamAbbreviation: string;
  schedule: NhlTeamSeasonGame[];
  requiredGamesPerCycle: number;
  appearedGameIds?: ReadonlySet<number>;
  goalieUnit?: boolean;
}): {
  currentTeamCycleNumber: number | null;
  currentTeamCycleGames: ProjectionCycleGameMarker[];
} {
  const requiredGamesPerCycle = Math.max(
    1,
    Math.floor(input.requiredGamesPerCycle)
  );
  const schedule = getRegularSeasonGames(input.schedule);

  if (schedule.length === 0) {
    return {
      currentTeamCycleNumber: null,
      currentTeamCycleGames: []
    };
  }

  const totalCycleCount = Math.max(
    1,
    Math.ceil(schedule.length / requiredGamesPerCycle)
  );
  let currentCycleNumber = totalCycleCount;
  let currentCycleGames = schedule.slice(
    (totalCycleCount - 1) * requiredGamesPerCycle,
    totalCycleCount * requiredGamesPerCycle
  );

  for (
    let cycleIndex = 0;
    cycleIndex < totalCycleCount;
    cycleIndex += 1
  ) {
    const cycleGames = schedule.slice(
      cycleIndex * requiredGamesPerCycle,
      (cycleIndex + 1) * requiredGamesPerCycle
    );

    if (!cycleGames.every(isFinalTeamGame)) {
      currentCycleNumber = cycleIndex + 1;
      currentCycleGames = cycleGames;
      break;
    }

    if (cycleIndex === totalCycleCount - 1) {
      currentCycleNumber = cycleIndex + 2;
      currentCycleGames = [];
    }
  }

  const markers = currentCycleGames.map((game) => {
    const isHome =
      game.homeTeam.abbrev === input.teamAbbreviation;
    const opponentAbbreviation = isHome
      ? game.awayTeam.abbrev
      : game.homeTeam.abbrev;
    let status: ProjectionCycleGameMarker['status'] =
      'upcoming';

    if (isFinalTeamGame(game)) {
      status = input.goalieUnit ||
        input.appearedGameIds?.has(game.id)
        ? 'played'
        : 'missed';
    }

    return {
      gameId: game.id,
      gameDate: game.gameDate,
      opponentAbbreviation,
      venue: isHome ? 'home' : 'away',
      status
    } satisfies ProjectionCycleGameMarker;
  });

  return {
    currentTeamCycleNumber: currentCycleNumber,
    currentTeamCycleGames: markers
  };
}

function buildSeasonDecisionMetrics(input: {
  currentSeasonFantasyPoints: number | null;
  projectedSeasonPoints: number | null;
  draftProjectedSeasonPoints: number | null;
  teamSchedule: NhlTeamSeasonGame[];
  fallbackGamesPlayed: number | null;
}): SeasonDecisionMetrics {
  const regularSeasonGames = getRegularSeasonGames(
    input.teamSchedule
  );
  const seasonLength = regularSeasonGames.length > 0
    ? regularSeasonGames.length
    : 82;
  const teamGamesPlayed = regularSeasonGames.length > 0
    ? regularSeasonGames.filter(isFinalTeamGame).length
    : Math.max(0, input.fallbackGamesPlayed ?? 0);
  const seasonGamesRemaining = Math.max(
    0,
    seasonLength - teamGamesPlayed
  );
  const currentSeasonFantasyPoints =
    typeof input.currentSeasonFantasyPoints === 'number'
      ? input.currentSeasonFantasyPoints
      : null;
  const currentOutlook =
    input.projectedSeasonPoints ??
    input.draftProjectedSeasonPoints;
  const baselineOutlook =
    input.draftProjectedSeasonPoints ??
    input.projectedSeasonPoints;
  const projectedRestOfSeasonPoints =
    typeof currentOutlook === 'number'
      ? currentOutlook /
        Math.max(1, seasonLength) *
        seasonGamesRemaining
      : null;
  const projectedFinalSeasonPoints =
    currentSeasonFantasyPoints !== null &&
    projectedRestOfSeasonPoints !== null
      ? currentSeasonFantasyPoints +
        projectedRestOfSeasonPoints
      : null;
  const expectedFantasyPointsToDate =
    typeof baselineOutlook === 'number'
      ? baselineOutlook /
        Math.max(1, seasonLength) *
        teamGamesPlayed
      : null;
  const performanceVsProjectionPoints =
    currentSeasonFantasyPoints !== null &&
    expectedFantasyPointsToDate !== null
      ? currentSeasonFantasyPoints -
        expectedFantasyPointsToDate
      : null;
  const performanceVsProjectionPercent =
    performanceVsProjectionPoints !== null &&
    expectedFantasyPointsToDate !== null &&
    expectedFantasyPointsToDate > 0
      ? performanceVsProjectionPoints /
        expectedFantasyPointsToDate *
        100
      : null;

  return {
    currentSeasonFantasyPoints:
      currentSeasonFantasyPoints === null
        ? null
        : roundOneDecimal(currentSeasonFantasyPoints),
    projectedRestOfSeasonPoints:
      projectedRestOfSeasonPoints === null
        ? null
        : roundOneDecimal(projectedRestOfSeasonPoints),
    projectedFinalSeasonPoints:
      projectedFinalSeasonPoints === null
        ? null
        : roundOneDecimal(projectedFinalSeasonPoints),
    expectedFantasyPointsToDate:
      expectedFantasyPointsToDate === null
        ? null
        : roundOneDecimal(expectedFantasyPointsToDate),
    performanceVsProjectionPoints:
      performanceVsProjectionPoints === null
        ? null
        : roundOneDecimal(performanceVsProjectionPoints),
    performanceVsProjectionPercent:
      performanceVsProjectionPercent === null
        ? null
        : roundOneDecimal(performanceVsProjectionPercent),
    seasonTeamGamesPlayed: teamGamesPlayed,
    seasonGamesRemaining
  };
}

function createBreakdownItem(
  key: string,
  label: string,
  statValue: number,
  statUnit: string,
  fantasyPoints: number,
  note?: string
): ProjectionStatBreakdownItem {
  return {
    key,
    label,
    statValue: roundOneDecimal(statValue),
    statUnit,
    fantasyPoints: roundOneDecimal(fantasyPoints),
    note: note ?? null
  };
}

function buildSkaterSeasonBreakdownFromGames(
  position: DraftPosition,
  games: SkaterGameProjectionStats[]
): ProjectionStatBreakdownItem[] {
  const positionRules = position === 'D'
    ? defaultScoringRules.defense
    : defaultScoringRules.forward;
  const primaryAssistShare = getProjectionPrimaryAssistShare(position);
  const secondaryAssistShare = 1 - primaryAssistShare;
  let goals = 0;
  let assists = 0;
  let shotsOnGoal = 0;
  let hits = 0;
  let blockedShots = 0;
  let powerPlayPoints = 0;
  let shortHandedPoints = 0;
  let gameWinningGoals = 0;
  let overtimeGoals = 0;
  let timeOnIceMinutes = 0;
  let goalFantasyPoints = 0;
  let primaryAssistFantasyPoints = 0;
  let secondaryAssistFantasyPoints = 0;
  let shotFantasyPoints = 0;
  let hitFantasyPoints = 0;
  let blockFantasyPoints = 0;
  let powerPlayFantasyPoints = 0;
  let shortHandedFantasyPoints = 0;
  let gameWinningFantasyPoints = 0;
  let overtimeFantasyPoints = 0;
  let timeOnIceFantasyPoints = 0;

  for (const game of games) {
    goals += game.goals;
    assists += game.assists;
    shotsOnGoal += game.shotsOnGoal;
    hits += game.hits;
    blockedShots += game.blockedShots;
    powerPlayPoints += game.powerPlayPoints;
    shortHandedPoints += game.shortHandedPoints;
    gameWinningGoals += game.gameWinningGoals;
    overtimeGoals += game.overtimeGoals;
    timeOnIceMinutes += game.averageTimeOnIceMinutes;
    goalFantasyPoints += calculateDiminishingGamePoints(
      game.goals,
      positionRules.goal
    );
    primaryAssistFantasyPoints +=
      calculateDiminishingGamePoints(
        game.assists,
        positionRules.primaryAssist
      ) * primaryAssistShare;
    secondaryAssistFantasyPoints +=
      calculateDiminishingGamePoints(
        game.assists,
        positionRules.secondaryAssist
      ) * secondaryAssistShare;
    shotFantasyPoints +=
      game.shotsOnGoal * positionRules.shotOnGoal;
    hitFantasyPoints +=
      game.hits * positionRules.hit;
    blockFantasyPoints +=
      game.blockedShots * positionRules.blockedShot;
    powerPlayFantasyPoints +=
      game.powerPlayPoints *
      positionRules.powerPlayPoint;
    shortHandedFantasyPoints +=
      game.shortHandedPoints *
      positionRules.shortHandedPoint;
    gameWinningFantasyPoints +=
      game.gameWinningGoals *
      defaultScoringRules.gameWinningGoal;
    overtimeFantasyPoints +=
      game.overtimeGoals *
      defaultScoringRules.overtimeGoal;
    timeOnIceFantasyPoints +=
      calculateProjectedToiPoints(
        position,
        {
          averageTimeOnIceMinutes:
            game.averageTimeOnIceMinutes,
          plusMinus: game.plusMinus
        },
        1
      );
  }

  return [
    createBreakdownItem(
      'goals',
      'Goals',
      goals,
      'G',
      goalFantasyPoints
    ),
    createBreakdownItem(
      'primary-assists',
      'Primary assists',
      assists * primaryAssistShare,
      'estimated',
      primaryAssistFantasyPoints,
      `Projection V11 estimates ${Math.round(primaryAssistShare * 100)}% of assists as primary.`
    ),
    createBreakdownItem(
      'secondary-assists',
      'Secondary assists',
      assists * secondaryAssistShare,
      'estimated',
      secondaryAssistFantasyPoints,
      `Projection V11 estimates ${Math.round(secondaryAssistShare * 100)}% of assists as secondary.`
    ),
    createBreakdownItem(
      'shots',
      'Shots on goal',
      shotsOnGoal,
      'SOG',
      shotFantasyPoints
    ),
    createBreakdownItem(
      'hits',
      'Hits',
      hits,
      'HIT',
      hitFantasyPoints
    ),
    createBreakdownItem(
      'blocks',
      'Blocked shots',
      blockedShots,
      'BLK',
      blockFantasyPoints
    ),
    createBreakdownItem(
      'power-play',
      'Power-play points',
      powerPlayPoints,
      'PPP',
      powerPlayFantasyPoints
    ),
    createBreakdownItem(
      'short-handed',
      'Short-handed points',
      shortHandedPoints,
      'SHP',
      shortHandedFantasyPoints
    ),
    createBreakdownItem(
      'game-winners',
      'Game-winning goals',
      gameWinningGoals,
      'GWG',
      gameWinningFantasyPoints
    ),
    createBreakdownItem(
      'overtime',
      'Overtime goals',
      overtimeGoals,
      'OTG',
      overtimeFantasyPoints
    ),
    createBreakdownItem(
      'time-on-ice',
      'Time on ice',
      timeOnIceMinutes,
      'minutes',
      timeOnIceFantasyPoints,
      position === 'D'
        ? 'Defense TOI value includes the scoring model’s bounded role multiplier.'
        : 'Forward TOI value uses the league scoring multiplier.'
    )
  ].filter((item) =>
    item.statValue > 0 ||
    Math.abs(item.fantasyPoints) >= 0.05
  );
}

function buildSkaterSeasonBreakdownFromStats(
  position: DraftPosition,
  stats: Partial<SkaterProjectionStats>
): ProjectionStatBreakdownItem[] {
  const positionRules = position === 'D'
    ? defaultScoringRules.defense
    : defaultScoringRules.forward;
  const gamesPlayed = Math.max(1, stats.gamesPlayed ?? 0);
  const goals = stats.goals ?? 0;
  const assists = stats.assists ?? 0;
  const shotsOnGoal = stats.shotsOnGoal ?? 0;
  const hits = stats.hits ?? 0;
  const blockedShots = stats.blockedShots ?? 0;
  const powerPlayPoints = stats.powerPlayPoints ?? 0;
  const shortHandedPoints = stats.shortHandedPoints ?? 0;
  const gameWinningGoals = stats.gameWinningGoals ?? 0;
  const overtimeGoals = stats.overtimeGoals ?? 0;
  const averageTimeOnIceMinutes = stats.averageTimeOnIceMinutes ?? 0;
  const primaryAssistShare = getProjectionPrimaryAssistShare(position);
  const safePrimaryAssistShare = clamp(primaryAssistShare, 0.45, 0.65);
  const estimatedPrimaryAssists = assists * safePrimaryAssistShare;
  const estimatedSecondaryAssists = assists * (1 - safePrimaryAssistShare);

  return [
    createBreakdownItem(
      'goals',
      'Goals',
      goals,
      'G',
      estimateDiminishingSeasonTotal(
        goals,
        gamesPlayed,
        positionRules.goal
      )
    ),
    createBreakdownItem(
      'primary-assists',
      'Primary assists',
      estimatedPrimaryAssists,
      'estimated',
      estimateDiminishingSeasonTotal(
        estimatedPrimaryAssists,
        gamesPlayed,
        positionRules.primaryAssist
      ),
      `Projection V11 estimates ${Math.round(safePrimaryAssistShare * 100)}% of assists as primary.`
    ),
    createBreakdownItem(
      'secondary-assists',
      'Secondary assists',
      estimatedSecondaryAssists,
      'estimated',
      estimateDiminishingSeasonTotal(
        estimatedSecondaryAssists,
        gamesPlayed,
        positionRules.secondaryAssist
      ),
      `Projection V11 estimates ${Math.round((1 - safePrimaryAssistShare) * 100)}% of assists as secondary.`
    ),
    createBreakdownItem(
      'shots',
      'Shots on goal',
      shotsOnGoal,
      'SOG',
      shotsOnGoal * positionRules.shotOnGoal
    ),
    createBreakdownItem(
      'hits',
      'Hits',
      hits,
      'HIT',
      hits * positionRules.hit
    ),
    createBreakdownItem(
      'blocks',
      'Blocked shots',
      blockedShots,
      'BLK',
      blockedShots * positionRules.blockedShot
    ),
    createBreakdownItem(
      'power-play',
      'Power-play points',
      powerPlayPoints,
      'PPP',
      powerPlayPoints *
        positionRules.powerPlayPoint
    ),
    createBreakdownItem(
      'short-handed',
      'Short-handed points',
      shortHandedPoints,
      'SHP',
      shortHandedPoints *
        positionRules.shortHandedPoint
    ),
    createBreakdownItem(
      'game-winners',
      'Game-winning goals',
      gameWinningGoals,
      'GWG',
      gameWinningGoals *
        defaultScoringRules.gameWinningGoal
    ),
    createBreakdownItem(
      'overtime',
      'Overtime goals',
      overtimeGoals,
      'OTG',
      overtimeGoals *
        defaultScoringRules.overtimeGoal
    ),
    createBreakdownItem(
      'time-on-ice',
      'Time on ice',
      averageTimeOnIceMinutes * gamesPlayed,
      'minutes',
      calculateProjectedToiPoints(
        position,
        {
          ...stats,
          gamesPlayed,
          goals,
          assists,
          shotsOnGoal,
          hits,
          blockedShots,
          powerPlayPoints,
          shortHandedPoints,
          gameWinningGoals,
          overtimeGoals,
          averageTimeOnIceMinutes,
          plusMinus: stats.plusMinus ?? 0
        },
        gamesPlayed
      ),
      'Built from season aggregate NHL statistics.'
    )
  ].filter((item) =>
    item.statValue > 0 ||
    Math.abs(item.fantasyPoints) >= 0.05
  );
}

function buildGoalieSeasonBreakdown(
  games: GoalieGameProjectionStats[],
  stats?: Partial<GoalieProjectionStats>
): ProjectionStatBreakdownItem[] {
  let gamesPlayed = 0;
  let saves = 0;
  let wins = 0;
  let shutouts = 0;
  let baseFantasyPoints = 0;
  let saveFantasyPoints = 0;
  let qualityFantasyPoints = 0;
  let winFantasyPoints = 0;
  let shutoutFantasyPoints = 0;
  let capAdjustment = 0;

  if (games.length > 0) {
    for (const game of games) {
      gamesPlayed += 1;
      saves += game.saves;
      wins += game.won ? 1 : 0;
      shutouts += game.shutout ? 1 : 0;
      const savePercentage = game.shotsAgainst > 0
        ? game.saves / game.shotsAgainst
        : 0;
      const gameBase =
        defaultScoringRules.goalieGameBase;
      const gameSaves =
        game.saves * defaultScoringRules.goalieSave;
      const gameQuality =
        calculateGoalieSaveQualityPoints(
          savePercentage,
          defaultScoringRules
        );
      const gameWin = game.won
        ? defaultScoringRules.goalieWin
        : 0;
      const gameShutout = game.shutout
        ? defaultScoringRules.goalieShutout
        : 0;
      const uncapped = gameBase + gameSaves +
        gameQuality + gameWin + gameShutout;
      const capped = Math.min(
        defaultScoringRules.goalieGameMaximum,
        uncapped
      );

      baseFantasyPoints += gameBase;
      saveFantasyPoints += gameSaves;
      qualityFantasyPoints += gameQuality;
      winFantasyPoints += gameWin;
      shutoutFantasyPoints += gameShutout;
      capAdjustment += capped - uncapped;
    }
  } else if (stats && (stats.gamesPlayed ?? 0) > 0) {
    gamesPlayed = stats.gamesPlayed ?? 0;
    saves = stats.saves ?? 0;
    wins = stats.wins ?? 0;
    shutouts = stats.shutouts ?? 0;
    const shotsAgainst = stats.shotsAgainst ?? 0;
    const savePercentage = shotsAgainst > 0
      ? saves / shotsAgainst
      : 0;
    baseFantasyPoints =
      gamesPlayed * defaultScoringRules.goalieGameBase;
    saveFantasyPoints =
      saves * defaultScoringRules.goalieSave;
    qualityFantasyPoints =
      gamesPlayed * calculateGoalieSaveQualityPoints(
        savePercentage,
        defaultScoringRules
      );
    winFantasyPoints =
      wins * defaultScoringRules.goalieWin;
    shutoutFantasyPoints =
      shutouts * defaultScoringRules.goalieShutout;
    const uncapped = baseFantasyPoints +
      saveFantasyPoints + qualityFantasyPoints +
      winFantasyPoints + shutoutFantasyPoints;
    capAdjustment = Math.min(
      uncapped,
      gamesPlayed *
        defaultScoringRules.goalieGameMaximum
    ) - uncapped;
  }

  const items = [
    createBreakdownItem(
      'goalie-games',
      'Goalie games',
      gamesPlayed,
      'GP',
      baseFantasyPoints
    ),
    createBreakdownItem(
      'saves',
      'Saves',
      saves,
      'SV',
      saveFantasyPoints
    ),
    createBreakdownItem(
      'save-quality',
      'Save quality',
      gamesPlayed,
      'games',
      qualityFantasyPoints,
      'Calculated game by game from save percentage when game rows are available.'
    ),
    createBreakdownItem(
      'wins',
      'Wins',
      wins,
      'W',
      winFantasyPoints
    ),
    createBreakdownItem(
      'shutouts',
      'Shutouts',
      shutouts,
      'SO',
      shutoutFantasyPoints
    )
  ];

  if (Math.abs(capAdjustment) >= 0.05) {
    items.push(
      createBreakdownItem(
        'game-cap',
        'Per-game scoring cap',
        gamesPlayed,
        'games checked',
        capAdjustment,
        'Negative adjustment applied when an individual goalie game exceeds the league maximum.'
      )
    );
  }

  return items.filter((item) =>
    item.statValue > 0 ||
    Math.abs(item.fantasyPoints) >= 0.05
  );
}

function getRecentMissedTeamGameCount(
  games: SkaterGameProjectionStats[],
  teamSchedule: NhlTeamSeasonGame[]
): number {
  const recentTeamGames = teamSchedule
    .filter(isFinalTeamGame)
    .sort((first, second) =>
      second.gameDate.localeCompare(first.gameDate) ||
      second.id - first.id
    )
    .slice(0, 20);

  if (recentTeamGames.length === 0) {
    return 0;
  }

  const recentAppearanceIds = new Set(
    games
      .slice(0, 20)
      .map((game) => game.gameId)
      .filter((gameId) => gameId > 0)
  );

  const recentAppearanceDates = new Set(
    games
      .slice(0, 20)
      .map((game) => game.gameDate)
      .filter(Boolean)
  );

  return recentTeamGames.filter((game) =>
    !recentAppearanceIds.has(game.id) &&
    !recentAppearanceDates.has(game.gameDate)
  ).length;
}

function getWeightedRecentAverage(
  lastThree: number | null,
  lastFive: number | null,
  lastTen: number | null,
  lastTwenty: number | null
): number | null {
  // Short windows capture real role/form changes, but receive deliberately
  // small weights so one explosive game cannot overwhelm the stable baseline.
  const weightedValues = [
    { value: lastThree, weight: 0.05 },
    { value: lastFive, weight: 0.15 },
    { value: lastTen, weight: 0.5 },
    { value: lastTwenty, weight: 0.3 }
  ].filter(
    (
      entry
    ): entry is {
      value: number;
      weight: number;
    } => typeof entry.value === 'number'
  );

  if (weightedValues.length === 0) {
    return null;
  }

  const totalWeight = weightedValues.reduce(
    (total, entry) => total + entry.weight,
    0
  );

  return weightedValues.reduce(
    (total, entry) =>
      total + entry.value * entry.weight,
    0
  ) / totalWeight;
}

function getConsistencyRating(
  fantasyPoints: number[]
): number | null {
  const mean = average(fantasyPoints);
  const deviation = standardDeviation(fantasyPoints);

  if (
    mean === null ||
    deviation === null ||
    mean <= 0
  ) {
    return null;
  }

  const coefficientOfVariation = deviation / mean;

  return roundOneDecimal(
    clamp(
      100 * (1 - coefficientOfVariation / 1.25),
      35,
      98
    )
  );
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
    return Math.min(projection, cap * 0.94);
  }

  if (gamesPlayed >= 25) {
    return Math.min(projection, cap * 0.84);
  }

  if (gamesPlayed >= 10) {
    return Math.min(projection, cap * 0.72);
  }

  if (gamesPlayed >= 1) {
    return Math.min(projection, cap * 0.58);
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

function calculateSkaterRawFantasyPoints(
  position: DraftPosition,
  stats: Partial<SkaterProjectionStats>,
  gamesPlayed: number,
  primaryAssistShare: number = getProjectionPrimaryAssistShare(position)
): number {
  if (gamesPlayed <= 0) {
    return 0;
  }

  const positionRules =
    position === 'D'
      ? defaultScoringRules.defense
      : defaultScoringRules.forward;

  const goals = stats.goals ?? 0;
  const assists = stats.assists ?? 0;

  const safePrimaryAssistShare = clamp(primaryAssistShare, 0.45, 0.65);
  const estimatedPrimaryAssists = assists * safePrimaryAssistShare;
  const estimatedSecondaryAssists = assists * (1 - safePrimaryAssistShare);

  return (
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
    (stats.shotsOnGoal ?? 0) * positionRules.shotOnGoal +
    (stats.hits ?? 0) * positionRules.hit +
    (stats.blockedShots ?? 0) * positionRules.blockedShot +
    (stats.powerPlayPoints ?? 0) *
      positionRules.powerPlayPoint +
    (stats.shortHandedPoints ?? 0) *
      positionRules.shortHandedPoint +
    (stats.gameWinningGoals ?? 0) *
      defaultScoringRules.gameWinningGoal +
    (stats.overtimeGoals ?? 0) *
      defaultScoringRules.overtimeGoal +
    calculateProjectedToiPoints(
      position,
      stats,
      gamesPlayed
    )
  );
}

function calculateSkaterSeasonPace(
  position: DraftPosition,
  stats: Partial<SkaterProjectionStats> | undefined
): number | null {
  const gamesPlayed = stats?.gamesPlayed ?? 0;

  if (gamesPlayed <= 0) {
    return null;
  }

  const rawPoints = calculateSkaterRawFantasyPoints(
    position,
    stats ?? {},
    gamesPlayed
  );

  return rawPoints / gamesPlayed * 82;
}

function calculateSkaterGameFantasyPoints(
  position: DraftPosition,
  stats: SkaterGameProjectionStats
): number {
  const positionRules =
    position === 'D'
      ? defaultScoringRules.defense
      : defaultScoringRules.forward;

  const primaryAssistShare = getProjectionPrimaryAssistShare(position);
  const assistPoints =
    calculateDiminishingGamePoints(
      stats.assists,
      positionRules.primaryAssist
    ) * primaryAssistShare +
    calculateDiminishingGamePoints(
      stats.assists,
      positionRules.secondaryAssist
    ) * (1 - primaryAssistShare);

  const toiPoints =
    calculateProjectedToiPoints(
      position,
      {
        averageTimeOnIceMinutes:
          stats.averageTimeOnIceMinutes,
        plusMinus: stats.plusMinus
      },
      1
    );

  return (
    calculateDiminishingGamePoints(
      stats.goals,
      positionRules.goal
    ) +
    assistPoints +
    stats.shotsOnGoal * positionRules.shotOnGoal +
    stats.hits * positionRules.hit +
    stats.blockedShots * positionRules.blockedShot +
    stats.powerPlayPoints *
      positionRules.powerPlayPoint +
    stats.shortHandedPoints *
      positionRules.shortHandedPoint +
    stats.gameWinningGoals *
      defaultScoringRules.gameWinningGoal +
    stats.overtimeGoals *
      defaultScoringRules.overtimeGoal +
    toiPoints
  );
}

function calculateSkaterSustainableGameFantasyPoints(
  position: DraftPosition,
  stats: SkaterGameProjectionStats
): number {
  const positionRules =
    position === 'D'
      ? defaultScoringRules.defense
      : defaultScoringRules.forward;
  const primaryAssistShare = getProjectionPrimaryAssistShare(position);
  const goalPoints = calculateDiminishingGamePoints(
    stats.goals,
    positionRules.goal
  );
  const assistPoints =
    calculateDiminishingGamePoints(
      stats.assists,
      positionRules.primaryAssist
    ) * primaryAssistShare +
    calculateDiminishingGamePoints(
      stats.assists,
      positionRules.secondaryAssist
    ) * (1 - primaryAssistShare);
  const volumeAndRolePoints =
    stats.shotsOnGoal * positionRules.shotOnGoal +
    stats.hits * positionRules.hit +
    stats.blockedShots * positionRules.blockedShot +
    stats.powerPlayPoints * positionRules.powerPlayPoint * 0.6 +
    calculateProjectedToiPoints(
      position,
      {
        averageTimeOnIceMinutes: stats.averageTimeOnIceMinutes,
        plusMinus: stats.plusMinus
      },
      1
    );
  const volatileOutcomePoints =
    goalPoints +
    assistPoints +
    stats.powerPlayPoints * positionRules.powerPlayPoint * 0.4 +
    stats.shortHandedPoints * positionRules.shortHandedPoint +
    stats.gameWinningGoals * defaultScoringRules.gameWinningGoal +
    stats.overtimeGoals * defaultScoringRules.overtimeGoal;

  // Recent opportunity is more predictive than a short run of finishing.
  // Keep all repeatable volume/role value and only 30% of volatile outcomes.
  return volumeAndRolePoints + volatileOutcomePoints * 0.3;
}

function buildSkaterRecentFormMetrics(
  position: DraftPosition,
  games: SkaterGameProjectionStats[],
  seasonAverageTimeOnIceMinutes: number | null,
  teamSchedule: NhlTeamSeasonGame[]
): RecentFormMetrics {
  // NHL game-level rows exist only when the player appeared. A missed team
  // game is therefore excluded rather than inserted as an artificial zero.
  const rawFantasyPoints = games.map((game) =>
    calculateSkaterGameFantasyPoints(position, game)
  );
  const sustainableFantasyPoints = games.map((game) =>
    calculateSkaterSustainableGameFantasyPoints(position, game)
  );

  const rawSeasonFantasyPointsPerGame =
    average(rawFantasyPoints) ?? 0;
  const seasonSustainableFantasyPointsPerGame =
    average(sustainableFantasyPoints) ?? 0;

  const seasonToi =
    seasonAverageTimeOnIceMinutes ??
    average(
      games
        .map((game) => game.averageTimeOnIceMinutes)
        .filter((value) => value > 0)
    );

  const weightedGames = games.map((game, index) => {
    const weight = getAppearanceWeight(
      game.averageTimeOnIceMinutes,
      seasonToi
    );

    return {
      weight,
      fantasyPoints: adjustPartialAppearancePoints(
        rawFantasyPoints[index] ?? 0,
        rawSeasonFantasyPointsPerGame,
        weight
      ),
      sustainableFantasyPoints: adjustPartialAppearancePoints(
        sustainableFantasyPoints[index] ?? 0,
        seasonSustainableFantasyPointsPerGame,
        weight
      )
    };
  });

  const adjustedFantasyPoints = weightedGames.map(
    (game) => game.fantasyPoints
  );
  const adjustedSustainableFantasyPoints = weightedGames.map(
    (game) => game.sustainableFantasyPoints
  );

  const lastThree =
    getWindowAverage(adjustedFantasyPoints, 3);

  const lastFive =
    getWindowAverage(adjustedFantasyPoints, 5);

  const lastTen =
    getWindowAverage(adjustedFantasyPoints, 10);

  const lastTwenty =
    getWindowAverage(adjustedFantasyPoints, 20);

  const weightedRecent =
    getWeightedRecentAverage(
      lastThree,
      lastFive,
      lastTen,
      lastTwenty
    );
  const weightedRecentSustainable =
    getWeightedRecentAverage(
      getWindowAverage(adjustedSustainableFantasyPoints, 3),
      getWindowAverage(adjustedSustainableFantasyPoints, 5),
      getWindowAverage(adjustedSustainableFantasyPoints, 10),
      getWindowAverage(adjustedSustainableFantasyPoints, 20)
    );

  const recentToi = average(
    games
      .slice(0, 5)
      .map((game) => game.averageTimeOnIceMinutes)
      .filter((value) => value > 0)
  );

  const recentWeights = weightedGames.slice(0, 20);
  const fullWeightRecentGames = recentWeights.filter(
    (game) => game.weight >= 0.999
  ).length;
  const partialWeightRecentGames = recentWeights.filter(
    (game) => game.weight < 0.999
  ).length;

  return {
    sampleSize: games.length,
    seasonFantasyPointsPerGame:
      rawSeasonFantasyPointsPerGame,
    recentThreeGameFantasyPointsPerGame:
      lastThree,
    recentFiveGameFantasyPointsPerGame:
      lastFive,
    recentTenGameFantasyPointsPerGame:
      lastTen,
    recentTwentyGameFantasyPointsPerGame:
      lastTwenty,
    weightedRecentFantasyPointsPerGame:
      weightedRecent,
    seasonSustainableFantasyPointsPerGame,
    weightedRecentSustainableFantasyPointsPerGame:
      weightedRecentSustainable,
    fantasyPointsStandardDeviation:
      standardDeviation(adjustedFantasyPoints.slice(0, 20)),
    consistencyRating:
      getConsistencyRating(adjustedFantasyPoints.slice(0, 20)),
    seasonAverageTimeOnIceMinutes:
      seasonToi,
    recentAverageTimeOnIceMinutes:
      recentToi,
    actualRecentAppearances: Math.min(games.length, 20),
    missedRecentTeamGames:
      getRecentMissedTeamGameCount(games, teamSchedule),
    weightedRecentAppearances: recentWeights.reduce(
      (total, game) => total + game.weight,
      0
    ),
    fullWeightRecentGames,
    partialWeightRecentGames
  };
}

function calculateSkaterReliabilityRating(
  position: DraftPosition,
  stats: Partial<SkaterProjectionStats>,
  gamesPlayed: number,
  consistencyRating: number | null
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
    clamp(gamesPlayed / 82, 0, 1) * 38;

  const toiTarget =
    position === 'D' ? 21 : 18;

  const toiScore =
    clamp(
      averageTimeOnIceMinutes / toiTarget,
      0,
      1
    ) * 23;

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
        ) * 18
      : clamp(
          (
            shotsPerGame +
            hitsPerGame * 0.15 +
            blocksPerGame * 0.2
          ) / 3,
          0,
          1
        ) * 18;

  const specialTeamsRoleScore =
    clamp(
      powerPlayPointsPerGame / 0.65,
      0,
      1
    ) * 5;

  const plusMinusStabilityScore =
    position === 'D'
      ? clamp(0.55 + plusMinusPerGame, 0, 1) * 5
      : clamp(
          0.5 + plusMinusPerGame * 0.35,
          0,
          1
        ) * 3;

  const availabilityBonus =
    gamesPlayed >= 78
      ? 5
      : gamesPlayed >= 70
        ? 3
        : 0;

  const baseRating = clamp(
    gamesScore +
      toiScore +
      volumeScore +
      specialTeamsRoleScore +
      plusMinusStabilityScore +
      availabilityBonus,
    35,
    98
  );

  if (typeof consistencyRating !== 'number') {
    return roundOneDecimal(baseRating);
  }

  return roundOneDecimal(
    clamp(
      baseRating * 0.78 +
        consistencyRating * 0.22,
      35,
      98
    )
  );
}

function calculateGoalieRawFantasyPoints(
  stats: Partial<GoalieProjectionStats>
): number {
  const saves = stats.saves ?? 0;
  const shotsAgainst = stats.shotsAgainst ?? 0;
  const wins = stats.wins ?? 0;
  const shutouts = stats.shutouts ?? 0;

  const savePercentage =
    shotsAgainst > 0
      ? saves / shotsAgainst
      : 0;

  const gamesPlayed = Math.max(
    1,
    stats.gamesPlayed ?? 82
  );

  const uncappedTotal =
    gamesPlayed * defaultScoringRules.goalieGameBase +
    saves * defaultScoringRules.goalieSave +
    wins * defaultScoringRules.goalieWin +
    shutouts * defaultScoringRules.goalieShutout +
    gamesPlayed *
      calculateGoalieSaveQualityPoints(
        savePercentage,
        defaultScoringRules
      );

  return Math.min(
    uncappedTotal,
    gamesPlayed *
      defaultScoringRules.goalieGameMaximum
  );
}

function calculateGoalieGameFantasyPoints(
  game: GoalieGameProjectionStats
): number {
  const savePercentage =
    game.shotsAgainst > 0
      ? game.saves / game.shotsAgainst
      : 0;

  const uncappedPoints =
    defaultScoringRules.goalieGameBase +
    game.saves * defaultScoringRules.goalieSave +
    (game.won ? defaultScoringRules.goalieWin : 0) +
    (game.shutout
      ? defaultScoringRules.goalieShutout
      : 0) +
    calculateGoalieSaveQualityPoints(
      savePercentage,
      defaultScoringRules
    );

  return Math.min(
    defaultScoringRules.goalieGameMaximum,
    uncappedPoints
  );
}

function calculateGoalieFantasyPointsFromGames(
  games: GoalieGameProjectionStats[]
): number {
  return games.reduce(
    (total, game) =>
      total + calculateGoalieGameFantasyPoints(game),
    0
  );
}

function buildGoalieRecentFormMetrics(
  games: GoalieGameProjectionStats[]
): RecentFormMetrics {
  const fantasyPoints = games.map((game) =>
    calculateGoalieGameFantasyPoints(game)
  );

  const lastThree =
    getWindowAverage(fantasyPoints, 3);

  const lastFive =
    getWindowAverage(fantasyPoints, 5);

  const lastTen =
    getWindowAverage(fantasyPoints, 10);

  const lastTwenty =
    getWindowAverage(fantasyPoints, 20);

  return {
    sampleSize: games.length,
    seasonFantasyPointsPerGame:
      average(fantasyPoints),
    recentThreeGameFantasyPointsPerGame:
      lastThree,
    recentFiveGameFantasyPointsPerGame:
      lastFive,
    recentTenGameFantasyPointsPerGame:
      lastTen,
    recentTwentyGameFantasyPointsPerGame:
      lastTwenty,
    weightedRecentFantasyPointsPerGame:
      getWeightedRecentAverage(
        lastThree,
        lastFive,
        lastTen,
        lastTwenty
      ),
    seasonSustainableFantasyPointsPerGame:
      average(fantasyPoints),
    weightedRecentSustainableFantasyPointsPerGame:
      getWeightedRecentAverage(
        lastThree,
        lastFive,
        lastTen,
        lastTwenty
      ),
    fantasyPointsStandardDeviation:
      standardDeviation(fantasyPoints.slice(0, 20)),
    consistencyRating:
      getConsistencyRating(fantasyPoints.slice(0, 20)),
    seasonAverageTimeOnIceMinutes: null,
    recentAverageTimeOnIceMinutes: null,
    actualRecentAppearances: Math.min(games.length, 20),
    missedRecentTeamGames: 0,
    weightedRecentAppearances: Math.min(games.length, 20),
    fullWeightRecentGames: Math.min(games.length, 20),
    partialWeightRecentGames: 0
  };
}

function calculateGoalieUnitReliabilityRating(
  stats: Partial<GoalieProjectionStats> | undefined,
  gamesPlayed: number,
  consistencyRating: number | null
): number {
  if (!stats || gamesPlayed <= 0) {
    return getDefaultReliabilityRating('G');
  }

  const saves = stats.saves ?? 0;
  const shotsAgainst = stats.shotsAgainst ?? 0;
  const wins = stats.wins ?? 0;
  const shutouts = stats.shutouts ?? 0;

  const savePercentage =
    shotsAgainst > 0
      ? saves / shotsAgainst
      : 0;

  const shotsAgainstPerGame =
    shotsAgainst / gamesPlayed;

  const gamesScore =
    clamp(gamesPlayed / 82, 0, 1) * 25;

  const workloadScore =
    clamp(shotsAgainstPerGame / 31, 0, 1) * 25;

  const savePercentageScore =
    clamp(
      (savePercentage - 0.86) / 0.08,
      0,
      1
    ) * 25;

  const winsScore =
    clamp(wins / 55, 0, 1) * 15;

  const shutoutScore =
    clamp(shutouts / 10, 0, 1) * 5;

  const baseRating = clamp(
    5 +
      gamesScore +
      workloadScore +
      savePercentageScore +
      winsScore +
      shutoutScore,
    50,
    98
  );

  if (typeof consistencyRating !== 'number') {
    return roundOneDecimal(baseRating);
  }

  return roundOneDecimal(
    clamp(
      baseRating * 0.78 +
        consistencyRating * 0.22,
      45,
      98
    )
  );
}

function getBlendedFormDelta(
  recentMetrics: RecentFormMetrics,
  useTwentyGameRawWindow: boolean = false
): { blendedDelta: number; sustainableDelta: number } | null {
  const seasonPpg = recentMetrics.seasonFantasyPointsPerGame;
  const recentPpg = useTwentyGameRawWindow
    ? recentMetrics.recentTwentyGameFantasyPointsPerGame
    : recentMetrics.weightedRecentFantasyPointsPerGame;
  const sustainableSeasonPpg =
    recentMetrics.seasonSustainableFantasyPointsPerGame;
  const sustainableRecentPpg =
    recentMetrics.weightedRecentSustainableFantasyPointsPerGame;

  if (
    typeof seasonPpg !== 'number' ||
    typeof recentPpg !== 'number'
  ) {
    return null;
  }

  const rawDelta = recentPpg - seasonPpg;
  const sustainableDelta =
    typeof sustainableSeasonPpg === 'number' &&
    typeof sustainableRecentPpg === 'number'
      ? sustainableRecentPpg - sustainableSeasonPpg
      : rawDelta;

  return {
    // Short-term goals and assists still matter, but role and repeatable volume
    // receive most of the weight so one finishing streak cannot dominate.
    blendedDelta: sustainableDelta * 0.72 + rawDelta * 0.28,
    sustainableDelta
  };
}

function getCycleSustainableFormAdjustment(
  recentMetrics: RecentFormMetrics,
  gamesPlayed: number,
  isCurrentSeason: boolean
): number {
  const formDelta = getBlendedFormDelta(recentMetrics);

  if (!formDelta || recentMetrics.sampleSize < 5) {
    return 0;
  }

  const sampleConfidence =
    clamp(recentMetrics.sampleSize / 20, 0.35, 1);
  const seasonConfidence =
    isCurrentSeason
      ? clamp(gamesPlayed / 20, 0.4, 1)
      : 0.35;

  return formDelta.sustainableDelta *
    defaultScoringRules.requiredGamesPerCycle *
    sampleConfidence *
    seasonConfidence *
    0.78 *
    0.72;
}

function getCycleFormAdjustment(
  baselineCyclePoints: number,
  recentMetrics: RecentFormMetrics,
  gamesPlayed: number,
  isCurrentSeason: boolean
): number {
  const formDelta = getBlendedFormDelta(recentMetrics);

  if (!formDelta || recentMetrics.sampleSize < 5) {
    return 0;
  }

  const sampleConfidence =
    clamp(recentMetrics.sampleSize / 20, 0.35, 1);

  const seasonConfidence =
    isCurrentSeason
      ? clamp(gamesPlayed / 20, 0.4, 1)
      : 0.35;

  const rawAdjustment =
    formDelta.blendedDelta *
    defaultScoringRules.requiredGamesPerCycle *
    sampleConfidence *
    seasonConfidence *
    0.78;

  const capRate = isCurrentSeason ? 0.075 : 0.04;
  const cap = baselineCyclePoints * capRate;

  return clamp(rawAdjustment, -cap, cap);
}

function getDraftTrendAdjustment(
  baselineCyclePoints: number,
  recentMetrics: RecentFormMetrics,
  isCurrentSeason: boolean
): number {
  const formDelta = getBlendedFormDelta(recentMetrics, true);

  if (!formDelta || recentMetrics.sampleSize < 10) {
    return 0;
  }

  const sampleConfidence =
    clamp(recentMetrics.sampleSize / 20, 0.5, 1);

  const rawAdjustment =
    formDelta.blendedDelta *
    defaultScoringRules.requiredGamesPerCycle *
    sampleConfidence *
    (isCurrentSeason ? 0.26 : 0.17);

  const cap = baselineCyclePoints * 0.025;

  return clamp(rawAdjustment, -cap, cap);
}

function calculateStableDraftSeasonProjection(input: {
  currentPace: number | null;
  previousPace: number | null;
  secondPreviousPace: number | null;
  conservativeBaseline: number;
  position: DraftPosition;
  currentGamesPlayed: number;
  previousGamesPlayed: number;
  secondPreviousGamesPlayed: number;
  previousAverageTimeOnIceMinutes?: number | null;
  secondPreviousAverageTimeOnIceMinutes?: number | null;
  previousShotsPerGame?: number | null;
  secondPreviousShotsPerGame?: number | null;
  previousPowerPlayPointsPerGame?: number | null;
  secondPreviousPowerPlayPointsPerGame?: number | null;
  birthDate?: string | null;
  projectionDate?: Date;
}): StableDraftProjectionResult {
  return calculateTrajectoryAwareStableDraftProjection({
    position: input.position,
    currentPace: input.currentPace,
    currentGamesPlayed: input.currentGamesPlayed,
    latestCompletedSeason: {
      pace: input.previousPace,
      gamesPlayed: input.previousGamesPlayed,
      averageTimeOnIceMinutes:
        input.previousAverageTimeOnIceMinutes ?? null,
      shotsPerGame: input.previousShotsPerGame ?? null,
      powerPlayPointsPerGame:
        input.previousPowerPlayPointsPerGame ?? null
    },
    previousCompletedSeason: {
      pace: input.secondPreviousPace,
      gamesPlayed: input.secondPreviousGamesPlayed,
      averageTimeOnIceMinutes:
        input.secondPreviousAverageTimeOnIceMinutes ?? null,
      shotsPerGame: input.secondPreviousShotsPerGame ?? null,
      powerPlayPointsPerGame:
        input.secondPreviousPowerPlayPointsPerGame ?? null
    },
    conservativeBaseline: input.conservativeBaseline,
    birthDate: input.birthDate,
    projectionDate: input.projectionDate,
    capProjectionBySample
  });
}

function getRoleAdjustment(
  baselineCyclePoints: number,
  recentMetrics: RecentFormMetrics,
  gamesPlayed: number,
  isCurrentSeason: boolean
): number {
  const seasonToi =
    recentMetrics.seasonAverageTimeOnIceMinutes;

  const recentToi =
    recentMetrics.recentAverageTimeOnIceMinutes;

  if (
    typeof seasonToi !== 'number' ||
    typeof recentToi !== 'number' ||
    seasonToi <= 0 ||
    recentMetrics.sampleSize < 5
  ) {
    return 0;
  }

  const roleChange =
    clamp(
      (recentToi - seasonToi) / seasonToi,
      -0.25,
      0.25
    );

  const confidence =
    (isCurrentSeason
      ? clamp(gamesPlayed / 20, 0.4, 1)
      : 0.35) *
    clamp(recentMetrics.sampleSize / 10, 0.5, 1);

  return baselineCyclePoints *
    clamp(roleChange * 0.2, -0.04, 0.04) *
    confidence;
}

function getDraftRoleAdjustment(
  baselineCyclePoints: number,
  recentMetrics: RecentFormMetrics,
  isCurrentSeason: boolean
): number {
  const seasonToi =
    recentMetrics.seasonAverageTimeOnIceMinutes;

  const recentToi =
    recentMetrics.recentAverageTimeOnIceMinutes;

  if (
    typeof seasonToi !== 'number' ||
    typeof recentToi !== 'number' ||
    seasonToi <= 0 ||
    recentMetrics.sampleSize < 10
  ) {
    return 0;
  }

  const roleChange = clamp(
    (recentToi - seasonToi) / seasonToi,
    -0.2,
    0.2
  );

  const confidence =
    clamp(recentMetrics.sampleSize / 20, 0.5, 1) *
    (isCurrentSeason ? 0.8 : 0.55);

  return baselineCyclePoints *
    clamp(roleChange * 0.12, -0.03, 0.03) *
    confidence;
}


function buildProjectionResult(input: {
  draftProjectedSeasonPoints: number;
  draftProjectedCyclePoints: number;
  draftTrajectoryLabel: DraftTrajectoryLabel;
  draftTrajectoryConfidence: number;
  draftTrajectoryAdjustment: number;
  draftLatestSeasonWeight: number;
  draftPaceChangePercent: number | null;
  draftRecentTrendAdjustment: number;
  draftRoleAdjustment: number;
  draftReliabilityRating: number;

  position: DraftPosition;
  projectionModelConfidence: number;
  projectionPrimaryAssistShare: number | null;
  projectionShootingPercentage: number | null;
  projectionShootingRegressionAdjustment: number | null;
  projectionCurrentSeasonWeight: number;
  projectionHistoricalWeight: number;
  sustainableFormAdjustment: number;

  projectedCyclePoints: number;
  seasonBaselineCyclePoints: number;
  recentFormAdjustment: number;
  roleAdjustment: number;
  scheduleContext: ProjectionScheduleContext;
  scheduleStrengthAdjustment: number;
  projectionDataSeason: string | null;
  projectionDataSource:
    | 'current-season-form'
    | 'current-season-baseline'
    | 'previous-season-form'
    | 'previous-season-baseline'
    | 'conservative-baseline';
  projectionGamesPlayed: number | null;
  recentMetrics: RecentFormMetrics | null;
  reliabilityRating: number;
  maxPenaltyRate: number;
  draftMaxPenaltyRate: number;
}): ProjectionCalculationResult {
  const safeReliabilityRating = clamp(
    input.reliabilityRating,
    0,
    100
  );

  const safeDraftReliabilityRating = clamp(
    input.draftReliabilityRating,
    0,
    100
  );

  const penaltyRate =
    (100 - safeReliabilityRating) /
    100 *
    input.maxPenaltyRate;

  const volatilityPenalty =
    input.projectedCyclePoints * penaltyRate;

  const floorAdjustedCyclePoints =
    Math.max(
      0,
      input.projectedCyclePoints - volatilityPenalty
    );

  const draftPenaltyRate =
    (100 - safeDraftReliabilityRating) /
    100 *
    input.draftMaxPenaltyRate;

  const draftVolatilityPenalty =
    input.draftProjectedCyclePoints * draftPenaltyRate;

  const draftFloorAdjustedCyclePoints =
    Math.max(
      0,
      input.draftProjectedCyclePoints -
        draftVolatilityPenalty
    );

  const projectionRange = calculateProjectionV11Range({
    mean: input.projectedCyclePoints,
    recentGameStandardDeviation:
      input.recentMetrics?.fantasyPointsStandardDeviation ?? null,
    recentSampleSize: input.recentMetrics?.sampleSize ?? 0,
    expectedGames: defaultScoringRules.requiredGamesPerCycle,
    reliabilityRating: safeReliabilityRating,
    position: input.position
  });

  return {
    projectedSeasonPoints:
      roundOneDecimal(input.draftProjectedSeasonPoints),
    projectedCyclePoints:
      roundOneDecimal(input.projectedCyclePoints),

    draftProjectedSeasonPoints:
      roundOneDecimal(input.draftProjectedSeasonPoints),
    draftProjectedCyclePoints:
      roundOneDecimal(input.draftProjectedCyclePoints),
    draftTrajectoryLabel: input.draftTrajectoryLabel,
    draftTrajectoryConfidence:
      roundOneDecimal(input.draftTrajectoryConfidence),
    draftTrajectoryAdjustment:
      roundOneDecimal(input.draftTrajectoryAdjustment),
    draftLatestSeasonWeight:
      roundOneDecimal(input.draftLatestSeasonWeight * 100),
    draftPaceChangePercent:
      input.draftPaceChangePercent !== null
        ? roundOneDecimal(input.draftPaceChangePercent * 100)
        : null,
    draftRecentTrendAdjustment:
      roundOneDecimal(input.draftRecentTrendAdjustment),
    draftRoleAdjustment:
      roundOneDecimal(input.draftRoleAdjustment),
    draftReliabilityRating:
      roundOneDecimal(safeDraftReliabilityRating),
    draftVolatilityPenalty:
      roundOneDecimal(draftVolatilityPenalty),
    draftFloorAdjustedCyclePoints:
      roundOneDecimal(draftFloorAdjustedCyclePoints),

    projectionModelVersion: PROJECTION_MODEL_VERSION,
    projectionModelConfidence:
      roundOneDecimal(input.projectionModelConfidence),
    projectionPrimaryAssistShare:
      input.projectionPrimaryAssistShare !== null
        ? Number(input.projectionPrimaryAssistShare.toFixed(4))
        : null,
    projectionShootingPercentage:
      input.projectionShootingPercentage !== null
        ? Number(input.projectionShootingPercentage.toFixed(4))
        : null,
    projectionShootingRegressionAdjustment:
      input.projectionShootingRegressionAdjustment !== null
        ? roundOneDecimal(input.projectionShootingRegressionAdjustment)
        : null,
    projectionCurrentSeasonWeight:
      Number(input.projectionCurrentSeasonWeight.toFixed(4)),
    projectionHistoricalWeight:
      Number(input.projectionHistoricalWeight.toFixed(4)),
    projectionFloorPoints:
      roundOneDecimal(projectionRange.floor),
    projectionCeilingPoints:
      roundOneDecimal(projectionRange.ceiling),
    projectionUncertaintyPoints:
      roundOneDecimal(projectionRange.uncertainty),
    sustainableFormAdjustment:
      roundOneDecimal(input.sustainableFormAdjustment),
    recentGameStandardDeviation:
      input.recentMetrics?.fantasyPointsStandardDeviation != null
        ? roundOneDecimal(input.recentMetrics.fantasyPointsStandardDeviation)
        : null,

    seasonBaselineCyclePoints:
      roundOneDecimal(input.seasonBaselineCyclePoints),
    recentFormAdjustment:
      roundOneDecimal(input.recentFormAdjustment),
    roleAdjustment:
      roundOneDecimal(input.roleAdjustment),
    scheduleStrengthAdjustment:
      roundOneDecimal(input.scheduleStrengthAdjustment),
    scheduleStrengthMultiplier:
      Number(input.scheduleContext.multiplier.toFixed(4)),
    scheduleDifficultyRating:
      roundOneDecimal(input.scheduleContext.difficultyRating),
    scheduleDifficultyLabel:
      input.scheduleContext.adjustmentLabel,
    scheduleDataConfidence:
      roundOneDecimal(input.scheduleContext.dataConfidence),
    projectionHomeGames:
      input.scheduleContext.homeGames,
    projectionRoadGames:
      input.scheduleContext.roadGames,
    projectionBackToBackGames:
      input.scheduleContext.backToBackGames,
    projectionRestAdvantageGames:
      input.scheduleContext.restAdvantageGames,
    projectionOpponentAbbreviations:
      input.scheduleContext.opponentAbbreviations,
    projectionDataSeason:
      input.projectionDataSeason,
    projectionDataSource:
      input.projectionDataSource,
    projectionGamesPlayed:
      input.projectionGamesPlayed,
    recentFormSampleSize:
      input.recentMetrics?.sampleSize ?? 0,
    seasonFantasyPointsPerGame:
      input.recentMetrics?.seasonFantasyPointsPerGame != null
        ? roundOneDecimal(
            input.recentMetrics
              .seasonFantasyPointsPerGame
          )
        : null,
    recentThreeGameFantasyPointsPerGame:
      input.recentMetrics
        ?.recentThreeGameFantasyPointsPerGame != null
        ? roundOneDecimal(
            input.recentMetrics
              .recentThreeGameFantasyPointsPerGame
          )
        : null,
    recentFiveGameFantasyPointsPerGame:
      input.recentMetrics
        ?.recentFiveGameFantasyPointsPerGame != null
        ? roundOneDecimal(
            input.recentMetrics
              .recentFiveGameFantasyPointsPerGame
          )
        : null,
    recentTenGameFantasyPointsPerGame:
      input.recentMetrics
        ?.recentTenGameFantasyPointsPerGame != null
        ? roundOneDecimal(
            input.recentMetrics
              .recentTenGameFantasyPointsPerGame
          )
        : null,
    recentTwentyGameFantasyPointsPerGame:
      input.recentMetrics
        ?.recentTwentyGameFantasyPointsPerGame != null
        ? roundOneDecimal(
            input.recentMetrics
              .recentTwentyGameFantasyPointsPerGame
          )
        : null,
    seasonAverageTimeOnIceMinutes:
      input.recentMetrics
        ?.seasonAverageTimeOnIceMinutes != null
        ? roundOneDecimal(
            input.recentMetrics
              .seasonAverageTimeOnIceMinutes
          )
        : null,
    recentAverageTimeOnIceMinutes:
      input.recentMetrics
        ?.recentAverageTimeOnIceMinutes != null
        ? roundOneDecimal(
            input.recentMetrics
              .recentAverageTimeOnIceMinutes
          )
        : null,
    actualRecentAppearances:
      input.recentMetrics?.actualRecentAppearances ?? 0,
    missedRecentTeamGames:
      input.recentMetrics?.missedRecentTeamGames ?? 0,
    weightedRecentAppearances:
      input.recentMetrics
        ? roundOneDecimal(
            input.recentMetrics.weightedRecentAppearances
          )
        : 0,
    fullWeightRecentGames:
      input.recentMetrics?.fullWeightRecentGames ?? 0,
    partialWeightRecentGames:
      input.recentMetrics?.partialWeightRecentGames ?? 0,
    healthyProjectedCyclePoints:
      roundOneDecimal(input.projectedCyclePoints),
    scheduledGamesInProjectionCycle:
      defaultScoringRules.requiredGamesPerCycle,
    expectedGamesAvailable:
      defaultScoringRules.requiredGamesPerCycle,
    expectedGamesMissed: 0,
    availabilityAdjustment: 0,
    availabilityAdjustedCyclePoints:
      roundOneDecimal(input.projectedCyclePoints),
    availabilityStatus: 'active',
    availabilityLabel: 'Active',
    availabilityReturnDate: null,
    availabilityNote: null,
    availabilityAsOf: null,
    targetProjectionCycleNumber: null,
    reliabilityRating:
      roundOneDecimal(safeReliabilityRating),
    volatilityPenalty:
      roundOneDecimal(volatilityPenalty),
    floorAdjustedCyclePoints:
      roundOneDecimal(floorAdjustedCyclePoints)
  };
}


function calculateSkaterProjection(input: {
  position: DraftPosition;
  currentStats:
    | Partial<SkaterProjectionStats>
    | undefined;
  previousStats:
    | Partial<SkaterProjectionStats>
    | undefined;
  secondPreviousStats:
    | Partial<SkaterProjectionStats>
    | undefined;
  currentGames: SkaterGameProjectionStats[];
  previousGames: SkaterGameProjectionStats[];
  currentSeason: string;
  previousSeason: string;
  secondPreviousSeason: string;
  currentTeamSchedule: NhlTeamSeasonGame[];
  previousTeamSchedule: NhlTeamSeasonGame[];
  scheduleContext: ProjectionScheduleContext;
  birthDate?: string | null;
  projectionDate?: Date;
}): ProjectionCalculationResult {
  const position = input.position;

  if (position === 'G') {
    throw new Error('Skater projection received a goalie position.');
  }

  const currentGamesPlayed =
    input.currentStats?.gamesPlayed ?? 0;

  const previousGamesPlayed =
    input.previousStats?.gamesPlayed ?? 0;

  const secondPreviousGamesPlayed =
    input.secondPreviousStats?.gamesPlayed ?? 0;

  const currentPace =
    calculateSkaterSeasonPace(
      position,
      input.currentStats
    );

  const previousPace =
    calculateSkaterSeasonPace(
      position,
      input.previousStats
    );

  const secondPreviousPace =
    calculateSkaterSeasonPace(
      position,
      input.secondPreviousStats
    );

  const conservativeBaseline =
    POSITION_BASELINES[position].conservativeSeasonPoints;

  const trajectoryAssessment = assessDraftTrajectory({
    position,
    latestCompletedSeason: {
      pace: previousPace,
      gamesPlayed: previousGamesPlayed,
      averageTimeOnIceMinutes:
        input.previousStats?.averageTimeOnIceMinutes ?? null,
      shotsPerGame:
        previousGamesPlayed > 0
          ? (input.previousStats?.shotsOnGoal ?? 0) / previousGamesPlayed
          : null,
      powerPlayPointsPerGame:
        previousGamesPlayed > 0
          ? (input.previousStats?.powerPlayPoints ?? 0) / previousGamesPlayed
          : null
    },
    previousCompletedSeason: {
      pace: secondPreviousPace,
      gamesPlayed: secondPreviousGamesPlayed,
      averageTimeOnIceMinutes:
        input.secondPreviousStats?.averageTimeOnIceMinutes ?? null,
      shotsPerGame:
        secondPreviousGamesPlayed > 0
          ? (input.secondPreviousStats?.shotsOnGoal ?? 0) /
            secondPreviousGamesPlayed
          : null,
      powerPlayPointsPerGame:
        secondPreviousGamesPlayed > 0
          ? (input.secondPreviousStats?.powerPlayPoints ?? 0) /
            secondPreviousGamesPlayed
          : null
    },
    birthDate: input.birthDate,
    projectionDate: input.projectionDate
  });

  const draftBaselineSeasonProjection =
    calculateStableDraftSeasonProjection({
      currentPace,
      previousPace,
      secondPreviousPace,
      conservativeBaseline,
      position,
      currentGamesPlayed,
      previousGamesPlayed,
      secondPreviousGamesPlayed,
      previousAverageTimeOnIceMinutes:
        input.previousStats?.averageTimeOnIceMinutes ?? null,
      secondPreviousAverageTimeOnIceMinutes:
        input.secondPreviousStats?.averageTimeOnIceMinutes ?? null,
      previousShotsPerGame:
        previousGamesPlayed > 0
          ? (input.previousStats?.shotsOnGoal ?? 0) / previousGamesPlayed
          : null,
      secondPreviousShotsPerGame:
        secondPreviousGamesPlayed > 0
          ? (input.secondPreviousStats?.shotsOnGoal ?? 0) /
            secondPreviousGamesPlayed
          : null,
      previousPowerPlayPointsPerGame:
        previousGamesPlayed > 0
          ? (input.previousStats?.powerPlayPoints ?? 0) / previousGamesPlayed
          : null,
      secondPreviousPowerPlayPointsPerGame:
        secondPreviousGamesPlayed > 0
          ? (input.secondPreviousStats?.powerPlayPoints ?? 0) /
            secondPreviousGamesPlayed
          : null,
      birthDate: input.birthDate,
      projectionDate: input.projectionDate
    });

  const componentProjection = buildProjectionV11SkaterRates({
    position,
    currentStats: input.currentStats,
    latestCompletedStats: input.previousStats,
    previousCompletedStats: input.secondPreviousStats,
    latestSeasonWeight: trajectoryAssessment.latestSeasonWeight,
    previousSeasonWeight: trajectoryAssessment.previousSeasonWeight
  });

  const componentSeasonProjection = clamp(
    calculateSkaterRawFantasyPoints(
      position,
      componentProjection.expectedStatsPer82,
      82,
      componentProjection.primaryAssistShare
    ),
    conservativeBaseline * 0.55,
    POSITION_BASELINES[position].highEndSeasonCap
  );

  /*
   * V11 makes the stat-component ensemble the primary estimate while keeping
   * the trajectory-aware completed-season projection as a guardrail. This lets stable role
   * stats move quickly, regresses finishing luck, and prevents a single noisy
   * category or unavailable NHL endpoint from moving a player implausibly far.
   */
  const componentBlendWeight = clamp(
    0.56 + componentProjection.modelConfidence / 100 * 0.22,
    0.64,
    0.78
  );
  const guardedDraftProjection =
    componentSeasonProjection * componentBlendWeight +
    draftBaselineSeasonProjection.projectedSeasonPoints *
      (1 - componentBlendWeight);
  const draftSeasonProjection = clamp(
    guardedDraftProjection,
    draftBaselineSeasonProjection.projectedSeasonPoints * 0.85,
    Math.min(
      POSITION_BASELINES[position].highEndSeasonCap,
      draftBaselineSeasonProjection.projectedSeasonPoints * 1.15
    )
  );
  const cycleBaselineSeasonProjection = clamp(
    componentSeasonProjection * 0.86 +
      draftBaselineSeasonProjection.projectedSeasonPoints * 0.14,
    conservativeBaseline * 0.55,
    POSITION_BASELINES[position].highEndSeasonCap
  );

  const usesCurrentSeason =
    currentGamesPlayed > 0;

  const selectedGames =
    usesCurrentSeason
      ? input.currentGames
      : input.previousGames;

  const selectedStats =
    usesCurrentSeason
      ? input.currentStats
      : input.previousStats;

  const selectedGamesPlayed =
    usesCurrentSeason
      ? currentGamesPlayed
      : previousGamesPlayed;

  const recentMetrics =
    selectedGames.length > 0
      ? buildSkaterRecentFormMetrics(
          position,
          selectedGames,
          selectedStats?.averageTimeOnIceMinutes ??
            null,
          usesCurrentSeason
            ? input.currentTeamSchedule
            : input.previousTeamSchedule
        )
      : null;

  const draftBaselineCyclePoints =
    draftSeasonProjection /
    82 *
    defaultScoringRules.requiredGamesPerCycle;

  const draftRecentTrendAdjustment =
    recentMetrics
      ? getDraftTrendAdjustment(
          draftBaselineCyclePoints,
          recentMetrics,
          usesCurrentSeason
        )
      : 0;

  const draftRoleAdjustment =
    recentMetrics
      ? getDraftRoleAdjustment(
          draftBaselineCyclePoints,
          recentMetrics,
          usesCurrentSeason
        )
      : 0;

  const draftProjectedCyclePoints = Math.max(
    0,
    draftBaselineCyclePoints +
      draftRecentTrendAdjustment +
      draftRoleAdjustment
  );

  const draftProjectedSeasonPoints =
    draftProjectedCyclePoints /
    defaultScoringRules.requiredGamesPerCycle *
    82;

  const seasonBaselineCyclePoints =
    cycleBaselineSeasonProjection /
    82 *
    defaultScoringRules.requiredGamesPerCycle;

  const recentFormAdjustment =
    recentMetrics
      ? getCycleFormAdjustment(
          seasonBaselineCyclePoints,
          recentMetrics,
          selectedGamesPlayed,
          usesCurrentSeason
        )
      : 0;

  const sustainableFormAdjustment =
    recentMetrics
      ? getCycleSustainableFormAdjustment(
          recentMetrics,
          selectedGamesPlayed,
          usesCurrentSeason
        )
      : 0;

  const roleAdjustment =
    recentMetrics
      ? getRoleAdjustment(
          seasonBaselineCyclePoints,
          recentMetrics,
          selectedGamesPlayed,
          usesCurrentSeason
        )
      : 0;

  const preScheduleCyclePoints = Math.max(
    0,
    seasonBaselineCyclePoints +
      recentFormAdjustment +
      roleAdjustment
  );

  const scheduleStrengthAdjustment =
    preScheduleCyclePoints *
    (input.scheduleContext.multiplier - 1);

  const projectedCyclePoints = Math.max(
    0,
    preScheduleCyclePoints + scheduleStrengthAdjustment
  );

  const baseReliability =
    calculateSkaterReliabilityRating(
      position,
      selectedStats ?? {},
      selectedGamesPlayed,
      recentMetrics?.consistencyRating ?? null
    );

  const seasonAdjustedReliability =
    usesCurrentSeason
      ? baseReliability
      : clamp(baseReliability - 4, 35, 98);

  // Historical coverage from the component model prevents an early current
  // season from appearing artificially unreliable after only a few games.
  const reliabilityRating = clamp(
    seasonAdjustedReliability * 0.74 +
      componentProjection.modelConfidence * 0.26,
    35,
    98
  );

  const draftReliabilityRating =
    clamp(
      reliabilityRating +
        (previousGamesPlayed >= 60 ? 3 : 0) -
        (previousGamesPlayed <= 10 ? 4 : 0),
      40,
      98
    );

  const projectionDataSource =
    usesCurrentSeason
      ? selectedGames.length >= 5
        ? 'current-season-form'
        : 'current-season-baseline'
      : previousGamesPlayed > 0
        ? selectedGames.length >= 5
          ? 'previous-season-form'
          : 'previous-season-baseline'
        : 'conservative-baseline';

  return buildProjectionResult({
    draftProjectedSeasonPoints,
    draftProjectedCyclePoints,
    draftTrajectoryLabel:
      draftBaselineSeasonProjection.trajectoryLabel,
    draftTrajectoryConfidence:
      draftBaselineSeasonProjection.trajectoryConfidence,
    draftTrajectoryAdjustment:
      draftBaselineSeasonProjection.trajectoryAdjustment,
    draftLatestSeasonWeight:
      draftBaselineSeasonProjection.latestSeasonWeight,
    draftPaceChangePercent:
      draftBaselineSeasonProjection.paceChangeRate,
    draftRecentTrendAdjustment,
    draftRoleAdjustment,
    draftReliabilityRating,

    position,
    projectionModelConfidence:
      componentProjection.modelConfidence,
    projectionPrimaryAssistShare:
      componentProjection.primaryAssistShare,
    projectionShootingPercentage:
      componentProjection.shootingPercentage,
    projectionShootingRegressionAdjustment:
      componentProjection.shootingRegressionAdjustmentGoalsPer82,
    projectionCurrentSeasonWeight:
      componentProjection.currentSeasonWeight,
    projectionHistoricalWeight:
      componentProjection.historicalWeight,
    sustainableFormAdjustment,

    projectedCyclePoints,
    seasonBaselineCyclePoints,
    recentFormAdjustment,
    roleAdjustment,
    scheduleContext: input.scheduleContext,
    scheduleStrengthAdjustment,
    projectionDataSeason:
      usesCurrentSeason
        ? input.currentSeason
        : previousGamesPlayed > 0
          ? input.previousSeason
          : null,
    projectionDataSource,
    projectionGamesPlayed:
      selectedGamesPlayed > 0
        ? selectedGamesPlayed
        : null,
    recentMetrics,
    reliabilityRating,
    maxPenaltyRate: 0.22,
    draftMaxPenaltyRate: 0.12
  });
}

function calculateGoalieUnitProjection(input: {
  currentStats:
    | Partial<GoalieProjectionStats>
    | undefined;
  previousStats:
    | Partial<GoalieProjectionStats>
    | undefined;
  secondPreviousStats:
    | Partial<GoalieProjectionStats>
    | undefined;
  currentGames: GoalieGameProjectionStats[];
  previousGames: GoalieGameProjectionStats[];
  currentSeason: string;
  previousSeason: string;
  secondPreviousSeason: string;
  scheduleContext: ProjectionScheduleContext;
}): ProjectionCalculationResult {
  const currentGameSummary =
    summarizeGoalieGames(input.currentGames) ?? undefined;
  const previousGameSummary =
    summarizeGoalieGames(input.previousGames) ?? undefined;

  const currentGamesPlayed =
    input.currentGames.length;

  const previousGamesPlayed =
    input.previousGames.length > 0
      ? input.previousGames.length
      : input.previousStats
        ? 82
        : 0;

  const secondPreviousGamesPlayed =
    input.secondPreviousStats
      ? 82
      : 0;

  /*
   * Prefer summed game-level fantasy points whenever they are available.
   * This mirrors calculateGoalieGameBreakdown exactly, including the
   * continuous save-quality value awarded separately in each game.
   */
  const currentRawPoints =
    input.currentGames.length > 0
      ? calculateGoalieFantasyPointsFromGames(
          input.currentGames
        )
      : null;

  const previousRawPoints =
    input.previousGames.length > 0
      ? calculateGoalieFantasyPointsFromGames(
          input.previousGames
        )
      : input.previousStats
        ? calculateGoalieRawFantasyPoints({
            ...input.previousStats,
            gamesPlayed: Math.max(
              1,
              previousGamesPlayed
            )
          })
        : null;

  const secondPreviousRawPoints =
    input.secondPreviousStats
      ? calculateGoalieRawFantasyPoints({
          ...input.secondPreviousStats,
          gamesPlayed: Math.max(
            1,
            secondPreviousGamesPlayed
          )
        })
      : null;

  const currentPace =
    currentRawPoints != null &&
    currentGamesPlayed > 0
      ? currentRawPoints /
        currentGamesPlayed *
        82
      : null;

  const previousPace =
    previousRawPoints;

  const secondPreviousPace =
    secondPreviousRawPoints;

  const conservativeBaseline =
    POSITION_BASELINES.G.conservativeSeasonPoints;

  const draftBaselineSeasonProjection =
    calculateStableDraftSeasonProjection({
      currentPace,
      previousPace,
      secondPreviousPace,
      conservativeBaseline,
      position: 'G',
      currentGamesPlayed,
      previousGamesPlayed,
      secondPreviousGamesPlayed
    });

  const componentProjection = buildProjectionV11GoalieRates({
    currentStats: currentGameSummary,
    latestCompletedStats:
      previousGameSummary ?? input.previousStats,
    previousCompletedStats:
      input.secondPreviousStats
  });

  const componentSeasonProjection = clamp(
    calculateGoalieRawFantasyPoints(
      componentProjection.expectedStatsPer82
    ),
    conservativeBaseline * 0.65,
    POSITION_BASELINES.G.highEndSeasonCap
  );

  const componentBlendWeight = clamp(
    0.54 + componentProjection.modelConfidence / 100 * 0.2,
    0.63,
    0.74
  );
  const guardedDraftProjection =
    componentSeasonProjection * componentBlendWeight +
    draftBaselineSeasonProjection.projectedSeasonPoints *
      (1 - componentBlendWeight);
  const draftSeasonProjection = clamp(
    guardedDraftProjection,
    draftBaselineSeasonProjection.projectedSeasonPoints * 0.86,
    Math.min(
      POSITION_BASELINES.G.highEndSeasonCap,
      draftBaselineSeasonProjection.projectedSeasonPoints * 1.14
    )
  );
  const cycleBaselineSeasonProjection = clamp(
    componentSeasonProjection * 0.84 +
      draftBaselineSeasonProjection.projectedSeasonPoints * 0.16,
    conservativeBaseline * 0.65,
    POSITION_BASELINES.G.highEndSeasonCap
  );

  const usesCurrentSeason =
    currentGamesPlayed > 0;

  const selectedGames =
    usesCurrentSeason
      ? input.currentGames
      : input.previousGames;

  const selectedStats =
    usesCurrentSeason
      ? currentGameSummary
      : previousGameSummary ?? input.previousStats;

  const selectedGamesPlayed =
    usesCurrentSeason
      ? currentGamesPlayed
      : previousGamesPlayed;

  const recentMetrics =
    selectedGames.length > 0
      ? buildGoalieRecentFormMetrics(selectedGames)
      : null;

  const draftBaselineCyclePoints =
    draftSeasonProjection /
    82 *
    defaultScoringRules.requiredGamesPerCycle;

  const draftRecentTrendAdjustment =
    recentMetrics
      ? getDraftTrendAdjustment(
          draftBaselineCyclePoints,
          recentMetrics,
          usesCurrentSeason
        )
      : 0;

  const draftProjectedCyclePoints = clamp(
    draftBaselineCyclePoints +
      draftRecentTrendAdjustment,
    0,
    defaultScoringRules.goalieGameMaximum *
      defaultScoringRules.requiredGamesPerCycle
  );

  const draftProjectedSeasonPoints =
    draftProjectedCyclePoints /
    defaultScoringRules.requiredGamesPerCycle *
    82;

  const seasonBaselineCyclePoints =
    cycleBaselineSeasonProjection /
    82 *
    defaultScoringRules.requiredGamesPerCycle;

  const recentFormAdjustment =
    recentMetrics
      ? getCycleFormAdjustment(
          seasonBaselineCyclePoints,
          recentMetrics,
          selectedGamesPlayed,
          usesCurrentSeason
        )
      : 0;

  const sustainableFormAdjustment =
    recentMetrics
      ? getCycleSustainableFormAdjustment(
          recentMetrics,
          selectedGamesPlayed,
          usesCurrentSeason
        )
      : 0;

  const preScheduleCyclePoints = Math.max(
    0,
    seasonBaselineCyclePoints + recentFormAdjustment
  );

  const scheduleStrengthAdjustment =
    preScheduleCyclePoints *
    (input.scheduleContext.multiplier - 1);

  const projectedCyclePoints = clamp(
    preScheduleCyclePoints + scheduleStrengthAdjustment,
    0,
    defaultScoringRules.goalieGameMaximum *
      defaultScoringRules.requiredGamesPerCycle
  );

  const baseReliability =
    calculateGoalieUnitReliabilityRating(
      selectedStats,
      selectedGamesPlayed,
      recentMetrics?.consistencyRating ?? null
    );

  const seasonAdjustedReliability =
    usesCurrentSeason
      ? baseReliability
      : clamp(baseReliability - 3, 45, 98);

  const reliabilityRating = clamp(
    seasonAdjustedReliability * 0.72 +
      componentProjection.modelConfidence * 0.28,
    45,
    98
  );

  const draftReliabilityRating =
    clamp(
      reliabilityRating +
        (previousGamesPlayed >= 60 ? 2 : 0),
      45,
      98
    );

  const projectionDataSource =
    usesCurrentSeason
      ? selectedGames.length >= 5
        ? 'current-season-form'
        : 'current-season-baseline'
      : input.previousStats
        ? selectedGames.length >= 5
          ? 'previous-season-form'
          : 'previous-season-baseline'
        : 'conservative-baseline';

  return buildProjectionResult({
    draftProjectedSeasonPoints,
    draftProjectedCyclePoints,
    draftTrajectoryLabel:
      draftBaselineSeasonProjection.trajectoryLabel,
    draftTrajectoryConfidence:
      draftBaselineSeasonProjection.trajectoryConfidence,
    draftTrajectoryAdjustment:
      draftBaselineSeasonProjection.trajectoryAdjustment,
    draftLatestSeasonWeight:
      draftBaselineSeasonProjection.latestSeasonWeight,
    draftPaceChangePercent:
      draftBaselineSeasonProjection.paceChangeRate,
    draftRecentTrendAdjustment,
    draftRoleAdjustment: 0,
    draftReliabilityRating,

    position: 'G',
    projectionModelConfidence:
      componentProjection.modelConfidence,
    projectionPrimaryAssistShare: null,
    projectionShootingPercentage: null,
    projectionShootingRegressionAdjustment: null,
    projectionCurrentSeasonWeight:
      componentProjection.currentSeasonWeight,
    projectionHistoricalWeight:
      componentProjection.historicalWeight,
    sustainableFormAdjustment,

    projectedCyclePoints,
    seasonBaselineCyclePoints,
    recentFormAdjustment,
    roleAdjustment: 0,
    scheduleContext: input.scheduleContext,
    scheduleStrengthAdjustment,
    projectionDataSeason:
      usesCurrentSeason
        ? input.currentSeason
        : input.previousStats
          ? input.previousSeason
          : null,
    projectionDataSource,
    projectionGamesPlayed:
      selectedGamesPlayed > 0
        ? selectedGamesPlayed
        : null,
    recentMetrics,
    reliabilityRating,
    maxPenaltyRate: 0.18,
    draftMaxPenaltyRate: 0.1
  });
}

function getAssetName(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.fullName
    : asset.teamName;
}

export async function loadDraftPlayerPool(
  input: boolean | DraftPlayerPoolProjectionOptions = false
): Promise<DraftableAsset[]> {
  const options = normalizeProjectionOptions(input);
  const hasProjectionContext = Boolean(
    options.targetCycleNumber ||
    options.availabilityByPlayerId ||
    options.currentSeasonOverride ||
    options.previousSeasonOverride ||
    options.secondPreviousSeasonOverride ||
    options.projectionAsOfDate ||
    options.ignoreAvailability
  );

  if (
    cachedPlayerPool &&
    !options.forceRefresh &&
    !hasProjectionContext
  ) {
    return cachedPlayerPool;
  }

  const projectionDate = options.projectionAsOfDate ?? new Date();
  const currentSeason =
    options.currentSeasonOverride ?? getCurrentNhlSeason(projectionDate);
  const previousSeason =
    options.previousSeasonOverride ?? getPreviousSeason(currentSeason);
  const secondPreviousSeason =
    options.secondPreviousSeasonOverride ?? getPreviousSeason(previousSeason);

  if (options.forceRefresh) {
    clearNhlProjectionApiCache();
  }

  const skaters = await getCurrentNhlDraftSkaters();

  /*
   * Load projection seasons in controlled waves. The NHL stats service can
   * throttle several large league-wide requests started at the same instant.
   * A throttled request used to be swallowed by the individual loaders, which
   * allowed an entire draft board to collapse to position baselines such as
   * 340 points for every center.
   */
  const [
    currentSkaterProjectionStats,
    currentGoalieProjectionStats
  ] = await Promise.all([
    loadSkaterProjectionStats(currentSeason),
    loadGoalieProjectionStats(currentSeason)
  ]);

  /*
   * The game-level endpoints are substantially larger than the season-summary
   * endpoints. Starting all of them together can cause the public NHL stats
   * service to time out during draft preparation. Give the aggregate wave a
   * brief head start, then fetch recent-form data in a separate bounded wave.
   */
  await wait(250);

  const [
    currentSkaterGameStats,
    currentGoalieGameStats
  ] = await Promise.all([
    loadSkaterGameProjectionStats(currentSeason),
    loadGoalieGameProjectionStats(currentSeason)
  ]);

  const currentSkaterGamesForProjection =
    filterGameMapByProjectionDate(
      currentSkaterGameStats,
      options.projectionAsOfDate
    );
  const currentGoalieGamesForProjection =
    filterGameMapByProjectionDate(
      currentGoalieGameStats,
      options.projectionAsOfDate
    );
  const currentSkaterStatsForProjection =
    options.projectionAsOfDate
      ? summarizeSkaterGameMap(currentSkaterGamesForProjection)
      : currentSkaterProjectionStats;
  const currentGoalieStatsForProjection =
    options.projectionAsOfDate
      ? summarizeGoalieGameMap(currentGoalieGamesForProjection)
      : currentGoalieProjectionStats;

  const [
    previousSkaterProjectionStats,
    previousGoalieProjectionStats
  ] = await Promise.all([
    loadSkaterProjectionStats(previousSeason),
    loadGoalieProjectionStats(previousSeason)
  ]);

  const [
    secondPreviousSkaterProjectionStats,
    secondPreviousGoalieProjectionStats
  ] = await Promise.all([
    loadSkaterProjectionStats(secondPreviousSeason),
    loadGoalieProjectionStats(secondPreviousSeason)
  ]);

  const hasCurrentGameData =
    currentSkaterGamesForProjection.size > 0 ||
    currentGoalieGamesForProjection.size > 0;

  const skatersWithProjectionHistory = skaters.filter(
    (skater) =>
      currentSkaterStatsForProjection.has(skater.id) ||
      previousSkaterProjectionStats.has(skater.id) ||
      secondPreviousSkaterProjectionStats.has(skater.id)
  ).length;

  const minimumExpectedHistoryCount = Math.max(
    75,
    Math.floor(skaters.length * 0.2)
  );

  if (
    skaters.length >= 100 &&
    skatersWithProjectionHistory < minimumExpectedHistoryCount
  ) {
    throw new Error(
      `NHL projection statistics were incomplete (${skatersWithProjectionHistory} of ${skaters.length} current skaters matched historical data). The previous shared projection was preserved. Please retry the projection refresh after the NHL stats service recovers.`
    );
  }

  const [
    previousSkaterGameStats,
    previousGoalieGameStats
  ] = hasCurrentGameData
    ? [
        new Map<
          number,
          SkaterGameProjectionStats[]
        >(),
        new Map<
          string,
          GoalieGameProjectionStats[]
        >()
      ]
    : await Promise.all([
        loadSkaterGameProjectionStats(previousSeason),
        loadGoalieGameProjectionStats(previousSeason)
      ]);

  const shouldLoadSchedules = Boolean(
    options.targetCycleNumber ||
    options.availabilityByPlayerId
  );

  const currentTeamSchedules = shouldLoadSchedules
    ? await loadTeamProjectionSchedules(currentSeason)
    : new Map<string, NhlTeamSeasonGame[]>();

  // Previous-season team strength remains useful early in a new season,
  // even when current player game logs already exist. Current results take
  // progressively more weight as the sample grows.
  const previousTeamSchedules = shouldLoadSchedules
    ? await loadTeamProjectionSchedules(previousSeason)
    : new Map<string, NhlTeamSeasonGame[]>();

  const currentTeamSchedulesAsOf =
    filterScheduleMapByProjectionDate(
      currentTeamSchedules,
      options.projectionAsOfDate
    );

  const teamStrengthProfiles = buildTeamStrengthProfiles(
    currentTeamSchedulesAsOf,
    previousTeamSchedules
  );

  const skaterAssets: DraftableAsset[] = skaters.map(
    (skater) => {
      const currentTeamSchedule =
        currentTeamSchedules.get(skater.nhlTeamAbbreviation) ?? [];
      const currentTeamScheduleAsOf =
        currentTeamSchedulesAsOf.get(skater.nhlTeamAbbreviation) ?? [];
      const targetGames = getTargetCycleGames(
        currentTeamSchedule,
        options.targetCycleNumber,
        options.requiredGamesPerCycle
      );
      const scheduleContext = options.targetCycleNumber
        ? calculateProjectionScheduleContext({
            teamAbbreviation: skater.nhlTeamAbbreviation,
            position: skater.position,
            targetGames,
            teamSchedules: currentTeamSchedules,
            teamStrengthProfiles,
            requiredGamesPerCycle: options.requiredGamesPerCycle
          })
        : NEUTRAL_PROJECTION_SCHEDULE_CONTEXT;

      const currentStats =
        currentSkaterStatsForProjection.get(skater.id);
      const currentGames =
        currentSkaterGamesForProjection.get(skater.id) ?? [];
      const baseProjection = calculateSkaterProjection({
        position: skater.position,
        currentStats,
        previousStats:
          previousSkaterProjectionStats.get(skater.id),
        secondPreviousStats:
          secondPreviousSkaterProjectionStats.get(skater.id),
        currentGames,
        previousGames:
          previousSkaterGameStats.get(skater.id) ?? [],
        currentSeason,
        previousSeason,
        secondPreviousSeason,
        currentTeamSchedule: currentTeamScheduleAsOf,
        previousTeamSchedule:
          previousTeamSchedules.get(
            skater.nhlTeamAbbreviation
          ) ?? [],
        scheduleContext,
        birthDate: skater.birthDate,
        projectionDate
      });

      const projection = applyAvailabilityAdjustment(
        baseProjection,
        skater.position,
        options.availabilityByPlayerId?.get(skater.id),
        targetGames,
        options.requiredGamesPerCycle,
        options.targetCycleNumber,
        0.22,
        projectionDate,
        options.ignoreAvailability
      );
      const seasonStatBreakdown = currentGames.length > 0
        ? buildSkaterSeasonBreakdownFromGames(
            skater.position,
            currentGames
          )
        : currentStats && (currentStats.gamesPlayed ?? 0) > 0
          ? buildSkaterSeasonBreakdownFromStats(
              skater.position,
              currentStats
            )
          : [];
      const currentSeasonFantasyPoints =
        currentGames.length > 0
          ? currentGames.reduce(
              (total, game) =>
                total + calculateSkaterGameFantasyPoints(
                  skater.position,
                  game
                ),
              0
            )
          : currentStats && (currentStats.gamesPlayed ?? 0) > 0
            ? calculateSkaterRawFantasyPoints(
                skater.position,
                currentStats,
                currentStats.gamesPlayed ?? 0
              )
            : null;
      const seasonDecisionMetrics =
        buildSeasonDecisionMetrics({
          currentSeasonFantasyPoints,
          projectedSeasonPoints:
            projection.projectedSeasonPoints,
          draftProjectedSeasonPoints:
            projection.draftProjectedSeasonPoints,
          teamSchedule: currentTeamScheduleAsOf,
          fallbackGamesPlayed:
            currentStats?.gamesPlayed ?? null
        });
      const currentCycleDecision =
        getCurrentTeamCycleDecisionData({
          teamAbbreviation:
            skater.nhlTeamAbbreviation,
          schedule: currentTeamScheduleAsOf,
          requiredGamesPerCycle:
            options.requiredGamesPerCycle,
          appearedGameIds: new Set(
            currentGames.map((game) => game.gameId)
          )
        });

      return {
        assetType: 'skater',
        assetKey: `skater-${skater.id}`,
        position: skater.position,
        projectedSeasonPoints:
          projection.projectedSeasonPoints,
        projectedCyclePoints:
          projection.projectedCyclePoints,
        currentSeasonFantasyPoints:
          seasonDecisionMetrics.currentSeasonFantasyPoints,
        projectedRestOfSeasonPoints:
          seasonDecisionMetrics.projectedRestOfSeasonPoints,
        projectedFinalSeasonPoints:
          seasonDecisionMetrics.projectedFinalSeasonPoints,
        expectedFantasyPointsToDate:
          seasonDecisionMetrics.expectedFantasyPointsToDate,
        performanceVsProjectionPoints:
          seasonDecisionMetrics.performanceVsProjectionPoints,
        performanceVsProjectionPercent:
          seasonDecisionMetrics.performanceVsProjectionPercent,
        seasonTeamGamesPlayed:
          seasonDecisionMetrics.seasonTeamGamesPlayed,
        seasonGamesRemaining:
          seasonDecisionMetrics.seasonGamesRemaining,
        seasonStatBreakdown,
        seasonStatBreakdownNote:
          currentGames.length > 0
            ? 'Fantasy points are rebuilt from current-season NHL game rows. Primary and secondary assist values use the projection model’s estimated split.'
            : currentStats && (currentStats.gamesPlayed ?? 0) > 0
              ? 'Fantasy points are estimated from current-season aggregate NHL statistics because game-by-game rows were unavailable.'
              : null,
        currentTeamCycleNumber:
          currentCycleDecision.currentTeamCycleNumber,
        currentTeamCycleGames:
          currentCycleDecision.currentTeamCycleGames,
        draftProjectedSeasonPoints:
          projection.draftProjectedSeasonPoints,
        draftProjectedCyclePoints:
          projection.draftProjectedCyclePoints,
        draftTrajectoryLabel:
          projection.draftTrajectoryLabel,
        draftTrajectoryConfidence:
          projection.draftTrajectoryConfidence,
        draftTrajectoryAdjustment:
          projection.draftTrajectoryAdjustment,
        draftLatestSeasonWeight:
          projection.draftLatestSeasonWeight,
        draftPaceChangePercent:
          projection.draftPaceChangePercent,
        draftRecentTrendAdjustment:
          projection.draftRecentTrendAdjustment,
        draftRoleAdjustment:
          projection.draftRoleAdjustment,
        draftReliabilityRating:
          projection.draftReliabilityRating,
        draftVolatilityPenalty:
          projection.draftVolatilityPenalty,
        draftFloorAdjustedCyclePoints:
          projection.draftFloorAdjustedCyclePoints,
        projectionModelVersion:
          projection.projectionModelVersion,
        projectionModelConfidence:
          projection.projectionModelConfidence,
        projectionPrimaryAssistShare:
          projection.projectionPrimaryAssistShare,
        projectionShootingPercentage:
          projection.projectionShootingPercentage,
        projectionShootingRegressionAdjustment:
          projection.projectionShootingRegressionAdjustment,
        projectionCurrentSeasonWeight:
          projection.projectionCurrentSeasonWeight,
        projectionHistoricalWeight:
          projection.projectionHistoricalWeight,
        projectionFloorPoints:
          projection.projectionFloorPoints,
        projectionCeilingPoints:
          projection.projectionCeilingPoints,
        projectionUncertaintyPoints:
          projection.projectionUncertaintyPoints,
        sustainableFormAdjustment:
          projection.sustainableFormAdjustment,
        recentGameStandardDeviation:
          projection.recentGameStandardDeviation,
        seasonBaselineCyclePoints:
          projection.seasonBaselineCyclePoints,
        recentFormAdjustment:
          projection.recentFormAdjustment,
        roleAdjustment:
          projection.roleAdjustment,
        scheduleStrengthAdjustment:
          projection.scheduleStrengthAdjustment,
        scheduleStrengthMultiplier:
          projection.scheduleStrengthMultiplier,
        scheduleDifficultyRating:
          projection.scheduleDifficultyRating,
        scheduleDifficultyLabel:
          projection.scheduleDifficultyLabel,
        scheduleDataConfidence:
          projection.scheduleDataConfidence,
        projectionHomeGames:
          projection.projectionHomeGames,
        projectionRoadGames:
          projection.projectionRoadGames,
        projectionBackToBackGames:
          projection.projectionBackToBackGames,
        projectionRestAdvantageGames:
          projection.projectionRestAdvantageGames,
        projectionOpponentAbbreviations:
          projection.projectionOpponentAbbreviations,
        projectionDataSeason:
          projection.projectionDataSeason,
        projectionDataSource:
          projection.projectionDataSource,
        projectionGamesPlayed:
          projection.projectionGamesPlayed,
        recentFormSampleSize:
          projection.recentFormSampleSize,
        seasonFantasyPointsPerGame:
          projection.seasonFantasyPointsPerGame,
        recentThreeGameFantasyPointsPerGame:
          projection.recentThreeGameFantasyPointsPerGame,
        recentFiveGameFantasyPointsPerGame:
          projection.recentFiveGameFantasyPointsPerGame,
        recentTenGameFantasyPointsPerGame:
          projection.recentTenGameFantasyPointsPerGame,
        recentTwentyGameFantasyPointsPerGame:
          projection.recentTwentyGameFantasyPointsPerGame,
        seasonAverageTimeOnIceMinutes:
          projection.seasonAverageTimeOnIceMinutes,
        recentAverageTimeOnIceMinutes:
          projection.recentAverageTimeOnIceMinutes,
        actualRecentAppearances:
          projection.actualRecentAppearances,
        missedRecentTeamGames:
          projection.missedRecentTeamGames,
        weightedRecentAppearances:
          projection.weightedRecentAppearances,
        fullWeightRecentGames:
          projection.fullWeightRecentGames,
        partialWeightRecentGames:
          projection.partialWeightRecentGames,
        healthyProjectedCyclePoints:
          projection.healthyProjectedCyclePoints,
        scheduledGamesInProjectionCycle:
          projection.scheduledGamesInProjectionCycle,
        expectedGamesAvailable:
          projection.expectedGamesAvailable,
        expectedGamesMissed:
          projection.expectedGamesMissed,
        availabilityAdjustment:
          projection.availabilityAdjustment,
        availabilityAdjustedCyclePoints:
          projection.availabilityAdjustedCyclePoints,
        availabilityStatus:
          projection.availabilityStatus,
        availabilityLabel:
          projection.availabilityLabel,
        availabilityReturnDate:
          projection.availabilityReturnDate,
        availabilityNote:
          projection.availabilityNote,
        availabilityAsOf:
          projection.availabilityAsOf,
        targetProjectionCycleNumber:
          projection.targetProjectionCycleNumber,
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
          nhlTeamAbbreviation:
            skater.nhlTeamAbbreviation,
          teamLogoUrl: skater.teamLogoUrl,
          headshotUrl: skater.headshotUrl,
          birthDate: skater.birthDate
        }
      };
    }
  );

  const goalieUnitAssets: DraftableAsset[] =
    NHL_DRAFT_CLUBS.map((club) => {
      const currentTeamSchedule =
        currentTeamSchedules.get(club.abbreviation) ?? [];
      const currentTeamScheduleAsOf =
        currentTeamSchedulesAsOf.get(club.abbreviation) ?? [];
      const targetGames = getTargetCycleGames(
        currentTeamSchedule,
        options.targetCycleNumber,
        options.requiredGamesPerCycle
      );
      const scheduleContext = options.targetCycleNumber
        ? calculateProjectionScheduleContext({
            teamAbbreviation: club.abbreviation,
            position: 'G',
            targetGames,
            teamSchedules: currentTeamSchedules,
            teamStrengthProfiles,
            requiredGamesPerCycle: options.requiredGamesPerCycle
          })
        : NEUTRAL_PROJECTION_SCHEDULE_CONTEXT;

      const currentStats =
        currentGoalieStatsForProjection.get(
          club.abbreviation
        );
      const currentGames =
        currentGoalieGamesForProjection.get(
          club.abbreviation
        ) ?? [];
      const baseProjection = calculateGoalieUnitProjection({
        currentStats,
        previousStats:
          previousGoalieProjectionStats.get(
            club.abbreviation
          ),
        secondPreviousStats:
          secondPreviousGoalieProjectionStats.get(
            club.abbreviation
          ),
        currentGames,
        previousGames:
          previousGoalieGameStats.get(
            club.abbreviation
          ) ?? [],
        currentSeason,
        previousSeason,
        secondPreviousSeason,
        scheduleContext
      });

      const projection = applyAvailabilityAdjustment(
        baseProjection,
        'G',
        undefined,
        targetGames,
        options.requiredGamesPerCycle,
        options.targetCycleNumber,
        0.18,
        projectionDate,
        true
      );
      const seasonStatBreakdown =
        buildGoalieSeasonBreakdown(
          currentGames,
          currentStats
        );
      const currentSeasonFantasyPoints =
        currentGames.length > 0
          ? calculateGoalieFantasyPointsFromGames(
              currentGames
            )
          : currentStats && (currentStats.gamesPlayed ?? 0) > 0
            ? calculateGoalieRawFantasyPoints(
                currentStats
              )
            : null;
      const seasonDecisionMetrics =
        buildSeasonDecisionMetrics({
          currentSeasonFantasyPoints,
          projectedSeasonPoints:
            projection.projectedSeasonPoints,
          draftProjectedSeasonPoints:
            projection.draftProjectedSeasonPoints,
          teamSchedule: currentTeamScheduleAsOf,
          fallbackGamesPlayed:
            currentStats?.gamesPlayed ?? null
        });
      const currentCycleDecision =
        getCurrentTeamCycleDecisionData({
          teamAbbreviation: club.abbreviation,
          schedule: currentTeamScheduleAsOf,
          requiredGamesPerCycle:
            options.requiredGamesPerCycle,
          goalieUnit: true
        });

      return {
        assetType: 'team-goalie-unit',
        assetKey:
          `goalie-unit-${club.abbreviation}`,
        position: 'G',
        teamName: club.name,
        teamAbbreviation: club.abbreviation,
        teamLogoUrl:
          `https://assets.nhle.com/logos/nhl/svg/${club.abbreviation}_light.svg`,
        projectedSeasonPoints:
          projection.projectedSeasonPoints,
        projectedCyclePoints:
          projection.projectedCyclePoints,
        currentSeasonFantasyPoints:
          seasonDecisionMetrics.currentSeasonFantasyPoints,
        projectedRestOfSeasonPoints:
          seasonDecisionMetrics.projectedRestOfSeasonPoints,
        projectedFinalSeasonPoints:
          seasonDecisionMetrics.projectedFinalSeasonPoints,
        expectedFantasyPointsToDate:
          seasonDecisionMetrics.expectedFantasyPointsToDate,
        performanceVsProjectionPoints:
          seasonDecisionMetrics.performanceVsProjectionPoints,
        performanceVsProjectionPercent:
          seasonDecisionMetrics.performanceVsProjectionPercent,
        seasonTeamGamesPlayed:
          seasonDecisionMetrics.seasonTeamGamesPlayed,
        seasonGamesRemaining:
          seasonDecisionMetrics.seasonGamesRemaining,
        seasonStatBreakdown,
        seasonStatBreakdownNote:
          currentGames.length > 0
            ? 'Goalie-unit points are rebuilt game by game, including save quality and any per-game cap adjustment.'
            : currentStats && (currentStats.gamesPlayed ?? 0) > 0
              ? 'Goalie-unit points are estimated from current-season aggregate NHL statistics because game-by-game rows were unavailable.'
              : null,
        currentTeamCycleNumber:
          currentCycleDecision.currentTeamCycleNumber,
        currentTeamCycleGames:
          currentCycleDecision.currentTeamCycleGames,
        draftProjectedSeasonPoints:
          projection.draftProjectedSeasonPoints,
        draftProjectedCyclePoints:
          projection.draftProjectedCyclePoints,
        draftTrajectoryLabel:
          projection.draftTrajectoryLabel,
        draftTrajectoryConfidence:
          projection.draftTrajectoryConfidence,
        draftTrajectoryAdjustment:
          projection.draftTrajectoryAdjustment,
        draftLatestSeasonWeight:
          projection.draftLatestSeasonWeight,
        draftPaceChangePercent:
          projection.draftPaceChangePercent,
        draftRecentTrendAdjustment:
          projection.draftRecentTrendAdjustment,
        draftRoleAdjustment:
          projection.draftRoleAdjustment,
        draftReliabilityRating:
          projection.draftReliabilityRating,
        draftVolatilityPenalty:
          projection.draftVolatilityPenalty,
        draftFloorAdjustedCyclePoints:
          projection.draftFloorAdjustedCyclePoints,
        projectionModelVersion:
          projection.projectionModelVersion,
        projectionModelConfidence:
          projection.projectionModelConfidence,
        projectionPrimaryAssistShare:
          projection.projectionPrimaryAssistShare,
        projectionShootingPercentage:
          projection.projectionShootingPercentage,
        projectionShootingRegressionAdjustment:
          projection.projectionShootingRegressionAdjustment,
        projectionCurrentSeasonWeight:
          projection.projectionCurrentSeasonWeight,
        projectionHistoricalWeight:
          projection.projectionHistoricalWeight,
        projectionFloorPoints:
          projection.projectionFloorPoints,
        projectionCeilingPoints:
          projection.projectionCeilingPoints,
        projectionUncertaintyPoints:
          projection.projectionUncertaintyPoints,
        sustainableFormAdjustment:
          projection.sustainableFormAdjustment,
        recentGameStandardDeviation:
          projection.recentGameStandardDeviation,
        seasonBaselineCyclePoints:
          projection.seasonBaselineCyclePoints,
        recentFormAdjustment:
          projection.recentFormAdjustment,
        roleAdjustment:
          projection.roleAdjustment,
        scheduleStrengthAdjustment:
          projection.scheduleStrengthAdjustment,
        scheduleStrengthMultiplier:
          projection.scheduleStrengthMultiplier,
        scheduleDifficultyRating:
          projection.scheduleDifficultyRating,
        scheduleDifficultyLabel:
          projection.scheduleDifficultyLabel,
        scheduleDataConfidence:
          projection.scheduleDataConfidence,
        projectionHomeGames:
          projection.projectionHomeGames,
        projectionRoadGames:
          projection.projectionRoadGames,
        projectionBackToBackGames:
          projection.projectionBackToBackGames,
        projectionRestAdvantageGames:
          projection.projectionRestAdvantageGames,
        projectionOpponentAbbreviations:
          projection.projectionOpponentAbbreviations,
        projectionDataSeason:
          projection.projectionDataSeason,
        projectionDataSource:
          projection.projectionDataSource,
        projectionGamesPlayed:
          projection.projectionGamesPlayed,
        recentFormSampleSize:
          projection.recentFormSampleSize,
        seasonFantasyPointsPerGame:
          projection.seasonFantasyPointsPerGame,
        recentThreeGameFantasyPointsPerGame:
          projection.recentThreeGameFantasyPointsPerGame,
        recentFiveGameFantasyPointsPerGame:
          projection.recentFiveGameFantasyPointsPerGame,
        recentTenGameFantasyPointsPerGame:
          projection.recentTenGameFantasyPointsPerGame,
        recentTwentyGameFantasyPointsPerGame:
          projection.recentTwentyGameFantasyPointsPerGame,
        seasonAverageTimeOnIceMinutes:
          projection.seasonAverageTimeOnIceMinutes,
        recentAverageTimeOnIceMinutes:
          projection.recentAverageTimeOnIceMinutes,
        actualRecentAppearances:
          projection.actualRecentAppearances,
        missedRecentTeamGames:
          projection.missedRecentTeamGames,
        weightedRecentAppearances:
          projection.weightedRecentAppearances,
        fullWeightRecentGames:
          projection.fullWeightRecentGames,
        partialWeightRecentGames:
          projection.partialWeightRecentGames,
        healthyProjectedCyclePoints:
          projection.healthyProjectedCyclePoints,
        scheduledGamesInProjectionCycle:
          projection.scheduledGamesInProjectionCycle,
        expectedGamesAvailable:
          projection.expectedGamesAvailable,
        expectedGamesMissed:
          projection.expectedGamesMissed,
        availabilityAdjustment:
          projection.availabilityAdjustment,
        availabilityAdjustedCyclePoints:
          projection.availabilityAdjustedCyclePoints,
        availabilityStatus:
          projection.availabilityStatus,
        availabilityLabel:
          projection.availabilityLabel,
        availabilityReturnDate:
          projection.availabilityReturnDate,
        availabilityNote:
          projection.availabilityNote,
        availabilityAsOf:
          projection.availabilityAsOf,
        targetProjectionCycleNumber:
          projection.targetProjectionCycleNumber,
        reliabilityRating:
          projection.reliabilityRating,
        volatilityPenalty:
          projection.volatilityPenalty,
        floorAdjustedCyclePoints:
          projection.floorAdjustedCyclePoints
      };
    });

  const playerPool = [
    ...skaterAssets,
    ...goalieUnitAssets
  ].sort((first, second) => {
    const firstProjection =
      first.draftProjectedCyclePoints ??
      first.projectedCyclePoints ??
      -1;

    const secondProjection =
      second.draftProjectedCyclePoints ??
      second.projectedCyclePoints ??
      -1;

    if (secondProjection !== firstProjection) {
      return secondProjection - firstProjection;
    }

    return getAssetName(first).localeCompare(
      getAssetName(second)
    );
  });

  if (!hasProjectionContext) {
    cachedPlayerPool = playerPool;
  }

  return playerPool;
}
