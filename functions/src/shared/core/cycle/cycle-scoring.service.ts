import { DraftableAsset, DraftPick } from '../draft/draft.models';
import {
  calculateGoalieGameBreakdown,
  calculateSkaterGameBreakdown,
  GoalieGameStats,
  SkaterGameStats
} from '../scoring/scoring-engine';
import { ScoringRules } from '../scoring/scoring-rules';
import { selectCycleWindowGames } from './cycle-window-selection.util';
import {
  findSkaterBoxscoreLine,
  getGameBoxscore,
  getGamePlayByPlay,
  getNhlTeamSeasonSchedule,
  getRegularSeasonGameLog,
  getSkaterAssistBreakdown,
  getTeamGoalieUnitResult,
  NhlGameBoxscoreResponse,
  NhlGamePlayByPlayResponse,
  NhlPlayerGameLogEntry,
  NhlTeamSeasonGame
} from '../nhl/nhl-api.service';

export type CycleGameRuntimeState =
  | 'scheduled'
  | 'live'
  | 'final';

export interface CycleAssetScoreSummary {
  assetKey: string;
  ownerId: string;
  rosterSlotId: string;
  windowId: string;
  currentScore: number;

  /** Final NHL team games that control six-game window progress. */
  gamesPlayed: number;

  /** Final NHL games where a skater actually appeared. */
  actualGamesPlayed?: number;

  scheduledGames: number;
  gamesLeft: number;
  scheduledGameIds: number[];
  scheduledGameDates: string[];
  scheduledGameLabels: string[];
  completedGameIds: number[];
  liveGameIds: number[];
  appearanceGameIds: number[];

  /**
   * Per-game scoring lets later refreshes reuse finalized games instead of
   * downloading every historical boxscore and player game log again.
   */
  gameScores: Record<string, number>;
  gameStates: Record<string, CycleGameRuntimeState>;

  firstScheduledGameDate: string | null;
  lastScheduledGameDate: string | null;
  status: 'scheduled' | 'active' | 'complete';
}

export interface CycleScoringResult {
  scoringSchemaVersion: 2;

  /** Backward-compatible lookup used by existing asset cards. */
  assetScores: Record<string, CycleAssetScoreSummary>;

  /** Canonical lookup for independent roster-slot windows. */
  windowScores: Record<string, CycleAssetScoreSummary>;

  teamScores: Record<string, number>;
  teamGameCounts: Record<string, number>;
  teamCycleComplete: Record<string, boolean>;

  /**
   * True when at least one drafted roster asset has an NHL team game in this
   * cycle. This prevents empty off-season cycles from completing forever.
   */
  cycleHasScheduledGames: boolean;

  /** Live-game metadata used by the shared scoring scheduler. */
  hasLiveGames: boolean;
  nextScheduledGameStart: string | null;
  refreshedAt: string;
  dataFingerprint: string;
}

export interface CalculateCycleScoringInput {
  picks: DraftPick[];
  cycleNumber: number;
  season: string;
  requiredGamesPerCycle: number;
  scoringRules: ScoringRules;

  /**
   * Expected persistent slot ids for each team. This prevents a partially
   * opened overlapping cycle from being marked complete before every slot has
   * entered that cycle.
   */
  expectedRosterSlotIdsByOwner?: Record<string, string[]>;

  /** Previous shared result used for incremental final-game reuse. */
  previousResult?: CycleScoringResult | null;

  /**
   * Optional commissioner historical-replay schedules. Each asset receives a
   * synthetic target-season schedule whose game ids point to source-season
   * boxscores. This keeps the normal immutable six-game selection logic while
   * allowing the simulated calendar to decide which team games are final.
   */
  replayGamesByAssetKey?: Record<string, NhlTeamSeasonGame[]>;

  /** Source season used for historical player game logs during replay. */
  gameLogSeason?: string;

  /** Kept optional for older callers. Scoring is based on NHL game numbers. */
  startDate?: Date;
  endDate?: Date;
}

interface ScoringGameData {
  boxscore: NhlGameBoxscoreResponse;
  playByPlay: NhlGamePlayByPlayResponse;
}

interface GameScoreResult {
  points: number;
  appeared: boolean;
}

const NHL_SCORING_BATCH_SIZE = 6;
const NHL_SCORING_BATCH_DELAY_MS = 125;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rounded(value: number): number {
  return Number(value.toFixed(1));
}

