import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Timestamp } from 'firebase/firestore';
import { auth } from '../../../core/firebase';
import { logoutUser } from '../../../core/auth/auth.service';
import { resetBrowserAfterAccountDeletion } from '../../../core/auth/auth-session.service';
import {
  AccountDeletionReadiness,
  deleteCurrentUserAccount,
  getAccountDeletionReadiness,
  reauthenticateCurrentUserWithPassword,
} from '../../../core/auth/account-deletion.service';
import { requestVerificationEmail } from '../../../core/notifications/email-notification.service';
import { hasCompletedTrainingCamp } from '../../../core/onboarding/training-camp.service';
import {
  getMyLeagueSummaries,
  LeagueSummary,
  syncManagerNameAcrossLeagues,
} from '../../../core/league/league.service';
import {
  BackgroundTheme,
  DefaultLandingPage,
  getUserProfile,
  updateFavoriteTeam,
  updateUserAccountSettings,
  UserProfile,
} from '../../../core/user/user.service';
import { applyUserTheme } from '../../../core/user/user-theme.service';
import { TeamIdentityChallengeService } from '../../../core/user/team-identity-challenge.service';
import { TelemetryService } from '../../../core/observability/telemetry.service';
import { waitForAuthenticatedUser } from '../../../core/guards/auth.guard';
import {
  buildCustomTeamIdentityVariantId,
  CUSTOM_TEAM_IDENTITY_VARIANT_ID,
  DEFAULT_TEAM_IDENTITY_VARIANT_ID,
  getCustomTeamIdentityLogoOptions,
  getNhlLogoUrl,
  getPixelTeamTheme,
  getTeamIdentityVariants,
  isCustomTeamIdentityVariantId,
  normalizeTeamIdentityHexColor,
  parseCustomTeamIdentityVariantId,
  PixelTeamTheme,
  RINKRAT_NEUTRAL_ABBREVIATION,
  TEAM_IDENTITY_UNLOCK_DETAILS,
  TeamIdentityUnlockRequirement,
  USER_SELECTABLE_PIXEL_THEMES,
} from '../../../shared/pixel-theme/pixel-theme.data';
import {
  DEFAULT_HOCKEY_EXPERIENCE_LEVEL,
  HOCKEY_EXPERIENCE_OPTIONS,
  HockeyExperienceLevel,
  normalizeHockeyExperienceLevel,
} from '../../../shared/hockey-terms/hockey-terms.data';
interface AccountAchievement {
  icon: string;
  title: string;
  description: string;
  reward: string;
  unlockRequirement: TeamIdentityUnlockRequirement;
  unlocked: boolean;
}

const IDENTITY_UNLOCK_ORDER: Exclude<TeamIdentityUnlockRequirement, 'default'>[] = [
  'first-line-change',
  'commissioner-mode',
  'league-explorer',
  'crowded-schedule',
  'identity-architect',
];


