import type {
  NhlGameBoxscoreResponse,
  NhlGamePlayByPlayResponse,
  NhlPlayByPlayEvent,
  NhlSkaterBoxscoreLine,
} from '../nhl/nhl-api.service';
import type { SkaterGameStats } from './scoring-engine';

export type NhlGameFantasyPointPhase = 'live' | 'final';

export interface NhlSkaterGameScoringFacts {
  phase: NhlGameFantasyPointPhase;
  stats: SkaterGameStats;
}

interface GoalStrength {
  powerPlay: boolean;
  shortHanded: boolean;
}

const LIVE_GAME_STATES = new Set(['LIVE', 'CRIT']);
const FINAL_GAME_STATES = new Set(['FINAL', 'OFF']);

/**
 * Orders one NHL team's skaters by their exact-game RinkRat total. Players
 * without a trustworthy calculation stay visible after the scored players,
 * while equal totals preserve the provider's original box-score order.
 */
export function sortNhlSkatersByFantasyPoints(
  players: readonly NhlSkaterBoxscoreLine[],
  totalsByPlayerId: ReadonlyMap<number, number>,
): NhlSkaterBoxscoreLine[] {
  return players
    .map((player, index) => ({
      player,
      index,
      total: totalsByPlayerId.get(player.playerId),
    }))
    .sort((first, second) => {
      const firstHasTotal = Number.isFinite(first.total);
      const secondHasTotal = Number.isFinite(second.total);

      if (firstHasTotal && secondHasTotal) {
        const difference = (second.total as number) - (first.total as number);
        return difference || first.index - second.index;
      }

      if (firstHasTotal !== secondHasTotal) {
        return firstHasTotal ? -1 : 1;
      }

      return first.index - second.index;
    })
    .map(({ player }) => player);
}

/**
 * Converts one exact NHL box-score line into the existing Scoring V4 engine's
 * input shape. Missing or internally inconsistent provider evidence returns
 * null so the UI never turns an incomplete calculation into a displayed zero.
 */
export function buildNhlSkaterGameScoringFacts(
  player: NhlSkaterBoxscoreLine,
  boxscore: NhlGameBoxscoreResponse,
  playByPlay: NhlGamePlayByPlayResponse | null,
): NhlSkaterGameScoringFacts | null {
  const gameState = (boxscore.gameState ?? playByPlay?.gameState ?? '')
    .trim()
    .toUpperCase();
  const phase: NhlGameFantasyPointPhase | null = FINAL_GAME_STATES.has(gameState)
    ? 'final'
    : LIVE_GAME_STATES.has(gameState)
      ? 'live'
      : null;

  if (!phase || !playByPlay || !Array.isArray(playByPlay.plays)) {
    return null;
  }

  const timeOnIceMinutes = parseTimeOnIceMinutes(player.toi);

  if (timeOnIceMinutes === null) {
    return null;
  }

  const goals = playByPlay.plays
    .filter(isNonShootoutGoal)
    .slice()
    .sort((first, second) => (first.sortOrder ?? 0) - (second.sortOrder ?? 0));
  const playerGoalEvents = goals.filter(
    (play) => play.details?.scoringPlayerId === player.playerId,
  );
  const primaryAssists = goals.filter(
    (play) => play.details?.assist1PlayerId === player.playerId,
  ).length;
  const secondaryAssists = goals.filter(
    (play) => play.details?.assist2PlayerId === player.playerId,
  ).length;

  if (
    playerGoalEvents.length !== player.goals ||
    primaryAssists + secondaryAssists !== player.assists
  ) {
    return null;
  }

  let powerPlayPoints = 0;
  let shortHandedPoints = 0;
  let derivedPowerPlayGoals = 0;

  if (phase === 'final') {
    for (const goal of goals) {
      const participates =
        goal.details?.scoringPlayerId === player.playerId ||
        goal.details?.assist1PlayerId === player.playerId ||
        goal.details?.assist2PlayerId === player.playerId;

      if (!participates) {
        continue;
      }

      const strength = getGoalStrength(goal, boxscore);

      if (!strength) {
        return null;
      }

      if (strength.powerPlay) {
        powerPlayPoints += 1;
      }

      if (strength.shortHanded) {
        shortHandedPoints += 1;
      }

      if (
        strength.powerPlay &&
        goal.details?.scoringPlayerId === player.playerId
      ) {
        derivedPowerPlayGoals += 1;
      }
    }

    if (derivedPowerPlayGoals !== player.powerPlayGoals) {
      return null;
    }
  } else {
    // Match the existing live-scoring fallback until final settlement supplies
    // complete special-teams and game-winning evidence.
    powerPlayPoints = player.powerPlayGoals;
  }

  return {
    phase,
    stats: {
      position: player.position === 'D' ? 'D' : 'F',
      goals: player.goals,
      primaryAssists,
      secondaryAssists,
      shotsOnGoal: player.sog,
      hits: player.hits,
      blockedShots: player.blockedShots,
      plusMinus: player.plusMinus,
      powerPlayPoints,
      shortHandedPoints,
      gameWinningGoal:
        phase === 'final' && getGameWinningGoalScorerId(goals, boxscore) === player.playerId,
      overtimeGoal:
        phase === 'final' && playerGoalEvents.some(isOvertimeGoal),
      timeOnIceMinutes,
    },
  };
}

