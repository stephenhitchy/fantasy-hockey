import { Injectable, OnDestroy } from '@angular/core';
import {
  NavigationEnd,
  NavigationStart,
  Router,
} from '@angular/router';
import { Subscription } from 'rxjs';

import {
  NavigationTriggerKind,
  isInternalNavigationHistoryEligible,
  normalizeInternalNavigationUrl,
  recordInternalNavigation,
  resolvePreviousInternalNavigation,
} from './navigation-history.util';

const NAVIGATION_HISTORY_STORAGE_KEY = 'rinkrat-internal-navigation-history-v1';
const HISTORY_BACK_SELECTOR = [
  'a.league-return-link',
  'a.support-back',
  'a.legal-back',
  'a.known-issues-back',
  'a.fairness-back',
  'a.commissioner-guide-back',
  'a.decision-back-link',
  'a.back-link.rr-pixel-shell-back-link',
  'a[data-rinkrat-history-back]',
].join(',');

function readStoredHistory(): string[] {
  if (typeof sessionStorage === 'undefined') {
    return [];
  }

  try {
    const value = JSON.parse(sessionStorage.getItem(NAVIGATION_HISTORY_STORAGE_KEY) ?? '[]');
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is string =>
            typeof entry === 'string' && isInternalNavigationHistoryEligible(entry),
        )
      : [];
  } catch {
    return [];
  }
}

function resolveAnchorFallback(anchor: HTMLAnchorElement): string {
  if (typeof window === 'undefined') {
    return '/dashboard';
  }

  try {
    const url = new URL(anchor.href, window.location.origin);

    if (url.origin !== window.location.origin) {
      return '';
    }

    return normalizeInternalNavigationUrl(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    return '';
  }
}

@Injectable({ providedIn: 'root' })
export class NavigationHistoryService implements OnDestroy {
  private readonly subscription: Subscription;
  private history = readStoredHistory();
  private navigationTrigger: NavigationTriggerKind = 'imperative';
  private navigationInProgress = false;

  private readonly handleHistoryBackClick = (event: MouseEvent): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const target = event.target;
    const element =
      target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;

    if (!element) {
      return;
    }

    const anchor = element.closest<HTMLAnchorElement>(HISTORY_BACK_SELECTOR);

    if (!anchor || anchor.target || anchor.hasAttribute('download')) {
      return;
    }

    const fallbackUrl = resolveAnchorFallback(anchor);

    if (!fallbackUrl) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    void this.goBack(fallbackUrl);
  };

  constructor(private readonly router: Router) {
    // Wait for Angular's first completed navigation instead of seeding the
    // history from router.url during application bootstrap. At that moment
    // Angular can still report `/`, even when the browser directly loaded a
    // deeper resource such as `/support`; storing that placeholder route made
    // a signed-in manager's first Back action land on the sign-in page.
    this.subscription = router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        // Angular types this value as optional for synthetic or legacy navigation
        // events. Treat an omitted trigger as a normal imperative navigation.
        this.navigationTrigger = event.navigationTrigger ?? 'imperative';
        return;
      }

      if (!(event instanceof NavigationEnd)) {
        return;
      }

      this.history = recordInternalNavigation(
        this.history,
        event.urlAfterRedirects,
        this.navigationTrigger,
      );
      this.navigationTrigger = 'imperative';
      this.persist();
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('click', this.handleHistoryBackClick, true);
    }
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();

    if (typeof document !== 'undefined') {
      document.removeEventListener('click', this.handleHistoryBackClick, true);
    }
  }

  async goBack(fallbackUrl: string): Promise<boolean> {
    if (this.navigationInProgress) {
      return false;
    }

    this.navigationInProgress = true;

    try {
      const previous = resolvePreviousInternalNavigation(this.history, this.router.url);

      if (previous) {
        const navigationSucceeded = await this.router.navigateByUrl(previous.destination);

        if (navigationSucceeded) {
          this.history = recordInternalNavigation(
            previous.remainingHistory,
            this.router.url,
          );
          this.persist();
        }

        return navigationSucceeded;
      }

      const fallback = normalizeInternalNavigationUrl(fallbackUrl) || '/dashboard';
      return await this.router.navigateByUrl(fallback);
    } finally {
      this.navigationInProgress = false;
    }
  }

  private persist(): void {
    if (typeof sessionStorage === 'undefined') {
      return;
    }

    try {
      sessionStorage.setItem(NAVIGATION_HISTORY_STORAGE_KEY, JSON.stringify(this.history));
    } catch {
      // History-aware back navigation is a convenience; storage failure must not block routing.
    }
  }
}
