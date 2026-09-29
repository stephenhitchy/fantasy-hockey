import { Component, OnDestroy } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
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
import {
  NhlGameBoxscoreResponse,
  NhlGamePlayByPlayResponse,
  NhlGameTeamSummary,
  NhlGoalieBoxscoreLine,
  NhlSkaterBoxscoreLine,
  findGoalieBoxscoreLine,
  findSkaterBoxscoreLine,
  getGameBoxscore,
  getGamePlayByPlay,
} from '../../../core/nhl/nhl-api.service';

interface PlayerGameDisplay {
  id: string;
  date: string;
  opponent: string;
  result: string;
  statSummary: string;
  breakdown: GamePointBreakdown;
}

interface NhlSingleGamePlayerDisplay {
  playerId: number;
  gameId: number;
  name: string;
  position: string;
  sweaterNumber: number | null;
  teamAbbreviation: string;
  teamLogoUrl: string;
  headshotUrl: string;
  gameLabel: string;
  gameStatus: string;
  stats: Array<{ label: string; value: string }>;
  isGoalie: boolean;
}

@Component({
  selector: 'app-player-detail',
  imports: [RouterLink],
  templateUrl: './player-detail.html',
  styleUrl: './player-detail.css'
})
export class PlayerDetail implements OnDestroy {
  playerDetail: MockPlayerDetail | null = null;
  gameBreakdowns: PlayerGameDisplay[] = [];
  cycleTotal = 0;
  nhlGamePlayer: NhlSingleGamePlayerDisplay | null = null;
  nhlGameLoading = false;
  nhlGameError = '';
  private requestGeneration = 0;

  constructor(
    private route: ActivatedRoute,
    private location: Location
  ) {
    const playerId = Number(this.route.snapshot.paramMap.get('playerId'));
    const gameId = this.parseGameId(this.route.snapshot.queryParamMap.get('nhlGameId'));

    this.playerDetail = getMockPlayerDetail(playerId);

    if (this.playerDetail) {
      this.gameBreakdowns = this.createGameBreakdowns(this.playerDetail);
      this.cycleTotal = Number(
        this.gameBreakdowns
          .reduce((total, game) => total + game.breakdown.total, 0)
          .toFixed(2)
      );
      return;
    }

    if (Number.isSafeInteger(playerId) && playerId > 0 && gameId !== null) {
      void this.loadNhlSingleGamePlayer(playerId, gameId);
    }
  }

  ngOnDestroy(): void {
    this.requestGeneration += 1;
  }

  goBack() {
    this.location.back();
  }

