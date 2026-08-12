import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { BUNDLED_RELEASE_MANIFEST } from '../../../environments/generated-release-manifest';
import { auth } from '../firebase-auth';
import { getRinkRatAppCheckState } from '../firebase-app-check';
import { functions } from '../firebase-functions';
import { ClientHealthService } from '../observability/client-health.service';
import type { CompetitiveActionRecord } from '../observability/competitive-action-health.util';
import { getFirestoreListenerSnapshot } from '../observability/firestore-listener-monitor';
import type {
  BetaFeedbackTechnicalContext,
  BetaOperationMetricRequest,
  BetaOperationMetricResponse,
  BetaViewportCategory,
  PublicBetaKnownIssuesResponse,
} from './beta-operations.models';

const ROUTE_SAMPLE_COOLDOWN_MILLISECONDS = 10 * 60 * 1_000;
const MAX_ROUTE_SAMPLES_PER_SESSION = 24;

function createSampleId(prefix: 'action' | 'route'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getBetaViewportCategory(): BetaViewportCategory {
  if (typeof window === 'undefined') {
    return 'unknown';
  }

  const width = Math.max(0, Math.round(window.innerWidth));

  if (width <= 360) return 'small-phone';
  if (width <= 620) return 'phone';
  if (width <= 1024) return 'tablet';
  return 'desktop';
}

@Injectable({ providedIn: 'root' })
export class BetaOperationsService {
  private readonly routeSamples = new Map<string, number>();
  private routeSampleCount = 0;

  constructor(private readonly clientHealth: ClientHealthService) {}

  buildFeedbackContext(
    route: string,
    recentAction: CompetitiveActionRecord | null,
  ): BetaFeedbackTechnicalContext {
    const connection = this.clientHealth.getSnapshot();
    const listeners = getFirestoreListenerSnapshot();
    const appCheck = getRinkRatAppCheckState();

    return {
      releaseLabel: BUNDLED_RELEASE_MANIFEST.releaseLabel,
      buildId: BUNDLED_RELEASE_MANIFEST.buildId,
      route,
      viewportCategory: getBetaViewportCategory(),
      online: connection.online,
      connectionType: connection.effectiveConnectionType,
      saveData: connection.saveData,
      appCheckClientStatus: appCheck.status,
      listenerCount: listeners.total,
      recentAction: recentAction
        ? {
            action: recentAction.action,
            outcome: recentAction.outcome,
            durationMilliseconds: Math.max(0, Math.round(recentAction.durationMilliseconds)),
            finishedAt: recentAction.finishedAt,
          }
        : null,
    };
  }

  recordCompetitiveAction(record: CompetitiveActionRecord): void {
    void this.submitMetric({
      sampleId: createSampleId('action'),
      kind: 'competitive-action',
      releaseLabel: BUNDLED_RELEASE_MANIFEST.releaseLabel,
      buildId: BUNDLED_RELEASE_MANIFEST.buildId,
      route: record.route,
      viewportCategory: getBetaViewportCategory(),
      connectionType: record.connectionType,
      online: record.online,
      appCheckClientStatus: getRinkRatAppCheckState().status,
      action: record.action,
      outcome: record.outcome,
      durationMilliseconds: record.durationMilliseconds,
    });
  }

  recordRouteReady(
    route: string,
    durationMilliseconds: number,
    listenerCount: number,
  ): void {
    if (!auth.currentUser || this.routeSampleCount >= MAX_ROUTE_SAMPLES_PER_SESSION) {
      return;
    }

    const now = Date.now();
    const previous = this.routeSamples.get(route) ?? 0;

    if (previous > 0 && now - previous < ROUTE_SAMPLE_COOLDOWN_MILLISECONDS) {
      return;
    }

    this.routeSamples.set(route, now);
    this.routeSampleCount += 1;
    const connection = this.clientHealth.getSnapshot();

    void this.submitMetric({
      sampleId: createSampleId('route'),
      kind: 'route-ready',
      releaseLabel: BUNDLED_RELEASE_MANIFEST.releaseLabel,
      buildId: BUNDLED_RELEASE_MANIFEST.buildId,
      route,
      viewportCategory: getBetaViewportCategory(),
      connectionType: connection.effectiveConnectionType,
      online: connection.online,
      appCheckClientStatus: getRinkRatAppCheckState().status,
      durationMilliseconds,
      listenerCount,
    });
  }

  async loadPublicKnownIssues(): Promise<PublicBetaKnownIssuesResponse> {
    const callable = httpsCallable<Record<string, never>, PublicBetaKnownIssuesResponse>(
      functions,
      'getPublicBetaKnownIssues',
      { timeout: 25_000 },
    );
    const response = await callable({});
    return response.data;
  }

  private async submitMetric(request: BetaOperationMetricRequest): Promise<void> {
    if (!auth.currentUser) {
      return;
    }

    try {
      const callable = httpsCallable<BetaOperationMetricRequest, BetaOperationMetricResponse>(
        functions,
        'recordBetaOperationMetric',
        { timeout: 12_000 },
      );
      await callable(request);
    } catch {
      // Evidence collection must never block or visually affect a competitive action.
    }
  }
}
