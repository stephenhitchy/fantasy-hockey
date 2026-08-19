import { computed, Injectable, OnDestroy, signal } from '@angular/core';

import { BUNDLED_RELEASE_MANIFEST } from '../../../environments/generated-release-manifest';
import { TelemetryService } from '../observability/telemetry.service';
import type {
  ReleaseManifest,
  ReleaseUpdateSnapshot,
  ReleaseUpdateStatus,
} from './release-manifest.models';
import {
  compareReleaseManifests,
  normalizeReleaseManifest,
} from './release-manifest.util';

const RELEASE_CHECK_INTERVAL_MILLISECONDS = 2 * 60 * 1_000;
const RELEASE_CHECK_MINIMUM_GAP_MILLISECONDS = 20_000;
const INITIAL_RELEASE_CHECK_DELAY_MILLISECONDS = 4_000;
const ONLINE_RELEASE_CHECK_DELAY_MILLISECONDS = 1_500;
const APPLIED_UPDATE_STORAGE_KEY = 'rinkrat:release-reload-target:v1';
const APPLIED_UPDATE_MAX_AGE_MILLISECONDS = 20 * 60 * 1_000;

interface AppliedUpdateMarker {
  targetBuildId: string;
  targetReleaseLabel: string;
  fromBuildId: string;
  requestedAt: string;
}

function isAppliedUpdateMarker(value: unknown): value is AppliedUpdateMarker {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<AppliedUpdateMarker>;
  return (
    typeof candidate.targetBuildId === 'string' &&
    Boolean(candidate.targetBuildId.trim()) &&
    typeof candidate.targetReleaseLabel === 'string' &&
    Boolean(candidate.targetReleaseLabel.trim()) &&
    typeof candidate.fromBuildId === 'string' &&
    Boolean(candidate.fromBuildId.trim()) &&
    typeof candidate.requestedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.requestedAt))
  );
}

@Injectable({ providedIn: 'root' })
export class ReleaseUpdateService implements OnDestroy {
  readonly bundledManifest: ReleaseManifest = BUNDLED_RELEASE_MANIFEST;
  readonly latestManifest = signal<ReleaseManifest | null>(null);
  readonly status = signal<ReleaseUpdateStatus>('idle');
  readonly checking = signal(false);
  readonly lastCheckedAt = signal<string | null>(null);
  readonly errorMessage = signal('');
  readonly reloadRequested = signal(false);

  readonly direction = computed(() =>
    compareReleaseManifests(this.bundledManifest, this.latestManifest()),
  );
  readonly updateAvailable = computed(() => this.direction() !== 'same');
  readonly latestReleaseLabel = computed(
    () => this.latestManifest()?.releaseLabel ?? this.bundledManifest.releaseLabel,
  );

