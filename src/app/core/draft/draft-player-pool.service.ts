import {
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

import {
  DraftableAsset,
  DraftPosition
} from './draft.models';

import {
  PlayerAvailabilityDatabaseRecord,
  PlayerAvailabilityStatus
} from '../player/player-availability.models';

let cachedPlayerPool: DraftableAsset[] | null = null;

export interface DraftPlayerPoolProjectionOptions {
  forceRefresh?: boolean;
  targetCycleNumber?: number;
  requiredGamesPerCycle?: number;
  availabilityByPlayerId?: ReadonlyMap<
    number,
    PlayerAvailabilityDatabaseRecord
  >;
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
  draftRecentTrendAdjustment: number | null;
  draftRoleAdjustment: number | null;
  draftReliabilityRating: number | null;
  draftVolatilityPenalty: number | null;
  draftFloorAdjustedCyclePoints: number | null;

  seasonBaselineCyclePoints: number | null;
  recentFormAdjustment: number | null;
  roleAdjustment: number | null;
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
     * With the current save, save-percentage, win, and shutout scoring,
     * a normal six-game unit is commonly worth roughly 110-145 points.
     */
    conservativeSeasonPoints: 1450,
    replacementSeasonPoints: 1600,
    highEndSeasonCap: 2200
  }
};

function getCurrentNhlSeason(): string {
  const now = new Date();
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
  'long-term-injured-reserve': 'Long-Term IR',
  suspended: 'Suspended',
  'personal-leave': 'Personal Leave',
  unknown: 'Unknown'
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds)
  );
}

function normalizeProjectionOptions(
  input: boolean | DraftPlayerPoolProjectionOptions
): Required<
  Pick<
    DraftPlayerPoolProjectionOptions,
    'forceRefresh' | 'requiredGamesPerCycle'
  >
> & Omit<
  DraftPlayerPoolProjectionOptions,
  'forceRefresh' | 'requiredGamesPerCycle'