@Component({
  selector: 'app-account-settings',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './account-settings.html',
  styleUrl: './account-settings.css',
})
export class AccountSettings {
  private readonly destroyRef = inject(DestroyRef);
  readonly profile = signal<UserProfile | null>(null);
  readonly leagueSummaries = signal<LeagueSummary[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly savingFavoriteTeam = signal(false);
  readonly customIdentityEditorOpen = signal(false);
  readonly sendingVerification = signal(false);
  readonly refreshingVerification = signal(false);
  readonly emailVerified = signal(false);
  readonly successMessage = signal('');
  readonly errorMessage = signal('');
  readonly deleteAccountPanelOpen = signal(false);
  readonly loadingDeletionReadiness = signal(false);
  readonly deletingAccount = signal(false);
  readonly deletionReadiness = signal<AccountDeletionReadiness | null>(null);
  readonly deletionErrorMessage = signal('');
  readonly unlockedIdentityRequirements = signal<
    Exclude<TeamIdentityUnlockRequirement, 'default'>[]
  >([]);

  username = '';
  favoriteTeamAbbreviation = RINKRAT_NEUTRAL_ABBREVIATION;
  favoriteTeamVariantId = DEFAULT_TEAM_IDENTITY_VARIANT_ID;
  hockeyExperience: HockeyExperienceLevel = DEFAULT_HOCKEY_EXPERIENCE_LEVEL;
  reducedMotion = false;
  defaultLandingPage: DefaultLandingPage = 'dashboard';
  injuryEmailEnabled = false;
  backgroundTheme: BackgroundTheme = 'rink-dark';
  customLogoVariantId = DEFAULT_TEAM_IDENTITY_VARIANT_ID;
  customPrimaryColor = '#26384C';
  customSecondaryColor = '#D6E2EE';
  customTertiaryColor = '#C94F5D';
  deleteConfirmationUsername = '';
  deletePassword = '';
  deleteAcknowledged = false;

  readonly teams: PixelTeamTheme[] = USER_SELECTABLE_PIXEL_THEMES;
  readonly hockeyExperienceOptions = HOCKEY_EXPERIENCE_OPTIONS;
  readonly backgroundOptions: { value: BackgroundTheme; title: string; description: string }[] = [
    { value: 'rink-dark', title: 'Rink Dark', description: 'Neutral graphite with classic arena contrast.' },
    { value: 'oled-black', title: 'OLED Black', description: 'Deep black surfaces for a sharper, high-contrast look.' },
    { value: 'ice-gray', title: 'Ice Gray', description: 'Cool gray panels with a slightly brighter rink feel.' },
    { value: 'light-ice', title: 'Light Ice', description: 'Bright ice background with darker text and accents.' },
  ];


  selectedTeam(): PixelTeamTheme {
    return getPixelTeamTheme(
      this.favoriteTeamAbbreviation,
      this.favoriteTeamVariantId,
    );
  }

  availableTeamVariants(): PixelTeamTheme[] {
    return getTeamIdentityVariants(this.favoriteTeamAbbreviation);
  }

  isNeutralIdentity(): boolean {
    return this.favoriteTeamAbbreviation === RINKRAT_NEUTRAL_ABBREVIATION;
  }

  selectedIdentityBadge(): string {
    return this.isNeutralIdentity()
      ? 'RinkRat · Neutral'
      : `${this.selectedTeam().abbreviation} · ${this.selectedTeam().variantShortLabel}`;
  }

  managerInitials(): string {
    const username = this.username.trim() || this.profile()?.username?.trim() || 'Manager';
    const parts = username.split(/\s+/).filter(Boolean).slice(0, 2);
    return parts.map((part) => part.charAt(0).toUpperCase()).join('') || 'M';
  }

  readonly leagueCount = computed(() => this.leagueSummaries().length);
  readonly commissionerLeagueCount = computed(
    () => this.leagueSummaries().filter((league) => league.isCommissioner).length,
  );
  readonly opponentCount = computed(() =>
    this.leagueSummaries().reduce((sum, league) => sum + Math.max(0, league.teamCount - 1), 0),
  );
  readonly totalTeamSlots = computed(() =>
    this.leagueSummaries().reduce((sum, league) => sum + league.teamCount, 0),
  );

  readonly trainingCampComplete = computed(() => hasCompletedTrainingCamp(this.profile()));
  readonly accountDeletionBlocked = computed(
    () => (this.deletionReadiness()?.commissionerLeagues.length ?? 0) > 0,
  );

  readonly achievements = computed<AccountAchievement[]>(() => [
    this.buildAchievement('rat', 'first-line-change'),
    this.buildAchievement('draft', 'commissioner-mode'),
    this.buildAchievement('arena', 'league-explorer'),
    this.buildAchievement('league', 'crowded-schedule'),
    this.buildAchievement('team', 'identity-architect'),
  ]);

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private telemetry: TelemetryService,
    private challengeService: TeamIdentityChallengeService,
  ) {
    this.route.fragment
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((fragment) => {
        if (fragment === 'team-identity-customizer' && !this.loading()) {
          this.focusRequestedIdentitySection(fragment);
        }
      });

    this.destroyRef.onDestroy(() => {
      if (this.customIdentityEditorOpen()) {
        this.previewPreferenceChanges();
      }
    });

    void this.loadProfile();
  }

