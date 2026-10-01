import type { DraftableAsset } from '../draft/draft.models';
import type { NhlTeamSeasonGame } from '../nhl/nhl-api.service';
import {
  getNhlGameRuntimeState,
  hasNhlGameReachedStartSafetyBoundary,
} from '../nhl/nhl-game-runtime-state.util';
import {
  selectCycleWindowGames,
  selectGamesByStableIds,
} from './cycle-window-selection.util';

export interface PreviousLivePlayerWindowSummary {
  status?: 'scheduled' | 'active' | 'complete';
  scheduledGameIds?: number[];
  completedGameIds?: number[];
  liveGameIds?: number[];
  appearanceGameIds?: number[];
  incompleteFinalGameIds?: number[];
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

function gameStartMilliseconds(game: NhlTeamSeasonGame): number | null {
  if (typeof game.startTimeUTC !== 'string' || !game.startTimeUTC.trim()) {
    return null;
  }

  const parsed = Date.parse(game.startTimeUTC);
  return Number.isFinite(parsed) ? parsed : null;
}

function gameOrder(
  first: NhlTeamSeasonGame,
  second: NhlTeamSeasonGame,
): number {
  const firstStart = gameStartMilliseconds(first);
  const secondStart = gameStartMilliseconds(second);

  if (firstStart !== null && secondStart !== null) {
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

function requireExactUniqueWindow(input: {
  assetKey: string;
  currentTeamAbbreviation: string;
  cycleNumber: number;
  requiredGamesPerCycle: number;
  games: NhlTeamSeasonGame[];
}): NhlTeamSeasonGame[] {
  const uniqueGameIds = new Set(input.games.map((game) => game.id));

  if (
    input.games.length !== input.requiredGamesPerCycle ||
    uniqueGameIds.size !== input.requiredGamesPerCycle
  ) {
    throw new Error(
      `Unable to assign exactly ${input.requiredGamesPerCycle} unique NHL games ` +
        `for ${input.assetKey} on ${input.currentTeamAbbreviation} in source ` +
        `block ${input.cycleNumber}; resolved ${uniqueGameIds.size}.`,
    );
  }

  return input.games;
}

function resolveSeasonPlanGames(input: {
  schedule: NhlTeamSeasonGame[];
  seasonSourceGameIds?: readonly number[];
}): NhlTeamSeasonGame[] {
  if (input.seasonSourceGameIds !== undefined) {
    return selectGamesByStableIds(
      input.schedule,
      input.seasonSourceGameIds,
    );
  }

  // Legacy leagues predate the frozen full-season plan. Their provider
  // schedule remains the compatibility source, but sorting it here gives the
  // same deterministic cursor semantics as a frozen plan.
  return [...input.schedule].sort(gameOrder);
}

function selectPlanSuffixGames(input: {
  planGames: NhlTeamSeasonGame[];
  startIndex: number;
  count: number;
  excludedGameIds: ReadonlySet<number>;
  confirmedAppearanceGameIds: ReadonlySet<number>;
  requireFinalAppearanceEvidence: boolean;
  scheduleDecisionAtMilliseconds: number;
  hardNotBeforeMilliseconds?: number;
  teamIdentityNotBeforeMilliseconds?: number;
}): NhlTeamSeasonGame[] {
  const selected: NhlTeamSeasonGame[] = [];
  const selectedGameIds = new Set<number>();

  for (const game of input.planGames.slice(input.startIndex)) {
    if (
      input.excludedGameIds.has(game.id) ||
      selectedGameIds.has(game.id)
    ) {
      continue;
    }

    const startMilliseconds = gameStartMilliseconds(game);
    const runtimeState = getNhlGameRuntimeState(game);
    const requiresIdentityCutoverEvidence =
      input.requireFinalAppearanceEvidence ||
      input.hardNotBeforeMilliseconds !== undefined ||
      input.teamIdentityNotBeforeMilliseconds !== undefined;
    const reachedStartSafetyBoundary =
      hasNhlGameReachedStartSafetyBoundary({
        source: game,
        observedAtMilliseconds: input.scheduleDecisionAtMilliseconds,
      });

    if (
      requiresIdentityCutoverEvidence &&
      runtimeState === 'scheduled' &&
      reachedStartSafetyBoundary
    ) {
      throw new Error(
        `NHL game ${game.id} reached its scheduled start while the provider ` +
        `still reports ${game.gameState?.trim().toUpperCase() || 'an unrecognized state'}. ` +
        'Window publication cannot prove the player-team identity cutover and will retry.',
      );
    }

    if (
      requiresIdentityCutoverEvidence &&
      (runtimeState === 'live' || runtimeState === 'final') &&
      startMilliseconds === null
    ) {
      throw new Error(
        `NHL game ${game.id} is ${runtimeState}, but its exact startTimeUTC ` +
        'is unavailable. Window publication cannot prove the player-team ' +
        'identity cutover and will retry.',
      );
    }

    const beforeHardBoundary =
      input.hardNotBeforeMilliseconds !== undefined &&
      (
        startMilliseconds === null ||
        startMilliseconds < input.hardNotBeforeMilliseconds
      );
    const beforeTeamIdentityBoundary =
      input.teamIdentityNotBeforeMilliseconds !== undefined &&
      (
        startMilliseconds === null ||
        startMilliseconds < input.teamIdentityNotBeforeMilliseconds
      );
    const provenByBoundary = startMilliseconds !== null && (
      (
        input.hardNotBeforeMilliseconds !== undefined &&
        startMilliseconds >= input.hardNotBeforeMilliseconds
      ) ||
      (
        input.teamIdentityNotBeforeMilliseconds !== undefined &&
        startMilliseconds >= input.teamIdentityNotBeforeMilliseconds
      )
    );

    if (
      beforeTeamIdentityBoundary &&
      runtimeState === 'live'
    ) {
      throw new Error(
        `NHL game ${game.id} started before the player's current-team ` +
        'identity was confirmed. Window publication will retry after final appearance evidence is available.',
      );
    }

    if (
      beforeHardBoundary ||
      (
        beforeTeamIdentityBoundary &&
        !(
          gameIsFinal(game) &&
          input.confirmedAppearanceGameIds.has(game.id)
        )
      ) ||
      (
        input.requireFinalAppearanceEvidence &&
        gameIsFinal(game) &&
        !provenByBoundary &&
        !input.confirmedAppearanceGameIds.has(game.id)
      )
    ) {
      continue;
    }

    selected.push(game);
    selectedGameIds.add(game.id);

    if (selected.length === input.count) {
      break;
    }
  }

  return selected;
}

/**
 * Keeps a live skater's six-game ownership attached to stable player identity.
 * Started/finalized games and games where the skater already appeared never
 * move. When the official NHL roster changes, only the unsettled remainder is
 * filled from the new club's frozen season plan and then remains fixed on
 * retries. Prior assignment evidence carries any spillover into the next
 * window without repeating or skipping an eligible game.
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
  /** Full-season frozen game-id plan for the currently resolved NHL club. */
  seasonSourceGameIds?: readonly number[];
  /** Games already assigned earlier in this continuous skater/slot stint. */
  priorAssignedGameIds?: readonly number[] | ReadonlySet<number>;
  /** NHL club that owned the immediately preceding continuity assignment. */
  continuityScheduleTeamAbbreviation?: string;
  /** Final current-club games with stable-player-id appearance evidence. */
  confirmedCurrentTeamAppearanceGameIds?:
    | readonly number[]
    | ReadonlySet<number>;
  /** Fresh fantasy activations cannot own a game that already started. */
  assignmentNotBeforeMilliseconds?: number;
  /** Current-team confirmation is soft: prior finals need appearance proof. */
  teamIdentityNotBeforeMilliseconds?: number;
  /** Server time at which mutable schedule ownership is being decided. */
  scheduleDecisionAtMilliseconds: number;
}): ResolvedLivePlayerWindow {
  const storedTeamAbbreviation = getAssetTeamAbbreviation(input.asset);
  const currentTeamAbbreviation = input.asset.assetType === 'skater'
    ? normalizeTeamAbbreviation(input.currentTeamAbbreviation) ||
      storedTeamAbbreviation
    : storedTeamAbbreviation;
  const previousScheduleTeamAbbreviation = normalizeTeamAbbreviation(
    input.previous?.scheduleTeamAbbreviation,
  ) || storedTeamAbbreviation;
  const previousPublishedWindow = input.previous?.scheduledGameIds?.length
    ? input.previous
    : undefined;

  if (
    previousPublishedWindow &&
    (
      previousPublishedWindow.status === 'complete' ||
      previousScheduleTeamAbbreviation === currentTeamAbbreviation
    )
  ) {
    const previousWindow = resolvePreviousGames({
      previous: previousPublishedWindow,
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

  if (!schedulesHaveTeam(input.schedulesByTeam, currentTeamAbbreviation)) {
    throw new Error(
      previousPublishedWindow
        ? `The NHL schedule for traded skater ${input.asset.assetKey} on ${currentTeamAbbreviation} is unavailable.`
        : `The NHL schedule for ${currentTeamAbbreviation} is unavailable.`,
    );
  }

  const currentTeamSchedule = input.schedulesByTeam[currentTeamAbbreviation];
  const priorAssignedGameIds = new Set(input.priorAssignedGameIds ?? []);
  const confirmedAppearanceGameIds = new Set(
    input.confirmedCurrentTeamAppearanceGameIds ?? [],
  );
  if (!previousPublishedWindow) {
    if (priorAssignedGameIds.size > 0) {
      const planGames = resolveSeasonPlanGames({
        schedule: currentTeamSchedule,
        seasonSourceGameIds: input.seasonSourceGameIds,
      });
      const continuityTeamAbbreviation = normalizeTeamAbbreviation(
        input.continuityScheduleTeamAbbreviation,
      );
      const latestPriorPlanIndex = planGames.reduce(
        (latestIndex, game, index) =>
          priorAssignedGameIds.has(game.id)
            ? Math.max(latestIndex, index)
            : latestIndex,
        -1,
      );
      const continuesSameTeam =
        continuityTeamAbbreviation === currentTeamAbbreviation &&
        latestPriorPlanIndex >= 0;
      // A club switch is a schedule cutover, not an ordinal-block swap. The
      // destination club can be ahead of or behind the former club, so begin
      // at its first eligible game: finalized games require stable-player-id
      // appearance evidence, while live/upcoming games are eligible from the
      // current official roster assignment. Same-club rollover still follows
      // the persisted cursor so spillover games are neither skipped nor reused.
      const startIndex = continuesSameTeam
        ? latestPriorPlanIndex + 1
        : 0;
      const games = requireExactUniqueWindow({
        assetKey: input.asset.assetKey,
        currentTeamAbbreviation,
        cycleNumber: input.cycleNumber,
        requiredGamesPerCycle: input.requiredGamesPerCycle,
        games: selectPlanSuffixGames({
          planGames,
          startIndex,
          count: input.requiredGamesPerCycle,
          excludedGameIds: priorAssignedGameIds,
          confirmedAppearanceGameIds,
          requireFinalAppearanceEvidence: !continuesSameTeam,
          scheduleDecisionAtMilliseconds:
            input.scheduleDecisionAtMilliseconds,
          hardNotBeforeMilliseconds:
            input.assignmentNotBeforeMilliseconds,
          teamIdentityNotBeforeMilliseconds:
            input.teamIdentityNotBeforeMilliseconds,
        }),
      });

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

    if (input.assignmentNotBeforeMilliseconds !== undefined) {
      const planGames = resolveSeasonPlanGames({
        schedule: currentTeamSchedule,
        seasonSourceGameIds: input.seasonSourceGameIds,
      });
      const games = requireExactUniqueWindow({
        assetKey: input.asset.assetKey,
        currentTeamAbbreviation,
        cycleNumber: input.cycleNumber,
        requiredGamesPerCycle: input.requiredGamesPerCycle,
        games: selectPlanSuffixGames({
          planGames,
          startIndex: 0,
          count: input.requiredGamesPerCycle,
          excludedGameIds: priorAssignedGameIds,
          confirmedAppearanceGameIds,
          requireFinalAppearanceEvidence: true,
          scheduleDecisionAtMilliseconds:
            input.scheduleDecisionAtMilliseconds,
          hardNotBeforeMilliseconds:
            input.assignmentNotBeforeMilliseconds,
          teamIdentityNotBeforeMilliseconds:
            input.teamIdentityNotBeforeMilliseconds,
        }),
      });

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

    if (
      input.asset.assetType === 'skater' &&
      currentTeamAbbreviation !== storedTeamAbbreviation
    ) {
      const planGames = resolveSeasonPlanGames({
        schedule: currentTeamSchedule,
        seasonSourceGameIds: input.seasonSourceGameIds,
      });
      const games = requireExactUniqueWindow({
        assetKey: input.asset.assetKey,
        currentTeamAbbreviation,
        cycleNumber: input.cycleNumber,
        requiredGamesPerCycle: input.requiredGamesPerCycle,
        games: selectPlanSuffixGames({
          planGames,
          startIndex: 0,
          count: input.requiredGamesPerCycle,
          excludedGameIds: priorAssignedGameIds,
          confirmedAppearanceGameIds,
          requireFinalAppearanceEvidence: true,
          scheduleDecisionAtMilliseconds:
            input.scheduleDecisionAtMilliseconds,
          hardNotBeforeMilliseconds:
            input.assignmentNotBeforeMilliseconds,
          teamIdentityNotBeforeMilliseconds:
            input.teamIdentityNotBeforeMilliseconds,
        }),
      });

      return {
        games,
        scheduleTeamAbbreviation: currentTeamAbbreviation,
        sourceTeamAbbreviationByGameId: buildSourceTeamMap(
          games,
          currentTeamAbbreviation,
        ),
        teamIdentityChanged: true,
      };
    }

    const games = requireExactUniqueWindow({
      assetKey: input.asset.assetKey,
      currentTeamAbbreviation,
      cycleNumber: input.cycleNumber,
      requiredGamesPerCycle: input.requiredGamesPerCycle,
      games: input.sourceNhlTargetGameIds?.length
        ? selectGamesByStableIds(
            currentTeamSchedule,
            input.sourceNhlTargetGameIds,
          )
        : selectCycleWindowGames(
            currentTeamSchedule,
            input.cycleNumber,
            input.requiredGamesPerCycle,
          ),
    });

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

  const previousWindow = resolvePreviousGames({
    previous: previousPublishedWindow,
    schedulesByTeam: input.schedulesByTeam,
    fallbackTeamAbbreviation: previousScheduleTeamAbbreviation,
  });
  const explicitlyProtectedGameIds = new Set([
    ...(input.previous?.completedGameIds ?? []),
    ...(input.previous?.liveGameIds ?? []),
    ...(input.previous?.appearanceGameIds ?? []),
    ...(input.previous?.incompleteFinalGameIds ?? []),
  ]);
  const protectedGames: NhlTeamSeasonGame[] = [];
  const protectedGameIds = new Set<number>();

  for (const game of previousWindow.games) {
    const savedState = input.previous?.gameStates?.[String(game.id)];
    const currentState = getNhlGameRuntimeState(game);
    const reachedStartSafetyBoundary =
      hasNhlGameReachedStartSafetyBoundary({
        source: game,
        observedAtMilliseconds: input.scheduleDecisionAtMilliseconds,
      });
    const isProtected =
      explicitlyProtectedGameIds.has(game.id) ||
      savedState === 'live' ||
      savedState === 'final' ||
      currentState === 'live' ||
      currentState === 'final' ||
      reachedStartSafetyBoundary;

    if (isProtected && !protectedGameIds.has(game.id)) {
      protectedGames.push(game);
      protectedGameIds.add(game.id);
    }
  }
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
  const planGames = resolveSeasonPlanGames({
    schedule: currentTeamSchedule,
    seasonSourceGameIds: input.seasonSourceGameIds,
  });
  const excludedGameIds = new Set([
    ...priorAssignedGameIds,
    ...protectedGameIds,
  ]);
  const replacementGames = selectPlanSuffixGames({
    planGames,
    // On a team change, schedule ordinals are not comparable. Starting from
    // the destination plan's beginning lets confirmed post-trade appearances
    // before the nominal block count, skips unproven finals, and naturally
    // lands on the first live/upcoming game when no finalized appearance is
    // available.
    startIndex: 0,
    count: remainingGameCount,
    excludedGameIds,
    confirmedAppearanceGameIds,
    requireFinalAppearanceEvidence: true,
    scheduleDecisionAtMilliseconds: input.scheduleDecisionAtMilliseconds,
    hardNotBeforeMilliseconds: input.assignmentNotBeforeMilliseconds,
    teamIdentityNotBeforeMilliseconds:
      input.teamIdentityNotBeforeMilliseconds,
  });
  const games = requireExactUniqueWindow({
    assetKey: input.asset.assetKey,
    currentTeamAbbreviation,
    cycleNumber: input.cycleNumber,
    requiredGamesPerCycle: input.requiredGamesPerCycle,
    games: [...protectedGames, ...replacementGames],
  });

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
