export type ClientViewportClass = 'phone' | 'tablet' | 'desktop';

export interface ClientPerformanceMetrics {
  firstContentfulPaintMilliseconds: number | null;
  largestContentfulPaintMilliseconds: number | null;
  cumulativeLayoutShift: number;
  interactionToNextPaintMilliseconds: number | null;
  longTaskCount: number;
  longestTaskMilliseconds: number;
  latestRouteReadyMilliseconds: number | null;
  slowestRouteReadyMilliseconds: number | null;
}

export function classifyClientViewport(width: number): ClientViewportClass {
  if (width <= 780) {
    return 'phone';
  }

  if (width <= 1180) {
    return 'tablet';
  }

  return 'desktop';
}

export function roundMetric(value: number | null, digits: number = 0): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  const multiplier = 10 ** Math.max(0, digits);
  return Math.round(value * multiplier) / multiplier;
}

export function estimateInpFromInteractions(interactions: ReadonlyMap<number, number>): number | null {
  const durations = [...interactions.values()]
    .filter((duration) => Number.isFinite(duration) && duration >= 0)
    .sort((first, second) => first - second);

  if (!durations.length) {
    return null;
  }

  const percentileIndex = Math.min(
    durations.length - 1,
    Math.max(0, Math.ceil(durations.length * 0.98) - 1),
  );

  return durations[percentileIndex] ?? null;
}

export function buildClientVitalsParameters(
  metrics: ClientPerformanceMetrics,
  viewportWidth: number,
  connectionType: string,
  saveData: boolean,
  online: boolean,
): Record<string, string | number | boolean> {
  return {
    viewport: classifyClientViewport(viewportWidth),
    online,
    connection_type: connectionType || 'unknown',
    save_data: saveData,
    fcp_ms: roundMetric(metrics.firstContentfulPaintMilliseconds) ?? 0,
    lcp_ms: roundMetric(metrics.largestContentfulPaintMilliseconds) ?? 0,
    cls_milli: roundMetric(metrics.cumulativeLayoutShift * 1_000) ?? 0,
    inp_ms: roundMetric(metrics.interactionToNextPaintMilliseconds) ?? 0,
    long_task_count: metrics.longTaskCount,
    longest_task_ms: roundMetric(metrics.longestTaskMilliseconds) ?? 0,
    latest_route_ms: roundMetric(metrics.latestRouteReadyMilliseconds) ?? 0,
    slowest_route_ms: roundMetric(metrics.slowestRouteReadyMilliseconds) ?? 0,
  };
}
