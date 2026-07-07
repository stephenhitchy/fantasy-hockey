import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';
import {
  FantasyTeam,
  getFantasyTeam,
  updateTeamName
} from '../../../core/team/team.service';

import {
  FantasyRoster
} from '../../../core/team/roster.models';

import {
  getOrCreateFantasyRoster
} from '../../../core/team/roster.service';

import { RosterBoard } from '../../../shared/roster-board/roster-board';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-team-settings',
  imports: [FormsModule, RosterBoard],
  templateUrl: './team-settings.html',
  styleUrl: './team-settings.css'
})
export class TeamSettings {
  leagueId = '';

  team = signal<FantasyTeam | null>(null);
  roster = signal<FantasyRoster | null>(null);

  teamName = '';
  loading = signal(true);
  saving = signal(false);
  errorMessage = signal('');
  successMessage = signal('');

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.loadTeam();
  }

  async loadTeam(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;

    try {
      const team = await getFantasyTeam(leagueId, user.uid);

      if (!team) {
        this.team.set(null);
        return;
      }

      const roster = await getOrCreateFantasyRoster(
        leagueId,
        user.uid
      );

      this.team.set(team);
      this.roster.set(roster);
      this.teamName = team.teamName;
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load this team.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  async saveTeamName(): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');

    const user = auth.currentUser;

    if (!user) {
      this.errorMessage.set('You must be logged in.');
      return;
    }

    if (!this.teamName.trim()) {
      this.errorMessage.set('Team name cannot be empty.');
      return;
    }

    this.saving.set(true);

    try {
      const updatedName = this.teamName.trim();

      await updateTeamName(this.leagueId, user.uid, updatedName);

      const currentTeam = this.team();

      if (currentTeam) {
        this.team.set({
          ...currentTeam,
          teamName: updatedName
        });
      }

      this.successMessage.set('Team name updated!');
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to update team name.'
      );
    } finally {
      this.saving.set(false);
    }
  }
}