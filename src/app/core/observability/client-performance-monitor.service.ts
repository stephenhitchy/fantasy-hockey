import { Injectable, OnDestroy } from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  Router,
} from '@angular/router';
import { Subscription } from 'rxjs';

import { BetaOperationsService } from '../beta-operations/beta-operations.service';
import { ClientHealthService } from './client-health.service';
import type { ClientConnectionSnapshot } from './client-health.service';
import {
  buildClientVitalsParameters,
  type ClientPerformanceMetrics,
  estimateInpFromInteractions,
  roundMetric,
} from './client-performance.util';
import {
  beginFirestoreRouteObservation,
  completeFirestoreRouteObservation,
  type FirestoreListenerSnapshot,
  type FirestoreRouteObservation,
  getFirestoreListenerSnapshot,
  isClientHealthMonitorEnabled,
  markFirestoreRouteNavigationSettled,
} from './firestore-listener-monitor';
import {
  buildFirestoreRouteEnvelopes,
  type FirestoreRouteEnvelope,
} from './firestore-route-evidence.util';
import { TelemetryService } from './telemetry.service';

const FIRESTORE_ROUTE_SETTLE_MILLISECONDS = 3_000;
const MAX_FIRESTORE_ROUTE_SAMPLES_PER_SESSION = 24;

interface LayoutShiftPerformanceEntry extends PerformanceEntry {
  value?: number;
  hadRecentInput?: boolean;
}

interface EventTimingPerformanceEntry extends PerformanceEntry {
  interactionId?: number;
  duration: number;
}

export interface ClientPerformanceSnapshot {
  route: string;
  metrics: ClientPerformanceMetrics;
  connection: ClientConnectionSnapshot;
  firestoreListeners: FirestoreListenerSnapshot;
  firestoreRouteEnvelopes: FirestoreRouteEnvelope[];
  generatedAt: string;
}

interface ClientHealthDebugBridge {
  snapshot: () => ClientPerformanceSnapshot;
  print: () => ClientPerformanceSnapshot;
}

@Injectable({ providedIn: 'root' })
export class ClientPerformanceMonitorService implements OnDestroy {
  private routeSubscription: Subscription | null = null;
  private routeStartedAt: number | null = null;
  private routeStartedUrl = '/';
  private observers: PerformanceObserver[] = [];
  private settleTimer: number | null = null;
  private firestoreRouteSettleTimer: number | null = null;
  private firstAnimationFrame: number | null = null;
  private secondAnimationFrame: number | null = null;
  private firestoreRouteObservationToken: number | null = null;
  private metricsFlushed = false;
  private started = false;
  private latestRoute = '/';
  private readonly interactions = new Map<number, number>();
  private readonly firestoreRouteObservations: FirestoreRouteObservation[] = [];

