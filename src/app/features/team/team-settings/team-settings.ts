import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { auth } from '../../../core/firebase';
import {
  FantasyTeam,
  getFantasyTeam,
  updateTeamName
} from '../../../core/team/team.service';
import { onAuthStateChanged, User } from 'firebase/auth';

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
  imports: [FormsModule],
  templateUrl: './team-settings.html',
  styleUrl: './team-settings.css'
})
export class TeamSettings {
  leagueId = '';
  team = signal<FantasyTeam | null>(null);
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

  async loadTeam() {

    
  const leagueId = this.route.snapshot.paramMap.get('leagueId');
  const user = await waitForAuthUser();

  if (!leagueId || !user) {
    await this.router.navigate(['/']);
    return;
  }

    this.leagueId = leagueId;

    const team = await getFantasyTeam(leagueId, user.uid);

    this.team.set(team);
    this.teamName = team?.teamName ?? '';
    this.loading.set(false);
  }

  async saveTeamName() {
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
      await updateTeamName(this.leagueId, user.uid, this.teamName.trim());

      const updatedTeam = this.team();
      if (updatedTeam) {
        this.team.set({
          ...updatedTeam,
          teamName: this.teamName.trim()
        });
      }

      this.successMessage.set('Team name updated!');
    } catch (error: any) {
      this.errorMessage.set(error.message);
    } finally {
      this.saving.set(false);
    }
  }
}