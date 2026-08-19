import {
  DraftableAsset,
  DraftPosition,
} from '../draft/draft.models';
import {
  getGamePlayByPlay,
  getGoalieGameSummaryStats,
  getNhlTeamSeasonSchedule,
  getSkaterGameRealtimeStats,
  getSkaterGameSummaryStats,
  NHL_DRAFT_CLUBS,
  NhlPlayByPlayEvent,
  NhlStatsRecord,
  NhlTeamSeasonGame,
} from '../nhl/nhl-api.service';
import {
  calculateGoalieGameBreakdown,
  calculateGoalieGamePoints,
  calculateSkaterGamePoints,
  GoalieGameStats,
  SkaterGameStats,
} from './scoring-engine';
import {
  CURRENT_SCORING_RULES_VERSION,
  defaultScoringRules,
  scoringRulesV3,
  ScoringRules,
} from './scoring-rules';

export type CalibrationPosition = DraftPosition;
export type CalibrationAssistMode = 'estimated' | 'exact' | 'hybrid';
export type CalibrationCandidateId =
  | 'current-v4'
  | 'legacy-v3'
  | 'star-separation';

export interface HistoricalCalibrationProgress {
  stage:
    | 'loading-schedules'
    | 'loading-skater-stats'
    | 'loading-goalie-stats'
    | 'loading-exact-assists'
    | 'building-windows'
    | 'summarizing'
    | 'complete';
  completed: number;
  total: number;
  message: string;
}

export interface HistoricalCalibrationRunOptions {
  season: string;
  leagueTeamCount: number;
  requiredGamesPerMatchup?: number;
  useExactAssists?: boolean;
  projectionAssets?: DraftableAsset[];
  signal?: AbortSignal;
  onProgress?: (progress: HistoricalCalibrationProgress) => void;
}

export interface HistoricalCalibrationPercentiles {
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  p95: number;
}

export interface HistoricalCalibrationPositionSummary {
  position: CalibrationPosition;
  label: string;
  assetCount: number;
  windowCount: number;
  mean: number;
  percentiles: HistoricalCalibrationPercentiles;
  standardDeviation: number;
  coefficientOfVariation: number;
  medianAssetVolatility: number;
  bestWindow: number;
  starterSlots: number;
  starterAverage: number;
  replacementThreshold: number;
  replacementAverage: number;
  valueAboveReplacement: number;
}

export interface HistoricalCalibrationCandidateSummary {
  id: CalibrationCandidateId;
  label: string;
  description: string;
  forwardMedian: number;
  forwardP90: number;
  forwardCeilingSpread: number;
  defenseMedian: number;
  goalieMedian: number;
  modeledGoalieSharePercent: number;
  averageStarterAdvantage: number;
  goalieCapHitPercent: number;
}

export interface HistoricalCalibrationFinding {
  level: 'good' | 'watch' | 'review';
  title: string;
  detail: string;
}

export interface HistoricalCalibrationDraftComparison {
  matchedAssetCount: number;
  spearmanCorrelation: number | null;
  label: string;
}

export interface HistoricalCalibrationReport {
  schemaVersion: 1;
  generatedAt: string;
  season: string;
  scoringRulesVersion: number;
  requiredGamesPerMatchup: number;
  leagueTeamCount: number;
  assistMode: CalibrationAssistMode;
  exactAssistGames: number;
  totalScheduleGames: number;
  assistMethodNote: string;
  productionRulesChanged: false;
  skaterAssetCount: number;
  goalieUnitCount: number;
  totalWindowCount: number;
  positionSummaries: HistoricalCalibrationPositionSummary[];
  candidateSummaries: HistoricalCalibrationCandidateSummary[];
  modeledGoalieSharePercent: number;
  goalieCapHitCount: number;
  goalieGameCount: number;
  goalieCapHitPercent: number;
  exceptionalForwardWindowCount: number;
  forwardWindowCount: number;
  exceptionalForwardWindowPercent: number;
  exceptionalForwardThreshold: number;
  defenseVsComparableForwardGap: number;
  draftComparison: HistoricalCalibrationDraftComparison;
  findings: HistoricalCalibrationFinding[];
  recommendation: 'keep-current-rules' | 'review-before-changing' | 'insufficient-data';
  methodologyNotes: string[];
}

interface HistoricalSkaterGame {
  playerId: number;
  playerName: string;
  position: Exclude<CalibrationPosition, 'G'>;
  teamAbbreviation: string;
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
  timeOnIceMinutes: number;
}

interface HistoricalGoalieUnitGame {
  teamAbbreviation: string;
  gameId: number;
  gameDate: string;
  saves: number;
  shotsAgainst: number;
  won: boolean;
  shutout: boolean;
}

interface AssistBreakdown {
  primary: number;
  secondary: number;
}

interface ExactAssistGameCache {
  [playerId: string]: AssistBreakdown;
}

interface ExactAssistSeasonCache {
  schemaVersion: 1;
  season: string;
  games: Record<string, ExactAssistGameCache>;
}

interface CandidateRuleSet {
  id: CalibrationCandidateId;
  label: string;
  description: string;
  rules: ScoringRules;
}

interface CalibrationWindow {
  assetKey: string;
  assetName: string;
  position: CalibrationPosition;
  matchupNumber: number;
  scheduledGameIds: number[];
  appearanceCount: number;
  pointsByCandidate: Record<CalibrationCandidateId, number>;
}

interface CalibrationAssetSummary {
  assetKey: string;
  assetName: string;
  position: CalibrationPosition;
  averageByCandidate: Record<CalibrationCandidateId, number>;
  currentWindowPoints: number[];
}

const POSITIONS: CalibrationPosition[] = ['LW', 'C', 'RW', 'D', 'G'];
const POSITION_LABELS: Record<CalibrationPosition, string> = {
  LW: 'Left Wing',
  C: 'Center',
  RW: 'Right Wing',
  D: 'Defense',
  G: 'Goalie Unit',
};
const POSITION_REQUIREMENTS: Record<CalibrationPosition, number> = {
  LW: 3,
  C: 3,
  RW: 3,
  D: 4,
  G: 1,
};
const EXACT_ASSIST_CACHE_PREFIX = 'rinkrat:historical-assists:v1:';
const EXACT_ASSIST_BATCH_SIZE = 4;
const EXACT_ASSIST_BATCH_DELAY_MILLISECONDS = 120;
const SCHEDULE_BATCH_SIZE = 8;
const EXCEPTIONAL_FORWARD_THRESHOLD = 100;

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Historical calibration was cancelled.', 'AbortError');
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}

