import {
  Component,
  computed,
  OnDestroy,
  signal,
} from '@angular/core';

import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
} from '@angular/router';

import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';

import { PlatformAdminService } from '../../core/admin/platform-admin.service';
import { listenToAuthState, logoutUser } from '../../core/auth/auth.service';
import {
  listenToEarliestUnfinishedOwnerMatchup,
} from '../../core/cycle/cycle.service';
import type { FantasyMatchup } from '../../core/cycle/cycle.models';
import { listenToFantasyDraft } from '../../core/draft/draft.service';
import type { DraftStatus } from '../../core/draft/draft.models';
import { DialogFocusTrapDirective } from '../accessibility/dialog-focus-trap.directive';
import {
  extractLeagueIdFromUrl,
  resolveMobileLeaguePrimaryDestination,
} from './mobile-navigation.util';

@Component({
  selector: 'app-navbar',
  imports: [
    RouterLink,
    RouterLinkActive,
    DialogFocusTrapDirective,
  ],
  templateUrl: './navbar.html',
  styleUrl: './navbar.css',
})
export class Navbar implements OnDestroy {
  readonly moreOpen = signal(false);
  readonly currentUrl = signal('');
  readonly draftStatus = signal<DraftStatus | null>(null);
  readonly navigationMatchup = signal<FantasyMatchup | null>(null);
  readonly isPlatformAdmin = computed(() => this.platformAdmin.isAdmin());

  readonly leagueId = computed(() => extractLeagueIdFromUrl(this.currentUrl()));

  readonly isLeagueContext = computed(() => Boolean(this.leagueId()));

  readonly mobileLeaguePrimary = computed(() =>
    resolveMobileLeaguePrimaryDestination({
      leagueId: this.leagueId(),
      draftStatus: this.draftStatus(),
      matchup: this.navigationMatchup(),
    }),
  );

  private readonly routerEventsSubscription: Subscription;
  private readonly stopAuthListener: () => void;
  private stopDraftListener: (() => void) | null = null;
  private stopMatchupListener: (() => void) | null = null;
  private activeNavigationLeagueId = '';
  private activeNavigationOwnerId = '';
  private activeMatchupListenerKey = '';

  constructor(
    private router: Router,
    private platformAdmin: PlatformAdminService,
  ) {
    this.currentUrl.set(this.router.url);
    void this.platformAdmin.refreshAccess();
    this.connectLeagueNavigation(this.leagueId());

    this.stopAuthListener = listenToAuthState((user) => {
      const ownerId = user?.uid ?? '';

      if (ownerId === this.activeNavigationOwnerId) {
        return;
      }

      this.activeNavigationOwnerId = ownerId;
      this.syncMatchupNavigation();
    });

    this.routerEventsSubscription = this.router.events
      .pipe(
        filter(
          (event): event is NavigationEnd =>
            event instanceof NavigationEnd,
        ),
      )
      .subscribe((event) => {
        this.currentUrl.set(event.urlAfterRedirects);
        this.closeMore();
        this.connectLeagueNavigation(this.leagueId());
      });
  }

  ngOnDestroy(): void {
    this.routerEventsSubscription.unsubscribe();
    this.stopAuthListener();
    this.stopLeagueNavigationListeners();
  }

  toggleMore(): void {
    this.moreOpen.update((isOpen) => !isOpen);
  }

  closeMore(): void {
    this.moreOpen.set(false);
  }

  isExactRoute(path: string): boolean {
    const urlWithoutQuery = this.currentUrl().split(/[?#]/)[0];

    return urlWithoutQuery === path;
  }

  isLeagueHomeActive(): boolean {
    const leagueId = this.leagueId();

    return Boolean(
      leagueId &&
      this.isExactRoute(`/leagues/${encodeURIComponent(leagueId)}`),
    );
  }

  isLeagueSectionActive(section: string): boolean {
    const leagueId = this.leagueId();
    const urlWithoutQuery = this.currentUrl().split(/[?#]/)[0];

    return Boolean(
      leagueId &&
      urlWithoutQuery.startsWith(
        `/leagues/${encodeURIComponent(leagueId)}/${section}`,
      ),
    );
  }

  isMobileLeaguePrimaryActive(): boolean {
    const destination = this.mobileLeaguePrimary();

    if (destination.kind === 'draft') {
      return this.isLeagueSectionActive('draft');
    }

    if (destination.kind === 'matchup') {
      const leagueId = this.leagueId();
      const urlWithoutQuery = this.currentUrl().split(/[?#]/)[0];

      return Boolean(
        leagueId &&
        new RegExp(
          `^/leagues/${this.escapeForRegExp(
            encodeURIComponent(leagueId),
          )}/cycles/\\d+(?:/matchups/[^/?#]+)?/?$`,
        ).test(urlWithoutQuery),
      );
    }

    return this.isLeagueHomeActive();
  }

  async logout(): Promise<void> {
    this.closeMore();
    await logoutUser();
    await this.router.navigate(['/']);
  }

  private connectLeagueNavigation(leagueId: string): void {
    if (leagueId === this.activeNavigationLeagueId) {
      this.syncMatchupNavigation();
      return;
    }

    this.stopLeagueNavigationListeners();
    this.activeNavigationLeagueId = leagueId;
    this.draftStatus.set(null);
    this.navigationMatchup.set(null);

    if (!leagueId) {
      return;
    }

    this.stopDraftListener = listenToFantasyDraft(leagueId, (draft) => {
      this.draftStatus.set(draft?.status ?? null);
      this.syncMatchupNavigation();
    });
  }

  private syncMatchupNavigation(): void {
    const shouldFollowMatchup =
      Boolean(this.activeNavigationLeagueId) &&
      Boolean(this.activeNavigationOwnerId) &&
      this.draftStatus() === 'complete';

    const nextListenerKey = shouldFollowMatchup
      ? `${this.activeNavigationLeagueId}:${this.activeNavigationOwnerId}`
      : '';

    if (nextListenerKey === this.activeMatchupListenerKey) {
      return;
    }

    this.stopMatchupListener?.();
    this.stopMatchupListener = null;
    this.activeMatchupListenerKey = nextListenerKey;
    this.navigationMatchup.set(null);

    if (!nextListenerKey) {
      return;
    }

    this.stopMatchupListener = listenToEarliestUnfinishedOwnerMatchup(
      this.activeNavigationLeagueId,
      this.activeNavigationOwnerId,
      (matchup) => this.navigationMatchup.set(matchup),
    );
  }

  private stopLeagueNavigationListeners(): void {
    this.stopDraftListener?.();
    this.stopMatchupListener?.();
    this.stopDraftListener = null;
    this.stopMatchupListener = null;
    this.activeMatchupListenerKey = '';
  }

  private escapeForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