> {
  if (typeof input === 'boolean') {
    return {
      forceRefresh: input,
      targetCycleNumber: undefined,
      requiredGamesPerCycle:
        defaultScoringRules.requiredGamesPerCycle,
      availabilityByPlayerId: undefined
    };
  }

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
    availabilityByPlayerId: input.availabilityByPlayerId
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
  availabilityRecord: PlayerAvailabilityDatabaseRecord | undefined,
  targetGames: NhlTeamSeasonGame[],
  requiredGamesPerCycle: number,
  targetCycleNumber: number | undefined,
  maxPenaltyRate: number
): ProjectionCalculationResult {
  const status = availabilityRecord?.status ?? 'active';
  const returnDate = parseExternalDate(
    availabilityRecord?.externalReturnDate
  );
  const now = new Date();

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

  const reliabilityRating = clamp(
    (projection.reliabilityRating ?? 50) -
      getAvailabilityReliabilityPenalty(
        status,
        Boolean(returnDate)
      ),
    25,
    98
  );

  const penaltyRate =
    (100 - reliabilityRating) / 100 * maxPenaltyRate;

  const volatilityPenalty =
    adjustedProjection * penaltyRate;

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
    availabilityAdjustment:
      roundOneDecimal(availabilityAdjustment),
    availabilityAdjustedCyclePoints:
      roundOneDecimal(adjustedProjection),
    availabilityStatus: status,
    availabilityLabel: AVAILABILITY_LABELS[status],
    availabilityReturnDate:
      availabilityRecord?.externalReturnDate ?? null,
    availabilityNote:
      availabilityRecord?.note ?? null,
    availabilityAsOf:
      availabilityRecord?.updatedAt ?? null,
    targetProjectionCycleNumber:
      targetCycleNumber ?? null,
    reliabilityRating:
      roundOneDecimal(reliabilityRating),
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
  lastTen: number | null,
  lastTwenty: number | null
): number | null {
  const weightedValues = [
    { value: lastTen, weight: 0.65 },
    { value: lastTwenty, weight: 0.35 }
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
  gamesPlayed: number
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

  const estimatedPrimaryAssists = assists * 0.4;
  const estimatedSecondaryAssists = assists * 0.6;

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

  const assistPoints =
    calculateDiminishingGamePoints(
      stats.assists,
      positionRules.primaryAssist
    ) * 0.4 +
    calculateDiminishingGamePoints(
      stats.assists,
      positionRules.secondaryAssist
    ) * 0.6;

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

  const rawSeasonFantasyPointsPerGame =
    average(rawFantasyPoints) ?? 0;

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
      )
    };
  });

  const adjustedFantasyPoints = weightedGames.map(
    (game) => game.fantasyPoints
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
      lastTen,
      lastTwenty
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

function getGoalieSavePercentageTierPoints(
  savePercentage: number
): number {
  const matchingTier =
    defaultScoringRules.goalieSavePercentageTiers.find(
      (tier) =>
        savePercentage >= tier.minSavePercentage
    );

  return matchingTier?.points ?? 0;
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
    saves * defaultScoringRules.goalieSave +
    wins * defaultScoringRules.goalieWin +
    shutouts * defaultScoringRules.goalieShutout +
    gamesPlayed *
      getGoalieSavePercentageTierPoints(savePercentage);

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
    game.saves * defaultScoringRules.goalieSave +
    (game.won ? defaultScoringRules.goalieWin : 0) +
    (game.shutout
      ? defaultScoringRules.goalieShutout
      : 0) +
    getGoalieSavePercentageTierPoints(savePercentage);

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
        lastTen,
        lastTwenty
      ),
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

function getCycleFormAdjustment(
  baselineCyclePoints: number,
  recentMetrics: RecentFormMetrics,
  gamesPlayed: number,
  isCurrentSeason: boolean
): number {
  const seasonPpg =
    recentMetrics.seasonFantasyPointsPerGame;

  const recentPpg =
    recentMetrics.weightedRecentFantasyPointsPerGame;

  if (
    typeof seasonPpg !== 'number' ||
    typeof recentPpg !== 'number' ||
    recentMetrics.sampleSize < 5
  ) {
    return 0;
  }

  const sampleConfidence =
    clamp(recentMetrics.sampleSize / 20, 0.35, 1);

  const seasonConfidence =
    isCurrentSeason
      ? clamp(gamesPlayed / 20, 0.4, 1)
      : 0.35;

  const rawAdjustment =
    (recentPpg - seasonPpg) *
    defaultScoringRules.requiredGamesPerCycle *
    sampleConfidence *
    seasonConfidence *
    0.7;

  const capRate = isCurrentSeason ? 0.06 : 0.04;
  const cap = baselineCyclePoints * capRate;

  return clamp(rawAdjustment, -cap, cap);
}

function getDraftTrendAdjustment(
  baselineCyclePoints: number,
  recentMetrics: RecentFormMetrics,
  isCurrentSeason: boolean
): number {
  const seasonPpg =
    recentMetrics.seasonFantasyPointsPerGame;

  const recentTwentyPpg =
    recentMetrics.recentTwentyGameFantasyPointsPerGame;

  if (
    typeof seasonPpg !== 'number' ||
    typeof recentTwentyPpg !== 'number' ||
    recentMetrics.sampleSize < 10
  ) {
    return 0;
  }

  const sampleConfidence =
    clamp(recentMetrics.sampleSize / 20, 0.5, 1);

  const rawAdjustment =
    (recentTwentyPpg - seasonPpg) *
    defaultScoringRules.requiredGamesPerCycle *
    sampleConfidence *
    (isCurrentSeason ? 0.3 : 0.2);

  const cap = baselineCyclePoints * 0.03;

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
}): number {
  const candidates: Array<{
    projection: number;
    baseWeight: number;
  }> = [];

  if (input.previousPace != null) {
    candidates.push({
      projection: capProjectionBySample(
        input.previousPace,
        input.position,
        input.previousGamesPlayed
      ),
      baseWeight: 0.7
    });
  }

  if (input.secondPreviousPace != null) {
    candidates.push({
      projection: capProjectionBySample(
        input.secondPreviousPace,
        input.position,
        input.secondPreviousGamesPlayed
      ),
      baseWeight: 0.2
    });
  }

  candidates.push({
    projection: input.conservativeBaseline,
    baseWeight: 0.1
  });

  const historicalWeightTotal = candidates.reduce(
    (total, candidate) => total + candidate.baseWeight,
    0
  );

  const currentWeight =
    input.currentPace != null &&
    input.currentGamesPlayed > 0
      ? clamp(
          input.currentGamesPlayed / 82 * 0.65,
          0.04,
          0.65
        )
      : 0;

  const historicalWeight = 1 - currentWeight;

  const historicalProjection = candidates.reduce(
    (total, candidate) =>
      total +
      candidate.projection *
        candidate.baseWeight /
        historicalWeightTotal,
    0
  );

  if (currentWeight <= 0 || input.currentPace == null) {
    return historicalProjection;
  }

  const currentProjection = capProjectionBySample(
    input.currentPace,
    input.position,
    input.currentGamesPlayed
  );

  return (
    currentProjection * currentWeight +
    historicalProjection * historicalWeight
  );
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
  draftRecentTrendAdjustment: number;
  draftRoleAdjustment: number;
  draftReliabilityRating: number;

  projectedCyclePoints: number;
  seasonBaselineCyclePoints: number;
  recentFormAdjustment: number;
  roleAdjustment: number;
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

  return {
    projectedSeasonPoints:
      roundOneDecimal(input.draftProjectedSeasonPoints),
    projectedCyclePoints:
      roundOneDecimal(input.projectedCyclePoints),

    draftProjectedSeasonPoints:
      roundOneDecimal(input.draftProjectedSeasonPoints),
    draftProjectedCyclePoints:
      roundOneDecimal(input.draftProjectedCyclePoints),
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

    seasonBaselineCyclePoints:
      roundOneDecimal(input.seasonBaselineCyclePoints),
    recentFormAdjustment:
      roundOneDecimal(input.recentFormAdjustment),
    roleAdjustment:
      roundOneDecimal(input.roleAdjustment),
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
}): ProjectionCalculationResult {
  const currentGamesPlayed =
    input.currentStats?.gamesPlayed ?? 0;

  const previousGamesPlayed =
    input.previousStats?.gamesPlayed ?? 0;

  const secondPreviousGamesPlayed =
    input.secondPreviousStats?.gamesPlayed ?? 0;

  const currentPace =
    calculateSkaterSeasonPace(
      input.position,
      input.currentStats
    );

  const previousPace =
    calculateSkaterSeasonPace(
      input.position,
      input.previousStats
    );

  const secondPreviousPace =
    calculateSkaterSeasonPace(
      input.position,
      input.secondPreviousStats
    );

  const conservativeBaseline =
    POSITION_BASELINES[
      input.position
    ].conservativeSeasonPoints;

  const previousBaseline =
    previousPace != null
      ? capProjectionBySample(
          previousPace,
          input.position,
          previousGamesPlayed
        )
      : conservativeBaseline;

  let cycleBaselineSeasonProjection = previousBaseline;

  if (currentPace != null && currentGamesPlayed > 0) {
    cycleBaselineSeasonProjection =
      capProjectionBySample(
        blendWithBaseline(
          currentPace,
          previousBaseline,
          getSkaterSampleTrust(currentGamesPlayed)
        ),
        input.position,
        currentGamesPlayed
      );
  }

  const draftBaselineSeasonProjection =
    calculateStableDraftSeasonProjection({
      currentPace,
      previousPace,
      secondPreviousPace,
      conservativeBaseline,
      position: input.position,
      currentGamesPlayed,
      previousGamesPlayed,
      secondPreviousGamesPlayed
    });

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
          input.position,
          selectedGames,
          selectedStats?.averageTimeOnIceMinutes ??
            null,
          usesCurrentSeason
            ? input.currentTeamSchedule
            : input.previousTeamSchedule
        )
      : null;

  const draftBaselineCyclePoints =
    draftBaselineSeasonProjection /
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
    recentMetrics && input.position !== 'G'
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

  const roleAdjustment =
    recentMetrics && input.position !== 'G'
      ? getRoleAdjustment(
          seasonBaselineCyclePoints,
          recentMetrics,
          selectedGamesPlayed,
          usesCurrentSeason
        )
      : 0;

  const projectedCyclePoints = Math.max(
    0,
    seasonBaselineCyclePoints +
      recentFormAdjustment +
      roleAdjustment
  );

  const baseReliability =
    calculateSkaterReliabilityRating(
      input.position,
      selectedStats ?? {},
      selectedGamesPlayed,
      recentMetrics?.consistencyRating ?? null
    );

  const reliabilityRating =
    usesCurrentSeason
      ? baseReliability
      : clamp(baseReliability - 4, 35, 98);

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
    draftRecentTrendAdjustment,
    draftRoleAdjustment,
    draftReliabilityRating,

    projectedCyclePoints,
    seasonBaselineCyclePoints,
    recentFormAdjustment,
    roleAdjustment,
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
}): ProjectionCalculationResult {
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
   * save-percentage tier awarded separately in each game. The older
   * season-summary fallback applied one aggregate save-percentage tier
   * across the entire season and could materially understate goalie units.
   */
  const currentRawPoints =
    input.currentGames.length > 0
      ? calculateGoalieFantasyPointsFromGames(
          input.currentGames
        )
      : input.currentStats
        ? calculateGoalieRawFantasyPoints({
            ...input.currentStats,
            gamesPlayed: Math.max(
              1,
              currentGamesPlayed
            )
          })
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

  const previousBaseline =
    previousPace ??
    conservativeBaseline;

  let cycleBaselineSeasonProjection = previousBaseline;

  if (
    currentPace != null &&
    currentGamesPlayed > 0
  ) {
    cycleBaselineSeasonProjection =
      capProjectionBySample(
        blendWithBaseline(
          currentPace,
          previousBaseline,
          getSkaterSampleTrust(currentGamesPlayed)
        ),
        'G',
        currentGamesPlayed
      );
  }

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
      ? buildGoalieRecentFormMetrics(selectedGames)
      : null;

  const draftBaselineCyclePoints =
    draftBaselineSeasonProjection /
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
    100,
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

  const projectedCyclePoints = clamp(
    seasonBaselineCyclePoints +
      recentFormAdjustment,
    100,
    defaultScoringRules.goalieGameMaximum *
      defaultScoringRules.requiredGamesPerCycle
  );

  const baseReliability =
    calculateGoalieUnitReliabilityRating(
      selectedStats,
      selectedGamesPlayed,
      recentMetrics?.consistencyRating ?? null
    );

  const reliabilityRating =
    usesCurrentSeason
      ? baseReliability
      : clamp(baseReliability - 3, 45, 98);

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
    draftRecentTrendAdjustment,
    draftRoleAdjustment: 0,
    draftReliabilityRating,

    projectedCyclePoints,
    seasonBaselineCyclePoints,
    recentFormAdjustment,
    roleAdjustment: 0,
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
    options.availabilityByPlayerId
  );

  if (
    cachedPlayerPool &&
    !options.forceRefresh &&
    !hasProjectionContext
  ) {
    return cachedPlayerPool;
  }

  const currentSeason = getCurrentNhlSeason();
  const previousSeason = getPreviousSeason(currentSeason);
  const secondPreviousSeason = getPreviousSeason(previousSeason);

  const skaters = await getCurrentNhlDraftSkaters();

  const [
    currentSkaterProjectionStats,
    previousSkaterProjectionStats,
    secondPreviousSkaterProjectionStats,
    currentSkaterGameStats,
    currentGoalieProjectionStats,
    previousGoalieProjectionStats,
    secondPreviousGoalieProjectionStats,
    currentGoalieGameStats
  ] = await Promise.all([
    loadSkaterProjectionStats(currentSeason),
    loadSkaterProjectionStats(previousSeason),
    loadSkaterProjectionStats(secondPreviousSeason),
    loadSkaterGameProjectionStats(currentSeason),
    loadGoalieProjectionStats(currentSeason),
    loadGoalieProjectionStats(previousSeason),
    loadGoalieProjectionStats(secondPreviousSeason),
    loadGoalieGameProjectionStats(currentSeason)
  ]);

  const hasCurrentGameData =
    currentSkaterGameStats.size > 0 ||
    currentGoalieGameStats.size > 0;

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

  const previousTeamSchedules =
    shouldLoadSchedules && !hasCurrentGameData
      ? await loadTeamProjectionSchedules(previousSeason)
      : new Map<string, NhlTeamSeasonGame[]>();

  const skaterAssets: DraftableAsset[] = skaters.map(
    (skater) => {
      const baseProjection = calculateSkaterProjection({
        position: skater.position,
        currentStats:
          currentSkaterProjectionStats.get(skater.id),
        previousStats:
          previousSkaterProjectionStats.get(skater.id),
        secondPreviousStats:
          secondPreviousSkaterProjectionStats.get(skater.id),
        currentGames:
          currentSkaterGameStats.get(skater.id) ?? [],
        previousGames:
          previousSkaterGameStats.get(skater.id) ?? [],
        currentSeason,
        previousSeason,
        secondPreviousSeason,
        currentTeamSchedule:
          currentTeamSchedules.get(
            skater.nhlTeamAbbreviation
          ) ?? [],
        previousTeamSchedule:
          previousTeamSchedules.get(
            skater.nhlTeamAbbreviation
          ) ?? []
      });

      const projection = applyAvailabilityAdjustment(
        baseProjection,
        options.availabilityByPlayerId?.get(skater.id),
        getTargetCycleGames(
          currentTeamSchedules.get(
            skater.nhlTeamAbbreviation
          ) ?? [],
          options.targetCycleNumber,
          options.requiredGamesPerCycle
        ),
        options.requiredGamesPerCycle,
        options.targetCycleNumber,
        0.22
      );

      return {
        assetType: 'skater',
        assetKey: `skater-${skater.id}`,
        position: skater.position,
        projectedSeasonPoints:
          projection.projectedSeasonPoints,
        projectedCyclePoints:
          projection.projectedCyclePoints,
        draftProjectedSeasonPoints:
          projection.draftProjectedSeasonPoints,
        draftProjectedCyclePoints:
          projection.draftProjectedCyclePoints,
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
        seasonBaselineCyclePoints:
          projection.seasonBaselineCyclePoints,
        recentFormAdjustment:
          projection.recentFormAdjustment,
        roleAdjustment:
          projection.roleAdjustment,
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
          headshotUrl: skater.headshotUrl
        }
      };
    }
  );

  const goalieUnitAssets: DraftableAsset[] =
    NHL_DRAFT_CLUBS.map((club) => {
      const baseProjection = calculateGoalieUnitProjection({
        currentStats:
          currentGoalieProjectionStats.get(
            club.abbreviation
          ),
        previousStats:
          previousGoalieProjectionStats.get(
            club.abbreviation
          ),
        secondPreviousStats:
          secondPreviousGoalieProjectionStats.get(
            club.abbreviation
          ),
        currentGames:
          currentGoalieGameStats.get(
            club.abbreviation
          ) ?? [],
        previousGames:
          previousGoalieGameStats.get(
            club.abbreviation
          ) ?? [],
        currentSeason,
        previousSeason,
        secondPreviousSeason
      });

      const projection = applyAvailabilityAdjustment(
        baseProjection,
        undefined,
        getTargetCycleGames(
          currentTeamSchedules.get(
            club.abbreviation
          ) ?? [],
          options.targetCycleNumber,
          options.requiredGamesPerCycle
        ),
        options.requiredGamesPerCycle,
        options.targetCycleNumber,
        0.18
      );

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
        draftProjectedSeasonPoints:
          projection.draftProjectedSeasonPoints,
        draftProjectedCyclePoints:
          projection.draftProjectedCyclePoints,
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
        seasonBaselineCyclePoints:
          projection.seasonBaselineCyclePoints,
        recentFormAdjustment:
          projection.recentFormAdjustment,
        roleAdjustment:
          projection.roleAdjustment,
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