function getNumber(record: NhlStatsRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }

  return null;
}

function getString(record: NhlStatsRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (
      value &&
      typeof value === 'object' &&
      'default' in value &&
      typeof (value as { default?: unknown }).default === 'string'
    ) {
      return (value as { default: string }).default.trim();
    }
  }

  return null;
}

function getTeamAbbreviation(record: NhlStatsRecord): string | null {
  const value = getString(record, [
    'teamAbbrevs',
    'teamAbbrev',
    'teamAbbreviation',
    'teamTriCode',
  ]);

  if (!value) {
    return null;
  }

  return value
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .find(Boolean) ?? null;
}

function getSkaterPosition(record: NhlStatsRecord): Exclude<CalibrationPosition, 'G'> | null {
  const value = getString(record, [
    'positionCode',
    'position',
    'skaterPosition',
  ])?.toUpperCase();

  switch (value) {
    case 'L':
    case 'LW':
      return 'LW';
    case 'C':
      return 'C';
    case 'R':
    case 'RW':
      return 'RW';
    case 'D':
      return 'D';
    default:
      return null;
  }
}

function parseTimeOnIceMinutes(value: unknown): number {
  if (typeof value === 'string') {
    const parts = value.split(':').map(Number);

    if (parts.length === 2 && parts.every(Number.isFinite)) {
      return parts[0] + parts[1] / 60;
    }

    if (parts.length === 3 && parts.every(Number.isFinite)) {
      return parts[0] * 60 + parts[1] + parts[2] / 60;
    }
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 60 ? value / 60 : value;
  }

  return 0;
}

function getTimeOnIceMinutes(record: NhlStatsRecord): number {
  for (const key of [
    'timeOnIce',
    'toi',
    'timeOnIcePerGame',
    'avgTimeOnIce',
  ]) {
    const minutes = parseTimeOnIceMinutes(record[key]);

    if (minutes > 0) {
      return minutes;
    }
  }

  return 0;
}

function stableHash(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function estimateAssistBreakdown(
  gameId: number,
  playerId: number,
  assists: number,
): AssistBreakdown {
  const safeAssists = Math.max(0, Math.floor(assists));

  if (safeAssists === 0) {
    return { primary: 0, secondary: 0 };
  }

  if (safeAssists === 1) {
    return stableHash(`${gameId}:${playerId}`) % 10 < 4
      ? { primary: 1, secondary: 0 }
      : { primary: 0, secondary: 1 };
  }

  const primary = clamp(Math.round(safeAssists * 0.4), 1, safeAssists);

  return {
    primary,
    secondary: safeAssists - primary,
  };
}

function cloneRules(rules: ScoringRules): ScoringRules {
  return JSON.parse(JSON.stringify(rules)) as ScoringRules;
}

function multiplyDiminishingValues(
  values: { first: number; second: number; additional: number },
  multiplier: number,
): void {
  values.first *= multiplier;
  values.second *= multiplier;
  values.additional *= multiplier;
}

function createCandidateRuleSets(): CandidateRuleSet[] {
  const currentRules = cloneRules(defaultScoringRules);
  const starSeparation = cloneRules(defaultScoringRules);
  multiplyDiminishingValues(starSeparation.forward.goal, 1.08);
  multiplyDiminishingValues(starSeparation.forward.primaryAssist, 1.08);
  starSeparation.forward.shotOnGoal *= 0.94;
  starSeparation.forward.hit *= 0.94;
  starSeparation.forward.blockedShot *= 0.94;
  starSeparation.forwardToiMultiplier *= 0.94;

  const legacyV3 = cloneRules(scoringRulesV3);

  return [
    {
      id: 'current-v4',
      label: 'Production V4',
      description: 'Uncapped goalie scoring with a wider efficiency curve, stronger win/shutout rewards, and skater scoring unchanged.',
      rules: currentRules,
    },
    {
      id: 'legacy-v3',
      label: 'Legacy V3',
      description:
        'The former 28-point goalie cap and more compressed participation/save model, retained for before-and-after calibration.',
      rules: legacyV3,
    },
    {
      id: 'star-separation',
      label: 'Star Separation',
      description:
        'Raises forward goals and primary assists by 8% while trimming repeatable floor categories by 6%.',
      rules: starSeparation,
    },
  ];
}

async function loadAllTeamSchedules(
  season: string,
  signal: AbortSignal | undefined,
  onProgress: HistoricalCalibrationRunOptions['onProgress'],
): Promise<Map<string, NhlTeamSeasonGame[]>> {
  const schedules = new Map<string, NhlTeamSeasonGame[]>();

  for (let index = 0; index < NHL_DRAFT_CLUBS.length; index += SCHEDULE_BATCH_SIZE) {
    assertNotAborted(signal);
    const clubs = NHL_DRAFT_CLUBS.slice(index, index + SCHEDULE_BATCH_SIZE);
    const results = await Promise.allSettled(
      clubs.map(async (club) => ({
        team: club.abbreviation,
        games: (await getNhlTeamSeasonSchedule(club.abbreviation, season))
          .filter((game) => game.gameType === 2)
          .sort((first, second) =>
            first.gameDate.localeCompare(second.gameDate) || first.id - second.id),
      })),
    );

    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        schedules.set(result.value.team, result.value.games);
      }
    });

    onProgress?.({
      stage: 'loading-schedules',
      completed: Math.min(index + clubs.length, NHL_DRAFT_CLUBS.length),
      total: NHL_DRAFT_CLUBS.length,
      message: `Loaded ${Math.min(index + clubs.length, NHL_DRAFT_CLUBS.length)} of ${NHL_DRAFT_CLUBS.length} NHL team schedules.`,
    });
  }

  return schedules;
}

