import { ActivatedRoute, Router } from '@angular/router';
import { getLeagueById, League } from '../../../core/league/league.service';
import { Component, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { FantasyTeam, getLeagueTeams } from '../../../core/team/team.service';

@Component({
  selector: 'app-league-detail',
  imports: [JsonPipe],
  templateUrl: './league-detail.html',
  styleUrl: './league-detail.css'
})

export class LeagueDetail {
  league = signal<League | null>(null);
  loading = signal(true);

  teams = signal<FantasyTeam[]>([]);
  copyMessage = signal('');

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
    const teams = await getLeagueTeams(leagueId);

    this.league.set(league);
    this.teams.set(teams);
    this.loading.set(false);

  }

  async copyInviteCode() {
  const code = this.league()?.inviteCode;

  if (!code) return;

  await navigator.clipboard.writeText(code);
  this.copyMessage.set('Invite code copied!');

  setTimeout(() => {
    this.copyMessage.set('');
  }, 2000);
  }
}

