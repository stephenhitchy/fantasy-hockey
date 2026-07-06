import { Component, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  findSkaterBoxscoreLine,
  getGameBoxscore,
  getGamePlayByPlay,
  getRegularSeasonGameLog,
  getSkaterAssistBreakdown,
  NhlPlayerGameLogEntry
} from '../../core/nhl/nhl-api.service';
import {
  calculateGoalieGamePoints,
  calculateSkaterGameBreakdown,
  calculateSkaterGamePoints,
  type GamePointBreakdown,
  type GoalieGameStats,
  type SkaterGameStats
} from '../../core/scoring/scoring-engine';
import { defaultScoringRules } from '../../core/scoring/scoring-rules';

type SkaterPosition = 'F' | 'D';

interface ScoringTestCase {
  name: string;
  type: 'skater' | 'goalie';
  description: string;
  points: number;
}

interface LabPlayer {
  id: number;
  name: string;
  position: SkaterPosition;
  season: string;
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
  playerCredit: string;
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
  imports: [FormsModule, JsonPipe],
  templateUrl: './scoring-test.html',
  styleUrl: './scoring-test.css'
})
export class ScoringTest {
  playerId = 8478402;
  playerName = 'Connor McDavid';
  playerPosition: SkaterPosition = 'F';
  season = '20252026';

  loadedPlayer = signal<LabPlayer | null>(null);

  apiStatus = signal('');
  apiGames = signal<NhlPlayerGameLogEntry[]>([]);

  realStatsStatus = signal('');
  realStatRows = signal<RealSkaterGameRow[]>([]);
  realCyclePoints = signal(0);
  realPointsPerGame = signal(0);

  playByPlayStatus = signal('');
  playByPlayEvents = signal<unknown[]>([]);
  goalEventRows = signal<GoalEventRow[]>([]);

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

  async loadPlayerGameLog(): Promise<void> {
    const player = this.getPlayerFromForm();

    if (!player) {
      return;
    }

    this.resetLabResults();
    this.loadedPlayer.set(player);
    this.apiStatus.set(`Loading ${player.name}'s NHL game log...`);

    try {
      const response = await getRegularSeasonGameLog(
        player.id,
        player.season
      );

      const games = Array.isArray(response.gameLog)
        ? response.gameLog.slice(0, 6)
        : [];

      this.apiGames.set(games);
      this.apiStatus.set(
        `Loaded ${games.length} games for ${player.name}.`
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown NHL API error';

      this.apiStatus.set(message);
    }
  }

  async loadPlayerFullStatsAndScore(): Promise<void> {
    const player = this.loadedPlayer();
    const games = this.apiGames();

    if (!player || games.length === 0) {
      this.realStatsStatus.set('Load a player game log first.');
      return;
    }

    this.realStatsStatus.set(
      `Loading and scoring ${player.name}'s six-game sample...`
    );

    this.realStatRows.set([]);
    this.realCyclePoints.set(0);
    this.realPointsPerGame.set(0);

    try {
      const rows = await Promise.all(
        games.map(async (game) => {
          const [boxscore, playByPlay] = await Promise.all([
            getGameBoxscore(game.gameId),
            getGamePlayByPlay(game.gameId)
          ]);

          const playerLine = findSkaterBoxscoreLine(
            boxscore,
            player.id
          );

          if (!playerLine) {
            throw new Error(
              `${player.name} was not found in boxscore ${game.gameId}.`
            );
          }

          const assists = getSkaterAssistBreakdown(
            playByPlay,
            player.id
          );

          const stats: SkaterGameStats = {
            position: player.position,
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
      this.realPointsPerGame.set(
        rows.length > 0
          ? Number((cyclePoints / rows.length).toFixed(2))
          : 0
      );

      this.realStatsStatus.set(
        `Loaded and scored ${rows.length} real games for ${player.name}.`
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';

      this.realStatsStatus.set(message);
    }
  }

  async loadAssistAudit(): Promise<void> {
    const player = this.loadedPlayer();
    const games = this.apiGames();

    if (!player || games.length === 0) {
      this.playByPlayStatus.set('Load a player game log first.');
      return;
    }

    const gameToInspect =
      games.find((game) => game.assists > 0) ?? games[0];

    this.playByPlayStatus.set(
      `Loading assist audit for ${player.name} on ${gameToInspect.gameDate}...`
    );

    this.playByPlayEvents.set([]);
    this.goalEventRows.set([]);

    try {
      const response = await getGamePlayByPlay(gameToInspect.gameId);

      const plays = Array.isArray(response.plays)
        ? response.plays
        : [];

      const goalRows = plays
        .filter(isGoalPlay)
        .map((play) => {
          const details = play.details ?? {};

          let playerCredit = 'No player credit';

          if (details.scoringPlayerId === player.id) {
            playerCredit = `${player.name} scored`;
          } else if (details.assist1PlayerId === player.id) {
            playerCredit = `${player.name}: Assist 1`;
          } else if (details.assist2PlayerId === player.id) {
            playerCredit = `${player.name}: Assist 2`;
          }

          return {
            eventId: play.eventId,
            period: play.periodDescriptor?.number ?? null,
            time: play.timeInPeriod ?? '--:--',
            scorerId: details.scoringPlayerId ?? null,
            assist1Id: details.assist1PlayerId ?? null,
            assist2Id: details.assist2PlayerId ?? null,
            playerCredit
          };
        });

      this.playByPlayEvents.set(plays);
      this.goalEventRows.set(goalRows);

      this.playByPlayStatus.set(
        `Loaded ${goalRows.length} goal events from ${gameToInspect.gameDate}.`
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown play-by-play error';

      this.playByPlayStatus.set(message);
    }
  }

  private getPlayerFromForm(): LabPlayer | null {
    const id = Number(this.playerId);
    const name = this.playerName.trim();
    const season = this.season.trim();

    if (!Number.isInteger(id) || id <= 0) {
      this.apiStatus.set('Enter a valid NHL player ID.');
      return null;
    }

    if (!name) {
      this.apiStatus.set('Enter a player name.');
      return null;
    }

    if (!/^\d{8}$/.test(season)) {
      this.apiStatus.set(
        'Season must use the format YYYYYYYY, such as 20252026.'
      );
      return null;
    }

    return {
      id,
      name,
      position: this.playerPosition,
      season
    };
  }

  private resetLabResults(): void {
    this.apiGames.set([]);
    this.realStatRows.set([]);
    this.realCyclePoints.set(0);
    this.realPointsPerGame.set(0);
    this.realStatsStatus.set('');
    this.playByPlayEvents.set([]);
    this.goalEventRows.set([]);
    this.playByPlayStatus.set('');
  }

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