function mergeSkaterRecords(
  summaryRecords: NhlStatsRecord[],
  realtimeRecords: NhlStatsRecord[],
): HistoricalSkaterGame[] {
  const byKey = new Map<string, HistoricalSkaterGame>();

  const merge = (record: NhlStatsRecord, includeSummary: boolean): void => {
    const playerId = getNumber(record, ['playerId', 'id']);
    const gameId = getNumber(record, ['gameId', 'gamePk']);
    const gameDate = getString(record, ['gameDate', 'date']) ?? '';
    const teamAbbreviation = getTeamAbbreviation(record);
    const position = getSkaterPosition(record);

    if (!playerId || !gameId || !teamAbbreviation || !position) {
      return;
    }

    const key = `${playerId}:${gameId}`;
    const existing = byKey.get(key) ?? {
      playerId,
      playerName:
        getString(record, ['skaterFullName', 'playerName', 'fullName', 'name']) ??
        `Player ${playerId}`,
      position,
      teamAbbreviation,
      gameId,
      gameDate,
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
      timeOnIceMinutes: 0,
    };

    existing.playerName =
      getString(record, ['skaterFullName', 'playerName', 'fullName', 'name']) ??
      existing.playerName;
    existing.position = position;
    existing.teamAbbreviation = teamAbbreviation;
    existing.gameDate = gameDate || existing.gameDate;

    if (includeSummary) {
      existing.goals = getNumber(record, ['goals']) ?? existing.goals;
      existing.assists = getNumber(record, ['assists']) ?? existing.assists;
      existing.shotsOnGoal =
        getNumber(record, ['shots', 'shotsOnGoal']) ?? existing.shotsOnGoal;
      existing.plusMinus = getNumber(record, ['plusMinus']) ?? existing.plusMinus;
      existing.powerPlayPoints =
        getNumber(record, ['ppPoints', 'powerPlayPoints', 'powerplayPoints']) ??
        existing.powerPlayPoints;
      existing.shortHandedPoints =
        getNumber(record, ['shPoints', 'shortHandedPoints', 'shorthandedPoints']) ??
        existing.shortHandedPoints;
      existing.gameWinningGoals =
        getNumber(record, ['gameWinningGoals', 'gwg']) ?? existing.gameWinningGoals;
      existing.overtimeGoals =
        getNumber(record, ['otGoals', 'overtimeGoals']) ?? existing.overtimeGoals;
    } else {
      existing.hits = getNumber(record, ['hits']) ?? existing.hits;
      existing.blockedShots =
        getNumber(record, ['blockedShots', 'blocks']) ?? existing.blockedShots;
    }

    const toi = getTimeOnIceMinutes(record);
    existing.timeOnIceMinutes = toi > 0 ? toi : existing.timeOnIceMinutes;
    byKey.set(key, existing);
  };

  summaryRecords.forEach((record) => merge(record, true));
  realtimeRecords.forEach((record) => merge(record, false));

  return [...byKey.values()].sort(
    (first, second) =>
      first.playerId - second.playerId ||
      first.gameDate.localeCompare(second.gameDate) ||
      first.gameId - second.gameId,
  );
}

function mergeGoalieRecords(records: NhlStatsRecord[]): HistoricalGoalieUnitGame[] {
  const byKey = new Map<string, HistoricalGoalieUnitGame>();

  for (const record of records) {
    const gameId = getNumber(record, ['gameId', 'gamePk']);
    const teamAbbreviation = getTeamAbbreviation(record);

    if (!gameId || !teamAbbreviation) {
      continue;
    }

    const key = `${teamAbbreviation}:${gameId}`;
    const existing = byKey.get(key) ?? {
      teamAbbreviation,
      gameId,
      gameDate: getString(record, ['gameDate', 'date']) ?? '',
      saves: 0,
      shotsAgainst: 0,
      won: false,
      shutout: false,
    };
    const saves = getNumber(record, ['saves']) ?? 0;
    const shotsAgainst = getNumber(record, ['shotsAgainst']) ?? 0;
    const goalsAgainst = getNumber(record, ['goalsAgainst']) ?? Math.max(0, shotsAgainst - saves);
    const wins = getNumber(record, ['wins']) ?? 0;
    const shutouts = getNumber(record, ['shutouts']) ?? 0;

    existing.saves += saves;
    existing.shotsAgainst += shotsAgainst;
    existing.won = existing.won || wins > 0;
    existing.shutout = existing.shutout || shutouts > 0 || (shotsAgainst > 0 && goalsAgainst === 0);
    existing.gameDate = existing.gameDate || getString(record, ['gameDate', 'date']) || '';
    byKey.set(key, existing);
  }

  return [...byKey.values()].sort(
    (first, second) =>
      first.teamAbbreviation.localeCompare(second.teamAbbreviation) ||
      first.gameDate.localeCompare(second.gameDate) ||
      first.gameId - second.gameId,
  );
}

function getExactAssistCacheKey(season: string): string {
  return `${EXACT_ASSIST_CACHE_PREFIX}${season}`;
}

function loadExactAssistCache(season: string): ExactAssistSeasonCache {
  const empty: ExactAssistSeasonCache = {
    schemaVersion: 1,
    season,
    games: {},
  };

  if (typeof localStorage === 'undefined') {
    return empty;
  }

  try {
    const raw = localStorage.getItem(getExactAssistCacheKey(season));

    if (!raw) {
      return empty;
    }

    const parsed = JSON.parse(raw) as Partial<ExactAssistSeasonCache>;

    return parsed.schemaVersion === 1 && parsed.season === season && parsed.games
      ? {
          schemaVersion: 1,
          season,
          games: parsed.games,
        }
      : empty;
  } catch {
    return empty;
  }
}

function saveExactAssistCache(cache: ExactAssistSeasonCache): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(getExactAssistCacheKey(cache.season), JSON.stringify(cache));
  } catch {
    // Exact enrichment still works in memory if browser storage is unavailable.
  }
}

function buildAssistCacheFromPlayByPlay(
  plays: NhlPlayByPlayEvent[],
): ExactAssistGameCache {
  const result: ExactAssistGameCache = {};

  for (const play of plays) {
    if (play.typeDescKey !== 'goal') {
      continue;
    }

    const primaryId = play.details?.assist1PlayerId;
    const secondaryId = play.details?.assist2PlayerId;

    if (typeof primaryId === 'number') {
      const key = String(primaryId);
      result[key] = result[key] ?? { primary: 0, secondary: 0 };
      result[key].primary += 1;
    }

    if (typeof secondaryId === 'number') {
      const key = String(secondaryId);
      result[key] = result[key] ?? { primary: 0, secondary: 0 };
      result[key].secondary += 1;
    }
  }

  return result;
}

