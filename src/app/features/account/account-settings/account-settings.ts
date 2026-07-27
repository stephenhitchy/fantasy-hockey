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
  updateUserAccountSettings,
  UserProfile,
} from '../../../core/user/user.service';
import { applyUserTheme } from '../../../core/user/user-theme.service';
import {
  getPixelTeamTheme,
  NHL_PIXEL_TEAMS,
  PixelTeamTheme,
} from '../../../shared/pixel-theme/pixel-theme.data';

interface AccountAchievement {
  icon: string;
  title: string;
  description: string;
  unlocked: boolean;
}

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

  username = '';
  favoriteTeamAbbreviation = 'VGK';
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
    return getPixelTeamTheme(this.favoriteTeamAbbreviation);
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
    {
      icon: 'rat',
      title: 'First Line Change',
      description: 'Join your first fantasy hockey league.',
      unlocked: this.leagueCount() >= 1,
    },
    {
      icon: 'draft',
      title: 'Commissioner Mode',
      description: 'Create or manage a league.',
      unlocked: this.commissionerLeagueCount() >= 1,
    },
    {
      icon: 'arena',
      title: 'League Explorer',
      description: 'Compete in three different leagues.',
      unlocked: this.leagueCount() >= 3,
    },
    {
      icon: 'league',
      title: 'Crowded Schedule',
      description: 'Face at least ten fantasy opponents.',
      unlocked: this.opponentCount() >= 10,
    },
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

      this.profile.set(profile);
      this.leagueSummaries.set(summaries);
      this.username = profile?.username ?? '';
      this.favoriteTeamAbbreviation = profile?.favoriteTeamAbbreviation || 'VGK';
      this.reducedMotion = Boolean(profile?.reducedMotion);
      this.defaultLandingPage =
        profile?.defaultLandingPage === 'lastLeague' ? 'lastLeague' : 'dashboard';
      this.injuryEmailEnabled = profile?.injuryEmailEnabled === true;
      this.backgroundTheme = profile?.backgroundTheme || 'rink-dark';

      applyUserTheme({
        favoriteTeamAbbreviation: this.favoriteTeamAbbreviation,
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

    const user = auth.currentUser;

    if (!user) {
      this.errorMessage.set('You must be logged in.');
      return;
    }

    const previousFavoriteTeam =
      this.profile()?.favoriteTeamAbbreviation || this.favoriteTeamAbbreviation || 'VGK';

    this.favoriteTeamAbbreviation = team.abbreviation;
    this.successMessage.set('');
    this.errorMessage.set('');
    this.savingFavoriteTeam.set(true);

    applyUserTheme({
      favoriteTeamAbbreviation: this.favoriteTeamAbbreviation,
      reducedMotion: this.reducedMotion,
      defaultLandingPage: this.defaultLandingPage,
      backgroundTheme: this.backgroundTheme,
    });

    try {
      await updateFavoriteTeam(user.uid, team.abbreviation);

      this.profile.update((current) =>
        current
          ? {
              ...current,
              favoriteTeamAbbreviation: team.abbreviation,
            }
          : current,
      );

      this.successMessage.set(`${team.name} is now your saved favorite team.`);
    } catch (error: unknown) {
      this.favoriteTeamAbbreviation = previousFavoriteTeam;

      applyUserTheme({
        favoriteTeamAbbreviation: previousFavoriteTeam,
        reducedMotion: this.reducedMotion,
        defaultLandingPage: this.defaultLandingPage,
        backgroundTheme: this.backgroundTheme,
      });

      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to save your favorite team.',
      );
    } finally {
      this.savingFavoriteTeam.set(false);
    }
  }

  previewPreferenceChanges(): void {
    applyUserTheme({
      favoriteTeamAbbreviation: this.favoriteTeamAbbreviation,
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
