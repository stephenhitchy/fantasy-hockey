import { Component } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import {
  calculateGoalieGameBreakdown,
  calculateSkaterGameBreakdown,
  GamePointBreakdown
} from '../../../core/scoring/scoring-engine';
import { defaultScoringRules } from '../../../core/scoring/scoring-rules';
import {
  getMockPlayerDetail,
  MockPlayerDetail
} from '../../../core/player/mock-player-data';

interface PlayerGameDisplay {
  id: string;
  date: string;
  opponent: string;
  result: string;
  statSummary: string;
  breakdown: GamePointBreakdown;
}

@Component({
  selector: 'app-player-detail',
  imports: [],
  templateUrl: './player-detail.html',
  styleUrl: './player-detail.css'
})
export class PlayerDetail {
  playerDetail: MockPlayerDetail | null = null;
  gameBreakdowns: PlayerGameDisplay[] = [];
  cycleTotal = 0;

  constructor(
    private route: ActivatedRoute,
    private location: Location
  ) {
    const playerId = Number(this.route.snapshot.paramMap.get('playerId'));

    this.playerDetail = getMockPlayerDetail(playerId);

    if (this.playerDetail) {
      this.gameBreakdowns = this.createGameBreakdowns(this.playerDetail);
      this.cycleTotal = Number(
        this.gameBreakdowns
          .reduce((total, game) => total + game.breakdown.total, 0)
          .toFixed(2)
      );
    }
  }

  goBack() {
    this.location.back();
  }

  private createGameBreakdowns(
    detail: MockPlayerDetail
  ): PlayerGameDisplay[] {
    return detail.gameLogs.map((game, index) => {
      if (game.type === 'skater') {
        const stats = game.stats;

        return {
          id: `${game.date}-${index}`,
          date: game.date,
          opponent: game.opponent,
          result: game.result,
          statSummary:
            `${stats.goals} G • ` +
            `${stats.primaryAssists + stats.secondaryAssists} A • ` +
            `${stats.shotsOnGoal} SOG • ` +
            `${stats.hits} HIT • ` +
            `${stats.blockedShots} BLK • ` +
            `${stats.timeOnIceMinutes} TOI`,
          breakdown: calculateSkaterGameBreakdown(
            stats,
            defaultScoringRules
          )
        };
      }

      const stats = game.stats;
      const savePercentage =
        stats.shotsAgainst > 0
          ? ((stats.saves / stats.shotsAgainst) * 100).toFixed(1)
          : '0.0';

      return {
        id: `${game.date}-${index}`,
        date: game.date,
        opponent: game.opponent,
        result: game.result,
        statSummary:
          `${stats.saves}/${stats.shotsAgainst} Saves • ` +
          `${savePercentage}% SV%` +
          (stats.won ? ' • Win' : '') +
          (stats.shutout ? ' • Shutout' : ''),
        breakdown: calculateGoalieGameBreakdown(
          stats,
          defaultScoringRules
        )
      };
    });
  }
}