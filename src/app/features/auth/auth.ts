import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { loginUser, registerUser } from '../../core/auth/auth.service';
import { requestPasswordResetEmail } from '../../core/notifications/email-notification.service';
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
  readonly isResettingPassword = signal(false);
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

  readonly pageTitle = computed(() => {
    if (this.isResettingPassword()) {
      return 'Reset Your Password';
    }

    return this.isRegistering() ? 'Create Your Franchise' : 'Enter the Rink';
  });

  readonly pageSubtitle = computed(() => {
    if (this.isResettingPassword()) {
      return 'Enter your account email and we will send a secure password-reset link.';
    }

    return this.isRegistering()
      ? 'Build your profile, choose your NHL club, and get ready for opening night.'
      : 'Sign in to manage your roster, follow your six-game windows, and chase the Cup.';
  });

  readonly cardLabel = computed(() => {
    if (this.isResettingPassword()) {
      return 'Account Recovery';
    }

    return this.isRegistering() ? 'New Manager Setup' : 'Manager Login';
  });

  readonly cardTitle = computed(() => {
    if (this.isResettingPassword()) {
      return 'Forgot Password';
    }

    return this.isRegistering() ? 'Create Account' : 'Welcome Back';
  });

  readonly submitLabel = computed(() => {
    if (this.loading()) {
      if (this.isResettingPassword()) {
        return 'Sending Reset Link...';
      }

      return this.isRegistering() ? 'Creating...' : 'Logging in...';
    }

    if (this.isResettingPassword()) {
      return 'Send Reset Link';
    }

    return this.isRegistering() ? 'Create Profile' : 'Login';
  });

  constructor(private router: Router) {}

  async submit(): Promise<void> {
    if (this.loading()) {
      return;
    }

    if (this.isResettingPassword()) {
      await this.submitPasswordReset();
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
          ? 'Profile created. Check your email to verify your address.'
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
    } catch (error: unknown) {
      this.errorMessage.set(this.getFriendlyAuthError(error));
      this.mascotCelebrating.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  private async submitPasswordReset(): Promise<void> {
    const normalizedEmail = this.email.trim();

    if (!normalizedEmail) {
      this.errorMessage.set('Enter the email address used for your account.');
      return;
    }

    this.errorMessage.set('');
    this.successMessage.set('');
    this.loading.set(true);

    try {
      await requestPasswordResetEmail(normalizedEmail);
      this.successMessage.set(
        'If an account exists for that email, a password-reset link has been sent. Check spam or junk folders too.',
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to send a reset link right now.',
      );
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
    this.isResettingPassword.set(false);
    this.favoriteTeamAbbreviation.set('');
    this.password = '';
    this.errorMessage.set('');
    this.successMessage.set('');
    this.loading.set(false);
    this.mascotCelebrating.set(false);
    applyUserTheme(loadStoredUserTheme(), { persist: false });
  }

  beginPasswordReset(): void {
    if (this.loading()) {
      return;
    }

    this.isRegistering.set(false);
    this.isResettingPassword.set(true);
    this.password = '';
    this.errorMessage.set('');
    this.successMessage.set('');
    this.mascotCelebrating.set(false);
  }

  returnToLogin(): void {
    if (this.loading()) {
      return;
    }

    this.isRegistering.set(false);
    this.isResettingPassword.set(false);
    this.password = '';
    this.errorMessage.set('');
    this.successMessage.set('');
  }

  private getFriendlyAuthError(error: unknown): string {
    const message = error instanceof Error ? error.message : '';

    if (message.includes('auth/invalid-credential')) {
      return 'The email or password is incorrect.';
    }

    if (message.includes('auth/email-already-in-use')) {
      return 'An account already exists for that email.';
    }

    if (message.includes('auth/weak-password')) {
      return 'Choose a stronger password with at least six characters.';
    }

    if (message.includes('auth/invalid-email')) {
      return 'Enter a valid email address.';
    }

    return message || 'Unable to continue right now.';
  }
}