async function loadExactAssistCacheForGames(input: {
  season: string;
  gameIds: number[];
  signal?: AbortSignal;
  onProgress?: HistoricalCalibrationRunOptions['onProgress'];
}): Promise<ExactAssistSeasonCache> {
  const cache = loadExactAssistCache(input.season);
  const missingGameIds = input.gameIds.filter((gameId) => !cache.games[String(gameId)]);
  let processed = input.gameIds.length - missingGameIds.length;

  input.onProgress?.({
    stage: 'loading-exact-assists',
    completed: processed,
    total: input.gameIds.length,
    message: `Exact assist order is already cached for ${processed} of ${input.gameIds.length} games.`,
  });

  for (let index = 0; index < missingGameIds.length; index += EXACT_ASSIST_BATCH_SIZE) {
    assertNotAborted(input.signal);
    const batch = missingGameIds.slice(index, index + EXACT_ASSIST_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (gameId) => ({
        gameId,
        playByPlay: await getGamePlayByPlay(gameId),
      })),
    );

    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        cache.games[String(result.value.gameId)] = buildAssistCacheFromPlayByPlay(
          result.value.playByPlay.plays ?? [],
        );
      }
    });

    processed += batch.length;

    if (processed % 20 < EXACT_ASSIST_BATCH_SIZE || processed >= input.gameIds.length) {
      saveExactAssistCache(cache);
    }

    input.onProgress?.({
      stage: 'loading-exact-assists',
      completed: Math.min(processed, input.gameIds.length),
      total: input.gameIds.length,
      message: `Loaded exact primary and secondary assist order for ${Math.min(processed, input.gameIds.length)} of ${input.gameIds.length} games.`,
    });

    if (index + EXACT_ASSIST_BATCH_SIZE < missingGameIds.length) {
      await wait(EXACT_ASSIST_BATCH_DELAY_MILLISECONDS);
    }
  }

  saveExactAssistCache(cache);
  return cache;
}

function buildPlayerScheduleTimeline(
  games: HistoricalSkaterGame[],
  schedules: ReadonlyMap<string, NhlTeamSeasonGame[]>,
): NhlTeamSeasonGame[] {
  const sortedGames = [...games].sort(
    (first, second) =>
      first.gameDate.localeCompare(second.gameDate) || first.gameId - second.gameId,
  );
  const segments: Array<{ team: string; startDate: string | null }> = [];

  for (const game of sortedGames) {
    if (segments.at(-1)?.team === game.teamAbbreviation) {
      continue;
    }

    segments.push({
      team: game.teamAbbreviation,
      startDate: segments.length === 0 ? null : game.gameDate,
    });
  }

  if (segments.length === 0) {
    return [];
  }

  const timeline: NhlTeamSeasonGame[] = [];
  const seen = new Set<number>();

  segments.forEach((segment, index) => {
    const nextStartDate = segments[index + 1]?.startDate ?? null;

    for (const game of schedules.get(segment.team) ?? []) {
      const afterStart = !segment.startDate || game.gameDate >= segment.startDate;
      const beforeNext = !nextStartDate || game.gameDate < nextStartDate;

      if (afterStart && beforeNext && !seen.has(game.id)) {
        seen.add(game.id);
        timeline.push(game);
      }
    }
  });

  return timeline.sort(
    (first, second) =>
      first.gameDate.localeCompare(second.gameDate) || first.id - second.id,
  );
}

function scoreSkaterGame(
  game: HistoricalSkaterGame | undefined,
  rules: ScoringRules,
  assistBreakdown: AssistBreakdown,
): number {
  if (!game) {
    return 0;
  }

  const stats: SkaterGameStats = {
    position: game.position === 'D' ? 'D' : 'F',
    goals: game.goals,
    primaryAssists: assistBreakdown.primary,
    secondaryAssists: assistBreakdown.secondary,
    shotsOnGoal: game.shotsOnGoal,
    hits: game.hits,
    blockedShots: game.blockedShots,
    plusMinus: game.plusMinus,
    powerPlayPoints: game.powerPlayPoints,
    shortHandedPoints: game.shortHandedPoints,
    gameWinningGoal: game.gameWinningGoals > 0,
    overtimeGoal: game.overtimeGoals > 0,
    timeOnIceMinutes: game.timeOnIceMinutes,
  };

  return calculateSkaterGamePoints(stats, rules);
}

function scoreGoalieGame(
  game: HistoricalGoalieUnitGame | undefined,
  rules: ScoringRules,
): number {
  if (!game) {
    return 0;
  }

  const stats: GoalieGameStats = {
    saves: game.saves,
    shotsAgainst: game.shotsAgainst,
    won: game.won,
    shutout: game.shutout,
  };

  return calculateGoalieGamePoints(stats, rules);
}

