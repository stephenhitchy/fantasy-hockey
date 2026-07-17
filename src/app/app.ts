import { Component, OnDestroy, signal } from '@angular/core';

import { onAuthStateChanged } from 'firebase/auth';

import { NavigationEnd, Router, RouterOutlet } from '@angular/router';

import { Subscription } from 'rxjs';

import { stopPlayerAvailabilityListeners } from './core/player/player-availability.service';

import { startLeagueLiveScoringSession } from './core/live-scoring/live-scoring.service';

import { auth } from './core/firebase';
import { getUserProfile } from './core/user/user.service';
import {
  applyUserTheme,
  initializeStoredUserTheme,
  rememberLastLeagueId,
} from './core/user/user-theme.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy {
  protected readonly title = signal('fantasy-hockey');

  private readonly routeSubscription: Subscription;
  private stopLiveScoringSession: (() => void) | null = null;
  private stopAuthThemeListener: (() => void) | null = null;
  private activeLeagueId = '';

  constructor(router: Router) {
    initializeStoredUserTheme();

    this.stopAuthThemeListener = onAuthStateChanged(auth, (user) => {
      if (!user) {
        return;
      }

      void getUserProfile(user.uid).then((profile) => {
        if (profile) {
          applyUserTheme(profile);
        }
      });
    });

    this.routeSubscription = router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) {
        return;
      }

      const match = event.urlAfterRedirects.match(/^\/leagues\/([^/?#]+)/);
      const segment = match?.[1] ?? '';
      const hasActiveLeague = Boolean(segment && segment !== 'create' && segment !== 'join');

      if (!hasActiveLeague) {
        stopPlayerAvailabilityListeners();
        this.stopLiveScoringSession?.();
        this.stopLiveScoringSession = null;
        this.activeLeagueId = '';
        return;
      }

      rememberLastLeagueId(segment);

      if (segment !== this.activeLeagueId) {
        this.stopLiveScoringSession?.();
        this.activeLeagueId = segment;
        this.stopLiveScoringSession = startLeagueLiveScoringSession(segment);
      }
    });
  }

  ngOnDestroy(): void {
    this.routeSubscription.unsubscribe();
    stopPlayerAvailabilityListeners();
    this.stopLiveScoringSession?.();
    this.stopAuthThemeListener?.();
  }
}
