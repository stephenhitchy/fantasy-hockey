import type { DraftableAsset } from '../draft/draft.models';
import type { NhlTeamSeasonGame } from '../nhl/nhl-api.service';
import {
  getCycleGameStartIndex,
  selectCycleWindowGames,
  selectGamesByStableIds,
} from './cycle-window-selection.util';

export interface PreviousLivePlayerWindowSummary {
  status?: 'scheduled' | 'active' | 'complete';
  scheduledGameIds?: number[];
  completedGameIds?: number[];
  incompleteFinalGameIds?: number[];
  liveGameIds?: number[];
  startedGameIds?: number[];
  appearanceGameIds?: number[];
  gameStates?: Record<string, 'scheduled' | 'live' | 'final'>;
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

function gameHasStarted(game: NhlTeamSeasonGame): boolean {
  const state = (game.gameState ?? '').trim().toUpperCase();
  return gameIsFinal(game) || state === 'LIVE' || state === 'CRIT';
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

function normalizeGameIdSet(
  values: readonly number[] | undefined,
  label: string,
): Set<number> {
  const gameIds = values ?? [];

  if (
    gameIds.some((gameId) => !Number.isSafeInteger(gameId) || gameId <= 0) ||
    new Set(gameIds).size !== gameIds.length
  ) {
    throw new Error(`${label} contains malformed or duplicate NHL game ids.`);
  }

  return new Set(gameIds);
}

function assertExactWindow(input: {
  assetKey: string;
  games: NhlTeamSeasonGame[];
  priorAssignedGameIds: ReadonlySet<number>;
  requiredGamesPerCycle: number;
}): void {
  const gameIds = input.games.map((game) => game.id);

  if (
    gameIds.length !== input.requiredGamesPerCycle ||
    new Set(gameIds).size !== gameIds.length
  ) {
    throw new Error(
      `Unable to resolve an exact ${input.requiredGamesPerCycle}-game NHL window for ` +
        `${input.assetKey}. Resolved ${gameIds.length} unique game(s).`,
    );
  }

  const repeatedGameIds = gameIds.filter((gameId) =>
    input.priorAssignedGameIds.has(gameId)
  );

  if (repeatedGameIds.length > 0) {
    throw new Error(
      `The NHL window for ${input.assetKey} repeats previously assigned game id(s): ` +
        `${repeatedGameIds.join(', ')}.`,
    );
  }
}

function getProtectedGameIds(
  previous: PreviousLivePlayerWindowSummary | undefined,
  previousGames: NhlTeamSeasonGame[],
): Set<number> {
  const protectedGameIds = new Set<number>([
    ...(previous?.completedGameIds ?? []),
    ...(previous?.incompleteFinalGameIds ?? []),
    ...(previous?.liveGameIds ?? []),
    ...(previous?.startedGameIds ?? []),
    ...(previous?.appearanceGameIds ?? []),
  ]);

  for (const [gameId, state] of Object.entries(previous?.gameStates ?? {})) {
    const parsedGameId = Number(gameId);

    if (
      (state === 'live' || state === 'final') &&
      Number.isSafeInteger(parsedGameId) &&
      parsedGameId > 0
    ) {
      protectedGameIds.add(parsedGameId);
    }
  }

  for (const game of previousGames) {
    if (gameHasStarted(game)) {
      protectedGameIds.add(game.id);
    }
  }

  return protectedGameIds;
}

function sameGameIds(
  first: readonly number[],
  second: readonly number[],
): boolean {
  return first.length === second.length &&
    first.every((gameId, index) => gameId === second[index]);
}

/**
 * Returns the immutable source-plan suffix beginning at this window's block.
 * The existing exact block remains a separate input so mixed-version callers
 * can prove that both pieces of frozen evidence describe the same assignment.
 */
function selectFrozenContinuationGames(input: {
  schedule: NhlTeamSeasonGame[];
  sourceNhlGameIdPlan: readonly number[];
  sourceNhlTargetGameIds?: readonly number[];
  cycleNumber: number;
  requiredGamesPerCycle: number;
}): NhlTeamSeasonGame[] {
  const sourcePlanGameIds = [
    ...normalizeGameIdSet(
      input.sourceNhlGameIdPlan,
      'The frozen NHL source-game plan',
    ),
  ];
  const startIndex = getCycleGameStartIndex(
    input.cycleNumber,
    input.requiredGamesPerCycle,
  );
  const sourceBlockGameIds = sourcePlanGameIds.slice(
    startIndex,
    startIndex + input.requiredGamesPerCycle,
  );

  if (sourceBlockGameIds.length !== input.requiredGamesPerCycle) {
    throw new Error(
      `The frozen NHL source-game plan is incomplete for source block ${input.cycleNumber}.`,
    );
  }

  if (
    input.sourceNhlTargetGameIds?.length &&
    !sameGameIds(sourceBlockGameIds, input.sourceNhlTargetGameIds)
  ) {
    throw new Error(
      `The frozen NHL target ids do not match source block ${input.cycleNumber}.`,
    );
  }

  return selectGamesByStableIds(
    input.schedule,
    sourcePlanGameIds.slice(startIndex),
  );
}

function selectCandidateGames(input: {
  schedule: NhlTeamSeasonGame[];
  cycleNumber: number;
  requiredGamesPerCycle: number;
  sourceNhlTargetGameIds?: readonly number[];
  sourceNhlGameIdPlan?: readonly number[];
  legacySelection: 'block' | 'block-continuation' | 'unsettled-season';
}): NhlTeamSeasonGame[] {
  let games: NhlTeamSeasonGame[];

  if (input.sourceNhlGameIdPlan?.length) {
    games = selectFrozenContinuationGames({
      schedule: input.schedule,
      sourceNhlGameIdPlan: input.sourceNhlGameIdPlan,
      sourceNhlTargetGameIds: input.sourceNhlTargetGameIds,
      cycleNumber: input.cycleNumber,
      requiredGamesPerCycle: input.requiredGamesPerCycle,
    });
  } else if (input.sourceNhlTargetGameIds?.length) {
    games = selectGamesByStableIds(
      input.schedule,
      input.sourceNhlTargetGameIds,
    );
  } else if (input.legacySelection === 'unsettled-season') {
    // Legacy leagues do not have a frozen full-season plan. Preserve their
    // established deterministic fallback while still applying ownership and
    // exact-window validation below.
    games = [...input.schedule].sort(gameOrder);
  } else if (input.legacySelection === 'block-continuation') {
    games = [...input.schedule]
      .sort(gameOrder)
      .slice(getCycleGameStartIndex(
        input.cycleNumber,
        input.requiredGamesPerCycle,
      ));
  } else {
    games = selectCycleWindowGames(
      input.schedule,
      input.cycleNumber,
      input.requiredGamesPerCycle,
    );
  }

  return input.legacySelection === 'unsettled-season'
    ? games.filter((game) => !gameIsFinal(game))
    : games;
}

/**
 * Keeps a live skater's six-game ownership attached to stable player identity.
 * Started/finalized games and games where the skater already appeared never
 * move. When the official NHL roster changes, only the unsettled remainder is
 * filled from the new club. Frozen-plan callers can supply earlier ownership so
 * a continuation never repeats one NHL game across fantasy windows.
 */
export function resolveLivePlayerTeamWindow(input: {
  asset: DraftableAsset;
  schedulesByTeam: Record<string, NhlTeamSeasonGame[]>;
  cycleNumber: number;
  requiredGamesPerCycle: number;
  previous?: PreviousLivePlayerWindowSummary;
  currentTeamAbbreviation?: string;
  /** Exact game ids frozen for the currently resolved NHL club. */
  sourceNhlTargetGameIds?: readonly number[];
  /**
   * Complete ordered frozen plan for the resolved club. Anchored callers use
   * this suffix to continue safely after excluded games without trusting a
   * later provider reorder or crossing the plan's bounded capacity.
   */
  sourceNhlGameIdPlan?: readonly number[];
  /**
   * Game ids already owned by earlier windows for this stable player/slot
   * stint. The current window's own ids must not be included.
   */
  priorAssignedGameIds?: readonly number[];
}): ResolvedLivePlayerWindow {
  const storedTeamAbbreviation = getAssetTeamAbbreviation(input.asset);
  const currentTeamAbbreviation = input.asset.assetType === 'skater'
    ? normalizeTeamAbbreviation(input.currentTeamAbbreviation) ||
      storedTeamAbbreviation
    : storedTeamAbbreviation;
  const previousScheduleTeamAbbreviation = normalizeTeamAbbreviation(
    input.previous?.scheduleTeamAbbreviation,
  ) || storedTeamAbbreviation;
  const priorAssignedGameIds = normalizeGameIdSet(
    input.priorAssignedGameIds,
    'Prior player-window ownership',
  );
  const hasPreviousWindow = Boolean(
    input.previous?.scheduledGameIds?.length,
  );
  const previousWindow = hasPreviousWindow
    ? resolvePreviousGames({
        previous: input.previous!,
        schedulesByTeam: input.schedulesByTeam,
        fallbackTeamAbbreviation: previousScheduleTeamAbbreviation,
      })
    : {
        games: [] as NhlTeamSeasonGame[],
        sourceTeamAbbreviationByGameId: {} as Record<string, string>,
      };
  const protectedGameIds = getProtectedGameIds(
    input.previous,
    previousWindow.games,
  );
  const previousGameIds = new Set(previousWindow.games.map((game) => game.id));
  const unknownProtectedGameIds = [...protectedGameIds].filter(
    (gameId) => !previousGameIds.has(gameId),
  );

  if (unknownProtectedGameIds.length > 0) {
    throw new Error(
      `The saved window for ${input.asset.assetKey} protects game id(s) that it ` +
        `does not own: ${unknownProtectedGameIds.join(', ')}.`,
    );
  }

  const protectedPriorConflicts = previousWindow.games
    .filter((game) =>
      protectedGameIds.has(game.id) && priorAssignedGameIds.has(game.id)
    )
    .map((game) => game.id);

  if (protectedPriorConflicts.length > 0) {
    throw new Error(
      `The immutable NHL window for ${input.asset.assetKey} conflicts with ` +
        `earlier ownership for game id(s): ${protectedPriorConflicts.join(', ')}.`,
    );
  }

  const previousContainsPriorAssignment = previousWindow.games.some((game) =>
    priorAssignedGameIds.has(game.id)
  );

  if (
    hasPreviousWindow &&
    (
      input.previous?.status === 'complete' ||
      previousScheduleTeamAbbreviation === currentTeamAbbreviation
    ) &&
    !previousContainsPriorAssignment
  ) {
    assertExactWindow({
      assetKey: input.asset.assetKey,
      games: previousWindow.games,
      priorAssignedGameIds,
      requiredGamesPerCycle: input.requiredGamesPerCycle,
    });

    return {
      ...previousWindow,
      scheduleTeamAbbreviation: previousScheduleTeamAbbreviation,
      teamIdentityChanged:
        previousScheduleTeamAbbreviation !== storedTeamAbbreviation,
    };
  }

  if (input.previous?.status === 'complete') {
    throw new Error(
      `The completed NHL window for ${input.asset.assetKey} conflicts with ` +
        'earlier game ownership and cannot be rewritten.',
    );
  }

  if (!schedulesHaveTeam(input.schedulesByTeam, currentTeamAbbreviation)) {
    throw new Error(
      currentTeamAbbreviation === previousScheduleTeamAbbreviation
        ? `The NHL schedule for ${currentTeamAbbreviation} is unavailable.`
        : `The NHL schedule for traded skater ${input.asset.assetKey} on ` +
          `${currentTeamAbbreviation} is unavailable.`,
    );
  }

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
  const teamIdentityChanged =
    currentTeamAbbreviation !== previousScheduleTeamAbbreviation;
  const needsContinuation =
    teamIdentityChanged || previousContainsPriorAssignment;
  const hasFrozenSelection = Boolean(
    input.sourceNhlGameIdPlan?.length || input.sourceNhlTargetGameIds?.length,
  );
  const replacementGames = selectCandidateGames({
    schedule: input.schedulesByTeam[currentTeamAbbreviation],
    cycleNumber: input.cycleNumber,
    requiredGamesPerCycle: input.requiredGamesPerCycle,
    sourceNhlTargetGameIds: input.sourceNhlTargetGameIds,
    sourceNhlGameIdPlan: input.sourceNhlGameIdPlan,
    legacySelection: teamIdentityChanged &&
        (previousWindow.games.length > 0 || !hasFrozenSelection)
      ? 'unsettled-season'
      : needsContinuation
        ? 'block-continuation'
        : 'block',
  })
    .filter((game) =>
      !protectedGameIds.has(game.id) &&
      !priorAssignedGameIds.has(game.id)
    )
    .slice(0, remainingGameCount);
  const games = [...protectedGames, ...replacementGames];

  assertExactWindow({
    assetKey: input.asset.assetKey,
    games,
    priorAssignedGameIds,
    requiredGamesPerCycle: input.requiredGamesPerCycle,
  });

  return {
    games,
    scheduleTeamAbbreviation: currentTeamAbbreviation,
    sourceTeamAbbreviationByGameId: {
      ...protectedSourceTeams,
      ...buildSourceTeamMap(replacementGames, currentTeamAbbreviation),
    },
    teamIdentityChanged:
      currentTeamAbbreviation !== storedTeamAbbreviation,
  };
}