function buildCalibrationWindows(input: {
  skaterGames: HistoricalSkaterGame[];
  goalieGames: HistoricalGoalieUnitGame[];
  schedules: ReadonlyMap<string, NhlTeamSeasonGame[]>;
  exactAssistCache: ExactAssistSeasonCache | null;
  candidates: CandidateRuleSet[];
  requiredGamesPerMatchup: number;
  signal?: AbortSignal;
  onProgress?: HistoricalCalibrationRunOptions['onProgress'];
}): { windows: CalibrationWindow[]; goalieCapHitCount: number; goalieGameCount: number } {
  const windows: CalibrationWindow[] = [];
  const gamesByPlayer = new Map<number, HistoricalSkaterGame[]>();

  for (const game of input.skaterGames) {
    const playerGames = gamesByPlayer.get(game.playerId) ?? [];
    playerGames.push(game);
    gamesByPlayer.set(game.playerId, playerGames);
  }

  let processedAssets = 0;
  const totalAssets = gamesByPlayer.size + input.schedules.size;

  for (const [playerId, playerGames] of gamesByPlayer) {
    assertNotAborted(input.signal);
    const appearanceByGameId = new Map(playerGames.map((game) => [game.gameId, game]));
    const scheduleTimeline = buildPlayerScheduleTimeline(playerGames, input.schedules);
    const firstGame = playerGames[0];

    for (
      let index = 0;
      index + input.requiredGamesPerMatchup <= scheduleTimeline.length;
      index += input.requiredGamesPerMatchup
    ) {
      const scheduledGames = scheduleTimeline.slice(
        index,
        index + input.requiredGamesPerMatchup,
      );
      const pointsByCandidate = Object.fromEntries(
        input.candidates.map((candidate) => [candidate.id, 0]),
      ) as Record<CalibrationCandidateId, number>;
      let appearanceCount = 0;

      for (const scheduledGame of scheduledGames) {
        const game = appearanceByGameId.get(scheduledGame.id);

        if (game) {
          appearanceCount += 1;
        }

        const exactAssist = input.exactAssistCache?.games[String(scheduledGame.id)]?.[
          String(playerId)
        ];
        const assistBreakdown = exactAssist ?? estimateAssistBreakdown(
          scheduledGame.id,
          playerId,
          game?.assists ?? 0,
        );

        input.candidates.forEach((candidate) => {
          pointsByCandidate[candidate.id] += scoreSkaterGame(
            game,
            candidate.rules,
            assistBreakdown,
          );
        });
      }

      Object.keys(pointsByCandidate).forEach((key) => {
        const candidateId = key as CalibrationCandidateId;
        pointsByCandidate[candidateId] = round(pointsByCandidate[candidateId], 2);
      });

      windows.push({
        assetKey: `skater-${playerId}`,
        assetName: firstGame?.playerName ?? `Player ${playerId}`,
        position: firstGame?.position ?? 'C',
        matchupNumber: index / input.requiredGamesPerMatchup + 1,
        scheduledGameIds: scheduledGames.map((game) => game.id),
        appearanceCount,
        pointsByCandidate,
      });
    }

    processedAssets += 1;
    input.onProgress?.({
      stage: 'building-windows',
      completed: processedAssets,
      total: totalAssets,
      message: `Built schedule-based six-game windows for ${processedAssets} of ${totalAssets} players and goalie units.`,
    });
  }

  const goalieByTeamAndGame = new Map(
    input.goalieGames.map((game) => [`${game.teamAbbreviation}:${game.gameId}`, game]),
  );
  let goalieCapHitCount = 0;
  let goalieGameCount = 0;

  for (const [teamAbbreviation, schedule] of input.schedules) {
    assertNotAborted(input.signal);

    for (
      let index = 0;
      index + input.requiredGamesPerMatchup <= schedule.length;
      index += input.requiredGamesPerMatchup
    ) {
      const scheduledGames = schedule.slice(index, index + input.requiredGamesPerMatchup);
      const pointsByCandidate = Object.fromEntries(
        input.candidates.map((candidate) => [candidate.id, 0]),
      ) as Record<CalibrationCandidateId, number>;
      let appearanceCount = 0;

      for (const scheduledGame of scheduledGames) {
        const game = goalieByTeamAndGame.get(`${teamAbbreviation}:${scheduledGame.id}`);

        if (game) {
          appearanceCount += 1;
          goalieGameCount += 1;
          const breakdown = calculateGoalieGameBreakdown(
            {
              saves: game.saves,
              shotsAgainst: game.shotsAgainst,
              won: game.won,
              shutout: game.shutout,
            },
            scoringRulesV3,
          );

          if (breakdown.lines.some((line) => line.label.startsWith('Goalie Game Maximum'))) {
            goalieCapHitCount += 1;
          }
        }

        input.candidates.forEach((candidate) => {
          pointsByCandidate[candidate.id] += scoreGoalieGame(game, candidate.rules);
        });
      }

      Object.keys(pointsByCandidate).forEach((key) => {
        const candidateId = key as CalibrationCandidateId;
        pointsByCandidate[candidateId] = round(pointsByCandidate[candidateId], 2);
      });

      windows.push({
        assetKey: `goalie-unit-${teamAbbreviation}`,
        assetName: `${teamAbbreviation} Team Goalie Unit`,
        position: 'G',
        matchupNumber: index / input.requiredGamesPerMatchup + 1,
        scheduledGameIds: scheduledGames.map((game) => game.id),
        appearanceCount,
        pointsByCandidate,
      });
    }

    processedAssets += 1;
    input.onProgress?.({
      stage: 'building-windows',
      completed: processedAssets,
      total: totalAssets,
      message: `Built schedule-based six-game windows for ${processedAssets} of ${totalAssets} players and goalie units.`,
    });
  }

  return {
    windows,
    goalieCapHitCount,
    goalieGameCount,
  };
}

function average(values: number[]): number {
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

function percentile(values: number[], target: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((first, second) => first - second);
  const index = (sorted.length - 1) * target;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function standardDeviation(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }

  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function buildPercentiles(values: number[]): HistoricalCalibrationPercentiles {
  return {
    p10: round(percentile(values, 0.1)),
    p25: round(percentile(values, 0.25)),
    median: round(percentile(values, 0.5)),
    p75: round(percentile(values, 0.75)),
    p90: round(percentile(values, 0.9)),
    p95: round(percentile(values, 0.95)),
  };
}

function buildAssetSummaries(
  windows: CalibrationWindow[],
  candidates: CandidateRuleSet[],
): CalibrationAssetSummary[] {
  const grouped = new Map<string, CalibrationWindow[]>();

  for (const window of windows) {
    const rows = grouped.get(window.assetKey) ?? [];
    rows.push(window);
    grouped.set(window.assetKey, rows);
  }

  return [...grouped.entries()].map(([assetKey, rows]) => ({
    assetKey,
    assetName: rows[0].assetName,
    position: rows[0].position,
    averageByCandidate: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        round(average(rows.map((row) => row.pointsByCandidate[candidate.id])), 2),
      ]),
    ) as Record<CalibrationCandidateId, number>,
    currentWindowPoints: rows.map((row) => row.pointsByCandidate['current-v4']),
  }));
}

function getPositionSummary(input: {
  position: CalibrationPosition;
  windows: CalibrationWindow[];
  assetSummaries: CalibrationAssetSummary[];
  leagueTeamCount: number;
}): HistoricalCalibrationPositionSummary {
  const positionWindows = input.windows.filter((window) => window.position === input.position);
  const points = positionWindows.map((window) => window.pointsByCandidate['current-v4']);
  const assets = input.assetSummaries
    .filter((asset) => asset.position === input.position)
    .sort(
      (first, second) =>
        second.averageByCandidate['current-v4'] - first.averageByCandidate['current-v4'],
    );
  const starterSlots = input.leagueTeamCount * POSITION_REQUIREMENTS[input.position];
  const starters = assets.slice(0, starterSlots);
  const replacementAsset = assets[Math.max(0, starterSlots - 1)];
  const replacementPool = assets.slice(starterSlots, starterSlots + input.leagueTeamCount);
  const replacementThreshold = replacementAsset?.averageByCandidate['current-v4'] ?? 0;
  const replacementAverage = replacementPool.length > 0
    ? average(replacementPool.map((asset) => asset.averageByCandidate['current-v4']))
    : replacementThreshold;
  const starterAverage = average(
    starters.map((asset) => asset.averageByCandidate['current-v4']),
  );
  const assetVolatility = assets.map((asset) => standardDeviation(asset.currentWindowPoints));
  const mean = average(points);
  const deviation = standardDeviation(points);

  return {
    position: input.position,
    label: POSITION_LABELS[input.position],
    assetCount: assets.length,
    windowCount: positionWindows.length,
    mean: round(mean),
    percentiles: buildPercentiles(points),
    standardDeviation: round(deviation),
    coefficientOfVariation: round(mean > 0 ? deviation / mean : 0, 2),
    medianAssetVolatility: round(percentile(assetVolatility, 0.5)),
    bestWindow: round(Math.max(0, ...points)),
    starterSlots,
    starterAverage: round(starterAverage),
    replacementThreshold: round(replacementThreshold),
    replacementAverage: round(replacementAverage),
    valueAboveReplacement: round(starterAverage - replacementAverage),
  };
}

