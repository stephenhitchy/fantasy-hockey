import { Injectable, computed, signal } from '@angular/core';

import {
  forgetRememberedLastLeagueId,
  getRememberedLastLeagueId,
  rememberLastLeagueId,
} from '../user/user-theme.service';
import { getMobileLeagueRouteContext } from './mobile-league-navigation.util';

export type MobileLeagueNavigationRoute = Array<string | number>;

export interface DashboardMobileLeagueNavigationContext {
  leagueId: string;
  matchupRoute: MobileLeagueNavigationRoute | null;
}

@Injectable({ providedIn: 'root' })
export class MobileLeagueNavigationService {
  private readonly currentLeagueIdState = signal(getRememberedLastLeagueId());
  private readonly matchupRoutesState = signal(
    new Map<string, MobileLeagueNavigationRoute>(),
  );

  readonly currentLeagueId = this.currentLeagueIdState.asReadonly();
  readonly teamRoute = computed<MobileLeagueNavigationRoute | null>(() => {
    const leagueId = this.currentLeagueIdState();
    return leagueId ? ['/leagues', leagueId, 'team'] : null;
  });
  readonly matchupRoute = computed<MobileLeagueNavigationRoute | null>(() => {
    const leagueId = this.currentLeagueIdState();
    const route = leagueId ? this.matchupRoutesState().get(leagueId) : null;
    return route ? [...route] : null;
  });

  restoreRememberedLeague(): void {
    this.currentLeagueIdState.set(getRememberedLastLeagueId());
  }

  observeRoute(rawUrl: string): void {
    const context = getMobileLeagueRouteContext(rawUrl);

    if (!context) {
      return;
    }

    this.selectLeague(context.leagueId);
    const cycleNumber = context.cycleNumber;

    if (cycleNumber !== null) {
      this.matchupRoutesState.update((current) => {
        const next = new Map(current);
        next.set(context.leagueId, [
          '/leagues',
          context.leagueId,
          'cycles',
          cycleNumber,
        ]);
        return next;
      });
    }
  }

  setDashboardContexts(
    contexts: readonly DashboardMobileLeagueNavigationContext[],
    selectedLeagueId: string,
  ): void {
    const nextRoutes = new Map<string, MobileLeagueNavigationRoute>();
    const leagueIds = new Set<string>();

    for (const context of contexts) {
      const leagueId = context.leagueId.trim();

      if (!leagueId) {
        continue;
      }

      leagueIds.add(leagueId);

      if (context.matchupRoute) {
        nextRoutes.set(leagueId, [...context.matchupRoute]);
      }
    }

    this.matchupRoutesState.set(nextRoutes);

    if (leagueIds.size === 0) {
      this.currentLeagueIdState.set('');
      forgetRememberedLastLeagueId();
      return;
    }

    const selected = selectedLeagueId.trim();
    const fallbackLeagueId = leagueIds.values().next().value ?? '';
    this.selectLeague(leagueIds.has(selected) ? selected : fallbackLeagueId);
  }

  selectLeague(leagueId: string): void {
    const normalized = leagueId.trim();

    if (!normalized) {
      return;
    }

    this.currentLeagueIdState.set(normalized);
    rememberLastLeagueId(normalized);
  }

  clearVisibleContext(): void {
    this.currentLeagueIdState.set('');
    this.matchupRoutesState.set(new Map());
  }
}
