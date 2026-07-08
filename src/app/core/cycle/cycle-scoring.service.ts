import { DraftableAsset, DraftPick } from '../draft/draft.models';
import {
  calculateGoalieGameBreakdown,
  calculateSkaterGameBreakdown,
  GoalieGameStats,
  SkaterGameStats
} from '../scoring/scoring-engine';
import { ScoringRules } from '../scoring/scoring-rules';
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

export interface CycleAssetScoreSummary {
  assetKey: string;
  currentScore: number;

  /**
   * This is the number that controls cycle progress.
   * It counts the asset's NHL team games in this cycle, even if the skater
   * was injured, scratched, suspended, benched, or otherwise did not play.
   */
  gamesPlayed: number;

  /**
   * This is the number of games where the skater actually appeared.
   * Goalie units count every final team game as an actual game.
   */
  actualGamesPlayed?: number;

  scheduledGames: number;
  gamesLeft: number;
}

export interface CycleScoringResult {
  assetScores: Record<string, CycleAssetScoreSummary>;
  teamScores: Record<string, number>;
  teamGameCounts: Record<string, number>;
  teamCycleComplete: Record<string, boolean>;
}

export interface CalculateCycleScoringInput {
  picks: DraftPick[];
  cycleNumber: number;
  season: string;
  requiredGamesPerCycle: number;
  scoringRules: ScoringRules;

  /**
   * Kept optional for older callers. Scoring no longer uses date windows.
   * A cycle is now based on NHL team game numbers:
   * Cycle 1 = games 1-6, Cycle 2 = games 7-12, etc.
   */
  startDate?: Date;
  endDate?: Date;
}

interface FinalGameData {
  boxscore: NhlGameBoxscoreResponse;
  playByPlay: NhlGamePlayByPlayResponse;
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

function isFinalGame(game: NhlTeamSeasonGame): boolean {
  const hasScores =
    typeof game.homeTeam.score === 'number' &&
    typeof game.awayTeam.score === 'number';

  return game.gameState === 'OFF' || game.gameState === 'FINAL' || hasScores;
}

function getAssetTeamAbbreviation(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.nhlTeamAbbreviation
    : asset.teamAbbreviation;
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

function getCycleGameStartIndex(
  cycleNumber: number,
  requiredGamesPerCycle: number
): number {
  return Math.max(0, (cycleNumber - 1) * requiredGamesPerCycle);
}

function getCycleGameEndIndex(
  cycleNumber: number,
  requiredGamesPerCycle: number
): number {
  return cycleNumber * requiredGamesPerCycle;
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

    await wait(NHL_SCORING_BATCH_DELAY_MS);
  }

  return schedulesByTeam;
}

async function loadFinalGameData(
  gameIds: number[]
): Promise<Map<number, FinalGameData>> {
  const finalGameDataById = new Map<number, FinalGameData>();

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
        finalGameDataById.set(result.value.gameId, result.value.data);
      } else {
        console.warn('Unable to load final game scoring data.', result.reason);
      }
    }

    await wait(NHL_SCORING_BATCH_DELAY_MS);
  }

  return finalGameDataById;
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

        const gameLogResponse = await getRegularSeasonGameLog(
          asset.player.id,
          season
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
        console.warn('Unable to load skater game log.', result.reason);
      }
    }

    await wait(NHL_SCORING_BATCH_DELAY_MS);
  }

  return gameLogsByPlayerId;
}

function getRelevantAssetGames(
  asset: DraftableAsset,
  schedulesByTeam: Record<string, NhlTeamSeasonGame[]>,
  cycleNumber: number,
  requiredGamesPerCycle: number
): NhlTeamSeasonGame[] {
  const teamAbbreviation = getAssetTeamAbbreviation(asset);
  const schedule = schedulesByTeam[teamAbbreviation] ?? [];

  return schedule.slice(
    getCycleGameStartIndex(cycleNumber, requiredGamesPerCycle),
    getCycleGameEndIndex(cycleNumber, requiredGamesPerCycle)
  );
}

function calculateSkaterAssetScore(
  asset: DraftableAsset,
  games: NhlTeamSeasonGame[],
  finalGameDataById: Map<number, FinalGameData>,
  gameLogsByPlayerId: Map<number, Map<number, NhlPlayerGameLogEntry>>,
  scoringRules: ScoringRules
): {
  currentScore: number;
  gamesPlayed: number;
  actualGamesPlayed: number;
} {
  if (asset.assetType !== 'skater') {
    return {
      currentScore: 0,
      gamesPlayed: 0,
      actualGamesPlayed: 0
    };
  }

  let currentScore = 0;
  let gamesPlayed = 0;
  let actualGamesPlayed = 0;

  const gameLogByGameId =
    gameLogsByPlayerId.get(asset.player.id) ??
    new Map<number, NhlPlayerGameLogEntry>();

  for (const game of games) {
    if (!isFinalGame(game)) {
      continue;
    }

    // This is the important DNP/injury rule:
    // a final NHL team game counts toward cycle progress even if the skater
    // did not appear in the boxscore or game log.
    gamesPlayed += 1;

    const finalGameData = finalGameDataById.get(game.id);
    const gameLog = gameLogByGameId.get(game.id);
    const skaterLine = finalGameData
      ? findSkaterBoxscoreLine(finalGameData.boxscore, asset.player.id)
      : null;

    if (!skaterLine && !gameLog) {
      continue;
    }

    actualGamesPlayed += 1;

    const assistBreakdown = finalGameData
      ? getSkaterAssistBreakdown(finalGameData.playByPlay, asset.player.id)
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
      powerPlayPoints:
        gameLog?.powerPlayPoints ?? skaterLine?.powerPlayGoals ?? 0,
      shortHandedPoints: gameLog?.shorthandedPoints ?? 0,
      gameWinningGoal: Boolean(gameLog?.gameWinningGoals),
      overtimeGoal: Boolean(gameLog?.otGoals),
      timeOnIceMinutes: getMinutesFromToi(skaterLine?.toi ?? gameLog?.toi)
    };

    const breakdown = calculateSkaterGameBreakdown(stats, scoringRules);
    currentScore += breakdown.total;
  }

  return {
    currentScore: rounded(currentScore),
    gamesPlayed,
    actualGamesPlayed
  };
}

