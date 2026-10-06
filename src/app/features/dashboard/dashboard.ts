import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { getMyLeagueSummaries, LeagueSummary } from '../../core/league/league.service';
import {
  buildManagerBriefing,
  type ManagerBriefingItem,
} from '../../core/league/manager-briefing.util';
import { waitForAuthenticatedUser } from '../../core/guards/auth.guard';
import { MobileLeagueNavigationService } from '../../core/navigation/mobile-league-navigation.service';
import { CURRENT_TRAINING_CAMP_VERSION } from '../../core/onboarding/training-camp.service';
import { getUserProfile, UserProfile } from '../../core/user/user.service';
import { applyUserTheme, loadStoredUserTheme } from '../../core/user/user-theme.service';
import { getLeagueLogoAssetPath } from '../../shared/league-logo/league-logo.data';
import { getPixelTeamTheme } from '../../shared/pixel-theme/pixel-theme.data';
import { NhlScoreboard } from './nhl-scoreboard/nhl-scoreboard';
import { combineDashboardNhlTeamRosterCounts } from './nhl-scoreboard/nhl-scoreboard.util';
import {
  clampDashboardLeagueRailIndex,
  type DashboardMatchupViewMode,
  getDashboardLeagueRailIndex,
  loadDashboardActiveLeagueId,
  loadDashboardMatchupViewMode,
  resolveDashboardActiveLeagueIndex,
  saveDashboardActiveLeagueId,
  saveDashboardMatchupViewMode,
} from './dashboard-league-carousel.util';

interface DashboardCache {
  userId: string;
  profile: UserProfile | null;
  leagueSummaries: LeagueSummary[];
  cachedAt: number;
}

const DASHBOARD_CACHE_VERSION = 10;
const DASHBOARD_CACHE_PREFIX = `fantasy-hockey-dashboard-v${DASHBOARD_CACHE_VERSION}`;


function getDashboardCacheKey(userId: string): string {
  return `${DASHBOARD_CACHE_PREFIX}:${userId}`;
}