  private readonly metrics: ClientPerformanceMetrics = {
    firstContentfulPaintMilliseconds: null,
    largestContentfulPaintMilliseconds: null,
    cumulativeLayoutShift: 0,
    interactionToNextPaintMilliseconds: null,
    longTaskCount: 0,
    longestTaskMilliseconds: 0,
    latestRouteReadyMilliseconds: null,
    slowestRouteReadyMilliseconds: null,
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.flushVitals('hidden');
    }
  };

  private readonly handlePageHide = (): void => {
    this.flushVitals('pagehide');
  };

  constructor(
    private readonly telemetry: TelemetryService,
    private readonly clientHealth: ClientHealthService,
    private readonly betaOperations: BetaOperationsService,
  ) {}

  start(router: Router): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.latestRoute = this.telemetry.sanitizedCurrentRoute();
    this.routeSubscription = router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.finishFirestoreRouteObservation('superseded');
        this.routeStartedAt = this.now();
        this.routeStartedUrl = event.url;
        this.firestoreRouteObservationToken = beginFirestoreRouteObservation(
          this.telemetry.sanitizedRoute(event.url),
        );
        return;
      }

      if (event instanceof NavigationEnd) {
        this.latestRoute = this.telemetry.sanitizedRoute(event.urlAfterRedirects);
        this.scheduleFirestoreRouteObservation();
        this.measureRouteReady(event.urlAfterRedirects);
        return;
      }

      if (event instanceof NavigationCancel || event instanceof NavigationError) {
        this.routeStartedAt = null;
        this.finishFirestoreRouteObservation('cancelled');
      }
    });

    this.observeBrowserPerformance();
    this.installDebugBridge();

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.handlePageHide);
      this.settleTimer = window.setTimeout(() => this.flushVitals('settled'), 15_000);
    }
  }

  ngOnDestroy(): void {
    this.routeSubscription?.unsubscribe();
    this.routeSubscription = null;
    this.finishFirestoreRouteObservation('cancelled');

    for (const observer of this.observers) {
      observer.disconnect();
    }

    this.observers = [];

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.handlePageHide);

      if (this.settleTimer !== null) {
        window.clearTimeout(this.settleTimer);
      }

      if (this.firestoreRouteSettleTimer !== null) {
        window.clearTimeout(this.firestoreRouteSettleTimer);
        this.firestoreRouteSettleTimer = null;
      }

      if (this.firstAnimationFrame !== null) {
        window.cancelAnimationFrame(this.firstAnimationFrame);
      }

      if (this.secondAnimationFrame !== null) {
        window.cancelAnimationFrame(this.secondAnimationFrame);
      }
    }
  }

  getSnapshot(): ClientPerformanceSnapshot {
    return {
      route: this.latestRoute,
      metrics: {
        ...this.metrics,
        interactionToNextPaintMilliseconds: estimateInpFromInteractions(this.interactions),
      },
      connection: this.clientHealth.getSnapshot(),
      firestoreListeners: getFirestoreListenerSnapshot(),
      firestoreRouteEnvelopes: buildFirestoreRouteEnvelopes(
        this.firestoreRouteObservations,
      ),
      generatedAt: new Date().toISOString(),
    };
  }

  private scheduleFirestoreRouteObservation(): void {
    const token = this.firestoreRouteObservationToken;

    if (token === null || typeof window === 'undefined') {
      return;
    }

    markFirestoreRouteNavigationSettled(token, this.latestRoute);

    if (this.firestoreRouteSettleTimer !== null) {
      window.clearTimeout(this.firestoreRouteSettleTimer);
    }

    this.firestoreRouteSettleTimer = window.setTimeout(() => {
      this.firestoreRouteSettleTimer = null;
      this.finishFirestoreRouteObservation('settled');
    }, FIRESTORE_ROUTE_SETTLE_MILLISECONDS);
  }

  private finishFirestoreRouteObservation(
    outcome: FirestoreRouteObservation['outcome'],
  ): void {
    if (this.firestoreRouteSettleTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.firestoreRouteSettleTimer);
      this.firestoreRouteSettleTimer = null;
    }

    const token = this.firestoreRouteObservationToken;
    this.firestoreRouteObservationToken = null;

    if (token === null) {
      return;
    }

    const observation = completeFirestoreRouteObservation(token, outcome);

    if (!observation || outcome !== 'settled') {
      return;
    }

    this.firestoreRouteObservations.push(observation);

    if (
      this.firestoreRouteObservations.length > MAX_FIRESTORE_ROUTE_SAMPLES_PER_SESSION
    ) {
      this.firestoreRouteObservations.shift();
    }

    this.telemetry.track('firestore_route_evidence', {
      page_path: observation.route,
      listener_start: observation.listenerCountStart,
      listener_end: observation.listenerCountEnd,
      listener_peak: observation.peakListenerCount,
      listener_opened: observation.listenersOpened,
      listener_closed: observation.listenersClosed,
      navigation_cleanup: observation.navigationCleanupCount,
      first_snapshot_count: observation.firstSnapshotCount,
      first_snapshot_docs: observation.firstSnapshotDocumentCount,
      first_snapshot_unknown: observation.unknownDocumentCountSnapshots,
      first_snapshot_cache: observation.firstSnapshotFromCacheCount,
      first_snapshot_server: observation.firstSnapshotFromServerCount,
      cache_to_server: observation.cacheToServerTransitionCount,
      reconnect_snapshot: observation.reconnectSnapshotCount,
      retry_listener: observation.retryListenersOpened,
      hidden_snapshot: observation.hiddenSnapshotCount,
      listener_error: observation.listenerErrorCount,
      listener_lifetime_max_ms: observation.maxClosedListenerLifetimeMilliseconds,
      awaiting_first_snapshot: observation.awaitingFirstSnapshotCount,
    });

    if (isClientHealthMonitorEnabled()) {
      console.info(
        '[RinkRat client health] Firestore route evidence.',
        JSON.stringify(observation),
      );

      if (
        observation.awaitingFirstSnapshotCount > 0 ||
        observation.listenerErrorCount > 0 ||
        observation.peakListenerCount > 32
      ) {
        console.warn('[RinkRat client health] Firestore route evidence needs review.', observation);
      }
    }
  }

  private measureRouteReady(rawUrl: string): void {
    const navigationStartedAt = this.routeStartedAt;
    this.routeStartedAt = null;

    if (navigationStartedAt === null || typeof window === 'undefined') {
      return;
    }

    if (this.firstAnimationFrame !== null) {
      window.cancelAnimationFrame(this.firstAnimationFrame);
    }

    if (this.secondAnimationFrame !== null) {
      window.cancelAnimationFrame(this.secondAnimationFrame);
    }

    this.firstAnimationFrame = window.requestAnimationFrame(() => {
      this.firstAnimationFrame = null;
      this.secondAnimationFrame = window.requestAnimationFrame(() => {
        this.secondAnimationFrame = null;
        const duration = Math.max(0, this.now() - navigationStartedAt);
        this.metrics.latestRouteReadyMilliseconds = duration;
        this.metrics.slowestRouteReadyMilliseconds = Math.max(
          this.metrics.slowestRouteReadyMilliseconds ?? 0,
          duration,
        );

        const route = this.telemetry.sanitizedRoute(rawUrl || this.routeStartedUrl);
        const listenerSnapshot = getFirestoreListenerSnapshot();

        this.telemetry.track('route_ready', {
          page_path: route,
          duration_ms: roundMetric(duration) ?? 0,
          listener_count: listenerSnapshot.total,
          online: this.clientHealth.online(),
          connection_type: this.clientHealth.effectiveConnectionType(),
        });
        this.betaOperations.recordRouteReady(
          route,
          roundMetric(duration) ?? 0,
          listenerSnapshot.total,
        );

        if (
          isClientHealthMonitorEnabled() &&
          (duration >= 1_200 || listenerSnapshot.total > 32)
        ) {
          console.warn('[RinkRat client health] Slow or listener-heavy route.', {
            route,
            durationMilliseconds: roundMetric(duration),
            firestoreListeners: listenerSnapshot,
          });
        }
      });
    });
  }

  private observeBrowserPerformance(): void {
    if (typeof PerformanceObserver === 'undefined') {
      return;
    }

    this.observe('paint', (entry) => {
      if (entry.name === 'first-contentful-paint') {
        this.metrics.firstContentfulPaintMilliseconds = entry.startTime;
      }
    });

    this.observe('largest-contentful-paint', (entry) => {
      this.metrics.largestContentfulPaintMilliseconds = Math.max(
        this.metrics.largestContentfulPaintMilliseconds ?? 0,
        entry.startTime,
      );
    });

    this.observe('layout-shift', (entry) => {
      const shift = entry as LayoutShiftPerformanceEntry;

      if (!shift.hadRecentInput && typeof shift.value === 'number') {
        this.metrics.cumulativeLayoutShift += shift.value;
      }
    });

    this.observe('event', (entry) => {
      const event = entry as EventTimingPerformanceEntry;
      const interactionId = event.interactionId ?? 0;

      if (!interactionId || !Number.isFinite(event.duration)) {
        return;
      }

      this.interactions.set(
        interactionId,
        Math.max(this.interactions.get(interactionId) ?? 0, event.duration),
      );
      this.metrics.interactionToNextPaintMilliseconds = estimateInpFromInteractions(
        this.interactions,
      );
    }, { durationThreshold: 40 });

    this.observe('longtask', (entry) => {
      this.metrics.longTaskCount += 1;
      this.metrics.longestTaskMilliseconds = Math.max(
        this.metrics.longestTaskMilliseconds,
        entry.duration,
      );
    });
  }

  private observe(
    type: string,
    callback: (entry: PerformanceEntry) => void,
    extraOptions: Record<string, unknown> = {},
  ): void {
    const supportedTypes = PerformanceObserver.supportedEntryTypes;

    if (Array.isArray(supportedTypes) && !supportedTypes.includes(type)) {
      return;
    }

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          callback(entry);
        }
      });

      observer.observe({
        type,
        buffered: true,
        ...extraOptions,
      } as PerformanceObserverInit);
      this.observers.push(observer);
    } catch (error: unknown) {
      if (isClientHealthMonitorEnabled()) {
        console.debug(`[RinkRat client health] ${type} observer unavailable.`, error);
      }
    }
  }

  private flushVitals(reason: string): void {
    if (this.metricsFlushed || typeof window === 'undefined') {
      return;
    }

    this.metricsFlushed = true;
    this.metrics.interactionToNextPaintMilliseconds = estimateInpFromInteractions(
      this.interactions,
    );

    this.telemetry.track('client_vitals', {
      page_path: this.latestRoute,
      reason,
      ...buildClientVitalsParameters(
        this.metrics,
        window.innerWidth,
        this.clientHealth.effectiveConnectionType(),
        this.clientHealth.saveData(),
        this.clientHealth.online(),
      ),
    });
  }

  private installDebugBridge(): void {
    if (!isClientHealthMonitorEnabled() || typeof window === 'undefined') {
      return;
    }

    const bridge: ClientHealthDebugBridge = {
      snapshot: () => this.getSnapshot(),
      print: () => {
        const snapshot = this.getSnapshot();
        console.table(snapshot);
        return snapshot;
      },
    };

    (
      window as typeof window & {
        __RINKRAT_CLIENT_HEALTH__?: ClientHealthDebugBridge;
      }
    ).__RINKRAT_CLIENT_HEALTH__ = bridge;
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
}