function getModeledGoalieShare(
  assetSummaries: CalibrationAssetSummary[],
  leagueTeamCount: number,
  candidateId: CalibrationCandidateId,
): number {
  const starterAverageByPosition = Object.fromEntries(
    POSITIONS.map((position) => {
      const assets = assetSummaries
        .filter((asset) => asset.position === position)
        .sort(
          (first, second) =>
            second.averageByCandidate[candidateId] - first.averageByCandidate[candidateId],
        );
      const count = leagueTeamCount * POSITION_REQUIREMENTS[position];
      return [
        position,
        average(assets.slice(0, count).map((asset) => asset.averageByCandidate[candidateId])),
      ];
    }),
  ) as Record<CalibrationPosition, number>;
  const total = POSITIONS.reduce(
    (sum, position) =>
      sum + starterAverageByPosition[position] * POSITION_REQUIREMENTS[position],
    0,
  );

  return total > 0 ? (starterAverageByPosition.G / total) * 100 : 0;
}

function getAverageStarterAdvantage(
  assetSummaries: CalibrationAssetSummary[],
  leagueTeamCount: number,
  candidateId: CalibrationCandidateId,
): number {
  const advantages = POSITIONS.map((position) => {
    const assets = assetSummaries
      .filter((asset) => asset.position === position)
      .sort(
        (first, second) =>
          second.averageByCandidate[candidateId] - first.averageByCandidate[candidateId],
      );
    const starterCount = leagueTeamCount * POSITION_REQUIREMENTS[position];
    const starterAverage = average(
      assets.slice(0, starterCount).map((asset) => asset.averageByCandidate[candidateId]),
    );
    const replacement =
      assets[Math.max(0, starterCount - 1)]?.averageByCandidate[candidateId] ?? 0;

    return starterAverage - replacement;
  });

  return average(advantages);
}

function buildCandidateSummaries(input: {
  windows: CalibrationWindow[];
  assetSummaries: CalibrationAssetSummary[];
  candidates: CandidateRuleSet[];
  leagueTeamCount: number;
  goalieGames: HistoricalGoalieUnitGame[];
}): HistoricalCalibrationCandidateSummary[] {
  return input.candidates.map((candidate) => {
    const forwardPoints = input.windows
      .filter((window) => ['LW', 'C', 'RW'].includes(window.position))
      .map((window) => window.pointsByCandidate[candidate.id]);
    const defensePoints = input.windows
      .filter((window) => window.position === 'D')
      .map((window) => window.pointsByCandidate[candidate.id]);
    const goaliePoints = input.windows
      .filter((window) => window.position === 'G')
      .map((window) => window.pointsByCandidate[candidate.id]);
    const capHitCount = input.goalieGames.filter((game) => {
      const breakdown = calculateGoalieGameBreakdown(
        {
          saves: game.saves,
          shotsAgainst: game.shotsAgainst,
          won: game.won,
          shutout: game.shutout,
        },
        candidate.rules,
      );
      return breakdown.lines.some((line) => line.label.startsWith('Goalie Game Maximum'));
    }).length;
    const forwardMedian = percentile(forwardPoints, 0.5);
    const forwardP90 = percentile(forwardPoints, 0.9);

    return {
      id: candidate.id,
      label: candidate.label,
      description: candidate.description,
      forwardMedian: round(forwardMedian),
      forwardP90: round(forwardP90),
      forwardCeilingSpread: round(forwardP90 - forwardMedian),
      defenseMedian: round(percentile(defensePoints, 0.5)),
      goalieMedian: round(percentile(goaliePoints, 0.5)),
      modeledGoalieSharePercent: round(
        getModeledGoalieShare(input.assetSummaries, input.leagueTeamCount, candidate.id),
      ),
      averageStarterAdvantage: round(
        getAverageStarterAdvantage(
          input.assetSummaries,
          input.leagueTeamCount,
          candidate.id,
        ),
      ),
      goalieCapHitPercent: round(
        input.goalieGames.length > 0
          ? (capHitCount / input.goalieGames.length) * 100
          : 0,
        2,
      ),
    };
  });
}

function getDefenseVsComparableForwardGap(
  assetSummaries: CalibrationAssetSummary[],
): number {
  const defense = assetSummaries
    .filter((asset) => asset.position === 'D')
    .sort(
      (first, second) =>
        second.averageByCandidate['current-v4'] - first.averageByCandidate['current-v4'],
    );
  const forwards = assetSummaries
    .filter((asset) => ['LW', 'C', 'RW'].includes(asset.position))
    .sort(
      (first, second) =>
        second.averageByCandidate['current-v4'] - first.averageByCandidate['current-v4'],
    );
  const comparisonCount = Math.min(40, defense.length, forwards.length);

  if (comparisonCount === 0) {
    return 0;
  }

  const gaps: number[] = [];

  for (let index = 0; index < comparisonCount; index += 1) {
    const defensePercentile = comparisonCount <= 1 ? 0 : index / (comparisonCount - 1);
    const forwardIndex = Math.round(defensePercentile * Math.max(0, forwards.length - 1));
    gaps.push(
      defense[index].averageByCandidate['current-v4'] -
        forwards[forwardIndex].averageByCandidate['current-v4'],
    );
  }

  return round(average(gaps));
}

function rank(values: Array<{ key: string; value: number }>): Map<string, number> {
  const sorted = [...values].sort((first, second) => second.value - first.value);
  const result = new Map<string, number>();
  let index = 0;

  while (index < sorted.length) {
    let end = index + 1;

    while (end < sorted.length && sorted[end].value === sorted[index].value) {
      end += 1;
    }

    const averageRank = (index + 1 + end) / 2;

    for (let position = index; position < end; position += 1) {
      result.set(sorted[position].key, averageRank);
    }

    index = end;
  }

  return result;
}

