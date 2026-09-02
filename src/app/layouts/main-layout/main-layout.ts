import {
  AfterViewInit,
  Component,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  ViewChild,
} from '@angular/core';
import {
  ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
  RouterLink,
  RouterOutlet,
} from '@angular/router';
import { Title } from '@angular/platform-browser';
import { filter, Subscription } from 'rxjs';

import { getScoringRuntimeState } from '../../core/cycle/cycle-runtime.config';
import { ClientHealthService } from '../../core/observability/client-health.service';
import { PrivateSeasonEngagementService } from '../../core/operations/private-season-engagement.service';
import { ServiceStatusService } from '../../core/operations/service-status.service';
import { Navbar } from '../../shared/navbar/navbar';
import { CoachHelp } from '../../shared/coach-help/coach-help';
import { buildFullPixelMarquee, PixelLogoItem } from '../../shared/pixel-theme/pixel-theme.data';

@Component({
  selector: 'app-main-layout',
  imports: [RouterLink, RouterOutlet, Navbar, CoachHelp],
  templateUrl: './main-layout.html',
  styleUrl: './main-layout.css',
})
export class MainLayout implements AfterViewInit, OnDestroy {
  @ViewChild('mainContent') private mainContent?: ElementRef<HTMLElement>;

  protected readonly clientHealth = inject(ClientHealthService);
  protected readonly serviceStatus = inject(ServiceStatusService);
  private readonly privateSeasonEngagement = inject(PrivateSeasonEngagementService);
  readonly scoringRuntime = getScoringRuntimeState();
  readonly teamRibbon: PixelLogoItem[] = buildFullPixelMarquee();
  readonly routeAnnouncement = signal('');

  private readonly routeSubscription: Subscription;
  private lastAccessiblePath = '';
  private routeFocusTimer: number | null = null;
  private routeFocusMissedBeforeView = false;
  private routeFocusObserver: MutationObserver | null = null;
  private routeFocusObserverTimer: number | null = null;
  private routeFocusedElement: HTMLElement | null = null;

  constructor(
    private readonly router: Router,
    private readonly documentTitle: Title,
  ) {
    this.serviceStatus.start();
    this.routeSubscription = this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => this.handleRouteChange(event.urlAfterRedirects));
  }

  ngAfterViewInit(): void {
    this.handleRouteChange(this.router.url);
    this.repairMissedInitialRouteFocus();
  }

  ngOnDestroy(): void {
    this.routeSubscription.unsubscribe();
    this.serviceStatus.stop();

    if (this.routeFocusTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.routeFocusTimer);
    }

    this.stopRouteFocusStabilityWatch();
  }

  private handleRouteChange(rawUrl: string): void {
    const path = rawUrl.split(/[?#]/)[0];

    this.privateSeasonEngagement.observeRoute(path);

    if (path === this.lastAccessiblePath) {
      return;
    }

    this.lastAccessiblePath = path;
    this.stopRouteFocusStabilityWatch();
    const pageTitle = this.getDeepestRouteTitle(this.router.routerState.snapshot.root);
    const fullTitle = pageTitle === 'RinkRat Fantasy' ? pageTitle : `${pageTitle} | RinkRat Fantasy`;

    this.documentTitle.setTitle(fullTitle);
    this.routeAnnouncement.set('');

    if (typeof window === 'undefined') {
      this.routeAnnouncement.set(`${pageTitle} page loaded.`);
      return;
    }

    if (this.routeFocusTimer !== null) {
      window.clearTimeout(this.routeFocusTimer);
    }

    this.routeFocusTimer = window.setTimeout(() => {
      this.routeFocusTimer = null;
      this.routeAnnouncement.set(`${pageTitle} page loaded.`);
      this.focusRouteHeadingOrMain();
    }, 0);
  }

  private getDeepestRouteTitle(snapshot: ActivatedRouteSnapshot): string {
    let current: ActivatedRouteSnapshot | null = snapshot;
    let title = 'RinkRat Fantasy';

    while (current) {
      if (typeof current.title === 'string' && current.title.trim()) {
        title = current.title.trim();
      }

      current = current.firstChild ?? null;
    }

    return title;
  }

  private focusRouteHeadingOrMain(): void {
    const main = this.mainContent?.nativeElement;

    if (!main) {
      this.routeFocusMissedBeforeView = true;
      return;
    }

    this.routeFocusMissedBeforeView = false;

    const heading = main.querySelector<HTMLElement>('h1');
    const target = heading ?? main;

    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }

    target.focus({ preventScroll: true });
    this.watchRouteFocusStability(main, target);
  }

  private repairMissedInitialRouteFocus(): void {
    if (!this.routeFocusMissedBeforeView || typeof document === 'undefined') {
      return;
    }

    const activeElement = document.activeElement;
    this.routeFocusMissedBeforeView = false;

    if (activeElement && activeElement !== document.body) {
      return;
    }

    this.focusRouteHeadingOrMain();
  }

  private watchRouteFocusStability(main: HTMLElement, focusedElement: HTMLElement): void {
    this.stopRouteFocusStabilityWatch();

    if (typeof MutationObserver === 'undefined' || typeof window === 'undefined') {
      return;
    }

    this.routeFocusedElement = focusedElement;
    this.routeFocusObserver = new MutationObserver(() => {
      this.repairReplacedRouteFocus(main);
    });
    this.routeFocusObserver.observe(main, { childList: true, subtree: true });
    this.routeFocusObserverTimer = window.setTimeout(() => {
      this.stopRouteFocusStabilityWatch();
    }, 5_000);
  }

  private repairReplacedRouteFocus(main: HTMLElement): void {
    const focusedElement = this.routeFocusedElement;
    const preferredTarget = main.querySelector<HTMLElement>('h1') ?? main;

    if (!focusedElement || preferredTarget === focusedElement) {
      return;
    }

    const activeElement = document.activeElement;

    if (
      activeElement &&
      activeElement !== document.body &&
      activeElement !== main &&
      activeElement !== focusedElement
    ) {
      this.stopRouteFocusStabilityWatch();
      return;
    }

    if (!preferredTarget.hasAttribute('tabindex')) {
      preferredTarget.setAttribute('tabindex', '-1');
    }

    preferredTarget.focus({ preventScroll: true });
    this.routeFocusedElement = preferredTarget;
  }

  private stopRouteFocusStabilityWatch(): void {
    this.routeFocusObserver?.disconnect();
    this.routeFocusObserver = null;
    this.routeFocusedElement = null;

    if (this.routeFocusObserverTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.routeFocusObserverTimer);
      this.routeFocusObserverTimer = null;
    }
  }
}
