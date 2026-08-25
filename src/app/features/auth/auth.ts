import { Component, computed, ElementRef, OnDestroy, signal, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { loginUser, registerUser } from '../../core/auth/auth.service';
import {
  AuthSessionTimeoutError,
  waitForAuthState,
  withTimeout,
} from '../../core/auth/auth-session.service';
import {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  PasswordPolicyEvaluation,
  evaluatePasswordAgainstFallbackPolicy,
  formatMissingPasswordRequirements,
  passwordMeetsRegistrationPolicy,
  passwordRequirementSummary,
} from '../../core/auth/auth-security.config';
import { validateRegistrationPassword } from '../../core/auth/password-policy.service';
import { TelemetryService } from '../../core/observability/telemetry.service';
import { requestPasswordResetEmail } from '../../core/notifications/email-notification.service';
import {
  bindPendingLeagueInviteToAccount,
  buildLeagueInvitePath,
  clearPendingLeagueInvite,
  markPendingLeagueInviteRequiresTrainingCamp,
  pendingLeagueInviteAccountMatch,
  readPendingLeagueInvite,
} from '../../core/league/invite-link-intent.service';
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
  RINKRAT_NEUTRAL_ABBREVIATION,
  RINKRAT_NEUTRAL_THEME,
} from '../../shared/pixel-theme/pixel-theme.data';
import { Navbar } from '../../shared/navbar/navbar';
import {
  DEFAULT_HOCKEY_EXPERIENCE_LEVEL,
  HOCKEY_EXPERIENCE_OPTIONS,
  HockeyExperienceLevel,
} from '../../shared/hockey-terms/hockey-terms.data';

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [FormsModule, RouterLink, Navbar],
  templateUrl: './auth.html',
  styleUrl: './auth.css',
})
export class Auth implements OnDestroy {
  @ViewChild('usernameInput') private usernameInput?: ElementRef<HTMLInputElement>;
  @ViewChild('favoriteTeamGrid') private favoriteTeamGrid?: ElementRef<HTMLElement>;
  @ViewChild('emailInput') private emailInput?: ElementRef<HTMLInputElement>;
  @ViewChild('passwordInput') private passwordInput?: ElementRef<HTMLInputElement>;

  email = '';
  password = '';
  username = '';
  readonly favoriteTeamAbbreviation = signal(RINKRAT_NEUTRAL_ABBREVIATION);
  readonly hockeyExperience = signal<HockeyExperienceLevel>(
    DEFAULT_HOCKEY_EXPERIENCE_LEVEL,
  );
  readonly isRegistering = signal(false);
  readonly isResettingPassword = signal(false);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly loading = signal(false);
  readonly invalidField = signal<'username' | 'team' | 'email' | 'password' | ''>('');
  readonly mascotCelebrating = signal(false);
  readonly pendingInviteCode = signal('');
  readonly inviteContinuationActive = computed(() => Boolean(this.pendingInviteCode()));
  readonly passwordPolicyChecking = signal(false);
  readonly passwordPolicyEvaluation = signal<PasswordPolicyEvaluation>(
    evaluatePasswordAgainstFallbackPolicy(''),
  );
  private passwordPolicyTimer: ReturnType<typeof setTimeout> | null = null;
  private passwordPolicySequence = 0;

  readonly teams: PixelTeamTheme[] = NHL_PIXEL_TEAMS;
  readonly neutralTheme = RINKRAT_NEUTRAL_THEME;
  readonly hockeyExperienceOptions = HOCKEY_EXPERIENCE_OPTIONS;
  readonly teamRibbon: PixelLogoItem[] = buildFullPixelMarquee();

  readonly selectedRegistrationTeam = computed(() => {
    const abbreviation = this.favoriteTeamAbbreviation();
    return getPixelTeamTheme(abbreviation);
  });

  readonly pageTitle = computed(() => {
    if (this.isResettingPassword()) {
      return 'Reset Your Password';
    }

    return this.isRegistering() ? 'Build Your RinkRat Team' : 'Enter the Rink';
  });

  readonly pageSubtitle = computed(() => {
    if (this.isResettingPassword()) {
      return 'Enter your account email and we will send a secure password-reset link.';
    }

    return this.isRegistering()
      ? 'Fair fantasy hockey, six games at a time—even if you are still learning the sport.'
      : 'Sign in to manage your roster, follow each six-game matchup, and chase the Cup.';
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

    if (this.isRegistering() && this.password && !this.passwordRegistrationReady()) {
      return 'Complete Password Requirements';
    }

    return this.isRegistering() ? 'Create Profile' : 'Login';
  });