  hideBrokenImage(event: Event): void {
    if (event.currentTarget instanceof HTMLImageElement) {
      event.currentTarget.hidden = true;
    }
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

  private async loadNhlSingleGamePlayer(playerId: number, gameId: number): Promise<void> {
    const generation = ++this.requestGeneration;
    this.nhlGameLoading = true;
    this.nhlGameError = '';

    const [boxscoreResult, playByPlayResult] = await Promise.allSettled([
      getGameBoxscore(gameId),
      getGamePlayByPlay(gameId),
    ]);

    if (generation !== this.requestGeneration) {
      return;
    }

    if (boxscoreResult.status === 'rejected') {
      this.nhlGameLoading = false;
      this.nhlGameError = 'This NHL player game could not be loaded.';
      return;
    }

    const boxscore = boxscoreResult.value;
    const playByPlay = playByPlayResult.status === 'fulfilled'
      ? playByPlayResult.value
      : null;
    const skater = findSkaterBoxscoreLine(boxscore, playerId);
    const goalie = skater ? null : findGoalieBoxscoreLine(boxscore, playerId);

    if (!skater && !goalie) {
      this.nhlGameLoading = false;
      this.nhlGameError = 'The NHL box score does not include this player.';
      return;
    }

    this.nhlGamePlayer = this.buildNhlSingleGamePlayer(
      playerId,
      gameId,
      skater,
      goalie,
      boxscore,
      playByPlay,
    );
    this.nhlGameLoading = false;
  }

  private buildNhlSingleGamePlayer(
    playerId: number,
    gameId: number,
    skater: NhlSkaterBoxscoreLine | null,
    goalie: NhlGoalieBoxscoreLine | null,
    boxscore: NhlGameBoxscoreResponse,
    playByPlay: NhlGamePlayByPlayResponse | null,
  ): NhlSingleGamePlayerDisplay {
    const player = skater ?? goalie as NhlGoalieBoxscoreLine;
    const team = this.findPlayerTeam(boxscore, playerId);
    const rosterSpot = playByPlay?.rosterSpots?.find((spot) => spot.playerId === playerId);
    const fullName = [rosterSpot?.firstName?.default, rosterSpot?.lastName?.default]
      .map((value) => value?.trim() ?? '')
      .filter(Boolean)
      .join(' ') || player.name.default;
    const away = boxscore.awayTeam?.abbrev ?? 'Away';
    const home = boxscore.homeTeam?.abbrev ?? 'Home';

    return {
      playerId,
      gameId,
      name: fullName,
      position: player.position,
      sweaterNumber: player.sweaterNumber ?? rosterSpot?.sweaterNumber ?? null,
      teamAbbreviation: team?.abbrev ?? '',
      teamLogoUrl: team?.logo ?? '',
      headshotUrl: rosterSpot?.headshot ?? '',
      gameLabel: `${away} at ${home}`,
      gameStatus: this.getNhlGameStatus(boxscore),
      stats: skater
        ? this.getSkaterStats(skater)
        : this.getGoalieStats(goalie as NhlGoalieBoxscoreLine),
      isGoalie: Boolean(goalie),
    };
  }

  private findPlayerTeam(
    boxscore: NhlGameBoxscoreResponse,
    playerId: number,
  ): NhlGameTeamSummary | null {
    for (const side of ['awayTeam', 'homeTeam'] as const) {
      const stats = boxscore.playerByGameStats?.[side];
      const players = [
        ...(stats?.forwards ?? []),
        ...(stats?.defense ?? []),
        ...(stats?.goalies ?? []),
      ];

      if (players.some((player) => player.playerId === playerId)) {
        return boxscore[side] ?? null;
      }
    }

    return null;
  }

  private getSkaterStats(player: NhlSkaterBoxscoreLine): Array<{ label: string; value: string }> {
    return [
      { label: 'Goals', value: String(player.goals) },
      { label: 'Assists', value: String(player.assists) },
      { label: 'Points', value: String(player.points) },
      { label: 'Shots', value: String(player.sog) },
      { label: 'TOI', value: player.toi || '—' },
      { label: '+/-', value: player.plusMinus > 0 ? `+${player.plusMinus}` : String(player.plusMinus) },
      { label: 'Hits', value: String(player.hits) },
      { label: 'Blocks', value: String(player.blockedShots) },
      { label: 'PIM', value: typeof player.pim === 'number' ? String(player.pim) : '—' },
      {
        label: 'Faceoffs',
        value: typeof player.faceoffWinningPctg === 'number'
          ? `${Math.round(player.faceoffWinningPctg * 100)}%`
          : '—',
      },
    ];
  }

  private getGoalieStats(player: NhlGoalieBoxscoreLine): Array<{ label: string; value: string }> {
    return [
      { label: 'Saves', value: String(player.saves) },
      { label: 'Shots against', value: String(player.shotsAgainst) },
      { label: 'Goals against', value: String(player.goalsAgainst) },
      {
        label: 'Save %',
        value: typeof player.savePctg === 'number'
          ? player.savePctg.toFixed(3).replace(/^0/, '')
          : '—',
      },
      { label: 'TOI', value: player.toi || '—' },
      { label: 'Decision', value: player.decision?.trim() || '—' },
    ];
  }

  private getNhlGameStatus(boxscore: NhlGameBoxscoreResponse): string {
    const state = (boxscore.gameState ?? '').toUpperCase();

    if (state === 'OFF' || state === 'FINAL') {
      const ending = (boxscore.gameOutcome?.lastPeriodType ?? '').toUpperCase();
      return ending && ending !== 'REG' ? `Final/${ending}` : 'Final';
    }

    if (state === 'LIVE' || state === 'CRIT') {
      const period = boxscore.periodDescriptor?.periodType === 'OT'
        ? 'OT'
        : `${boxscore.periodDescriptor?.number ?? ''}`;
      return boxscore.clock?.timeRemaining
        ? `${period} · ${boxscore.clock.timeRemaining}`
        : period || 'Live';
    }

    return 'Scheduled';
  }

  private parseGameId(value: string | null): number | null {
    if (!value || !/^\d{10}$/.test(value)) {
      return null;
    }

    const gameId = Number(value);
    return Number.isSafeInteger(gameId) && gameId > 0 ? gameId : null;
  }
}
