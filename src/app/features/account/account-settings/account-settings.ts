import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';
import { Timestamp } from 'firebase/firestore';
import { auth } from '../../../core/firebase';
import { logoutUser } from '../../../core/auth/auth.service';
import { requestVerificationEmail } from '../../../core/notifications/email-notification.service';
import { getMyLeagueSummaries, LeagueSummary } from '../../../core/league/league.service';
import {
  BackgroundTheme,
  DefaultLandingPage,
  getUserProfile,
  updateFavoriteTeam,
  updateTeamIdentityUnlocks,
  updateUserAccountSettings,
  UserProfile,
} from '../../../core/user/user.service';
import { applyUserTheme } from '../../../core/user/user-theme.service';
import {
  DEFAULT_TEAM_IDENTITY_VARIANT_ID,
  getNhlLogoUrl,
  getPixelTeamTheme,
  getTeamIdentityVariants,
  NHL_PIXEL_TEAMS,
  PixelTeamTheme,
  TEAM_IDENTITY_UNLOCK_DETAILS,
  TeamIdentityUnlockRequirement,
} from '../../../shared/pixel-theme/pixel-theme.data';

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
];

function waitForAuthUser(): Promise<User | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }

  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-account-settings',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './account-settings.html',
  styleUrl: './account-settings.css',
})
export class AccountSettings {
  readonly profile = signal<UserProfile | null>(null);
  readonly leagueSummaries = signal<LeagueSummary[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly savingFavoriteTeam = signal(false);
  readonly sendingVerification = signal(false);
  readonly refreshingVerification = signal(false);
  readonly emailVerified = signal(false);
  readonly successMessage = signal('');
  readonly errorMessage = signal('');
  readonly unlockedIdentityRequirements = signal<
    Exclude<TeamIdentityUnlockRequirement, 'default'>[]
  >([]);

  username = '';
  favoriteTeamAbbreviation = 'VGK';
  favoriteTeamVariantId = DEFAULT_TEAM_IDENTITY_VARIANT_ID;
  reducedMotion = false;
  defaultLandingPage: DefaultLandingPage = 'dashboard';
  injuryEmailEnabled = false;
  backgroundTheme: BackgroundTheme = 'rink-dark';

  readonly teams: PixelTeamTheme[] = NHL_PIXEL_TEAMS;
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

  readonly achievements = computed<AccountAchievement[]>(() => [
    this.buildAchievement('rat', 'first-line-change'),
    this.buildAchievement('draft', 'commissioner-mode'),
    this.buildAchievement('arena', 'league-explorer'),
    this.buildAchievement('league', 'crowded-schedule'),
  ]);

  constructor(private router: Router) {
    void this.loadProfile();
  }

  async loadProfile(): Promise<void> {
    const user = await waitForAuthUser();

    if (!user) {
      await this.router.navigate(['/']);
      return;
    }

    try {
      await user.reload();
      this.emailVerified.set(user.emailVerified);

      const [profile, summaries] = await Promise.all([
        getUserProfile(user.uid),
        getMyLeagueSummaries(),
      ]);

      this.leagueSummaries.set(summaries);
      this.username = profile?.username ?? '';
      this.favoriteTeamAbbreviation = profile?.favoriteTeamAbbreviation || 'VGK';
      this.reducedMotion = Boolean(profile?.reducedMotion);
      this.defaultLandingPage =
        profile?.defaultLandingPage === 'lastLeague' ? 'lastLeague' : 'dashboard';
      this.injuryEmailEnabled = profile?.injuryEmailEnabled === true;
      this.backgroundTheme = profile?.backgroundTheme || 'rink-dark';

      const savedUnlocks = this.normalizeIdentityUnlocks(profile?.teamIdentityUnlocks);
      const earnedUnlocks = this.getEarnedIdentityUnlocks(summaries);
      const mergedUnlocks = this.mergeIdentityUnlocks(savedUnlocks, earnedUnlocks);
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

      const persistenceTasks: Promise<void>[] = [];
      if (!this.sameIdentityUnlocks(savedUnlocks, mergedUnlocks)) {
        persistenceTasks.push(updateTeamIdentityUnlocks(user.uid, mergedUnlocks));
      }
      if (
        profile?.favoriteTeamVariantId &&
        profile.favoriteTeamVariantId !== this.favoriteTeamVariantId
      ) {
        persistenceTasks.push(
          updateFavoriteTeam(
            user.uid,
            this.favoriteTeamAbbreviation,
            this.favoriteTeamVariantId,
          ),
        );
      }
      if (persistenceTasks.length > 0) {
        await Promise.all(persistenceTasks);
      }

      applyUserTheme({
        favoriteTeamAbbreviation: this.favoriteTeamAbbreviation,
        favoriteTeamVariantId: this.favoriteTeamVariantId,
        teamIdentityUnlocks: this.unlockedIdentityRequirements(),
        reducedMotion: this.reducedMotion,
        defaultLandingPage: this.defaultLandingPage,
        backgroundTheme: this.backgroundTheme,
      });
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load your manager profile.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  async selectFavoriteTeam(team: PixelTeamTheme): Promise<void> {
    if (this.savingFavoriteTeam() || team.abbreviation === this.favoriteTeamAbbreviation) {
      return;
    }

    const previousTeam = this.favoriteTeamAbbreviation;
    const previousVariant = this.favoriteTeamVariantId;

    this.favoriteTeamAbbreviation = team.abbreviation;
    this.favoriteTeamVariantId = DEFAULT_TEAM_IDENTITY_VARIANT_ID;

    await this.saveFavoriteTeamIdentity(
      previousTeam,
      previousVariant,
      `${team.name} is now your saved favorite team. Choose a logo and color version below.`,
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
      variant.abbreviation !== this.favoriteTeamAbbreviation ||
      variant.variantId === this.favoriteTeamVariantId
    ) {
      return;
    }

    const previousTeam = this.favoriteTeamAbbreviation;
    const previousVariant = this.favoriteTeamVariantId;
    this.favoriteTeamVariantId = variant.variantId;

    await this.saveFavoriteTeamIdentity(
      previousTeam,
      previousVariant,
      `${variant.variantLabel} is now your active ${variant.name} identity.`,
    );
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

  private getEarnedIdentityUnlocks(
    summaries: LeagueSummary[],
  ): Exclude<TeamIdentityUnlockRequirement, 'default'>[] {
    const leagueCount = summaries.length;
    const commissionerLeagueCount = summaries.filter((league) => league.isCommissioner).length;
    const opponentCount = summaries.reduce(
      (sum, league) => sum + Math.max(0, league.teamCount - 1),
      0,
    );
    const earned: Exclude<TeamIdentityUnlockRequirement, 'default'>[] = [];

    if (leagueCount >= 1) {
      earned.push('first-line-change');
    }
    if (commissionerLeagueCount >= 1) {
      earned.push('commissioner-mode');
    }
    if (leagueCount >= 3) {
      earned.push('league-explorer');
    }
    if (opponentCount >= 10) {
      earned.push('crowded-schedule');
    }

    return earned;
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

  private sameIdentityUnlocks(
    first: Exclude<TeamIdentityUnlockRequirement, 'default'>[],
    second: Exclude<TeamIdentityUnlockRequirement, 'default'>[],
  ): boolean {
    return first.length === second.length && first.every((value, index) => value === second[index]);
  }

  private isUnlockRequirementUnlocked(
    requirement: TeamIdentityUnlockRequirement,
    unlocked: TeamIdentityUnlockRequirement[],
  ): boolean {
    return requirement === 'default' || unlocked.includes(requirement);
  }

  previewPreferenceChanges(): void {
    applyUserTheme({
      favoriteTeamAbbreviation: this.favoriteTeamAbbreviation,
      favoriteTeamVariantId: this.favoriteTeamVariantId,
      teamIdentityUnlocks: this.unlockedIdentityRequirements(),
      reducedMotion: this.reducedMotion,
      defaultLandingPage: this.defaultLandingPage,
      backgroundTheme: this.backgroundTheme,
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
      });

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

  async signOut(): Promise<void> {
    await logoutUser();
    await this.router.navigate(['/']);
  }
}
