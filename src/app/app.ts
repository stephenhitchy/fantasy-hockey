import { Component, OnDestroy, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { onAuthStateChanged } from 'firebase/auth';
import { Subscription } from 'rxjs';

import { auth } from './core/firebase-auth';
import {
  applyUserTheme,
  initializeStoredUserTheme,
  rememberLastLeagueId,
} from './core/user/user-theme.service';

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
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy {
  protected readonly title = signal('fantasy-hockey');

  private readonly routeSubscription: Subscription;
  private stopAuthThemeListener: (() => void) | null = null;
  private cancelProfileRefresh: (() => void) | null = null;
  private activeLeagueId = '';

  constructor(router: Router) {
    initializeStoredUserTheme();

    this.stopAuthThemeListener = onAuthStateChanged(auth, (user) => {
      this.cancelProfileRefresh?.();
      this.cancelProfileRefresh = null;

      if (!user || !this.activeLeagueId) {
        return;
      }

      this.scheduleProfileRefresh(user.uid);
    });

    this.routeSubscription = router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) {
        return;
      }

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
    this.cancelProfileRefresh?.();
    this.stopAuthThemeListener?.();
  }

  private scheduleProfileRefresh(userId: string): void {
    this.cancelProfileRefresh?.();
    this.cancelProfileRefresh = scheduleAfterPaint(() => {
      void this.refreshProfileTheme(userId);
    }, 1_000);
  }

  private async refreshProfileTheme(userId: string): Promise<void> {
    try {
      const { getUserProfile } = await import('./core/user/user.service');
      const profile = await getUserProfile(userId);

      if (profile) {
        applyUserTheme(profile);
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
