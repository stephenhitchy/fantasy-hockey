import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { createLeague } from '../../../core/league/league.service';
import { getUserProfile } from '../../../core/user/user.service';
import { auth } from '../../../core/firebase';

@Component({
  selector: 'app-create-league',
  imports: [FormsModule],
  templateUrl: './create-league.html',
  styleUrl: './create-league.css'
})
export class CreateLeague {
  name = '';
  maxTeams = 6;
  errorMessage = signal('');
  loading = signal(false);

  constructor(private router: Router) {}

  async submit() {
    this.errorMessage.set('');
    this.loading.set(true);

    try {
      const user = auth.currentUser;

      if (!user) {
        throw new Error('You must be logged in.');
      }

      const profile = await getUserProfile(user.uid);
      const username = profile?.username || user.email || 'Unknown User';

      const leagueId = await createLeague(this.name, this.maxTeams, username);

      await this.router.navigate(['/dashboard']);
    } catch (error: any) {
      this.errorMessage.set(error.message);
    } finally {
      this.loading.set(false);
    }
  }
}