function spearmanCorrelation(
  firstRanks: Map<string, number>,
  secondRanks: Map<string, number>,
): number | null {
  const keys = [...firstRanks.keys()].filter((key) => secondRanks.has(key));

  if (keys.length < 8) {
    return null;
  }

  const first = keys.map((key) => firstRanks.get(key) ?? 0);
  const second = keys.map((key) => secondRanks.get(key) ?? 0);
  const firstMean = average(first);
  const secondMean = average(second);
  const numerator = keys.reduce(
    (total, _key, index) =>
      total + (first[index] - firstMean) * (second[index] - secondMean),
    0,
  );
  const firstVariance = first.reduce(
    (total, value) => total + (value - firstMean) ** 2,
    0,
  );
  const secondVariance = second.reduce(
    (total, value) => total + (value - secondMean) ** 2,
    0,
  );
  const denominator = Math.sqrt(firstVariance * secondVariance);

  return denominator > 0 ? numerator / denominator : null;
}

function buildDraftComparison(
  assetSummaries: CalibrationAssetSummary[],
  projectionAssets: DraftableAsset[],
): HistoricalCalibrationDraftComparison {
  const projectionRankValues = projectionAssets
    .map((asset) => ({
      key: asset.assetKey,
      value: -(asset.draftRank ?? asset.balancedRank ?? Number.MAX_SAFE_INTEGER),
    }))
    .filter((entry) => Number.isFinite(entry.value));
  const actualRankValues = assetSummaries.map((asset) => ({
    key: asset.assetKey,
    value: asset.averageByCandidate['current-v4'],
  }));
  const projectionRanks = rank(projectionRankValues);
  const actualRanks = rank(actualRankValues);
  const matchedAssetCount = [...projectionRanks.keys()].filter((key) => actualRanks.has(key)).length;
  const correlation = spearmanCorrelation(projectionRanks, actualRanks);

  return {
    matchedAssetCount,
    spearmanCorrelation: correlation == null ? null : round(correlation, 3),
    label:
      correlation == null
        ? 'Not enough matching projection assets'
        : correlation >= 0.7
          ? 'Strong alignment'
          : correlation >= 0.5
            ? 'Useful alignment'
            : correlation >= 0.3
              ? 'Moderate alignment'
              : 'Weak alignment',
  };
}

function buildFindings(input: {
  positionSummaries: HistoricalCalibrationPositionSummary[];
  modeledGoalieSharePercent: number;
  goalieCapHitPercent: number;
  exceptionalForwardWindowPercent: number;
  draftComparison: HistoricalCalibrationDraftComparison;
  totalWindowCount: number;
}): HistoricalCalibrationFinding[] {
  const findings: HistoricalCalibrationFinding[] = [];
  const forwardVolatility = average(
    input.positionSummaries
      .filter((summary) => ['LW', 'C', 'RW'].includes(summary.position))
      .map((summary) => summary.medianAssetVolatility),
  );
  const defenseVolatility =
    input.positionSummaries.find((summary) => summary.position === 'D')
      ?.medianAssetVolatility ?? 0;

  findings.push({
    level:
      input.modeledGoalieSharePercent >= 8 && input.modeledGoalieSharePercent <= 18
        ? 'good'
        : 'watch',
    title: 'Goalie-unit share',
    detail: `A modeled starting lineup receives ${round(input.modeledGoalieSharePercent)}% of its points from the one goalie-unit slot.`,
  });

  findings.push({
    level: 'good',
    title: 'Legacy goalie-cap removal',
    detail: input.goalieCapHitPercent === 0
      ? 'The recorded season did not contain a team-goalie game that would have crossed the legacy V3 maximum.'
      : `Legacy Scoring V3 would have clipped ${round(input.goalieCapHitPercent, 2)}% of recorded team-goalie games. Production V4 preserves those exceptional totals.`,
  });

  findings.push({
    level: defenseVolatility <= forwardVolatility ? 'good' : 'watch',
    title: 'Position identity',
    detail: `Median asset volatility is ${round(defenseVolatility)} for defense and ${round(forwardVolatility)} across forward positions.`,
  });

  findings.push({
    level:
      input.exceptionalForwardWindowPercent >= 1 && input.exceptionalForwardWindowPercent <= 12
        ? 'good'
        : 'watch',
    title: 'Exceptional forward windows',
    detail: `${round(input.exceptionalForwardWindowPercent, 2)}% of forward six-game windows reached ${EXCEPTIONAL_FORWARD_THRESHOLD} points or more.`,
  });

  if (input.draftComparison.spearmanCorrelation != null) {
    findings.push({
      level:
        input.draftComparison.spearmanCorrelation >= 0.5
          ? 'good'
          : input.draftComparison.spearmanCorrelation >= 0.3
            ? 'watch'
            : 'review',
      title: 'Draft ranking vs historical outcomes',
      detail: `${input.draftComparison.matchedAssetCount} matched assets produced a Spearman correlation of ${input.draftComparison.spearmanCorrelation}.`,
    });
  }

  if (input.totalWindowCount < 500) {
    findings.push({
      level: 'review',
      title: 'Sample size',
      detail: `Only ${input.totalWindowCount} complete six-game windows were available. Avoid changing production scoring from this sample alone.`,
    });
  }

  return findings;
}

function getRecommendation(
  findings: HistoricalCalibrationFinding[],
  totalWindowCount: number,
): HistoricalCalibrationReport['recommendation'] {
  if (totalWindowCount < 500) {
    return 'insufficient-data';
  }

  return findings.some((finding) => finding.level === 'review')
    ? 'review-before-changing'
    : 'keep-current-rules';
}

