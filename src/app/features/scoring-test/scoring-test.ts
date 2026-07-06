import { Component, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';
import {
  findSkaterBoxscoreLine,
  getGameBoxscore,
  getGamePlayByPlay,
  getRegularSeasonGameLog,
  NhlPlayerGameLogEntry,
  getSkaterAssistBreakdown
} from '../../core/nhl/nhl-api.service';
import {
  calculateSkaterGameBreakdown,
  type GamePointBreakdown,
  type SkaterGameStats
} from '../../core/scoring/scoring-engine';

import { defaultScoringRules } from '../../core/scoring/scoring-rules';
import {
  calculateGoalieGamePoints,
  calculateSkaterGamePoints,
  GoalieGameStats,
} from '../../core/scoring/scoring-engine';



interface ScoringTestCase {
  name: string;
  type: 'skater' | 'goalie';
  description: string;
  points: number;
}

interface RealSkaterGameRow {
  gameId: number;
  date: string;
  matchup: string;
  goals: number;
  primaryAssists: number;
  secondaryAssists: number;
  shots: number;
  hits: number;
  blocks: number;
  powerPlayPoints: number;
  shortHandedPoints: number;
  plusMinus: number;
  toi: string;
  breakdown: GamePointBreakdown;
}

interface GoalPlay {
  eventId: number;
  periodDescriptor?: {
    number?: number;
  };
  timeInPeriod?: string;
  typeDescKey?: string;
  details?: {
    scoringPlayerId?: number;
    assist1PlayerId?: number;
    assist2PlayerId?: number;
  };
}

interface GoalEventRow {
  eventId: number;
  period: number | null;
  time: string;
  scorerId: number | null;
  assist1Id: number | null;
  assist2Id: number | null;
  mcdavidCredit: string;
}

function isGoalPlay(play: unknown): play is GoalPlay {
  if (typeof play !== 'object' || play === null) {
    return false;
  }

  return (play as { typeDescKey?: unknown }).typeDescKey === 'goal';
}

function toiToMinutes(toi: string): number {
  const [minutes, seconds] = toi.split(':').map(Number);

  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return 0;
  }

  return minutes + seconds / 60;
}

