import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { loginUser, registerUser } from '../../core/auth/auth.service';
import {
  applyUserTheme,
  getRememberedLastLeagueId,
  loadStoredUserTheme,
} from '../../core/user/user-theme.service';
import {
  buildFullPixelMarquee,
  getPixelTeamTheme,
  NHL_PIXEL_TEAMS,
  PixelLogoItem,
  PixelTeamTheme,
} from '../../shared/pixel-theme/pixel-theme.data';

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './auth.html',
  styleUrl: './auth.css',
})
export class Auth {
  email = '';
  password = '';
  username = '';
  readonly favoriteTeamAbbreviation = signal('');
  readonly isRegistering = signal(false);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly loading = signal(false);
  readonly mascotCelebrating = signal(false);

  readonly teams: PixelTeamTheme[] = NHL_PIXEL_TEAMS;
  readonly teamRibbon: PixelLogoItem[] = buildFullPixelMarquee();

  readonly selectedRegistrationTeam = computed(() => {
    const abbreviation = this.favoriteTeamAbbreviation();
    return abbreviation ? getPixelTeamTheme(abbreviation) : null;
  });

  readonly pageTitle = computed(() =>
    this.isRegistering() ? 'Create Your Franchise' : 'Enter the Rink',
  );

  readonly pageSubtitle = computed(() =>
    this.isRegistering()
      ? 'Build your profile, choose your NHL club, and get ready for opening night.'
      : 'Sign in to manage your roster, follow your six-game windows, and chase the Cup.',
  );

  readonly submitLabel = computed(() =>
    this.loading()
      ? this.isRegistering()
        ? 'Creating...'
        : 'Logging in...'
      : this.isRegistering()
        ? 'Create Profile'
        : 'Login',
  );

  constructor(private router: Router) {}

  async submit(): Promise<void> {
    if (this.loading()) {
      return;
    }

    if (this.isRegistering() && !this.favoriteTeamAbbreviation()) {
      this.errorMessage.set('Choose your favorite NHL team to finish creating your profile.');
      return;
    }

    this.errorMessage.set('');
    this.successMessage.set('');
    this.loading.set(true);
    this.mascotCelebrating.set(false);

    try {
      const user = this.isRegistering()
        ? await registerUser(
            this.email,
            this.password,
            this.username,
            this.favoriteTeamAbbreviation(),
          )
        : await loginUser(this.email, this.password);

      this.successMessage.set(
        this.isRegistering()
          ? 'Profile created. Welcome to the league!'
          : 'Login successful. Opening your manager home...',
      );

      const { getUserProfile } = await import('../../core/user/user.service');
      const profile = await getUserProfile(user.uid);
      applyUserTheme(profile);

      this.mascotCelebrating.set(true);
      await new Promise((resolve) => setTimeout(resolve, 850));

      const lastLeagueId = getRememberedLastLeagueId();
      const destination =
        profile?.defaultLandingPage === 'lastLeague' && lastLeagueId
          ? ['/leagues', lastLeagueId]
          : ['/dashboard'];

      await this.router.navigate(destination);
    } catch (error: any) {
      this.errorMessage.set(error?.message || 'Unable to continue right now.');
      this.mascotCelebrating.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  selectRegistrationTeam(team: PixelTeamTheme): void {
    if (this.loading()) {
      return;
    }

    this.favoriteTeamAbbreviation.set(team.abbreviation);
    this.errorMessage.set('');
    applyUserTheme(
      {
        ...loadStoredUserTheme(),
        favoriteTeamAbbreviation: team.abbreviation,
      },
      { persist: false },
    );
  }

  toggleMode(): void {
    const nextMode = !this.isRegistering();

    this.isRegistering.set(nextMode);
    this.favoriteTeamAbbreviation.set('');
    this.errorMessage.set('');
    this.successMessage.set('');
    this.loading.set(false);
    this.mascotCelebrating.set(false);
    applyUserTheme(loadStoredUserTheme(), { persist: false });
  }
}
