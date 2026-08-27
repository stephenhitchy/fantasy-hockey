export const LEAGUE_AUTOMATION_WATCHDOG_REQUIRED_BLOCKING_STREAK = 2;
export const LEAGUE_AUTOMATION_CAPACITY_HEADROOM_RATIO = 0.7;
export const LEAGUE_AUTOMATION_CAPACITY_MIN_SAMPLE_COUNT = 30;
export const LEAGUE_AUTOMATION_CAPACITY_REPRESENTATIVE_SAMPLE_COUNT = 100;
export const LEAGUE_AUTOMATION_CAPACITY_MIN_SAMPLE_DAY_COUNT = 3;
export const LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MAX_P95_MILLISECONDS = 20_000;
export const LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MIN_RELIABILITY_RATE = 0.995;

export function shouldTreatLeagueAutomationDueAgeAsBacklog(
  mode: 'shadow' | 'canary' | 'primary',
): boolean {
  return mode !== 'shadow';
}

export type LeagueAutomationWatchdogAction =
  | 'none'
  | 'disable-canonical-authority'
  | 'return-to-shadow';

export type LeagueAutomationWatchdogStatus =
  | 'observing'
  | 'healthy'
  | 'warning'
  | 'error'
  | 'canonical-fallback'
  | 'shadow-fallback';

export interface LeagueAutomationWatchdogDecision {
  action: LeagueAutomationWatchdogAction;
  status: LeagueAutomationWatchdogStatus;
  queueBlockingStreak: number;
  canonicalBlockingStreak: number;
  queueBlockingAlertIds: string[];
  canonicalBlockingAlertIds: string[];
}

const QUEUE_BLOCKING_ALERT_IDS = new Set([
  'dispatcher-stale',
  'queue-backlog-blocking',
  'enqueue-failures',
  'schedule-coverage',
  'capacity-evidence-stale',
  'capacity-refresh-failed',
  'capacity-p95-high',
  'capacity-success-rate-low',
  'capacity-primary-unsafe',
]);

const CANONICAL_BLOCKING_ALERT_IDS = new Set([
  'canonical-feed-stale',
  'feed-failures',
  'parity-incomplete',
  'canonical-circuit-open',
]);

