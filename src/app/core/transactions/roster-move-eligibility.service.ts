import { DraftableAsset } from '../draft/draft.models';
import { getNhlTeamSeasonSchedule, NhlTeamSeasonGame } from '../nhl/nhl-api.service';

export interface RosterMoveAssetCycleEligibility {
  assetKey: string;
  teamAbbreviation: string;
  season: string;
  requiredGamesPerCycle: number;
  currentCycleNumber: number;
  completedGamesInCurrentCycle: number;
  liveGamesInCurrentCycle: number;
  scheduledGamesInCurrentCycle: number;
  currentCycleHasStarted: boolean;
  currentCycleIsComplete: boolean;
  earliestEligibleCycleNumber: number;
  checkedAt: string;
}

interface CachedSchedule {
  expiresAt: number;
  schedule: NhlTeamSeasonGame[];
}

const SCHEDULE_CACHE_MS = 5 * 60 * 1000;
const scheduleCache = new Map<string, CachedSchedule>();

function getAssetTeamAbbreviation(asset: DraftableAsset): string {
  return asset.assetType === 'skater' ? asset.player.nhlTeamAbbreviation : asset.teamAbbreviation;
}

function isRegularSeasonGame(game: NhlTeamSeasonGame): boolean {
  return typeof game.gameType !== 'number' || game.gameType === 2;
}

function getGameState(game: NhlTeamSeasonGame): 'scheduled' | 'live' | 'final' {
  const state = (game.gameState ?? '').toUpperCase();

  if (state === 'OFF' || state === 'FINAL') {
    return 'final';
  }

  if (state === 'LIVE' || state === 'CRIT') {
    return 'live';
  }

  if (
    !state &&
    typeof game.homeTeam.score === 'number' &&
    typeof game.awayTeam.score === 'number'
  ) {
    return 'final';
  }

  return 'scheduled';
}

export function getNhlSeasonForDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startYear = month >= 7 ? year : year - 1;

  return `${startYear}${startYear + 1}`;
}

async function loadSchedule(
  teamAbbreviation: string,
  season: string,
  forceRefresh: boolean,
): Promise<NhlTeamSeasonGame[]> {
  const cacheKey = `${teamAbbreviation}::${season}`;
  const cached = scheduleCache.get(cacheKey);

  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.schedule;
  }

  const schedule = (await getNhlTeamSeasonSchedule(teamAbbreviation, season))
    .filter(isRegularSeasonGame)
    .sort((first, second) => {
      const dateCompare = first.gameDate.localeCompare(second.gameDate);

      return dateCompare !== 0 ? dateCompare : first.id - second.id;
    });

  scheduleCache.set(cacheKey, {
    expiresAt: Date.now() + SCHEDULE_CACHE_MS,
    schedule,
  });

  return schedule;
}

export function calculateRosterMoveAssetCycleEligibility(
  asset: DraftableAsset,
  schedule: NhlTeamSeasonGame[],
  requiredGamesPerCycle: number,
  season: string,
  checkedAt = new Date(),
): RosterMoveAssetCycleEligibility {
  const normalizedGamesPerCycle = Math.max(1, Math.floor(requiredGamesPerCycle));
  const teamAbbreviation = getAssetTeamAbbreviation(asset);
  const regularSeasonSchedule = schedule.filter(isRegularSeasonGame).sort((first, second) => {
    const dateCompare = first.gameDate.localeCompare(second.gameDate);

    return dateCompare !== 0 ? dateCompare : first.id - second.id;
  });
  const totalCycleCount = Math.max(
    1,
    Math.ceil(regularSeasonSchedule.length / normalizedGamesPerCycle),
  );
  let currentCycleNumber = totalCycleCount;
  let currentCycleGames = regularSeasonSchedule.slice(
    (totalCycleCount - 1) * normalizedGamesPerCycle,
    totalCycleCount * normalizedGamesPerCycle,
  );

  for (let cycleIndex = 0; cycleIndex < totalCycleCount; cycleIndex += 1) {
    const cycleGames = regularSeasonSchedule.slice(
      cycleIndex * normalizedGamesPerCycle,
      (cycleIndex + 1) * normalizedGamesPerCycle,
    );
    const cycleIsComplete =
      cycleGames.length > 0 && cycleGames.every((game) => getGameState(game) === 'final');

    if (!cycleIsComplete) {
      currentCycleNumber = cycleIndex + 1;
      currentCycleGames = cycleGames;
      break;
    }

    if (cycleIndex === totalCycleCount - 1) {
      currentCycleNumber = cycleIndex + 2;
      currentCycleGames = [];
    }
  }

  const completedGamesInCurrentCycle = currentCycleGames.filter(
    (game) => getGameState(game) === 'final',
  ).length;
  const liveGamesInCurrentCycle = currentCycleGames.filter(
    (game) => getGameState(game) === 'live',
  ).length;
  const currentCycleHasStarted = completedGamesInCurrentCycle > 0 || liveGamesInCurrentCycle > 0;
  const currentCycleIsComplete =
    currentCycleGames.length > 0 && completedGamesInCurrentCycle === currentCycleGames.length;

  return {
    assetKey: asset.assetKey,
    teamAbbreviation,
    season,
    requiredGamesPerCycle: normalizedGamesPerCycle,
    currentCycleNumber,
    completedGamesInCurrentCycle,
    liveGamesInCurrentCycle,
    scheduledGamesInCurrentCycle: currentCycleGames.length || normalizedGamesPerCycle,
    currentCycleHasStarted,
    currentCycleIsComplete,
    earliestEligibleCycleNumber: currentCycleHasStarted
      ? currentCycleNumber + 1
      : currentCycleNumber,
    checkedAt: checkedAt.toISOString(),
  };
}

export async function resolveRosterMoveAssetCycleEligibility(
  asset: DraftableAsset,
  requiredGamesPerCycle: number,
  options: {
    forceRefresh?: boolean;
    referenceDate?: Date;
  } = {},
): Promise<RosterMoveAssetCycleEligibility> {
  const referenceDate = options.referenceDate ?? new Date();
  const season = getNhlSeasonForDate(referenceDate);
  const teamAbbreviation = getAssetTeamAbbreviation(asset);

  if (!teamAbbreviation) {
    throw new Error('The selected player does not have an NHL team schedule.');
  }

  const schedule = await loadSchedule(teamAbbreviation, season, Boolean(options.forceRefresh));

  if (schedule.length === 0) {
    throw new Error(`No regular-season schedule was found for ${teamAbbreviation}.`);
  }

  return calculateRosterMoveAssetCycleEligibility(
    asset,
    schedule,
    requiredGamesPerCycle,
    season,
    referenceDate,
  );
}
