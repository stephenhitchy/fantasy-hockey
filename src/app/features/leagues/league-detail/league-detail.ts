import { ActivatedRoute, Router } from '@angular/router';
import { getLeagueById, League } from '../../../core/league/league.service';
import { Component, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';

@Component({
  selector: 'app-league-detail',
  imports: [JsonPipe],
  templateUrl: './league-detail.html',
  styleUrl: './league-detail.css'
})

export class LeagueDetail {
  league = signal<League | null>(null);
  loading = signal(true);

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.loadLeague();
  }

  async loadLeague() {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');

    if (!leagueId) {
      await this.router.navigate(['/dashboard']);
      return;
    }

    const league = await getLeagueById(leagueId);
    this.league.set(league);
    this.loading.set(false);
  }
}