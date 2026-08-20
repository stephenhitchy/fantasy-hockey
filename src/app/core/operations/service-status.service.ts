import { computed, Injectable, signal } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';
import type {
  PublicServiceStatusSnapshot,
  ServiceStatusState,
} from './service-status.models';
import {
  highestPriorityBannerIncident,
  normalizePublicServiceStatusSnapshot,
} from './service-status.util';

const CACHE_KEY = 'rinkrat:public-service-status:v1';
const CACHE_MAXIMUM_AGE_MILLISECONDS = 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MILLISECONDS = 5 * 60 * 1000;

interface StoredStatusCache {
  savedAt: string;
  snapshot: PublicServiceStatusSnapshot;
}

function parseCache(): StoredStatusCache | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredStatusCache>;
    const snapshot = normalizePublicServiceStatusSnapshot(parsed.snapshot);
    if (!parsed.savedAt || !snapshot) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    const savedAt = Date.parse(parsed.savedAt);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > CACHE_MAXIMUM_AGE_MILLISECONDS) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return { savedAt: parsed.savedAt, snapshot };
  } catch {
    return null;
  }
}

function writeCache(snapshot: PublicServiceStatusSnapshot): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      snapshot,
    } satisfies StoredStatusCache));
  } catch {
    // Public status caching is best effort only.
  }
}

@Injectable({ providedIn: 'root' })
export class ServiceStatusService {
  readonly state = signal<ServiceStatusState>({
    snapshot: null,
    stale: false,
    source: 'none',
    loadedAt: null,
  });
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly bannerIncident = computed(() =>
    highestPriorityBannerIncident(this.state().snapshot?.activeIncidents ?? []),
  );

  private started = false;
  private refreshTimer: number | null = null;

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.load();

    if (typeof window !== 'undefined') {
      this.refreshTimer = window.setInterval(() => {
        void this.load(true);
      }, REFRESH_INTERVAL_MILLISECONDS);
    }
  }

  stop(): void {
    if (this.refreshTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.started = false;
  }

  async load(force = false): Promise<PublicServiceStatusSnapshot | null> {
    if (this.loading()) {
      return this.state().snapshot;
    }

    if (!force && this.state().snapshot) {
      return this.state().snapshot;
    }

    this.loading.set(true);
    this.errorMessage.set('');

    try {
      const callable = httpsCallable<Record<string, never>, PublicServiceStatusSnapshot>(
        functions,
        'getPublicServiceStatus',
        { timeout: 25_000 },
      );
      const response = await callable({});
      const snapshot = normalizePublicServiceStatusSnapshot(response.data);
      if (!snapshot) {
        throw new Error('RinkRat returned an invalid public service-status response.');
      }
      writeCache(snapshot);
      this.state.set({
        snapshot,
        stale: false,
        source: 'live',
        loadedAt: new Date().toISOString(),
      });
      return snapshot;
    } catch {
      const cached = parseCache();
      if (cached) {
        this.state.set({
          snapshot: cached.snapshot,
          stale: true,
          source: 'cache',
          loadedAt: cached.savedAt,
        });
        this.errorMessage.set('Live status is unavailable. Showing the last saved public status.');
        return cached.snapshot;
      }

      this.errorMessage.set('Live RinkRat service status could not be loaded.');
      this.state.set({
        snapshot: null,
        stale: false,
        source: 'none',
        loadedAt: null,
      });
      return null;
    } finally {
      this.loading.set(false);
    }
  }
}
