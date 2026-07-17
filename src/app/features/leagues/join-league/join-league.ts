import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { auth } from '../../../core/firebase';
import { joinLeagueByInviteCode } from '../../../core/league/league.service';
import { getUserProfile } from '../../../core/user/user.service';
import { buildPixelMarquee, PixelLogoItem } from '../../../shared/pixel-theme/pixel-theme.data';

@Component({
  selector: 'app-join-league',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './join-league.html',
  styleUrl: './join-league.css'
})
export class JoinLeague {
  inviteCode = '';
  loading = signal(false);
  errorMessage = signal('');

  readonly topRibbon: PixelLogoItem[] = buildPixelMarquee(9);
  readonly bottomRibbon: PixelLogoItem[] = buildPixelMarquee(21);

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

      const leagueId = await joinLeagueByInviteCode(this.inviteCode, username);
      await this.router.navigate(['/leagues', leagueId]);
    } catch (error: any) {
      this.errorMessage.set(error?.message || 'Unable to join the league right now.');
    } finally {
      this.loading.set(false);
    }
  }
}
