import { Component, computed, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { getMyLeagueSummaries, LeagueSummary } from '../../core/league/league.service';
import { waitForAuthenticatedUser } from '../../core/guards/auth.guard';
import { CURRENT_TRAINING_CAMP_VERSION } from '../../core/onboarding/training-camp.service';
import { getUserProfile, UserProfile } from '../../core/user/user.service';
import { applyUserTheme, loadStoredUserTheme } from '../../core/user/user-theme.service';
import { getLeagueLogoAssetPath } from '../../shared/league-logo/league-logo.data';
import { getPixelTeamTheme } from '../../shared/pixel-theme/pixel-theme.data';

interface DashboardCache {
  userId: string;
  profile: UserProfile | null;
  leagueSummaries: LeagueSummary[];
  cachedAt: number;
}

const DASHBOARD_CACHE_VERSION = 4;
const DASHBOARD_CACHE_PREFIX = `fantasy-hockey-dashboard-v${DASHBOARD_CACHE_VERSION}`;


function getDashboardCacheKey(userId: string): string {
  return `${DASHBOARD_CACHE_PREFIX}:${userId}`;
}

function readDashboardCache(userId: string): DashboardCache | null {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }

  try {
    const raw = sessionStorage.getItem(getDashboardCacheKey(userId));
    const parsed = raw ? (JSON.parse(raw) as Partial<DashboardCache>) : null;

    if (!parsed || parsed.userId !== userId || !Array.isArray(parsed.leagueSummaries)) {
      return null;
    }

    return {
      userId,
      profile: parsed.profile ?? null,
      leagueSummaries: parsed.leagueSummaries,
      cachedAt: typeof parsed.cachedAt === 'number' ? parsed.cachedAt : 0,
    };
  } catch {
    return null;
  }
}

function writeDashboardCache(cache: DashboardCache): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }

  try {
    sessionStorage.setItem(getDashboardCacheKey(cache.userId), JSON.stringify(cache));
  } catch {
    // A full or unavailable browser storage area should never block the app.
  }
}

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class Dashboard {
  readonly leagueSummaries = signal<LeagueSummary[]>([]);
  readonly profile = signal<UserProfile | null>(null);
  readonly loading = signal(true);
  readonly leaguesLoading = signal(false);
  readonly errorMessage = signal('');

  private userId = '';
  private userEmail = '';
  private loadGeneration = 0;

  readonly favoriteTeam = computed(() => {
    const storedTheme = loadStoredUserTheme();

    const profile = this.profile();

    return getPixelTeamTheme(
      profile?.favoriteTeamAbbreviation || storedTheme.favoriteTeamAbbreviation,
      profile?.favoriteTeamVariantId || storedTheme.favoriteTeamVariantId,
    );
  });

  readonly trainingCampComplete = computed(
    () => (this.profile()?.trainingCampVersion ?? 0) >= CURRENT_TRAINING_CAMP_VERSION,
  );

  readonly displayName = computed(() => {
    const profile = this.profile();
    const username = profile?.username?.trim();

    if (username) {
      return username;
    }

    const email = profile?.email?.trim() || this.userEmail;

    if (email) {
      return email.split('@')[0];
    }

    return 'Manager';
  });

  constructor(private router: Router) {
    void this.loadDashboard();
  }

  async loadDashboard(): Promise<void> {
    const generation = ++this.loadGeneration;

    this.errorMessage.set('');

    if (!this.userId) {
      this.loading.set(true);
    }

    const user = await waitForAuthenticatedUser();

    if (generation !== this.loadGeneration) {
      return;
    }

    if (!user) {
      await this.router.navigate(['/']);
      return;
    }

    this.userId = user.uid;
    this.userEmail = user.email ?? '';

    const cached = readDashboardCache(user.uid);

    if (cached) {
      const storedTheme = loadStoredUserTheme();
      const cachedProfile = cached.profile
        ? {
            ...cached.profile,
            favoriteTeamAbbreviation: storedTheme.favoriteTeamAbbreviation,
            favoriteTeamVariantId: storedTheme.favoriteTeamVariantId,
            teamIdentityUnlocks: storedTheme.teamIdentityUnlocks,
            reducedMotion: storedTheme.reducedMotion,
            defaultLandingPage: storedTheme.defaultLandingPage,
            backgroundTheme: storedTheme.backgroundTheme,
          }
        : null;

      this.profile.set(cachedProfile);
      this.leagueSummaries.set(cached.leagueSummaries);

      if (cachedProfile) {
        applyUserTheme(cachedProfile);
      }
    }

    // Authentication is known now, so reveal the dashboard immediately.
    // Profile and league data refresh independently underneath it.
    this.loading.set(false);
    this.leaguesLoading.set(true);

    const errors: string[] = [];

    const profileRefresh = getUserProfile(user.uid)
      .then((profile) => {
        if (generation !== this.loadGeneration) {
          return;
        }

        this.profile.set(profile);

        if (profile) {
          applyUserTheme(profile);
        }

        this.saveCache();
      })
      .catch((error: unknown) => {
        errors.push(
          error instanceof Error ? error.message : 'Unable to refresh your manager profile.',
        );
      });

    const leagueRefresh = getMyLeagueSummaries()
      .then((leagueSummaries) => {
        if (generation !== this.loadGeneration) {
          return;
        }

        this.leagueSummaries.set(leagueSummaries);
        this.saveCache();
      })
      .catch((error: unknown) => {
        errors.push(
          error instanceof Error ? error.message : 'Unable to refresh your fantasy hockey leagues.',
        );
      })
      .finally(() => {
        if (generation === this.loadGeneration) {
          this.leaguesLoading.set(false);
        }
      });

    await Promise.all([profileRefresh, leagueRefresh]);

    if (generation !== this.loadGeneration) {
      return;
    }

    if (errors.length > 0) {
      this.errorMessage.set(
        cached ? 'Showing your saved dashboard while fresh data reconnects.' : errors[0],
      );
    }
  }

  private saveCache(): void {
    if (!this.userId) {
      return;
    }

    const profile = this.profile();
    const cacheProfile: UserProfile | null = profile
      ? {
          uid: profile.uid,
          email: profile.email,
          username: profile.username,
          favoriteTeamAbbreviation: profile.favoriteTeamAbbreviation,
          favoriteTeamVariantId: profile.favoriteTeamVariantId,
          teamIdentityUnlocks: profile.teamIdentityUnlocks,
          reducedMotion: profile.reducedMotion,
          defaultLandingPage: profile.defaultLandingPage,
          backgroundTheme: profile.backgroundTheme,
          trainingCampVersion: profile.trainingCampVersion,
        }
      : null;

    writeDashboardCache({
      userId: this.userId,
      profile: cacheProfile,
      leagueSummaries: this.leagueSummaries(),
      cachedAt: Date.now(),
    });
  }

  getLeagueLogoPath(league: LeagueSummary): string {
    return getLeagueLogoAssetPath(league.leagueLogoId, league.leagueLogoPaletteId);
  }
}
