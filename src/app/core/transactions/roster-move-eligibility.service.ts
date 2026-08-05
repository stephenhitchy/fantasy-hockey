import {
  getNhlTeamSeasonSchedule,
  type NhlTeamSeasonGame,
} from '../nhl/nhl-api.service';
import {
  calculateRosterMoveAssetCycleEligibility,
  getNhlSeasonForDate,
  getRosterMoveAssetTeamAbbreviation,
  isRosterMoveRegularSeasonGame,
  type RosterMoveAssetCycleEligibility,
  type RosterMoveEligibilityOptions,
} from './roster-move-eligibility.util';
import type { DraftableAsset } from '../draft/draft.models';

export * from './roster-move-eligibility.util';

interface CachedSchedule {
  expiresAt: number;
  schedule: NhlTeamSeasonGame[];
}

const SCHEDULE_CACHE_MS = 5 * 60 * 1000;
const scheduleCache = new Map<string, CachedSchedule>();

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
    .filter(isRosterMoveRegularSeasonGame)
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

export async function resolveRosterMoveAssetCycleEligibility(
  asset: DraftableAsset,
  requiredGamesPerCycle: number,
  options: RosterMoveEligibilityOptions = {},
): Promise<RosterMoveAssetCycleEligibility> {
  const referenceDate = options.referenceDate ?? new Date();
  const season = options.seasonOverride?.trim() || getNhlSeasonForDate(referenceDate);
  const completedThroughDate = options.completedThroughDate?.trim() || null;
  const teamAbbreviation = getRosterMoveAssetTeamAbbreviation(asset);

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
    completedThroughDate,
  );
}
