import { Component, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import {
  getLeagueById,
  League
} from '../../../core/league/league.service';

import {
  FantasyTeam,
  getLeagueTeams
} from '../../../core/team/team.service';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-league-detail',
  imports: [RouterLink],
  templateUrl: './league-detail.html',
  styleUrl: './league-detail.css'
})
export class LeagueDetail {
  leagueId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);

  loading = signal(true);
  isCommissioner = signal(false);
  copyMessage = signal('');
  errorMessage = signal('');

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.loadLeague();
  }

  async loadLeague(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;

    try {
      const [league, teams] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId)
      ]);

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      this.league.set(league);
      this.teams.set(teams);
      this.isCommissioner.set(
        league.commissionerId === user.uid
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load this league.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  async copyInviteCode(): Promise<void> {
    const code = this.league()?.inviteCode;

    if (!code) {
      return;
    }

    await navigator.clipboard.writeText(code);

    this.copyMessage.set('Invite code copied!');

    setTimeout(() => {
      this.copyMessage.set('');
    }, 2000);
  }
}