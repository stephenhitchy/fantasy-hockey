import { Injectable } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import type { Analytics } from 'firebase/analytics';
import { filter, Subscription } from 'rxjs';

import { firebaseApp } from '../firebase-app';

export type TelemetryValue = string | number | boolean;
export type TelemetryParameters = Record<string, TelemetryValue | null | undefined>;

const MAX_PARAMETER_LENGTH = 100;
const MAX_EVENT_NAME_LENGTH = 40;

function isLocalDevelopmentHost(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  const hostname = window.location.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function normalizeEventName(eventName: string): string {
  return eventName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, MAX_EVENT_NAME_LENGTH);
}

function sanitizeRoute(url: string): string {
  const path = url.split(/[?#]/)[0] || '/';
  const segments = path.split('/').filter(Boolean);
  const sanitized: string[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    const previous = segments[index - 1] ?? '';

    if (previous === 'join') {
      sanitized.push(':inviteCode');
      continue;
    }

    if (previous === 'leagues' && segment !== 'create' && segment !== 'join') {
      sanitized.push(':leagueId');
      continue;
    }

    if (previous === 'players') {
      sanitized.push(':playerId');
      continue;
    }

    if (previous === 'matchups') {
      sanitized.push(':matchupId');
      continue;
    }

    if (previous === 'assets') {
      sanitized.push(':assetKey');
      continue;
    }

    if (previous === 'cycles' && /^\d+$/.test(segment)) {
      sanitized.push(':cycleNumber');
      continue;
    }

    sanitized.push(segment);
  }

  return `/${sanitized.join('/')}` || '/';
}

function sanitizeParameters(parameters: TelemetryParameters): Record<string, TelemetryValue> {
  const sanitized: Record<string, TelemetryValue> = {};

  for (const [rawKey, rawValue] of Object.entries(parameters)) {
    if (rawValue === null || rawValue === undefined) {
      continue;
    }

    const key = rawKey
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 40);

    if (!key) {
      continue;
    }

    sanitized[key] =
      typeof rawValue === 'string' ? rawValue.slice(0, MAX_PARAMETER_LENGTH) : rawValue;
  }

  return sanitized;
}

@Injectable({ providedIn: 'root' })
export class TelemetryService {
  private analytics: Analytics | null = null;
  private initializationPromise: Promise<Analytics | null> | null = null;
  private routeSubscription: Subscription | null = null;

  start(router: Router): void {
    if (this.routeSubscription) {
      return;
    }

    this.routeSubscription = router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        this.track('page_view', {
          page_path: sanitizeRoute(event.urlAfterRedirects),
          page_title: 'RinkRat Fantasy',
        });
      });

    void this.ensureAnalytics();
  }

  track(eventName: string, parameters: TelemetryParameters = {}): void {
    const normalizedEventName = normalizeEventName(eventName);

    if (!normalizedEventName) {
      return;
    }

    void this.ensureAnalytics().then(async (analytics) => {
      if (!analytics) {
        return;
      }

      const { logEvent } = await import('firebase/analytics');
      logEvent(analytics, normalizedEventName, sanitizeParameters(parameters));
    });
  }

  trackErrorCategory(category: string, source: string): void {
    this.track('client_error', {
      category: category.slice(0, 60),
      source: source.slice(0, 60),
    });
  }

  sanitizedCurrentRoute(): string {
    if (typeof window === 'undefined') {
      return '/';
    }

    return sanitizeRoute(`${window.location.pathname}${window.location.search}`);
  }

  sanitizedRoute(route: string): string {
    return sanitizeRoute(route);
  }

  private ensureAnalytics(): Promise<Analytics | null> {
    if (this.analytics) {
      return Promise.resolve(this.analytics);
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.initializeAnalytics();
    return this.initializationPromise;
  }

  private async initializeAnalytics(): Promise<Analytics | null> {
    if (typeof window === 'undefined' || isLocalDevelopmentHost()) {
      return null;
    }

    try {
      const { getAnalytics, isSupported } = await import('firebase/analytics');
      const supported = await isSupported();

      if (!supported) {
        return null;
      }

      this.analytics = getAnalytics(firebaseApp);
      return this.analytics;
    } catch (error: unknown) {
      console.warn('RinkRat analytics could not be initialized.', error);
      return null;
    }
  }
}
