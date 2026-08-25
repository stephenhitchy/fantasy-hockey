import { Component, computed, effect, OnDestroy, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { onAuthStateChanged } from 'firebase/auth';
import { Subscription } from 'rxjs';

import { repairViewportOverlayLock } from './shared/accessibility/viewport-overlay-portal.directive';

import { auth } from './core/firebase-auth';
import { ClientPerformanceMonitorService } from './core/observability/client-performance-monitor.service';
import { CompetitiveActionMonitorService } from './core/observability/competitive-action-monitor.service';
import { NavigationHistoryService } from './core/navigation/navigation-history.service';
import { RinkRatPwaService } from './core/pwa/rinkrat-pwa.service';
import { TelemetryService } from './core/observability/telemetry.service';
import { shortBuildIdentifier } from './core/release/release-manifest.util';
import { ReleaseUpdateService } from './core/release/release-update.service';
import { TeamIdentityChallengeService } from './core/user/team-identity-challenge.service';
import {
  applyUserTheme,
  initializeStoredUserTheme,
  rememberLastLeagueId,
} from './core/user/user-theme.service';

const RELEASE_FORCE_RELOAD_DELAY_MILLISECONDS = 60_000;

function scheduleAfterPaint(task: () => void, delayMilliseconds: number): () => void {
  if (typeof window === 'undefined') {
    task();
    return () => undefined;
  }

  let idleHandle: number | null = null;
  let cancelled = false;

  const timeoutHandle = window.setTimeout(() => {
    if (cancelled) {
      return;
    }

    if (typeof window.requestIdleCallback === 'function') {
      idleHandle = window.requestIdleCallback(task, { timeout: 2_000 });
      return;
    }

    task();
  }, delayMilliseconds);

  return () => {
    cancelled = true;
    window.clearTimeout(timeoutHandle);

    if (idleHandle !== null) {
      window.cancelIdleCallback(idleHandle);
    }
  };
}

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy {
  protected readonly title = signal('RinkRat Fantasy');
  protected readonly appliedUpdateNotice = signal('');
  protected readonly releaseMessage = signal('');
  protected readonly forceReleaseReloadAllowed = signal(false);
  protected readonly updateReloadBlocked = computed(
    () =>
      this.releaseUpdate.reloadRequested() ||
      (this.actionMonitor.activeCount() > 0 && !this.forceReleaseReloadAllowed()),
  );

  private readonly routeSubscription: Subscription;
  private stopAuthThemeListener: (() => void) | null = null;
  private cancelProfileRefresh: (() => void) | null = null;
  private activeLeagueId = '';
  private appliedUpdateNoticeTimer: number | null = null;
  private readonly refreshChallengesOnFocus = () => {
    const userId = auth.currentUser?.uid;
    if (userId) {
      void this.challengeService.refresh(userId);
    }
  };

  constructor(
    router: Router,
    telemetry: TelemetryService,
    performanceMonitor: ClientPerformanceMonitorService,
    protected readonly releaseUpdate: ReleaseUpdateService,
    protected readonly actionMonitor: CompetitiveActionMonitorService,
    protected readonly challengeService: TeamIdentityChallengeService,
    protected readonly pwa: RinkRatPwaService,
    navigationHistory: NavigationHistoryService,
  ) {
    void navigationHistory;
    initializeStoredUserTheme();
    telemetry.start(router);
    performanceMonitor.start(router);
    releaseUpdate.start();
    pwa.start();
    this.showAppliedUpdateNotice(releaseUpdate.consumeAppliedUpdateNotice());

    effect((onCleanup) => {
      const updateAvailable = releaseUpdate.updateAvailable();
      const activeCount = actionMonitor.activeCount();

      if (updateAvailable) {
        void pwa.checkForWorkerUpdate();
      }
      this.forceReleaseReloadAllowed.set(false);

      if (!updateAvailable || activeCount === 0 || typeof window === 'undefined') {
        return;
      }

      const timer = window.setTimeout(() => {
        this.forceReleaseReloadAllowed.set(true);
      }, RELEASE_FORCE_RELOAD_DELAY_MILLISECONDS);
      onCleanup(() => window.clearTimeout(timer));
    });

    this.stopAuthThemeListener = onAuthStateChanged(auth, (user) => {
      this.cancelProfileRefresh?.();
      this.cancelProfileRefresh = null;

      if (!user) {
        this.challengeService.reset();
        return;
      }

      this.scheduleProfileRefresh(user.uid);
      void this.challengeService.refresh(user.uid, { force: true });
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.refreshChallengesOnFocus);
    }

    this.routeSubscription = router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) {
        return;
      }

      // A route transition must never leave Safari's body fixed or visually
      // blurred after a dialog or pending operation has already disappeared.
      // The overlay portal also repairs itself through DOM/page lifecycle
      // observers; this route-level pass covers abrupt Angular navigation.
      repairViewportOverlayLock();

      const match = event.urlAfterRedirects.match(/^\/leagues\/([^/?#]+)/);
      const segment = match?.[1] ?? '';
      const hasActiveLeague = Boolean(segment && segment !== 'create' && segment !== 'join');

      if (!hasActiveLeague) {
        this.leaveLeagueContext();
        return;
      }

      rememberLastLeagueId(segment);

      if (segment !== this.activeLeagueId) {
        this.enterLeagueContext(segment);
      }
    });
  }

  ngOnDestroy(): void {
    this.routeSubscription.unsubscribe();

    if (this.appliedUpdateNoticeTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.appliedUpdateNoticeTimer);
      this.appliedUpdateNoticeTimer = null;
    }
    this.cancelProfileRefresh?.();
    this.stopAuthThemeListener?.();
    this.challengeService.reset();

    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.refreshChallengesOnFocus);
    }
  }


  protected getReleaseUpdateTitle(): string {
    switch (this.releaseUpdate.direction()) {
      case 'rollback':
        return 'RinkRat deployment changed';
      case 'different':
        return 'A different RinkRat build is live';
      default:
        return 'RinkRat update ready';
    }
  }

  protected getReleaseUpdateDetail(): string {
    const activeCount = this.actionMonitor.activeCount();

    if (activeCount > 0) {
      if (this.forceReleaseReloadAllowed()) {
        return `${activeCount} action${activeCount === 1 ? ' still appears' : 's still appear'} pending. Reload only after checking whether the last change already registered.`;
      }

      return `${activeCount} competitive action${activeCount === 1 ? ' is' : 's are'} still finishing. Reload becomes available as soon as the action settles.`;
    }

    return 'Reload before your next draft, roster, waiver, or testing action so this tab uses the deployed version.';
  }

  protected getReleaseBuildTransition(): string {
    const bundled = this.releaseUpdate.bundledManifest;
    const latest = this.releaseUpdate.latestManifest();

    if (!latest) {
      return `${bundled.releaseLabel} · ${shortBuildIdentifier(bundled)}`;
    }

    return `${bundled.releaseLabel} · ${shortBuildIdentifier(bundled)} → ${latest.releaseLabel} · ${shortBuildIdentifier(latest)}`;
  }

  protected getReleaseUpdateButtonLabel(): string {
    if (this.releaseUpdate.reloadRequested()) {
      return 'Reloading…';
    }

    if (this.actionMonitor.activeCount() > 0) {
      return this.forceReleaseReloadAllowed() ? 'Reload Anyway' : 'Finishing action…';
    }

    return 'Reload RinkRat';
  }

  protected reloadForReleaseUpdate(): void {
    this.releaseMessage.set('');

    if (this.actionMonitor.activeCount() > 0 && !this.forceReleaseReloadAllowed()) {
      this.releaseMessage.set('Finish the current competitive action before reloading this tab.');
      return;
    }

    if (!this.releaseUpdate.requestReload(() => this.pwa.reloadWithLatestWorker())) {
      this.releaseMessage.set('RinkRat could not start the reload. Refresh the page once manually.');
    }
  }

  private showAppliedUpdateNotice(message: string): void {
    if (!message) {
      return;
    }

    this.appliedUpdateNotice.set(message);

    if (typeof window === 'undefined') {
      return;
    }

    this.appliedUpdateNoticeTimer = window.setTimeout(() => {
      this.appliedUpdateNoticeTimer = null;
      this.appliedUpdateNotice.set('');
    }, 6_500);
  }

  private scheduleProfileRefresh(userId: string): void {
    this.cancelProfileRefresh?.();
    this.cancelProfileRefresh = scheduleAfterPaint(() => {
      void this.refreshProfileTheme(userId);
    }, 1_000);
  }

  private async refreshProfileTheme(userId: string): Promise<void> {
    try {
      const [
        { getUserProfile },
        { ensureLeagueProfileIcon, syncManagerNameForLeague },
      ] = await Promise.all([
        import('./core/user/user.service'),
        import('./core/league/league.service'),
      ]);
      const profile = await getUserProfile(userId);

      if (profile) {
        applyUserTheme(profile);
      }

      if (this.activeLeagueId) {
        await Promise.all([
          ensureLeagueProfileIcon(this.activeLeagueId),
          profile?.username
            ? syncManagerNameForLeague(this.activeLeagueId, profile.username)
            : Promise.resolve(),
        ]);
      }
    } catch (error: unknown) {
      console.warn('Unable to refresh the saved user theme.', error);
    }
  }

  private enterLeagueContext(leagueId: string): void {
    this.activeLeagueId = leagueId;

    if (auth.currentUser) {
      this.scheduleProfileRefresh(auth.currentUser.uid);
    }
  }

  private leaveLeagueContext(): void {
    const hadActiveLeague = Boolean(this.activeLeagueId);

    this.activeLeagueId = '';

    if (!hadActiveLeague) {
      return;
    }

    void import('./core/player/player-availability.service')
      .then(({ stopPlayerAvailabilityListeners }) => {
        stopPlayerAvailabilityListeners();
      })
      .catch((error: unknown) => {
        console.warn('Unable to stop player availability listeners.', error);
      });
  }

}