function normalizedStreak(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function decideLeagueAutomationWatchdogAction(input: {
  mode: 'shadow' | 'canary' | 'primary';
  canonicalAuthorityConfigured: boolean;
  alertIds: readonly string[];
  previousQueueBlockingStreak: number;
  previousCanonicalBlockingStreak: number;
  requiredBlockingStreak?: number;
}): LeagueAutomationWatchdogDecision {
  const requiredBlockingStreak = Math.max(
    1,
    Math.trunc(
      input.requiredBlockingStreak ??
      LEAGUE_AUTOMATION_WATCHDOG_REQUIRED_BLOCKING_STREAK,
    ),
  );
  const queueBlockingAlertIds = [...new Set(
    input.alertIds.filter((alertId) => QUEUE_BLOCKING_ALERT_IDS.has(alertId)),
  )].sort();
  const canonicalBlockingAlertIds = input.canonicalAuthorityConfigured
    ? [...new Set(
        input.alertIds.filter((alertId) =>
          CANONICAL_BLOCKING_ALERT_IDS.has(alertId)
        ),
      )].sort()
    : [];

  if (input.mode === 'shadow') {
    return {
      action: 'none',
      status: 'observing',
      queueBlockingStreak: 0,
      canonicalBlockingStreak: 0,
      queueBlockingAlertIds,
      canonicalBlockingAlertIds,
    };
  }

  const queueBlockingStreak = queueBlockingAlertIds.length > 0
    ? normalizedStreak(input.previousQueueBlockingStreak) + 1
    : 0;
  const canonicalBlockingStreak = canonicalBlockingAlertIds.length > 0
    ? normalizedStreak(input.previousCanonicalBlockingStreak) + 1
    : 0;

  if (queueBlockingStreak >= requiredBlockingStreak) {
    return {
      action: 'return-to-shadow',
      status: 'shadow-fallback',
      queueBlockingStreak,
      canonicalBlockingStreak,
      queueBlockingAlertIds,
      canonicalBlockingAlertIds,
    };
  }

  if (
    input.canonicalAuthorityConfigured &&
    canonicalBlockingStreak >= requiredBlockingStreak
  ) {
    return {
      action: 'disable-canonical-authority',
      status: 'canonical-fallback',
      queueBlockingStreak,
      canonicalBlockingStreak,
      queueBlockingAlertIds,
      canonicalBlockingAlertIds,
    };
  }

  const warning = queueBlockingStreak > 0 || canonicalBlockingStreak > 0;

  return {
    action: 'none',
    status: warning ? 'warning' : 'healthy',
    queueBlockingStreak,
    canonicalBlockingStreak,
    queueBlockingAlertIds,
    canonicalBlockingAlertIds,
  };
}

export type LeagueAutomationCapacityEvidenceLevel =
  | 'insufficient'
  | 'preliminary'
  | 'representative';

export interface LeagueAutomationCapacityRecommendation {
  evidenceLevel: LeagueAutomationCapacityEvidenceLevel;
  queueTaskSampleCount: number;
  queueTaskSuccessCount: number;
  queueTaskErrorCount: number;
  queueTaskSkippedCount: number;
  queueTaskReliabilityRate: number;
  sampledDayCount: number;
  averageDurationMilliseconds: number;
  p95DurationMilliseconds: number;
  maximumDurationMilliseconds: number;
  workerCount: number;
  refreshIntervalMilliseconds: number;
  headroomRatio: number;
  safeAffectedLeagueCapacity: number;
  recommendedWorkersFor25Leagues: number;
  recommendedWorkersFor50Leagues: number;
  promotionEvidenceReady: boolean;
  p95WithinPrimaryTarget: boolean;
  reliabilityWithinPrimaryTarget: boolean;
  supportsActiveLeagueTarget: boolean;
  primaryCapacityReady: boolean;
}

function normalizedDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function recommendedWorkerCount(input: {
  targetLeagueCount: number;
  p95DurationMilliseconds: number;
  refreshIntervalMilliseconds: number;
  headroomRatio: number;
}): number {
  if (
    input.targetLeagueCount <= 0 ||
    input.p95DurationMilliseconds <= 0 ||
    input.refreshIntervalMilliseconds <= 0 ||
    input.headroomRatio <= 0
  ) {
    return 0;
  }

  return Math.max(
    1,
    Math.ceil(
      (input.targetLeagueCount * input.p95DurationMilliseconds) /
      (input.refreshIntervalMilliseconds * input.headroomRatio),
    ),
  );
}

export function buildLeagueAutomationCapacityRecommendation(input: {
  queueTaskSampleCount: number;
  queueTaskSuccessCount: number;
  queueTaskErrorCount?: number;
  queueTaskSkippedCount?: number;
  sampledDayCount: number;
  averageDurationMilliseconds: number;
  p95DurationMilliseconds: number;
  maximumDurationMilliseconds: number;
  workerCount: number;
  refreshIntervalMilliseconds: number;
  activeLeagueTarget: number;
  headroomRatio?: number;
}): LeagueAutomationCapacityRecommendation {
  const queueTaskSampleCount = Math.max(
    0,
    Math.trunc(input.queueTaskSampleCount),
  );
  const queueTaskSuccessCount = Math.max(
    0,
    Math.trunc(input.queueTaskSuccessCount),
  );
  const queueTaskErrorCount = Math.max(
    0,
    Math.trunc(input.queueTaskErrorCount ?? 0),
  );
  const queueTaskSkippedCount = Math.max(
    0,
    Math.trunc(input.queueTaskSkippedCount ?? 0),
  );
  const queueTaskReliableCount = Math.min(
    queueTaskSampleCount,
    queueTaskSuccessCount + queueTaskSkippedCount,
  );
  const queueTaskReliabilityRate = queueTaskSampleCount > 0
    ? Math.min(1, queueTaskReliableCount / queueTaskSampleCount)
    : 0;
  const sampledDayCount = Math.max(0, Math.trunc(input.sampledDayCount));
  const averageDurationMilliseconds = normalizedDuration(
    input.averageDurationMilliseconds,
  );
  const p95DurationMilliseconds = normalizedDuration(
    input.p95DurationMilliseconds,
  );
  const maximumDurationMilliseconds = normalizedDuration(
    input.maximumDurationMilliseconds,
  );
  const workerCount = Math.max(1, Math.trunc(input.workerCount));
  const refreshIntervalMilliseconds = Math.max(
    1,
    normalizedDuration(input.refreshIntervalMilliseconds),
  );
  const activeLeagueTarget = Math.max(0, Math.trunc(input.activeLeagueTarget));
  const headroomRatio = Math.min(
    0.95,
    Math.max(
      0.1,
      input.headroomRatio ?? LEAGUE_AUTOMATION_CAPACITY_HEADROOM_RATIO,
    ),
  );
  const promotionEvidenceReady =
    queueTaskSuccessCount >= LEAGUE_AUTOMATION_CAPACITY_MIN_SAMPLE_COUNT &&
    sampledDayCount >= LEAGUE_AUTOMATION_CAPACITY_MIN_SAMPLE_DAY_COUNT;
  const evidenceLevel: LeagueAutomationCapacityEvidenceLevel =
    queueTaskSuccessCount >=
      LEAGUE_AUTOMATION_CAPACITY_REPRESENTATIVE_SAMPLE_COUNT &&
    sampledDayCount >= LEAGUE_AUTOMATION_CAPACITY_MIN_SAMPLE_DAY_COUNT
      ? 'representative'
      : promotionEvidenceReady
        ? 'preliminary'
        : 'insufficient';
  const safeAffectedLeagueCapacity = p95DurationMilliseconds > 0
    ? Math.max(
        0,
        Math.floor(
          (workerCount * refreshIntervalMilliseconds * headroomRatio) /
          p95DurationMilliseconds,
        ),
      )
    : 0;
  const p95WithinPrimaryTarget =
    p95DurationMilliseconds > 0 &&
    p95DurationMilliseconds <=
      LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MAX_P95_MILLISECONDS;
  const reliabilityWithinPrimaryTarget =
    queueTaskSampleCount > 0 &&
    queueTaskReliabilityRate >=
      LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MIN_RELIABILITY_RATE;
  const supportsActiveLeagueTarget =
    activeLeagueTarget > 0 &&
    safeAffectedLeagueCapacity >= activeLeagueTarget;

  return {
    evidenceLevel,
    queueTaskSampleCount,
    queueTaskSuccessCount,
    queueTaskErrorCount,
    queueTaskSkippedCount,
    queueTaskReliabilityRate,
    sampledDayCount,
    averageDurationMilliseconds,
    p95DurationMilliseconds,
    maximumDurationMilliseconds,
    workerCount,
    refreshIntervalMilliseconds,
    headroomRatio,
    safeAffectedLeagueCapacity,
    recommendedWorkersFor25Leagues: recommendedWorkerCount({
      targetLeagueCount: 25,
      p95DurationMilliseconds,
      refreshIntervalMilliseconds,
      headroomRatio,
    }),
    recommendedWorkersFor50Leagues: recommendedWorkerCount({
      targetLeagueCount: 50,
      p95DurationMilliseconds,
      refreshIntervalMilliseconds,
      headroomRatio,
    }),
    promotionEvidenceReady,
    p95WithinPrimaryTarget,
    reliabilityWithinPrimaryTarget,
    supportsActiveLeagueTarget,
    primaryCapacityReady:
      promotionEvidenceReady &&
      p95WithinPrimaryTarget &&
      reliabilityWithinPrimaryTarget &&
      supportsActiveLeagueTarget,
  };
}
