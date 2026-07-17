import {
  Component,
  computed,
  signal
} from '@angular/core';

import {
  Router,
  RouterLink
} from '@angular/router';

import {
  onAuthStateChanged,
  User
} from 'firebase/auth';

import { auth } from '../../core/firebase';

import {
  getMyLeagueSummaries,
  LeagueSummary
} from '../../core/league/league.service';

import {
  getUserProfile,
  UserProfile
} from '../../core/user/user.service';

import {
  buildPixelMarquee,
  getPixelTeamTheme,
  PixelLogoItem
} from '../../shared/pixel-theme/pixel-theme.data';

import { applyUserTheme } from '../../core/user/user-theme.service';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class Dashboard {
  readonly leagueSummaries = signal<LeagueSummary[]>([]);
  readonly profile = signal<UserProfile | null>(null);
  readonly loading = signal(true);
  readonly errorMessage = signal('');
  readonly topRibbon: PixelLogoItem[] = buildPixelMarquee(6);
  readonly bottomRibbon: PixelLogoItem[] = buildPixelMarquee(19);


  readonly favoriteTeam = computed(() =>
    getPixelTeamTheme(this.profile()?.favoriteTeamAbbreviation)
  );

  readonly displayName = computed(() => {
    const profile = this.profile();
    const username = profile?.username?.trim();

    if (username) {
      return username;
    }

    const email = profile?.email?.trim();

    if (email) {
      return email.split('@')[0];
    }

    return 'Manager';
  });

  constructor(private router: Router) {
    void this.loadDashboard();
  }

  async loadDashboard(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');

    const user = await waitForAuthUser();

    if (!user) {
      await this.router.navigate(['/']);
      return;
    }

    try {
      const [profile, leagueSummaries] = await Promise.all([
        getUserProfile(user.uid),
        getMyLeagueSummaries()
      ]);

      this.profile.set(profile);
      this.leagueSummaries.set(leagueSummaries);

      if (profile) {
        applyUserTheme(profile);
      }
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load your fantasy hockey dashboard.'
      );
    } finally {
      this.loading.set(false);
    }
  }
}