  readonly passwordAutocomplete = computed(() =>
    this.isRegistering() ? 'new-password' : 'current-password',
  );

  readonly passwordRequirementText = passwordRequirementSummary();
  readonly passwordRequirements = computed(() =>
    this.passwordPolicyEvaluation().requirements,
  );
  readonly passwordRequirementsMetCount = computed(() =>
    this.passwordRequirements().filter((requirement) => requirement.met).length,
  );
  readonly passwordRequirementsTotalCount = computed(() =>
    this.passwordRequirements().filter((requirement) => requirement.required).length,
  );
  readonly passwordPolicySummary = computed(() => {
    const evaluation = this.passwordPolicyEvaluation();

    if (!this.password) {
      return 'Complete each requirement below before creating your account.';
    }

    if (evaluation.isValid) {
      return evaluation.source === 'firebase'
        ? 'Your password meets the live Firebase requirements.'
        : 'Your password meets the RinkRat production requirements.';
    }

    return `Still needed: ${formatMissingPasswordRequirements(evaluation)}.`;
  });

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private telemetry: TelemetryService,
  ) {
    const pendingInvite = readPendingLeagueInvite();
    this.pendingInviteCode.set(pendingInvite?.inviteCode ?? '');

    const sessionReset = this.route.snapshot.queryParamMap.get('sessionReset');

    if (sessionReset === 'deleted-account') {
      this.successMessage.set(
        'The deleted account session was fully cleared. You can safely sign in to another account.',
      );

      if (typeof window !== 'undefined') {
        window.history.replaceState({}, '', '/');
      }
    } else if (pendingInvite) {
      void this.resumeSignedInInviteIfAvailable();
    }
  }

  ngOnDestroy(): void {
    if (this.passwordPolicyTimer !== null) {
      clearTimeout(this.passwordPolicyTimer);
      this.passwordPolicyTimer = null;
    }

    this.passwordPolicySequence += 1;
  }

  async submit(): Promise<void> {
    if (this.loading()) {
      return;
    }

    if (!this.validateCurrentForm()) {
      return;
    }

    if (this.isRegistering() && !(await this.confirmRegistrationPasswordPolicy())) {
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
            this.hockeyExperience(),
          )
        : await loginUser(this.email, this.password);

      this.successMessage.set(
        this.isRegistering()
          ? 'Profile created. Opening Training Camp before email verification...'
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

      const pendingInvite = readPendingLeagueInvite();

      if (pendingInvite) {
        const accountMatch = pendingLeagueInviteAccountMatch(pendingInvite, user.uid);
        const boundIntent = this.isRegistering()
          ? bindPendingLeagueInviteToAccount(user.uid, {
              inviteCode: pendingInvite.inviteCode,
              allowAccountSwitch: true,
            })
          : accountMatch === 'mismatch'
            ? null
            : bindPendingLeagueInviteToAccount(user.uid, {
                inviteCode: pendingInvite.inviteCode,
              });
        const invitePath = buildLeagueInvitePath(pendingInvite.inviteCode);

        if (this.isRegistering() && boundIntent) {
          markPendingLeagueInviteRequiresTrainingCamp(
            user.uid,
            pendingInvite.inviteCode,
          );
          await this.router.navigate(['/training-camp'], {
            queryParams: { continue: 'league-invite' },
          });
          return;
        }

        if (invitePath) {
          await this.router.navigateByUrl(invitePath);
          return;
        }
      }

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

  passwordRegistrationReady(): boolean {
    return this.passwordPolicyEvaluation().isValid;
  }

  handlePasswordChange(value: string): void {
    this.password = value;
    this.clearInvalidField('password');
    this.passwordPolicyEvaluation.set(evaluatePasswordAgainstFallbackPolicy(value));
    this.passwordPolicyChecking.set(false);

    if (this.passwordPolicyTimer !== null) {
      clearTimeout(this.passwordPolicyTimer);
      this.passwordPolicyTimer = null;
    }

    const sequence = ++this.passwordPolicySequence;

    if (!this.isRegistering() || value.length === 0) {
      return;
    }

    this.passwordPolicyTimer = setTimeout(() => {
      this.passwordPolicyTimer = null;
      void this.refreshPasswordPolicy(value, sequence);
    }, 300);
  }

  private async refreshPasswordPolicy(
    password: string,
    sequence: number,
  ): Promise<PasswordPolicyEvaluation> {
    this.passwordPolicyChecking.set(true);
    const evaluation = await validateRegistrationPassword(password);

    if (sequence === this.passwordPolicySequence && password === this.password) {
      this.passwordPolicyEvaluation.set(evaluation);
      this.passwordPolicyChecking.set(false);
    }

    return evaluation;
  }

  private async confirmRegistrationPasswordPolicy(): Promise<boolean> {
    const sequence = ++this.passwordPolicySequence;

    if (this.passwordPolicyTimer !== null) {
      clearTimeout(this.passwordPolicyTimer);
      this.passwordPolicyTimer = null;
    }

    const evaluation = await this.refreshPasswordPolicy(this.password, sequence);

    if (sequence !== this.passwordPolicySequence) {
      return false;
    }

    if (evaluation.isValid) {
      return true;
    }

    this.setValidationError(
      'password',
      `Update your password before continuing. It still needs ${formatMissingPasswordRequirements(evaluation)}.`,
      this.passwordInput?.nativeElement,
    );
    return false;
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
        hockeyExperience: this.hockeyExperience(),
      },
      { persist: false },
    );
  }

  selectHockeyExperience(level: HockeyExperienceLevel): void {
    if (this.loading()) {
      return;
    }

    this.hockeyExperience.set(level);
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

  async cancelInviteContinuation(): Promise<void> {
    clearPendingLeagueInvite(this.pendingInviteCode());
    this.pendingInviteCode.set('');

    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { invite: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  toggleMode(): void {
    const nextMode = !this.isRegistering();

    this.isRegistering.set(nextMode);
    this.isResettingPassword.set(false);
    this.favoriteTeamAbbreviation.set(RINKRAT_NEUTRAL_ABBREVIATION);
    this.hockeyExperience.set(DEFAULT_HOCKEY_EXPERIENCE_LEVEL);
    this.password = '';
    this.passwordPolicyEvaluation.set(evaluatePasswordAgainstFallbackPolicy(''));
    this.passwordPolicyChecking.set(false);
    this.errorMessage.set('');
    this.successMessage.set('');
    this.invalidField.set('');
    this.loading.set(false);
    this.mascotCelebrating.set(false);
    applyUserTheme(
      {
        ...loadStoredUserTheme(),
        favoriteTeamAbbreviation: RINKRAT_NEUTRAL_ABBREVIATION,
        favoriteTeamVariantId: 'current-home',
        hockeyExperience: DEFAULT_HOCKEY_EXPERIENCE_LEVEL,
      },
      { persist: false },
    );
  }

  beginPasswordReset(): void {
    if (this.loading()) {
      return;
    }

    this.isRegistering.set(false);
    this.isResettingPassword.set(true);
    this.password = '';
    this.passwordPolicyEvaluation.set(evaluatePasswordAgainstFallbackPolicy(''));
    this.passwordPolicyChecking.set(false);
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
    this.passwordPolicyEvaluation.set(evaluatePasswordAgainstFallbackPolicy(''));
    this.passwordPolicyChecking.set(false);
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

    if (!this.password) {
      this.setValidationError(
        'password',
        this.isRegistering()
          ? 'Create a password and complete every highlighted requirement.'
          : 'Enter your password.',
        this.passwordInput?.nativeElement,
      );
      return false;
    }

    if (this.isRegistering() && !passwordMeetsRegistrationPolicy(this.password)) {
      const evaluation = evaluatePasswordAgainstFallbackPolicy(this.password);
      this.passwordPolicyEvaluation.set(evaluation);
      this.setValidationError(
        'password',
        `Update your password before continuing. It still needs ${formatMissingPasswordRequirements(evaluation)}.`,
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

  private async resumeSignedInInviteIfAvailable(): Promise<void> {
    const user = await waitForAuthState(undefined, 8_000);
    const pendingInvite = readPendingLeagueInvite();

    if (!user || !pendingInvite || this.loading()) {
      return;
    }

    const accountMatch = pendingLeagueInviteAccountMatch(pendingInvite, user.uid);

    if (accountMatch === 'unbound') {
      bindPendingLeagueInviteToAccount(user.uid, {
        inviteCode: pendingInvite.inviteCode,
      });
    }

    const invitePath = buildLeagueInvitePath(pendingInvite.inviteCode);

    if (invitePath && readPendingLeagueInvite(pendingInvite.inviteCode)) {
      await this.router.navigateByUrl(invitePath);
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
      return 'Unable to create an account with that email. Try signing in or use password reset.';
    }

    if (message.includes('auth/weak-password')) {
      const evaluation = this.passwordPolicyEvaluation();
      const missing = formatMissingPasswordRequirements(evaluation);
      return missing
        ? `That password does not meet the account requirements. Add ${missing}.`
        : `That password does not meet the ${MINIMUM_PASSWORD_LENGTH}–${MAXIMUM_PASSWORD_LENGTH} character policy.`;
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
