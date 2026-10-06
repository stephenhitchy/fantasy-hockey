export const LEAGUE_AUTOMATION_WATCHDOG_REQUIRED_BLOCKING_STREAK = 2;
export const LEAGUE_AUTOMATION_CAPACITY_HEADROOM_RATIO = 0.7;
export const LEAGUE_AUTOMATION_CAPACITY_MIN_SAMPLE_COUNT = 30;
export const LEAGUE_AUTOMATION_CAPACITY_REPRESENTATIVE_SAMPLE_COUNT = 100;
export const LEAGUE_AUTOMATION_CAPACITY_MIN_SAMPLE_DAY_COUNT = 3;
export const LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MAX_P95_MILLISECONDS = 20_000;
export const LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MIN_RELIABILITY_RATE = 0.995;
export const LEAGUE_AUTOMATION_STALE_DUE_MILLISECONDS = 25 * 60 * 1000;

export type LeagueAutomationFreshnessStatus =
  | 'healthy'
  | 'due'
  | 'active'
  | 'recovering'
  | 'stale'
  | 'failing'
  | 'missing-schedule'
  | 'schedule-invalid'
  | 'paused'
  | 'historical-replay'
  | 'draft-incomplete';

export interface LeagueAutomationFreshnessResult {
  status: LeagueAutomationFreshnessStatus;
  severity: 'healthy' | 'info' | 'warning' | 'critical';
  reason: string;
  dueAgeMilliseconds: number;
}

export function classifyLeagueAutomationFreshness(input: {
  nowMilliseconds: number;
  draftComplete: boolean;
  historicalReplayEnabled: boolean;
  scheduleExists: boolean;
  scoringEnabled: boolean;
  queueStatus: string;
  nextScoringAtMilliseconds: number;
  activeTaskLeaseExpiresAtMilliseconds: number;
  consecutiveFailureCount: number;
  lastError: string;
  staleAfterMilliseconds?: number;
}): LeagueAutomationFreshnessResult {
  const nowMilliseconds = Number.isFinite(input.nowMilliseconds)
    ? Math.max(0, input.nowMilliseconds)
    : 0;
  const nextScoringAtMilliseconds = Number.isFinite(
    input.nextScoringAtMilliseconds,
  )
    ? Math.max(0, input.nextScoringAtMilliseconds)
    : 0;
  const activeTaskLeaseExpiresAtMilliseconds = Number.isFinite(
    input.activeTaskLeaseExpiresAtMilliseconds,
  )
    ? Math.max(0, input.activeTaskLeaseExpiresAtMilliseconds)
    : 0;
  const staleAfterMilliseconds = Number.isFinite(input.staleAfterMilliseconds)
    ? Math.max(1, input.staleAfterMilliseconds ?? 0)
    : LEAGUE_AUTOMATION_STALE_DUE_MILLISECONDS;
  const dueAgeMilliseconds = nextScoringAtMilliseconds > 0
    ? Math.max(0, nowMilliseconds - nextScoringAtMilliseconds)
    : 0;
  const active = (
    input.queueStatus === 'queued' || input.queueStatus === 'processing'
  ) && activeTaskLeaseExpiresAtMilliseconds > nowMilliseconds;
  const failing = Math.max(0, Math.trunc(input.consecutiveFailureCount)) > 0 ||
    input.queueStatus === 'error' ||
    Boolean(input.lastError.trim());

  if (!input.draftComplete) {
    return {
      status: 'draft-incomplete',
      severity: 'info',
      reason: 'The Draft is not complete, so live scoring is not expected yet.',
      dueAgeMilliseconds: 0,
    };
  }

  if (input.historicalReplayEnabled) {
    return {
      status: 'historical-replay',
      severity: 'info',
      reason: 'Historical replay owns this league’s serialized scoring schedule.',
      dueAgeMilliseconds: 0,
    };
  }

  if (!input.scheduleExists) {
    return {
      status: 'missing-schedule',
      severity: 'critical',
      reason: 'This completed-Draft league has no server-owned scoring schedule.',
      dueAgeMilliseconds: 0,
    };
  }

  if (!input.scoringEnabled) {
    return {
      status: 'paused',
      severity: 'info',
      reason: 'Live scoring is intentionally paused for this league.',
      dueAgeMilliseconds: 0,
    };
  }

  if (active && failing) {
    return {
      status: 'recovering',
      severity: 'warning',
      reason: 'A new scoring task is active after an earlier recorded failure.',
      dueAgeMilliseconds,
    };
  }

  if (active) {
    return {
      status: 'active',
      severity: 'healthy',
      reason: 'A scoring task currently holds a valid server lease.',
      dueAgeMilliseconds,
    };
  }

  if (failing) {
    return {
      status: 'failing',
      severity: 'critical',
      reason: 'The latest scoring attempt failed and no healthy retry is active.',
      dueAgeMilliseconds,
    };
  }

  if (nextScoringAtMilliseconds <= 0) {
    return {
      status: 'schedule-invalid',
      severity: 'critical',
      reason: 'Scoring is enabled but the next server scoring time is missing.',
      dueAgeMilliseconds: 0,
    };
  }

  if (dueAgeMilliseconds >= staleAfterMilliseconds) {
    return {
      status: 'stale',
      severity: 'critical',
      reason: `The scoring schedule is ${Math.round(dueAgeMilliseconds / 60_000)} minutes overdue with no active task.`,
      dueAgeMilliseconds,
    };
  }

  if (dueAgeMilliseconds > 0) {
    return {
      status: 'due',
      severity: 'info',
      reason: 'The scoring schedule is due and still inside the bounded recovery window.',
      dueAgeMilliseconds,
    };
  }

  return {
    status: 'healthy',
    severity: 'healthy',
    reason: 'The next scoring check is scheduled and no failure is recorded.',
    dueAgeMilliseconds: 0,
  };
}

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
  'schedule-bootstrap-failed',
  'schedule-bootstrap-stale',
  'stale-league-schedules',
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