  async loadProfile(): Promise<void> {
    const user = await waitForAuthenticatedUser();

    if (!user) {
      await this.router.navigate(['/']);
      return;
    }

    try {
      await user.reload();
      this.emailVerified.set(user.emailVerified);

      const [profile, summaries, reconciledUnlocks] = await Promise.all([
        getUserProfile(user.uid),
        getMyLeagueSummaries(),
        this.challengeService.refresh(user.uid, { force: true }),
      ]);

      this.leagueSummaries.set(summaries);
      this.username = profile?.username ?? '';
      this.favoriteTeamAbbreviation =
        profile?.favoriteTeamAbbreviation || RINKRAT_NEUTRAL_ABBREVIATION;
      this.hockeyExperience = normalizeHockeyExperienceLevel(profile?.hockeyExperience);
      this.reducedMotion = Boolean(profile?.reducedMotion);
      this.defaultLandingPage =
        profile?.defaultLandingPage === 'lastLeague' ? 'lastLeague' : 'dashboard';
      this.injuryEmailEnabled = profile?.injuryEmailEnabled === true;
      this.backgroundTheme = profile?.backgroundTheme || 'rink-dark';

      const savedUnlocks = this.normalizeIdentityUnlocks(profile?.teamIdentityUnlocks);
      const mergedUnlocks = this.mergeIdentityUnlocks(
        savedUnlocks,
        this.normalizeIdentityUnlocks(reconciledUnlocks),
      );
      this.unlockedIdentityRequirements.set(mergedUnlocks);

      const requestedVariant = getPixelTeamTheme(
        this.favoriteTeamAbbreviation,
        profile?.favoriteTeamVariantId,
      );
      const selectedVariant = this.isUnlockRequirementUnlocked(
        requestedVariant.unlockRequirement,
        mergedUnlocks,
      )
        ? requestedVariant
        : getPixelTeamTheme(
            this.favoriteTeamAbbreviation,
            DEFAULT_TEAM_IDENTITY_VARIANT_ID,
          );
      this.favoriteTeamVariantId = selectedVariant.variantId;

      const normalizedProfile: UserProfile | null = profile
        ? {
            ...profile,
            favoriteTeamVariantId: this.favoriteTeamVariantId,
            teamIdentityUnlocks: mergedUnlocks,
          }
        : profile;
      this.profile.set(normalizedProfile);

      if (
        profile?.favoriteTeamVariantId &&
        profile.favoriteTeamVariantId !== this.favoriteTeamVariantId
      ) {
        await updateFavoriteTeam(
          user.uid,
          this.favoriteTeamAbbreviation,
          this.favoriteTeamVariantId,
        );
      }

      applyUserTheme({
        favoriteTeamAbbreviation: this.favoriteTeamAbbreviation,
        favoriteTeamVariantId: this.favoriteTeamVariantId,
        teamIdentityUnlocks: this.unlockedIdentityRequirements(),
        reducedMotion: this.reducedMotion,
        defaultLandingPage: this.defaultLandingPage,
        backgroundTheme: this.backgroundTheme,
        hockeyExperience: this.hockeyExperience,
      });
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load your manager profile.',
      );
    } finally {
      this.loading.set(false);
      this.focusRequestedIdentitySection();
    }
  }

  async selectFavoriteTeam(team: PixelTeamTheme): Promise<void> {
    if (this.savingFavoriteTeam() || team.abbreviation === this.favoriteTeamAbbreviation) {
      return;
    }

    const previousTeam = this.favoriteTeamAbbreviation;
    const previousVariant = this.favoriteTeamVariantId;

    this.customIdentityEditorOpen.set(false);
    this.favoriteTeamAbbreviation = team.abbreviation;
    this.favoriteTeamVariantId = DEFAULT_TEAM_IDENTITY_VARIANT_ID;

    const successMessage =
      team.abbreviation === RINKRAT_NEUTRAL_ABBREVIATION
        ? 'Neutral RinkRat colors are now active. You can choose an NHL favorite at any time.'
        : `${team.name} is now your saved favorite team. Choose a logo and color version below.`;

    await this.saveFavoriteTeamIdentity(
      previousTeam,
      previousVariant,
      successMessage,
    );
  }

  async selectTeamVariant(variant: PixelTeamTheme): Promise<void> {
    if (!this.isTeamVariantUnlocked(variant)) {
      const unlock = TEAM_IDENTITY_UNLOCK_DETAILS[variant.unlockRequirement];
      this.successMessage.set('');
      this.errorMessage.set(
        `${variant.variantLabel} unlocks with ${unlock.challengeTitle}: ${unlock.description}`,
      );
      return;
    }

    if (
      this.savingFavoriteTeam() ||
      variant.abbreviation !== this.favoriteTeamAbbreviation
    ) {
      return;
    }

    if (variant.variantId === CUSTOM_TEAM_IDENTITY_VARIANT_ID) {
      this.openCustomIdentityEditor();
      return;
    }

    if (variant.variantId === this.favoriteTeamVariantId) {
      return;
    }

    this.customIdentityEditorOpen.set(false);
    const previousTeam = this.favoriteTeamAbbreviation;
    const previousVariant = this.favoriteTeamVariantId;
    this.favoriteTeamVariantId = variant.variantId;

    await this.saveFavoriteTeamIdentity(
      previousTeam,
      previousVariant,
      `${variant.variantLabel} is now your active ${variant.name} identity.`,
    );
  }

  isTeamVariantSelected(variant: PixelTeamTheme): boolean {
    return variant.variantId === CUSTOM_TEAM_IDENTITY_VARIANT_ID
      ? isCustomTeamIdentityVariantId(this.favoriteTeamVariantId)
      : variant.variantId === this.favoriteTeamVariantId;
  }

  teamVariantPreview(variant: PixelTeamTheme): PixelTeamTheme {
    return variant.variantId === CUSTOM_TEAM_IDENTITY_VARIANT_ID &&
      isCustomTeamIdentityVariantId(this.favoriteTeamVariantId)
      ? this.selectedTeam()
      : variant;
  }

  customLogoOptions(): PixelTeamTheme[] {
    return getCustomTeamIdentityLogoOptions(this.favoriteTeamAbbreviation);
  }

  customIdentityPreview(): PixelTeamTheme {
    return getPixelTeamTheme(
      this.favoriteTeamAbbreviation,
      this.buildCustomIdentityDraftId(),
    );
  }

  openCustomIdentityEditor(): void {
    if (this.isNeutralIdentity()) {
      this.errorMessage.set('Choose an NHL favorite before building a custom team identity.');
      return;
    }

    if (!this.isUnlockRequirementUnlocked('identity-architect', this.unlockedIdentityRequirements())) {
      const details = TEAM_IDENTITY_UNLOCK_DETAILS['identity-architect'];
      this.errorMessage.set(
        `${details.challengeTitle} is still locked: ${details.description}`,
      );
      return;
    }

    const savedConfiguration = parseCustomTeamIdentityVariantId(this.favoriteTeamVariantId);
    const sourceTheme = this.selectedTeam();
    const logoOptions = this.customLogoOptions();
    const matchingLogo = logoOptions.find((option) =>
      option.variantId === savedConfiguration?.logoVariantId ||
      (!savedConfiguration && option.logoUrl === sourceTheme.logoUrl),
    );

    this.customLogoVariantId = matchingLogo?.variantId ?? DEFAULT_TEAM_IDENTITY_VARIANT_ID;
    this.customPrimaryColor = savedConfiguration?.primaryColor ?? sourceTheme.primaryColor;
    this.customSecondaryColor = savedConfiguration?.secondaryColor ?? sourceTheme.secondaryColor;
    this.customTertiaryColor = savedConfiguration?.tertiaryColor ?? sourceTheme.tertiaryColor;
    this.customIdentityEditorOpen.set(true);
    this.successMessage.set('');
    this.errorMessage.set('');
    this.previewCustomIdentityDraft();
  }

  chooseCustomLogo(variantId: string): void {
    if (!this.customLogoOptions().some((option) => option.variantId === variantId)) {
      return;
    }

    this.customLogoVariantId = variantId;
    this.previewCustomIdentityDraft();
  }

  updateCustomIdentityColor(
    color: 'primary' | 'secondary' | 'tertiary',
    value: string,
  ): void {
    const normalized = normalizeTeamIdentityHexColor(value);
    if (!normalized) {
      return;
    }

    if (color === 'primary') {
      this.customPrimaryColor = normalized;
    } else if (color === 'secondary') {
      this.customSecondaryColor = normalized;
    } else {
      this.customTertiaryColor = normalized;
    }

    this.previewCustomIdentityDraft();
  }

  resetCustomIdentityDraft(): void {
    const home = getPixelTeamTheme(
      this.favoriteTeamAbbreviation,
      DEFAULT_TEAM_IDENTITY_VARIANT_ID,
    );
    this.customLogoVariantId = DEFAULT_TEAM_IDENTITY_VARIANT_ID;
    this.customPrimaryColor = home.primaryColor;
    this.customSecondaryColor = home.secondaryColor;
    this.customTertiaryColor = home.tertiaryColor;
    this.previewCustomIdentityDraft();
  }

  cancelCustomIdentityEditor(): void {
    this.customIdentityEditorOpen.set(false);
    this.previewPreferenceChanges();
  }

  async saveCustomIdentity(): Promise<void> {
    if (this.savingFavoriteTeam()) {
      return;
    }

    const previousTeam = this.favoriteTeamAbbreviation;
    const previousVariant = this.favoriteTeamVariantId;
    const customVariantId = this.buildCustomIdentityDraftId();
    this.favoriteTeamVariantId = customVariantId;

    await this.saveFavoriteTeamIdentity(
      previousTeam,
      previousVariant,
      `Your custom ${this.selectedTeam().name} identity is now active.`,
    );

    if (this.favoriteTeamVariantId === customVariantId) {
      this.customIdentityEditorOpen.set(false);
    }
  }

  private buildCustomIdentityDraftId(): string {
    return buildCustomTeamIdentityVariantId({
      logoVariantId: this.customLogoVariantId,
      primaryColor: this.customPrimaryColor,
      secondaryColor: this.customSecondaryColor,
      tertiaryColor: this.customTertiaryColor,
    });
  }

  private previewCustomIdentityDraft(): void {
    applyUserTheme({
      favoriteTeamAbbreviation: this.favoriteTeamAbbreviation,
      favoriteTeamVariantId: this.buildCustomIdentityDraftId(),
      teamIdentityUnlocks: this.unlockedIdentityRequirements(),
      reducedMotion: this.reducedMotion,
      defaultLandingPage: this.defaultLandingPage,
      backgroundTheme: this.backgroundTheme,
      hockeyExperience: this.hockeyExperience,
    }, { persist: false });
  }

  private async saveFavoriteTeamIdentity(
    previousTeam: string,
    previousVariant: string,
    successMessage: string,
  ): Promise<void> {
    const user = auth.currentUser;

    if (!user) {
      this.favoriteTeamAbbreviation = previousTeam;
      this.favoriteTeamVariantId = previousVariant;
      this.errorMessage.set('You must be logged in.');
      return;
    }

    this.successMessage.set('');
    this.errorMessage.set('');
    this.savingFavoriteTeam.set(true);
    this.previewPreferenceChanges();

    try {
      await updateFavoriteTeam(
        user.uid,
        this.favoriteTeamAbbreviation,
        this.favoriteTeamVariantId,
      );

      this.profile.update((current) =>
        current
          ? {
              ...current,
              favoriteTeamAbbreviation: this.favoriteTeamAbbreviation,
              favoriteTeamVariantId: this.favoriteTeamVariantId,
            }
          : current,
      );

      this.successMessage.set(successMessage);
    } catch (error: unknown) {
      this.favoriteTeamAbbreviation = previousTeam;
      this.favoriteTeamVariantId = previousVariant;
      this.previewPreferenceChanges();
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to save your team identity.',
      );
    } finally {
      this.savingFavoriteTeam.set(false);
    }
  }

  isTeamVariantUnlocked(variant: PixelTeamTheme): boolean {
    return this.isUnlockRequirementUnlocked(
      variant.unlockRequirement,
      this.unlockedIdentityRequirements(),
    );
  }

  teamVariantUnlockLabel(variant: PixelTeamTheme): string {
    if (this.isTeamVariantUnlocked(variant)) {
      return variant.unlockRequirement === 'default' ? 'Included' : 'Unlocked';
    }

    return `Locked · ${TEAM_IDENTITY_UNLOCK_DETAILS[variant.unlockRequirement].challengeTitle}`;
  }

  handleTeamLogoError(event: Event, abbreviation: string): void {
    const image = event.target as HTMLImageElement | null;
    const fallbackUrl = getNhlLogoUrl(abbreviation);

    if (!image || image.src === fallbackUrl) {
      return;
    }

    image.onerror = null;
    image.src = fallbackUrl;
  }

  private buildAchievement(
    icon: string,
    unlockRequirement: Exclude<TeamIdentityUnlockRequirement, 'default'>,
  ): AccountAchievement {
    const details = TEAM_IDENTITY_UNLOCK_DETAILS[unlockRequirement];

    return {
      icon,
      title: details.challengeTitle,
      description: details.description,
      reward: details.rewardLabel,
      unlockRequirement,
      unlocked: this.isUnlockRequirementUnlocked(
        unlockRequirement,
        this.unlockedIdentityRequirements(),
      ),
    };
  }

  private normalizeIdentityUnlocks(
    unlocks: TeamIdentityUnlockRequirement[] | null | undefined,
  ): Exclude<TeamIdentityUnlockRequirement, 'default'>[] {
    const saved = new Set(unlocks ?? []);

    return IDENTITY_UNLOCK_ORDER.filter((requirement) => saved.has(requirement));
  }

  private mergeIdentityUnlocks(
    first: Exclude<TeamIdentityUnlockRequirement, 'default'>[],
    second: Exclude<TeamIdentityUnlockRequirement, 'default'>[],
  ): Exclude<TeamIdentityUnlockRequirement, 'default'>[] {
    const merged = new Set<TeamIdentityUnlockRequirement>([...first, ...second]);

    return IDENTITY_UNLOCK_ORDER.filter((requirement) => merged.has(requirement));
  }

  private isUnlockRequirementUnlocked(
    requirement: TeamIdentityUnlockRequirement,
    unlocked: TeamIdentityUnlockRequirement[],
  ): boolean {
    return requirement === 'default' || unlocked.includes(requirement);
  }

  private focusRequestedIdentitySection(
    fragment = this.route.snapshot.fragment,
  ): void {
    if (
      fragment !== 'team-identity-customizer' ||
      typeof window === 'undefined'
    ) {
      return;
    }

    window.setTimeout(() => {
      if (
        !this.isNeutralIdentity() &&
        this.isUnlockRequirementUnlocked(
          'identity-architect',
          this.unlockedIdentityRequirements(),
        )
      ) {
        this.openCustomIdentityEditor();
      }

      document.getElementById('team-identity-customizer')?.scrollIntoView({
        behavior: this.reducedMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    }, 0);
  }

  previewPreferenceChanges(): void {
    applyUserTheme({
      favoriteTeamAbbreviation: this.favoriteTeamAbbreviation,
      favoriteTeamVariantId: this.favoriteTeamVariantId,
      teamIdentityUnlocks: this.unlockedIdentityRequirements(),
      reducedMotion: this.reducedMotion,
      defaultLandingPage: this.defaultLandingPage,
      backgroundTheme: this.backgroundTheme,
      hockeyExperience: this.hockeyExperience,
    });
  }

  async saveAccountSettings(): Promise<void> {
    this.successMessage.set('');
    this.errorMessage.set('');

    const user = auth.currentUser;
    const normalizedUsername = this.username.trim();

    if (!user) {
      this.errorMessage.set('You must be logged in.');
      return;
    }

    if (!normalizedUsername) {
      this.errorMessage.set('Username cannot be empty.');
      return;
    }

    this.saving.set(true);

    try {
      await updateUserAccountSettings(user.uid, {
        username: normalizedUsername,
        favoriteTeamAbbreviation: this.favoriteTeamAbbreviation,
        favoriteTeamVariantId: this.favoriteTeamVariantId,
        teamIdentityUnlocks: this.unlockedIdentityRequirements(),
        reducedMotion: this.reducedMotion,
        defaultLandingPage: this.defaultLandingPage,
        backgroundTheme: this.backgroundTheme,
        injuryEmailEnabled: this.emailVerified() && this.injuryEmailEnabled,
        hockeyExperience: this.hockeyExperience,
      });

      await syncManagerNameAcrossLeagues(normalizedUsername);

      this.profile.update((current) =>
        current
          ? {
              ...current,
              username: normalizedUsername,
              favoriteTeamAbbreviation: this.favoriteTeamAbbreviation,
              favoriteTeamVariantId: this.favoriteTeamVariantId,
              teamIdentityUnlocks: this.unlockedIdentityRequirements(),
              reducedMotion: this.reducedMotion,
              defaultLandingPage: this.defaultLandingPage,
              backgroundTheme: this.backgroundTheme,
              injuryEmailEnabled: this.emailVerified() && this.injuryEmailEnabled,
              hockeyExperience: this.hockeyExperience,
            }
          : current,
      );

      applyUserTheme(this.profile());
      this.successMessage.set('Manager profile and theme preferences saved.');
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to save your account settings.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  async sendVerificationEmail(): Promise<void> {
    if (this.sendingVerification()) {
      return;
    }

    this.successMessage.set('');
    this.errorMessage.set('');
    this.sendingVerification.set(true);

    try {
      const result = await requestVerificationEmail();

      if (result.alreadyVerified) {
        this.emailVerified.set(true);
        this.successMessage.set('Your email address is already verified.');
        return;
      }

      this.successMessage.set(
        'Verification email sent. Check your inbox and spam folder, then return here to refresh your status.',
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to send a verification email.',
      );
    } finally {
      this.sendingVerification.set(false);
    }
  }

  async refreshVerificationStatus(): Promise<void> {
    const user = auth.currentUser;

    if (!user || this.refreshingVerification()) {
      return;
    }

    this.successMessage.set('');
    this.errorMessage.set('');
    this.refreshingVerification.set(true);

    try {
      await user.reload();
      this.emailVerified.set(user.emailVerified);

      if (user.emailVerified) {
        this.successMessage.set(
          'Email verified. You can now enable injury notification emails.',
        );
      } else {
        this.errorMessage.set(
          'Your email is not verified yet. Open the verification link, then try again.',
        );
      }
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to refresh verification status.',
      );
    } finally {
      this.refreshingVerification.set(false);
    }
  }

  onInjuryEmailPreferenceChange(): void {
    if (!this.emailVerified()) {
      this.injuryEmailEnabled = false;
      this.errorMessage.set('Verify your email before enabling injury alerts.');
    }
  }

  formatMemberSince(): string {
    const createdAt = this.profile()?.createdAt;
    let date: Date | null = null;

    if (createdAt instanceof Timestamp) {
      date = createdAt.toDate();
    } else if (createdAt instanceof Date) {
      date = createdAt;
    } else if (createdAt && typeof createdAt === 'object' && 'toDate' in createdAt) {
      const maybeTimestamp = createdAt as { toDate?: () => Date };
      date = maybeTimestamp.toDate?.() ?? null;
    }

    return date && !Number.isNaN(date.getTime())
      ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(date)
      : 'Founding manager';
  }

  async openDeleteAccountPanel(): Promise<void> {
    this.telemetry.track('account_deletion_reviewed');
    this.deleteAccountPanelOpen.set(true);
    this.deleteConfirmationUsername = '';
    this.deletePassword = '';
    this.deleteAcknowledged = false;
    this.deletionErrorMessage.set('');
    await this.refreshAccountDeletionReadiness();
  }

  closeDeleteAccountPanel(): void {
    if (this.deletingAccount()) {
      return;
    }

    this.deleteAccountPanelOpen.set(false);
    this.deleteConfirmationUsername = '';
    this.deletePassword = '';
    this.deleteAcknowledged = false;
    this.deletionErrorMessage.set('');
  }

  async refreshAccountDeletionReadiness(): Promise<void> {
    if (this.loadingDeletionReadiness()) {
      return;
    }

    this.loadingDeletionReadiness.set(true);
    this.deletionErrorMessage.set('');

    try {
      this.deletionReadiness.set(await getAccountDeletionReadiness());
    } catch (error: unknown) {
      this.deletionReadiness.set(null);
      this.deletionErrorMessage.set(
        this.getAccountDeletionErrorMessage(
          error,
          'Unable to review your leagues for account deletion.',
        ),
      );
    } finally {
      this.loadingDeletionReadiness.set(false);
    }
  }

  canSubmitAccountDeletion(): boolean {
    const profileUsername = this.profile()?.username ?? '';

    return Boolean(
      this.deletionReadiness()?.canDelete &&
      this.deleteAcknowledged &&
      this.deletePassword.length > 0 &&
      this.deleteConfirmationUsername === profileUsername &&
      !this.deletingAccount(),
    );
  }

  async permanentlyDeleteAccount(): Promise<void> {
    if (!this.canSubmitAccountDeletion()) {
      return;
    }

    const confirmationUsername = this.deleteConfirmationUsername;
    const password = this.deletePassword;
    this.deletingAccount.set(true);
    this.deletionErrorMessage.set('');
    this.successMessage.set('');
    this.errorMessage.set('');

    try {
      this.telemetry.track('account_deletion_started', {
        member_league_count: this.deletionReadiness()?.memberLeagueCount ?? 0,
      });
      await reauthenticateCurrentUserWithPassword(password);
      await deleteCurrentUserAccount(confirmationUsername);

      await resetBrowserAfterAccountDeletion();
    } catch (error: unknown) {
      this.deletionErrorMessage.set(
        this.getAccountDeletionErrorMessage(
          error,
          'Unable to delete your account. Nothing was deleted from this browser session.',
        ),
      );
      this.deletePassword = '';
      await this.refreshAccountDeletionReadiness();
    } finally {
      this.deletingAccount.set(false);
    }
  }

  private getAccountDeletionErrorMessage(error: unknown, fallback: string): string {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    const code = typeof candidate?.code === 'string' ? candidate.code : '';
    const rawMessage = typeof candidate?.message === 'string' ? candidate.message : '';

    if (code.includes('auth/wrong-password') || code.includes('auth/invalid-credential')) {
      return 'That password was not correct. Enter your current RinkRat password and try again.';
    }

    if (code.includes('auth/too-many-requests')) {
      return 'Too many sign-in attempts were made. Wait a few minutes and try again.';
    }

    if (code.includes('auth/network-request-failed')) {
      return 'The password could not be verified because the network connection was interrupted.';
    }

    if (rawMessage) {
      return rawMessage
        .replace(/^Firebase:\s*/i, '')
        .replace(/\s*\([^)]*\)\.?$/, '')
        .trim();
    }

    return fallback;
  }

  async signOut(): Promise<void> {
    await logoutUser();
    await this.router.navigate(['/']);
  }
}