  private started = false;
  private destroyed = false;
  private checkPromise: Promise<boolean> | null = null;
  private initialTimer: number | null = null;
  private intervalTimer: number | null = null;
  private onlineTimer: number | null = null;
  private lastCheckStartedAtMilliseconds = 0;
  private lastReportedDeploymentBuildId = '';

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') {
      return;
    }

    void this.checkForUpdate();
  };

  private readonly handleOnline = (): void => {
    if (typeof window === 'undefined') {
      return;
    }

    if (this.onlineTimer !== null) {
      window.clearTimeout(this.onlineTimer);
    }

    this.onlineTimer = window.setTimeout(() => {
      this.onlineTimer = null;
      void this.checkForUpdate(true);
    }, ONLINE_RELEASE_CHECK_DELAY_MILLISECONDS);
  };

  constructor(private readonly telemetry: TelemetryService) {}

  start(): void {
    if (this.started || this.destroyed || typeof window === 'undefined') {
      return;
    }

    this.started = true;
    window.addEventListener('online', this.handleOnline);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.initialTimer = window.setTimeout(() => {
      this.initialTimer = null;
      void this.checkForUpdate(true);
    }, INITIAL_RELEASE_CHECK_DELAY_MILLISECONDS);

    this.intervalTimer = window.setInterval(() => {
      void this.checkForUpdate();
    }, RELEASE_CHECK_INTERVAL_MILLISECONDS);
  }

  ngOnDestroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);

      if (this.initialTimer !== null) {
        window.clearTimeout(this.initialTimer);
        this.initialTimer = null;
      }

      if (this.intervalTimer !== null) {
        window.clearInterval(this.intervalTimer);
        this.intervalTimer = null;
      }

      if (this.onlineTimer !== null) {
        window.clearTimeout(this.onlineTimer);
        this.onlineTimer = null;
      }
    }

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  async checkForUpdate(force = false): Promise<boolean> {
    if (typeof window === 'undefined' || typeof fetch === 'undefined') {
      return false;
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.status.set('offline');
      this.errorMessage.set('');
      return false;
    }

    if (this.checkPromise) {
      return this.checkPromise;
    }

    const now = Date.now();

    if (
      !force &&
      now - this.lastCheckStartedAtMilliseconds < RELEASE_CHECK_MINIMUM_GAP_MILLISECONDS
    ) {
      return this.updateAvailable();
    }

    this.lastCheckStartedAtMilliseconds = now;
    this.checking.set(true);
    this.status.set('checking');
    this.errorMessage.set('');
    this.checkPromise = this.fetchLatestManifest();

    try {
      return await this.checkPromise;
    } finally {
      this.checkPromise = null;
      this.checking.set(false);
    }
  }

  requestReload(reloadAction: () => void = () => window.location.reload()): boolean {
    if (
      typeof window === 'undefined' ||
      !this.updateAvailable() ||
      this.reloadRequested()
    ) {
      return false;
    }

    const latest = this.latestManifest();

    if (!latest) {
      return false;
    }

    this.reloadRequested.set(true);
    this.storeAppliedUpdateMarker(latest);
    this.telemetry.track('release_update_reload_requested', {
      from_release: this.bundledManifest.releaseLabel,
      to_release: latest.releaseLabel,
      direction: this.direction(),
    });
    try {
      reloadAction();
    } catch {
      window.location.reload();
    }
    return true;
  }

  consumeAppliedUpdateNotice(): string {
    if (typeof sessionStorage === 'undefined') {
      return '';
    }

    try {
      const raw = sessionStorage.getItem(APPLIED_UPDATE_STORAGE_KEY);

      if (!raw) {
        return '';
      }

      const marker = JSON.parse(raw);

      if (!isAppliedUpdateMarker(marker)) {
        sessionStorage.removeItem(APPLIED_UPDATE_STORAGE_KEY);
        return '';
      }

      const age = Date.now() - Date.parse(marker.requestedAt);

      if (age < 0 || age > APPLIED_UPDATE_MAX_AGE_MILLISECONDS) {
        sessionStorage.removeItem(APPLIED_UPDATE_STORAGE_KEY);
        return '';
      }

      if (marker.targetBuildId !== this.bundledManifest.buildId) {
        return '';
      }

      sessionStorage.removeItem(APPLIED_UPDATE_STORAGE_KEY);
      this.telemetry.track('release_update_applied', {
        release: this.bundledManifest.releaseLabel,
      });
      return `RinkRat updated to ${this.bundledManifest.releaseLabel}.`;
    } catch {
      try {
        sessionStorage.removeItem(APPLIED_UPDATE_STORAGE_KEY);
      } catch {
        // Session storage can be unavailable in private or hardened browser modes.
      }
      return '';
    }
  }

  getSnapshot(): ReleaseUpdateSnapshot {
    return {
      bundled: this.bundledManifest,
      latest: this.latestManifest(),
      status: this.status(),
      direction: this.direction(),
      updateAvailable: this.updateAvailable(),
      checking: this.checking(),
      lastCheckedAt: this.lastCheckedAt(),
      errorMessage: this.errorMessage(),
    };
  }

  private async fetchLatestManifest(): Promise<boolean> {
    try {
      const url = new URL('release-manifest.json', document.baseURI);
      url.searchParams.set('rinkratReleaseCheck', Date.now().toString(36));
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Release check returned HTTP ${response.status}.`);
      }

      const manifest = normalizeReleaseManifest(await response.json());

      if (!manifest) {
        throw new Error('The deployed release manifest is invalid.');
      }

      this.latestManifest.set(manifest);
      this.lastCheckedAt.set(new Date().toISOString());
      const updateAvailable = manifest.buildId !== this.bundledManifest.buildId;
      this.status.set(updateAvailable ? 'update-available' : 'current');
      this.errorMessage.set('');

      if (
        updateAvailable &&
        manifest.buildId !== this.lastReportedDeploymentBuildId
      ) {
        this.lastReportedDeploymentBuildId = manifest.buildId;
        this.telemetry.track('release_update_available', {
          current_release: this.bundledManifest.releaseLabel,
          deployed_release: manifest.releaseLabel,
          direction: compareReleaseManifests(this.bundledManifest, manifest),
        });
      }

      return updateAvailable;
    } catch (error: unknown) {
      this.lastCheckedAt.set(new Date().toISOString());
      this.status.set('error');
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to check the deployed RinkRat version.',
      );
      return this.updateAvailable();
    }
  }

  private storeAppliedUpdateMarker(latest: ReleaseManifest): void {
    if (typeof sessionStorage === 'undefined') {
      return;
    }

    const marker: AppliedUpdateMarker = {
      targetBuildId: latest.buildId,
      targetReleaseLabel: latest.releaseLabel,
      fromBuildId: this.bundledManifest.buildId,
      requestedAt: new Date().toISOString(),
    };

    try {
      sessionStorage.setItem(APPLIED_UPDATE_STORAGE_KEY, JSON.stringify(marker));
    } catch {
      // A reload still works when session storage is unavailable.
    }
  }
}