export async function runHistoricalScoringCalibration(
  options: HistoricalCalibrationRunOptions,
): Promise<HistoricalCalibrationReport> {
  const season = options.season.trim();
  const leagueTeamCount = clamp(Math.floor(options.leagueTeamCount), 2, 32);
  const requiredGamesPerMatchup = clamp(
    Math.floor(options.requiredGamesPerMatchup ?? defaultScoringRules.requiredGamesPerCycle),
    1,
    10,
  );

  if (!/^\d{8}$/.test(season)) {
    throw new Error('Enter the NHL season as eight digits, such as 20252026.');
  }

  assertNotAborted(options.signal);
  const schedulesPromise = loadAllTeamSchedules(
    season,
    options.signal,
    options.onProgress,
  );

  options.onProgress?.({
    stage: 'loading-skater-stats',
    completed: 0,
    total: 2,
    message: 'Loading full-season skater game statistics.',
  });
  const skaterStatsPromise = Promise.all([
    getSkaterGameSummaryStats(season),
    getSkaterGameRealtimeStats(season),
  ]);

  options.onProgress?.({
    stage: 'loading-goalie-stats',
    completed: 0,
    total: 1,
    message: 'Loading full-season goalie game statistics.',
  });
  const goalieStatsPromise = getGoalieGameSummaryStats(season);
  const [schedules, [skaterSummary, skaterRealtime], goalieRecords] = await Promise.all([
    schedulesPromise,
    skaterStatsPromise,
    goalieStatsPromise,
  ]);

  assertNotAborted(options.signal);
  options.onProgress?.({
    stage: 'loading-skater-stats',
    completed: 2,
    total: 2,
    message: 'Full-season skater summary and realtime game statistics are ready.',
  });
  options.onProgress?.({
    stage: 'loading-goalie-stats',
    completed: 1,
    total: 1,
    message: 'Full-season goalie game statistics are ready.',
  });

  const skaterGames = mergeSkaterRecords(skaterSummary, skaterRealtime);
  const goalieGames = mergeGoalieRecords(goalieRecords);
  const uniqueScheduleGameIds = [...new Set(
    [...schedules.values()].flatMap((schedule) => schedule.map((game) => game.id)),
  )].sort((first, second) => first - second);
  const exactAssistCache = options.useExactAssists
    ? await loadExactAssistCacheForGames({
        season,
        gameIds: uniqueScheduleGameIds,
        signal: options.signal,
        onProgress: options.onProgress,
      })
    : null;
  const exactAssistGames = exactAssistCache
    ? uniqueScheduleGameIds.filter((gameId) => exactAssistCache.games[String(gameId)]).length
    : 0;
  const assistMode: CalibrationAssistMode = !options.useExactAssists
    ? 'estimated'
    : exactAssistGames >= uniqueScheduleGameIds.length
      ? 'exact'
      : 'hybrid';
  const candidates = createCandidateRuleSets();
  const { windows, goalieCapHitCount, goalieGameCount } = buildCalibrationWindows({
    skaterGames,
    goalieGames,
    schedules,
    exactAssistCache,
    candidates,
    requiredGamesPerMatchup,
    signal: options.signal,
    onProgress: options.onProgress,
  });

  assertNotAborted(options.signal);
  options.onProgress?.({
    stage: 'summarizing',
    completed: 0,
    total: 1,
    message: 'Summarizing distributions, replacement values, and candidate rules.',
  });
  const assetSummaries = buildAssetSummaries(windows, candidates);
  const positionSummaries = POSITIONS.map((position) =>
    getPositionSummary({
      position,
      windows,
      assetSummaries,
      leagueTeamCount,
    }),
  );
  const modeledGoalieSharePercent = getModeledGoalieShare(
    assetSummaries,
    leagueTeamCount,
    'current-v4',
  );
  const forwardWindows = windows.filter((window) =>
    ['LW', 'C', 'RW'].includes(window.position),
  );
  const exceptionalForwardWindowCount = forwardWindows.filter(
    (window) => window.pointsByCandidate['current-v4'] >= EXCEPTIONAL_FORWARD_THRESHOLD,
  ).length;
  const exceptionalForwardWindowPercent = forwardWindows.length > 0
    ? (exceptionalForwardWindowCount / forwardWindows.length) * 100
    : 0;
  const draftComparison = buildDraftComparison(
    assetSummaries,
    options.projectionAssets ?? [],
  );
  const goalieCapHitPercent = goalieGameCount > 0
    ? (goalieCapHitCount / goalieGameCount) * 100
    : 0;
  const findings = buildFindings({
    positionSummaries,
    modeledGoalieSharePercent,
    goalieCapHitPercent,
    exceptionalForwardWindowPercent,
    draftComparison,
    totalWindowCount: windows.length,
  });
  const report: HistoricalCalibrationReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    season,
    scoringRulesVersion: CURRENT_SCORING_RULES_VERSION,
    requiredGamesPerMatchup,
    leagueTeamCount,
    assistMode,
    exactAssistGames,
    totalScheduleGames: uniqueScheduleGameIds.length,
    assistMethodNote:
      assistMode === 'exact'
        ? 'Primary and secondary assists were read from NHL play-by-play for every schedule game.'
        : assistMode === 'hybrid'
          ? 'Cached NHL play-by-play was used where available; remaining games used a deterministic 40/60 integer assist estimate.'
          : 'The fast report uses a deterministic 40/60 integer estimate for primary and secondary assists. Exact mode can enrich every game from play-by-play.',
    productionRulesChanged: false,
    skaterAssetCount: assetSummaries.filter((asset) => asset.position !== 'G').length,
    goalieUnitCount: assetSummaries.filter((asset) => asset.position === 'G').length,
    totalWindowCount: windows.length,
    positionSummaries,
    candidateSummaries: buildCandidateSummaries({
      windows,
      assetSummaries,
      candidates,
      leagueTeamCount,
      goalieGames,
    }),
    modeledGoalieSharePercent: round(modeledGoalieSharePercent),
    goalieCapHitCount,
    goalieGameCount,
    goalieCapHitPercent: round(goalieCapHitPercent, 2),
    exceptionalForwardWindowCount,
    forwardWindowCount: forwardWindows.length,
    exceptionalForwardWindowPercent: round(exceptionalForwardWindowPercent, 2),
    exceptionalForwardThreshold: EXCEPTIONAL_FORWARD_THRESHOLD,
    defenseVsComparableForwardGap: getDefenseVsComparableForwardGap(assetSummaries),
    draftComparison,
    findings,
    recommendation: getRecommendation(findings, windows.length),
    methodologyNotes: [
      'Every asset window is based on six scheduled NHL team games. A scheduled game in which a skater did not appear counts as zero, matching RinkRat roster-slot behavior.',
      'Traded skaters follow a team-schedule timeline inferred from team changes in their NHL game logs.',
      'Only complete six-game blocks are included; a final partial block is excluded from distribution comparisons.',
      'Goalie rows are combined by NHL team and game so the report measures the RinkRat team-goalie unit rather than one individual goaltender.',
      'Starter and replacement values use the selected league size and RinkRat active roster requirements.',
      'Candidate rule sets are calculated in memory for comparison only. The report never writes Firestore scoring rules or changes production scoring.',
    ],
  };

  options.onProgress?.({
    stage: 'complete',
    completed: 1,
    total: 1,
    message: `Historical calibration completed with ${windows.length} full six-game windows.`,
  });

  return report;
}
