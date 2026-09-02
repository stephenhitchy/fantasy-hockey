import type { FirestoreRouteObservation } from './firestore-listener-monitor';

export interface FirestoreRoutePercentiles {
  p50: number;
  p95: number;
  max: number;
}

export interface FirestoreRouteEnvelope {
  route: string;
  sampleCount: number;
  peakListeners: FirestoreRoutePercentiles;
  firstSnapshotDocuments: FirestoreRoutePercentiles;
  maxClosedListenerLifetimeMilliseconds: FirestoreRoutePercentiles;
  maxAwaitingFirstSnapshots: number;
  navigationCleanupCount: number;
  retryListenersOpened: number;
  listenerErrorCount: number;
  cacheToServerTransitionCount: number;
  reconnectSnapshotCount: number;
  hiddenSnapshotCount: number;
  pendingWriteSnapshotCount: number;
}

function nearestRank(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((first, second) => first - second);
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function buildPercentiles(values: number[]): FirestoreRoutePercentiles {
  return {
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

export function buildFirestoreRouteEnvelopes(
  observations: FirestoreRouteObservation[],
): FirestoreRouteEnvelope[] {
  const byRoute = new Map<string, FirestoreRouteObservation[]>();

  for (const observation of observations) {
    const routeObservations = byRoute.get(observation.route) ?? [];
    routeObservations.push(observation);
    byRoute.set(observation.route, routeObservations);
  }

  return [...byRoute.entries()]
    .sort(([firstRoute], [secondRoute]) => firstRoute.localeCompare(secondRoute))
    .map(([route, routeObservations]) => ({
      route,
      sampleCount: routeObservations.length,
      peakListeners: buildPercentiles(
        routeObservations.map((observation) => observation.peakListenerCount),
      ),
      firstSnapshotDocuments: buildPercentiles(
        routeObservations.map((observation) => observation.firstSnapshotDocumentCount),
      ),
      maxClosedListenerLifetimeMilliseconds: buildPercentiles(
        routeObservations.map((observation) => observation.maxClosedListenerLifetimeMilliseconds),
      ),
      maxAwaitingFirstSnapshots: Math.max(
        ...routeObservations.map((observation) => observation.awaitingFirstSnapshotCount),
      ),
      navigationCleanupCount: routeObservations.reduce(
        (total, observation) => total + observation.navigationCleanupCount,
        0,
      ),
      retryListenersOpened: routeObservations.reduce(
        (total, observation) => total + observation.retryListenersOpened,
        0,
      ),
      listenerErrorCount: routeObservations.reduce(
        (total, observation) => total + observation.listenerErrorCount,
        0,
      ),
      cacheToServerTransitionCount: routeObservations.reduce(
        (total, observation) => total + observation.cacheToServerTransitionCount,
        0,
      ),
      reconnectSnapshotCount: routeObservations.reduce(
        (total, observation) => total + observation.reconnectSnapshotCount,
        0,
      ),
      hiddenSnapshotCount: routeObservations.reduce(
        (total, observation) => total + observation.hiddenSnapshotCount,
        0,
      ),
      pendingWriteSnapshotCount: routeObservations.reduce(
        (total, observation) => total + observation.pendingWriteSnapshotCount,
        0,
      ),
    }));
}
