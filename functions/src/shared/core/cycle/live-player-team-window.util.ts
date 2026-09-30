import type { DraftableAsset } from '../draft/draft.models';
import type { NhlTeamSeasonGame } from '../nhl/nhl-api.service';
import {
  selectCycleWindowGames,
  selectGamesByStableIds,
} from './cycle-window-selection.util';

export interface PreviousLivePlayerWindowSummary {
  status?: 'scheduled' | 'active' | 'complete';
  scheduledGameIds?: number[];
  completedGameIds?: number[];
  appearanceGameIds?: number[];
  scheduleTeamAbbreviation?: string;
  sourceTeamAbbreviationByGameId?: Record<string, string>;
}

export interface ResolvedLivePlayerWindow {
  games: NhlTeamSeasonGame[];
  scheduleTeamAbbreviation: string;
  sourceTeamAbbreviationByGameId: Record<string, string>;
  teamIdentityChanged: boolean;
}

function normalizeTeamAbbreviation(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{2,4}$/.test(normalized) ? normalized : '';
}

function getAssetTeamAbbreviation(asset: DraftableAsset): string {
  return normalizeTeamAbbreviation(
    asset.assetType === 'skater'
      ? asset.player.nhlTeamAbbreviation
      : asset.teamAbbreviation,
  );
}

function gameIsFinal(game: NhlTeamSeasonGame): boolean {
  const state = (game.gameState ?? '').trim().toUpperCase();

  if (state === 'OFF' || state === 'FINAL') {
    return true;
  }

  return Boolean(
    !state &&
    typeof game.homeTeam.score === 'number' &&
    typeof game.awayTeam.score === 'number',
  );
}

function gameOrder(
  first: NhlTeamSeasonGame,
  second: NhlTeamSeasonGame,
): number {
  const firstStart = Date.parse(
    first.startTimeUTC ?? `${first.gameDate}T12:00:00Z`,
  );
  const secondStart = Date.parse(
    second.startTimeUTC ?? `${second.gameDate}T12:00:00Z`,
  );

  if (Number.isFinite(firstStart) && Number.isFinite(secondStart)) {
    return firstStart - secondStart || first.id - second.id;
  }

  return first.gameDate.localeCompare(second.gameDate) || first.id - second.id;
}

function schedulesHaveTeam(
  schedulesByTeam: Record<string, NhlTeamSeasonGame[]>,
  teamAbbreviation: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(
    schedulesByTeam,
    teamAbbreviation,
  );
}

function gameLookup(
  schedulesByTeam: Record<string, NhlTeamSeasonGame[]>,
): Map<number, { game: NhlTeamSeasonGame; teamAbbreviation: string }> {
  const byGameId = new Map<
    number,
    { game: NhlTeamSeasonGame; teamAbbreviation: string }
  >();

  for (const [teamAbbreviation, games] of Object.entries(schedulesByTeam)) {
    for (const game of games) {
      if (!byGameId.has(game.id)) {
        byGameId.set(game.id, { game, teamAbbreviation });
      }
    }
  }

  return byGameId;
}

function resolvePreviousGames(input: {
  previous: PreviousLivePlayerWindowSummary;
  schedulesByTeam: Record<string, NhlTeamSeasonGame[]>;
  fallbackTeamAbbreviation: string;
}): {
  games: NhlTeamSeasonGame[];
  sourceTeamAbbreviationByGameId: Record<string, string>;
} {
  const lookup = gameLookup(input.schedulesByTeam);
  const games: NhlTeamSeasonGame[] = [];
  const sourceTeamAbbreviationByGameId: Record<string, string> = {};

  for (const gameId of input.previous.scheduledGameIds ?? []) {
    const resolved = lookup.get(gameId);

    if (!resolved) {
      throw new Error(
        `The saved six-game window references NHL game ${gameId}, but its team schedule is unavailable.`,
      );
    }

    games.push(resolved.game);
    sourceTeamAbbreviationByGameId[String(gameId)] =
      normalizeTeamAbbreviation(
        input.previous.sourceTeamAbbreviationByGameId?.[String(gameId)],
      ) || input.fallbackTeamAbbreviation;
  }

  return { games, sourceTeamAbbreviationByGameId };
}

function buildSourceTeamMap(
  games: NhlTeamSeasonGame[],
  teamAbbreviation: string,
): Record<string, string> {
  return Object.fromEntries(
    games.map((game) => [String(game.id), teamAbbreviation]),
  );
}

/**
 * Keeps a live skater's six-game ownership attached to stable player identity.
 * Finalized games and games where the skater already appeared never move.
 * When the official NHL roster changes, only the unsettled remainder is filled
 * from live/upcoming games for the new club and then remains fixed on retries.
 */