function omitCachedLiveMatchupActivity(leagueSummaries: readonly LeagueSummary[]): LeagueSummary[] {
  return leagueSummaries.map((league) => {
    const activity = league.dashboardActivity;
    const matchup = activity?.matchup;

    if (!activity || !matchup) {
      return league;
    }

    const withoutLiveActivity = (progress: typeof matchup.myProgress) => ({
      ...progress,
      liveStarterCount: 0,
      liveStarterNames: [],
      liveStarterPreviewNames: [],
      additionalLiveStarterCount: 0,
      additionalLiveStarterNames: '',
    });

    return {
      ...league,
      dashboardActivity: {
        ...activity,
        matchup: {
          ...matchup,
          myProgress: withoutLiveActivity(matchup.myProgress),
          opponentProgress: withoutLiveActivity(matchup.opponentProgress),
        },
      },
    };
  });
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
      leagueSummaries: omitCachedLiveMatchupActivity(parsed.leagueSummaries),
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
  imports: [RouterLink, NhlScoreboard],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class Dashboard implements OnDestroy {
  private readonly mobileLeagueNavigation = inject(MobileLeagueNavigationService);

  readonly leagueSummaries = signal<LeagueSummary[]>([]);
  readonly profile = signal<UserProfile | null>(null);
  readonly loading = signal(true);
  readonly leaguesLoading = signal(false);
  readonly errorMessage = signal('');
  readonly activeLeagueIndex = signal(0);
  readonly matchupViewMode = signal<DashboardMatchupViewMode>(loadDashboardMatchupViewMode());
  readonly leagueRail = viewChild<ElementRef<HTMLDivElement>>('leagueRail');

  private userId = '';
  private userEmail = '';
  private loadGeneration = 0;
  private leagueRailPositionFrame: number | null = null;
  private leagueCardPointer: {
    leagueId: string;
    pointerId: number;
    startX: number;
    startY: number;
    startScrollLeft: number;
    moved: boolean;
  } | null = null;
  private lastLeagueCardDragAt = 0;

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

  readonly managerBriefing = computed(() => buildManagerBriefing(
    this.leagueSummaries(),
    { maximumItems: 3 },
  ));

  readonly orderedLeagueSummaries = computed(() => [...this.leagueSummaries()].sort(
    (first, second) =>
      Number(Boolean(second.dashboardActivity?.matchup)) -
      Number(Boolean(first.dashboardActivity?.matchup)),
  ));

  readonly activeLeagueNumber = computed(() => {
    const count = this.orderedLeagueSummaries().length;

    return count === 0
      ? 0
      : clampDashboardLeagueRailIndex(this.activeLeagueIndex(), count) + 1;
  });

  readonly canOpenPreviousLeague = computed(() => this.activeLeagueIndex() > 0);
  readonly canOpenNextLeague = computed(() =>
    this.activeLeagueIndex() < this.orderedLeagueSummaries().length - 1,
  );

  readonly nhlTeamRosterCounts = computed(() =>
    combineDashboardNhlTeamRosterCounts(
      this.leagueSummaries().map((league) =>
        ({
          leagueId: league.leagueId,
          leagueName: league.leagueName,
          ownerId: this.userId,
          rosterCounts: league.dashboardActivity?.nhlTeamRosterCounts ?? [],
        }),
      ),
    ),
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

  ngOnDestroy(): void {
    this.loadGeneration += 1;

    if (this.leagueRailPositionFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.leagueRailPositionFrame);
      this.leagueRailPositionFrame = null;
    }
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
      this.resetLeagueRailPosition();

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

    const leagueRefresh = getMyLeagueSummaries({ includeDashboardActivity: true })
      .then((leagueSummaries) => {
        if (generation !== this.loadGeneration) {
          return;
        }

        this.leagueSummaries.set(leagueSummaries);
        this.resetLeagueRailPosition();
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
      leagueSummaries: omitCachedLiveMatchupActivity(this.leagueSummaries()),
      cachedAt: Date.now(),
    });
  }


  getRecordLabel(league: LeagueSummary): string {
    return `${league.wins}-${league.losses}-${league.ties}`;
  }

  formatScore(value: number): string {
    return Number.isFinite(value) ? value.toFixed(1) : '0.0';
  }

  getLeagueLogoPath(league: LeagueSummary): string {
    return getLeagueLogoAssetPath(league.leagueLogoId, league.leagueLogoPaletteId);
  }

  getBriefingLeagueLogoPath(item: ManagerBriefingItem): string {
    const league = this.leagueSummaries().find((entry) => entry.leagueId === item.leagueId);
    return league ? this.getLeagueLogoPath(league) : '/assets/branding/rinkrat-colored-mascot-512.png';
  }

  openPreviousLeague(): void {
    if (this.canOpenPreviousLeague()) {
      this.scrollToLeague(this.activeLeagueIndex() - 1);
    }
  }

  setMatchupViewMode(mode: DashboardMatchupViewMode): void {
    if (this.matchupViewMode() === mode) {
      return;
    }

    this.matchupViewMode.set(mode);
    this.leagueCardPointer = null;
    saveDashboardMatchupViewMode(mode);

    if (mode === 'carousel') {
      this.restoreActiveLeagueRailPosition();
    }
  }

  openNextLeague(): void {
    if (this.canOpenNextLeague()) {
      this.scrollToLeague(this.activeLeagueIndex() + 1);
    }
  }

  handleLeagueRailKeydown(event: KeyboardEvent): void {
    if (
      this.matchupViewMode() !== 'carousel' ||
      event.target !== event.currentTarget ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }

    if (event.key === 'ArrowLeft' && this.canOpenPreviousLeague()) {
      event.preventDefault();
      this.openPreviousLeague();
    } else if (event.key === 'ArrowRight' && this.canOpenNextLeague()) {
      event.preventDefault();
      this.openNextLeague();
    }
  }

  handleLeagueRailScroll(): void {
    if (this.matchupViewMode() !== 'carousel') {
      return;
    }

    const rail = this.leagueRail()?.nativeElement;
    const pointer = this.leagueCardPointer;

    if (rail && pointer && Math.abs(rail.scrollLeft - pointer.startScrollLeft) > 2) {
      pointer.moved = true;
      this.lastLeagueCardDragAt = Date.now();
    }

    this.scheduleLeagueRailPositionUpdate();
  }

  beginLeagueCardPointer(leagueId: string, event: PointerEvent): void {
    if (this.matchupViewMode() !== 'carousel' || !event.isPrimary) {
      return;
    }

    this.leagueCardPointer = {
      leagueId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: this.leagueRail()?.nativeElement.scrollLeft ?? 0,
      moved: false,
    };
  }

  trackLeagueCardPointer(leagueId: string, event: PointerEvent): void {
    const pointer = this.leagueCardPointer;

    if (
      !pointer ||
      pointer.leagueId !== leagueId ||
      pointer.pointerId !== event.pointerId
    ) {
      return;
    }

    if (
      Math.abs(event.clientX - pointer.startX) > 10 ||
      Math.abs(event.clientY - pointer.startY) > 10
    ) {
      pointer.moved = true;
    }
  }

  finishLeagueCardPointer(event: PointerEvent): void {
    const pointer = this.leagueCardPointer;

    if (!pointer || pointer.pointerId !== event.pointerId) {
      return;
    }

    const rail = this.leagueRail()?.nativeElement;
    const railMoved = rail
      ? Math.abs(rail.scrollLeft - pointer.startScrollLeft) > 2
      : false;

    if (pointer.moved || railMoved) {
      this.lastLeagueCardDragAt = Date.now();
    }

    this.leagueCardPointer = null;
  }

  openLeagueHqFromCard(event: MouseEvent, leagueId: string): void {
    const target = event.target;

    if (event.detail !== 0 && Date.now() - this.lastLeagueCardDragAt < 700) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (
      event.defaultPrevented ||
      !(target instanceof Element) ||
      target.closest('a, button, input, select, textarea, [role="button"]')
    ) {
      return;
    }

    void this.router.navigate(['/leagues', leagueId]);
  }

  private scrollToLeague(index: number): void {
    const rail = this.leagueRail()?.nativeElement;

    if (!rail) {
      return;
    }

    const cards = this.getLeagueCards(rail);
    const targetIndex = clampDashboardLeagueRailIndex(index, cards.length);
    const targetCard = cards[targetIndex];

    if (!targetCard) {
      return;
    }

    const targetLeft = this.getLeagueCardOffset(rail, targetCard);
    const maxScrollLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const reducedMotion = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    rail.scrollTo({
      left: Math.min(maxScrollLeft, Math.max(0, targetLeft)),
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
    this.selectActiveLeagueIndex(targetIndex);
  }

  private resetLeagueRailPosition(): void {
    const targetIndex = resolveDashboardActiveLeagueIndex(
      this.orderedLeagueSummaries(),
      loadDashboardActiveLeagueId(this.userId),
    );

    this.activeLeagueIndex.set(targetIndex);
    this.syncMobileLeagueNavigation();

    if (this.matchupViewMode() !== 'carousel') {
      return;
    }

    this.restoreActiveLeagueRailPosition();
  }

  private restoreActiveLeagueRailPosition(): void {
    if (typeof window === 'undefined' || this.matchupViewMode() !== 'carousel') {
      return;
    }

    if (this.leagueRailPositionFrame !== null) {
      window.cancelAnimationFrame(this.leagueRailPositionFrame);
    }

    this.leagueRailPositionFrame = window.requestAnimationFrame(() => {
      this.leagueRailPositionFrame = null;
      const rail = this.leagueRail()?.nativeElement;

      if (!rail) {
        return;
      }

      const cards = this.getLeagueCards(rail);
      const targetIndex = clampDashboardLeagueRailIndex(
        this.activeLeagueIndex(),
        cards.length,
      );
      const targetCard = cards[targetIndex];

      if (targetCard) {
        rail.scrollLeft = this.getLeagueCardOffset(rail, targetCard);
      }
    });
  }

  private scheduleLeagueRailPositionUpdate(): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (this.leagueRailPositionFrame !== null) {
      window.cancelAnimationFrame(this.leagueRailPositionFrame);
    }

    this.leagueRailPositionFrame = window.requestAnimationFrame(() => {
      this.leagueRailPositionFrame = null;
      const rail = this.leagueRail()?.nativeElement;

      if (!rail) {
        this.selectActiveLeagueIndex(0);
        return;
      }

      const offsets = this.getLeagueCards(rail).map((card) =>
        this.getLeagueCardOffset(rail, card),
      );
      this.selectActiveLeagueIndex(
        getDashboardLeagueRailIndex(rail.scrollLeft, offsets),
      );
    });
  }

  private selectActiveLeagueIndex(index: number): void {
    const leagues = this.orderedLeagueSummaries();
    const activeIndex = clampDashboardLeagueRailIndex(index, leagues.length);
    const selectedLeagueId = leagues[activeIndex]?.leagueId ?? '';

    this.activeLeagueIndex.set(activeIndex);

    if (this.userId && selectedLeagueId) {
      saveDashboardActiveLeagueId(this.userId, selectedLeagueId);
    }

    this.syncMobileLeagueNavigation();
  }

  private syncMobileLeagueNavigation(): void {
    const leagues = this.orderedLeagueSummaries();
    const activeIndex = clampDashboardLeagueRailIndex(
      this.activeLeagueIndex(),
      leagues.length,
    );
    const selectedLeagueId = leagues[activeIndex]?.leagueId ?? '';

    this.mobileLeagueNavigation.setDashboardContexts(
      leagues.map((league) => {
        const activity = league.dashboardActivity;
        const hasGameCenterDestination = activity?.stage === 'matchup-active' ||
          activity?.stage === 'matchup-complete' ||
          activity?.stage === 'cycle-complete';

        return {
          leagueId: league.leagueId,
          matchupRoute: hasGameCenterDestination && activity
            ? [...activity.primaryActionRoute]
            : null,
        };
      }),
      selectedLeagueId,
    );
  }

  private getLeagueCards(rail: HTMLDivElement): HTMLElement[] {
    return Array.from(rail.querySelectorAll<HTMLElement>('.league-card'));
  }

  private getLeagueCardOffset(rail: HTMLDivElement, card: HTMLElement): number {
    return rail.scrollLeft + card.getBoundingClientRect().left - rail.getBoundingClientRect().left;
  }
}
