import { Component, computed, ElementRef, signal, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { loginUser, registerUser } from '../../core/auth/auth.service';
import { AuthSessionTimeoutError, withTimeout } from '../../core/auth/auth-session.service';
import { TelemetryService } from '../../core/observability/telemetry.service';
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
  imports: [FormsModule, RouterLink],
  templateUrl: './auth.html',
  styleUrl: './auth.css',
})
export class Auth {
  @ViewChild('usernameInput') private usernameInput?: ElementRef<HTMLInputElement>;
  @ViewChild('favoriteTeamGrid') private favoriteTeamGrid?: ElementRef<HTMLElement>;
  @ViewChild('emailInput') private emailInput?: ElementRef<HTMLInputElement>;
  @ViewChild('passwordInput') private passwordInput?: ElementRef<HTMLInputElement>;

  email = '';
  password = '';
  username = '';
  readonly favoriteTeamAbbreviation = signal('');
  readonly isRegistering = signal(false);
  readonly isResettingPassword = signal(false);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly loading = signal(false);
  readonly invalidField = signal<'username' | 'team' | 'email' | 'password' | ''>('');
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

  readonly passwordAutocomplete = computed(() =>
    this.isRegistering() ? 'new-password' : 'current-password',
  );

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private telemetry: TelemetryService,
  ) {
    const sessionReset = this.route.snapshot.queryParamMap.get('sessionReset');

    if (sessionReset === 'deleted-account') {
      this.successMessage.set(
        'The deleted account session was fully cleared. You can safely sign in to another account.',
      );

      if (typeof window !== 'undefined') {
        window.history.replaceState({}, '', '/');
      }
    }
  }

  async submit(): Promise<void> {
    if (this.loading()) {
      return;
    }

    if (!this.validateCurrentForm()) {
      return;
    }

    if (this.isResettingPassword()) {
      await this.submitPasswordReset();
      return;
    }

    this.errorMessage.set('');
    this.successMessage.set('');
    this.invalidField.set('');
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
      let profile = null;
      let profileLoadTimedOut = false;

      try {
        profile = await withTimeout(
          getUserProfile(user.uid),
          12_000,
          'Your account signed in, but the manager profile took too long to load.',
        );
        applyUserTheme(profile);
      } catch (error: unknown) {
        if (!(error instanceof AuthSessionTimeoutError)) {
          throw error;
        }

        profileLoadTimedOut = true;
        applyUserTheme(loadStoredUserTheme(), { persist: false });
      }

      this.mascotCelebrating.set(true);
      await new Promise((resolve) => setTimeout(resolve, 850));

      this.telemetry.track(
        this.isRegistering() ? 'registration_completed' : 'login_completed',
        {
          default_landing: profile?.defaultLandingPage === 'lastLeague' ? 'last_league' : 'dashboard',
        },
      );

      if (this.isRegistering()) {
        await this.router.navigate(['/training-camp']);
        return;
      }

      const returnUrl = this.safeReturnUrl();

      if (returnUrl) {
        await this.router.navigateByUrl(returnUrl);
        return;
      }

      const lastLeagueId = getRememberedLastLeagueId();
      const destination =
        !profileLoadTimedOut && profile?.defaultLandingPage === 'lastLeague' && lastLeagueId
          ? ['/leagues', lastLeagueId]
          : ['/dashboard'];

      await this.router.navigate(destination);
    } catch (error: unknown) {
      this.telemetry.track('auth_action_failed', {
        action: this.isRegistering() ? 'register' : 'login',
      });
      this.errorMessage.set(this.getFriendlyAuthError(error));
      this.mascotCelebrating.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  private async submitPasswordReset(): Promise<void> {
    const normalizedEmail = this.email.trim();

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
    this.invalidField.set('');
    this.errorMessage.set('');
    applyUserTheme(
      {
        ...loadStoredUserTheme(),
        favoriteTeamAbbreviation: team.abbreviation,
        favoriteTeamVariantId: 'current-home',
      },
      { persist: false },
    );
  }

  handleTeamGridKeydown(event: KeyboardEvent, currentTeam: PixelTeamTheme): void {
    const supportedKeys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];

    if (!supportedKeys.includes(event.key) || this.loading()) {
      return;
    }

    event.preventDefault();

    const currentIndex = this.teams.findIndex(
      (team) => team.abbreviation === currentTeam.abbreviation,
    );
    let nextIndex = currentIndex;

    if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = this.teams.length - 1;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % this.teams.length;
    } else {
      nextIndex = (currentIndex - 1 + this.teams.length) % this.teams.length;
    }

    const nextTeam = this.teams[nextIndex];

    if (!nextTeam) {
      return;
    }

    this.selectRegistrationTeam(nextTeam);

    window.requestAnimationFrame(() => {
      const buttons =
        this.favoriteTeamGrid?.nativeElement.querySelectorAll<HTMLButtonElement>('button');
      buttons?.[nextIndex]?.focus({ preventScroll: true });
    });
  }

  toggleMode(): void {
    const nextMode = !this.isRegistering();

    this.isRegistering.set(nextMode);
    this.isResettingPassword.set(false);
    this.favoriteTeamAbbreviation.set('');
    this.password = '';
    this.errorMessage.set('');
    this.successMessage.set('');
    this.invalidField.set('');
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
    this.invalidField.set('');
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
    this.invalidField.set('');
  }

  clearInvalidField(field: 'username' | 'email' | 'password'): void {
    if (this.invalidField() === field) {
      this.invalidField.set('');
      this.errorMessage.set('');
    }
  }

  private validateCurrentForm(): boolean {
    if (this.isRegistering() && this.username.trim().length < 2) {
      this.setValidationError(
        'username',
        'Enter a username with at least two characters.',
        this.usernameInput?.nativeElement,
      );
      return false;
    }

    if (this.isRegistering() && !this.favoriteTeamAbbreviation()) {
      const firstTeamButton =
        this.favoriteTeamGrid?.nativeElement.querySelector<HTMLButtonElement>('button');
      this.setValidationError(
        'team',
        'Choose your favorite NHL team to finish creating your profile.',
        firstTeamButton ?? this.favoriteTeamGrid?.nativeElement,
      );
      return false;
    }

    const normalizedEmail = this.email.trim();
    const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);

    if (!normalizedEmail || !emailLooksValid) {
      this.setValidationError(
        'email',
        normalizedEmail
          ? 'Enter a valid email address.'
          : 'Enter the email address used for your account.',
        this.emailInput?.nativeElement,
      );
      return false;
    }

    if (this.isResettingPassword()) {
      return true;
    }

    const minimumPasswordLength = this.isRegistering() ? 6 : 1;

    if (this.password.length < minimumPasswordLength) {
      this.setValidationError(
        'password',
        this.isRegistering()
          ? 'Choose a password with at least six characters.'
          : 'Enter your password.',
        this.passwordInput?.nativeElement,
      );
      return false;
    }

    return true;
  }

  private setValidationError(
    field: 'username' | 'team' | 'email' | 'password',
    message: string,
    focusTarget?: HTMLElement,
  ): void {
    this.invalidField.set(field);
    this.successMessage.set('');
    this.errorMessage.set(message);

    if (focusTarget && typeof window !== 'undefined') {
      window.requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
    }
  }

  private safeReturnUrl(): string {
    const candidate = this.route.snapshot.queryParamMap.get('returnUrl')?.trim() ?? '';

    if (!candidate.startsWith('/') || candidate.startsWith('//')) {
      return '';
    }

    if (candidate === '/' || candidate.startsWith('/privacy') || candidate.startsWith('/terms')) {
      return '';
    }

    return candidate;
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

    if (error instanceof AuthSessionTimeoutError) {
      return `${error.message} The old session was closed. Try again, or open RinkRat in a new tab.`;
    }

    return message || 'Unable to continue right now.';
  }
}