export function resolveLivePlayerTeamWindow(input: {
  asset: DraftableAsset;
  schedulesByTeam: Record<string, NhlTeamSeasonGame[]>;
  cycleNumber: number;
  requiredGamesPerCycle: number;
  previous?: PreviousLivePlayerWindowSummary;
  currentTeamAbbreviation?: string;
  /** Exact game ids frozen for the currently resolved NHL club. */
  sourceNhlTargetGameIds?: number[];
}): ResolvedLivePlayerWindow {
  const storedTeamAbbreviation = getAssetTeamAbbreviation(input.asset);
  const currentTeamAbbreviation = input.asset.assetType === 'skater'
    ? normalizeTeamAbbreviation(input.currentTeamAbbreviation) ||
      storedTeamAbbreviation
    : storedTeamAbbreviation;
  const previousScheduleTeamAbbreviation = normalizeTeamAbbreviation(
    input.previous?.scheduleTeamAbbreviation,
  ) || storedTeamAbbreviation;

  if (
    input.previous?.scheduledGameIds?.length &&
    (
      input.previous.status === 'complete' ||
      previousScheduleTeamAbbreviation === currentTeamAbbreviation
    )
  ) {
    const previousWindow = resolvePreviousGames({
      previous: input.previous,
      schedulesByTeam: input.schedulesByTeam,
      fallbackTeamAbbreviation: previousScheduleTeamAbbreviation,
    });

    return {
      ...previousWindow,
      scheduleTeamAbbreviation: previousScheduleTeamAbbreviation,
      teamIdentityChanged:
        previousScheduleTeamAbbreviation !== storedTeamAbbreviation,
    };
  }

  if (currentTeamAbbreviation === previousScheduleTeamAbbreviation) {
    if (!schedulesHaveTeam(input.schedulesByTeam, currentTeamAbbreviation)) {
      throw new Error(
        `The NHL schedule for ${currentTeamAbbreviation} is unavailable.`,
      );
    }

    const games = input.sourceNhlTargetGameIds?.length
      ? selectGamesByStableIds(
          input.schedulesByTeam[currentTeamAbbreviation],
          input.sourceNhlTargetGameIds,
        )
      : selectCycleWindowGames(
          input.schedulesByTeam[currentTeamAbbreviation],
          input.cycleNumber,
          input.requiredGamesPerCycle,
        );

    return {
      games,
      scheduleTeamAbbreviation: currentTeamAbbreviation,
      sourceTeamAbbreviationByGameId: buildSourceTeamMap(
        games,
        currentTeamAbbreviation,
      ),
      teamIdentityChanged:
        currentTeamAbbreviation !== storedTeamAbbreviation,
    };
  }

  if (!schedulesHaveTeam(input.schedulesByTeam, currentTeamAbbreviation)) {
    throw new Error(
      `The NHL schedule for traded skater ${input.asset.assetKey} on ${currentTeamAbbreviation} is unavailable.`,
    );
  }

  const previousWindow = input.previous?.scheduledGameIds?.length
    ? resolvePreviousGames({
        previous: input.previous,
        schedulesByTeam: input.schedulesByTeam,
        fallbackTeamAbbreviation: previousScheduleTeamAbbreviation,
      })
    : {
        games: [] as NhlTeamSeasonGame[],
        sourceTeamAbbreviationByGameId: {} as Record<string, string>,
      };
  const protectedGameIds = new Set([
    ...(input.previous?.completedGameIds ?? []),
    ...(input.previous?.appearanceGameIds ?? []),
  ]);
  const protectedGames = previousWindow.games.filter((game) =>
    protectedGameIds.has(game.id)
  );
  const protectedSourceTeams = Object.fromEntries(
    protectedGames.map((game) => [
      String(game.id),
      previousWindow.sourceTeamAbbreviationByGameId[String(game.id)] ||
        previousScheduleTeamAbbreviation,
    ]),
  );
  const remainingGameCount = Math.max(
    0,
    input.requiredGamesPerCycle - protectedGames.length,
  );
  const replacementGames = (
    previousWindow.games.length === 0 && input.sourceNhlTargetGameIds?.length
      ? selectGamesByStableIds(
          input.schedulesByTeam[currentTeamAbbreviation],
          input.sourceNhlTargetGameIds,
        )
      : [...input.schedulesByTeam[currentTeamAbbreviation]]
          .filter((game) => !protectedGameIds.has(game.id) && !gameIsFinal(game))
          .sort(gameOrder)
  )
    .filter((game) => !protectedGameIds.has(game.id))
    .slice(0, remainingGameCount);
  const games = [...protectedGames, ...replacementGames];

  return {
    games,
    scheduleTeamAbbreviation: currentTeamAbbreviation,
    sourceTeamAbbreviationByGameId: {
      ...protectedSourceTeams,
      ...buildSourceTeamMap(replacementGames, currentTeamAbbreviation),
    },
    teamIdentityChanged: true,
  };
}