@Component({
  selector: 'app-scoring-test',
  imports: [JsonPipe],
  templateUrl: './scoring-test.html',
  styleUrl: './scoring-test.css'
})
export class ScoringTest {
realCyclePoints = signal(0);
apiStatus = signal('');
apiGames = signal<NhlPlayerGameLogEntry[]>([]);
realStatsStatus = signal('');
realStatRows = signal<RealSkaterGameRow[]>([]);
playByPlayStatus = signal('');
playByPlayEvents = signal<unknown[]>([]);
goalEventRows = signal<GoalEventRow[]>([]);

async loadMcDavidBoxscores(): Promise<void> {
  const games = this.apiGames();

  if (games.length === 0) {
    this.realStatsStatus.set('Load the McDavid game log first.');
    return;
  }

  this.realStatsStatus.set(
    'Loading full stats and scoring six real games...'
  );

  this.realStatRows.set([]);
  this.realCyclePoints.set(0);

  try {
    const rows = await Promise.all(
      games.map(async (game) => {
        const [boxscore, playByPlay] = await Promise.all([
          getGameBoxscore(game.gameId),
          getGamePlayByPlay(game.gameId)
        ]);

        const playerLine = findSkaterBoxscoreLine(
          boxscore,
          8478402
        );

        if (!playerLine) {
          throw new Error(
            `McDavid was not found in boxscore ${game.gameId}.`
          );
        }

        const assists = getSkaterAssistBreakdown(
          playByPlay,
          8478402
        );

        const stats: SkaterGameStats = {
          position: 'F',
          goals: game.goals,
          primaryAssists: assists.primaryAssists,
          secondaryAssists: assists.secondaryAssists,
          shotsOnGoal: playerLine.sog,
          hits: playerLine.hits,
          blockedShots: playerLine.blockedShots,
          plusMinus: game.plusMinus,
          powerPlayPoints: game.powerPlayPoints,
          shortHandedPoints: game.shorthandedPoints,
          gameWinningGoal: game.gameWinningGoals > 0,
          overtimeGoal: game.otGoals > 0,
          timeOnIceMinutes: toiToMinutes(playerLine.toi)
        };

        return {
          gameId: game.gameId,
          date: game.gameDate,
          matchup: `${game.homeRoadFlag === 'H' ? 'vs' : '@'} ${game.opponentAbbrev}`,
          goals: game.goals,
          primaryAssists: assists.primaryAssists,
          secondaryAssists: assists.secondaryAssists,
          shots: playerLine.sog,
          hits: playerLine.hits,
          blocks: playerLine.blockedShots,
          powerPlayPoints: game.powerPlayPoints,
          shortHandedPoints: game.shorthandedPoints,
          plusMinus: game.plusMinus,
          toi: playerLine.toi,
          breakdown: calculateSkaterGameBreakdown(
            stats,
            defaultScoringRules
          )
        };
      })
    );

    const cyclePoints = rows.reduce(
      (total, game) => total + game.breakdown.total,
      0
    );

    this.realStatRows.set(rows);
    this.realCyclePoints.set(Number(cyclePoints.toFixed(2)));

    this.realStatsStatus.set(
      `Loaded and scored ${rows.length} real games.`
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';

    this.realStatsStatus.set(message);
  }
}

async loadMcDavidFourAssistPlayByPlay(): Promise<void> {
  this.playByPlayStatus.set(
    'Loading play-by-play from McDavid’s four-assist game...'
  );

  this.playByPlayEvents.set([]);
  this.goalEventRows.set([]);

  try {
    const response = await getGamePlayByPlay(2025021311);

    const plays = Array.isArray(response.plays)
      ? response.plays
      : [];

    const goalRows = plays
      .filter(isGoalPlay)
      .map((play) => {
        const details = play.details ?? {};

        let mcdavidCredit = 'No McDavid credit';

        if (details.scoringPlayerId === 8478402) {
          mcdavidCredit = 'McDavid scored';
        } else if (details.assist1PlayerId === 8478402) {
          mcdavidCredit = 'McDavid: Assist 1';
        } else if (details.assist2PlayerId === 8478402) {
          mcdavidCredit = 'McDavid: Assist 2';
        }

        return {
          eventId: play.eventId,
          period: play.periodDescriptor?.number ?? null,
          time: play.timeInPeriod ?? '--:--',
          scorerId: details.scoringPlayerId ?? null,
          assist1Id: details.assist1PlayerId ?? null,
          assist2Id: details.assist2PlayerId ?? null,
          mcdavidCredit
        };
      });

    this.playByPlayEvents.set(plays);
    this.goalEventRows.set(goalRows);

    this.playByPlayStatus.set(
      `Loaded ${plays.length} play-by-play events and ${goalRows.length} goal events.`
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown play-by-play error';

    this.playByPlayStatus.set(message);
  }
}

async loadMcDavidGameLog(): Promise<void> {
  this.apiStatus.set('Loading NHL game log...');
  this.apiGames.set([]);

  try {
    const response = await getRegularSeasonGameLog(
      8478402,
      '20252026'
    );

    const games = Array.isArray(response.gameLog)
      ? response.gameLog.slice(0, 6)
      : [];

    this.apiGames.set(games);
    this.apiStatus.set(`Loaded ${games.length} games.`);
    console.log('Connor McDavid game log:', response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown NHL API error';

    this.apiStatus.set(message);
  }
}
  testCases: ScoringTestCase[] = [
    this.createSkaterTest('Connor McDavid', 'Superstar forward game', {
      position: 'F',
      goals: 1,
      primaryAssists: 2,
      secondaryAssists: 0,
      shotsOnGoal: 6,
      hits: 0,
      blockedShots: 0,
      plusMinus: 1,
      powerPlayPoints: 2,
      shortHandedPoints: 0,
      gameWinningGoal: false,
      overtimeGoal: false,
      timeOnIceMinutes: 22
    }),
    this.createSkaterTest('Zach Werenski', 'High-TOI defenseman game', {
      position: 'D',
      goals: 0,
      primaryAssists: 1,
      secondaryAssists: 1,
      shotsOnGoal: 3,
      hits: 1,
      blockedShots: 4,
      plusMinus: 1,
      powerPlayPoints: 1,
      shortHandedPoints: 0,
      gameWinningGoal: false,
      overtimeGoal: false,
      timeOnIceMinutes: 26
    }),
    this.createSkaterTest('Brandon Tanev', 'Useful grinder game', {
      position: 'F',
      goals: 0,
      primaryAssists: 0,
      secondaryAssists: 0,
      shotsOnGoal: 2,
      hits: 5,
      blockedShots: 1,
      plusMinus: 0,
      powerPlayPoints: 0,
      shortHandedPoints: 0,
      gameWinningGoal: false,
      overtimeGoal: false,
      timeOnIceMinutes: 14
    }),
    this.createGoalieTest('Connor Hellebuyck', 'Elite goalie win', {
      saves: 34,
      shotsAgainst: 36,
      won: true,
      shutout: false
    }),
    this.createGoalieTest('Average Goalie', 'Average starter win', {
      saves: 27,
      shotsAgainst: 30,
      won: true,
      shutout: false
    }),
    this.createGoalieTest('Bad Goalie Game', 'Rough goalie loss', {
      saves: 20,
      shotsAgainst: 25,
      won: false,
      shutout: false
    })
  ];

  private createSkaterTest(
    name: string,
    description: string,
    stats: SkaterGameStats
  ): ScoringTestCase {
    return {
      name,
      type: 'skater',
      description,
      points: calculateSkaterGamePoints(stats, defaultScoringRules)
    };
  }

  private createGoalieTest(
    name: string,
    description: string,
    stats: GoalieGameStats
  ): ScoringTestCase {
    return {
      name,
      type: 'goalie',
      description,
      points: calculateGoalieGamePoints(stats, defaultScoringRules)
    };
  }
}