function isNonShootoutGoal(play: NhlPlayByPlayEvent): boolean {
  return (
    play.typeDescKey === 'goal' &&
    (play.periodDescriptor?.periodType ?? '').trim().toUpperCase() !== 'SO'
  );
}

function isOvertimeGoal(play: NhlPlayByPlayEvent): boolean {
  return (play.periodDescriptor?.periodType ?? '').trim().toUpperCase() === 'OT';
}

function getGoalStrength(
  play: NhlPlayByPlayEvent,
  boxscore: NhlGameBoxscoreResponse,
): GoalStrength | null {
  const code = play.situationCode ?? '';
  const eventOwnerTeamId = play.details?.eventOwnerTeamId;

  if (!/^\d{4}$/.test(code) || typeof eventOwnerTeamId !== 'number') {
    return null;
  }

  const awaySkaters = Number(code[1]);
  const homeSkaters = Number(code[2]);
  const isAwayScorer = eventOwnerTeamId === boxscore.awayTeam?.id;
  const isHomeScorer = eventOwnerTeamId === boxscore.homeTeam?.id;

  if (!isAwayScorer && !isHomeScorer) {
    return null;
  }

  const scoringSkaters = isAwayScorer ? awaySkaters : homeSkaters;
  const opponentSkaters = isAwayScorer ? homeSkaters : awaySkaters;

  return {
    powerPlay: scoringSkaters > opponentSkaters,
    shortHanded: scoringSkaters < opponentSkaters,
  };
}

function getGameWinningGoalScorerId(
  goals: readonly NhlPlayByPlayEvent[],
  boxscore: NhlGameBoxscoreResponse,
): number | null {
  const awayScore = boxscore.awayTeam?.score;
  const homeScore = boxscore.homeTeam?.score;
  const awayTeamId = boxscore.awayTeam?.id;
  const homeTeamId = boxscore.homeTeam?.id;

  if (
    typeof awayScore !== 'number' ||
    typeof homeScore !== 'number' ||
    awayScore === homeScore ||
    typeof awayTeamId !== 'number' ||
    typeof homeTeamId !== 'number'
  ) {
    return null;
  }

  const winningTeamId = awayScore > homeScore ? awayTeamId : homeTeamId;
  const losingScore = Math.min(awayScore, homeScore);
  const winningTeamGoals = goals.filter(
    (goal) => goal.details?.eventOwnerTeamId === winningTeamId,
  );

  return winningTeamGoals[losingScore]?.details?.scoringPlayerId ?? null;
}

function parseTimeOnIceMinutes(value: string): number | null {
  const match = /^(\d+):(\d{2})$/.exec(value.trim());

  if (!match) {
    return null;
  }

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);

  if (!Number.isFinite(minutes) || seconds < 0 || seconds > 59) {
    return null;
  }

  return minutes + seconds / 60;
}