function isRegularSeasonGame(game: NhlTeamSeasonGame): boolean {
  return typeof game.gameType !== 'number' || game.gameType === 2;
}

function getGameRuntimeState(
  game: NhlTeamSeasonGame
): CycleGameRuntimeState {
  const state = (game.gameState ?? '').toUpperCase();

  if (state === 'OFF' || state === 'FINAL') {
    return 'final';
  }

  if (state === 'LIVE' || state === 'CRIT') {
    return 'live';
  }

  /*
   * Historical NHL responses sometimes omit gameState but retain final scores.
   * Do not use this fallback when an explicit live/scheduled state exists.
   */
  if (
    !state &&
    typeof game.homeTeam.score === 'number' &&
    typeof game.awayTeam.score === 'number'
  ) {
    return 'final';
  }

  return 'scheduled';
}

function getAssetTeamAbbreviation(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.nhlTeamAbbreviation
    : asset.teamAbbreviation;
}

function getRosterSlotId(pick: DraftPick): string {
  return pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`;
}

function getWindowId(pick: DraftPick, cycleNumber: number): string {
  return pick.cycleWindowId ??
    `${pick.ownerId}__${getRosterSlotId(pick)}__cycle-${cycleNumber}`;
}

function getPickWindowCycleNumber(
  pick: DraftPick,
  fallbackCycleNumber: number
): number {
  return pick.snapshotCycleNumber ?? fallbackCycleNumber;
}

function getMinutesFromToi(toi: string | undefined): number {
  if (!toi) {
    return 0;
  }

  const [minutesRaw, secondsRaw] = toi.split(':');
  const minutes = Number(minutesRaw);
  const seconds = Number(secondsRaw);

  if (Number.isNaN(minutes) || Number.isNaN(seconds)) {
    return 0;
  }

  return Number((minutes + seconds / 60).toFixed(2));
}

function getUniqueDraftedTeams(picks: DraftPick[]): string[] {
  return [
    ...new Set(
      picks.map((pick) => getAssetTeamAbbreviation(pick.asset))
    )
  ].sort();
}

function getUniqueSkaterAssets(picks: DraftPick[]): DraftableAsset[] {
  const skatersByKey = new Map<string, DraftableAsset>();

  for (const pick of picks) {
    if (pick.asset.assetType === 'skater') {
      skatersByKey.set(pick.asset.assetKey, pick.asset);
    }
  }

  return [...skatersByKey.values()];
}

async function loadSchedulesByTeam(
  teamAbbreviations: string[],
  season: string
): Promise<Record<string, NhlTeamSeasonGame[]>> {
  const schedulesByTeam: Record<string, NhlTeamSeasonGame[]> = {};

  for (
    let index = 0;
    index < teamAbbreviations.length;
    index += NHL_SCORING_BATCH_SIZE
  ) {
    const batch = teamAbbreviations.slice(
      index,
      index + NHL_SCORING_BATCH_SIZE
    );

    const results = await Promise.allSettled(
      batch.map(async (teamAbbreviation) => {
        const schedule = await getNhlTeamSeasonSchedule(
          teamAbbreviation,
          season
        );

        return {
          teamAbbreviation,
          schedule: schedule
            .filter(isRegularSeasonGame)
            .sort((first, second) => {
              const dateCompare = first.gameDate.localeCompare(second.gameDate);

              if (dateCompare !== 0) {
                return dateCompare;
              }

              return first.id - second.id;
            })
        };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        schedulesByTeam[result.value.teamAbbreviation] = result.value.schedule;
      } else {
        console.warn('Unable to load scoring schedule.', result.reason);
      }
    }

    if (index + NHL_SCORING_BATCH_SIZE < teamAbbreviations.length) {
      await wait(NHL_SCORING_BATCH_DELAY_MS);
    }
  }

  return schedulesByTeam;
}

async function loadScoringGameData(
  gameIds: number[]
): Promise<Map<number, ScoringGameData>> {
  const gameDataById = new Map<number, ScoringGameData>();

  for (
    let index = 0;
    index < gameIds.length;
    index += NHL_SCORING_BATCH_SIZE
  ) {
    const batch = gameIds.slice(index, index + NHL_SCORING_BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (gameId) => {
        const [boxscore, playByPlay] = await Promise.all([
          getGameBoxscore(gameId),
          getGamePlayByPlay(gameId)
        ]);

        return {
          gameId,
          data: {
            boxscore,
            playByPlay
          }
        };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        gameDataById.set(result.value.gameId, result.value.data);
      } else {
        console.warn('Unable to load NHL game scoring data.', result.reason);
      }
    }

    if (index + NHL_SCORING_BATCH_SIZE < gameIds.length) {
      await wait(NHL_SCORING_BATCH_DELAY_MS);
    }
  }

  return gameDataById;
}

async function loadSkaterGameLogs(
  skaters: DraftableAsset[],
  season: string
): Promise<Map<number, Map<number, NhlPlayerGameLogEntry>>> {
  const gameLogsByPlayerId = new Map<
    number,
    Map<number, NhlPlayerGameLogEntry>
  >();

  for (
    let index = 0;
    index < skaters.length;
    index += NHL_SCORING_BATCH_SIZE
  ) {
    const batch = skaters.slice(index, index + NHL_SCORING_BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (asset) => {
        if (asset.assetType !== 'skater') {
          throw new Error(
            'Non-skater asset passed to skater game log loader.'
          );
        }

        /*
         * These players have a newly final game. Force one fresh log so
         * power-play, short-handed, game-winning, and overtime bonuses settle
         * accurately. Old finalized games are reused from the shared snapshot.
         */
        const gameLogResponse = await getRegularSeasonGameLog(
          asset.player.id,
          season,
          true
        );

        const gameLogByGameId = new Map<number, NhlPlayerGameLogEntry>();

        for (const gameLog of gameLogResponse.gameLog ?? []) {
          gameLogByGameId.set(gameLog.gameId, gameLog);
        }

        return {
          playerId: asset.player.id,
          gameLogByGameId
        };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        gameLogsByPlayerId.set(
          result.value.playerId,
          result.value.gameLogByGameId
        );
      } else {
        console.warn('Unable to load newly final skater game log.', result.reason);
      }
    }

    if (index + NHL_SCORING_BATCH_SIZE < skaters.length) {
      await wait(NHL_SCORING_BATCH_DELAY_MS);
    }
  }

  return gameLogsByPlayerId;
}

function getRelevantAssetGames(
  asset: DraftableAsset,
  schedulesByTeam: Record<string, NhlTeamSeasonGame[]>,
  cycleNumber: number,
  requiredGamesPerCycle: number,
  replayGamesByAssetKey?: Record<string, NhlTeamSeasonGame[]>
): NhlTeamSeasonGame[] {
  const schedule = replayGamesByAssetKey?.[asset.assetKey] ??
    schedulesByTeam[getAssetTeamAbbreviation(asset)] ?? [];

  return selectCycleWindowGames(
    schedule,
    cycleNumber,
    requiredGamesPerCycle
  );
}

function calculateSkaterGameScore(
  asset: DraftableAsset,
  gameData: ScoringGameData | undefined,
  gameLog: NhlPlayerGameLogEntry | undefined,
  gameIsFinal: boolean,
  scoringRules: ScoringRules
): GameScoreResult {
  if (asset.assetType !== 'skater') {
    return {
      points: 0,
      appeared: false
    };
  }

  const skaterLine = gameData
    ? findSkaterBoxscoreLine(gameData.boxscore, asset.player.id)
    : null;

  if (!skaterLine && !gameLog) {
    return {
      points: 0,
      appeared: false
    };
  }

  const assistBreakdown = gameData
    ? getSkaterAssistBreakdown(gameData.playByPlay, asset.player.id)
    : {
        primaryAssists: 0,
        secondaryAssists: 0
      };

  const totalAssists = skaterLine?.assists ?? gameLog?.assists ?? 0;
  let primaryAssists = assistBreakdown.primaryAssists;
  let secondaryAssists = assistBreakdown.secondaryAssists;

  if (primaryAssists + secondaryAssists < totalAssists) {
    secondaryAssists += totalAssists - primaryAssists - secondaryAssists;
  }

  const stats: SkaterGameStats = {
    position: asset.position === 'D' ? 'D' : 'F',
    goals: skaterLine?.goals ?? gameLog?.goals ?? 0,
    primaryAssists,
    secondaryAssists,
    shotsOnGoal: skaterLine?.sog ?? gameLog?.shots ?? 0,
    hits: skaterLine?.hits ?? 0,
    blockedShots: skaterLine?.blockedShots ?? 0,
    plusMinus: skaterLine?.plusMinus ?? gameLog?.plusMinus ?? 0,

    /*
     * Live boxscores expose power-play goals but not every PP/SH assist bonus.
     * The newly final player log settles those bonuses after the game ends.
     */
    powerPlayPoints: gameIsFinal
      ? gameLog?.powerPlayPoints ?? skaterLine?.powerPlayGoals ?? 0
      : skaterLine?.powerPlayGoals ?? 0,
    shortHandedPoints: gameIsFinal
      ? gameLog?.shorthandedPoints ?? 0
      : 0,
    gameWinningGoal: gameIsFinal && Boolean(gameLog?.gameWinningGoals),
    overtimeGoal: gameIsFinal && Boolean(gameLog?.otGoals),
    timeOnIceMinutes: getMinutesFromToi(skaterLine?.toi ?? gameLog?.toi)
  };

  return {
    points: rounded(
      calculateSkaterGameBreakdown(stats, scoringRules).total
    ),
    appeared: true
  };
}

function calculateGoalieUnitGameScore(
  asset: DraftableAsset,
  gameData: ScoringGameData | undefined,
  gameIsFinal: boolean,
  scoringRules: ScoringRules
): GameScoreResult {
  if (asset.assetType === 'skater' || !gameData) {
    return {
      points: 0,
      appeared: false
    };
  }

  const goalieResult = getTeamGoalieUnitResult(
    gameData.boxscore,
    asset.teamAbbreviation
  );

  if (!goalieResult) {
    return {
      points: 0,
      appeared: false
    };
  }

  const stats: GoalieGameStats = {
    saves: goalieResult.saves,
    shotsAgainst: goalieResult.shotsAgainst,
    won: gameIsFinal && goalieResult.won,
    shutout: gameIsFinal && goalieResult.shutout
  };

  return {
    points: rounded(
      calculateGoalieGameBreakdown(stats, scoringRules).total
    ),
    appeared: true
  };
}

function canReuseFinalGame(
  previous: CycleAssetScoreSummary | undefined,
  gameId: number
): boolean {
  const key = String(gameId);

  return (
    previous?.gameStates?.[key] === 'final' &&
    typeof previous.gameScores?.[key] === 'number'
  );
}

function getPreviousWindowSummary(
  previousResult: CycleScoringResult | null | undefined,
  windowId: string,
  assetKey: string
): CycleAssetScoreSummary | undefined {
  return previousResult?.windowScores?.[windowId] ??
    previousResult?.assetScores?.[assetKey];
}

function getNextScheduledStart(
  games: NhlTeamSeasonGame[]
): string | null {
  const candidates = games
    .filter((game) => getGameRuntimeState(game) === 'scheduled')
    .map((game) => game.startTimeUTC ?? `${game.gameDate}T12:00:00Z`)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((first, second) => Date.parse(first) - Date.parse(second));

  return candidates[0] ?? null;
}

function buildResultFingerprint(
  cycleNumber: number,
  windowScores: Record<string, CycleAssetScoreSummary>
): string {
  return [
    `cycle:${cycleNumber}`,
    ...Object.values(windowScores)
      .sort((first, second) => first.windowId.localeCompare(second.windowId))
      .map((summary) => [
        summary.windowId,
        summary.currentScore.toFixed(1),
        summary.gamesPlayed,
        summary.actualGamesPlayed ?? 0,
        summary.status,
        summary.completedGameIds.join(','),
        summary.liveGameIds.join(','),
        Object.entries(summary.gameScores)
          .sort(([first], [second]) => first.localeCompare(second))
          .map(([gameId, score]) => `${gameId}:${score.toFixed(1)}`)
          .join(',')
      ].join(':'))
  ].join('|');
}

export async function calculateCycleScoring(
  input: CalculateCycleScoringInput
): Promise<CycleScoringResult> {
  const draftedTeams = getUniqueDraftedTeams(input.picks);
  const schedulesByTeam = input.replayGamesByAssetKey
    ? {}
    : await loadSchedulesByTeam(draftedTeams, input.season);
  const gamesByWindowId = new Map<string, NhlTeamSeasonGame[]>();
  const previousByWindowId = new Map<string, CycleAssetScoreSummary | undefined>();
  const gameIdsToLoad = new Set<number>();
  const skaterAssetKeysNeedingFinalLogs = new Set<string>();

  const teamGameCounts: Record<string, number> = {};

  for (const teamAbbreviation of draftedTeams) {
    const representativePick = input.picks.find(
      (pick) => getAssetTeamAbbreviation(pick.asset) === teamAbbreviation
    );
    const schedule = representativePick
      ? input.replayGamesByAssetKey?.[representativePick.asset.assetKey] ??
        schedulesByTeam[teamAbbreviation] ?? []
      : schedulesByTeam[teamAbbreviation] ?? [];

    teamGameCounts[teamAbbreviation] = selectCycleWindowGames(
      schedule,
      input.cycleNumber,
      input.requiredGamesPerCycle
    ).length;
  }

  for (const pick of input.picks) {
    const pickWindowCycleNumber = getPickWindowCycleNumber(
      pick,
      input.cycleNumber
    );
    const windowId = getWindowId(pick, pickWindowCycleNumber);
    const games = getRelevantAssetGames(
      pick.asset,
      schedulesByTeam,
      pickWindowCycleNumber,
      input.requiredGamesPerCycle,
      input.replayGamesByAssetKey
    );
    const previous = getPreviousWindowSummary(
      input.previousResult,
      windowId,
      pick.asset.assetKey
    );

    gamesByWindowId.set(windowId, games);
    previousByWindowId.set(windowId, previous);

    for (const game of games) {
      const state = getGameRuntimeState(game);

      if (state === 'live') {
        gameIdsToLoad.add(game.id);
        continue;
      }

      if (state === 'final' && !canReuseFinalGame(previous, game.id)) {
        gameIdsToLoad.add(game.id);

        if (pick.asset.assetType === 'skater') {
          skaterAssetKeysNeedingFinalLogs.add(pick.asset.assetKey);
        }
      }
    }
  }

  const skatersNeedingLogs = getUniqueSkaterAssets(input.picks).filter(
    (asset) => skaterAssetKeysNeedingFinalLogs.has(asset.assetKey)
  );

  const [gameDataById, gameLogsByPlayerId] = await Promise.all([
    loadScoringGameData([...gameIdsToLoad]),
    loadSkaterGameLogs(skatersNeedingLogs, input.gameLogSeason ?? input.season)
  ]);

  const assetScores: Record<string, CycleAssetScoreSummary> = {};
  const windowScores: Record<string, CycleAssetScoreSummary> = {};
  const teamScores: Record<string, number> = {};
  let hasLiveGames = false;
  const allRelevantGames: NhlTeamSeasonGame[] = [];

  for (const pick of input.picks) {
    const rosterSlotId = getRosterSlotId(pick);
    const pickWindowCycleNumber = getPickWindowCycleNumber(
      pick,
      input.cycleNumber
    );
    const windowId = getWindowId(pick, pickWindowCycleNumber);
    const games = gamesByWindowId.get(windowId) ?? [];
    const previous = previousByWindowId.get(windowId);
    const gameScores: Record<string, number> = {};
    const gameStates: Record<string, CycleGameRuntimeState> = {};
    const completedGameIds: number[] = [];
    const liveGameIds: number[] = [];
    const appearanceGameIds: number[] = [];
    let gamesPlayed = 0;
    let actualGamesPlayed = 0;
    let currentScore = 0;

    allRelevantGames.push(...games);

    for (const game of games) {
      const gameIdKey = String(game.id);
      const state = getGameRuntimeState(game);
      gameStates[gameIdKey] = state;

      if (state === 'scheduled') {
        continue;
      }

      if (state === 'live') {
        hasLiveGames = true;
        liveGameIds.push(game.id);
      }

      if (state === 'final') {
        gamesPlayed += 1;
        completedGameIds.push(game.id);
      }

      if (state === 'final' && canReuseFinalGame(previous, game.id)) {
        const previousScore = previous?.gameScores?.[gameIdKey] ?? 0;
        gameScores[gameIdKey] = rounded(previousScore);
        currentScore += previousScore;

        if (previous?.appearanceGameIds?.includes(game.id)) {
          actualGamesPlayed += 1;
          appearanceGameIds.push(game.id);
        }

        continue;
      }

      const gameData = gameDataById.get(game.id);
      const gameLog = pick.asset.assetType === 'skater'
        ? gameLogsByPlayerId
            .get(pick.asset.player.id)
            ?.get(game.id)
        : undefined;
      const scoreResult = pick.asset.assetType === 'skater'
        ? calculateSkaterGameScore(
            pick.asset,
            gameData,
            gameLog,
            state === 'final',
            input.scoringRules
          )
        : calculateGoalieUnitGameScore(
            pick.asset,
            gameData,
            state === 'final',
            input.scoringRules
          );

      gameScores[gameIdKey] = scoreResult.points;
      currentScore += scoreResult.points;

      if (state === 'final' && scoreResult.appeared) {
        actualGamesPlayed += 1;
        appearanceGameIds.push(game.id);
      }
    }

    const gamesLeft = Math.max(0, games.length - gamesPlayed);
    const status = games.length > 0 && gamesLeft === 0
      ? 'complete'
      : gamesPlayed > 0 || liveGameIds.length > 0
        ? 'active'
        : 'scheduled';

    const summary: CycleAssetScoreSummary = {
      assetKey: pick.asset.assetKey,
      ownerId: pick.ownerId,
      rosterSlotId,
      windowId,
      currentScore: rounded(currentScore),
      gamesPlayed,
      actualGamesPlayed,
      scheduledGames: games.length,
      gamesLeft,
      scheduledGameIds: games.map((game) => game.id),
      scheduledGameDates: games.map((game) => game.gameDate),
      scheduledGameLabels: games.map((game) => {
        const teamAbbreviation = getAssetTeamAbbreviation(pick.asset);
        return game.homeTeam.abbrev === teamAbbreviation
          ? `vs ${game.awayTeam.abbrev}`
          : `@ ${game.homeTeam.abbrev}`;
      }),
      completedGameIds,
      liveGameIds,
      appearanceGameIds,
      gameScores,
      gameStates,
      firstScheduledGameDate: games[0]?.gameDate ?? null,
      lastScheduledGameDate: games.at(-1)?.gameDate ?? null,
      status
    };

    assetScores[pick.asset.assetKey] = summary;
    windowScores[windowId] = summary;
    teamScores[pick.ownerId] = rounded(
      (teamScores[pick.ownerId] ?? 0) + summary.currentScore
    );
  }

  const teamCycleComplete: Record<string, boolean> = {};
  const expectedOwnerIds = Object.keys(
    input.expectedRosterSlotIdsByOwner ?? {}
  );
  const ownerIds = [
    ...new Set([
      ...input.picks.map((pick) => pick.ownerId),
      ...expectedOwnerIds
    ])
  ];

  for (const ownerId of ownerIds) {
    const ownerPicks = input.picks.filter((pick) => pick.ownerId === ownerId);
    const expectedSlotIds =
      input.expectedRosterSlotIdsByOwner?.[ownerId] ??
      ownerPicks.map(getRosterSlotId);
    const pickBySlotId = new Map(
      ownerPicks.map((pick) => [getRosterSlotId(pick), pick] as const)
    );

    teamCycleComplete[ownerId] =
      expectedSlotIds.length > 0 &&
      expectedSlotIds.every((slotId) => {
        const pick = pickBySlotId.get(slotId);

        if (!pick) {
          return false;
        }

        const summary = windowScores[
          getWindowId(
            pick,
            getPickWindowCycleNumber(pick, input.cycleNumber)
          )
        ];

        return Boolean(summary) && summary.gamesLeft === 0;
      });
  }

  const cycleHasScheduledGames = Object.values(assetScores).some(
    (summary) => summary.scheduledGames > 0
  );
  const dataFingerprint = buildResultFingerprint(
    input.cycleNumber,
    windowScores
  );

  return {
    scoringSchemaVersion: 2,
    assetScores,
    windowScores,
    teamScores,
    teamGameCounts,
    teamCycleComplete,
    cycleHasScheduledGames,
    hasLiveGames,
    nextScheduledGameStart: getNextScheduledStart(allRelevantGames),
    refreshedAt: new Date().toISOString(),
    dataFingerprint
  };
}
