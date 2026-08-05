import type { DraftableAsset } from '../draft/draft.models';
import type { NhlTeamSeasonGame } from '../nhl/nhl-api.service';

export type RosterMoveEligibilityGameState = 'scheduled' | 'live' | 'final';
export type RosterMoveEligibilityEvaluationMode = 'live' | 'historical-replay';

export interface RosterMoveEligibilityGame {
  gameId: number;
  gameDate: string;
  opponentAbbreviation: string;
  venue: 'home' | 'away';
  state: RosterMoveEligibilityGameState;
}

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
  currentCycleGames: RosterMoveEligibilityGame[];
  gamesByCycleNumber: Record<number, RosterMoveEligibilityGame[]>;
  earliestEligibleCycleNumber: number;
  evaluationMode: RosterMoveEligibilityEvaluationMode;
  completedThroughDate: string | null;
  checkedAt: string;
}

export interface RosterMoveEligibilityOptions {
  forceRefresh?: boolean;
  referenceDate?: Date;
  seasonOverride?: string;
  completedThroughDate?: string | null;
}

export function getRosterMoveAssetTeamAbbreviation(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.nhlTeamAbbreviation
    : asset.teamAbbreviation;
}

export function isRosterMoveRegularSeasonGame(game: NhlTeamSeasonGame): boolean {
  return typeof game.gameType !== 'number' || game.gameType === 2;
}

function getGameState(
  game: NhlTeamSeasonGame,
  completedThroughDate: string | null = null,
): RosterMoveEligibilityGameState {
  if (completedThroughDate) {
    return game.gameDate <= completedThroughDate ? 'final' : 'scheduled';
  }

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

function toEligibilityGame(
  game: NhlTeamSeasonGame,
  teamAbbreviation: string,
  completedThroughDate: string | null,
): RosterMoveEligibilityGame {
  const isHome = game.homeTeam.abbrev === teamAbbreviation;

  return {
    gameId: game.id,
    gameDate: game.gameDate,
    opponentAbbreviation: isHome ? game.awayTeam.abbrev : game.homeTeam.abbrev,
    venue: isHome ? 'home' : 'away',
    state: getGameState(game, completedThroughDate),
  };
}

export function getNhlSeasonForDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startYear = month >= 7 ? year : year - 1;

  return `${startYear}${startYear + 1}`;
}

export function calculateRosterMoveAssetCycleEligibility(
  asset: DraftableAsset,
  schedule: NhlTeamSeasonGame[],
  requiredGamesPerCycle: number,
  season: string,
  checkedAt = new Date(),
  completedThroughDate: string | null = null,
): RosterMoveAssetCycleEligibility {
  const normalizedGamesPerCycle = Math.max(1, Math.floor(requiredGamesPerCycle));
  const teamAbbreviation = getRosterMoveAssetTeamAbbreviation(asset);
  const regularSeasonSchedule = schedule
    .filter(isRosterMoveRegularSeasonGame)
    .sort((first, second) => {
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

  const gamesByCycleNumber: Record<number, RosterMoveEligibilityGame[]> = {};

  for (let cycleIndex = 0; cycleIndex < totalCycleCount; cycleIndex += 1) {
    gamesByCycleNumber[cycleIndex + 1] = regularSeasonSchedule
      .slice(
        cycleIndex * normalizedGamesPerCycle,
        (cycleIndex + 1) * normalizedGamesPerCycle,
      )
      .map((game) => toEligibilityGame(game, teamAbbreviation, completedThroughDate));
  }

  for (let cycleIndex = 0; cycleIndex < totalCycleCount; cycleIndex += 1) {
    const cycleGames = regularSeasonSchedule.slice(
      cycleIndex * normalizedGamesPerCycle,
      (cycleIndex + 1) * normalizedGamesPerCycle,
    );
    const cycleIsComplete =
      cycleGames.length > 0 &&
      cycleGames.every((game) => getGameState(game, completedThroughDate) === 'final');

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
    (game) => getGameState(game, completedThroughDate) === 'final',
  ).length;
  const liveGamesInCurrentCycle = currentCycleGames.filter(
    (game) => getGameState(game, completedThroughDate) === 'live',
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
    currentCycleGames: gamesByCycleNumber[currentCycleNumber] ?? [],
    gamesByCycleNumber,
    earliestEligibleCycleNumber: currentCycleHasStarted
      ? currentCycleNumber + 1
      : currentCycleNumber,
    evaluationMode: completedThroughDate ? 'historical-replay' : 'live',
    completedThroughDate,
    checkedAt: checkedAt.toISOString(),
  };
}
