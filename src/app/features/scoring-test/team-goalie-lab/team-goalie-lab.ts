import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  getGameBoxscore,
  getRegularSeasonTeamGames,
  getTeamGoalieUnitResult,
  NhlTeamSeasonGame
} from '../../../core/nhl/nhl-api.service';

import {
  calculateGoalieGameBreakdown,
  GamePointBreakdown
} from '../../../core/scoring/scoring-engine';

import { defaultScoringRules } from '../../../core/scoring/scoring-rules';

interface TeamGoalieLabTeam {
  name: string;
  abbreviation: string;
  season: string;
}

interface TeamGoalieGameRow {
  gameId: number;
  date: string;
  matchup: string;
  goalieAppearances: string;
  saves: number;
  shotsAgainst: number;
  savePercentage: string;
  result: string;
  shutout: boolean;
  breakdown: GamePointBreakdown;
}

@Component({
  selector: 'app-team-goalie-lab',
  imports: [FormsModule],
  templateUrl: './team-goalie-lab.html',
  styleUrl: './team-goalie-lab.css'
})
export class TeamGoalieLab {
  teamName = 'Nashville Predators';
  teamAbbreviation = 'NSH';
  season = '20252026';

  loadedTeam = signal<TeamGoalieLabTeam | null>(null);
  teamGames = signal<NhlTeamSeasonGame[]>([]);
  gameRows = signal<TeamGoalieGameRow[]>([]);

  status = signal('');
  cyclePoints = signal(0);
  pointsPerGame = signal(0);

  async loadSixTeamGames(): Promise<void> {
    const team = this.getTeamFromForm();

    if (!team) {
      return;
    }

    this.loadedTeam.set(team);
    this.teamGames.set([]);
    this.gameRows.set([]);
    this.cyclePoints.set(0);
    this.pointsPerGame.set(0);

    this.status.set(`Loading six ${team.name} games...`);

    try {
      const games = await getRegularSeasonTeamGames(
        team.abbreviation,
        team.season
      );

      const sixGames = games.slice(0, 6);

      this.teamGames.set(sixGames);
      this.status.set(
        `Loaded ${sixGames.length} completed ${team.name} games.`
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown NHL API error';

      this.status.set(message);
    }
  }

  async scoreTeamGoalieUnit(): Promise<void> {
    const team = this.loadedTeam();
    const games = this.teamGames();

    if (!team || games.length === 0) {
      this.status.set('Load the team games first.');
      return;
    }

    this.status.set(
      `Scoring the ${team.name} goalie unit across six team games...`
    );

    this.gameRows.set([]);
    this.cyclePoints.set(0);
    this.pointsPerGame.set(0);

    try {
      const rows = await Promise.all(
        games.map(async (game) => {
          const boxscore = await getGameBoxscore(game.id);

          const unit = getTeamGoalieUnitResult(
            boxscore,
            team.abbreviation
          );

          if (!unit) {
            throw new Error(
              `No active ${team.abbreviation} goalie was found for game ${game.id}.`
            );
          }

          const isHome = game.homeTeam.abbrev === team.abbreviation;

          const breakdown = calculateGoalieGameBreakdown(
            {
              saves: unit.saves,
              shotsAgainst: unit.shotsAgainst,
              won: unit.won,
              shutout: unit.shutout
            },
            defaultScoringRules
          );

          return {
            gameId: game.id,
            date: game.gameDate,
            matchup: `${isHome ? 'vs' : '@'} ${unit.opponentAbbreviation}`,
            goalieAppearances: unit.goalies
              .map((goalie) => {
                const role = goalie.starter ? 'Starter' : 'Relief';

                return `${goalie.name} (${role}, ${goalie.saves}/${goalie.shotsAgainst})`;
              })
              .join(' • '),
            saves: unit.saves,
            shotsAgainst: unit.shotsAgainst,
            savePercentage:
              unit.shotsAgainst > 0
                ? (unit.saves / unit.shotsAgainst).toFixed(3)
                : '0.000',
            result: `${unit.won ? 'W' : 'L'} ${unit.teamScore}-${unit.opponentScore}`,
            shutout: unit.shutout,
            breakdown
          };
        })
      );

      const total = rows.reduce(
        (sum, game) => sum + game.breakdown.total,
        0
      );

      this.gameRows.set(rows);
      this.cyclePoints.set(Number(total.toFixed(2)));
      this.pointsPerGame.set(
        Number((total / rows.length).toFixed(2))
      );

      this.status.set(
        `Scored ${rows.length} ${team.name} goalie-unit games.`
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';

      this.status.set(message);
    }
  }

  private getTeamFromForm(): TeamGoalieLabTeam | null {
    const name = this.teamName.trim();
    const abbreviation = this.teamAbbreviation.trim().toUpperCase();
    const season = this.season.trim();

    if (!name) {
      this.status.set('Enter a team name.');
      return null;
    }

    if (!/^[A-Z]{3}$/.test(abbreviation)) {
      this.status.set('Use a three-letter team abbreviation, such as NSH.');
      return null;
    }

    if (!/^\d{8}$/.test(season)) {
      this.status.set(
        'Season must use the format YYYYYYYY, such as 20252026.'
      );
      return null;
    }

    return {
      name,
      abbreviation,
      season
    };
  }
}