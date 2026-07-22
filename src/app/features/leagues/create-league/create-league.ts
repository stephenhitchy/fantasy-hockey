import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { auth } from '../../../core/firebase';
import { createLeague } from '../../../core/league/league.service';
import { getUserProfile } from '../../../core/user/user.service';

@Component({
  selector: 'app-create-league',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './create-league.html',
  styleUrl: './create-league.css'
})
export class CreateLeague {
  name = '';
  maxTeams = 6;
  errorMessage = signal('');
  loading = signal(false);

  readonly teamOptions = computed(() => Array.from({ length: 11 }, (_, index) => index + 2));

  constructor(private router: Router) {}

  async submit(): Promise<void> {
    this.errorMessage.set('');
    this.loading.set(true);

    try {
      const user = auth.currentUser;

      if (!user) {
        throw new Error('You must be logged in.');
      }

      const profile = await getUserProfile(user.uid);
      const username = profile?.username || user.email || 'Unknown User';

      await createLeague(this.name, this.maxTeams, username);
      await this.router.navigate(['/dashboard']);
    } catch (error: any) {
      this.errorMessage.set(error?.message || 'Unable to create the league right now.');
    } finally {
      this.loading.set(false);
    }
  }
}