function calculateGoalieUnitAssetScore(
  asset: DraftableAsset,
  games: NhlTeamSeasonGame[],
  finalGameDataById: Map<number, FinalGameData>,
  scoringRules: ScoringRules
): {
  currentScore: number;
  gamesPlayed: number;
  actualGamesPlayed: number;
} {
  if (asset.assetType === 'skater') {
    return {
      currentScore: 0,
      gamesPlayed: 0,
      actualGamesPlayed: 0
    };
  }

  let currentScore = 0;
  let gamesPlayed = 0;
  let actualGamesPlayed = 0;

  for (const game of games) {
    if (!isFinalGame(game)) {
      continue;
    }

    gamesPlayed += 1;
    actualGamesPlayed += 1;

    const finalGameData = finalGameDataById.get(game.id);

    if (!finalGameData) {
      continue;
    }

    const goalieResult = getTeamGoalieUnitResult(
      finalGameData.boxscore,
      asset.teamAbbreviation
    );

    if (!goalieResult) {
      continue;
    }

    const stats: GoalieGameStats = {
      saves: goalieResult.saves,
      shotsAgainst: goalieResult.shotsAgainst,
      won: goalieResult.won,
      shutout: goalieResult.shutout
    };

    const breakdown = calculateGoalieGameBreakdown(stats, scoringRules);
    currentScore += breakdown.total;
  }

  return {
    currentScore: rounded(currentScore),
    gamesPlayed,
    actualGamesPlayed
  };
}

export async function calculateCycleScoring(
  input: CalculateCycleScoringInput
): Promise<CycleScoringResult> {
  const draftedTeams = getUniqueDraftedTeams(input.picks);
  const schedulesByTeam = await loadSchedulesByTeam(draftedTeams, input.season);

  const teamGameCounts: Record<string, number> = {};

  for (const teamAbbreviation of draftedTeams) {
    const schedule = schedulesByTeam[teamAbbreviation] ?? [];

    teamGameCounts[teamAbbreviation] = schedule.slice(
      getCycleGameStartIndex(input.cycleNumber, input.requiredGamesPerCycle),
      getCycleGameEndIndex(input.cycleNumber, input.requiredGamesPerCycle)
    ).length;
  }

  const finalGameIds = [
    ...new Set(
      input.picks
        .flatMap((pick) =>
          getRelevantAssetGames(
            pick.asset,
            schedulesByTeam,
            input.cycleNumber,
            input.requiredGamesPerCycle
          )
        )
        .filter(isFinalGame)
        .map((game) => game.id)
    )
  ];

  const [finalGameDataById, gameLogsByPlayerId] = await Promise.all([
    loadFinalGameData(finalGameIds),
    loadSkaterGameLogs(getUniqueSkaterAssets(input.picks), input.season)
  ]);

  const assetScores: Record<string, CycleAssetScoreSummary> = {};
  const teamScores: Record<string, number> = {};

  for (const pick of input.picks) {
    const games = getRelevantAssetGames(
      pick.asset,
      schedulesByTeam,
      input.cycleNumber,
      input.requiredGamesPerCycle
    );

    const result =
      pick.asset.assetType === 'skater'
        ? calculateSkaterAssetScore(
            pick.asset,
            games,
            finalGameDataById,
            gameLogsByPlayerId,
            input.scoringRules
          )
        : calculateGoalieUnitAssetScore(
            pick.asset,
            games,
            finalGameDataById,
            input.scoringRules
          );

    const summary: CycleAssetScoreSummary = {
      assetKey: pick.asset.assetKey,
      currentScore: result.currentScore,
      gamesPlayed: result.gamesPlayed,
      actualGamesPlayed: result.actualGamesPlayed,
      scheduledGames: games.length,
      gamesLeft: Math.max(0, games.length - result.gamesPlayed)
    };

    assetScores[pick.asset.assetKey] = summary;
    teamScores[pick.ownerId] = rounded(
      (teamScores[pick.ownerId] ?? 0) + summary.currentScore
    );
  }

  const teamCycleComplete: Record<string, boolean> = {};
  const ownerIds = [...new Set(input.picks.map((pick) => pick.ownerId))];

  for (const ownerId of ownerIds) {
    const ownerPicks = input.picks.filter((pick) => pick.ownerId === ownerId);

    teamCycleComplete[ownerId] =
      ownerPicks.length > 0 &&
      ownerPicks.every((pick) => {
        const summary = assetScores[pick.asset.assetKey];
        return Boolean(summary) && summary.gamesLeft === 0;
      });
  }

  return {
    assetScores,
    teamScores,
    teamGameCounts,
    teamCycleComplete
  };
}
