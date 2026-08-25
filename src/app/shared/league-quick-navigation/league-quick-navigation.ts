import { Component, Input } from '@angular/core';
import { RouterLink } from '@angular/router';

export type LeagueNavigationDestination =
  | 'league-hq'
  | 'players'
  | 'team'
  | 'matchup'
  | 'matchups'
  | 'schedule'
  | 'standings';

@Component({
  selector: 'app-league-quick-navigation',
  imports: [RouterLink],
  templateUrl: './league-quick-navigation.html',
  styleUrl: './league-quick-navigation.css',
})
export class LeagueQuickNavigation {
  @Input({ required: true }) leagueId = '';
  @Input() cycleNumber: number | null = null;
  @Input() currentMatchupRoute: Array<string | number> | string | null = null;
  @Input() currentDestination: LeagueNavigationDestination | null = null;
  @Input() compact = false;

  isCurrent(destination: LeagueNavigationDestination): boolean {
    return this.currentDestination === destination;
  }

  getCurrentMatchupRoute(): Array<string | number> | string | null {
    if (this.currentMatchupRoute) {
      return this.currentMatchupRoute;
    }

    return this.cycleNumber === null
      ? null
      : ['/leagues', this.leagueId, 'cycles', this.cycleNumber];
  }
}
